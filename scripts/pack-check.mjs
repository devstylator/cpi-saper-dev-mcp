// Installs the published package the way a user gets it (npm pack -> install the .tgz into an empty folder) and
// checks it works there: the textconv command, the MCP server's tools, the bundled catalog and versioning rules.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'cpi-mcp-pack-'));
const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const tgz = npm(['pack', '--pack-destination', work, '--silent'], join(root, 'packages', 'mcp-server')).trim().split('\n').at(-1);
const app = join(work, 'app');
mkdirSync(app);
writeFileSync(join(app, 'package.json'), '{"name":"pack-check","private":true}');
npm(['install', '--silent', '--no-audit', '--no-fund', join(work, tgz)], app);
const bin = join(app, 'node_modules', '.bin', 'cpi-saper-dev-mcp');

const iflw = join(root, 'packages', 'core', 'test', 'fixtures', 'sample-after', 'src', 'main', 'resources', 'scenarioflows', 'integrationflow', 'SampleFlow.iflw');
assert.match(execFileSync(bin, ['textconv', iflw], { encoding: 'utf8' }), /Aggregate IP data/);

// a project with a configuration, as a user would have it
const project = join(work, 'project');
mkdirSync(join(project, '.cpi'), { recursive: true });
writeFileSync(join(project, '.cpi', 'config.json'), JSON.stringify({ tenants: { t: { apiKey: 'keys/api.json' } } }));
const client = new Client({ name: 'pack-check', version: '0' });
await client.connect(new StdioClientTransport({ command: bin, args: [], cwd: project, stderr: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: work } }));
try {
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 50, `tools: ${tools.length}`);
  const cat = await client.callTool({ name: 'templates_list', arguments: { kind: 'adapter' } });
  assert.ok(!cat.isError && JSON.parse(cat.content[0].text).entries.length > 20, 'bundled catalog found');
  const rules = await client.readResource({ uri: 'cpi://rules/versioning' });
  assert.match(rules.contents[0].text, /major|minor|patch/i, 'bundled versioning rules found');
  console.log(`pack check passed: ${tgz} installed, ${tools.length} tools, catalog and rules found, textconv works`);
} finally {
  await client.close();
}
