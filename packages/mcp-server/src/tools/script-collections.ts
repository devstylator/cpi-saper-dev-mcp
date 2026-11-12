// Script collections: create, pull, push (as a new version), deploy and delete. Same rules as for iFlows: development
// tenants and allowed packages only, confirmation, a version dialog for every upload, no push over tenant changes.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  bumpVersion, collectionScripts, createScriptCollection, deleteScriptCollection, deployErrorList, deployScriptCollection, designLocks,
  downloadScriptCollection, getScriptCollection, IFLOW_ID, localChanges, resolvePackage, unzipEntries, uploadScriptCollection,
  withCollectionVersion, zipChanges, zipFolder, zipVersion, type VersionPart,
} from '@cpi-saper-dev-mcp/core';
import { context, tenantApi } from '../context.js';
import { toolError, toolResult } from '../result.js';
import { assertMayChange, audit, confirmAction, Declined } from '../safety.js';
import { askVersion, recordVersion } from '../versioning.js';
import { recheckBeforeUpload } from './tenant-write.js';

const tenantArg = z.string().optional().describe('Tenant name from the configuration; default: defaultTenant');
const idArg = z.string().describe('Script collection Id');

const notFound = (e: unknown) => (/not found/.test((e as Error).message) ? undefined : Promise.reject(e));

/** Version hint from the changed files: a removed script can break iFlows (major), a new one is minor, else patch */
function collectionProposal(lastVersion: string | undefined, files: string[]) {
  const removed = files.filter((f) => f.endsWith('(deleted)'));
  const added = files.filter((f) => f.endsWith('(new)'));
  const part: VersionPart = removed.length ? 'major' : added.length ? 'minor' : 'patch';
  const name = (f: string) => f.replace(/^src\/main\/resources\/script\//, '').replace(/ \((new|deleted)\)$/, '');
  const reasons = removed.length ? [`removed ${removed.map(name).join(', ')} (iFlows using them break)`] : added.length ? [`added ${added.map(name).join(', ')}`] : ['changed scripts'];
  return { lastVersion: lastVersion ?? null, changes: files, hint: { part, reasons, version: bumpVersion(lastVersion, part) } };
}

export function registerScriptCollectionTools(server: McpServer) {
  server.registerTool(
    'script_collection_create',
    {
      title: 'Create a script collection',
      description:
        'Create an empty script collection in an allowed package on a development tenant (version 1.0.0, as the ' +
        'designer does) and pull it as <workspace>/<package>/<id>/. Put scripts in src/main/resources/script/ and ' +
        'upload them with script_collection_push. Asks for confirmation when configured.',
      inputSchema: { package: z.string().describe('Package Id or display name'), id: idArg, name: z.string().optional(), tenant: tenantArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ package: pkgArg, id, name, tenant: tenantName }) => {
      const ctx = await context(server).catch((e) => e as Error);
      if (ctx instanceof Error) return toolError(ctx);
      const api = tenantApi(ctx.config, tenantName);
      try {
        if (!IFLOW_ID.test(id)) throw new Error(`"${id}" is not a valid Id: use letters, digits, "_", "-" and "." only`);
        const pkg = await resolvePackage(api.client, pkgArg);
        await assertMayChange(api.client, api.tenant, pkg.id);
        const existing = await getScriptCollection(api.client, id).catch(notFound);
        if (existing) throw new Error(`a script collection with Id ${id} already exists (package ${existing.packageId}); pull it with script_collection_pull`);
        const dir = ctx.workspace.iflowDir(pkg.id, id);
        if (existsSync(dir) && readdirSync(dir).length) throw new Error(`the local folder ${relative(ctx.workspace.root, dir)} already exists and is not empty; move or delete it first (nothing was created)`);
        await confirmAction(server, ctx.config, 'create', `Create the script collection ${id}${name && name !== id ? ` ("${name}")` : ''} in package ${pkg.id} ("${pkg.name}") on tenant "${api.tenant.name}"?`);
        await createScriptCollection(api.client, pkg.id, id, name ?? id);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'script_collection_create', artifact: id, result: `created in ${pkg.id}` });
        const r = ctx.workspace.pull(api.tenant.name, { iflowId: id, packageId: pkg.id, version: '1.0.0' }, await downloadScriptCollection(api.client, id));
        return toolResult({
          tenant: api.tenant.name, scriptCollection: id, package: pkg.id, version: '1.0.0', folderInWorkspace: relative(ctx.workspace.root, r.dir), files: r.files,
          next: 'write scripts into src/main/resources/script/ (e.g. Utils.groovy), then script_collection_push and script_collection_deploy',
        });
      } catch (e) {
        if (!(e instanceof Declined)) audit(ctx.config, { tenant: api.tenant.name, tool: 'script_collection_create', artifact: id, result: `refused: ${(e as Error).message.split('\n')[0]}` });
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'script_collection_pull',
    {
      title: 'Pull a script collection',
      description:
        'Download a script collection into the workspace as <workspace>/<packageId>/<id>/; its scripts are in ' +
        'src/main/resources/script/. Refuses to overwrite local changes made since the previous pull unless overwrite is true.',
      inputSchema: { id: idArg, tenant: tenantArg, overwrite: z.boolean().default(false).describe('Discard local changes made since the previous pull') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, tenant, overwrite }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenant);
        const info = await getScriptCollection(api.client, id);
        const zip = await downloadScriptCollection(api.client, id);
        const r = ctx.workspace.pull(api.tenant.name, { iflowId: id, packageId: info.packageId, ...(info.version ? { version: info.version } : {}) }, zip, { overwrite });
        return toolResult({
          tenant: api.tenant.name, scriptCollection: id, package: info.packageId, version: info.version ?? null, runtime: info.runtime,
          folderInWorkspace: relative(ctx.workspace.root, r.dir), scripts: collectionScripts(zip),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'script_collection_push',
    {
      title: 'Push a script collection as a new version',
      description:
        'Upload a locally edited script collection (pulled or created before) as a new version: pass version and a ' +
        'one-line comment (hint: a removed script is major, a new one minor, a change patch); the user confirms both ' +
        '(in unattendedTestMode, test only, they are used as passed). The tenant keeps no comments for script ' +
        'collections, so the comment goes to the changelog next to the folder. Refuses when the collection changed on ' +
        'the tenant since the pull or is open in the designer. iFlows use the new version after script_collection_deploy.',
      inputSchema: {
        id: idArg,
        version: z.string().optional().describe('Proposed version, e.g. 1.1.0'),
        comment: z.string().optional().describe('Proposed comment: one brief line starting with the part, e.g. "minor: new script Utils.groovy"'),
        tenant: tenantArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, version, comment, tenant: tenantName }) => {
      const ctx = await context(server).catch((e) => e as Error);
      if (ctx instanceof Error) return toolError(ctx);
      const api = tenantApi(ctx.config, tenantName);
      try {
        const pulled = ctx.workspace.pulledState(api.tenant.name, id);
        if (!pulled || !existsSync(pulled.state.dir)) throw new Error(`${id} was not pulled from tenant "${api.tenant.name}"; pull it first (script_collection_pull)`);
        const dir = pulled.state.dir;
        await assertMayChange(api.client, api.tenant, pulled.state.packageId);
        const files = localChanges(dir, pulled.zip).filter((f) => f !== 'META-INF/MANIFEST.MF');
        if (!files.length) return toolResult({ scriptCollection: id, pushed: false, reason: 'no local changes since the last pull or push' });
        const lock = (await designLocks(api.client)).find((l) => l.artifactId === id);
        if (lock) throw new Error(`${id} is open for editing in the designer${lock.lockedBy ? ` by ${lock.lockedBy}` : ''}; close it there first`);
        const current = await downloadScriptCollection(api.client, id);
        const changed = zipChanges(pulled.zip, current);
        if (changed.length) throw new Error(`${id} changed on the tenant since your pull (${changed.slice(0, 8).join(', ')}); pull it again (overwrite) and re-apply your changes`);
        const p = collectionProposal(zipVersion(current), files);
        const v = await askVersion(server, ctx.config, api.tenant, `Push script collection ${id} to tenant "${api.tenant.name}" as a new version?\nChanged files: ${files.join(', ')}`,
          p, { version, comment });
        await recheckBeforeUpload(ctx.config, id, current, {
          download: () => downloadScriptCollection(api.client, id),
          locked: async () => (await designLocks(api.client)).find((l) => l.artifactId === id),
        });
        await uploadScriptCollection(api.client, id, withCollectionVersion(zipFolder(dir), v.version));
        const info = await getScriptCollection(api.client, id);
        const after = await downloadScriptCollection(api.client, id);
        // the tenant's manifest (version in Bundle-Version and Provide-Capability, wrapped its way) becomes the local one
        writeFileSync(join(dir, 'META-INF', 'MANIFEST.MF'), unzipEntries(after)['META-INF/MANIFEST.MF']!);
        ctx.workspace.updatePulledState(api.tenant.name, { iflowId: id, packageId: info.packageId, version: v.version }, after, dir);
        const rec = recordVersion(ctx, api.tenant, 'script_collection_push', id, info.packageId, v, undefined);
        return toolResult({
          scriptCollection: id, pushed: true, version: v.version, comment: v.comment, previous: p.lastVersion, files, changelog: rec.changelog,
          scripts: collectionScripts(after),
          next: info.runtime ? 'deploy it again (script_collection_deploy) so iFlows use the new version' : 'deploy it with script_collection_deploy; iFlows can only use a deployed collection',
        });
      } catch (e) {
        if (!(e instanceof Declined)) audit(ctx.config, { tenant: api.tenant.name, tool: 'script_collection_push', artifact: id, result: `refused: ${(e as Error).message.split('\n')[0]}` });
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'script_collection_deploy',
    {
      title: 'Deploy a script collection',
      description:
        'Deploy the script collection\'s current version so iFlows can use its scripts (deploy the collection before ' +
        'the iFlows that use it). With deploy mode "manual" nothing is deployed: ask the user to deploy it in the ' +
        'designer. Asks for confirmation when configured.',
      inputSchema: { id: idArg, tenant: tenantArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, tenant: tenantName }) => {
      try {
        const ctx = await context(server);
        const api = tenantApi(ctx.config, tenantName);
        const info = await getScriptCollection(api.client, id);
        await assertMayChange(api.client, api.tenant, info.packageId);
        if (api.tenant.deploy === 'manual') {
          return toolResult({
            scriptCollection: id, deployed: false, mode: 'manual', version: info.version ?? null,
            next: `Tenant "${api.tenant.name}" is configured for manual deploys: ask the user to deploy script collection ${id} version ${info.version ?? '(current)'} in the designer and to tell you when it is done.`,
          });
        }
        await confirmAction(server, ctx.config, 'deploy', `Deploy script collection ${id} version ${info.version ?? '(current)'} on tenant "${api.tenant.name}"?` +
          `${info.runtime ? ` Currently deployed: ${info.runtime.version ?? '?'} (${info.runtime.status}).` : ' Not deployed yet.'}`);
        const r = await deployScriptCollection(api.client, id, { timeoutSeconds: ctx.config.timeouts.deploySeconds });
        audit(ctx.config, { tenant: api.tenant.name, tool: 'script_collection_deploy', artifact: id, result: `${r.status} ${info.version ?? ''}`.trim() });
        const data = { scriptCollection: id, deployed: r.status === 'STARTED', ...r, ...(r.error ? { deployErrors: deployErrorList(r.error) } : {}) };
        return { ...toolResult(data), ...(r.status === 'STARTED' ? {} : { isError: true }) };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'script_collection_delete',
    {
      title: 'Delete a script collection',
      description:
        'Delete a script collection with its version history from a development tenant; this cannot be undone. ' +
        'Refuses a deployed collection (cpi_undeploy first) and one open in the designer. iFlows that still use its ' +
        'scripts fail at their next deploy. Asks for confirmation unless removed from "confirm". The local folder stays.',
      inputSchema: { id: idArg, tenant: tenantArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, tenant: tenantName }) => {
      const ctx = await context(server).catch((e) => e as Error);
      if (ctx instanceof Error) return toolError(ctx);
      const api = tenantApi(ctx.config, tenantName);
      try {
        const info = await getScriptCollection(api.client, id);
        await assertMayChange(api.client, api.tenant, info.packageId);
        if (info.runtime) throw new Error(`${id} is deployed (version ${info.runtime.version ?? '?'}); undeploy it with cpi_undeploy first`);
        const lock = (await designLocks(api.client)).find((l) => l.artifactId === id);
        if (lock) throw new Error(`${id} is open for editing in the designer; close it there first`);
        await confirmAction(server, ctx.config, 'delete',
          `Delete the script collection ${id} ("${info.name}", version ${info.version ?? '?'}) from package ${info.packageId} on tenant "${api.tenant.name}"? ` +
          'Its whole version history is deleted; iFlows that use its scripts fail at their next deploy. This cannot be undone.');
        await deleteScriptCollection(api.client, id);
        audit(ctx.config, { tenant: api.tenant.name, tool: 'script_collection_delete', artifact: id, result: `deleted from ${info.packageId} (was ${info.version ?? '?'})` });
        return toolResult({ scriptCollection: id, deleted: true, package: info.packageId, lastVersion: info.version ?? null, pulledStateRemoved: ctx.workspace.forgetPulledState(api.tenant.name, id) });
      } catch (e) {
        if (!(e instanceof Declined)) audit(ctx.config, { tenant: api.tenant.name, tool: 'script_collection_delete', artifact: id, result: `refused: ${(e as Error).message.split('\n')[0]}` });
        return toolError(e);
      }
    },
  );
}
