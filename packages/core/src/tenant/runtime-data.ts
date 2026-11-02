// Runtime data the iFlows keep on the tenant: data stores (Write/Get/Select steps) and variables (Write Variables).
// Local ones belong to one iFlow, global ones to the tenant; the API keys them by name and iFlow ('' when global).
import { CpiClient, HttpError, odataDate, q } from './client.js';
import { readProp } from '../params.js';
import { unzipEntries } from '../workspace.js';
import { redactor } from './monitor.js';

type Row = Record<string, unknown>;
const iso = (v: unknown) => odataDate(v)?.toISOString();
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

export interface DataStoreRef { name: string; iflow: string; type: string }
export interface DataStoreInfo extends DataStoreRef { global: boolean; entries: number; overdue: number }
export interface DataStoreEntryInfo { id: string; status?: string; messageLogId?: string; dueAt?: string; createdAt?: string; retainUntil?: string }

const storeKey = (s: DataStoreRef) => `DataStoreName='${q(s.name)}',IntegrationFlow='${q(s.iflow)}',Type='${q(s.type)}'`;

export async function listDataStores(client: CpiClient): Promise<DataStoreInfo[]> {
  const rows = await client.odata<Row[]>('GET', '/DataStores');
  return rows.map((r) => ({
    name: String(r.DataStoreName), iflow: String(r.IntegrationFlow ?? ''), type: String(r.Type ?? ''),
    global: String(r.Visibility ?? '') === 'Global' || !str(r.IntegrationFlow),
    entries: Number(r.NumberOfMessages ?? 0), overdue: Number(r.NumberOfOverdueMessages ?? 0),
  }));
}

/** The store meant by its name, and its iFlow when several iFlows have a local store of that name */
export async function findDataStore(client: CpiClient, name: string, iflow?: string): Promise<DataStoreInfo> {
  const all = (await listDataStores(client)).filter((s) => s.name === name && (iflow === undefined || s.iflow === iflow || (iflow === '' && s.global)));
  if (all.length === 1) return all[0]!;
  if (!all.length) throw new Error(`no data store "${name}"${iflow ? ` of iFlow ${iflow}` : ''} (a store exists once something was written to it)`);
  throw new Error(`"${name}" is a data store of several iFlows (${all.map((s) => s.iflow || 'global').join(', ')}); pass iflow`);
}

export async function listDataStoreEntries(client: CpiClient, store: DataStoreRef): Promise<DataStoreEntryInfo[]> {
  const rows = await client.odata<Row[]>('GET', `/DataStores(${storeKey(store)})/Entries`);
  return rows.map((r) => ({
    id: String(r.Id), ...(str(r.Status) ? { status: str(r.Status)! } : {}), ...(str(r.MessageId) ? { messageLogId: str(r.MessageId)! } : {}),
    ...(iso(r.DueAt) ? { dueAt: iso(r.DueAt)! } : {}), ...(iso(r.CreatedAt) ? { createdAt: iso(r.CreatedAt)! } : {}), ...(iso(r.RetainUntil) ? { retainUntil: iso(r.RetainUntil)! } : {}),
  }));
}

/** An entry's stored message: the tenant returns a zip with "body" and "headers.prop" (measured) */
export async function getDataStoreEntry(client: CpiClient, store: DataStoreRef, id: string, { redact = redactor(), maxChars = 20000 } = {}) {
  const res = await client.raw('GET', `/DataStoreEntries(Id='${q(id)}',${storeKey(store)})/$value`).catch((e: unknown) => {
    if (e instanceof HttpError && e.status === 404) throw new Error(`data store ${store.name} has no entry "${id}"`);
    throw e;
  });
  const files = unzipEntries(new Uint8Array(await res.arrayBuffer()));
  const raw = files.body ?? new Uint8Array();
  const text = Buffer.from(raw).toString('utf8');
  const binary = /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 2000));
  const headers = Object.fromEntries([...readProp(files['headers.prop'] ? Buffer.from(files['headers.prop']).toString('utf8') : '')].map(([k, v]) => [k, redact(k, v)]));
  return {
    bodySize: raw.length,
    body: binary ? `(binary, ${raw.length} bytes)` : text.length > maxChars ? `${text.slice(0, maxChars)}\n…(cut: ${text.length} characters)` : text,
    headers,
  };
}

export async function deleteDataStoreEntry(client: CpiClient, store: DataStoreRef, id: string): Promise<void> {
  await client.raw('DELETE', `/DataStoreEntries(Id='${q(id)}',${storeKey(store)})`);
}

/** Delete the store with all its entries */
export async function deleteDataStore(client: CpiClient, store: DataStoreRef): Promise<void> {
  await client.raw('DELETE', `/DataStores(${storeKey(store)})`);
}

export interface VariableInfo { name: string; iflow: string; global: boolean; updatedAt?: string; retainUntil?: string }

export async function listVariables(client: CpiClient): Promise<VariableInfo[]> {
  const rows = await client.odata<Row[]>('GET', '/Variables');
  return rows.map((r) => ({
    name: String(r.VariableName), iflow: String(r.IntegrationFlow ?? ''), global: String(r.Visibility ?? '') === 'Global' || !str(r.IntegrationFlow),
    ...(iso(r.UpdatedAt) ? { updatedAt: iso(r.UpdatedAt)! } : {}), ...(iso(r.RetainUntil) ? { retainUntil: iso(r.RetainUntil)! } : {}),
  }));
}

/** The variable meant by its name, and its iFlow when several iFlows have a local variable of that name */
export async function findVariable(client: CpiClient, name: string, iflow?: string): Promise<VariableInfo> {
  const all = (await listVariables(client)).filter((v) => v.name === name && (iflow === undefined || v.iflow === iflow || (iflow === '' && v.global)));
  if (all.length === 1) return all[0]!;
  if (!all.length) throw new Error(`no variable "${name}"${iflow ? ` of iFlow ${iflow}` : ''}`);
  throw new Error(`"${name}" is a variable of several iFlows (${all.map((v) => v.iflow || 'global').join(', ')}); pass iflow`);
}

const varKey = (v: { name: string; iflow: string }) => `VariableName='${q(v.name)}',IntegrationFlow='${q(v.iflow)}'`;

/**
 * A variable's value. The tenant returns a zip with headers.prop (measured): the value under the variable's name,
 * next to the message ids of the run that wrote it.
 */
export async function getVariableValue(client: CpiClient, v: { name: string; iflow: string }): Promise<string> {
  const buf = new Uint8Array(await (await client.raw('GET', `/Variables(${varKey(v)})/$value`)).arrayBuffer());
  const prop = unzipEntries(buf)['headers.prop'];
  const value = prop ? readProp(Buffer.from(prop).toString('utf8')).get(v.name) : undefined;
  if (value === undefined) throw new Error(`variable ${v.name}: the tenant returned no value for it`);
  return value;
}

export async function deleteVariable(client: CpiClient, v: { name: string; iflow: string }): Promise<void> {
  await client.raw('DELETE', `/Variables(${varKey(v)})`);
}
