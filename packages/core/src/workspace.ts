// Local workspace: pulled iFlows live in <workspace>/<packageId>/<iflowId>/ with SAP's file layout inside.
// The tenant's zip of each pull is kept as the "pulled state" (<state>/<tenant>/<iflowId>.zip + .json): it protects
// local changes from being overwritten and is the base for "what changed since the pull".
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { parseIflw, type Document } from './iflow/model.js';

const RESOURCES = join('src', 'main', 'resources');
const FLOWS = join(RESOURCES, 'scenarioflows', 'integrationflow');

export interface LocatedIflow {
  /** folder of the exploded iFlow (contains META-INF/ and src/), if known */
  dir?: string;
  iflwPath: string;
  /** paths below src/main/resources, "/"-separated */
  resourceFiles?: Set<string>;
  declaredParameters?: Set<string>;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const posix = (p: string) => p.split(sep).join('/');

/**
 * Find an iFlow by folder, .iflw file, or iFlow id (looked up as <workspace>/<any package>/<id>/).
 * Relative paths are resolved against the workspace.
 */
export function locateIflow(target: string, workspace: string): LocatedIflow {
  const p = isAbsolute(target) ? target : resolve(workspace, target);
  if (existsSync(p) && statSync(p).isFile()) {
    if (!p.endsWith('.iflw')) throw new Error(`${target}: not an .iflw file`);
    return { iflwPath: p };
  }
  let dir = existsSync(p) ? p : undefined;
  if (!dir && !/[\\/]/.test(target) && existsSync(workspace)) {
    const hits = readdirSync(workspace).map((pkg) => join(workspace, pkg, target)).filter((d) => existsSync(join(d, FLOWS)));
    if (hits.length > 1) throw new Error(`iFlow "${target}" exists in several packages: ${hits.map((h) => relative(workspace, h)).join(', ')}`);
    dir = hits[0];
  }
  if (!dir) throw new Error(`iFlow "${target}" not found (as a path or as <package>/${target} in ${workspace}); pull it first`);
  const flows = join(dir, FLOWS);
  const iflws = existsSync(flows) ? walk(flows).filter((f) => f.endsWith('.iflw')) : [];
  if (iflws.length !== 1) throw new Error(`${dir}: expected exactly one .iflw under ${FLOWS}, found ${iflws.length}`);
  const res = join(dir, RESOURCES);
  const propdef = join(res, 'parameters.propdef');
  return {
    dir,
    iflwPath: iflws[0]!,
    resourceFiles: new Set(walk(res).map((f) => posix(relative(res, f)))),
    ...(existsSync(propdef)
      ? { declaredParameters: new Set([...readFileSync(propdef, 'utf8').matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]!)) }
      : {}),
  };
}

export function readIflow(located: LocatedIflow): Document {
  return parseIflw(readFileSync(located.iflwPath, 'utf8'));
}

// ---------- pulled state ----------

export interface PulledState { tenant: string; iflowId: string; packageId: string; version?: string; pulledAt: string; dir: string }

export class Workspace {
  constructor(readonly root: string, readonly stateDir: string) {}

  iflowDir(packageId: string, iflowId: string): string {
    return join(this.root, safeName(packageId), safeName(iflowId));
  }

  private statePaths(tenant: string, iflowId: string) {
    const base = join(this.stateDir, safeName(tenant), safeName(iflowId));
    return { zip: `${base}.zip`, meta: `${base}.json` };
  }

  pulledState(tenant: string, iflowId: string): { state: PulledState; zip: Uint8Array } | undefined {
    const { zip, meta } = this.statePaths(tenant, iflowId);
    if (!existsSync(zip) || !existsSync(meta)) return undefined;
    return { state: JSON.parse(readFileSync(meta, 'utf8')) as PulledState, zip: new Uint8Array(readFileSync(zip)) };
  }

  /** Pulled-state records (meta files) of a local iFlow folder, from any tenant */
  private recordsFor(dir: string): { state: PulledState; meta: string }[] {
    if (!existsSync(this.stateDir)) return [];
    const out: { state: PulledState; meta: string }[] = [];
    for (const tenant of readdirSync(this.stateDir)) {
      const tdir = join(this.stateDir, tenant);
      if (!statSync(tdir).isDirectory()) continue;
      for (const f of readdirSync(tdir).filter((n) => n.endsWith('.json'))) {
        let st: Partial<PulledState>;
        try { st = JSON.parse(readFileSync(join(tdir, f), 'utf8')) as Partial<PulledState>; } catch { continue; }
        // only pulled-state records count (other JSON files may live here)
        if (typeof st.dir !== 'string' || typeof st.tenant !== 'string' || typeof st.iflowId !== 'string') continue;
        if (resolve(st.dir) === resolve(dir)) out.push({ state: st as PulledState, meta: join(tdir, f) });
      }
    }
    return out;
  }

  /**
   * The pulled state that belongs to a local iFlow folder: the record of the given tenant if there is one, else the
   * most recent pull (records left behind by a renamed tenant must not win over the current pull)
   */
  pulledStateFor(dir: string, tenant?: string): { state: PulledState; zip: Uint8Array } | undefined {
    const records = this.recordsFor(dir);
    const pick = records.find((r) => r.state.tenant === tenant)
      ?? records.sort((a, b) => String(b.state.pulledAt).localeCompare(String(a.state.pulledAt)))[0];
    return pick ? this.pulledState(pick.state.tenant, pick.state.iflowId) : undefined;
  }

  /** Store the zip and its record; records of the same folder from other tenants no longer describe it and are removed */
  private saveState(tenant: string, info: { iflowId: string; packageId: string; version?: string }, zip: Uint8Array, dir: string): PulledState {
    const { zip: zipPath, meta } = this.statePaths(tenant, info.iflowId);
    for (const r of this.recordsFor(dir)) {
      if (r.meta === meta) continue;
      rmSync(r.meta, { force: true });
      rmSync(r.meta.replace(/\.json$/, '.zip'), { force: true });
    }
    mkdirSync(dirname(zipPath), { recursive: true });
    writeFileSync(zipPath, zip);
    const state: PulledState = {
      tenant, iflowId: info.iflowId, packageId: info.packageId, ...(info.version ? { version: info.version } : {}),
      pulledAt: new Date().toISOString(), dir,
    };
    writeFileSync(meta, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  /** Record the tenant's current content as the pulled state without touching local files (after a push or save) */
  updatePulledState(tenant: string, info: { iflowId: string; packageId: string; version?: string }, zip: Uint8Array, dir: string): PulledState {
    return this.saveState(tenant, info, zip, dir);
  }

  /**
   * Write a downloaded iFlow into its folder. Refuses to overwrite local changes (files that differ from the
   * previous pull, or a folder that was not pulled by this tool) unless overwrite is set.
   */
  pull(tenant: string, info: { iflowId: string; packageId: string; version?: string }, zip: Uint8Array, { overwrite = false } = {}) {
    const dir = this.iflowDir(info.packageId, info.iflowId);
    const files = unzipEntries(zip);
    const previous = this.pulledState(tenant, info.iflowId);
    if (existsSync(dir) && readdirSync(dir).length && !overwrite) {
      if (!previous) throw new Error(`${dir} already exists and was not pulled by this tool; set overwrite to replace it`);
      const changed = localChanges(dir, previous.zip);
      if (changed.length) {
        throw new Error(`${dir} has local changes since the last pull (${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', …' : ''}); ` +
          'commit or save them elsewhere, or set overwrite to discard them');
      }
    }
    // files of the previous pull that the new version no longer has
    if (previous) {
      for (const name of Object.keys(unzipEntries(previous.zip))) if (!(name in files)) rmSync(join(dir, name), { force: true });
    }
    for (const [name, data] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
    const state = this.saveState(tenant, info, zip, dir);
    return { dir, files: Object.keys(files).sort(), state };
  }
}

// iFlow ids and package ids become folder names: keep them to one safe path segment
function safeName(s: string): string {
  if (!s || s === '.' || s === '..' || /[\\/\0]/.test(s)) throw new Error(`"${s}" cannot be used as a folder name`);
  return s;
}

/** Zip entries (files only) with names checked to stay inside the target folder */
export function unzipEntries(zip: Uint8Array): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(unzipSync(zip))) {
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) throw new Error(`unsafe zip entry: ${name}`);
    out[name] = data;
  }
  return out;
}

// .prop files carry a "#<date>" comment the tenant rewrites on every export
const comparable = (name: string, data: Uint8Array) =>
  name.endsWith('.prop') ? Buffer.from(data).toString('utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n') : Buffer.from(data);

/** Files added, changed or removed in a local folder compared with a pulled zip ("/"-separated paths) */
export function localChanges(dir: string, zip: Uint8Array): string[] {
  const base = unzipEntries(zip);
  const local = new Map(walk(dir).map((f) => [posix(relative(dir, f)), f]));
  const changed: string[] = [];
  for (const [name, data] of Object.entries(base)) {
    const f = local.get(name);
    if (!f) { changed.push(`${name} (deleted)`); continue; }
    const a = comparable(name, data), b = comparable(name, new Uint8Array(readFileSync(f)));
    if (typeof a === 'string' ? a !== b : !a.equals(b as Buffer)) changed.push(name);
  }
  for (const name of local.keys()) if (!(name in base)) changed.push(`${name} (new)`);
  return changed;
}

/** Files that differ between two zips of the same iFlow ("/"-separated; .prop timestamp comments ignored) */
export function zipChanges(base: Uint8Array, other: Uint8Array): string[] {
  const [a, b] = [unzipEntries(base), unzipEntries(other)];
  const changed: string[] = [];
  for (const [name, data] of Object.entries(a)) {
    const o = b[name];
    if (!o) { changed.push(`${name} (deleted)`); continue; }
    const x = comparable(name, data), y = comparable(name, o);
    if (typeof x === 'string' ? x !== y : !x.equals(y as Buffer)) changed.push(name);
  }
  for (const name of Object.keys(b)) if (!(name in a)) changed.push(`${name} (new)`);
  return changed;
}

/** The .iflw of a pulled zip, parsed */
export function iflowFromZip(zip: Uint8Array): Document {
  const entry = Object.entries(unzipEntries(zip)).find(([n]) => n.startsWith('src/main/resources/scenarioflows/integrationflow/') && n.endsWith('.iflw'));
  if (!entry) throw new Error('the pulled zip contains no .iflw');
  return parseIflw(Buffer.from(entry[1]).toString('utf8'));
}
