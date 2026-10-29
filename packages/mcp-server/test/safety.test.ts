import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseConfig } from '@cpi-saper-dev-mcp/core';
import { audit, confirmAction, Declined } from '../dist/safety.js';

const config = (confirm?: string[]) => parseConfig({ tenants: { t: { apiKey: 'k' } }, ...(confirm ? { confirm } : {}) },
  join(mkdtempSync(join(tmpdir(), 'cpi-safety-')), 'config.json'));

// Stand-in for the SDK server: client capabilities and the user's answer
function fakeServer(elicitation: boolean, answer?: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) {
  const asked: string[] = [];
  const server = {
    server: {
      getClientCapabilities: () => (elicitation ? { elicitation: {} } : {}),
      elicitInput: async (p: { message: string }) => { asked.push(p.message); return answer!; },
    },
  } as unknown as McpServer;
  return { server, asked };
}

test('confirmAction: not configured -> no question', async () => {
  const { server, asked } = fakeServer(true, { action: 'decline' });
  assert.deepEqual(await confirmAction(server, config(), 'save_version', 'Save?'), {});
  assert.equal(asked.length, 0);
});

test('confirmAction: client without elicitation -> refused with an explanation', async () => {
  const { server } = fakeServer(false);
  await assert.rejects(confirmAction(server, config(), 'push', 'Push?'), /"push" needs your confirmation .* cannot ask \(no MCP elicitation support\)/);
});

test('confirmAction: accept returns the form values; decline and cancel stop the action', async () => {
  const yes = fakeServer(true, { action: 'accept', content: { saveVersion: '1.0.11' } });
  assert.deepEqual(await confirmAction(yes.server, config(), 'deploy', 'Deploy X?'), { saveVersion: '1.0.11' });
  assert.deepEqual(yes.asked, ['Deploy X?']);
  await assert.rejects(confirmAction(fakeServer(true, { action: 'decline' }).server, config(), 'deploy', 'Deploy?'),
    (e: Error) => e instanceof Declined && /the user declined: deploy was not done/.test(e.message));
  await assert.rejects(confirmAction(fakeServer(true, { action: 'cancel' }).server, config(), 'deploy', 'Deploy?'), /closed the question without deciding/);
  // an empty confirm list means: never ask
  assert.deepEqual(await confirmAction(fakeServer(false).server, config([]), 'push', 'Push?'), {});
});

test('audit: one JSON line per change', () => {
  const c = config();
  audit(c, { tenant: 't', tool: 'cpi_push', artifact: 'Flow', result: 'pushed' });
  audit(c, { tenant: 't', tool: 'cpi_deploy', artifact: 'Flow', result: 'STARTED' });
  const lines = readFileSync(c.auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.tool, l.result]), [['cpi_push', 'pushed'], ['cpi_deploy', 'STARTED']]);
  assert.match(lines[0].time, /^\d{4}-\d\d-\d\dT/);
});
