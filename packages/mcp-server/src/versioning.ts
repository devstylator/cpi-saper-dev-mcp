// Saving versions: compare the draft with the last saved version, propose number and comment, ask the user in one
// dialog, save, and record the comment in the iFlow's changelog (Cloud Integration's API cannot store it).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  appendChangelog, bumpVersion, changelogPath, cmpVersion, describe, downloadIflow, getIflow, iflowFromZip, isVersion,
  loadVersioningRules, readChangelog, saveVersion, unzipEntries, suggestPart, zipChanges, type CpiClient, type TenantConfig, type VersionPart,
} from '@cpi-saper-dev-mcp/core';
import { tokenStoreOf, type ToolContext } from './context.js';
import { audit, Declined } from './safety.js';

export const rulesOf = (ctx: ToolContext) => loadVersioningRules(ctx.config.versioning.rules);

/** Where the iFlow's changelog lives: next to its folder in the workspace */
function changelogFor(ctx: ToolContext, tenant: TenantConfig, iflowId: string, packageId: string) {
  const pulled = ctx.workspace.pulledState(tenant.name, iflowId);
  return changelogPath(pulled?.state.dir ?? join(ctx.workspace.root, packageId, iflowId), iflowId);
}

/** What changed since the last saved version, and the technical hint for the version part */
export async function versionProposal(ctx: ToolContext, client: CpiClient, tenant: TenantConfig, iflowId: string) {
  const info = await getIflow(client, iflowId);
  const lastSaved = info.version && isVersion(info.version) ? info.version : undefined;
  const draft = await downloadIflow(client, iflowId);
  // the tenant returns the draft for the latest version number, so the saved content comes from our own snapshot
  const snap = ctx.workspace.versionSnapshot(tenant.name, iflowId);
  const saved = snap && lastSaved && snap.version === lastSaved ? snap : undefined;
  const basis = saved
    ? (saved.exact ? `version ${lastSaved} as saved by this tool` : `the content when the iFlow was pulled at version ${lastSaved} (approximate: the version may have been saved in the designer)`)
    : `unknown: version ${lastSaved ?? '(none)'} was saved outside this tool and the iFlow was not pulled at that version`;
  // the manifest carries the version number itself: not a content change
  const changedFiles = saved ? zipChanges(saved.zip, draft).filter((f) => f !== 'META-INF/MANIFEST.MF') : ['(not known)'];
  const hint = saved
    ? suggestPart(describe(iflowFromZip(saved.zip), { maxLen: 0 }), describe(iflowFromZip(draft), { maxLen: 0 }))
    : { part: 'patch' as VersionPart, reasons: ['the content of the last saved version is not known: decide from the work done'], changes: [] };
  return {
    info, draft, lastSaved: lastSaved ?? null, comparedWith: basis, changedFiles, changes: hint.changes,
    hint: { part: hint.part, reasons: hint.reasons, version: bumpVersion(lastSaved, hint.part) },
    changelog: readChangelog(changelogFor(ctx, tenant, iflowId, info.packageId)),
  };
}

const whoAmI = (ctx: ToolContext, tenant: TenantConfig) =>
  (tenant.login === 'user' ? (tokenStoreOf(ctx.config, tenant).read()?.email ?? 'user') : 'technical client (service key)');

/**
 * Save the draft as a new version after asking the user for number and comment (one dialog, prefilled with the
 * agent's proposal). With deploy: true the same dialog confirms the deploy. Returns saved: false when the draft has no
 * changes since the last saved version.
 */
export async function saveVersionAsked(server: McpServer, ctx: ToolContext, client: CpiClient, tenant: TenantConfig, iflowId: string,
  proposal: { version?: string | undefined; comment?: string | undefined; deploy?: boolean }) {
  const p = await versionProposal(ctx, client, tenant, iflowId);
  if (p.lastSaved && !p.changedFiles.length) return { saved: false as const, version: p.lastSaved, reason: `no changes since version ${p.lastSaved} (compared with ${p.comparedWith})` };
  if (!server.server.getClientCapabilities()?.elicitation) {
    throw new Error('saving a version asks you for its number and comment, but this client cannot ask (no MCP elicitation support); ' +
      'use a client that supports it (for example Claude Code 2.1.76 or later, or VS Code)');
  }
  const version = proposal.version ?? p.hint.version;
  const comment = proposal.comment ?? `${p.hint.part}: ${p.changes.find((l) => /^[+~-] /.test(l))?.replace(/\s*\[[^\]]*\]/g, '') ?? 'changes'}`.slice(0, 120);
  const r = await server.server.elicitInput({
    mode: 'form',
    message: `${proposal.deploy ? 'Deploy' : 'Save'} ${iflowId} on tenant "${tenant.name}"${proposal.deploy ? ' after saving it as a new version' : ' as a new version'}?\n` +
      `Last saved version: ${p.lastSaved ?? '(none)'}; changes compared with ${p.comparedWith}.\nHint: ${p.hint.part} (${p.hint.reasons.join('; ')}).\n` +
      `${p.changes.slice(0, 20).join('\n')}${p.changes.length > 20 ? `\n… ${p.changes.length - 20} more lines` : ''}`,
    requestedSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', title: 'Version', description: 'MAJOR.MINOR.PATCH, higher than the last saved one', default: version },
        comment: { type: 'string', title: 'Comment', description: 'One line: what changed', default: comment },
      },
      required: ['version', 'comment'],
    },
  });
  if (r.action !== 'accept') {
    throw new Declined(r.action === 'decline' ? `the user declined: no version saved${proposal.deploy ? ', nothing deployed' : ''}` : 'the user closed the question without deciding');
  }
  const v = String(r.content?.version ?? version).trim();
  const c = String(r.content?.comment ?? comment).trim();
  if (!isVersion(v)) throw new Error(`"${v}" is not a version like 1.0.14`);
  if (p.lastSaved && cmpVersion(v, p.lastSaved) <= 0) throw new Error(`version ${v} must be higher than the last saved version ${p.lastSaved}`);
  if (!c) throw new Error('every version needs a comment');
  await saveVersion(client, iflowId, v);
  ctx.workspace.saveVersionSnapshot(tenant.name, iflowId, v, p.draft, true);
  const user = whoAmI(ctx, tenant);
  const log = changelogFor(ctx, tenant, iflowId, p.info.packageId);
  appendChangelog(log, iflowId, { version: v, date: new Date().toISOString().slice(0, 10), user, comment: c });
  const pulled = ctx.workspace.pulledState(tenant.name, iflowId);
  if (pulled) {
    const now = await downloadIflow(client, iflowId);
    ctx.workspace.updatePulledState(tenant.name, { iflowId, packageId: p.info.packageId, version: v }, now, pulled.state.dir);
    // the tenant wrote the new number into its MANIFEST.MF: take it into the local copy too
    const manifest = unzipEntries(now)['META-INF/MANIFEST.MF'];
    if (manifest) writeFileSync(join(pulled.state.dir, 'META-INF', 'MANIFEST.MF'), manifest);
  }
  audit(ctx.config, { tenant: tenant.name, tool: 'save_version', artifact: iflowId, result: `saved ${v}`, details: { comment: c } });
  return { saved: true as const, version: v, comment: c, previous: p.lastSaved, changelog: log };
}
