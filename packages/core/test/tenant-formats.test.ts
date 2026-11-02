// Responses as a Cloud Integration tenant sent them (recorded on a trial tenant, names made generic), replayed by a
// fake tenant: the parsing and the requests the code sends must keep matching what the tenant does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import {
  bytesText, CpiClient, createNumberRange, deleteQueueMessage, deployErrorList, getConfigurations, getDataStoreEntry, getPersisted, getVariableValue,
  listDataStores, listQueueMessages, listQueues, moveQueueMessages, planNumberRange, retryQueueMessages, setConfiguration,
} from '../dist/index.js';

const KEY = { clientid: 'id', clientsecret: 'secret', url: 'https://tenant.example.com', tokenurl: 'https://auth.example.com/oauth/token' };
type Reply = unknown | { raw: Uint8Array | string; type?: string };

/** A tenant answering by "METHOD path" (query ignored); records every request with its body */
function tenant(routes: Record<string, Reply>) {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === KEY.tokenurl) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    const method = init?.method ?? 'GET';
    const path = url.replace(`${KEY.url}/api/v1`, '').split('?')[0]!;
    calls.push({ method, path, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (method === 'GET' && path === '/') return new Response('', { headers: { 'x-csrf-token': 'csrf' } });
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return new Response('not found', { status: 404 });
    if (hit && typeof hit === 'object' && 'raw' in (hit as object)) {
      const r = hit as { raw: Uint8Array | string; type?: string };
      return new Response(r.raw, { headers: { 'content-type': r.type ?? 'application/octet-stream' } });
    }
    return new Response(JSON.stringify({ d: Array.isArray(hit) ? { results: hit } : hit }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new CpiClient(KEY, impl), calls };
}
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])));
const sent = (calls: Array<{ method: string; path: string; body?: string }>, method: string) => calls.filter((c) => c.method === method);

test('deploy error: the tenant\'s JSON (GenerationFailed) as one line per problem', () => {
  const recorded = '{"message":{"subsystemName":"CONTENT","subsytemPartName":"CONTENT_DEPLOY","messageId":"GenerationFailed","messageText":""},"parameter":["The generation and build of the artifact were unsuccessful. Please address the issues outlined below and redeploy the artifact.\\nGeneration and build failed for DeployFail as validation of resource is failed\\nXPath is not defined for Splitter step\\nAttribute \'XPath Expression\' is mandatory"]}';
  assert.deepEqual(deployErrorList(recorded), [
    'The generation and build of the artifact were unsuccessful. Please address the issues outlined below and redeploy the artifact.',
    'Generation and build failed for DeployFail as validation of resource is failed',
    'XPath is not defined for Splitter step',
    "Attribute 'XPath Expression' is mandatory",
  ]);
});

test('data stores: list (local and global), an entry as zip with body and headers.prop', async () => {
  const key = "DataStoreName='Orders',IntegrationFlow='Flow',Type=''";
  const { client } = tenant({
    'GET /DataStores': [
      { DataStoreName: 'Orders', IntegrationFlow: 'Flow', Type: '', Visibility: 'Integration Flow', NumberOfMessages: '2', NumberOfOverdueMessages: '0' },
      { DataStoreName: 'Shared', IntegrationFlow: '', Type: '', Visibility: 'Global', NumberOfMessages: '1', NumberOfOverdueMessages: '1' },
    ],
    [`GET /DataStoreEntries(Id='A1',${key})/$value`]: { raw: zip({ body: '<order id="A1"/>', 'headers.prop': '#Mon Nov 02 10:55:02 UTC 2026\nSAP_MplCorrelationId=AGx\nAuthorization=Basic abc\n' }) },
  });
  const stores = await listDataStores(client);
  assert.deepEqual(stores.map((s) => [s.name, s.iflow, s.global, s.entries, s.overdue]), [['Orders', 'Flow', false, 2, 0], ['Shared', '', true, 1, 1]]);
  const e = await getDataStoreEntry(client, stores[0]!, 'A1');
  assert.equal(e.body, '<order id="A1"/>');
  assert.equal(e.headers.SAP_MplCorrelationId, 'AGx');
  assert.equal(e.headers.Authorization, '<hidden>');
});

test('variables: the value is the line of its name in headers.prop inside a zip', async () => {
  const { client } = tenant({
    "GET /Variables(VariableName='lastRun',IntegrationFlow='Flow')/$value": { raw: zip({ 'headers.prop': '#Mon Nov 02 11:01:29 UTC 2026\nSAP_MplCorrelationId=AGx\nlastRun=2026-11-02T10\\:00\\:00Z\n' }) },
  });
  assert.equal(await getVariableValue(client, { name: 'lastRun', iflow: 'Flow' }), '2026-11-02T10:00:00Z');
});

test('persisted messages: plain body, headers from the entry properties', async () => {
  const { client } = tenant({
    "GET /MessageStoreEntries('E1')/$value": { raw: '<order id="P1">persist me</order>', type: 'text/plain; charset=utf-8' },
    "GET /MessageStoreEntries('E1')/Properties": [{ MessageId: 'E1', Name: 'SAP_MplCorrelationId', Value: 'AGx' }, { MessageId: 'E1', Name: 'Cookie', Value: 'session=1' }],
  });
  const p = await getPersisted(client, 'E1');
  assert.equal(p.body, '<order id="P1">persist me</order>');
  assert.deepEqual(p.headers, { SAP_MplCorrelationId: 'AGx', Cookie: '<hidden>' });
});

test('JMS: queues with their iFlows (display name -> Id), messages, retry/move bodies, delete form', async () => {
  const { client, calls } = tenant({
    'GET /Queues': [{ Name: 'Q1', NumbOfMsgs: '1', Size: '1303', Type: '0', State: '0', FillGrade: '0', Active: '1', Exclusive: '0' }],
    'GET /IntegrationRuntimeArtifacts': [{ Id: 'Writer_Flow', Name: 'Writer_Flow' }, { Id: 'Reader_Flow', Name: 'Reader flow' }],
    "GET /Queues('Q1')/Artifacts": [{ Name: 'Writer_Flow', Id: 'guid-1', Direction: '2' }, { Name: 'Reader flow', Id: 'guid-2', Direction: '1' }],
    "GET /Queues('Q1')/Messages": [{
      Msgid: 'x-hex-49443a30', Name: 'Q1', Failed: true, Mplid: 'AGm', CreatedAt: '1793616724525', RetryCount: '1', NextRetry: '1793617000000',
      OverdueAt: '1793789524525', ExpirationDate: '1796208725668', SapSender: null, SapMplCorrelationId: 'AGc',
    }],
    'POST /RetryMessagingMessages': { raw: '{"operation":"RETRY","processedCount":1}', type: 'application/json' },
    'POST /MoveMessagingMessages': { raw: '{"operation":"MOVE","processedCount":2}', type: 'application/json' },
    "DELETE /MessagingMessages(jmsMessageId='x-hex-49443a30',queueName='Q1')": { raw: '' },
  });
  const [q] = await listQueues(client);
  assert.deepEqual(q!.iflows, [{ name: 'Writer_Flow', iflow: 'Writer_Flow', role: 'writes' }, { name: 'Reader flow', iflow: 'Reader_Flow', role: 'reads' }]);
  const [m] = await listQueueMessages(client, 'Q1');
  assert.deepEqual([m!.id, m!.failed, m!.retryCount, m!.messageLogId, m!.createdAt], ['x-hex-49443a30', true, 1, 'AGm', new Date(1793616724525).toISOString()]);
  assert.deepEqual(await retryQueueMessages(client, 'Q1', { ids: ['x-hex-49443a30'] }), { processed: 1 });
  assert.deepEqual(await moveQueueMessages(client, 'Q1', 'Q2', { createdBefore: new Date(1793616724525) }), { processed: 2 });
  await deleteQueueMessage(client, 'Q1', 'x-hex-49443a30');
  const posts = sent(calls, 'POST').filter((c) => c.path !== '/');
  // field names the tenant accepts (it rejects unknown ones)
  assert.deepEqual(JSON.parse(posts[0]!.body!), { queueName: 'Q1', jmsMessageIds: ['x-hex-49443a30'] });
  assert.deepEqual(JSON.parse(posts[1]!.body!), { sourceQueue: 'Q1', targetQueue: 'Q2', createdBefore: 1793616724525 });
  assert.equal(sent(calls, 'DELETE')[0]!.path, "/MessagingMessages(jmsMessageId='x-hex-49443a30',queueName='Q1')");
});

test('number ranges and configured values: the request bodies the tenant accepts', async () => {
  const { client, calls } = tenant({
    'POST /NumberRanges': { Name: 'N' },
    "GET /IntegrationDesigntimeArtifacts(Id='Flow',Version='active')/Configurations": [
      { ParameterKey: 'endpointPath', ParameterValue: '/a', DataType: 'xsd:string', Description: 'Path' },
      { ParameterKey: 'SAP_ProfileId', ParameterValue: 'iflmap', DataType: 'xsd:string', Description: null },
    ],
    "PUT /IntegrationDesigntimeArtifacts(Id='Flow',Version='active')/$links/Configurations('endpointPath')": { raw: '' },
  });
  await createNumberRange(client, planNumberRange('N', { max: '9999', fieldLength: '4', rotate: true }));
  // Rotate as text true/false (anything else: HTTP 500 "Rotate must be set to true or false")
  assert.deepEqual(JSON.parse(sent(calls, 'POST').find((c) => c.path === '/NumberRanges')!.body!),
    { Name: 'N', Description: '', MinValue: '0', MaxValue: '9999', CurrentValue: '0', FieldLength: '4', Rotate: 'true' });
  assert.deepEqual(await getConfigurations(client, 'Flow'), [
    { key: 'endpointPath', value: '/a', type: 'xsd:string', description: 'Path' }, { key: 'SAP_ProfileId', value: 'iflmap', type: 'xsd:string' },
  ]);
  // only max given: no empty value may reach the tenant (it answered HTTP 500 "For input string")
  await createNumberRange(client, planNumberRange('M', { max: '500' }));
  const minimal = JSON.parse(sent(calls, 'POST').filter((c) => c.path === '/NumberRanges')[1]!.body!);
  assert.deepEqual([minimal.MinValue, minimal.CurrentValue, minimal.FieldLength], ['0', '0', '3']);
  await setConfiguration(client, 'Flow', 'endpointPath', '/b', 'xsd:string');
  assert.deepEqual(JSON.parse(sent(calls, 'PUT')[0]!.body!), { ParameterValue: '/b', DataType: 'xsd:string' });
});

test('JMS broker: capacity also as readable text', () => {
  assert.equal(bytesText(6291456000), '5.9 GB');
  assert.equal(bytesText(1303), '1.3 KB');
  assert.equal(bytesText(0), '0 B');
});
