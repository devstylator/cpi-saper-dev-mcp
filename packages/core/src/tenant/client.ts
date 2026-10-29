// Client for the Cloud Integration OData API (service key plan "api") and for deployed HTTP endpoints
// (plan "integration-flow"). Error messages contain HTTP status and the API's own message, never key values.
import type { ServiceKey } from '../service-key.js';

/**
 * OData error bodies come as JSON on most entity sets and as XML on others (measured: 404 on
 * IntegrationRuntimeArtifacts), whatever the Accept header says. Returns the message text, if any.
 */
export function odataErrorMessage(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const v = (JSON.parse(body) as { error?: { message?: { value?: string } } })?.error?.message?.value;
    if (v) return v;
  } catch { /* not JSON */ }
  return body.match(/<message[^>]*>([\s\S]*?)<\/message>/)?.[1]?.trim();
}

export class HttpError extends Error {
  readonly odataMessage: string | undefined;
  constructor(method: string, url: string, readonly status: number, readonly body: string) {
    const msg = odataErrorMessage(body);
    super(`${method} ${url} -> HTTP ${status}${msg ? `: ${msg}` : body ? `\n${body.slice(0, 2000)}` : ''}`);
    this.odataMessage = msg;
  }
}

/**
 * HTTP endpoints of deployed iFlows: the message log id is in the SAP_MessageProcessingLogID header on success,
 * but failed calls carry it only in the body text ("The MPL ID for the failed message is : <id>").
 */
export function mplIdOf(res: Response, body = ''): string | undefined {
  return res.headers.get('sap_messageprocessinglogid') ?? body.match(/MPL ID for the failed message is\s*:\s*([A-Za-z0-9_-]+)/)?.[1];
}

/** OData key predicate value: single quotes doubled, then URL-encoded */
export const q = (v: string) => encodeURIComponent(v.replace(/'/g, "''"));

/**
 * Dates come in three forms (measured): "/Date(1698765432000)/" (message logs), a zone-less ISO string in UTC
 * (IntegrationRuntimeArtifacts.DeployedOn) and epoch milliseconds as text (package and artifact Created/Modified).
 */
export function odataDate(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = v.match(/\/Date\((\d+)/) ?? v.match(/^(\d{11,})$/);
  if (ms) return new Date(Number(ms[1]));
  if (/^\d{4}-\d\d-\d\dT[\d:.]+$/.test(v)) return new Date(`${v}Z`);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Query options the OData API rejects with HTTP 501 per entity set (measured 2026-10-28 on a trial tenant).
// odata() emulates them on the client.
const UNSUPPORTED: Record<string, Set<string>> = {
  IntegrationPackages: new Set(['select', 'filter', 'inlinecount']),
  IntegrationDesigntimeArtifacts: new Set(['filter']),
};

export interface QueryOptions {
  select?: string[];
  /** equality filter: { Field: value } */
  where?: Record<string, string>;
  orderby?: string;
  top?: number;
  skip?: number;
}

type Row = Record<string, unknown>;

export class CpiClient {
  private token: { value: string; expires: number } | undefined;
  private csrf: string | undefined;
  private cookies = '';

  /** tokenProvider: tokens of a user login (authorization code grant); default: the key's client credentials */
  constructor(readonly key: ServiceKey, private readonly fetchImpl: typeof fetch = fetch, private readonly tokenProvider?: () => Promise<string>) {}

  async bearer(): Promise<string> {
    if (this.tokenProvider) return this.tokenProvider();
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(this.key.tokenurl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.key.clientid}:${this.key.clientsecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new HttpError('POST', 'token endpoint', res.status, await res.text());
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  // Modifying calls go first without a CSRF token (bearer tokens usually need none); on
  // "403 + x-csrf-token: Required" a token is fetched once and the call repeated. The token comes from the API root,
  // or, for an iFlow endpoint (an HTTPS sender with CSRF protection), from that endpoint itself.
  async request(method: string, url: string, { body, headers = {} }: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
    const send = async () => this.fetchImpl(url, {
      method,
      ...(body !== undefined ? { body } : {}),
      headers: {
        Authorization: `Bearer ${await this.bearer()}`,
        Accept: 'application/json',
        ...(this.csrf && method !== 'GET' ? { 'X-CSRF-Token': this.csrf, Cookie: this.cookies } : {}),
        ...headers,
      },
    });
    let res = await send();
    if (res.status === 403 && method !== 'GET' && /required/i.test(res.headers.get('x-csrf-token') ?? '')) {
      await this.fetchCsrf(url.startsWith(this.api('')) ? this.api('/') : url);
      res = await send();
    }
    return res;
  }

  private async fetchCsrf(from: string) {
    const res = await this.fetchImpl(from, {
      headers: { Authorization: `Bearer ${await this.bearer()}`, 'X-CSRF-Token': 'Fetch' },
    });
    this.csrf = res.headers.get('x-csrf-token') ?? undefined;
    this.cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }

  api(path: string): string {
    return `${this.key.url}/api/v1${path}`;
  }

  /**
   * JSON call against /api/v1; returns the OData "d" payload (results array for collections). Query options an
   * entity set does not support are applied on the client instead.
   */
  async odata<T = Row>(method: string, path: string, body?: unknown, { select, where, orderby, top, skip }: QueryOptions = {}): Promise<T> {
    const set = path.match(/^\/(\w+)/)?.[1] ?? '';
    const server = (opt: string) => !UNSUPPORTED[set]?.has(opt);
    const params: string[] = [];
    if (select && server('select')) params.push(`$select=${select.join(',')}`);
    if (where && server('filter')) {
      params.push(`$filter=${encodeURIComponent(Object.entries(where).map(([k, v]) => `${k} eq '${v.replace(/'/g, "''")}'`).join(' and '))}`);
    }
    if (orderby) params.push(`$orderby=${encodeURIComponent(orderby)}`);
    // with a client-side filter, paging must happen after filtering
    const pageOnServer = !(where && !server('filter'));
    if (top !== undefined && pageOnServer) params.push(`$top=${top}`);
    if (skip !== undefined && pageOnServer) params.push(`$skip=${skip}`);
    if (params.length) path += `${path.includes('?') ? '&' : '?'}${params.join('&')}`;

    let result = await this.odataRaw(method, path, body);
    if (Array.isArray(result)) {
      if (where && !server('filter')) {
        result = (result as Row[]).filter((r) => Object.entries(where).every(([k, v]) => String(r[k]) === v));
        result = (result as Row[]).slice(skip ?? 0, top === undefined ? undefined : (skip ?? 0) + top);
      }
      if (select && !server('select')) result = (result as Row[]).map((r) => Object.fromEntries(select.map((f) => [f, r[f]])));
    }
    return result as T;
  }

  private async odataRaw(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.request(method, this.api(path), {
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(method, path, res.status, text);
    if (!text) return null;
    const json = JSON.parse(text) as { d?: { results?: unknown } & Record<string, unknown> };
    return json?.d?.results ?? json?.d ?? json;
  }

  /** Raw call against /api/v1 (zip downloads, $value texts, function imports); throws HttpError on failure */
  async raw(method: string, path: string, opts?: { body?: BodyInit; headers?: Record<string, string> }): Promise<Response> {
    const res = await this.request(method, this.api(path), opts);
    if (!res.ok) throw new HttpError(method, path, res.status, await res.text());
    return res;
  }
}
