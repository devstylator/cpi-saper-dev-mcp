// Script collection references of an iFlow: the manifest requirement the designer writes, local checks against a
// pulled collection in the same package folder, and the tenant check before a deploy.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  collectionScripts, downloadScriptCollection, getScriptCollection, scriptCollectionRefs, withCollectionRequirements,
  type CpiClient, type Document, type Issue, type LocatedIflow,
} from '@cpi-saper-dev-mcp/core';

const manifestOf = (located: LocatedIflow) => (located.dir ? join(located.dir, 'META-INF', 'MANIFEST.MF') : undefined);

/** Write the iFlow's Require-Capability for the collections its steps use; true when the manifest changed */
export function syncCollectionRequirements(located: LocatedIflow, doc: Document): boolean {
  const mf = manifestOf(located);
  if (!mf || !existsSync(mf)) return false;
  const old = readFileSync(mf, 'utf8');
  const ids = scriptCollectionRefs(doc).map((r) => r.collection);
  // nothing to do for an iFlow that never used a collection
  if (!ids.length && !/scriptcollection\./.test(old)) return false;
  const next = withCollectionRequirements(old, ids);
  if (next.replace(/\r?\n /g, '') === old.replace(/\r?\n /g, '')) return false;
  writeFileSync(mf, next);
  return true;
}

/** Local checks: the manifest names each collection; a collection pulled into the same package folder has the script */
export function collectionIssues(located: LocatedIflow, doc: Document): Issue[] {
  const refs = scriptCollectionRefs(doc);
  if (!refs.length || !located.dir) return [];
  const issues: Issue[] = [];
  const mf = manifestOf(located);
  const manifest = mf && existsSync(mf) ? readFileSync(mf, 'utf8').replace(/\r?\n /g, '') : '';
  const pkgDir = dirname(located.dir);
  for (const r of refs) {
    if (!manifest.includes(`scriptcollection.${r.collection};`)) {
      issues.push({ severity: 'warning', code: 'MISSING_REQUIREMENT', msg: `${r.step}: META-INF/MANIFEST.MF does not require script collection ${r.collection} (iflow_edit writes it)` });
    }
    const coll = join(pkgDir, r.collection);
    if (!existsSync(join(coll, 'META-INF', 'MANIFEST.MF'))) {
      issues.push({ severity: 'warning', code: 'COLLECTION_NOT_PULLED', msg: `${r.step}: script collection ${r.collection} is not in package folder ${basename(pkgDir)}; pull it (script_collection_pull) to check ${r.script}` });
    } else if (!existsSync(join(coll, 'src', 'main', 'resources', 'script', r.script))) {
      issues.push({ severity: 'error', code: 'MISSING_COLLECTION_SCRIPT', msg: `${r.step}: script collection ${r.collection} has no ${r.script}` });
    }
  }
  return issues;
}

/**
 * Before a deploy: each collection the iFlow's steps use must exist in the iFlow's package, have the script and be
 * deployed (otherwise the iFlow fails at runtime). Returns the problems, empty when all is well.
 */
export async function collectionProblems(client: CpiClient, doc: Document, packageId: string): Promise<string[]> {
  const problems: string[] = [];
  const byCollection = new Map<string, string[]>();
  for (const r of scriptCollectionRefs(doc)) byCollection.set(r.collection, [...(byCollection.get(r.collection) ?? []), r.script]);
  for (const [id, scripts] of byCollection) {
    const info = await getScriptCollection(client, id).catch(() => undefined);
    if (!info) { problems.push(`script collection ${id} does not exist on the tenant`); continue; }
    if (info.packageId !== packageId) problems.push(`script collection ${id} is in package ${info.packageId}; an iFlow can only use collections of its own package (${packageId})`);
    const have = new Set(collectionScripts(await downloadScriptCollection(client, id)));
    for (const s of scripts) if (!have.has(s)) problems.push(`script collection ${id} has no ${s}`);
    if (info.runtime?.status !== 'STARTED') problems.push(`script collection ${id} is not deployed${info.runtime ? ` (${info.runtime.status})` : ''}: deploy it first (script_collection_deploy)`);
    // the runtime runs the deployed version: scripts added since then are missing there
    else if (info.version && info.runtime.version && info.runtime.version !== info.version) {
      problems.push(`script collection ${id} runs version ${info.runtime.version}, the latest is ${info.version}: deploy it again (script_collection_deploy)`);
    }
  }
  return problems;
}
