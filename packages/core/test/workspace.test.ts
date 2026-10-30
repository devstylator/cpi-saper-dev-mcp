import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { iflowFromZip, localChanges, locateIflow, unzipEntries, Workspace, describe } from '../dist/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

// The fixture folder zipped like the tenant exports it
function zipOf(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else files[relative(dir, p).split('\\').join('/')] = new Uint8Array(readFileSync(p));
    }
  };
  walk(dir);
  return zipSync(files);
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'cpi-ws-'));
  return new Workspace(root, join(root, '.cpi', 'state'));
}
const INFO = { iflowId: 'SampleFlow', packageId: 'SamplePkg', version: '1.0.9' };

test('pull writes <package>/<iflow>/ and keeps the pulled state', () => {
  const ws = workspace();
  const r = ws.pull('trial', INFO, zipOf(join(FIXTURES, 'sample-before')));
  assert.equal(r.dir, join(ws.root, 'SamplePkg', 'SampleFlow'));
  assert.ok(r.files.includes('src/main/resources/scenarioflows/integrationflow/SampleFlow.iflw'));
  assert.equal(ws.pulledState('trial', 'SampleFlow')?.state.version, '1.0.9');
  assert.equal(ws.pulledStateFor(r.dir)?.state.tenant, 'trial');
  assert.equal(locateIflow('SampleFlow', ws.root).dir, r.dir, 'found by iFlow id');
  assert.deepEqual(localChanges(r.dir, ws.pulledState('trial', 'SampleFlow')!.zip), []);
});

test('pull again: fine without local changes; refuses with them unless overwrite; removes files gone on the tenant', () => {
  const ws = workspace();
  const { dir } = ws.pull('trial', INFO, zipOf(join(FIXTURES, 'sample-after')));
  ws.pull('trial', INFO, zipOf(join(FIXTURES, 'sample-after')));
  writeFileSync(join(dir, 'src/main/resources/script/script1.groovy'), '// changed locally\n');
  assert.throws(() => ws.pull('trial', INFO, zipOf(join(FIXTURES, 'sample-before'))), /local changes since the last pull \(src\/main\/resources\/script\/script1\.groovy\)/);
  ws.pull('trial', INFO, zipOf(join(FIXTURES, 'sample-before')), { overwrite: true });
  assert.equal(existsSync(join(dir, 'src/main/resources/mapping/ClaudeAggregate.xsl')), false, 'file of the previous pull removed');
  assert.notEqual(readFileSync(join(dir, 'src/main/resources/script/script1.groovy'), 'utf8'), '// changed locally\n');
});

test('pull refuses a non-empty folder it did not create', () => {
  const ws = workspace();
  const dir = ws.iflowDir('SamplePkg', 'SampleFlow');
  ws.pull('other', INFO, zipOf(join(FIXTURES, 'sample-before'))); // creates the folder under another tenant's state
  assert.throws(() => ws.pull('trial', INFO, zipOf(join(FIXTURES, 'sample-before'))), /was not pulled by this tool/);
  assert.ok(existsSync(dir));
});

test('a renamed tenant: the stale record of the old name neither wins nor survives a new pull', () => {
  const ws = workspace();
  const { dir } = ws.pull('dev', INFO, zipOf(join(FIXTURES, 'sample-before')));
  // the tenant was renamed dev -> trial: the record under dev/ is left behind
  assert.equal(ws.pulledStateFor(dir, 'trial')?.state.tenant, 'dev', 'only record: still found');
  ws.pull('trial', INFO, zipOf(join(FIXTURES, 'sample-before')), { overwrite: true });
  assert.equal(ws.pulledStateFor(dir, 'trial')?.state.tenant, 'trial');
  assert.equal(ws.pulledStateFor(dir)?.state.tenant, 'trial');
  assert.equal(ws.pulledState('dev', 'SampleFlow'), undefined, 'stale record removed');
});

test('localChanges ignores the timestamp comment in .prop files', () => {
  const ws = workspace();
  const { dir } = ws.pull('trial', INFO, zipOf(join(FIXTURES, 'sample-before')));
  const prop = join(dir, 'metainfo.prop');
  writeFileSync(prop, readFileSync(prop, 'utf8').replace(/^#.*$/m, '#Thu Jan 01 00:00:00 UTC 2099'));
  assert.deepEqual(localChanges(dir, ws.pulledState('trial', 'SampleFlow')!.zip), []);
});

test('zip safety and reading the iFlow back from the pulled zip', () => {
  assert.throws(() => unzipEntries(zipSync({ '../evil.txt': new Uint8Array([1]) })), /unsafe zip entry/);
  assert.throws(() => workspace().iflowDir('..', 'x'), /cannot be used as a folder name/);
  const doc = iflowFromZip(zipOf(join(FIXTURES, 'sample-before')));
  assert.equal(describe(doc).processes[0]!.name, 'Integration Process');
});
