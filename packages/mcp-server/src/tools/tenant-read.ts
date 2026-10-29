import { relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getIflow, listIflows, listPackages, downloadIflow, packageAllowed, resolvePackage } from '@cpi-saper-dev-mcp/core';
import { context, tenantApi } from '../context.js';
import { toolError, toolResult } from '../result.js';

const tenantArg = z.string().optional().describe('Tenant name from the configuration; default: defaultTenant');

export function registerTenantReadTools(server: McpServer) {
  server.registerTool(
    'cpi_packages',
    {
      title: 'List packages',
      description:
        'List the integration packages on a tenant. agentMayChange says whether the agent may change content in the ' +
        'package (development tenant, package allowed by the configuration, and not READ_ONLY content from SAP or partners).',
      inputSchema: { tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const packages = (await listPackages(api.client)).map((p) => ({
          ...p,
          agentMayChange: p.mode !== 'READ_ONLY' && packageAllowed(api.tenant, { id: p.id, name: p.name }),
        }));
        return toolResult({ tenant: api.tenant.name, packages });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_artifacts',
    {
      title: 'List iFlows of a package',
      description:
        'List the integration flows of a package with their design-time version ("Active" = changed since the last ' +
        'saved version) and runtime status (null = not deployed). The package can be given by Id or display name.',
      inputSchema: { package: z.string().describe('Package Id or display name'), tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ package: pkg, tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const p = await resolvePackage(api.client, pkg);
        return toolResult({ tenant: api.tenant.name, package: { id: p.id, name: p.name }, iflows: await listIflows(api.client, p.id) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_pull',
    {
      title: 'Pull an iFlow',
      description:
        'Download an iFlow from the tenant into the workspace as <workspace>/<packageId>/<iflowId>/ (SAP file layout). ' +
        'Refuses to overwrite local changes made since the previous pull unless overwrite is true. Read the result ' +
        'with iflow_describe; compare later local edits with iflow_diff.',
      inputSchema: {
        iflow: z.string().describe('iFlow Id'),
        tenant: tenantArg,
        overwrite: z.boolean().default(false).describe('Discard local changes made since the previous pull'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ iflow, tenant, overwrite }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const info = await getIflow(api.client, iflow);
        const zip = await downloadIflow(api.client, iflow);
        const r = ctx.workspace.pull(api.tenant.name, { iflowId: info.id, packageId: info.packageId, ...(info.version ? { version: info.version } : {}) }, zip, { overwrite });
        return toolResult({
          tenant: api.tenant.name,
          iflow: info.id,
          package: info.packageId,
          version: info.version ?? null,
          runtime: info.runtime,
          folder: r.dir,
          folderInWorkspace: relative(ctx.workspace.root, r.dir),
          files: r.files,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
