import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe, diffIflows, findEntries, loadCatalog, locateIflow, pickVersion, readIflow, textconv, toMermaid, validate,
  type Container, type Step,
} from '../dist/index.js';

// Fixtures: one iFlow before and after an XSLT Mapping step was inserted (measured on a trial tenant)
const FIXTURES = join(import.meta.dirname, 'fixtures');
const flat = (c: Container): Step[] => c.steps.flatMap((s) => [s, ...(s.steps ? flat(s as Container) : [])]);

test('describe: steps numbered in flow order, tables decoded', () => {
  const m = describe(readIflow(locateIflow('sample-after', FIXTURES)));
  const numbered = flat(m.processes[0]!).filter((s) => s.no).sort((a, b) => a.no! - b.no!).map((s) => `#${s.no} ${s.name}`);
  assert.deepEqual(numbered, ['#1 Get IP', '#2 Groovy Script 1', '#3 JSON to XML Converter 1', '#4 Aggregate IP data',
    '#5 set content type', '#6 Router 1', '#7 Claude marker']);
  const cm = flat(m.processes[0]!).find((s) => s.name === 'set content type')!;
  assert.deepEqual(cm.config?.headerTable, [{ Action: 'Create', Type: 'constant', Value: 'application/xml', Default: '', Name: 'Content-Type', Datatype: '' }]);
  assert.deepEqual(m.adapters.map((a) => `${a.adapter} ${a.direction}`), ['HTTP Receiver', 'HTTPS Sender']);
  assert.deepEqual(m.externalizedParameters, ['accessURL']);
  assert.deepEqual(m.resourceRefs.map((r) => r.path), ['script/script1.groovy', 'mapping/ClaudeAggregate.xsl']);
});

test('validate: clean iFlow passes; a missing XSLT file is an error', () => {
  const ok = locateIflow('sample-after', FIXTURES);
  assert.deepEqual(validate(readIflow(ok), ok), []);
  const dir = mkdtempSync(join(tmpdir(), 'cpi-val-'));
  cpSync(join(FIXTURES, 'sample-after'), dir, { recursive: true });
  rmSync(join(dir, 'src/main/resources/mapping/ClaudeAggregate.xsl'));
  const broken = locateIflow(dir, FIXTURES);
  assert.deepEqual(validate(readIflow(broken), broken).map((i) => `${i.severity} ${i.code}`), ['error MISSING_RESOURCE']);
});

test('mermaid: display numbers written as #35; (Mermaid entity for #)', () => {
  const mm = toMermaid(describe(readIflow(locateIflow('sample-after', FIXTURES))));
  assert.match(mm, /^flowchart LR/);
  assert.match(mm, /ServiceTask_5\["#35;1 Get IP<br\/><i>ExternalCall<\/i>"\]/);
});

test('diff: an inserted step shows as one step and rewired flows; layout only counted', () => {
  const [a, b] = ['sample-before', 'sample-after'].map((n) => readIflow(locateIflow(n, FIXTURES)));
  const lines = diffIflows(describe(a!, { maxLen: 0 }), describe(b!, { maxLen: 0 }), { docA: a!, docB: b! });
  assert.deepEqual(lines.filter((l) => !l.startsWith('    ')), [
    '+ step #4 "Aggregate IP data" (Mapping:XSLTMapping 1.2.0) [CallActivity_21] in "Integration Process"',
    '+ flow #3 "JSON to XML Converter 1" -> #4 "Aggregate IP data"',
    '+ flow #4 "Aggregate IP data" -> #5 "set content type"',
    '- flow #3 "JSON to XML Converter 1" -> #5 "set content type"',
    '  (layout: 5 shapes moved or resized, not shown)',
  ]);
  assert.ok(lines.includes('    mappinguri = "dir://mapping/xslt/src/main/resources/mapping/ClaudeAggregate.xsl"'));
  assert.deepEqual(diffIflows(describe(b!), describe(b!), { docA: b!, docB: b! }), [], 'no changes: no lines');
});

test('textconv: one fact per line, no display numbers', () => {
  const t = textconv(describe(readIflow(locateIflow('sample-after', FIXTURES)), { maxLen: 0 }));
  assert.ok(t.includes('  callActivity "Aggregate IP data" (Mapping:XSLTMapping 1.2.0) [CallActivity_21]'));
  assert.doesNotMatch(t, /#\d/);
});

test('catalog: bundled, found by label or cname; version follows the iFlow', () => {
  const c = loadCatalog();
  assert.equal(Object.keys(c.entries).length, 106);
  const [[key, cm]] = findEntries(c, 'content modifier') as [[string, ReturnType<typeof loadCatalog>['entries'][string]]];
  assert.equal(key, 'ctype::FlowstepVariant/cname::Enricher');
  assert.equal(findEntries(c, 'GroovyScript').length, 1);
  assert.equal(findEntries(c, 'End').length, 3, 'ambiguous label: several entries');
  const doc = readIflow(locateIflow('sample-after', FIXTURES));
  assert.deepEqual(pickVersion(cm, key, doc), { version: '1.6.6', reason: 'already used in this iFlow' });
  const [[gkey, groovy]] = findEntries(c, 'Groovy Script') as [[string, typeof cm]];
  assert.deepEqual(pickVersion(groovy, gkey, doc), { version: '1.1.2', reason: 'already used in this iFlow' });
  assert.throws(() => pickVersion(groovy, gkey, doc, '9.9.9'), /no version 9\.9\.9/);
});
