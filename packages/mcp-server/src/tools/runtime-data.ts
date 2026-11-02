// Runtime data: data stores and variables. Reading on every configured tenant; changes only on development tenants,
// for data of an iFlow in an allowed package (global data: development tenants), confirmed as "runtime_data".
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  deleteDataStore, deleteDataStoreEntry, deleteVariable, findDataStore, findVariable, getDataStoreEntry, getIflow, getVariableValue,
  listDataStoreEntries, listDataStores, listVariables, redactor, type CpiClient, type TenantConfig,
} from '@cpi-saper-dev-mcp/core';
import { context, tenantApi } from '../context.js';
import { toolError, toolResult } from '../result.js';
import { assertMayChange, audit, confirmAction, Declined } from '../safety.js';

const tenantArg = z.string().optional().describe('Tenant name from the configuration; default: defaultTenant');
const iflowArg = z.string().optional().describe('The iFlow the store or variable belongs to; "" for a global one; needed only when the name is ambiguous');

/** Data of an iFlow follows that iFlow's package rules; global data only needs a development tenant */
async function assertMayChangeData(client: CpiClient, tenant: TenantConfig, iflow: string): Promise<void> {
  if (tenant.role !== 'development') throw new Error(`tenant "${tenant.name}" is ${tenant.role}: the agent may not change it`);
  if (!iflow) return;
  const info = await getIflow(client, iflow).catch(() => undefined);
  // data of an iFlow that no longer exists on the tenant: nothing to protect in a package
  if (info) await assertMayChange(client, tenant, info.packageId);
}

export function registerRuntimeDataTools(server: McpServer) {
  server.registerTool(
    'cpi_datastores',
    {
      title: 'Data stores',
      description:
        'Data stores the iFlows wrote (Write step): without store, all stores with their iFlow (or global), number of ' +
        'entries and overdue entries; with store, its entries (id, status, message log id, due, created, retain until). ' +
        'A store appears once something was written to it.',
      inputSchema: { store: z.string().optional().describe('Data store name'), iflow: iflowArg, tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ store, iflow, tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        if (!store) {
          const all = await listDataStores(api.client);
          return toolResult({ tenant: api.tenant.name, dataStores: iflow === undefined ? all : all.filter((s) => s.iflow === iflow) });
        }
        const s = await findDataStore(api.client, store, iflow);
        return toolResult({ tenant: api.tenant.name, dataStore: s, entries: await listDataStoreEntries(api.client, s) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_datastore_entry',
    {
      title: 'Data store entry',
      description:
        'The message a data store entry holds: body (cut to output.maxChars; binary bodies are only measured) and the ' +
        'stored headers, credential-like values hidden.',
      inputSchema: { store: z.string(), id: z.string().describe('Entry id'), iflow: iflowArg, tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ store, id, iflow, tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const s = await findDataStore(api.client, store, iflow);
        const entry = await getDataStoreEntry(api.client, s, id, { redact: redactor(ctx.config.redact), maxChars: ctx.config.output.maxChars });
        return toolResult({ tenant: api.tenant.name, dataStore: s.name, iflow: s.iflow || null, id, ...entry });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_datastore_delete',
    {
      title: 'Delete data store entries',
      description:
        'Delete entries of a data store, or the whole store (all: true), for example to reset test data between runs. ' +
        'Development tenants only; a store of an iFlow follows its package rules. Asks for confirmation ("runtime_data").',
      inputSchema: {
        store: z.string(),
        ids: z.array(z.string()).optional().describe('Entry ids to delete'),
        all: z.boolean().default(false).describe('Delete the whole store with all entries'),
        iflow: iflowArg,
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ store, ids, all, iflow, tenant: tenantName }) => {
      const ctx = await context(server).catch((e) => e as Error);
      if (ctx instanceof Error) return toolError(ctx);
      const api = tenantApi(ctx.config, tenantName);
      try {
        if (!all === !ids?.length) throw new Error('give either ids (entries to delete) or all: true (the whole store)');
        const s = await findDataStore(api.client, store, iflow);
        await assertMayChangeData(api.client, api.tenant, s.iflow);
        const known = new Set((await listDataStoreEntries(api.client, s)).map((e) => e.id));
        const missing = (ids ?? []).filter((i) => !known.has(i));
        if (missing.length) throw new Error(`data store ${s.name} has no entries ${missing.join(', ')}`);
        const where = `data store ${s.name} (${s.iflow ? `iFlow ${s.iflow}` : 'global'}) on tenant "${api.tenant.name}"`;
        await confirmAction(server, ctx.config, 'runtime_data', all ? `Delete ${where} with all ${s.entries} entries?` : `Delete ${ids!.length} entr${ids!.length === 1 ? 'y' : 'ies'} of ${where}: ${ids!.join(', ')}?`);
        if (all) await deleteDataStore(api.client, s); else for (const i of ids!) await deleteDataStoreEntry(api.client, s, i);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_datastore_delete', artifact: `${s.iflow || 'global'}/${s.name}`, result: all ? 'store deleted' : `deleted ${ids!.join(', ')}` });
        return toolResult({ dataStore: s.name, iflow: s.iflow || null, deleted: all ? 'the store with all entries' : ids });
      } catch (e) {
        if (!(e instanceof Declined)) audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_datastore_delete', artifact: store, result: `refused: ${(e as Error).message.split('\n')[0]}` });
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_variables',
    {
      title: 'Variables',
      description:
        'Variables the iFlows wrote (Write Variables step): without name, all with their iFlow (or global), updated and ' +
        'retain-until dates; with name, also the value.',
      inputSchema: { name: z.string().optional().describe('Variable name'), iflow: iflowArg, tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, iflow, tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        if (!name) {
          const all = await listVariables(api.client);
          return toolResult({ tenant: api.tenant.name, variables: iflow === undefined ? all : all.filter((v) => v.iflow === iflow) });
        }
        const v = await findVariable(api.client, name, iflow);
        const value = await getVariableValue(api.client, v);
        return toolResult({ tenant: api.tenant.name, variable: { ...v, value: redactor(ctx.config.redact)(v.name, value) } });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_variable_delete',
    {
      title: 'Delete a variable',
      description:
        'Delete a variable, for example so a delta load starts again from its default. Development tenants only; a ' +
        'variable of an iFlow follows its package rules. Asks for confirmation ("runtime_data").',
      inputSchema: { name: z.string(), iflow: iflowArg, tenant: tenantArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, iflow, tenant: tenantName }) => {
      const ctx = await context(server).catch((e) => e as Error);
      if (ctx instanceof Error) return toolError(ctx);
      const api = tenantApi(ctx.config, tenantName);
      try {
        const v = await findVariable(api.client, name, iflow);
        await assertMayChangeData(api.client, api.tenant, v.iflow);
        await confirmAction(server, ctx.config, 'runtime_data', `Delete variable ${v.name} (${v.iflow ? `iFlow ${v.iflow}` : 'global'}) on tenant "${api.tenant.name}"?`);
        await deleteVariable(api.client, v);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_variable_delete', artifact: `${v.iflow || 'global'}/${v.name}`, result: 'deleted' });
        return toolResult({ variable: v.name, iflow: v.iflow || null, deleted: true });
      } catch (e) {
        if (!(e instanceof Declined)) audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_variable_delete', artifact: name, result: `refused: ${(e as Error).message.split('\n')[0]}` });
        return toolError(e);
      }
    },
  );
}
