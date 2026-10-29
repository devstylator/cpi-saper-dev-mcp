import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CpiClient, loadCatalog, loadServiceKey, locateIflow, readIflow, selectTenant, Workspace,
  type Catalog, type Config, type TenantConfig,
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

export function tenantApi(config: Config, name?: string): { tenant: TenantConfig; client: CpiClient } {
  const tenant = selectTenant(config, name);
  return { tenant, client: clientFor(tenant.apiKey) };
}

export function catalogOf(config: Config): Catalog {
  return config.catalog ? loadCatalog(config.catalog) : loadCatalog();
}

/** An iFlow in the workspace: folder, .iflw file, or iFlow id */
export function localIflow(ctx: ToolContext, target: string) {
  const located = locateIflow(target, ctx.workspace.root);
  return { located, doc: readIflow(located) };
}
