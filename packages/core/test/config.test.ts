import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkServiceKey, ConfigError, loadConfig, packageAllowed, selectTenant } from '../dist/index.js';

// A project folder with .cpi/config.json and fake keys; home is a separate empty folder
function project(config: unknown, keys: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cpi-mcp-test-'));
  const home = mkdtempSync(join(tmpdir(), 'cpi-mcp-home-'));
  mkdirSync(join(root, '.cpi', 'keys'), { recursive: true });
  writeFileSync(join(root, '.cpi', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  for (const [name, content] of Object.entries(keys)) {
    writeFileSync(join(root, '.cpi', 'keys', name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { cwd: root, home, env: {} };
}

const KEY = { oauth: { clientid: 'id', clientsecret: 'very-secret', url: 'https://tenant.example.com/', tokenurl: 'https://auth.example.com/oauth/token' } };

test('defaults: readonly role, api deploy, warn guidelines, confirm push/deploy/undeploy', () => {
  const loc = project({ tenants: { trial: { apiKey: 'keys/api.json' } } });
  const c = loadConfig(loc);
  const t = c.tenants.trial!;
  assert.equal(t.role, 'readonly');
  assert.equal(t.deploy, 'api');
  assert.equal(t.guidelines, 'warn');
  assert.deepEqual(c.confirm, ['create', 'delete', 'push', 'deploy', 'undeploy']);
  assert.equal(c.defaultTenant, 'trial', 'the only tenant becomes the default');
  assert.equal(c.experimental.trace, false);
  assert.equal(c.output.maxChars, 20000);
  assert.equal(c.workspace, loc.cwd);
});

test('relative paths resolve from the config file folder; ~ is the home folder', () => {
  const loc = project({ tenants: { a: { apiKey: 'keys/api.json', runtimeKey: '~/rt.json' } }, auditLog: 'logs/audit.log' });
  const c = loadConfig(loc);
  assert.equal(c.tenants.a!.apiKey, join(loc.cwd, '.cpi', 'keys', 'api.json'));
  assert.equal(c.tenants.a!.runtimeKey, join(loc.home, 'rt.json'));
  assert.equal(c.auditLog, join(loc.cwd, '.cpi', 'logs', 'audit.log'));
});

test('lookup order: CPI_MCP_CONFIG, then project, then user folder', () => {
  const loc = project({ tenants: { project: { apiKey: 'k.json' } } });
  mkdirSync(join(loc.home, '.config', 'cpi-saper-dev-mcp'), { recursive: true });
  const userCfg = join(loc.home, '.config', 'cpi-saper-dev-mcp', 'config.json');
  writeFileSync(userCfg, JSON.stringify({ tenants: { user: { apiKey: 'k.json' } } }));
  assert.ok(loadConfig(loc).tenants.project, 'project config wins over user config');
  assert.ok(loadConfig({ ...loc, cwd: loc.home }).tenants.user, 'user config when the project has none');
  assert.ok(loadConfig({ ...loc, env: { CPI_MCP_CONFIG: userCfg } }).tenants.user, 'CPI_MCP_CONFIG wins');
  assert.throws(() => loadConfig({ ...loc, env: { CPI_MCP_CONFIG: '/nope.json' } }), /CPI_MCP_CONFIG points to/);
});

test('no configuration: error lists the places searched', () => {
  const home = mkdtempSync(join(tmpdir(), 'cpi-mcp-empty-'));
  assert.throws(() => loadConfig({ cwd: home, home, env: {} }), (e: Error) =>
    e instanceof ConfigError && e.message.includes('.cpi/config.json') && e.message.includes('.config/cpi-saper-dev-mcp'));
});

test('invalid values are reported with their path', () => {
  const loc = project({ tenants: { t: { apiKey: 'k', role: 'admin', deploy: 'later' } }, confirm: ['explode'], extra: 1 });
  assert.throws(() => loadConfig(loc), (e: Error) =>
    /tenants\.t\.role/.test(e.message) && /tenants\.t\.deploy/.test(e.message) && /confirm\.0/.test(e.message) && /extra/.test(e.message));
});

test('script runner only on development tenants; defaultTenant must exist', () => {
  assert.throws(() => loadConfig(project({ tenants: { t: { apiKey: 'k', scriptRunner: '/v2/test/script' } } })), /scriptRunner: only allowed/);
  assert.throws(() => loadConfig(project({ defaultTenant: 'x', tenants: { t: { apiKey: 'k' } } })), /defaultTenant: "x"/);
  assert.throws(() => loadConfig(project('{ not json')), /not valid JSON/);
});

test('selectTenant: named, default, or a clear error', () => {
  const c = loadConfig(project({ tenants: { a: { apiKey: 'k' }, b: { apiKey: 'k' } } }));
  assert.equal(selectTenant(c, 'b').name, 'b');
  assert.throws(() => selectTenant(c), /no tenant given and no defaultTenant/);
  assert.throws(() => selectTenant(c, 'z'), /unknown tenant "z"; tenants: a, b/);
});

test('packageAllowed: readonly never; patterns match Id or name, case-insensitive', () => {
  const c = loadConfig(project({ tenants: {
    ro: { apiKey: 'k' },
    dev: { apiKey: 'k', role: 'development' },
    some: { apiKey: 'k', role: 'development', allowedPackages: ['Z01*', 'Shared.Tools'] },
  } }));
  assert.equal(packageAllowed(c.tenants.ro!, { id: 'Z01Claude' }), false);
  assert.equal(packageAllowed(c.tenants.dev!, { id: 'Anything' }), true);
  assert.equal(packageAllowed(c.tenants.some!, { id: 'z01claude' }), true);
  assert.equal(packageAllowed(c.tenants.some!, { id: 'X', name: 'Z01_Claude' }), true);
  assert.equal(packageAllowed(c.tenants.some!, { id: 'SharedXTools' }), false, '"." is literal, not a regex wildcard');
  assert.equal(packageAllowed(c.tenants.some!, { id: 'Other' }), false);
});

test('checkServiceKey: host only, never secret values', () => {
  const loc = project({ tenants: { t: { apiKey: 'keys/api.json' } } }, { 'api.json': KEY, 'bad.json': '{"oauth":{"clientid":"x"}}', 'broken.json': '{ "clientsecret": "leak' });
  const dir = join(loc.cwd, '.cpi', 'keys');
  const ok = checkServiceKey(join(dir, 'api.json'));
  assert.deepEqual(ok, { status: 'ok', host: 'tenant.example.com' });
  assert.equal(checkServiceKey(join(dir, 'none.json')).status, 'missing');
  const bad = checkServiceKey(join(dir, 'bad.json'));
  assert.equal(bad.status, 'invalid');
  assert.match((bad as { problem: string }).problem, /clientsecret, url, tokenurl/);
  const broken = checkServiceKey(join(dir, 'broken.json'));
  assert.equal(broken.status, 'invalid');
  for (const r of [ok, bad, broken]) assert.doesNotMatch(JSON.stringify(r), /very-secret|leak/);
});
