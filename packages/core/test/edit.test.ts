import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEdits, byTag, children, CpiClient, describe, mappingSettings, NS, scriptCollectionRefs, textconv, withCollectionRequirements, diffIflows, findElement, groovyVersionOf, insertStepAfter, loadCatalog, locateIflow,
  mappingText, parseIflw, readMapping, readProps, removeStep, runScript, runXslt, serializeIflw, validate,
} from '../dist/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const located = locateIflow('sample-before', FIXTURES);
const XML = readFileSync(located.iflwPath, 'utf8');
const fresh = () => parseIflw(XML);
const catalog = loadCatalog();

/** Pairs of shapes that overlap, except a pool or subprocess with what it contains */
function overlapping(doc: ReturnType<typeof parseIflw>): string[] {
  const shapes = byTag(doc, 'BPMNShape', NS.bpmndi).map((s) => {
    const b = children(s, 'Bounds', NS.dc)[0]!;
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(b.getAttribute(k)));
    return { id: s.getAttribute('bpmnElement')!, x: x!, y: y!, w: w!, h: h! };
  });
  const contains = (a: typeof shapes[0], b: typeof shapes[0]) => a.x <= b.x && a.y <= b.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
  const out: string[] = [];
  shapes.forEach((a, i) => shapes.slice(i + 1).forEach((b) => {
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h && !contains(a, b) && !contains(b, a)) out.push(`${a.id}/${b.id}`);
  }));
  return out;
}

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
  // a designer-made flow with a router: laid out in rows, nothing overlaps, the model is unchanged
  const routed = fresh();
  const model = describe(routed, { maxLen: 0 });
  assert.match(applyEdits(routed, [{ op: 'layout' }], catalog)[0]!, /laid out 8 elements in one row/);
  // the router's second route skips "Claude marker" on the same row: it goes over the top
  const skip = byTag(routed, 'BPMNEdge', NS.bpmndi).find((e) => e.getAttribute('bpmnElement') === 'SequenceFlow_19')!;
  assert.deepEqual(children(skip, 'waypoint', NS.di).map((w) => Number(w.getAttribute('y'))), [120, 95, 95, 124]);
  assert.deepEqual(describe(routed, { maxLen: 0 }), model);
  assert.deepEqual(overlapping(routed), []);
  assert.deepEqual(validate(routed), []);
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

test('Filter: "expression" fills wrapContent; an XPath given as xpathType is refused with a hint', () => {
  const doc = fresh();
  const log = applyEdits(doc, [{ op: 'insert_step', after: 'CallActivity_10', type: 'Filter', expression: "/Orders/Order[region='EU']" }], catalog);
  const id = log[0]!.match(/inserted (\S+)/)![1]!;
  assert.equal(readProps(findElement(doc, id)).wrapContent, "/Orders/Order[region='EU']");
  assert.equal(readProps(findElement(doc, id)).xpathType, 'Nodelist');
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'Filter' }], catalog), /needs "expression"/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'Filter', settings: { xpathType: '/Orders/Order' } }], catalog),
    /xpathType is the value type .* pass the XPath as "expression"/);
  applyEdits(doc, [{ op: 'set', element: id, expression: '/Orders/Order[1]', settings: { xpathType: 'Node' } }], catalog);
  assert.deepEqual([readProps(findElement(doc, id)).wrapContent, readProps(findElement(doc, id)).xpathType], ['/Orders/Order[1]', 'Node']);
  assert.throws(() => applyEdits(doc, [{ op: 'set', element: 'CallActivity_10', expression: '/a' }], catalog), /Filter steps only/);
  applyEdits(doc, [{ op: 'set', element: id, expression: '' }], catalog);
  assert.match(validate(doc).map((i) => `${i.severity} ${i.msg}`).join(), /error .*wrapContent is empty/);
});

test('validate: whitespace in a Receiver name and authenticationMethod in the wrong case are refused at deploy', () => {
  const doc = parseIflw(EMPTY);
  applyEdits(doc, [
    { op: 'insert_step', after: 'StartEvent_2', type: 'Request Reply', name: 'Call' },
    { op: 'add_adapter', step: 'Call', type: 'HTTP', participant: 'Receiver', settings: { authenticationMethod: 'none' } },
    { op: 'rename', element: 'Participant_2', name: 'Mock Server' },
  ], catalog);
  const msgs = validate(doc).filter((i) => i.severity === 'error').map((i) => i.msg);
  assert.equal(msgs.length, 2, msgs.join('\n'));
  assert.match(msgs.join('\n'), /Receiver name "Mock Server" contains whitespace/);
  assert.match(msgs.join('\n'), /authenticationMethod "none" must be written "None"/);
  applyEdits(doc, [{ op: 'rename', element: 'Mock Server', name: 'MockServer' }, { op: 'set', element: 'HTTP', settings: { authenticationMethod: 'None' } }], catalog);
  assert.deepEqual(validate(doc).filter((i) => i.severity === 'error'), []);
});

test('exception subprocess: added below the main row, steps go inside, layout, refusals, removal', () => {
  const doc = parseIflw(EMPTY);
  const box = (id: string) => {
    const s = byTag(doc, 'BPMNShape', NS.bpmndi).find((x) => x.getAttribute('bpmnElement') === id)!;
    const b = children(s, 'Bounds', NS.dc)[0]!;
    return ['x', 'y', 'width', 'height'].map((k) => Number(b.getAttribute(k)));
  };
  applyEdits(doc, [
    { op: 'add_adapter', step: 'StartEvent_2', type: 'HTTPS', settings: { urlPath: '/x' } },
    { op: 'insert_step', after: 'StartEvent_2', type: 'Request Reply', name: 'Call' },
    { op: 'add_adapter', step: 'Call', type: 'HTTP' },
  ], catalog);
  const before = describe(doc, { maxLen: 0 });
  const log = applyEdits(doc, [{ op: 'add_exception_subprocess' }], catalog);
  const endBefore = box('EndEvent_2');
  assert.match(log[0]!, /added exception subprocess SubProcess_1 to Process_1: StartEvent_3 "Error Start 1" -> EndEvent_3 "Error End 1"/);
  // the receiver's line would cross the subprocess, so its box moves above the pool; the diagram moves down 160
  assert.deepEqual(box('Participant_2'), [378, 20, 100, 140], 'receiver above the pool, its line clear of the subprocess');
  assert.deepEqual(box('Participant_Process_1'), [250, 220, 540, 330], 'pool grows 20 below the subprocess');
  assert.deepEqual(box('SubProcess_1'), [292, 390, 400, 140], 'below the main row, left-aligned with it');
  assert.deepEqual([box('StartEvent_3').slice(0, 2), box('EndEvent_3').slice(0, 2)], [[325, 436], [608, 436]]);
  assert.deepEqual(validate(doc), []);

  applyEdits(doc, [
    { op: 'insert_step', after: 'Error Start 1', type: 'Content Modifier', name: 'Error reply' },
    { op: 'insert_step', after: 'Error reply', type: 'Content Modifier', name: 'Error header' },
  ], catalog);
  assert.deepEqual(box('EndEvent_2'), endBefore, 'the main row does not move when the subprocess grows');
  assert.equal(box('SubProcess_1')[2], 550);
  assert.deepEqual(validate(doc), []);
  assert.match(applyEdits(doc, [{ op: 'layout' }], catalog)[0]!, /3 elements in one row and 4 in the exception subprocess below/);
  assert.deepEqual(box('SubProcess_1'), [292, 390, 499, 140]);
  assert.deepEqual(box('Participant_2'), [378, 20, 100, 140], 'layout keeps the receiver above');
  assert.deepEqual(validate(doc), []);

  const subBefore = box('SubProcess_1');
  const mainLog = applyEdits(doc, [{ op: 'insert_step', after: 'Call', type: 'Content Modifier', name: 'Main step' }], catalog);
  assert.deepEqual(box('SubProcess_1'), subBefore, 'the subprocess does not move when the main row grows');
  applyEdits(doc, [{ op: 'remove_step', step: mainLog[0]!.match(/inserted (\S+)/)![1]! }], catalog);
  assert.throws(() => applyEdits(doc, [{ op: 'add_exception_subprocess' }], catalog), /already has an exception subprocess/);
  assert.throws(() => applyEdits(doc, [{ op: 'insert_step', after: 'Call', type: 'Exception Subprocess' }], catalog), /add_exception_subprocess/);
  // a step inside with an adapter blocks the removal
  const withCall = parseIflw(serializeIflw(doc));
  applyEdits(withCall, [{ op: 'insert_step', after: 'Error header', type: 'Request Reply', name: 'Notify' }, { op: 'add_adapter', step: 'Notify', type: 'HTTP' }], catalog);
  assert.throws(() => applyEdits(withCall, [{ op: 'remove_exception_subprocess' }], catalog), /has an adapter.*remove_adapter/);

  applyEdits(doc, [{ op: 'remove_exception_subprocess' }], catalog);
  assert.deepEqual(describe(doc, { maxLen: 0 }), before, 'the model is as before');
  assert.deepEqual(validate(doc), []);
});

test('exception subprocess that replies: Error Start -> End (message end)', () => {
  const doc = parseIflw(EMPTY);
  applyEdits(doc, [{ op: 'add_exception_subprocess', end: 'message' }], catalog);
  const end = findElement(doc, 'End 1');
  assert.equal(end.localName, 'endEvent');
  assert.equal(children(end, 'messageEventDefinition').length, 1);
  assert.equal(readProps(end).cmdVariantUri, 'ctype::FlowstepVariant/cname::MessageEndEvent/version::1.1.0');
  assert.deepEqual(validate(doc), []);
});

test('router and multicast: build, steps on routes and branches, layout in rows, edit routes, remove again', () => {
  const doc = parseIflw(EMPTY);
  applyEdits(doc, [
    { op: 'add_adapter', step: 'StartEvent_2', type: 'HTTPS', settings: { urlPath: '/branches' } },
    { op: 'insert_step', after: 'StartEvent_2', type: 'Content Modifier', name: 'Prepare' },
    { op: 'add_router', after: 'Prepare', routes: [{ name: 'EU', condition: "${header.region} = 'EU'" }, { name: 'Other' }], expressionType: 'NonXML' },
    { op: 'insert_step', route: 'EU', type: 'Content Modifier', name: 'Mark EU' },
    { op: 'insert_step', route: 'Other', type: 'Content Modifier', name: 'Mark other' },
    { op: 'add_multicast', after: 'Prepare', branches: ['A', 'B'] },
    { op: 'insert_step', route: 'A', type: 'Content Modifier', name: 'Do A' },
    { op: 'insert_step', route: 'B', type: 'Content Modifier', name: 'Do B' },
  ], catalog);
  const log = applyEdits(doc, [{ op: 'insert_step', after: 'Join', type: 'Gather', name: 'Gather' }, { op: 'layout' }], catalog);
  assert.match(log.at(-1)!, /laid out 11 elements in 9 columns and 2 rows/, 'branches far apart share the second row');
  assert.deepEqual(validate(doc), []);
  assert.deepEqual(overlapping(doc), []);

  // the router as the designer writes it: default attribute, route settings, a condition on the other route
  const router = findElement(doc, 'Router 1');
  const eu = byTag(doc, 'sequenceFlow').find((f) => f.getAttribute('name') === 'EU')!;
  const other = byTag(doc, 'sequenceFlow').find((f) => f.getAttribute('name') === 'Other')!;
  assert.equal(router.getAttribute('default'), other.getAttribute('id'));
  assert.equal(readProps(eu).expressionType, 'NonXML');
  assert.equal(readProps(eu).cmdVariantUri, 'ctype::FlowstepVariant/cname::GatewayRoute/version::1.0.0');
  assert.equal(children(eu, 'conditionExpression')[0]!.textContent, "${header.region} = 'EU'");
  assert.equal(children(other, 'conditionExpression').length, 0);
  assert.equal(children(findElement(doc, 'Join'), 'incoming').length, 2);

  // routes: rename, new condition, swap the default (the old default takes the condition)
  applyEdits(doc, [
    { op: 'set_route', route: 'EU', name: 'Europe', condition: "${header.region} in 'EU,EEA'" },
    { op: 'set_route', route: 'Europe', default: true },
  ], catalog);
  assert.equal(router.getAttribute('default'), eu.getAttribute('id'));
  assert.equal(children(eu, 'conditionExpression').length, 0);
  assert.equal(children(other, 'conditionExpression')[0]!.textContent, "${header.region} in 'EU,EEA'", 'the old default takes the condition');
  applyEdits(doc, [{ op: 'set_route', route: 'Other', condition: "${header.region} = 'US'" }], catalog);
  assert.equal(children(other, 'conditionExpression')[0]!.textContent, "${header.region} = 'US'");
  assert.throws(() => applyEdits(doc, [{ op: 'set_route', route: 'Europe', condition: '1 = 1' }], catalog), /default route and has no condition/);
  assert.deepEqual(validate(doc), []);

  // removing: refused while routes have steps; then everything back to Prepare -> Gather -> End
  assert.throws(() => applyEdits(doc, [{ op: 'remove_gateway', gateway: 'Router 1' }], catalog), /still have steps: .*Mark/);
  applyEdits(doc, [
    { op: 'remove_step', step: 'Mark EU' }, { op: 'remove_step', step: 'Mark other' }, { op: 'remove_gateway', gateway: 'Router 1' },
    { op: 'remove_step', step: 'Do A' }, { op: 'remove_step', step: 'Do B' }, { op: 'remove_gateway', gateway: 'Parallel Multicast 1' },
  ], catalog);
  const text = textconv(describe(doc, { maxLen: 0 }));
  assert.match(text, /flow "Prepare" -> "Gather"/);
  assert.match(text, /flow "Gather" -> "End"/);
  assert.equal(byTag(doc, 'exclusiveGateway').length + byTag(doc, 'parallelGateway').length, 0);
  assert.deepEqual(validate(doc), []);
  assert.deepEqual(overlapping(doc), []);
});

test('sequential multicast without join, a router route with its own End, and refusals', () => {
  const doc = parseIflw(EMPTY);
  applyEdits(doc, [
    { op: 'insert_step', after: 'StartEvent_2', type: 'Content Modifier', name: 'Prepare' },
    { op: 'add_multicast', after: 'Prepare', kind: 'sequential', branches: ['First', 'Second', 'Third'], join: false },
  ], catalog);
  const mc = findElement(doc, 'Sequential Multicast 1');
  const ids = byTag(doc, 'sequenceFlow').filter((f) => f.getAttribute('sourceRef') === mc.getAttribute('id')).map((f) => f.getAttribute('id'));
  assert.equal(readProps(mc).routingSequenceTable, ids.map((id, i) => `<row><cell>${i + 1}</cell><cell>${id}</cell></row>`).join(''));
  assert.equal(byTag(doc, 'endEvent').length, 3, 'the first branch leads on, the others end in their own End event');
  assert.deepEqual(validate(doc), []);
  assert.deepEqual(overlapping(doc), []);

  const r = parseIflw(EMPTY);
  applyEdits(r, [{ op: 'add_router', after: 'StartEvent_2', routes: [{ name: 'Reject', condition: "//status = 'X'", end: true }, { name: 'Go on' }] }], catalog);
  assert.equal(findElement(r, 'End Reject').localName, 'endEvent');
  assert.deepEqual(validate(r), []);
  // the route ends on its own: removing the router takes that End event along
  applyEdits(r, [{ op: 'remove_gateway', gateway: 'Router 1' }], catalog);
  assert.equal(byTag(r, 'endEvent').length, 1);
  assert.deepEqual(validate(r), []);

  const refused = (ops: object[], re: RegExp) => assert.throws(() => applyEdits(parseIflw(EMPTY), ops as never, catalog), re);
  refused([{ op: 'add_router', after: 'StartEvent_2', routes: [{ name: 'A' }, { name: 'B' }] }], /exactly one route must have no condition/);
  refused([{ op: 'add_router', after: 'StartEvent_2', routes: [{ name: 'A' }] }], /at least two routes/);
  refused([{ op: 'add_multicast', after: 'StartEvent_2', branches: ['A', 'A'] }], /must be different/);
  refused([{ op: 'insert_step', after: 'StartEvent_2', route: 'x', type: 'Content Modifier' }], /either "after".*or "route"/);
  refused([{ op: 'set_route', route: 'SequenceFlow_3', name: 'x' }], /not a route of a router/);
});

test('script collection reference: insert_step scriptCollection, manifest requirement as the designer writes it', () => {
  const doc = fresh();
  const log = applyEdits(doc, [{ op: 'insert_step', after: 'CallActivity_10', type: 'Groovy Script', version: '1.1.2', scriptCollection: 'Z01_SC01_Probe', settings: { script: 'ProbeUtil.groovy' } }], catalog);
  const id = log[0]!.match(/inserted (\S+)/)![1]!;
  const p = readProps(findElement(doc, id));
  assert.deepEqual([p.scriptBundleId, p.script], ['Z01_SC01_Probe', 'ProbeUtil.groovy']);
  assert.deepEqual(scriptCollectionRefs(doc), [{ step: id, collection: 'Z01_SC01_Probe', script: 'ProbeUtil.groovy' }]);
  assert.deepEqual(validate(doc, { resourceFiles: new Set() }).filter((i) => i.code === 'MISSING_RESOURCE' && i.msg.includes(id)), [], 'the script lives in the collection');
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'Groovy Script', scriptCollection: 'X' }], catalog), /needs settings\.script: its file name/);
  assert.throws(() => applyEdits(fresh(), [{ op: 'insert_step', after: 'CallActivity_10', type: 'Content Modifier', scriptCollection: 'X', settings: {} }], catalog), /Groovy Script and JavaScript steps only/);

  // the designer's line (measured), kept when it is already right; other capabilities stay; removed when unused
  const designer = 'Manifest-Version: 1.0\nBundle-Version: 1.4.2\nRequire-Capability: scriptcollection.Z01_SC01_Probe;resolution:=optional\n ;bundleType:String="ScriptCollection";source:String="reference"\n\n';
  const expected = 'Require-Capability: scriptcollection.Z01_SC01_Probe;resolution:=optional;bundleType:String="ScriptCollection";source:String="reference"';
  assert.ok(withCollectionRequirements(designer, ['Z01_SC01_Probe']).includes(expected));
  const added = withCollectionRequirements('Manifest-Version: 1.0\nBundle-Version: 1.0.0\n\n', ['B', 'A', 'B']);
  assert.match(added, /^Require-Capability: scriptcollection\.A;.*,scriptcollection\.B;resolution:=optional;bundleType:String="ScriptCollection";source:String="reference"$/m);
  const mixed = withCollectionRequirements('Require-Capability: osgi.ee;filter:="(osgi.ee=JavaSE)",scriptcollection.Old;resolution:=optional\n', ['New']);
  assert.match(mixed, /^Require-Capability: osgi\.ee;filter:="\(osgi\.ee=JavaSE\)",scriptcollection\.New;/m);
  assert.doesNotMatch(mixed, /scriptcollection\.Old/);
  assert.doesNotMatch(withCollectionRequirements(designer, []), /Require-Capability/);
});

test('validate: allowed headers separated by commas', () => {
  const doc = parseIflw(EMPTY);
  applyEdits(doc, [{ op: 'set', element: 'integrationFlow', settings: { allowedHeaderList: 'entryId,fail' }, allowNewKeys: true }], catalog);
  assert.match(validate(doc).map((i) => i.msg).join(), /separated by \| .*"entryId\|fail"/);
  applyEdits(doc, [{ op: 'set', element: 'integrationFlow', settings: { allowedHeaderList: 'entryId|fail' } }], catalog);
  assert.deepEqual(validate(doc).filter((i) => i.code === 'ALLOWED_HEADERS'), []);
});

test('validate: Groovy 2.x scripts under script/v2/, == in Camel conditions, header names (tester report)', () => {
  // insert_step refuses a 2.x step whose script is not under v2/, and accepts the right path
  assert.throws(() => applyEdits(parseIflw(EMPTY), [{ op: 'insert_step', after: 'StartEvent_2', type: 'Groovy Script', version: '2.0.0', settings: { script: 'helper.groovy' } }], catalog),
    /script\/v2\/: use settings\.script "v2\/helper\.groovy"/);
  const doc = parseIflw(EMPTY);
  const log = applyEdits(doc, [{ op: 'insert_step', after: 'StartEvent_2', type: 'Groovy Script', version: '2.0.0', settings: { script: 'v2/helper.groovy' } }], catalog);
  assert.deepEqual(validate(doc).filter((i) => i.code === 'INVALID_SETTING'), []);
  // a 2.x step edited to the wrong path is reported
  applyEdits(doc, [{ op: 'set', element: log[0]!.match(/inserted (\S+)/)![1]!, settings: { script: 'helper.groovy' } }], catalog);
  assert.match(validate(doc).map((i) => i.msg).join(), /takes its script from script\/v2\/; set script to "v2\/helper\.groovy"/);

  const r = parseIflw(EMPTY);
  applyEdits(r, [
    { op: 'add_router', after: 'StartEvent_2', expressionType: 'NonXML', routes: [{ name: 'EU', condition: "${header.region} == 'EU'" }, { name: 'Other' }] },
    { op: 'insert_step', route: 'Other', type: 'Content Modifier', name: 'Mark', headers: [{ name: '2', value: 'x' }, { name: 'X-Region', value: 'EU' }] },
  ], catalog);
  const msgs = validate(r).map((i) => `${i.severity} ${i.msg}`);
  assert.ok(msgs.some((m) => /^error route .*uses ==; Camel Simple compares with =/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /^warning .*header name "2" starts with a digit/.test(m)), msgs.join('\n'));
  assert.ok(!msgs.some((m) => /X-Region/.test(m)), 'normal names pass');
});
