// Versions: every upload is an entry in Cloud Integration's version history (number from the uploaded manifest,
// comment from the upload, the uploading user), so each push is one version. The user confirms number and comment
// in a dialog, prefilled with the agent's proposal; the comment is also kept in the iFlow's changelog for git.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  appendChangelog, bumpVersion, changelogPath, cmpVersion, isVersion, loadVersioningRules, readChangelog, suggestPart,
  type IflowModel, type TenantConfig, type VersionPart,
} from '@cpi-saper-dev-mcp/core';
import type { Config } from '@cpi-saper-dev-mcp/core';
import { tokenStoreOf, type ToolContext } from './context.js';
import { audit, Declined } from './safety.js';

export const rulesOf = (ctx: ToolContext) => loadVersioningRules(ctx.config.versioning.rules);

/** The iFlow's changelog: next to its folder in the workspace */
export function changelogFor(ctx: ToolContext, tenant: TenantConfig, iflowId: string, packageId: string) {
  const pulled = ctx.workspace.pulledState(tenant.name, iflowId);
  return changelogPath(pulled?.state.dir ?? join(ctx.workspace.root, packageId, iflowId), iflowId);
}

/** Changes and the technical hint for the next version; before/after undefined when the changes are not known */
export function proposal(lastVersion: string | undefined, before?: IflowModel, after?: IflowModel) {
  const hint = before && after
    ? suggestPart(before, after)
    : { part: 'patch' as VersionPart, reasons: ['the changes are not known: decide from the work done'], changes: [] as string[] };
  return { lastVersion: lastVersion ?? null, changes: hint.changes, hint: { part: hint.part, reasons: hint.reasons, version: bumpVersion(lastVersion, hint.part) } };
}

/**
 * Ask the user for the version number and comment (one dialog, prefilled with the agent's proposal or the hint).
 * Every version needs both, so this always asks; clients that cannot ask are refused. In unattendedTestMode (test
 * only) the agent's proposal (or the hint) is used without asking, checked the same way.
 */
export async function askVersion(server: McpServer, config: Config, tenant: TenantConfig, intro: string, p: ReturnType<typeof proposal>,
  agent: { version?: string | undefined; comment?: string | undefined }): Promise<{ version: string; comment: string }> {
  if (config.unattendedTestMode) {
    return checkVersion(p, agent.version ?? p.hint.version, agent.comment ?? defaultComment(p));
  }
  if (!server.server.getClientCapabilities()?.elicitation) {
    throw new Error('every version needs a number and a comment confirmed by you, but this client cannot ask (no MCP elicitation support); ' +
      'use a client that supports it (for example Claude Code 2.1.76 or later, or VS Code)');
  }
  const version = agent.version ?? p.hint.version;
  const comment = agent.comment ?? defaultComment(p);
  const r = await server.server.elicitInput({
    mode: 'form',
    message: `${intro}\nLast version: ${p.lastVersion ?? '(none)'}. Hint: ${p.hint.part} (${p.hint.reasons.join('; ')}).\n` +
      `${p.changes.slice(0, 25).join('\n')}${p.changes.length > 25 ? `\n… ${p.changes.length - 25} more lines` : ''}`,
    requestedSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', title: 'Version', description: `MAJOR.MINOR.PATCH, higher than ${p.lastVersion ?? 'the last one'}`, default: version },
        comment: { type: 'string', title: 'Comment', description: 'One line: what changed', default: comment },
      },
      required: ['version', 'comment'],
    },
  });
  if (r.action !== 'accept') {
    throw new Declined(r.action === 'decline' ? `the user declined: nothing was uploaded to ${tenant.name}` : 'the user closed the question without deciding: nothing was uploaded');
  }
  return checkVersion(p, String(r.content?.version ?? version), String(r.content?.comment ?? comment));
}

const defaultComment = (p: ReturnType<typeof proposal>) =>
  `${p.hint.part}: ${p.changes.find((l) => /^[+~-] /.test(l))?.replace(/\s*\[[^\]]*\]/g, '') ?? 'changes'}`.slice(0, 120);

function checkVersion(p: ReturnType<typeof proposal>, version: string, comment: string) {
  const v = version.trim();
  const c = comment.trim();
  if (!isVersion(v)) throw new Error(`"${v}" is not a version like 1.0.14`);
  if (p.lastVersion && isVersion(p.lastVersion) && cmpVersion(v, p.lastVersion) <= 0) throw new Error(`version ${v} must be higher than ${p.lastVersion}`);
  if (!c) throw new Error('every version needs a comment');
  return { version: v, comment: c };
}

/** After an upload: the number into the local manifest, the comment into the changelog, an audit line */
export function recordVersion(ctx: ToolContext, tenant: TenantConfig, tool: string, iflowId: string, packageId: string,
  v: { version: string; comment: string }, localDir?: string) {
  const mf = localDir && join(localDir, 'META-INF', 'MANIFEST.MF');
  if (mf && existsSync(mf)) writeFileSync(mf, readFileSync(mf, 'utf8').replace(/^Bundle-Version:\s*\S+/m, `Bundle-Version: ${v.version}`));
  const user = (tenant.login === 'user' ? (tokenStoreOf(ctx.config, tenant).read()?.email ?? 'user') : 'technical client (service key)') +
    (ctx.config.unattendedTestMode ? ', unattended test mode' : '');
  const log = changelogFor(ctx, tenant, iflowId, packageId);
  appendChangelog(log, iflowId, { version: v.version, date: new Date().toISOString().slice(0, 10), user, comment: v.comment });
  audit(ctx.config, { tenant: tenant.name, tool, artifact: iflowId, result: `version ${v.version}`, details: { comment: v.comment } });
  return { changelog: log, recent: readChangelog(log, 3) };
}
