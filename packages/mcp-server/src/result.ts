import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * The result as JSON text. Only text: clients such as Copilot pass both text and structuredContent to the model, so
 * returning both doubled every result's tokens (tester report).
 */
export function toolResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Errors are returned to the agent (isError), not thrown: the agent can read and act on the message */
export function toolError(e: unknown): CallToolResult {
  return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
}
