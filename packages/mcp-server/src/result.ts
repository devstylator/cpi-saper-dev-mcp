import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Structured result plus the same data as JSON text, for clients that only show text */
export function toolResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/** Errors are returned to the agent (isError), not thrown: the agent can read and act on the message */
export function toolError(e: unknown): CallToolResult {
  return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
}
