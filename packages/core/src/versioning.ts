// Versioning: the rules the agent follows when proposing a version (bundled default, replaceable per project), a
// technical hint derived from the changes, and a changelog per iFlow. Every upload is a version in Cloud Integration
// (number from the manifest, comment from the upload); the changelog <workspace>/<package>/<iflowId>.CHANGELOG.md,
// next to the iFlow folder (never uploaded), keeps a copy for git, since the API cannot read the history.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IflowModel } from './iflow/model.js';
import { diffIflows } from './iflow/diff.js';

export const BUNDLED_VERSIONING_RULES = fileURLToPath(new URL('../rules/versioning.md', import.meta.url));

export function loadVersioningRules(path: string = BUNDLED_VERSIONING_RULES): string {
  return readFileSync(path, 'utf8');
}

export type VersionPart = 'major' | 'minor' | 'patch';

export function bumpVersion(version: string | undefined, part: VersionPart): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!m) return part === 'major' ? '1.0.0' : part === 'minor' ? '0.1.0' : '0.0.1';
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return part === 'major' ? `${maj + 1}.0.0` : part === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

export const isVersion = (v: string) => /^\d+\.\d+\.\d+$/.test(v);

/**
 * A technical hint for the version part, from the model-level changes. It cannot judge whether a mapping or script
 * change breaks a message format: the agent decides with the rules, the user confirms.
 */
export function suggestPart(before: IflowModel, after: IflowModel): { part: VersionPart; reasons: string[]; changes: string[] } {
  const changes = diffIflows(before, after);
  const reasons: string[] = [];
  const senders = (m: IflowModel) => new Map(m.adapters.filter((a) => a.direction === 'Sender').map((a) => [a.id, JSON.stringify(a)]));
  const [sa, sb] = [senders(before), senders(after)];
  const senderChanged = [...new Set([...sa.keys(), ...sb.keys()])].filter((id) => sa.get(id) !== sb.get(id));
  if (senderChanged.length) reasons.push(`sender adapter changed (${senderChanged.join(', ')}): callers may be affected`);
  if (reasons.length) return { part: 'major', reasons, changes };

  const added = changes.filter((l) => /^\+ (step|gateway|adapter|participant|event|subprocess|process) /.test(l));
  const removed = changes.filter((l) => /^- (step|gateway|adapter|event|subprocess|process) /.test(l));
  const newParams = after.externalizedParameters.filter((p) => !before.externalizedParameters.includes(p));
  if (added.length) reasons.push(`${added.length} element(s) added`);
  if (removed.length) reasons.push(`${removed.length} element(s) removed: check whether anyone relied on them (could be major)`);
  if (newParams.length) reasons.push(`new externalized parameter(s): ${newParams.join(', ')}`);
  if (reasons.length) return { part: 'minor', reasons, changes };
  return { part: 'patch', reasons: [changes.length ? 'settings, names, layout or file contents changed' : 'no model changes'], changes };
}

// ---------- changelog ----------

export const changelogPath = (iflowDir: string, iflowId: string) => join(dirname(iflowDir), `${iflowId}.CHANGELOG.md`);

export interface ChangelogEntry { version: string; date: string; user: string; comment: string }

/** Newest entry first, under a title */
export function appendChangelog(path: string, iflowId: string, e: ChangelogEntry) {
  const title = `# ${iflowId}: versions\n\nVersions pushed by cpi-saper-dev-mcp (the same comments are in Cloud Integration\'s version history).\n`;
  mkdirSync(dirname(path), { recursive: true });
  const old = existsSync(path) ? readFileSync(path, 'utf8').replace(/^# [^\n]*\n(\n[^#][^\n]*\n)?/, '') : '';
  writeFileSync(path, `${title}\n## ${e.version} — ${e.date}, ${e.user}\n${e.comment}\n${old.startsWith('\n') ? old : `\n${old}`}`.replace(/\n+$/, '\n'));
}

export function readChangelog(path: string, max = 5): ChangelogEntry[] {
  if (!existsSync(path)) return [];
  const out: ChangelogEntry[] = [];
  for (const m of readFileSync(path, 'utf8').matchAll(/^## (\S+) — (\S+), ([^\n]*)\n([^\n]*)/gm)) {
    out.push({ version: m[1]!, date: m[2]!, user: m[3]!, comment: m[4]! });
    if (out.length >= max) break;
  }
  return out;
}
