// Every tool goes through this wrapper. It writes the optional log of tool calls (configuration "toolLog": what the
// agent asked for, what it got back and how long it took, one JSON line per call; off by default), and it tells an
// agent that repeats a call that keeps failing the same way (seen: a weaker model sent one refused edit 15 times).
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

/** From this many identical failures in a row the error text says so */
export const SAME_ERROR_HINT_FROM = 3;
let lastError: { call: string; text: string; count: number } | undefined;

/** The error text, with a note when the same call failed the same way several times in a row */
export function repeatedError(call: string, text: string): string {
  const same = lastError && lastError.call === call && lastError.text === text;
  lastError = { call, text, count: same ? lastError!.count + 1 : 1 };
  return lastError.count < SAME_ERROR_HINT_FROM ? text
    : `${text}\n\n(This exact call failed this way ${lastError.count} times in a row. Repeating it will not help: change the call as the message says, or ask the user.)`;
}

/** Wrap every tool registered from now on: the tool-call log, and the note on repeated failures */
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
        let r = await run(...a);
        const call = JSON.stringify([name, hasInput ? a[0] : null]);
        if (r.isError) {
          const text = resultText(r);
          const said = repeatedError(call, text);
          if (said !== text) r = { ...r, content: [{ type: 'text', text: said }] };
        } else lastError = undefined;
        if (file) writeToolLog(file, { ...base(), ...(r.isError ? { isError: true } : {}), result: resultText(r) });
        return r;
      } catch (e) {
        if (file) writeToolLog(file, { ...base(), thrown: (e as Error).message ?? String(e) });
        throw e;
      }
    });
  };
}
