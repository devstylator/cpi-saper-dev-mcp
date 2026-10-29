import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  checkModel, deployIflow, describe, designLocks, diffIflows, downloadIflow, getIflow, iflowFromZip, localChanges,
  runGuidelines, runtimeError, saveVersion, undeployIflow, unzipEntries, updateResource, uploadIflow, validate,
  withTenantVersion, zipChanges, zipFolder, type CpiClient, type GuidelineFinding, type TenantConfig,
} from '@cpi-saper-dev-mcp/core';
import { context, localIflow, stepNamesFor, tenantApi, type ToolContext } from '../context.js';
import { toolError, toolResult } from '../result.js';
import { assertMayChange, audit, confirmAction, Declined } from '../safety.js';
import { saveVersionAsked, rulesOf, versionProposal } from '../versioning.js';

const tenantArg = z.string().optional().describe('Tenant name from the configuration; default: defaultTenant');
const iflowIdArg = z.string().describe('iFlow Id');

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
async function assertTenantUnchanged(client: CpiClient, iflowId: string, pulledZip: Uint8Array, only?: string): Promise<Uint8Array> {
  const current = await downloadIflow(client, iflowId);
  let changed = zipChanges(pulledZip, current);
  if (only) changed = changed.filter((c) => c.startsWith(only));
  if (changed.length) {
    throw new Error(`${iflowId} changed on the tenant since your pull (${changed.slice(0, 8).join(', ')}); those changes would be overwritten. ` +
      'Keep your local work elsewhere, pull again with overwrite, and re-apply it (iflow_diff shows your changes)');
  }
  return current;
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
        'Upload a locally edited iFlow (pulled before with cpi_pull) to its tenant as the draft (no version is saved). ' +
        'Refuses when the tenant is not a development tenant, the package is not allowed or read-only, the local iFlow ' +
        'has structural errors, the iFlow is open in the designer, or its content changed on the tenant since the pull. ' +
        'Asks the user to confirm (with the changes) when "push" is in the configuration\'s confirm list.',
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
        // the version number (MANIFEST Bundle-Version) belongs to the tenant: not a local change
        const files = localChanges(local.dir, local.pulled.zip).filter((f) => f !== 'META-INF/MANIFEST.MF');
        if (!files.length) return toolResult({ iflow: id, pushed: false, reason: 'no local changes since the last pull' });
        await assertNotLocked(api.client, id);
        const current = await assertTenantUnchanged(api.client, id, local.pulled.zip);

        const base = iflowFromZip(local.pulled.zip);
        const changes = diffIflows(describe(base, { maxLen: 0 }), describe(local.doc, { maxLen: 0 }), { docA: base, docB: local.doc });
        await confirmAction(server, ctx.config, 'push',
          `Push ${id} to tenant "${api.tenant.name}"${api.tenant.label ? ` (${api.tenant.label})` : ''}? (a draft: no version is saved)\n` +
          `Changed files: ${files.join(', ')}\n${changes.slice(0, 30).join('\n')}${changes.length > 30 ? `\n… ${changes.length - 30} more lines` : ''}`);

        await uploadIflow(api.client, id, withTenantVersion(zipFolder(local.dir), current));
        const info = await getIflow(api.client, id);
        ctx.workspace.updatePulledState(api.tenant.name, { iflowId: id, packageId: info.packageId, ...(info.version ? { version: info.version } : {}) },
          await downloadIflow(api.client, id), local.dir);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_push', artifact: id, result: 'pushed', details: { files } });
        return toolResult({
          iflow: id, pushed: true, files, lastSavedVersion: info.version ?? null,
          next: 'the draft is on the tenant; cpi_deploy saves it as a new version and deploys it (or cpi_save_version on request)',
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
    'cpi_version_proposal',
    {
      title: 'Propose the next version',
      description:
        'Everything needed to propose the next version of an iFlow: the versioning rules (the project\'s own file or the ' +
        'default), the last saved version, the changes of the draft since then, a technical hint (major/minor/patch with ' +
        'reasons) and the latest changelog entries. Decide by the rules, then pass version and a brief one-line comment to ' +
        'cpi_save_version or cpi_deploy; the user confirms them.',
      inputSchema: { iflow: iflowIdArg, tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ iflow, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const { info, draft: _draft, ...p } = await versionProposal(ctx, api.client, api.tenant, iflow);
        return toolResult({
          iflow, rulesFile: ctx.config.versioning.rules ?? '(default)', rules: rulesOf(ctx),
          ...p, deployed: info.runtime?.version ?? null,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_save_version',
    {
      title: 'Save a version',
      description:
        'Save the iFlow\'s current design-time content (draft) on the tenant as a new version. Call cpi_version_proposal ' +
        'first and propose version and comment by the versioning rules; the user confirms or edits both in a dialog. ' +
        'The comment goes to the iFlow\'s changelog in the workspace (Cloud Integration\'s API cannot store it).',
      inputSchema: {
        iflow: iflowIdArg,
        version: z.string().optional().describe('Proposed version, e.g. 1.1.0; default: the technical hint'),
        comment: z.string().optional().describe('Proposed comment: one brief line, starting with the part, e.g. "minor: new step X adds header Y"'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ iflow, version, comment, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const info = await getIflow(api.client, iflow);
        await assertMayChange(api.client, api.tenant, info.packageId);
        return toolResult({ iflow, ...(await saveVersionAsked(server, ctx, api.client, api.tenant, iflow, { version, comment })) });
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
        'Deploy the iFlow. First runs SAP\'s design guideline check when the tenant\'s "guidelines" setting asks for it ' +
        '(block: new High findings stop the deploy). Then, with versioning.saveOn "deploy" (default), saves the draft as a ' +
        'new version: call cpi_version_proposal first and pass version and comment by the versioning rules; the user ' +
        'confirms both (and the deploy) in one dialog. With deploy mode "manual" (e.g. BTP trial tenants) the version is ' +
        'saved and the user is asked to deploy it in the designer; check afterwards with cpi_runtime_status. Otherwise ' +
        'deploys, waits, and reports errors with step names.',
      inputSchema: {
        iflow: iflowIdArg,
        version: z.string().optional().describe('Proposed version for the save before deploying'),
        comment: z.string().optional().describe('Proposed version comment: one brief line'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ iflow, version, comment, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const info = await getIflow(api.client, iflow);
        await assertMayChange(api.client, api.tenant, info.packageId);
        const gate = await guidelineGate(api.client, api.tenant, iflow, info.runtime?.version);
        // a version before every deploy; its dialog also confirms the deploy
        const saved = ctx.config.versioning.saveOn === 'deploy'
          ? await saveVersionAsked(server, ctx, api.client, api.tenant, iflow, { version, comment, deploy: api.tenant.deploy === 'api' })
          : undefined;
        const deployVersion = saved?.version ?? info.version ?? 'active';
        if (api.tenant.deploy === 'manual') {
          return toolResult({
            iflow, deployed: false, mode: 'manual', version: saved ?? null, guidelines: gate,
            next: `Tenant "${api.tenant.name}" is configured for manual deploys: ask the user to deploy ${iflow} version ${deployVersion} ` +
              'in the designer and to tell you when it is done; then check it with cpi_runtime_status.',
          });
        }
        if (!saved?.saved) await confirmAction(server, ctx.config, 'deploy',
          `Deploy ${iflow} (design-time version ${info.version ?? 'active'}) on tenant "${api.tenant.name}"?` +
          `${info.runtime ? ` Currently deployed: ${info.runtime.version ?? '?'} (${info.runtime.status}).` : ' Not deployed yet.'}` +
          `${gate.checked && gate.newHighFindings.length ? `\nNew High guideline findings:\n${gate.newHighFindings.join('\n')}` : ''}`);
        const r = await deployIflow(api.client, iflow, { timeoutSeconds: ctx.config.timeouts.deploySeconds });
        const name = await stepNamesFor(ctx, api.client, iflow);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_deploy', artifact: iflow, result: r.status });
        const data = { iflow, deployed: r.status === 'STARTED', ...r, ...(r.error ? { error: translate(r.error, name) } : {}), savedVersion: saved ?? null, guidelines: gate };
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

