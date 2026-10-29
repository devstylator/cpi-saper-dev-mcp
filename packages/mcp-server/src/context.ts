import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CpiClient, describe, downloadIflow, iflowFromZip, loadCatalog, loadServiceKey, locateIflow, readIflow, selectTenant, TokenStore,
  userTokenProvider, Workspace,
  type Catalog, type Config, type Step, type TenantConfig,
} from '@cpi-saper-dev-mcp/core';
import { currentConfig } from './project.js';

// One client per key file (re-created when the file changes), so OAuth tokens are reused across tool calls
const clients = new Map<string, { mtime: number; client: CpiClient }>();

function clientFor(keyPath: string): CpiClient {
  const mtime = statSync(keyPath).mtimeMs;
  const cached = clients.get(keyPath);
  if (cached && cached.mtime === mtime) return cached.client;
  const client = new CpiClient(loadServiceKey(keyPath));
  clients.set(keyPath, { mtime, client });
  return client;
}

export interface ToolContext {
  config: Config;
  workspace: Workspace;
}

export async function context(server: McpServer): Promise<ToolContext> {
  const config = await currentConfig(server);
  return { config, workspace: new Workspace(config.workspace, join(dirname(config.path), 'state')) };
}

/** Where a tenant's user login is kept: tokens/ next to the configuration (not in state/, which holds pulled iFlows) */
export const tokenStoreOf = (config: Config, tenant: TenantConfig) =>
  new TokenStore(join(dirname(config.path), 'tokens', `${tenant.name}.json`));

const userClients = new Map<string, CpiClient>();

/** OData API client: the user's login for tenants with login "user", else the service key's technical client */
export function tenantApi(config: Config, name?: string): { tenant: TenantConfig; client: CpiClient } {
  const tenant = selectTenant(config, name);
  if (tenant.login !== 'user') return { tenant, client: clientFor(tenant.apiKey) };
  const cacheKey = `${config.path}#${tenant.name}`;
  let client = userClients.get(cacheKey);
  if (!client) {
    const key = loadServiceKey(tenant.apiKey);
    client = new CpiClient(key, fetch, userTokenProvider(key, tokenStoreOf(config, tenant), tenant.name));
    userClients.set(cacheKey, client);
  }
  return { tenant, client };
}

/** Client for the tenant's deployed endpoints (service key with plan integration-flow) */
export function tenantRuntime(config: Config, name?: string): { tenant: TenantConfig; client: CpiClient } {
  const tenant = selectTenant(config, name);
  if (!tenant.runtimeKey) throw new Error(`tenant "${tenant.name}" has no "runtimeKey" (service key with plan integration-flow)`);
  return { tenant, client: clientFor(tenant.runtimeKey) };
}

export function catalogOf(config: Config): Catalog {
  return config.catalog ? loadCatalog(config.catalog) : loadCatalog();
}

/**
 * Step id -> "name (#n)" for an iFlow, to translate ids in deploy errors and message logs. Uses the local copy
 * when the iFlow was pulled, else the tenant's current design-time content.
 */
export async function stepNamesFor(ctx: ToolContext, client: CpiClient, iflowId: string): Promise<(id: string) => string | undefined> {
  let doc;
  try {
    doc = readIflow(locateIflow(iflowId, ctx.workspace.root));
  } catch {
    try { doc = iflowFromZip(await downloadIflow(client, iflowId)); } catch { return () => undefined; }
  }
  const names = new Map<string, string>();
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      names.set(s.id, `${s.name || s.kind || s.id}${s.no ? ` (#${s.no})` : ''}`);
      if (s.steps) walk(s.steps);
    }
  };
  const model = describe(doc);
  for (const p of model.processes) walk(p.steps);
  for (const a of model.adapters) names.set(a.id, `${a.name ?? a.adapter ?? a.id} adapter`);
  return (id) => names.get(id);
}

/** An iFlow in the workspace: folder, .iflw file, or iFlow id */
export function localIflow(ctx: ToolContext, target: string) {
  const located = locateIflow(target, ctx.workspace.root);
  return { located, doc: readIflow(located) };
}
