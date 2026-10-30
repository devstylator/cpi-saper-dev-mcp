import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEdits, CpiClient, describe, mappingSettings, diffIflows, findElement, groovyVersionOf, insertStepAfter, loadCatalog, locateIflow,
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

const EMPTY = readFileSync(locateIflow('empty', FIXTURES).iflwPath, 'utf8');

test('adapters on a new iFlow: sender to Start, receiver from Request Reply, a second receiver gets its own box', () => {
  const doc = parseIflw(EMPTY);
  const log = applyEdits(doc, [
    { op: 'add_adapter', step: 'Start', type: 'HTTPS', settings: { urlPath: '/orders' } },
    { op: 'insert_step', after: 'StartEvent_2', type: 'Request Reply', name: 'Call backend' },
    { op: 'add_adapter', step: 'Call backend', type: 'HTTP', settings: { httpAddressWithoutQuery: 'https://example.com/api' } },
    { op: 'insert_step', after: 'Call backend', type: 'Send', name: 'Archive' },
    { op: 'add_adapter', step: 'Archive', type: 'SFTP' },
  ], catalog);
  assert.match(log[0]!, /^added sender adapter MessageFlow_1 "HTTPS" \(HTTPS 1\.5\.3, latest in catalog\) from Sender to StartEvent_2$/);
  assert.match(log[2]!, /^added receiver adapter MessageFlow_2 "HTTP" .* from ServiceTask_1 to Receiver$/);
  assert.match(log[4]!, /^added receiver adapter MessageFlow_3 "SFTP" .* from ServiceTask_2 to Receiver1 \(new box Participant_3\)$/);
  assert.deepEqual(validate(doc), []);
  const m = describe(doc, { maxLen: 0 });
  assert.deepEqual(m.adapters.map((a) => `${a.from}->${a.to} ${a.adapter} ${a.direction}`),
    ['Participant_1->StartEvent_2 HTTPS Sender', 'ServiceTask_1->Participant_2 HTTP Receiver', 'ServiceTask_2->Participant_3 SFTP Receiver']);
  const https = readProps(findElement(doc, 'MessageFlow_1'));
  assert.equal(https.urlPath, '/orders');
  assert.equal(https.system, 'Sender');
  assert.equal(readProps(findElement(doc, 'MessageFlow_3')).system, 'Receiver1');
  const box = findElement(doc, 'Participant_3');
  assert.equal(box.getAttribute('ifl:type'), 'EndpointRecevier');
  assert.equal(box.getAttribute('name'), 'Receiver1');
  // layout: the steps went into the room between Start and End (nothing moved); each receiver box sits below the
  // pool under its step (the free Receiver of the new iFlow was moved there), so its line runs straight down
  const at = (d: typeof doc, id: string) => {
    const m = serializeIflw(d).match(new RegExp(`bpmnElement="${id}"[^>]*>\\s*<dc:Bounds height="([\\d.]+)" width="([\\d.]+)" x="([\\d.-]+)" y="([\\d.-]+)"`))!;
    const [h, w, x, y] = m.slice(1).map(Number) as [number, number, number, number];
    return { x, y, w, h, cx: x + w / 2 };
  };
  const line = (d: typeof doc, id: string) => [...serializeIflw(d).matchAll(new RegExp(`bpmnElement="${id}"[\\s\\S]*?</bpmndi:BPMNEdge>`, 'g'))][0]![0]
    .match(/x="[\d.-]+"/g)!.map((v) => Number(v.slice(3, -1)));
  const pool = at(doc, 'Participant_Process_1');
  assert.deepEqual([at(doc, 'EndEvent_2').x, pool.w], [703, 540], 'End and the pool stayed');
  for (const [step, box] of [['ServiceTask_1', 'Participant_2'], ['ServiceTask_2', 'Participant_3']] as const) {
    assert.equal(at(doc, box).cx, at(doc, step).cx, `${box} under ${step}`);
    assert.equal(at(doc, box).y, pool.y + pool.h + 60);
  }
  assert.deepEqual(line(doc, 'MessageFlow_2'), [at(doc, 'ServiceTask_1').cx, at(doc, 'ServiceTask_1').cx], 'vertical line');

  // a step inserted before them shifts the flow: the boxes below move along and their lines stay vertical
  applyEdits(doc, [{ op: 'insert_step', after: 'StartEvent_2', type: 'Content Modifier' }], catalog);
  assert.equal(at(doc, 'ServiceTask_1').cx, 428 + 150);
  assert.equal(at(doc, 'Participant_2').cx, at(doc, 'ServiceTask_1').cx);
  assert.deepEqual(line(doc, 'MessageFlow_3'), [at(doc, 'ServiceTask_2').cx, at(doc, 'ServiceTask_2').cx]);
  assert.deepEqual(validate(doc), []);
});

test('add then remove an adapter restores the file byte for byte; remove_adapter frees the step', () => {
  const doc = parseIflw(EMPTY);
  applyEdits(doc, [{ op: 'add_adapter', step: 'StartEvent_2', type: 'HTTPS' }], catalog);
  applyEdits(doc, [{ op: 'remove_adapter', adapter: 'MessageFlow_1' }], catalog);
  assert.equal(serializeIflw(doc), serializeIflw(parseIflw(EMPTY)));

  const d2 = fresh();
  applyEdits(d2, [{ op: 'remove_adapter', adapter: 'MessageFlow_8' }, { op: 'remove_step', step: 'ServiceTask_5' }], catalog);
  assert.deepEqual(validate(d2).filter((i) => i.severity === 'error'), []);
});

test('adapter refusals: wrong element, wrong direction, ambiguous type, step already connected, box of the other kind', () => {
  const doc = () => parseIflw(EMPTY);
  assert.throws(() => applyEdits(fresh(), [{ op: 'add_adapter', step: 'CallActivity_10', type: 'SFTP' }], catalog), /cannot have an adapter/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'add_adapter', step: 'ServiceTask_5', type: 'HTTPS' }], catalog), /only as Sender adapter, but ServiceTask_5 needs a receiver adapter/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'add_adapter', step: 'ServiceTask_5', type: 'HTTP' }], catalog), /already has an adapter/);
  assert.throws(() => applyEdits(doc(), [{ op: 'add_adapter', step: 'EndEvent_2', type: 'OData' }], catalog), /ambiguous for a receiver adapter/);
  assert.throws(() => applyEdits(doc(), [{ op: 'add_adapter', step: 'StartEvent_2', type: 'HTTPS', participant: 'Receiver' }], catalog), /Receiver is not a sender box/);
  assert.throws(() => applyEdits(doc(), [{ op: 'add_adapter', step: 'StartEvent_2', type: 'HTTPS', settings: { urlPth: '/x' } }], catalog), /has no setting "urlPth"/);
});

test('layout: a straight flow in one even row, pool fitted, sender left, receiver below its step; branches refused', () => {
  const doc = parseIflw(EMPTY);
  applyEdits(doc, [
    { op: 'add_adapter', step: 'StartEvent_2', type: 'HTTPS' },
    { op: 'insert_step', after: 'StartEvent_2', type: 'Request Reply', name: 'Call' },
    { op: 'add_adapter', step: 'Call', type: 'HTTP' },
    { op: 'insert_step', after: 'StartEvent_2', type: 'Content Modifier' },
    { op: 'insert_step', after: 'StartEvent_2', type: 'Content Modifier', name: 'Second' },
  ], catalog);
  const log = applyEdits(doc, [{ op: 'layout' }], catalog);
  assert.match(log[0]!, /^laid out 5 elements in one row \(pool width 664\), 2 Sender\/Receiver box\(es\) placed$/);
  const xml = serializeIflw(doc);
  const box = (id: string) => xml.match(new RegExp(`bpmnElement="${id}"[^>]*>\\s*<dc:Bounds height="[\\d.]+" width="([\\d.]+)" x="([\\d.-]+)" y="([\\d.-]+)"`))!.slice(1).map(Number);
  assert.deepEqual(['StartEvent_2', 'CallActivity_2', 'CallActivity_1', 'ServiceTask_1', 'EndEvent_2'].map((id) => box(id)[1]), [292, 378, 528, 678, 828]);
  assert.deepEqual(box('Participant_1').slice(1), [40, 90], 'sender left of the pool, level with Start');
  assert.deepEqual(box('Participant_2').slice(1), [678, 340], 'receiver below its step');
  assert.deepEqual(validate(doc), []);
  assert.throws(() => applyEdits(fresh(), [{ op: 'layout' }], catalog), /straight flows only/);
});

test('XSLT Mapping: "mapping" sets uri, path and name as the designer does; a mapping step without a file is refused', () => {
  const doc = fresh();
  const log = applyEdits(doc, [{ op: 'insert_step', after: 'CallActivity_10', type: 'XSLT Mapping', name: 'Rows to items', mapping: 'rows2items.xsl' }], catalog);
  const id = log[0]!.match(/inserted (\S+)/)![1]!;
  const p = readProps(findElement(doc, id));
  assert.equal(p.mappinguri, 'dir://mapping/xslt/src/main/resources/mapping/rows2items.xsl');
  assert.equal(p.mappingpath, 'src/main/resources/mapping/rows2items');
  assert.equal(p.mappingname, 'rows2items');
  assert.ok(describe(doc) && validate(doc).length === 0);
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'XSLT Mapping' }], catalog), /needs "mapping"/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'XSLT Mapping', mapping: 'x.groovy' }], catalog), /\.xsl or \.xslt/);
  // from a header: no file needed
  applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'XSLT Mapping', settings: { mappingSource: 'mappingSrcHeader' } }], catalog);
  // set on an existing step
  applyEdits(doc, [{ op: 'set', element: id, mapping: 'mapping/Other.xslt' }], catalog);
  assert.deepEqual(mappingSettings('MessageMapping', 'src/main/resources/mapping/Orders.mmap'), {
    mappinguri: 'dir://mmap/src/main/resources/mapping/Orders.mmap', mappingpath: 'src/main/resources/mapping/Orders', mappingname: 'Orders',
  });
  assert.equal(readProps(findElement(doc, id)).mappingname, 'Other');
  assert.throws(() => applyEdits(fresh(), [{ op: 'set', element: 'CallActivity_10', mapping: 'a.xsl' }], catalog), /XSLT Mapping and Message Mapping steps only/);
});

test('validate: settings and adapters the tenant needs at deploy', () => {
  const codes = (doc: ReturnType<typeof fresh>) => validate(doc).filter((i) => i.severity === 'error').map((i) => `${i.code} ${i.msg.split(' ')[0]}`);
  const doc = fresh();
  const log = applyEdits(doc, [
    { op: 'insert_step', after: 'CallActivity_10', type: 'General Splitter' },
    { op: 'insert_step', after: 'CallActivity_10', type: 'Simple Signer' },
    { op: 'insert_step', after: 'CallActivity_10', type: 'Content Enricher' },
  ], catalog);
  const [splitter, signer, enricher] = log.map((l) => l.match(/inserted (\S+)/)![1]!);
  assert.deepEqual(codes(doc).sort(), [`MISSING_SETTING ${splitter}`, `MISSING_SETTING ${signer}`, `NO_ADAPTER ${enricher}`].sort());
  applyEdits(doc, [
    { op: 'set', element: splitter!, settings: { splitExprValue: '//order' } },
    { op: 'set', element: signer!, settings: { privateKeyAlias: 'sign' } },
    { op: 'add_adapter', step: enricher!, type: 'HTTP' },
  ], catalog);
  assert.deepEqual(codes(doc), []);

  const empty = parseIflw(EMPTY);
  applyEdits(empty, [{ op: 'add_adapter', step: 'StartEvent_2', type: 'HTTPS', settings: { senderAuthType: 'None' } }], catalog);
  assert.match(validate(empty).map((i) => i.code).join(), /INVALID_SETTING/);
  applyEdits(empty, [{ op: 'set', element: 'HTTPS', settings: { senderAuthType: 'ClientCertificate' } }], catalog);
  assert.match(validate(empty).map((i) => i.msg).join(), /ClientCertificate needs clientCertificates/);
  applyEdits(empty, [{ op: 'set', element: 'HTTPS', settings: { senderAuthType: 'RoleBased' } }], catalog);
  assert.deepEqual(validate(empty).filter((i) => i.severity === 'error'), []);
});
