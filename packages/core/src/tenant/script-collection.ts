// Script collections: Groovy and JavaScript files that iFlows of the same package can use as their script. Same
// lifecycle as an iFlow (design-time content as a zip, a version per upload labelled with Bundle-Version, deployed
// to the runtime on its own), with its own OData entity.
import { unzipSync, zipSync } from 'fflate';
import { CpiClient, HttpError, q } from './client.js';
import { runtimeArtifacts, type RuntimeInfo } from './read.js';
import { awaitDeployment, type DeployResult } from './write.js';

const sc = (id: string, version = 'active') => `/ScriptCollectionDesigntimeArtifacts(Id='${q(id)}',Version='${q(version)}')`;
type Row = Record<string, unknown>;

export interface ScriptCollectionInfo {
  id: string;
  name: string;
  packageId: string;
  version?: string;
  description?: string;
  /** null = not deployed */
  runtime: RuntimeInfo | null;
}

const toInfo = (r: Row, runtime: RuntimeInfo | null): ScriptCollectionInfo => ({
  id: String(r.Id), name: String(r.Name), packageId: String(r.PackageId), runtime,
  ...(r.Version ? { version: String(r.Version) } : {}), ...(r.Description ? { description: String(r.Description) } : {}),
});

export async function listScriptCollections(client: CpiClient, packageId: string): Promise<ScriptCollectionInfo[]> {
  const [rows, runtime] = await Promise.all([
    client.odata<Row[]>('GET', `/IntegrationPackages('${q(packageId)}')/ScriptCollectionDesigntimeArtifacts`),
    runtimeArtifacts(client),
  ]);
  return rows.map((r) => toInfo(r, runtime.get(String(r.Id)) ?? null));
}

export async function getScriptCollection(client: CpiClient, id: string): Promise<ScriptCollectionInfo> {
  const [row, runtime] = await Promise.all([
    client.odata<Row>('GET', sc(id)).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 404) throw new Error(`script collection "${id}" not found on the tenant`);
      throw e;
    }),
    runtimeArtifacts(client),
  ]);
  return toInfo(row, runtime.get(id) ?? null);
}

/** An empty script collection, as the designer creates one (version 1.0.0, no files) */
export async function createScriptCollection(client: CpiClient, packageId: string, id: string, name = id): Promise<void> {
  await client.odata('POST', '/ScriptCollectionDesigntimeArtifacts', { Id: id, Name: name, PackageId: packageId });
}

export async function downloadScriptCollection(client: CpiClient, id: string): Promise<Uint8Array> {
  return new Uint8Array(await (await client.raw('GET', `${sc(id)}/$value`)).arrayBuffer());
}

/** Upload the content as a new version (the entity has no comment field: comments go to the changelog only) */
export async function uploadScriptCollection(client: CpiClient, id: string, zip: Uint8Array): Promise<void> {
  const meta = await client.odata<Row>('GET', sc(id));
  await client.odata('PUT', sc(id), { Name: meta.Name, ArtifactContent: Buffer.from(zip).toString('base64') });
}

/**
 * The zip with another version number: Bundle-Version and the version the collection offers to iFlows
 * (Provide-Capability). The tenant labels the upload with Bundle-Version and wraps the manifest lines itself (measured).
 */
export function withCollectionVersion(zip: Uint8Array, version: string): Uint8Array {
  const files = unzipSync(zip);
  const m = files['META-INF/MANIFEST.MF'];
  if (!m) throw new Error('the script collection has no META-INF/MANIFEST.MF');
  const flat = Buffer.from(m).toString('utf8').replace(/\r?\n /g, '');
  const next = flat.replace(/^Bundle-Version:\s*\S+/m, `Bundle-Version: ${version}`)
    .replace(/(Provide-Capability: scriptcollection\.[^;\n]+;version:Version=")[^"]*"/, `$1${version}"`);
  files['META-INF/MANIFEST.MF'] = new Uint8Array(Buffer.from(next));
  return zipSync(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}

export async function deployScriptCollection(client: CpiClient, id: string, opts: { timeoutSeconds?: number; pollMs?: number } = {}): Promise<DeployResult> {
  const started = Date.now();
  await client.raw('POST', `/DeployScriptCollectionDesigntimeArtifact?Id='${q(id)}'&Version='active'`);
  return awaitDeployment(client, id, started, opts);
}

/** Delete the collection with its version history (cannot be undone) */
export async function deleteScriptCollection(client: CpiClient, id: string): Promise<void> {
  await client.raw('DELETE', sc(id));
}

/** Script files of a collection's zip (names under src/main/resources/script/) */
export function collectionScripts(zip: Uint8Array): string[] {
  return Object.keys(unzipSync(zip)).filter((n) => n.startsWith('src/main/resources/script/') && !n.endsWith('/'))
    .map((n) => n.slice('src/main/resources/script/'.length)).sort();
}
