import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planNumberRange, readParams, readProp, setParams } from '../dist/index.js';

// as the current designer writes them: no line break between blocks, a reference section at the end
const PROPDEF = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><parameters><parameter>\n    <key/>\n    <name>accessURL</name>\n    <type>xsd:string</type>\n' +
  '    <isRequired>false</isRequired>\n    <constraint/>\n    <description/>\n    <additionalMetadata/>\n  </parameter><param_references><reference attribute_category="Sender" ' +
  'attribute_id="/attrId::urlPath" attribute_uilabel="" param_key="accessURL"/></param_references></parameters>';
const PROP = '#Thu Oct 29 13:11:20 UTC 2026\naccessURL=/test\nEnable\\ Logging\\ (Y/N)=N\nLast\\ Modified=2023-03-28T00\\:00\\:00Z\n';

function iflowDir(withFiles = true) {
  const dir = mkdtempSync(join(tmpdir(), 'cpi-params-'));
  const res = join(dir, 'src', 'main', 'resources');
  mkdirSync(res, { recursive: true });
  if (withFiles) { writeFileSync(join(res, 'parameters.propdef'), PROPDEF); writeFileSync(join(res, 'parameters.prop'), PROP); }
  return { dir, def: () => readFileSync(join(res, 'parameters.propdef'), 'utf8'), prop: () => readFileSync(join(res, 'parameters.prop'), 'utf8') };
}

test('parameters.prop: Java escaping read and written like java.util.Properties', () => {
  const v = readProp(PROP);
  assert.equal(v.get('Enable Logging (Y/N)'), 'N');
  assert.equal(v.get('Last Modified'), '2023-03-28T00:00:00Z');
  const f = iflowDir();
  setParams(f.dir, [{ name: 'Target Host', value: 'https://x.example.com:8443/a=b' }]);
  assert.match(f.prop(), /^Target\\ Host=https\\:\/\/x.example.com\\:8443\/a\\=b$/m);
  assert.equal(readParams(f.dir).find((p) => p.name === 'Target Host')?.value, 'https://x.example.com:8443/a=b');
});

test('setParams: change a value in place, declare before the references, keep everything else', () => {
  const f = iflowDir();
  assert.deepEqual(setParams(f.dir, [{ name: 'accessURL', value: '/orders' }]), ['accessURL = /orders']);
  assert.equal(f.prop(), PROP.replace('accessURL=/test', 'accessURL=/orders'), 'only that line changes');
  assert.equal(f.def(), PROPDEF, 'the declaration is untouched');

  const log = setParams(f.dir, [{ name: 'timeout', type: 'xsd:integer', value: '30', description: 'seconds' }]);
  assert.deepEqual(log, ['declared timeout (xsd:integer)', 'timeout = 30']);
  assert.ok(f.def().startsWith(PROPDEF.slice(0, PROPDEF.indexOf('<param_references>'))), 'existing text unchanged');
  assert.match(f.def(), /<\/parameter><parameter>\n {4}<key\/>\n {4}<name>timeout<\/name>\n {4}<type>xsd:integer<\/type>[\s\S]*<description>seconds<\/description>[\s\S]*<\/parameter><param_references>/);
  assert.deepEqual(readParams(f.dir).map((p) => [p.name, p.type, p.value]), [['accessURL', 'xsd:string', '/orders'], ['timeout', 'xsd:integer', '30']]);

  setParams(f.dir, [{ name: 'timeout', required: true }]);
  assert.equal(readParams(f.dir).find((p) => p.name === 'timeout')?.required, true);
  assert.throws(() => setParams(f.dir, [{ name: 'timeout', value: 'soon' }]), /not a whole number/);
  assert.throws(() => setParams(f.dir, [{ name: 'x', type: 'xsd:float' }]), /not one of/);
  assert.throws(() => setParams(f.dir, [], ['nope']), /not declared/);

  // removing takes the declaration, the value and the designer's reference
  setParams(f.dir, [], ['accessURL']);
  assert.doesNotMatch(f.def(), /accessURL/);
  assert.doesNotMatch(f.prop(), /accessURL/);
  assert.match(f.def(), /<param_references><\/param_references><\/parameters>$/);
});

test('setParams: an iFlow without parameter files gets both, as the designer writes them', () => {
  const f = iflowDir(false);
  setParams(f.dir, [{ name: 'region', value: 'EU' }]);
  assert.match(f.def(), /^<\?xml version="1.0" encoding="UTF-8" standalone="no"\?><parameters><parameter>\n {4}<key\/>\n {4}<name>region<\/name>[\s\S]*<\/parameter><\/parameters>$/);
  assert.match(f.prop(), /^#\w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2} UTC \d{4}\nregion=EU\n$/);
});

test('number ranges: planned and checked before anything is sent', () => {
  const r = planNumberRange('N', { max: '9999', fieldLength: '4' });
  assert.deepEqual([r.min, r.max, r.current, r.rotate], ['0', '9999', '0', false]);
  assert.equal(planNumberRange('N', { max: '500' }).fieldLength, '3', 'field length defaults to the digits of max');
  const changed = planNumberRange('N', { current: '42', rotate: true }, r);
  assert.deepEqual([changed.max, changed.current, changed.rotate, changed.fieldLength], ['9999', '42', true, '4'], 'what is not given stays');
  assert.throws(() => planNumberRange('N', {}), /needs max/);
  assert.throws(() => planNumberRange('N', { current: '10000' }, r), /outside 0\.\.9999/);
  assert.throws(() => planNumberRange('N', { max: '99999' }, r), /does not fit in field length 4/);
  assert.throws(() => planNumberRange('N', { min: '5', max: '1' }), /above max/);
  assert.throws(() => planNumberRange('N', { max: '1e3' }), /not a whole number/);
});
