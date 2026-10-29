import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function projectWithConfig() {
  const root = mkdtempSync(join(tmpdir(), 'cpi-mcp-project-'));
  mkdirSync(join(root, '.cpi'));
  writeFileSync(join(root, '.cpi', 'config.json'), JSON.stringify({ tenants: { t: { apiKey: 'keys/api.json' } } }));
  return root;
}

// Starts the built server in `cwd`; with `roots`, the client reports them like VS Code does
async function connect(cwd: string, roots?: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'cpi-mcp-home-')); // no user-level config
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER], cwd, stderr: 'ignore',
    env: { PATH: process.env.PATH ?? '', HOME: home },
  });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: roots ? { roots: {} } : {} });
  if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
  await client.connect(transport);
  return client;
}

async function tenants(client: Client) {
  const r = await client.callTool({ name: 'cpi_tenants', arguments: {} });
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  return { isError: Boolean(r.isError), text };
}

test('lists the tools; only cpi_pull, iflow_edit and script_run are not read-only', async () => {
  const client = await connect(projectWithConfig());
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['cpi_tenants', 'cpi_packages', 'cpi_artifacts', 'cpi_pull',
      'iflow_describe', 'iflow_render', 'iflow_validate', 'iflow_diff', 'templates_list',
      'iflow_edit', 'xslt_run', 'mapping_describe', 'script_run']);
    assert.deepEqual(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name), ['cpi_pull', 'iflow_edit', 'script_run']);
  } finally {
    await client.close();
  }
});

test('finds the configuration in the working folder when the client reports no roots', async () => {
  const project = projectWithConfig();
  const client = await connect(project);
  try {
    const r = await tenants(client);
    assert.equal(r.isError, false);
    assert.equal(JSON.parse(r.text).configFile, join(project, '.cpi', 'config.json'));
  } finally {
    await client.close();
  }
});

test('uses the client roots: the first one with .cpi/config.json, wherever the server was started', async () => {
  const project = projectWithConfig();
  const elsewhere = mkdtempSync(join(tmpdir(), 'cpi-mcp-other-'));
  const client = await connect(elsewhere, [elsewhere, project]);
  try {
    const r = await tenants(client);
    assert.equal(r.isError, false);
    assert.equal(JSON.parse(r.text).configFile, join(project, '.cpi', 'config.json'));
    assert.equal(JSON.parse(r.text).workspace, project);
  } finally {
    await client.close();
  }
});

test('explains where it looked when there is no configuration', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'cpi-mcp-empty-'));
  const client = await connect(empty);
  try {
    const r = await tenants(client);
    assert.equal(r.isError, true);
    assert.match(r.text, /no configuration found/);
  } finally {
    await client.close();
  }
});

// Workspace = the core test fixtures (one iFlow before and after an XSLT step was inserted)
function projectOnFixtures() {
  const root = projectWithConfig();
  const fixtures = fileURLToPath(new URL('../../core/test/fixtures', import.meta.url));
  writeFileSync(join(root, '.cpi', 'config.json'), JSON.stringify({ tenants: { t: { apiKey: 'keys/api.json' } }, workspace: fixtures }));
  return root;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: (r.content as Array<{ text: string }>)[0]!.text, data: r.structuredContent as Record<string, any> };
}

test('local tools on an iFlow in the workspace', async () => {
  const client = await connect(projectOnFixtures());
  try {
    const d = await call(client, 'iflow_describe', { iflow: 'sample-after' });
    assert.equal(d.isError, false);
    assert.equal(d.data.processes[0].steps.find((s: { no?: number }) => s.no === 4).name, 'Aggregate IP data');
    const v = await call(client, 'iflow_validate', { iflow: 'sample-after' });
    assert.deepEqual([v.data.errors, v.data.warnings], [0, 0]);
    const m = await call(client, 'iflow_render', { iflow: 'sample-after' });
    assert.match(m.text, /^```mermaid\nflowchart LR/);
    const diff = await call(client, 'iflow_diff', { iflow: 'sample-after', against: 'sample-before' });
    assert.ok(diff.data.changes.includes('+ flow #3 "JSON to XML Converter 1" -> #4 "Aggregate IP data"'));
    const noBase = await call(client, 'iflow_diff', { iflow: 'sample-after' });
    assert.equal(noBase.isError, true);
    assert.match(noBase.text, /no pulled state/);
    const missing = await call(client, 'iflow_describe', { iflow: 'NoSuchFlow' });
    assert.match(missing.text, /not found .* pull it first/);
  } finally {
    await client.close();
  }
});

test('templates_list: overview and one entry with its defaults', async () => {
  const client = await connect(projectOnFixtures());
  try {
    const all = await call(client, 'templates_list', { kind: 'adapter' });
    assert.equal(all.data.entries.length, 31);
    const cm = await call(client, 'templates_list', { query: 'Content Modifier' });
    assert.equal(cm.data.matches[0].key, 'ctype::FlowstepVariant/cname::Enricher');
    assert.ok(cm.data.matches[0].versions['1.6.6'].properties);
    assert.equal((await call(client, 'templates_list', { query: 'Nope' })).isError, true);
  } finally {
    await client.close();
  }
});
