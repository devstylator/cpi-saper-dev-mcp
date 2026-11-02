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

// ---------- number ranges (global; used by number range steps) ----------

export interface NumberRangeInfo {
  name: string; description?: string; min: string; max: string; current: string; fieldLength?: string; rotate: boolean; deployedBy?: string; deployedOn?: string;
}
export interface NumberRangeInput { description?: string; min?: string; max?: string; current?: string; fieldLength?: string; rotate?: boolean }

const toRange = (r: Row): NumberRangeInfo => ({
  name: String(r.Name), ...(str(r.Description) ? { description: str(r.Description)! } : {}),
  min: String(r.MinValue ?? ''), max: String(r.MaxValue ?? ''), current: String(r.CurrentValue ?? ''), ...(str(r.FieldLength) ? { fieldLength: str(r.FieldLength)! } : {}),
  rotate: String(r.Rotate) === 'true', ...(str(r.DeployedBy) ? { deployedBy: str(r.DeployedBy)! } : {}), ...(iso(r.DeployedOn) ? { deployedOn: iso(r.DeployedOn)! } : {}),
});

export async function listNumberRanges(client: CpiClient): Promise<NumberRangeInfo[]> {
  return (await client.odata<Row[]>('GET', '/NumberRanges')).map(toRange);
}

/** Check a range's numbers: whole numbers, min <= current <= max, and within the field length when given */
export function checkNumberRange(r: { min: string; max: string; current: string; fieldLength?: string }) {
  for (const [k, v] of Object.entries({ min: r.min, max: r.max, current: r.current })) if (!/^\d+$/.test(v)) throw new Error(`${k} "${v}" is not a whole number`);
  const [min, max, cur] = [BigInt(r.min), BigInt(r.max), BigInt(r.current)];
  if (min > max) throw new Error(`min ${r.min} is above max ${r.max}`);
  if (cur < min || cur > max) throw new Error(`current ${r.current} is outside ${r.min}..${r.max}`);
  if (r.fieldLength && (!/^\d+$/.test(r.fieldLength) || r.max.length > Number(r.fieldLength))) throw new Error(`max ${r.max} does not fit in field length ${r.fieldLength}`);
}

const rangeBody = (name: string, r: NumberRangeInfo) => ({
  Name: name, Description: r.description ?? '', MinValue: r.min, MaxValue: r.max, CurrentValue: r.current, FieldLength: r.fieldLength ?? '', Rotate: r.rotate ? 'true' : 'false',
});

/**
 * The range after a create (old missing: needs max; min defaults to 0, current to min) or an update (what is not
 * given stays), checked before anything is sent.
 */
export function planNumberRange(name: string, r: NumberRangeInput, old?: NumberRangeInfo): NumberRangeInfo {
  const base: NumberRangeInfo = old ?? { name, min: r.min ?? '0', max: '', current: r.current ?? r.min ?? '0', rotate: false };
  const next: NumberRangeInfo = {
    ...base, ...(r.description !== undefined ? { description: r.description } : {}), ...(r.min !== undefined ? { min: r.min } : {}), ...(r.max !== undefined ? { max: r.max } : {}),
    ...(r.current !== undefined ? { current: r.current } : {}), ...(r.fieldLength !== undefined ? { fieldLength: r.fieldLength } : {}), ...(r.rotate !== undefined ? { rotate: r.rotate } : {}),
  };
  if (!next.max) throw new Error('a new number range needs max');
  // the tenant refuses an empty field length (HTTP 500 "For input string", tester report): default to max's digits
  if (!next.fieldLength) next.fieldLength = String(next.max.length);
  checkNumberRange(next);
  return next;
}

export async function createNumberRange(client: CpiClient, r: NumberRangeInfo): Promise<void> {
  await client.odata('POST', '/NumberRanges', rangeBody(r.name, r));
}

export async function updateNumberRange(client: CpiClient, r: NumberRangeInfo): Promise<void> {
  await client.raw('PUT', `/NumberRanges('${q(r.name)}')`, { body: JSON.stringify(rangeBody(r.name, r)), headers: { 'Content-Type': 'application/json' } });
}

export async function deleteNumberRange(client: CpiClient, name: string): Promise<void> {
  await client.raw('DELETE', `/NumberRanges('${q(name)}')`);
}

// ---------- duplicate checks (idempotent repository: what was already processed) ----------

export interface DuplicateCheckEntry { source: string; entry: string; component?: string; createdAt?: string; expiresAt?: string; hexSource: string; hexEntry: string }
const epoch = (v: unknown) => (v !== null && v !== undefined && v !== '' ? new Date(Number(v)).toISOString() : undefined);

export async function listDuplicateChecks(client: CpiClient): Promise<DuplicateCheckEntry[]> {
  const rows = await client.odata<Row[]>('GET', '/IdempotentRepositoryEntries');
  return rows.map((r) => ({
    source: String(r.Source ?? ''), entry: String(r.Entry ?? ''), ...(str(r.Component) ? { component: str(r.Component)! } : {}),
    ...(epoch(r.CreationTime) ? { createdAt: epoch(r.CreationTime)! } : {}), ...(epoch(r.ExpirationTime) ? { expiresAt: epoch(r.ExpirationTime)! } : {}),
    hexSource: String(r.HexSource), hexEntry: String(r.HexEntry),
  }));
}

export async function deleteDuplicateCheck(client: CpiClient, e: { hexSource: string; hexEntry: string }): Promise<void> {
  await client.raw('DELETE', `/IdempotentRepositoryEntries(HexSource='${q(e.hexSource)}',HexEntry='${q(e.hexEntry)}')`);
}

// ---------- persisted messages (Persist steps), per message log ----------

export interface PersistedEntry { id: string; step: string; at?: string; hasAttachments: boolean }

export async function listPersisted(client: CpiClient, messageLogId: string): Promise<PersistedEntry[]> {
  const rows = await client.odata<Row[]>('GET', `/MessageProcessingLogs('${q(messageLogId)}')/MessageStoreEntries`).catch((e: unknown) => {
    if (e instanceof HttpError && e.status === 404) throw new Error(`message ${messageLogId} not found`);
    throw e;
  });
  return rows.map((r) => ({ id: String(r.Id), step: String(r.MessageStoreId ?? ''), ...(iso(r.TimeStamp) ? { at: iso(r.TimeStamp)! } : {}), hasAttachments: r.HasAttachments === true }));
}

/** A persisted message: the body as stored (measured: plain content) and its headers (the entry's properties) */
export async function getPersisted(client: CpiClient, id: string, { redact = redactor(), maxChars = 20000 } = {}) {
  const raw = new Uint8Array(await (await client.raw('GET', `/MessageStoreEntries('${q(id)}')/$value`)).arrayBuffer());
  const text = Buffer.from(raw).toString('utf8');
  const binary = /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 2000));
  const props = await client.odata<Row[]>('GET', `/MessageStoreEntries('${q(id)}')/Properties`).catch(() => [] as Row[]);
  return {
    bodySize: raw.length,
    body: binary ? `(binary, ${raw.length} bytes)` : text.length > maxChars ? `${text.slice(0, maxChars)}\n…(cut: ${text.length} characters)` : text,
    headers: Object.fromEntries(props.map((p) => [String(p.Name), redact(String(p.Name), String(p.Value ?? ''))])),
  };
}
