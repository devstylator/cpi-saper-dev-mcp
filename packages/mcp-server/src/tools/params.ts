// Externalized parameters: declared locally (params_set), configured on the tenant (cpi_config_get/set).
// Configuring writes the tenant's design-time parameters.prop without a version (measured), so cpi_config_set
// brings the local copy along; otherwise the next push would find the iFlow changed on the tenant.
import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  byTag, checkSchedule, downloadIflow, scheduleConfigValue, scheduleTable, type Schedule, getConfigurations, getIflow, localChanges, NS, readParams, setConfiguration, setParams, unzipEntries, zipChanges,
  type Document, type Element,
} from '@cpi-saper-dev-mcp/core';
import { context, localIflow, tenantApi } from '../context.js';
import { toolError, toolResult } from '../result.js';
import { assertMayChange, audit, confirmAction, Declined } from '../safety.js';

const tenantArg = z.string().optional().describe('Tenant name from the configuration; default: defaultTenant');
const PROP = 'src/main/resources/parameters.prop';

/** Where each {{name}} is used: "<element id> <setting>" */
function uses(doc: Document): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of byTag(doc, 'property', NS.ifl)) {
    const key = p.getElementsByTagName('key')[0]?.textContent ?? '';
    const value = p.getElementsByTagName('value')[0]?.textContent ?? '';
    let el = p.parentNode as Element | null;
    while (el && !el.getAttribute?.('id')) el = el.parentNode as Element | null;
    for (const [, name] of value.matchAll(/\{\{([^{}]+)\}\}/g)) out.set(name!, [...(out.get(name!) ?? []), `${el?.getAttribute('id') ?? 'integrationFlow'} ${key}`]);
  }
  return out;
}

const checkValue = (key: string, type: string, value: string) => {
  if ((type === 'xsd:integer' || type === 'xsd:long') && !/^-?\d+$/.test(value)) throw new Error(`${key}: "${value}" is not a whole number (${type})`);
  if (type === 'xsd:boolean' && !/^(true|false)$/.test(value)) throw new Error(`${key}: "${value}" is not true or false`);
};

export function registerParamTools(server: McpServer) {
  server.registerTool(
    'params_set',
    {
      title: 'Declare externalized parameters',
      description:
        'Declare, change or remove externalized parameters of a local iFlow: parameters.propdef (name, type, required, ' +
        'description) and parameters.prop (the value) stay consistent, in the designer\'s format; created when missing. ' +
        'Use a parameter in a setting by writing {{name}} as its value (iflow_edit set). Returns the parameters with ' +
        'their values and where each is used. The values go to the tenant with cpi_push; to change a value on the tenant ' +
        'without a new version, use cpi_config_set.',
      inputSchema: {
        iflow: z.string().describe('Local iFlow: Id, folder or .iflw'),
        set: z.array(z.object({
          name: z.string(),
          value: z.string().optional(),
          type: z.enum(['xsd:string', 'xsd:integer', 'xsd:long', 'xsd:boolean', 'xsd:date', 'xsd:time', 'xsd:dateTime', 'custom:schedule']).optional().describe('Default xsd:string (kept when changing)'),
          required: z.boolean().optional(),
          description: z.string().optional(),
          schedule: z.union([z.literal('once'), z.object({
            every: z.number().int().positive().optional(), unit: z.enum(['minutes', 'hours']).optional(), cron: z.string().optional(),
            from: z.string().optional(), until: z.string().optional(), timeZone: z.string().optional(),
          })]).optional().describe('For a timer schedule parameter (type custom:schedule) instead of value: "once", {every, unit} or {cron}, with from, until, timeZone'),
        })).default([]),
        remove: z.array(z.string()).default([]).describe('Parameter names to remove (declaration, value and the designer\'s references)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ iflow, set, remove }) => {
      try {
        const ctx = await context(server);
        const { located, doc } = localIflow(ctx, iflow);
        if (!located.dir) throw new Error(`${iflow}: parameters belong to an iFlow folder (src/main/resources), not a loose .iflw`);
        // a schedule object becomes the designer's table
        const input = set.map(({ schedule, ...p }) => (schedule !== undefined ? { ...p, type: 'custom:schedule', value: scheduleTable(checkSchedule(schedule)) } : p));
        const log = (input.length || remove.length ? setParams(located.dir, input, remove) : []).map((l) => l.replace(/ = <row>.*$/, ' = (schedule table)'));
        const used = uses(doc);
        const params = readParams(located.dir).map((p) => ({ ...p, usedBy: used.get(p.name) ?? [] }));
        const declared = new Set(params.map((p) => p.name));
        return toolResult({
          file: relative(ctx.workspace.root, join(located.dir, PROP)),
          changes: log,
          parameters: params,
          ...([...used.keys()].some((n) => !declared.has(n)) ? { undeclared: [...used.keys()].filter((n) => !declared.has(n)).map((n) => `{{${n}}} used by ${used.get(n)!.join(', ')}`) } : {}),
          ...(params.some((p) => !p.usedBy.length) ? { notInTheIflow: params.filter((p) => !p.usedBy.length).map((p) => `${p.name} (not used as {{${p.name}}}; a message mapping may still use it)`) } : {}),
          ...(params.some((p) => p.required && p.value === undefined) ? { missingValues: params.filter((p) => p.required && p.value === undefined).map((p) => p.name) } : {}),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_config_get',
    {
      title: 'Configured parameter values',
      description:
        'The values an iFlow\'s externalized parameters are configured with on the tenant (SAP\'s own keys like ' +
        'SAP_ProfileId marked), compared with the local parameters.prop when the iFlow is pulled.',
      inputSchema: { iflow: z.string().describe('iFlow Id'), tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ iflow, tenant }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const values = await getConfigurations(api.client, iflow);
        const pulled = ctx.workspace.pulledState(api.tenant.name, iflow);
        const local = pulled && existsSync(pulled.state.dir) ? new Map(readParams(pulled.state.dir).map((p) => [p.name, p.value])) : undefined;
        return toolResult({
          tenant: api.tenant.name, iflow,
          values: values.map((v) => ({
            ...v, ...(v.key.startsWith('SAP_') ? { sap: true } : {}),
            ...(local && !v.key.startsWith('SAP_') && local.get(v.key) !== v.value ? { local: local.get(v.key) ?? null } : {}),
          })),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_config_set',
    {
      title: 'Configure parameter values on the tenant',
      description:
        'Set configured values of an iFlow\'s externalized parameters on a development tenant (allowed packages only), ' +
        'like "Configure" in the designer: no new version; the running iFlow uses them after the next deploy. Asks for ' +
        'confirmation when "config_set" is in "confirm". When the iFlow is pulled, its local parameters.prop is updated ' +
        'too (unless it has local changes, which a later cpi_push would upload over these values).',
      inputSchema: {
        iflow: z.string().describe('iFlow Id'),
        values: z.record(z.string(), z.string()).default({}).describe('Parameter name -> value'),
        schedules: z.record(z.string(), z.object({
          every: z.number().int().positive().optional(), unit: z.enum(['minutes', 'hours']).optional(), cron: z.string().optional(),
          from: z.string().optional(), until: z.string().optional(), timeZone: z.string().optional(),
        })).default({}).describe('Schedule parameter name (type custom:schedule) -> {every, unit} or {cron}, with from, until, timeZone'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ iflow, values: plain, schedules, tenant: tenantName }) => {
      const ctx = await context(server).catch((e) => e as Error);
      if (ctx instanceof Error) return toolError(ctx);
      const api = tenantApi(ctx.config, tenantName);
      try {
        const info = await getIflow(api.client, iflow);
        await assertMayChange(api.client, api.tenant, info.packageId);
        const current = new Map((await getConfigurations(api.client, iflow)).map((v) => [v.key, v]));
        // schedules go in the API's own short form (recorded), checked first
        const values: Record<string, string> = { ...plain };
        for (const [k, sch] of Object.entries(schedules)) {
          if (current.get(k) && current.get(k)!.type !== 'custom:schedule') throw new Error(`${k} is not a schedule parameter (${current.get(k)!.type})`);
          values[k] = scheduleConfigValue(checkSchedule(sch) as Exclude<Schedule, 'once'>);
        }
        for (const k of Object.keys(plain)) if (current.get(k)?.type === 'custom:schedule') throw new Error(`${k} is a schedule: pass it in "schedules" as {every, unit} or {cron}`);
        const keys = Object.keys(values);
        if (!keys.length) throw new Error('nothing to set: pass values');
        for (const k of keys) {
          const c = current.get(k);
          if (!c) throw new Error(`${iflow} has no parameter "${k}"; parameters: ${[...current.keys()].filter((x) => !x.startsWith('SAP_')).join(', ') || 'none'}`);
          if (k.startsWith('SAP_')) throw new Error(`${k} is set by SAP, not configured`);
          if (c.type !== 'custom:schedule') checkValue(k, c.type, values[k]!);
        }
        await confirmAction(server, ctx.config, 'config_set', `Configure ${iflow} on tenant "${api.tenant.name}"?\n` +
          keys.map((k) => `${k}: ${current.get(k)!.value} -> ${values[k]}`).join('\n'));
        // whether the local copy can follow: the tenant content must be what was pulled (only the values change)
        const pulled = ctx.workspace.pulledState(api.tenant.name, iflow);
        const inStep = pulled ? zipChanges(pulled.zip, await downloadIflow(api.client, iflow)).length === 0 : false;
        for (const k of keys) await setConfiguration(api.client, iflow, k, values[k]!, current.get(k)!.type);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_config_set', artifact: iflow, result: `configured ${keys.join(', ')}`, details: values });
        let local: string | undefined;
        if (pulled && inStep && existsSync(pulled.state.dir)) {
          const after = await downloadIflow(api.client, iflow);
          const ownEdit = localChanges(pulled.state.dir, pulled.zip).includes(PROP);
          if (!ownEdit) writeFileSync(join(pulled.state.dir, PROP), unzipEntries(after)[PROP] ?? new Uint8Array());
          ctx.workspace.updatePulledState(api.tenant.name, { iflowId: iflow, packageId: info.packageId, ...(info.version ? { version: info.version } : {}) }, after, pulled.state.dir);
          local = ownEdit
            ? 'your local parameters.prop has its own changes and was kept: a cpi_push uploads it and replaces these configured values'
            : 'local parameters.prop updated';
        } else if (pulled) local = 'the iFlow changed on the tenant since your pull: pull it again to get these values locally';
        return toolResult({
          iflow, configured: Object.fromEntries(keys.map((k) => [k, { from: current.get(k)!.value, to: values[k] }])),
          ...(local ? { local } : {}),
          next: info.runtime ? 'deploy it again (cpi_deploy) so the running iFlow uses the new values' : 'the values apply when the iFlow is deployed',
        });
      } catch (e) {
        if (!(e instanceof Declined)) audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_config_set', artifact: iflow, result: `refused: ${(e as Error).message.split('\n')[0]}` });
        return toolError(e);
      }
    },
  );
}
