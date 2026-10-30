import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  checkModel, createIflow, deployIflow, describe, designLocks, downloadIflow, getIflow, iflowFromZip, localChanges, readChangelog,
  IFLOW_ID, resolvePackage, runGuidelines, runtimeError, undeployIflow, uploadIflow, validate, withVersion, zipChanges, zipFolder, zipVersion,
  type CpiClient, type GuidelineFinding, type TenantConfig,
} from '@cpi-saper-dev-mcp/core';
import { context, localIflow, stepNamesFor, tenantApi, type ToolContext } from '../context.js';
import { toolError, toolResult } from '../result.js';
import { assertMayChange, audit, confirmAction, Declined } from '../safety.js';
import { askVersion, changelogFor, proposal, recordVersion, rulesOf } from '../versioning.js';

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
 * SAP's guideline check as a deploy gate. "New" High findings are those not recorded at the last deploy through this
 * tool (the API cannot run the check on older versions: only the latest one is reachable), so an iFlow's existing
 * debt does not block every deploy. The record is kept in the state folder and updated by each deploy.
 */
async function guidelineGate(ctx: ToolContext, client: CpiClient, tenant: TenantConfig, iflowId: string) {
  if (tenant.guidelines === 'off') return { checked: false as const };
  const record = join(ctx.workspace.stateDir, tenant.name, `${iflowId}.guidelines.json`);
  const now = (await runGuidelines(client, iflowId)).findings.filter(highFinding);
  const known = new Set<string>(existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as { high: string[] }).high : []);
  const fresh = now.filter((f) => !known.has(findingKey(f)));
  const lines = fresh.map((f) => `${f.id}: ${f.name}${f.violated ? ` ${f.violated}` : ''}${f.fix ? ` (fix: ${f.fix})` : ''}`);
  if (fresh.length && tenant.guidelines === 'block') {
    throw new Error(`not deployed: SAP's design guideline check reports new High findings (${existsSync(record) ? 'not present at the last deploy' : 'no deploy recorded yet, so all count as new'}):\n  ${lines.join('\n  ')}\n` +
      'Fix them, or set "guidelines": "warn" for this tenant');
  }
  const accept = () => {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${JSON.stringify({ high: now.map(findingKey), at: new Date().toISOString() }, null, 2)}\n`);
  };
  return { checked: true as const, highFindings: now.length, newHighFindings: lines, accept };
}

export function registerTenantWriteTools(server: McpServer) {
  server.registerTool(
    'iflow_create',
    {
      title: 'Create a new iFlow',
      description:
        'Create an empty iFlow in a package on a development tenant and pull it into the workspace. The tenant ' +
        'scaffolds it like the designer does: version 1.0.0, a Sender and a Receiver box, Start -> End, no adapters. ' +
        'Then build it locally with iflow_edit (add_adapter connects the sender to the Start event, insert_step adds ' +
        'steps) and upload it with cpi_push, which gives it its first real version. Refuses an Id that exists on the ' +
        'tenant, a package that is not allowed or read-only, and non-development tenants. Asks for confirmation when configured.',
      inputSchema: {
        package: z.string().describe('Package Id or display name'),
        id: z.string().describe('iFlow Id: letters, digits, "_", "-", "." (no spaces); unique on the tenant'),
        name: z.string().optional().describe('Display name (default: the Id)'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ package: pkgArg, id, name, tenant: tenantName }) => {
      const ctx = await context(server).catch((e) => e as Error);
      if (ctx instanceof Error) return toolError(ctx);
      const api = tenantApi(ctx.config, tenantName);
      try {
        if (!IFLOW_ID.test(id)) throw new Error(`"${id}" is not a valid iFlow Id: use letters, digits, "_", "-" and "." only`);
        const pkg = await resolvePackage(api.client, pkgArg);
        await assertMayChange(api.client, api.tenant, pkg.id);
        const existing = await getIflow(api.client, id).catch((e: Error) => (/not found/.test(e.message) ? undefined : Promise.reject(e)));
        if (existing) throw new Error(`an iFlow with Id ${id} already exists on tenant "${api.tenant.name}" (package ${existing.packageId}); pull it with cpi_pull or choose another Id`);
        await confirmAction(server, ctx.config, 'create',
          `Create the iFlow ${id}${name && name !== id ? ` ("${name}")` : ''} in package ${pkg.id} ("${pkg.name}") on tenant "${api.tenant.name}"?`);
        await createIflow(api.client, pkg.id, id, name ?? id);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'iflow_create', artifact: id, result: `created in ${pkg.id}` });
        const info = await getIflow(api.client, id);
        const r = ctx.workspace.pull(api.tenant.name, { iflowId: id, packageId: pkg.id, ...(info.version ? { version: info.version } : {}) }, await downloadIflow(api.client, id));
        return toolResult({
          tenant: api.tenant.name, iflow: id, package: pkg.id, version: info.version ?? null,
          folder: r.dir, folderInWorkspace: relative(ctx.workspace.root, r.dir), files: r.files,
          next: 'iflow_describe shows the scaffold; build it with iflow_edit (add_adapter on StartEvent_2 for the sender, insert_step after it), then cpi_push',
        });
      } catch (e) {
        if (!(e instanceof Declined)) audit(ctx.config, { tenant: api.tenant.name, tool: 'iflow_create', artifact: id, result: `refused: ${(e as Error).message.split('\n')[0]}` });
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_push',
    {
      title: 'Push an iFlow as a new version',
      description:
        'Upload a locally edited iFlow (pulled before with cpi_pull) to its tenant. Every upload is a new version in ' +
        'Cloud Integration\'s history, so each push gets a version number and a one-line comment: call ' +
        'cpi_version_proposal first and pass version and comment by the versioning rules; the user confirms or edits ' +
        'both in a dialog (in unattendedTestMode, test only, they are used as passed). Collect and check related edits locally before pushing, rather than pushing every small step. ' +
        'Refuses when the tenant is not a development tenant, the package is not allowed or read-only, the local iFlow ' +
        'has structural errors, the iFlow is open in the designer, or its content changed on the tenant since the pull.',
      inputSchema: {
        iflow: z.string().describe('Local iFlow: Id, folder or .iflw'),
        version: z.string().optional().describe('Proposed version, e.g. 1.2.0 (default: the hint from the changes)'),
        comment: z.string().optional().describe('Proposed comment: one brief line starting with the part, e.g. "minor: new step X adds header Y"'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ iflow, version, comment, tenant: tenantName }) => {
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
        // the version number (MANIFEST Bundle-Version) is set by the push itself: not a local change
        const files = localChanges(local.dir, local.pulled.zip).filter((f) => f !== 'META-INF/MANIFEST.MF');
        if (!files.length) return toolResult({ iflow: id, pushed: false, reason: 'no local changes since the last pull or push' });
        await assertNotLocked(api.client, id);
        const current = await assertTenantUnchanged(api.client, id, local.pulled.zip);

        const p = proposal(zipVersion(current), describe(iflowFromZip(local.pulled.zip), { maxLen: 0 }), describe(local.doc, { maxLen: 0 }));
        const v = await askVersion(server, ctx.config, api.tenant,
          `Push ${id} to tenant "${api.tenant.name}"${api.tenant.label ? ` (${api.tenant.label})` : ''} as a new version?\nChanged files: ${files.join(', ')}`,
          p, { version, comment });
        await uploadIflow(api.client, id, withVersion(zipFolder(local.dir), v.version), v.comment);
        const info = await getIflow(api.client, id);
        ctx.workspace.updatePulledState(api.tenant.name, { iflowId: id, packageId: info.packageId, version: v.version }, await downloadIflow(api.client, id), local.dir);
        const rec = recordVersion(ctx, api.tenant, 'cpi_push', id, info.packageId, v, local.dir);
        return toolResult({
          iflow: id, pushed: true, version: v.version, comment: v.comment, previous: p.lastVersion, files, changelog: rec.changelog,
          next: 'deploy it with cpi_deploy when it should run',
        });
      } catch (e) {
        if (!(e instanceof Declined)) audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_push', artifact: id, result: `refused: ${(e as Error).message.split('\n')[0]}` });
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_version_proposal',
    {
      title: 'Propose the next version',
      description:
        'Everything needed to propose the version for a push: the versioning rules (the project\'s own file or the ' +
        'default), the last version (from the pull), the local changes since then, a technical hint (major/minor/patch ' +
        'with reasons) and the latest changelog entries. Decide by the rules, then pass version and a brief one-line ' +
        'comment to cpi_push; the user confirms them.',
      inputSchema: { iflow: z.string().describe('Local iFlow: Id, folder or .iflw'), tenant: tenantArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ iflow, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const local = pulledIflow(ctx, iflow, api.tenant);
        const p = proposal(zipVersion(local.pulled.zip), describe(iflowFromZip(local.pulled.zip), { maxLen: 0 }), describe(local.doc, { maxLen: 0 }));
        return toolResult({
          iflow: local.pulled.state.iflowId, rulesFile: ctx.config.versioning.rules ?? '(default)', rules: rulesOf(ctx), ...p,
          changelog: readChangelog(changelogFor(ctx, api.tenant, local.pulled.state.iflowId, local.pulled.state.packageId)),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'cpi_save_version',
    {
      title: 'Make the tenant\'s content a new version',
      description:
        'Record the iFlow\'s current content on the tenant as a new version with number and comment, for example after ' +
        'the user worked in the designer. (Local changes are versioned by cpi_push.) The content is uploaded again with ' +
        'the new number; the user confirms number and comment in a dialog.',
      inputSchema: {
        iflow: iflowIdArg,
        version: z.string().optional().describe('Proposed version'),
        comment: z.string().optional().describe('Proposed comment: one brief line'),
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
        await assertNotLocked(api.client, iflow);
        const current = await downloadIflow(api.client, iflow);
        const pulled = ctx.workspace.pulledState(api.tenant.name, iflow);
        // the changes since the pull are known when the iFlow was pulled; the user's designer work shows there
        const p = pulled
          ? proposal(zipVersion(current), describe(iflowFromZip(pulled.zip), { maxLen: 0 }), describe(iflowFromZip(current), { maxLen: 0 }))
          : proposal(zipVersion(current));
        const v = await askVersion(server, ctx.config, api.tenant, `Record ${iflow} on tenant "${api.tenant.name}" as a new version (its current content, unchanged)?`, p, { version, comment });
        await uploadIflow(api.client, iflow, withVersion(current, v.version), v.comment);
        // the local copy follows only if it holds no unpushed work
        const localDir = pulled && !localChanges(pulled.state.dir, pulled.zip).filter((f) => f !== 'META-INF/MANIFEST.MF').length ? pulled.state.dir : undefined;
        if (pulled && localDir && !zipChanges(pulled.zip, current).filter((f) => f !== 'META-INF/MANIFEST.MF').length) {
          ctx.workspace.updatePulledState(api.tenant.name, { iflowId: iflow, packageId: info.packageId, version: v.version }, await downloadIflow(api.client, iflow), localDir);
        }
        const rec = recordVersion(ctx, api.tenant, 'cpi_save_version', iflow, info.packageId, v, localDir);
        return toolResult({ iflow, version: v.version, comment: v.comment, previous: p.lastVersion, changelog: rec.changelog });
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
        'Deploy the iFlow\'s current version (every push is a version). First runs SAP\'s design guideline check when ' +
        'the tenant\'s "guidelines" setting asks for it (block: High findings not present at the last deploy stop it). ' +
        'With deploy mode "manual" (e.g. BTP trial tenants) nothing is deployed: ask the user to deploy that version in ' +
        'the designer, then check with cpi_runtime_status. Otherwise asks for confirmation (if configured), deploys, ' +
        'waits, and reports errors with step names.',
      inputSchema: { iflow: iflowIdArg, tenant: tenantArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ iflow, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const info = await getIflow(api.client, iflow);
        await assertMayChange(api.client, api.tenant, info.packageId);
        const gate = await guidelineGate(ctx, api.client, api.tenant, iflow);
        const { accept, ...guidelines } = gate.checked ? gate : { ...gate, accept: undefined };
        if (api.tenant.deploy === 'manual') {
          accept?.();
          return toolResult({
            iflow, deployed: false, mode: 'manual', version: info.version ?? null, guidelines,
            next: `Tenant "${api.tenant.name}" is configured for manual deploys: ask the user to deploy ${iflow} version ${info.version ?? '(current)'} ` +
              'in the designer and to tell you when it is done; then check it with cpi_runtime_status.',
          });
        }
        await confirmAction(server, ctx.config, 'deploy',
          `Deploy ${iflow} version ${info.version ?? '(current)'} on tenant "${api.tenant.name}"?` +
          `${info.runtime ? ` Currently deployed: ${info.runtime.version ?? '?'} (${info.runtime.status}).` : ' Not deployed yet.'}` +
          `${gate.checked && gate.newHighFindings.length ? `\nNew High guideline findings:\n${gate.newHighFindings.join('\n')}` : ''}`);
        const r = await deployIflow(api.client, iflow, { timeoutSeconds: ctx.config.timeouts.deploySeconds });
        if (r.status === 'STARTED') accept?.();
        const name = await stepNamesFor(ctx, api.client, iflow);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'cpi_deploy', artifact: iflow, result: `${r.status} ${info.version ?? ''}`.trim() });
        const data = { iflow, deployed: r.status === 'STARTED', ...r, ...(r.error ? { error: translate(r.error, name) } : {}), guidelines };
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

