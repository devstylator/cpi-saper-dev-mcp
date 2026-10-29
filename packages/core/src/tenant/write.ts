// Operations that change a tenant: upload content, save a version, update one file, deploy, undeploy.
// Callers enforce the rules (role, allowed packages, confirmation, conflict and lock checks).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';
import { CpiClient, HttpError, odataDate, q } from './client.js';

const artifact = (id: string, version = 'active') => `/IntegrationDesigntimeArtifacts(Id='${q(id)}',Version='${q(version)}')`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Zip an exploded iFlow folder the way the tenant expects it ("/"-separated paths, sorted) */
export function zipFolder(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else files[relative(dir, p).split(sep).join('/')] = new Uint8Array(readFileSync(p));
    }
  };
  walk(dir);
  return zipSync(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}

export interface DesignLock { artifactId: string; artifactType?: string; lockedBy?: string; since?: string }

/** Edit locks the designer holds (an iFlow open in edit mode) */
export async function designLocks(client: CpiClient): Promise<DesignLock[]> {
  const rows = await client.odata<Array<Record<string, unknown>>>('GET', '/IntegrationDesigntimeLocks');
  return rows.map((l) => ({
    artifactId: String(l.ArtifactId),
    ...(l.ArtifactType ? { artifactType: String(l.ArtifactType) } : {}),
    ...(l.CreatedBy ? { lockedBy: String(l.CreatedBy) } : {}),
    ...(odataDate(l.CreatedAt) ? { since: odataDate(l.CreatedAt)!.toISOString() } : {}),
  }));
}

/** Replace the iFlow's design-time content with a zip */
export async function uploadIflow(client: CpiClient, id: string, zip: Uint8Array): Promise<void> {
  const meta = await client.odata<Record<string, unknown>>('GET', artifact(id));
  await client.odata('PUT', artifact(id), { Name: meta.Name, ArtifactContent: Buffer.from(zip).toString('base64') });
}

export async function saveVersion(client: CpiClient, id: string, version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version "${version}" must look like 1.0.11`);
  await client.raw('POST', `/IntegrationDesigntimeArtifactSaveAsVersion?Id='${q(id)}'&SaveAsVersion='${q(version)}'`);
}

export interface ResourceInfo { name: string; type: string }

export async function listResources(client: CpiClient, id: string): Promise<ResourceInfo[]> {
  const rows = await client.odata<Array<Record<string, unknown>>>('GET', `${artifact(id)}/Resources`);
  return rows.map((r) => ({ name: String(r.Name), type: String(r.ResourceType) }));
}

/**
 * Replace one resource file. The tenant addresses resources by file name only (a script in script/v2/ is listed
 * under its bare name), so the name must be unique among the iFlow's resources.
 */
export async function updateResource(client: CpiClient, id: string, name: string, content: Uint8Array): Promise<ResourceInfo> {
  const matches = (await listResources(client, id)).filter((r) => r.name === name);
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? `"${name}" exists ${matches.length} times on the tenant (e.g. a script and its v2 copy); upload the whole iFlow with cpi_push`
      : `"${name}" is not a resource of ${id} on the tenant; new files need cpi_push`);
  }
  const r = matches[0]!;
  await client.raw('PUT', `${artifact(id)}/$links/Resources(Name='${q(name)}',ResourceType='${q(r.type)}')`, {
    body: JSON.stringify({ ResourceContent: Buffer.from(content).toString('base64') }),
    headers: { 'Content-Type': 'application/json' },
  });
  return r;
}

export interface DeployResult {
  status: 'STARTED' | 'ERROR' | 'TIMEOUT' | string;
  version?: string;
  seconds: number;
  /** deploy error text (step ids as the tenant reports them) */
  error?: string;
}

/** Deploy the active design-time version and wait until the runtime reports the new deployment (or timeout) */
export async function deployIflow(client: CpiClient, id: string, { timeoutSeconds = 180, pollMs = 3000 } = {}): Promise<DeployResult> {
  const started = Date.now();
  await client.raw('POST', `/DeployIntegrationDesigntimeArtifact?Id='${q(id)}'&Version='active'`);
  for (;;) {
    const rt = await client.odata<Record<string, unknown>>('GET', `/IntegrationRuntimeArtifacts('${q(id)}')`)
      .catch((e: unknown) => (e instanceof HttpError && e.status === 404 ? null : Promise.reject(e)));
    const deployedOn = odataDate(rt?.DeployedOn);
    const fresh = deployedOn !== undefined && deployedOn.getTime() >= started - 5000;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (rt && fresh && rt.Status !== 'STARTING') {
      const result: DeployResult = { status: String(rt.Status), ...(rt.Version ? { version: String(rt.Version) } : {}), seconds };
      if (rt.Status === 'ERROR') result.error = await runtimeError(client, id);
      return result;
    }
    if (seconds >= timeoutSeconds) return { status: 'TIMEOUT', seconds, ...(rt ? { error: `last runtime status ${String(rt.Status)}` } : {}) };
    await sleep(pollMs);
  }
}

export async function runtimeError(client: CpiClient, id: string): Promise<string | undefined> {
  try {
    return (await (await client.raw('GET', `/IntegrationRuntimeArtifacts('${q(id)}')/ErrorInformation/$value`)).text()).slice(0, 4000);
  } catch {
    return undefined;
  }
}

export async function undeployIflow(client: CpiClient, id: string): Promise<void> {
  await client.raw('DELETE', `/IntegrationRuntimeArtifacts('${q(id)}')`);
}

// ---------- checks the designer runs before deploying (API deploys skip them) ----------

export interface GuidelineFinding {
  id: string; name: string; severity: string; compliance: string;
  violated?: string; actual?: string; fix?: string; skipped?: boolean; skipReason?: string;
}

/** SAP's design guideline check; the list must be read with $expand (the navigation alone fails with HTTP 400) */
export async function runGuidelines(client: CpiClient, id: string, version = 'active'): Promise<{ artifactVersion?: string; status?: string; findings: GuidelineFinding[] }> {
  const exec = (await (await client.raw('POST', `/ExecuteIntegrationDesigntimeArtifactsGuidelines?Id='${q(id)}'&Version='${q(version)}'`)).text()).trim().replace(/^"|"$/g, '');
  const r = await client.odata<Record<string, unknown> & { DesignGuidelines?: { results?: Array<Record<string, unknown>> } }>(
    'GET', `${artifact(id, version)}/DesignGuidelineExecutionResults('${q(exec)}')?$expand=DesignGuidelines`);
  const rank: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
  const findings = (r.DesignGuidelines?.results ?? []).map((g) => {
    const f: GuidelineFinding = { id: String(g.GuidelineId), name: String(g.GuidelineName), severity: String(g.Severity), compliance: String(g.Compliance) };
    if (g.ViolatedComponents) f.violated = String(g.ViolatedComponents);
    if (g.ActualKPI) f.actual = String(g.ActualKPI);
    if (g.ExpectedKPI) f.fix = String(g.ExpectedKPI);
    if (g.IsGuidelineSkipped) { f.skipped = true; if (g.SkipReason) f.skipReason = String(g.SkipReason); }
    return f;
  }).sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
  return { ...(r.ArtifactVersion ? { artifactVersion: String(r.ArtifactVersion) } : {}), ...(r.ExecutionStatus ? { status: String(r.ExecutionStatus) } : {}), findings };
}

/** The tenant's model validation ("Check for problems" in the designer) */
export async function checkModel(client: CpiClient, id: string, version = 'active'): Promise<{ status: number; text: string }> {
  const res = await client.raw('POST', `/ValidateIntegrationDesigntimeArtifact?Id='${q(id)}'&Version='${q(version)}'`);
  return { status: res.status, text: (await res.text()).slice(0, 3000) };
}
