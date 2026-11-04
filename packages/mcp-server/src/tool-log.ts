// Optional log of every tool call (configuration "toolLog"): what the agent asked for, what it got back and how long
// it took, one JSON line per call. For debugging how agents (and weaker models) use the server; off by default.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { currentConfig } from './project.js';

/** Longest result text kept per call; longer ones are cut and marked */
export const TOOL_LOG_MAX_CHARS = 20000;

let failed = false;

export function writeToolLog(file: string, entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (e) {
    if (!failed) console.error(`cpi-saper-dev-mcp: tool log ${file} not writable: ${(e as Error).message}`);
    failed = true;
  }
}

function resultText(r: CallToolResult | undefined): string {
  const text = (r?.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return text.length > TOOL_LOG_MAX_CHARS ? `${text.slice(0, TOOL_LOG_MAX_CHARS)}… [${text.length - TOOL_LOG_MAX_CHARS} more characters]` : text;
}

/** Wrap every tool registered from now on, so its calls are logged when the project's configuration asks for it */
export function enableToolLog(server: McpServer) {
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, handler: unknown) => {
    const run = handler as (...a: unknown[]) => Promise<CallToolResult>;
    const hasInput = !!(config as { inputSchema?: unknown }).inputSchema;
    return register(name, config, async (...a: unknown[]) => {
      const started = Date.now();
      let file: string | undefined;
      try { file = (await currentConfig(server)).toolLog; } catch { /* no valid configuration: the tool reports that itself */ }
      const base = () => ({ time: new Date(started).toISOString(), tool: name, ...(hasInput ? { args: a[0] } : {}), ms: Date.now() - started });
      try {
        const r = await run(...a);
        if (file) writeToolLog(file, { ...base(), ...(r.isError ? { isError: true } : {}), result: resultText(r) });
        return r;
      } catch (e) {
        if (file) writeToolLog(file, { ...base(), thrown: (e as Error).message ?? String(e) });
        throw e;
      }
    });
  };
}
