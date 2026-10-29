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

test('lists cpi_tenants as a read-only tool', async () => {
  const client = await connect(projectWithConfig());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['cpi_tenants']);
  assert.equal(tools[0]!.annotations?.readOnlyHint, true);
  await client.close();
});

test('finds the configuration in the working folder when the client reports no roots', async () => {
  const project = projectWithConfig();
  const client = await connect(project);
  const r = await tenants(client);
  assert.equal(r.isError, false);
  assert.equal(JSON.parse(r.text).configFile, join(project, '.cpi', 'config.json'));
  await client.close();
});

test('uses the client roots: the first one with .cpi/config.json, wherever the server was started', async () => {
  const project = projectWithConfig();
  const elsewhere = mkdtempSync(join(tmpdir(), 'cpi-mcp-other-'));
  const client = await connect(elsewhere, [elsewhere, project]);
  const r = await tenants(client);
  assert.equal(r.isError, false);
  assert.equal(JSON.parse(r.text).configFile, join(project, '.cpi', 'config.json'));
  assert.equal(JSON.parse(r.text).workspace, project);
  await client.close();
});

test('explains where it looked when there is no configuration', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'cpi-mcp-empty-'));
  const client = await connect(empty);
  const r = await tenants(client);
  assert.equal(r.isError, true);
  assert.match(r.text, /no configuration found/);
  await client.close();
});
