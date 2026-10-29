import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getIflow, getMessage, listMessages, redactor, sendMessage, setLogLevel, stepTraces } from '@cpi-saper-dev-mcp/core';
import { context, stepNamesFor, tenantApi, tenantRuntime } from '../context.js';
import { toolError, toolResult } from '../result.js';
import { assertMayChange, audit } from '../safety.js';

const tenantArg = z.string().optional().describe('Tenant name from the configuration; default: defaultTenant');
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n…(cut: ${s.length} characters, limit output.maxChars = ${max})` : s);

export function registerTestTools(server: McpServer) {
  server.registerTool(
    'cpi_send_message',
    {
      title: 'Send a test message',
      description:
        'Call a deployed iFlow\'s HTTP endpoint (https://<runtime>/http<path>, the HTTPS sender\'s address) on a ' +
        'development tenant. Returns the HTTP status, response headers and body, and the message log id (also for ' +
        'failed calls) to read with cpi_message.',
      inputSchema: {
        path: z.string().describe('Endpoint path as configured in the HTTPS sender, e.g. /test'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
        body: z.string().optional(),
        bodyFile: z.string().optional().describe('File with the request body (relative to the workspace or absolute), instead of "body"'),
        headers: z.record(z.string(), z.string()).optional(),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ path, method, body, bodyFile, headers, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const rt = tenantRuntime(ctx.config, tenantName);
        if (rt.tenant.role !== 'development') throw new Error(`tenant "${rt.tenant.name}" is ${rt.tenant.role}: test messages go to development tenants only`);
        const text = bodyFile ? readFileSync(isAbsolute(bodyFile) ? bodyFile : resolve(ctx.workspace.root, bodyFile), 'utf8') : body;
        const r = await sendMessage(rt.client, path, { method, ...(text !== undefined ? { body: text } : {}), headers: headers ?? {}, redact: redactor(ctx.config.redact) });
        return toolResult({ ...r, body: clip(r.body, ctx.config.output.maxChars) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_messages',
    {
      title: 'Search message logs',
      description: 'Message processing logs, newest first, optionally for one iFlow and/or one status (COMPLETED, FAILED, RETRY, ESCALATED, PROCESSING).',
      inputSchema: {
        iflow: z.string().optional().describe('iFlow Id'),
        status: z.enum(['COMPLETED', 'FAILED', 'RETRY', 'ESCALATED', 'PROCESSING', 'DISCARDED', 'ABANDONED']).optional(),
        top: z.number().int().min(1).max(100).default(10),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ iflow, status, top, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        return toolResult({ messages: await listMessages(api.client, { ...(iflow ? { iflow } : {}), ...(status ? { status } : {}), top }) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_message',
    {
      title: 'One message log',
      description:
        'One message processing log: status, error text with the failing step by name, and every processing step ' +
        'with its status (step ids translated to step names and display numbers). Use the id from cpi_send_message or cpi_messages.',
      inputSchema: { id: z.string().describe('Message log id (MessageGuid)'), tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const first = await getMessage(api.client, id);
        const name = await stepNamesFor(ctx, api.client, first.iflow);
        const detail = await getMessage(api.client, id, name);
        return toolResult({ ...detail, steps: detail.steps.map(({ runId: _r, childCount: _c, ...s }) => s) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_trace',
    {
      title: 'Step trace (experimental)',
      description:
        'Experimental (setting "experimental.trace"); uses an undocumented SAP endpoint. With "enable": switch the ' +
        'iFlow\'s log level to TRACE for 10 minutes (development tenants only); send messages afterwards. With "message": ' +
        'the body, headers and properties as they entered each step of that message (only for messages processed while ' +
        'TRACE was on). Credential values are hidden.',
      inputSchema: {
        enable: z.string().optional().describe('iFlow Id: switch TRACE on'),
        message: z.string().optional().describe('Message log id: read its step traces'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ enable, message, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        if (!ctx.config.experimental.trace) throw new Error('cpi_trace is experimental: set "experimental": { "trace": true } in the configuration to use it');
        if (!enable === !message) throw new Error('give either "enable" (iFlow Id) or "message" (message log id)');
        const api = tenantApi(ctx.config, tenantName);
        if (enable) {
          const info = await getIflow(api.client, enable);
          await assertMayChange(api.client, api.tenant, info.packageId);
          if (!info.runtime) throw new Error(`${enable} is not deployed`);
          const r = await setLogLevel(api.client, enable, 'TRACE');
          audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_trace', artifact: enable, result: 'log level TRACE' });
          return toolResult({ iflow: enable, ...r, next: 'send messages now (cpi_send_message), then read them with cpi_trace { message }' });
        }
        const name = await stepNamesFor(ctx, api.client, (await getMessage(api.client, message!)).iflow);
        const detail = await getMessage(api.client, message!, name);
        if (detail.logLevel && detail.logLevel !== 'TRACE') throw new Error(`message ${message} was processed at log level ${detail.logLevel}; traces exist only for messages processed at TRACE`);
        const redact = redactor(ctx.config.redact);
        const steps = [];
        for (const s of detail.steps) {
          steps.push({ no: s.no, step: s.stepName ?? s.stepId, status: s.status, traces: await stepTraces(api.client, s.runId, s.childCount, redact, ctx.config.output.maxChars) });
        }
        return toolResult({ message: message!, iflow: detail.iflow, status: detail.status, steps });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
