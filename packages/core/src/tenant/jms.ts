// JMS queues of the tenant's message broker: what iFlows with the JMS adapter wait on, with retry for failed
// messages. Measured on a trial: Queues, MessagingQueues and the broker answer; JmsQueues and JmsMessages lists do
// not (501). The retry and move functions take a JSON body and reject unknown fields, which showed their fields.
import { CpiClient, HttpError, q } from './client.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));
const ms = (v: unknown) => { const n = num(v); return n ? new Date(n).toISOString() : undefined; };

export interface BrokerInfo { capacity?: string; capacityBytes?: number; maxCapacityBytes?: number; queues?: number; maxQueues?: number; warnings: string[] }

/** 6291456000 -> "5.9 GB": readable, and not taken for a phone number by clients that mask long digit runs (tester report) */
export const bytesText = (n: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(1) : v} ${units[i]}`;
};
export interface QueueInfo { name: string; messages: number; sizeBytes?: number; active: boolean; exclusive: boolean; iflows: Array<{ name: string; iflow?: string; role: string }> }
export interface QueueMessage {
  id: string; failed: boolean; messageLogId?: string; createdAt?: string; retryCount?: number; nextRetry?: string;
  overdueAt?: string; expiresAt?: string; sender?: string; receiver?: string; messageType?: string; correlationId?: string;
}

export async function getBroker(client: CpiClient): Promise<BrokerInfo> {
  const b = await client.odata<Row>('GET', "/JmsBrokers('Broker1')");
  const flags: Array<[string, string]> = [['CapacityWarning', 'capacity warning'], ['CapacityError', 'capacity error'], ['IsQueuesHigh', 'many queues'],
    ['IsMessageSpoolHigh', 'message spool high'], ['IsConsumersHigh', 'many consumers'], ['IsProducersHigh', 'many producers'], ['IsTransactedSessionsHigh', 'many transacted sessions']];
  return {
    ...(num(b.Capacity) !== undefined && num(b.MaxCapacity) !== undefined ? { capacity: `${bytesText(num(b.Capacity)!)} of ${bytesText(num(b.MaxCapacity)!)} used` } : {}),
    ...(num(b.Capacity) !== undefined ? { capacityBytes: num(b.Capacity)! } : {}), ...(num(b.MaxCapacity) !== undefined ? { maxCapacityBytes: num(b.MaxCapacity)! } : {}),
    ...(num(b.QueueNumber) !== undefined ? { queues: num(b.QueueNumber)! } : {}), ...(num(b.MaxQueueNumber) !== undefined ? { maxQueues: num(b.MaxQueueNumber)! } : {}),
    warnings: flags.filter(([k]) => Number(b[k] ?? 0) > 0).map(([, t]) => t),
  };
}

/**
 * Queues with the iFlows that use them (Direction 1: the iFlow reads it, 2: writes to it; measured). The queue names
 * an iFlow by its display name, so the Id comes from the deployed artifacts; `id` is missing when it cannot be resolved.
 */
export async function listQueues(client: CpiClient): Promise<QueueInfo[]> {
  const [rows, deployed] = await Promise.all([client.odata<Row[]>('GET', '/Queues'), client.odata<Row[]>('GET', '/IntegrationRuntimeArtifacts')]);
  const idByName = new Map<string, string[]>();
  for (const d of deployed) idByName.set(String(d.Name), [...(idByName.get(String(d.Name)) ?? []), String(d.Id)]);
  return Promise.all(rows.map(async (r) => {
    const name = String(r.Name);
    const arts = await client.odata<Row[]>('GET', `/Queues('${q(name)}')/Artifacts`).catch(() => [] as Row[]);
    return {
      name, messages: Number(r.NumbOfMsgs ?? 0), ...(num(r.Size) !== undefined ? { sizeBytes: num(r.Size)! } : {}),
      active: String(r.Active) === '1', exclusive: String(r.Exclusive) === '1',
      iflows: arts.map((a) => {
        const ids = idByName.get(String(a.Name)) ?? [];
        return { name: String(a.Name), ...(ids.length === 1 ? { iflow: ids[0]! } : {}), role: String(a.Direction) === '2' ? 'writes' : String(a.Direction) === '1' ? 'reads' : String(a.Direction) };
      }),
    };
  }));
}

export async function listQueueMessages(client: CpiClient, queue: string): Promise<QueueMessage[]> {
  const rows = await client.odata<Row[]>('GET', `/Queues('${q(queue)}')/Messages`).catch((e: unknown) => {
    if (e instanceof HttpError && e.status === 404) throw new Error(`queue "${queue}" not found`);
    throw e;
  });
  const opt = (k: string, v: unknown) => (typeof v === 'string' && v ? { [k]: v } : {});
  return rows.map((r) => ({
    id: String(r.Msgid), failed: r.Failed === true || r.Failed === 'true',
    ...opt('messageLogId', r.Mplid), ...(ms(r.CreatedAt) ? { createdAt: ms(r.CreatedAt)! } : {}), ...(num(r.RetryCount) !== undefined ? { retryCount: num(r.RetryCount)! } : {}),
    ...(ms(r.NextRetry) ? { nextRetry: ms(r.NextRetry)! } : {}), ...(ms(r.OverdueAt) ? { overdueAt: ms(r.OverdueAt)! } : {}), ...(ms(r.ExpirationDate) ? { expiresAt: ms(r.ExpirationDate)! } : {}),
    ...opt('sender', r.SapSender), ...opt('receiver', r.SapReceiver), ...opt('messageType', r.SapMsgType), ...opt('correlationId', r.SapMplCorrelationId),
  }));
}

/** Which messages a retry or move applies to; none given: all failed ones */
export interface MessageSelection { ids?: string[]; messageLogId?: string; createdBefore?: Date }
const selection = (s: MessageSelection) => ({
  ...(s.ids?.length ? { jmsMessageIds: s.ids } : {}), ...(s.messageLogId ? { mplId: s.messageLogId } : {}), ...(s.createdBefore ? { createdBefore: s.createdBefore.getTime() } : {}),
});
const post = async (client: CpiClient, fn: string, body: Row) => {
  const res = await client.raw('POST', `/${fn}`, { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const out = JSON.parse(await res.text() || '{}') as Row;
  return { processed: Number(out.processedCount ?? 0) };
};

/** Retry failed messages now (the tenant retries them on the error queue of the queue) */
export const retryQueueMessages = (client: CpiClient, queue: string, s: MessageSelection = {}) =>
  post(client, 'RetryMessagingMessages', { queueName: queue, ...selection(s) });

export const moveQueueMessages = (client: CpiClient, queue: string, target: string, s: MessageSelection = {}) =>
  post(client, 'MoveMessagingMessages', { sourceQueue: queue, targetQueue: target, ...selection(s) });

/** Delete one message (this form checks that the message exists; the JmsMessages form answers 204 for any id) */
export async function deleteQueueMessage(client: CpiClient, queue: string, id: string): Promise<void> {
  await client.raw('DELETE', `/MessagingMessages(jmsMessageId='${q(id)}',queueName='${q(queue)}')`);
}

export async function setQueueActive(client: CpiClient, queue: string, active: boolean): Promise<void> {
  await client.raw('POST', `/${active ? 'activateQueue' : 'deactivateQueue'}?Name='${q(queue)}'`);
}
