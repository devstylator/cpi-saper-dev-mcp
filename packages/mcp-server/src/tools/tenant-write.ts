import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  checkModel, deployIflow, describe, designLocks, diffIflows, downloadIflow, getIflow, iflowFromZip, localChanges,
  runGuidelines, runtimeError, saveVersion, undeployIflow, unzipEntries, updateResource, uploadIflow, validate,
  zipChanges, zipFolder, type CpiClient, type GuidelineFinding, type TenantConfig,
} from '@cpi-saper-dev-mcp/core';
import { context, localIflow, stepNamesFor, tenantApi, type ToolContext } from '../context.js';
import { toolError, toolResult } from '../result.js';
import { assertMayChange, audit, confirmAction, Declined } from '../safety.js';

const tenantArg = z.string().optional().describe('Tenant name from the configuration; default: defaultTenant');
const iflowIdArg = z.string().describe('iFlow Id');

const nextPatch = (v?: string) => (v && /^\d+\.\d+\.\d+$/.test(v) ? v.replace(/(\d+)$/, (n) => String(Number(n) + 1)) : '');
const translate = (text: string, name: (id: string) => string | undefined) => text.replace(/\b[A-Za-z]+_\d+\b/g, (id) => (name(id) ? `${id} "${name(id)}"` : id));

/** The local copy of an iFlow pulled from this tenant, with its pulled state */
function pulledIflow(ctx: ToolContext, iflow: string, tenant: TenantConfig) {
  const local = localIflow(ctx, iflow);
  const pulled = local.located.dir ? ctx.workspace.pulledStateFor(local.located.dir) : undefined;
  if (!pulled) throw new Error(`${iflow} was not pulled with cpi_pull; pull it first (changes are only pushed onto the state they were made on)`);
  if (pulled.state.tenant !== tenant.name) throw new Error(`${iflow} was pulled from tenant "${pulled.state.tenant}", not "${tenant.name}"`);
  return { ...local, pulled, dir: local.located.dir! };
}

async function assertNotLocked(client: CpiClient, iflowId: string) {
  const lock = (await designLocks(client)).find((l) => l.artifactId === iflowId);
  if (lock) throw new Error(`${iflowId} is open for editing in the designer${lock.lockedBy ? ` by ${lock.lockedBy}` : ''}${lock.since ? ` since ${lock.since}` : ''}; close it there first`);
}

/** Refuses when the tenant's content changed since the pull: those changes (e.g. made in the designer) would be lost */
async function assertTenantUnchanged(client: CpiClient, iflowId: string, pulledZip: Uint8Array, only?: string): Promise<void> {
  let changed = zipChanges(pulledZip, await downloadIflow(client, iflowId));
  if (only) changed = changed.filter((c) => c.startsWith(only));
  if (changed.length) {
    throw new Error(`${iflowId} changed on the tenant since your pull (${changed.slice(0, 8).join(', ')}); those changes would be overwritten. ` +
      'Keep your local work elsewhere, pull again with overwrite, and re-apply it (iflow_diff shows your changes)');
  }
}

const highFinding = (f: GuidelineFinding) => f.compliance === 'Non-Compliant' && f.severity === 'High' && !f.skipped;
const findingKey = (f: GuidelineFinding) => `${f.id} ${f.violated ?? ''}`;

/**
 * SAP's guideline check as a deploy gate. "New" High findings are those the deployed version does not have,
 * so an iFlow's existing debt does not block every deploy.
 */
async function guidelineGate(client: CpiClient, tenant: TenantConfig, iflowId: string, deployedVersion?: string) {
  if (tenant.guidelines === 'off') return { checked: false as const };
  const now = (await runGuidelines(client, iflowId)).findings.filter(highFinding);
  let baseline: GuidelineFinding[] = [];
  if (deployedVersion) {
    try { baseline = (await runGuidelines(client, iflowId, deployedVersion)).findings.filter(highFinding); } catch { /* version not available: all findings count as new */ }
  }
  const known = new Set(baseline.map(findingKey));
  const fresh = now.filter((f) => !known.has(findingKey(f)));
  const lines = fresh.map((f) => `${f.id}: ${f.name}${f.violated ? ` ${f.violated}` : ''}${f.fix ? ` (fix: ${f.fix})` : ''}`);
  if (fresh.length && tenant.guidelines === 'block') {
    throw new Error(`not deployed: SAP's design guideline check reports new High findings (compared with deployed version ${deployedVersion ?? '(none)'}):\n  ${lines.join('\n  ')}\n` +
      'Fix them, or set "guidelines": "warn" for this tenant');
  }
  return { checked: true as const, highFindings: now.length, newHighFindings: lines, comparedWith: deployedVersion ?? null };
}

export function registerTenantWriteTools(server: McpServer) {
  server.registerTool(
    'cpi_push',
    {
      title: 'Push an iFlow',
      description:
        'Upload a locally edited iFlow (pulled before with cpi_pull) to its tenant. Refuses when the tenant is not a ' +
        'development tenant, the package is not allowed or read-only, the local iFlow has structural errors, the iFlow ' +
        'is open in the designer, or its content changed on the tenant since the pull. Asks the user to confirm (with ' +
        'the changes) when "push" is in the configuration\'s confirm list; the user can also save a version there.',
      inputSchema: { iflow: z.string().describe('Local iFlow: Id, folder or .iflw'), tenant: tenantArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ iflow, tenant: tenantName }) => {
      const ctx = await context(server).catch((e) => e as Error);
      if (ctx instanceof Error) return toolError(ctx);
      const api = tenantApi(ctx.config, tenantName);
      let id = iflow;
      try {
        const local = pulledIflow(ctx, iflow, api.tenant);
        id = local.pulled.state.iflowId;
        await assertMayChange(api.client, api.tenant, local.pulled.state.packageId);
        const errors = validate(local.doc, local.located).filter((i) => i.severity === 'error');
        if (errors.length) throw new Error(`not pushed: the local iFlow has errors (iflow_validate):\n${errors.map((i) => `  ${i.code} ${i.msg}`).join('\n')}`);
        const files = localChanges(local.dir, local.pulled.zip);
        if (!files.length) return toolResult({ iflow: id, pushed: false, reason: 'no local changes since the last pull' });
        await assertNotLocked(api.client, id);
        await assertTenantUnchanged(api.client, id, local.pulled.zip);

        const base = iflowFromZip(local.pulled.zip);
        const changes = diffIflows(describe(base, { maxLen: 0 }), describe(local.doc, { maxLen: 0 }), { docA: base, docB: local.doc });
        const answer = await confirmAction(server, ctx.config, 'push',
          `Push ${id} to tenant "${api.tenant.name}"${api.tenant.label ? ` (${api.tenant.label})` : ''}?\n` +
          `Changed files: ${files.join(', ')}\n${changes.slice(0, 30).join('\n')}${changes.length > 30 ? `\n… ${changes.length - 30} more lines` : ''}`,
          { saveVersion: { type: 'string', title: 'Then save as version', description: 'e.g. 1.0.11; leave empty to not save a version', default: nextPatch(local.pulled.state.version) } });

        await uploadIflow(api.client, id, zipFolder(local.dir));
        const version = typeof answer.saveVersion === 'string' && answer.saveVersion.trim() ? answer.saveVersion.trim() : undefined;
        if (version) await saveVersion(api.client, id, version);
        const info = await getIflow(api.client, id);
        ctx.workspace.updatePulledState(api.tenant.name, { iflowId: id, packageId: info.packageId, ...(info.version ? { version: info.version } : {}) },
          await downloadIflow(api.client, id), local.dir);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_push', artifact: id, result: 'pushed', details: { files, savedVersion: version ?? null } });
        return toolResult({
          iflow: id, pushed: true, files, savedVersion: version ?? null, tenantVersion: info.version ?? null,
          next: info.runtime ? 'deployed version is older now: deploy with cpi_deploy' : 'not deployed yet: deploy with cpi_deploy',
        });
      } catch (e) {
        if (!(e instanceof Declined)) audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_push', artifact: id, result: `refused: ${(e as Error).message.split('\n')[0]}` });
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_update_resource',
    {
      title: 'Update one script or mapping file',
      description:
        'Upload one changed file of a pulled iFlow (e.g. script/script1.groovy, mapping/x.xsl) without uploading the ' +
        'whole iFlow. Same rules as cpi_push, checked for this file. New files, and names that exist twice on the tenant ' +
        '(a script and its v2 copy), need cpi_push.',
      inputSchema: {
        iflow: z.string().describe('Local iFlow: Id, folder or .iflw'),
        file: z.string().describe('Path below src/main/resources, e.g. script/script1.groovy'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ iflow, file, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const local = pulledIflow(ctx, iflow, api.tenant);
        const id = local.pulled.state.iflowId;
        const entry = `src/main/resources/${file.replace(/^\/+/, '')}`;
        if (!(entry in unzipEntries(local.pulled.zip))) throw new Error(`${file} is not a file of the pulled iFlow; new files need cpi_push`);
        await assertMayChange(api.client, api.tenant, local.pulled.state.packageId);
        await assertNotLocked(api.client, id);
        await assertTenantUnchanged(api.client, id, local.pulled.zip, entry);
        await confirmAction(server, ctx.config, 'update_resource', `Upload ${file} of ${id} to tenant "${api.tenant.name}"?`);
        const r = await updateResource(api.client, id, basename(file), new Uint8Array(readFileSync(join(local.dir, entry))));
        const info = await getIflow(api.client, id);
        ctx.workspace.updatePulledState(api.tenant.name, { iflowId: id, packageId: info.packageId, ...(info.version ? { version: info.version } : {}) },
          await downloadIflow(api.client, id), local.dir);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_update_resource', artifact: id, result: 'updated', details: { file } });
        return toolResult({ iflow: id, updated: file, resourceType: r.type, tenantVersion: info.version ?? null });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_save_version',
    {
      title: 'Save a version',
      description: 'Save the iFlow\'s current design-time content on the tenant as a new version (like "Save as version" in the designer).',
      inputSchema: { iflow: iflowIdArg, version: z.string().describe('New version, e.g. 1.0.11'), tenant: tenantArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ iflow, version, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const info = await getIflow(api.client, iflow);
        await assertMayChange(api.client, api.tenant, info.packageId);
        await confirmAction(server, ctx.config, 'save_version', `Save ${iflow} on tenant "${api.tenant.name}" as version ${version}?`);
        await saveVersion(api.client, iflow, version);
        const pulled = ctx.workspace.pulledState(api.tenant.name, iflow);
        if (pulled) {
          ctx.workspace.updatePulledState(api.tenant.name, { iflowId: iflow, packageId: info.packageId, version }, await downloadIflow(api.client, iflow), pulled.state.dir);
        }
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_save_version', artifact: iflow, result: `saved ${version}` });
        return toolResult({ iflow, savedVersion: version });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_deploy',
    {
      title: 'Deploy an iFlow',
      description:
        'Deploy the iFlow\'s current design-time content. First runs SAP\'s design guideline check when the tenant\'s ' +
        '"guidelines" setting asks for it (block: new High findings stop the deploy). With deploy mode "manual" ' +
        '(e.g. BTP trial tenants) nothing is deployed: ask the user to deploy in the designer, then check with ' +
        'cpi_runtime_status. Otherwise asks for confirmation (if configured), deploys, waits, and reports errors with step names.',
      inputSchema: { iflow: iflowIdArg, tenant: tenantArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ iflow, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const info = await getIflow(api.client, iflow);
        await assertMayChange(api.client, api.tenant, info.packageId);
        const gate = await guidelineGate(api.client, api.tenant, iflow, info.runtime?.version);
        if (api.tenant.deploy === 'manual') {
          return toolResult({
            iflow, deployed: false, mode: 'manual', guidelines: gate,
            next: `Tenant "${api.tenant.name}" is configured for manual deploys: ask the user to deploy ${iflow} in the designer ` +
              '(version ' + (info.version ?? 'active') + '), and to tell you when it is done; then check it with cpi_runtime_status.',
          });
        }
        await confirmAction(server, ctx.config, 'deploy',
          `Deploy ${iflow} (design-time version ${info.version ?? 'active'}) on tenant "${api.tenant.name}"?` +
          `${info.runtime ? ` Currently deployed: ${info.runtime.version ?? '?'} (${info.runtime.status}).` : ' Not deployed yet.'}` +
          `${gate.checked && gate.newHighFindings.length ? `\nNew High guideline findings:\n${gate.newHighFindings.join('\n')}` : ''}`);
        const r = await deployIflow(api.client, iflow, { timeoutSeconds: ctx.config.timeouts.deploySeconds });
        const name = await stepNamesFor(ctx, api.client, iflow);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_deploy', artifact: iflow, result: r.status });
        const data = { iflow, deployed: r.status === 'STARTED', ...r, ...(r.error ? { error: translate(r.error, name) } : {}), guidelines: gate };
        return { ...toolResult(data), ...(r.status === 'STARTED' ? {} : { isError: true }) };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_undeploy',
    {
      title: 'Undeploy an iFlow',
      description: 'Remove the iFlow from the runtime (its design-time content stays). Asks for confirmation when configured.',
      inputSchema: { iflow: iflowIdArg, tenant: tenantArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ iflow, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const info = await getIflow(api.client, iflow);
        if (!info.runtime) return toolResult({ iflow, undeployed: false, reason: 'not deployed' });
        await assertMayChange(api.client, api.tenant, info.packageId);
        await confirmAction(server, ctx.config, 'undeploy', `Undeploy ${iflow} (deployed version ${info.runtime.version ?? '?'}, ${info.runtime.status}) from tenant "${api.tenant.name}"?`);
        await undeployIflow(api.client, iflow);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_undeploy', artifact: iflow, result: 'undeployed' });
        return toolResult({ iflow, undeployed: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_runtime_status',
    {
      title: 'Runtime status of an iFlow',
      description: 'Whether and which version of the iFlow is deployed, its status, and the deploy error with step names when it failed.',
      inputSchema: { iflow: iflowIdArg, tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ iflow, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const info = await getIflow(api.client, iflow);
        let error: string | undefined;
        if (info.runtime?.status === 'ERROR') {
          const raw = await runtimeError(api.client, iflow);
          if (raw) error = translate(raw, await stepNamesFor(ctx, api.client, iflow));
        }
        return toolResult({ iflow, designTimeVersion: info.version ?? null, runtime: info.runtime, ...(error ? { error } : {}) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_guidelines',
    {
      title: 'SAP design guideline check',
      description:
        'Run SAP\'s design guideline check on the tenant (deploys through the API skip it, unlike the designer). ' +
        'Returns the non-compliant guidelines, most severe first, with the violating components and SAP\'s fix text.',
      inputSchema: {
        iflow: iflowIdArg,
        version: z.string().optional().describe('Saved version; default: the current design-time content'),
        all: z.boolean().default(false).describe('Also list compliant and skipped guidelines'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ iflow, version, all, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const r = await runGuidelines(api.client, iflow, version ?? 'active');
        const nonCompliant = r.findings.filter((f) => f.compliance === 'Non-Compliant');
        return toolResult({
          iflow, version: r.artifactVersion ?? version ?? 'active', status: r.status ?? null,
          nonCompliant: nonCompliant.length, high: nonCompliant.filter((f) => f.severity === 'High').length,
          findings: all ? r.findings : nonCompliant,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_check',
    {
      title: 'Tenant model check',
      description: 'Run the tenant\'s model validation of the iFlow ("Check for problems" in the designer).',
      inputSchema: { iflow: iflowIdArg, version: z.string().optional(), tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ iflow, version, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const r = await checkModel(api.client, iflow, version ?? 'active');
        return toolResult({ iflow, passed: /Passed/i.test(r.text), result: r.text });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}

