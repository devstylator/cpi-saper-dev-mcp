// Read operations on the tenant: packages, iFlows with runtime status, artifact download.
import { CpiClient, HttpError, odataDate, q } from './client.js';

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v !== '' && v !== 'null' ? v : undefined);
const iso = (v: unknown) => odataDate(v)?.toISOString();

export interface PackageInfo {
  id: string;
  name: string;
  version?: string;
  shortText?: string;
  vendor?: string;
  /** EDIT_ALLOWED, or READ_ONLY for content delivered by SAP or partners */
  mode?: string;
  modifiedAt?: string;
  modifiedBy?: string;
}

const toPackage = (p: Row): PackageInfo => {
  const out: PackageInfo = { id: String(p.Id), name: String(p.Name) };
  const set = <K extends keyof PackageInfo>(k: K, v: PackageInfo[K] | undefined) => { if (v !== undefined) out[k] = v; };
  set('version', str(p.Version));
  set('shortText', str(p.ShortText));
  set('vendor', str(p.Vendor));
  set('mode', str(p.Mode));
  set('modifiedAt', iso(p.ModifiedDate));
  set('modifiedBy', str(p.ModifiedBy));
  return out;
};

export async function listPackages(client: CpiClient): Promise<PackageInfo[]> {
  return (await client.odata<Row[]>('GET', '/IntegrationPackages')).map(toPackage);
}

/**
 * Packages are addressed by Id only; the display name (what the user sees in the UI) gives 404.
 * Accepts either: exact Id first, then exact name, then case-insensitive name.
 */
export async function resolvePackage(client: CpiClient, idOrName: string): Promise<PackageInfo> {
  const all = await listPackages(client);
  const hits = [(p: PackageInfo) => p.id === idOrName, (p: PackageInfo) => p.name === idOrName, (p: PackageInfo) => p.name.toLowerCase() === idOrName.toLowerCase()]
    .map((test) => all.filter(test)).find((h) => h.length);
  if (!hits) throw new Error(`package "${idOrName}" not found (by Id or name)`);
  if (hits.length > 1) throw new Error(`package name "${idOrName}" is ambiguous: ${hits.map((p) => p.id).join(', ')}`);
  return hits[0]!;
}

export interface RuntimeInfo { status: string; version?: string; deployedAt?: string; deployedBy?: string }

export interface IflowInfo {
  id: string;
  name: string;
  packageId: string;
  /** design-time version; "Active" when the draft was changed without saving a version */
  version?: string;
  description?: string;
  modifiedAt?: string;
  modifiedBy?: string;
  /** null = not deployed */
  runtime: RuntimeInfo | null;
}

const toRuntime = (r: Row): RuntimeInfo => {
  const out: RuntimeInfo = { status: String(r.Status) };
  if (str(r.Version)) out.version = str(r.Version)!;
  if (iso(r.DeployedOn)) out.deployedAt = iso(r.DeployedOn)!;
  if (str(r.DeployedBy)) out.deployedBy = str(r.DeployedBy)!;
  return out;
};

const toIflow = (a: Row, runtime: RuntimeInfo | null): IflowInfo => {
  const out: IflowInfo = { id: String(a.Id), name: String(a.Name), packageId: String(a.PackageId), runtime };
  if (str(a.Version)) out.version = str(a.Version)!;
  if (str(a.Description)) out.description = str(a.Description)!;
  if (iso(a.ModifiedAt)) out.modifiedAt = iso(a.ModifiedAt)!;
  if (str(a.ModifiedBy)) out.modifiedBy = str(a.ModifiedBy)!;
  return out;
};

/** Deployed integration flows by id */
export async function runtimeArtifacts(client: CpiClient): Promise<Map<string, RuntimeInfo>> {
  const rows = await client.odata<Row[]>('GET', '/IntegrationRuntimeArtifacts');
  return new Map(rows.map((r) => [String(r.Id), toRuntime(r)]));
}

export async function listIflows(client: CpiClient, packageId: string): Promise<IflowInfo[]> {
  const [rows, runtime] = await Promise.all([
    client.odata<Row[]>('GET', `/IntegrationPackages('${q(packageId)}')/IntegrationDesigntimeArtifacts`),
    runtimeArtifacts(client),
  ]);
  return rows.map((a) => toIflow(a, runtime.get(String(a.Id)) ?? null));
}

export async function getIflow(client: CpiClient, id: string): Promise<IflowInfo> {
  const [row, runtime] = await Promise.all([
    client.odata<Row>('GET', `/IntegrationDesigntimeArtifacts(Id='${q(id)}',Version='active')`).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 404) throw new Error(`iFlow "${id}" not found on the tenant`);
      throw e;
    }),
    runtimeArtifacts(client),
  ]);
  return toIflow(row, runtime.get(id) ?? null);
}

/** The iFlow's design-time content as the tenant exports it (zip) */
export async function downloadIflow(client: CpiClient, id: string): Promise<Uint8Array> {
  const res = await client.raw('GET', `/IntegrationDesigntimeArtifacts(Id='${q(id)}',Version='active')/$value`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------- endpoints and security material ----------

export interface EndpointInfo { iflow: string; version?: string; protocol?: string; urls: Array<{ url: string; type?: string }> }

/** HTTP endpoints of the deployed iFlows (one entry per endpoint; an iFlow with several senders has several) */
export async function listEndpoints(client: CpiClient): Promise<EndpointInfo[]> {
  const rows = await client.odata<Row[]>('GET', '/ServiceEndpoints?$expand=EntryPoints');
  return rows.map((r) => {
    const eps = (r.EntryPoints as { results?: Row[] } | Row[] | undefined);
    const list = Array.isArray(eps) ? eps : eps?.results ?? [];
    return {
      iflow: String(r.Name), ...(str(r.Version) ? { version: str(r.Version)! } : {}), ...(str(r.Protocol) ? { protocol: str(r.Protocol)! } : {}),
      urls: list.map((e) => ({ url: String(e.Url), ...(str(e.Type) ? { type: str(e.Type)! } : {}) })),
    };
  });
}

export interface SecurityMaterial {
  keystore: Array<{ alias: string; type?: string; keyType?: string; keySize?: number; validFrom?: string; validUntil?: string; daysLeft?: number; subject?: string; issuer?: string; owner?: string; status?: string }>;
  userCredentials: Array<{ name: string; kind?: string; description?: string; deployedOn?: string; status?: string }>;
  oauth2Clients: Array<{ name: string; description?: string; tokenUrl?: string; authentication?: string; deployedOn?: string; status?: string }>;
  secureParameters: Array<{ name: string; description?: string; deployedOn?: string; status?: string }>;
}

/**
 * Names, types, validity and deploy status of the tenant's security material. Only listed fields are copied, so
 * passwords, client secrets, secure parameter values, user names and certificate content are never returned.
 */
export async function listSecurityMaterial(client: CpiClient, now = new Date()): Promise<SecurityMaterial> {
  const get = (set: string) => client.odata<Row[]>('GET', `/${set}`);
  const [keys, users, oauth, secure] = await Promise.all([get('KeystoreEntries'), get('UserCredentials'), get('OAuth2ClientCredentials'), get('SecureParameters')]);
  const descriptor = (r: Row) => (r.SecurityArtifactDescriptor ?? {}) as Row;
  const deployed = (d: Row) => ({ ...(iso(d.DeployedOn) ? { deployedOn: iso(d.DeployedOn)! } : {}), ...(str(d.Status) ? { status: str(d.Status)! } : {}) });
  const opt = (k: string, v: unknown) => (str(v) ? { [k]: str(v)! } : {});
  return {
    keystore: keys.map((r) => {
      const until = iso(r.ValidNotAfter);
      return {
        alias: String(r.Alias), ...opt('type', r.Type), ...opt('keyType', r.KeyType), ...(r.KeySize ? { keySize: Number(r.KeySize) } : {}),
        ...(iso(r.ValidNotBefore) ? { validFrom: iso(r.ValidNotBefore)! } : {}),
        ...(until ? { validUntil: until, daysLeft: Math.floor((Date.parse(until) - now.getTime()) / 86_400_000) } : {}),
        ...opt('subject', r.SubjectDN), ...opt('issuer', r.IssuerDN), ...opt('owner', r.Owner), ...opt('status', r.Status),
      };
    }),
    userCredentials: users.map((r) => ({ name: String(r.Name), ...opt('kind', r.Kind), ...opt('description', r.Description), ...deployed(descriptor(r)) })),
    oauth2Clients: oauth.map((r) => ({
      name: String(r.Name), ...opt('description', r.Description), ...opt('tokenUrl', r.TokenServiceUrl), ...opt('authentication', r.ClientAuthentication), ...deployed(descriptor(r)),
    })),
    secureParameters: secure.map((r) => ({ name: String(r.Name), ...opt('description', r.Description), ...deployed(r) })),
  };
}
