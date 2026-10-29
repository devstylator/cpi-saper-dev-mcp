import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CpiClient, HttpError, listIflows, mplIdOf, odataDate, odataErrorMessage, resolvePackage } from '../dist/index.js';

const KEY = { clientid: 'id', clientsecret: 'secret', url: 'https://tenant.example.com', tokenurl: 'https://auth.example.com/oauth/token' };

// Fake tenant: answers the token call and serves fixed OData rows; records request URLs
function fakeTenant(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === KEY.tokenurl) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    const path = url.replace(`${KEY.url}/api/v1`, '');
    const hit = Object.entries(routes).find(([p]) => path === p || path.startsWith(`${p}?`));
    if (!hit) return new Response('<error><message>Requested entity could not be found.</message></error>', { status: 404 });
    return new Response(JSON.stringify({ d: Array.isArray(hit[1]) ? { results: hit[1] } : hit[1] }));
  }) as typeof fetch;
  return { client: new CpiClient(KEY, impl), calls };
}

const PACKAGES = [
  { Id: 'Z01Claude', Name: 'Z01_Claude', Version: '1.0.0', Mode: 'EDIT_ALLOWED', ModifiedDate: '1793269609401' },
  { Id: 'SAPAdapter', Name: 'SAP Adapter', Mode: 'READ_ONLY' },
];

test('dates in all three measured forms', () => {
  assert.equal(odataDate('/Date(1793101377569)/')?.toISOString(), '2026-10-27T11:42:57.569Z');
  assert.equal(odataDate('2026-10-28T11:41:37.379')?.toISOString(), '2026-10-28T11:41:37.379Z', 'zone-less ISO is UTC');
  assert.equal(odataDate('1793269609401')?.toISOString(), '2026-10-29T10:26:49.401Z');
  assert.equal(odataDate('null'), undefined);
});

test('error messages from JSON and XML bodies; message log id from header or body', () => {
  assert.equal(odataErrorMessage('{"error":{"code":"Not Found","message":{"lang":"en","value":"not there"}}}'), 'not there');
  assert.equal(odataErrorMessage('<error xmlns="x"><code>Not Found</code><message xml:lang="en">gone</message></error>'), 'gone');
  assert.equal(new HttpError('GET', '/X', 404, '<error><message>gone</message></error>').message, 'GET /X -> HTTP 404: gone');
  assert.equal(mplIdOf(new Response('', { headers: { SAP_MessageProcessingLogID: 'AAA' } })), 'AAA');
  assert.equal(mplIdOf(new Response(''), 'Internal Server Error. The MPL ID for the failed message is : AGrh5i-z1S\nFor more'), 'AGrh5i-z1S');
});

test('options IntegrationPackages rejects ($select, $filter) are applied on the client', async () => {
  const { client, calls } = fakeTenant({ '/IntegrationPackages': PACKAGES, '/IntegrationRuntimeArtifacts': [] });
  const rows = await client.odata<Array<Record<string, unknown>>>('GET', '/IntegrationPackages', undefined, { select: ['Id'], where: { Name: 'Z01_Claude' } });
  assert.deepEqual(rows, [{ Id: 'Z01Claude' }]);
  assert.equal(calls.at(-1), `${KEY.url}/api/v1/IntegrationPackages`, 'no $select/$filter sent');
  await client.odata('GET', '/IntegrationRuntimeArtifacts', undefined, { select: ['Id', 'Status'], where: { Status: 'STARTED' } });
  assert.match(calls.at(-1)!, /\$select=Id,Status&\$filter=Status%20eq%20'STARTED'/, 'sent where supported');
});

test('packages resolve by Id or display name; iFlows carry their runtime status', async () => {
  const { client } = fakeTenant({
    '/IntegrationPackages': PACKAGES,
    "/IntegrationPackages('Z01Claude')/IntegrationDesigntimeArtifacts": [
      { Id: 'Flow1', Name: 'Flow 1', PackageId: 'Z01Claude', Version: '1.0.10', ModifiedAt: '1793269576111' },
      { Id: 'Flow2', Name: 'Flow 2', PackageId: 'Z01Claude', Version: 'Active' },
    ],
    '/IntegrationRuntimeArtifacts': [{ Id: 'Flow1', Version: '1.0.10', Status: 'STARTED', DeployedOn: '2026-10-28T11:41:37.379' }],
  });
  assert.equal((await resolvePackage(client, 'z01_claude')).id, 'Z01Claude');
  assert.equal((await resolvePackage(client, 'Z01Claude')).mode, 'EDIT_ALLOWED');
  await assert.rejects(resolvePackage(client, 'Nope'), /package "Nope" not found/);
  const flows = await listIflows(client, 'Z01Claude');
  assert.deepEqual(flows.map((f) => [f.id, f.version, f.runtime?.status ?? null]), [['Flow1', '1.0.10', 'STARTED'], ['Flow2', 'Active', null]]);
  assert.equal(flows[0]!.runtime?.deployedAt, '2026-10-28T11:41:37.379Z');
});
