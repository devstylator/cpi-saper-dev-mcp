// Login as the user (OAuth authorization code grant) instead of the service key's technical client, so the tenant
// records the user ("Modified by", "Deployed by"). Needs a Process Integration Runtime service instance with
// "grant-types": ["authorization_code"] (plus "refresh_token" to stay logged in beyond one token's lifetime) and
// "redirect-uris": ["http://localhost:<port>/**"]. Grant types cannot be changed later: the broker refuses updates.
// Tokens are kept in a file only the user can read: the refresh token if the instance allows one, else the access
// token until it expires (the instance's token-validity, e.g. 12 hours).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServiceKey } from '../service-key.js';
import { HttpError } from './client.js';

export interface TokenSet { accessToken: string; expires: number; refreshToken?: string }
export interface LoggedInUser { user?: string; email?: string }

const CALLBACK = '/callback';
export const redirectUri = (port: number) => `http://localhost:${port}${CALLBACK}`;

/** The key's authorizationurl, else the XSUAA authorize endpoint next to the token endpoint */
export function authorizeUrl(key: ServiceKey, port: number, state: string): string {
  const u = new URL(key.authorizationurl ?? `${key.tokenurl.replace(/\/oauth\/token\/?$/, '')}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', key.clientid);
  u.searchParams.set('redirect_uri', redirectUri(port));
  u.searchParams.set('state', state);
  return u.toString();
}

export const newState = () => randomBytes(16).toString('hex');

/**
 * Listen on the local callback for the browser to come back with ?code=...&state=...; resolves with the code.
 * cancel() stops listening (frees the port) and rejects the promise. The promise rejects early when the port is busy.
 */
export function waitForCode(port: number, state: string, timeoutMs = 300_000): { code: Promise<string>; cancel: () => void } {
  let cancel = () => {};
  const code = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (u.pathname !== CALLBACK) { res.writeHead(404).end(); return; }
      const fail = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const ok = !fail && code && u.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(`<!doctype html><title>cpi-saper-dev-mcp</title><p>${ok ? 'Logged in. You can close this tab and return to your AI client.' : 'Login failed. You can close this tab.'}</p>`);
      finish(ok ? undefined : new Error(fail ? `login failed: ${fail} ${u.searchParams.get('error_description') ?? ''}`.trim() : 'login failed: unexpected callback (state mismatch)'), u.searchParams.get('code') ?? undefined);
    });
    const timer = setTimeout(() => finish(new Error(`no login within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    let done = false;
    const finish = (err?: Error, value?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err); else resolve(value!);
    };
    server.on('error', (e: NodeJS.ErrnoException) => finish(new Error(e.code === 'EADDRINUSE' ? `port ${port} is in use (another login still waiting?); set "loginPort" (and the instance's redirect-uris) to another one` : e.message)));
    cancel = () => finish(new Error('login cancelled'));
    server.listen(port, '127.0.0.1');
  });
  // a rejection nobody awaits (declined, timed out, cancelled) must not become an unhandled rejection, which would
  // end the server process; whoever awaits `code` still gets the error
  code.catch(() => {});
  return { code, cancel: () => cancel() };
}

async function tokenRequest(key: ServiceKey, form: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(key.tokenurl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${key.clientid}:${key.clientsecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError('POST', 'token endpoint', res.status, text.replace(/"(access|refresh|id)_token"\s*:\s*"[^"]*"/g, '"$1_token":"<hidden>"'));
  const json = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
  return { accessToken: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000, ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}) };
}

export const exchangeCode = (key: ServiceKey, code: string, port: number) =>
  tokenRequest(key, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(port) });

export const refreshTokens = (key: ServiceKey, refreshToken: string) =>
  tokenRequest(key, { grant_type: 'refresh_token', refresh_token: refreshToken });

/** Who a token belongs to (XSUAA claims); read for display only, not verified */
export function tokenUser(accessToken: string): LoggedInUser {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    return {
      ...(typeof claims.user_name === 'string' ? { user: claims.user_name } : {}),
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    };
  } catch {
    return {};
  }
}

// ---------- token store ----------

interface Stored { refreshToken?: string; accessToken?: string; expires?: number; user?: string; email?: string; loggedInAt: string }

/** Tokens per tenant in a file readable only by the user (mode 600) */
export class TokenStore {
  constructor(private readonly path: string) {}

  read(): Stored | undefined {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Stored) : undefined;
  }

  write(tokens: TokenSet) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const who = tokenUser(tokens.accessToken);
    // with a refresh token only that is kept (new access tokens come from it); without, the access token until it expires
    const keep = tokens.refreshToken ? { refreshToken: tokens.refreshToken } : { accessToken: tokens.accessToken, expires: tokens.expires };
    writeFileSync(this.path, `${JSON.stringify({ ...keep, ...who, loggedInAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  clear() {
    rmSync(this.path, { force: true });
  }
}

export class NotLoggedIn extends Error {}

/**
 * Access tokens for a user login: the stored access token while it is valid, else refreshed from the stored refresh
 * token (which rotates on every refresh). Throws NotLoggedIn when neither works: the user has to log in (cpi_login).
 */
export function userTokenProvider(key: ServiceKey, store: TokenStore, tenant: string): () => Promise<string> {
  let current: TokenSet | undefined;
  return async () => {
    if (current && current.expires > Date.now() + 60_000) return current.accessToken;
    const stored = store.read();
    if (!stored) throw new NotLoggedIn(`tenant "${tenant}" is configured for user login and nobody is logged in: call cpi_login first`);
    if (stored.accessToken && (stored.expires ?? 0) > Date.now() + 60_000) {
      current = { accessToken: stored.accessToken, expires: stored.expires! };
      return current.accessToken;
    }
    if (!stored.refreshToken) {
      store.clear();
      throw new NotLoggedIn(`the login for tenant "${tenant}" has expired: call cpi_login again`);
    }
    try {
      current = await refreshTokens(key, stored.refreshToken);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 401)) {
        store.clear();
        throw new NotLoggedIn(`the login for tenant "${tenant}" has expired: call cpi_login again`);
      }
      throw e;
    }
    if (current.refreshToken) store.write(current);
    return current.accessToken;
  };
}
