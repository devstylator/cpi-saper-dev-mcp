import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeUrl, NotLoggedIn, TokenStore, tokenUser, userTokenProvider, waitForCode } from '../dist/index.js';

const KEY = { clientid: 'sb-x!b1|it!b2', clientsecret: 's', url: 'https://t.example.com', tokenurl: 'https://sub.authentication.example.com/oauth/token' };
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const store = () => new TokenStore(join(mkdtempSync(join(tmpdir(), 'cpi-login-')), 'tokens', 't.json'));

test('authorize URL: the key\'s authorizationurl, else next to the token endpoint', () => {
  const derived = new URL(authorizeUrl(KEY, 8765, 'st'));
  assert.equal(`${derived.origin}${derived.pathname}`, 'https://sub.authentication.example.com/oauth/authorize');
  assert.deepEqual(Object.fromEntries(derived.searchParams), {
    response_type: 'code', client_id: 'sb-x!b1|it!b2', redirect_uri: 'http://localhost:8765/callback', state: 'st',
  });
  assert.match(authorizeUrl({ ...KEY, authorizationurl: 'https://idp.example.com/oauth/authorize' }, 9000, 'x'), /^https:\/\/idp\.example\.com\/oauth\/authorize\?/);
});

test('callback: code with the right state; wrong state and cancel are refused and free the port', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const ok = waitForCode(port, 'good', 5000);
  const res = await fetch(`http://localhost:${port}/callback?code=C1&state=good`);
  assert.equal(res.status, 200);
  assert.equal(await ok.code, 'C1');

  const bad = waitForCode(port, 'good', 5000);
  assert.equal((await fetch(`http://localhost:${port}/callback?code=C2&state=evil`)).status, 400);
  await assert.rejects(bad.code, /state mismatch/);

  const cancelled = waitForCode(port, 'x', 5000);
  cancelled.cancel();
  await assert.rejects(cancelled.code, /cancelled/);
  const again = waitForCode(port, 'y', 5000); // port free again
  again.cancel();
  await assert.rejects(again.code, /cancelled/);
});

test('token store: file readable only by the user; refresh token or access token until expiry', () => {
  const s = store();
  s.write({ accessToken: jwt({ user_name: 'u@example.com', email: 'u@example.com' }), expires: Date.now() + 3600_000 });
  const path = (s as unknown as { path: string }).path;
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const kept = s.read()!;
  assert.equal(kept.email, 'u@example.com');
  assert.ok(kept.accessToken && kept.expires && !kept.refreshToken);
  s.write({ accessToken: jwt({}), expires: 0, refreshToken: 'R' });
  assert.deepEqual([s.read()!.refreshToken, s.read()!.accessToken], ['R', undefined], 'with a refresh token only that is kept');
});

test('provider: stored token while valid; expired or missing login asks for cpi_login', async () => {
  const s = store();
  await assert.rejects(userTokenProvider(KEY, s, 'trial')(), (e: Error) => e instanceof NotLoggedIn && /call cpi_login first/.test(e.message));
  const token = jwt({ email: 'u@example.com' });
  s.write({ accessToken: token, expires: Date.now() + 3600_000 });
  assert.equal(await userTokenProvider(KEY, s, 'trial')(), token);
  s.write({ accessToken: token, expires: Date.now() - 1000 });
  await assert.rejects(userTokenProvider(KEY, s, 'trial')(), /has expired: call cpi_login again/);
  assert.equal(s.read(), undefined, 'expired login removed');
  assert.deepEqual(tokenUser(jwt({ user_name: 'a', email: 'b' })), { user: 'a', email: 'b' });
  assert.deepEqual(tokenUser('not-a-jwt'), {});
});
