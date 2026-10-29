import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendChangelog, applyEdits, bumpVersion, changelogPath, describe, loadCatalog, loadVersioningRules, locateIflow,
  parseConfig, readChangelog, readIflow, suggestPart,
} from '../dist/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const model = (name: string) => describe(readIflow(locateIflow(name, FIXTURES)), { maxLen: 0 });

test('bumpVersion: the raised part goes up, later parts start at 0', () => {
  assert.equal(bumpVersion('1.4.2', 'patch'), '1.4.3');
  assert.equal(bumpVersion('1.4.2', 'minor'), '1.5.0');
  assert.equal(bumpVersion('1.4.2', 'major'), '2.0.0');
  assert.equal(bumpVersion(undefined, 'patch'), '0.0.1');
});

test('suggestPart: added step -> minor; sender adapter change -> major; setting only -> patch; nothing -> patch', () => {
  const added = suggestPart(model('sample-before'), model('sample-after'));
  assert.equal(added.part, 'minor');
  assert.match(added.reasons.join(), /1 element\(s\) added/);

  const doc = readIflow(locateIflow('sample-after', FIXTURES));
  applyEdits(doc, [{ op: 'set', element: 'MessageFlow_4', settings: { urlPath: '/other' } }], loadCatalog());
  const sender = suggestPart(model('sample-after'), describe(doc, { maxLen: 0 }));
  assert.equal(sender.part, 'major');
  assert.match(sender.reasons[0]!, /sender adapter changed \(MessageFlow_4\)/);

  const doc2 = readIflow(locateIflow('sample-after', FIXTURES));
  applyEdits(doc2, [{ op: 'set', element: 'MessageFlow_8', settings: { httpRequestTimeout: '1000' } }], loadCatalog());
  assert.equal(suggestPart(model('sample-after'), describe(doc2, { maxLen: 0 })).part, 'patch');
  assert.deepEqual(suggestPart(model('sample-after'), model('sample-after')).reasons, ['no model changes']);
});

test('changelog: newest first, next to the iFlow folder, readable back', () => {
  const ws = mkdtempSync(join(tmpdir(), 'cpi-changelog-'));
  const path = changelogPath(join(ws, 'Pkg', 'Flow'), 'Flow');
  assert.equal(path, join(ws, 'Pkg', 'Flow.CHANGELOG.md'));
  appendChangelog(path, 'Flow', { version: '1.0.1', date: '2026-10-29', user: 'a@example.com', comment: 'patch: timeout raised' });
  appendChangelog(path, 'Flow', { version: '1.1.0', date: '2026-10-30', user: 'b@example.com', comment: 'minor: new step X' });
  assert.deepEqual(readChangelog(path).map((e) => `${e.version} ${e.user} ${e.comment}`), ['1.1.0 b@example.com minor: new step X', '1.0.1 a@example.com patch: timeout raised']);
  const text = readFileSync(path, 'utf8');
  assert.equal(text.match(/^# /gm)?.length, 1, 'one title');
  assert.match(text, /^# Flow: versions\n/);
});

test('versioning settings: default rules bundled, own file from the config folder', () => {
  assert.match(loadVersioningRules(), /^# Versioning rules/);
  const dir = mkdtempSync(join(tmpdir(), 'cpi-vcfg-'));
  const dflt = parseConfig({ tenants: { t: { apiKey: 'k' } } }, join(dir, 'config.json'));
  assert.deepEqual(dflt.versioning, {});
  const own = parseConfig({ tenants: { t: { apiKey: 'k' } }, versioning: { rules: 'rules/versioning.md' } }, join(dir, 'config.json'));
  assert.deepEqual(own.versioning, { rules: join(dir, 'rules', 'versioning.md') });
});

test('withVersion / zipVersion: the upload carries the new number, the rest of the manifest stays', async () => {
  const { zipSync, unzipSync } = await import('fflate');
  const { withVersion, zipVersion } = await import('../dist/index.js');
  const m = (v: string) => new Uint8Array(Buffer.from(`Manifest-Version: 1.0\nBundle-Name: Flow\nBundle-Version: ${v}\nImport-Package: x\n`));
  const local = zipSync({ 'META-INF/MANIFEST.MF': m('1.0.13'), 'a.txt': new Uint8Array([1]) });
  assert.equal(zipVersion(local), '1.0.13');
  const out = withVersion(local, '1.2.0');
  assert.equal(zipVersion(out), '1.2.0');
  assert.match(Buffer.from(unzipSync(out)['META-INF/MANIFEST.MF']!).toString('utf8'), /^Import-Package: x$/m);
  assert.deepEqual(unzipSync(out)['a.txt'], new Uint8Array([1]));
});
