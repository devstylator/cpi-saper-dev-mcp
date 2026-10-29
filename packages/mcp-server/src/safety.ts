// Rules every tool that changes a tenant goes through: role and package checks, the user's confirmation, the audit log.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { packageAllowed, resolvePackage, type Config, type ConfirmableAction, type CpiClient, type TenantConfig } from '@cpi-saper-dev-mcp/core';

/** Development tenant, package allowed by the configuration, and not READ_ONLY content from SAP or partners */
export async function assertMayChange(client: CpiClient, tenant: TenantConfig, packageId: string): Promise<void> {
  if (tenant.role !== 'development') throw new Error(`tenant "${tenant.name}" is ${tenant.role}: the agent may not change it`);
  const pkg = await resolvePackage(client, packageId);
  if (pkg.mode === 'READ_ONLY') throw new Error(`package ${pkg.id} is read-only content (${pkg.vendor || 'SAP or a partner'}); copy it first`);
  if (!packageAllowed(tenant, { id: pkg.id, name: pkg.name })) {
    throw new Error(`package ${pkg.id} ("${pkg.name}") is not in allowedPackages of tenant "${tenant.name}" (${tenant.allowedPackages?.join(', ')})`);
  }
}

type Field =
  | { type: 'string'; title: string; description?: string; default?: string }
  | { type: 'boolean'; title: string; description?: string; default?: boolean };

export class Declined extends Error {}

/**
 * Ask the user to confirm an action through MCP elicitation when the configuration lists it in "confirm".
 * The question goes to the user, not to the agent. Clients that cannot ask (no elicitation capability) are refused
 * with an explanation, so a configured confirmation can never be skipped silently.
 * Returns the form values the user entered (empty when no confirmation is configured).
 */
export async function confirmAction(server: McpServer, config: Config, action: ConfirmableAction, message: string,
  fields: Record<string, Field> = {}): Promise<Record<string, unknown>> {
  if (!config.confirm.includes(action)) return {};
  if (!server.server.getClientCapabilities()?.elicitation) {
    throw new Error(`"${action}" needs your confirmation (setting "confirm" in ${config.path}), but this client cannot ask ` +
      '(no MCP elicitation support). Use a client that supports it (for example Claude Code 2.1.76 or later, or VS Code), ' +
      `or remove "${action}" from "confirm" if you accept changes without a question.`);
  }
  const r = await server.server.elicitInput({
    mode: 'form',
    message,
    requestedSchema: { type: 'object', properties: fields, required: [] },
  });
  if (r.action === 'accept') return r.content ?? {};
  throw new Declined(r.action === 'decline' ? `the user declined: ${action} was not done` : `the user closed the question without deciding: ${action} was not done`);
}

/** One JSON line per tenant change: time, tenant, tool, artifact, outcome */
export function audit(config: Config, entry: { tenant: string; tool: string; artifact: string; result: string; details?: Record<string, unknown> }) {
  try {
    mkdirSync(dirname(config.auditLog), { recursive: true });
    appendFileSync(config.auditLog, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  } catch (e) {
    console.error(`cpi-saper-dev-mcp: audit log ${config.auditLog} not writable: ${(e as Error).message}`);
  }
}
