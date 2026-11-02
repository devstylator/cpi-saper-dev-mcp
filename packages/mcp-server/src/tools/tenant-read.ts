import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getIflow, getScriptCollection, listIflows, listScriptCollections, listPackages, downloadIflow, downloadScriptCollection, listEndpoints,
  listSecurityMaterial, localChanges, packageAllowed, resolvePackage, zipChanges, zipVersion, type PulledState,
} from '@cpi-saper-dev-mcp/core';
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
      title: 'List iFlows and script collections of a package',
      description:
        'List the integration flows and script collections of a package with their design-time version ("Active" = ' +
        'changed since the last saved version) and runtime status (null = not deployed). The package can be given by Id or display name.',
      inputSchema: { package: z.string().describe('Package Id or display name'), tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ package: pkg, tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const p = await resolvePackage(api.client, pkg);
        const [iflows, scriptCollections] = await Promise.all([listIflows(api.client, p.id), listScriptCollections(api.client, p.id)]);
        return toolResult({ tenant: api.tenant.name, package: { id: p.id, name: p.name }, iflows, scriptCollections });
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

  server.registerTool(
    'cpi_status',
    {
      title: 'Local and tenant status',
      description:
        'For every iFlow and script collection pulled from the tenant (or one, or those of a package): whether it ' +
        'changed locally since the pull, changed on the tenant since the pull (e.g. in the designer, or a configured ' +
        'value), both (conflict: a push is refused), or neither; with the pulled, tenant and deployed versions. With ' +
        'package, also lists the package\'s artifacts that are not pulled. Downloads each artifact from the tenant.',
      inputSchema: {
        iflow: z.string().optional().describe('Only this iFlow or script collection Id'),
        package: z.string().optional().describe('Only this package (Id or display name), including what is not pulled'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ iflow, package: pkgArg, tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const pkg = pkgArg ? await resolvePackage(api.client, pkgArg) : undefined;
        let pulled: PulledState[] = ctx.workspace.allPulled(api.tenant.name);
        if (iflow) pulled = pulled.filter((p) => p.iflowId === iflow);
        if (pkg) pulled = pulled.filter((p) => p.packageId === pkg.id);
        const isCollection = (dir: string) => !existsSync(join(dir, 'src', 'main', 'resources', 'scenarioflows'));
        const rows = [];
        for (const p of pulled) {
          const kind = existsSync(p.dir) && isCollection(p.dir) ? 'script collection' : 'iFlow';
          const info = await (kind === 'iFlow' ? getIflow(api.client, p.iflowId) : getScriptCollection(api.client, p.iflowId)).catch(() => undefined);
          const base = { id: p.iflowId, kind, package: p.packageId, folder: relative(ctx.workspace.root, p.dir), pulledVersion: p.version ?? null };
          if (!existsSync(p.dir)) { rows.push({ ...base, state: 'local folder missing', tenantVersion: info?.version ?? null }); continue; }
          if (!info) { rows.push({ ...base, state: 'deleted on the tenant' }); continue; }
          const state = ctx.workspace.pulledState(api.tenant.name, p.iflowId)!;
          // the push writes the version into the manifest and the tenant rewrites it: not a change of its own
          const local = localChanges(p.dir, state.zip).filter((f) => f !== 'META-INF/MANIFEST.MF');
          const current = kind === 'iFlow' ? await downloadIflow(api.client, p.iflowId) : await downloadScriptCollection(api.client, p.iflowId);
          const remote = zipChanges(state.zip, current);
          rows.push({
            ...base,
            state: local.length && remote.length ? 'conflict' : local.length ? 'modified locally' : remote.length ? 'changed on the tenant' : 'in sync',
            ...(local.length ? { localChanges: local } : {}), ...(remote.length ? { tenantChanges: remote } : {}),
            tenantVersion: info.version ?? zipVersion(current) ?? null, deployed: info.runtime ? `${info.runtime.version ?? '?'} (${info.runtime.status})` : null,
          });
        }
        const notPulled = pkg ? [
          ...(await listIflows(api.client, pkg.id)).map((x) => ({ id: x.id, kind: 'iFlow', version: x.version ?? null })),
          ...(await listScriptCollections(api.client, pkg.id)).map((x) => ({ id: x.id, kind: 'script collection', version: x.version ?? null })),
        ].filter((x) => !pulled.some((p) => p.iflowId === x.id)) : [];
        const hint = rows.some((r) => r.state === 'conflict') ? 'conflict: the push is refused; pull with overwrite (after saving your local changes elsewhere) and apply them again'
          : rows.some((r) => r.state === 'changed on the tenant') ? 'changed on the tenant: pull again before editing' : undefined;
        return toolResult({ tenant: api.tenant.name, artifacts: rows, ...(pkg ? { notPulled } : {}), ...(hint ? { hint } : {}) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_endpoints',
    {
      title: 'Endpoints of deployed iFlows',
      description: 'The URLs of the HTTP endpoints of deployed iFlows (call them with cpi_send_message using the iFlow and the path).',
      inputSchema: { iflow: z.string().optional().describe('Only this iFlow'), tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ iflow, tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const all = await listEndpoints(api.client);
        const endpoints = iflow ? all.filter((e) => e.iflow === iflow) : all;
        return toolResult({ tenant: api.tenant.name, endpoints, ...(iflow && !endpoints.length ? { note: `${iflow} has no deployed HTTP endpoint` } : {}) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_security_material',
    {
      title: 'Security material',
      description:
        'Names, types, validity and deploy status of the tenant\'s keystore entries, user credentials, OAuth2 client ' +
        'credentials and secure parameters, to reference them in adapter settings. Never returns passwords, secrets, ' +
        'user names, secure parameter values or certificate content. expiringWithinDays lists only keystore entries ' +
        'that expire within that many days (and the other kinds unchanged).',
      inputSchema: {
        kind: z.enum(['keystore', 'userCredentials', 'oauth2Clients', 'secureParameters']).optional().describe('Only this kind'),
        expiringWithinDays: z.number().int().positive().optional(),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ kind, expiringWithinDays, tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const m = await listSecurityMaterial(api.client);
        if (expiringWithinDays !== undefined) m.keystore = m.keystore.filter((k) => k.daysLeft !== undefined && k.daysLeft <= expiringWithinDays);
        return toolResult({ tenant: api.tenant.name, ...(kind ? { [kind]: m[kind] } : m) });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
