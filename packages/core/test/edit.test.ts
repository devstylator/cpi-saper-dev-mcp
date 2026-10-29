import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEdits, CpiClient, describe, diffIflows, findElement, groovyVersionOf, insertStepAfter, loadCatalog, locateIflow,
  mappingText, parseIflw, readMapping, readProps, removeStep, runScript, runXslt, serializeIflw, validate,
} from '../dist/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const located = locateIflow('sample-before', FIXTURES);
const XML = readFileSync(located.iflwPath, 'utf8');
const fresh = () => parseIflw(XML);
const catalog = loadCatalog();

test('insert then remove restores a straight sequence byte for byte', () => {
  const plain = serializeIflw(fresh());
  for (const after of ['StartEvent_2', 'ServiceTask_5', 'CallActivity_20', 'CallActivity_10', 'CallActivity_13', 'CallActivity_14']) {
    const doc = fresh();
    const { stepId } = insertStepAfter(doc, after, { name: 'tmp', properties: { a: '1' } });
    assert.equal(validate(doc).length, 0, `valid after inserting after ${after}`);
    removeStep(doc, stepId);
    assert.equal(serializeIflw(doc), plain, `round trip after ${after}`);
  }
});

test('a batch: insert from the catalog with headers, set, rename, header table edits', () => {
  const doc = fresh();
  const log = applyEdits(doc, [
    { op: 'insert_step', after: 'CallActivity_10', type: 'Content Modifier', name: 'Set trace', headers: [{ name: 'X-Trace', value: 'yes' }, { name: 'X-Ip', value: '${property.ip}', type: 'expression' }] },
    { op: 'set', element: 'MessageFlow_8', settings: { httpRequestTimeout: '30000' } },
    { op: 'rename', element: 'Router 1', name: 'Is Claude IP?' },
    { op: 'headers', step: 'CallActivity_13', set: [{ name: 'Content-Type', value: 'application/json' }] },
  ], catalog);
  assert.match(log[0]!, /^inserted CallActivity_21 "Set trace" \(Content Modifier 1\.6\.6, already used in this iFlow\) after CallActivity_10$/);
  assert.equal(readProps(findElement(doc, 'MessageFlow_8')).httpRequestTimeout, '30000');
  assert.equal(findElement(doc, 'ExclusiveGateway_16').getAttribute('name'), 'Is Claude IP?');
  const changes = diffIflows(describe(fresh(), { maxLen: 0 }), describe(doc, { maxLen: 0 }));
  assert.ok(changes.includes('    + headerTable X-Ip: Action="Create" Type="expression" Value="${property.ip}"'));
  assert.ok(changes.includes('    ~ headerTable Content-Type: Value "application/xml" -> "application/json"'));
  assert.deepEqual(validate(doc), []);
  // what the designer would read back: the new step keeps the catalog defaults and SAP's formatting
  const xml = serializeIflw(doc);
  assert.match(xml, /<bpmn2:callActivity id="CallActivity_21" name="Set trace">\n {12}<bpmn2:extensionElements>\n {16}<ifl:property>/);
  assert.match(xml, /<value>ctype::FlowstepVariant\/cname::Enricher\/version::1\.6\.6<\/value>/);
});

test('refusals: unknown keys, ambiguous or unknown types, script steps without file, steps with adapters', () => {
  assert.throws(() => applyEdits(fresh(), [{ op: 'set', element: 'MessageFlow_8', settings: { httpMetod: 'GET' } }], catalog), /operation 1 \(set\): MessageFlow_8: unknown setting\(s\) httpMetod/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'End' }], catalog), /ambiguous/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'Teleporter' }], catalog), /not in the catalog/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'Router' }], catalog), /cannot be inserted as a step yet/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'Groovy Script' }], catalog), /needs settings\.script/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'Content Modifier', settings: { bodyTyp: 'x' } }], catalog), /has no setting "bodyTyp"/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'remove_step', step: 'ServiceTask_5' }], catalog), /has an adapter connected/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'remove_step', step: 'ExclusiveGateway_16' }], catalog), /only steps can be removed/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'headers', step: 'CallActivity_13', remove: ['Nope'] }], catalog), /has no row "Nope"/);
});

test('script step 2.x from the catalog; the version follows the iFlow unless asked', () => {
  const doc = fresh();
  applyEdits(doc, [
    { op: 'insert_step', after: 'CallActivity_10', type: 'Groovy Script', settings: { script: 'other.groovy' } },
    { op: 'insert_step', after: 'CallActivity_10', type: 'Groovy Script', version: '2.0.0', settings: { script: 'v2/new.groovy' } },
  ], catalog);
  const versions = ['CallActivity_21', 'CallActivity_22'].map((id) => readProps(findElement(doc, id)).cmdVariantUri);
  assert.deepEqual(versions, ['ctype::FlowstepVariant/cname::GroovyScript/version::1.1.2', 'ctype::FlowstepVariant/cname::GroovyScript/version::2.0.0']);
  assert.deepEqual(validate(doc, located).filter((i) => i.code === 'MISSING_RESOURCE').map((i) => i.msg.replace(/^.* -> /, '')).sort(),
    ['src/main/resources/script/other.groovy', 'src/main/resources/script/v2/new.groovy']);
});

test('xslt: output with parameters, compile error with exact line, runtime error', () => {
  const xsl = `<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:param name="SAP_Sender"/>
  <xsl:template match="/order"><xsl:message>n=<xsl:value-of select="count(item)"/></xsl:message><Order from="{$SAP_Sender}"><xsl:value-of select="upper-case(item[1])"/></Order></xsl:template>
</xsl:stylesheet>`;
  const ok = runXslt({ stylesheetText: xsl, input: '<order><item>a</item><item>b</item></order>', headers: { SAP_Sender: 'ERP' } });
  assert.ok(ok.ok);
  assert.match(ok.ok ? ok.output : '', /<Order from="ERP">A<\/Order>/);
  assert.deepEqual(ok.messages, ['n=2']);
  const bad = runXslt({ stylesheetText: xsl.replace('count(item)', 'count(item'), input: '<order/>' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.ok ? null : [bad.error.code, bad.error.line], ['XPST0003', 4]);
  const rt = runXslt({ stylesheetText: xsl.replace('upper-case(item[1])', "xs:integer('x')").replace('version="3.0"', 'version="3.0" xmlns:xs="http://www.w3.org/2001/XMLSchema"'), input: '<order/>' });
  assert.equal(rt.ok ? null : rt.error.code, 'FORG0001');
});

test('mapping view of a message mapping', () => {
  const m = readMapping(`<xiObj xmlns="urn:sap-com:xi"><generic><lnks>
    <lnkRole kpos="1" role="SOURCE_IFR_MESS"><lnk><key typeID="xsd"><elem>In.xsd</elem><elem>src/main/resources/xsd</elem><elem>order</elem></key></lnk></lnkRole>
    <lnkRole kpos="1" role="TARGET_IFR_MESS"><lnk><key typeID="xsd"><elem>Out.xsd</elem><elem>src/main/resources/xsd</elem><elem>root</elem></key></lnk></lnkRole>
  </lnks></generic><content><project><transformation>
    <brick path="/root/Type" type="Dst"><arg><brick fname="const" fns="dflt" type="Func"><bindings><param name="value"><value>305</value></param></bindings></brick></arg></brick>
    <brick path="/root/Name" type="Dst"><arg><brick fname="concat" fns="dflt" object_uid="r1" type="Func"><arg><brick context="/order" path="/order/first" type="Src"/></arg><arg pin="1"><brick path="/order/last" type="Src"/></arg><bindings><param name="delimeter"><value> </value></param></bindings></brick></arg></brick>
    <brick path="/root/Copy" type="Dst"><arg><brick object_uid="r1"/></arg></brick>
  </transformation></project></content></xiObj>`);
  assert.equal(mappingText(m), [
    'source 1: order (src/main/resources/xsd/In.xsd)', 'target 1: root (src/main/resources/xsd/Out.xsd)', '',
    '/root/Type <- "305"', '/root/Name <- concat(/order/first {ctx order}, /order/last, delimeter=" ")', '/root/Copy <- (same as /root/Name)',
  ].join('\n'));
});

test('script runner client: request format and result', async () => {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, string> }> = [];
  const key = { clientid: 'i', clientsecret: 's', url: 'https://rt.example.com', tokenurl: 'https://auth.example.com/token' };
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === key.tokenurl) return new Response(JSON.stringify({ access_token: 't' }));
    sent.push({ url: String(input), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    const b = (s: string) => Buffer.from(s).toString('base64');
    return new Response(JSON.stringify({ payload: b('{"x":1}'), console: b('hi\n'), headers: '', properties: '', delta: { headers: { set: { A: '1' }, removed: [] }, properties: { set: {}, removed: [] } } }),
      { headers: { SAP_MessageProcessingLogID: 'M1' } });
  }) as typeof fetch;
  const script = 'import com.sap.it.script.v2.api.Message\nMessage processData(Message m) { m }';
  assert.equal(groovyVersionOf(script), 2);
  const r = await runScript(new CpiClient(key, fake), '/v2/test/script', { script, body: 'in', headers: { H: '1' }, function: 'other' });
  assert.equal(sent[0]!.url, 'https://rt.example.com/http/v2/test/script');
  assert.equal(sent[0]!.headers['groovy-version'], '2');
  assert.equal(Buffer.from(sent[0]!.body.inputParams!, 'base64').toString(), 'runnerFunction=other');
  assert.deepEqual([r.ok, r.body, r.console, r.messageLogId, r.delta?.headers.set], [true, '{"x":1}', 'hi\n', 'M1', { A: '1' }]);
  await assert.rejects(runScript(new CpiClient(key, fake), '/x', { script, headers: { 'A=B': '1' } }), /cannot pass ";" or "="/);
});
