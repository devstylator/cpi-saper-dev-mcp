// Testing and monitoring: call deployed endpoints, read message processing logs, step traces.
import { CpiClient, HttpError, mplIdOf, odataDate, q } from './client.js';

type Row = Record<string, unknown>;
const iso = (v: unknown) => odataDate(v)?.toISOString();

/** Credentials the runtime keeps in headers and properties: their values are never shown */
export const SENSITIVE = /auth|passport|password|secret|token|cookie|credential/i;
export const redactor = (extra: string[] = []) => {
  const lower = extra.map((x) => x.toLowerCase());
  return (name: string, value: string) => (SENSITIVE.test(name) || lower.includes(name.toLowerCase()) ? '<hidden>' : value);
};

export interface SendResult { status: number; ms: number; messageLogId?: string; contentType?: string; headers: Record<string, string>; body: string }

/** Call an iFlow's HTTP endpoint (https://<runtime>/http<path>) with the runtime key */
export async function sendMessage(client: CpiClient, path: string, { method = 'POST', body, headers = {}, redact = redactor() }:
  { method?: string; body?: string; headers?: Record<string, string>; redact?: (n: string, v: string) => string } = {}): Promise<SendResult> {
  const url = `${client.key.url}/http${path.startsWith('/') ? path : `/${path}`}`;
  const started = Date.now();
  const res = await client.request(method, url, { ...(body !== undefined ? { body } : {}), headers });
  const text = await res.text();
  const shown: Record<string, string> = {};
  for (const [k, v] of res.headers) if (!/^(set-cookie|strict-transport|x-content-type|x-frame|x-xss|x-correlationid|x-vcap)/i.test(k)) shown[k] = redact(k, v);
  const mpl = mplIdOf(res, text);
  return {
    status: res.status, ms: Date.now() - started, ...(mpl ? { messageLogId: mpl } : {}),
    ...(res.headers.get('content-type') ? { contentType: res.headers.get('content-type')! } : {}), headers: shown, body: text,
  };
}

export interface MessageSummary { id: string; iflow: string; status: string; start?: string; end?: string; customStatus?: string }

const toSummary = (m: Row): MessageSummary => ({
  id: String(m.MessageGuid), iflow: String(m.IntegrationFlowName), status: String(m.Status),
  ...(iso(m.LogStart) ? { start: iso(m.LogStart)! } : {}), ...(iso(m.LogEnd) ? { end: iso(m.LogEnd)! } : {}),
  ...(m.CustomStatus && m.CustomStatus !== m.Status ? { customStatus: String(m.CustomStatus) } : {}),
});

/** Newest first */
export async function listMessages(client: CpiClient, { iflow, status, top = 10 }: { iflow?: string; status?: string; top?: number } = {}): Promise<MessageSummary[]> {
  const where: Record<string, string> = {};
  if (iflow) where.IntegrationFlowName = iflow;
  if (status) where.Status = status;
  const rows = await client.odata<Row[]>('GET', '/MessageProcessingLogs', undefined, { ...(Object.keys(where).length ? { where } : {}), orderby: 'LogEnd desc', top });
  return rows.map(toSummary);
}

export interface RunStep { no: number; status: string; stepId: string; stepName?: string; activity?: string; error?: string; runId: string; childCount: number }
export interface MessageDetail extends MessageSummary {
  logLevel?: string;
  error?: { type?: string; lastFailingStep?: string; lastFailingStepName?: string; text: string };
  steps: RunStep[];
  /** why steps is empty, when the tenant recorded none */
  note?: string;
}

/** One message log with its error and the processing steps; stepName maps the model's step ids to names */
export async function getMessage(client: CpiClient, id: string, stepName: (stepId: string) => string | undefined = () => undefined): Promise<MessageDetail> {
  const m = await client.odata<Row>('GET', `/MessageProcessingLogs('${q(id)}')`).catch((e: unknown) => {
    if (e instanceof HttpError && e.status === 404) throw new Error(`message ${id} not found`);
    throw e;
  });
  const detail: MessageDetail = { ...toSummary(m), ...(m.LogLevel ? { logLevel: String(m.LogLevel) } : {}), steps: [] };
  if (!['COMPLETED', 'PROCESSING'].includes(detail.status)) {
    try {
      const info = await client.odata<Row>('GET', `/MessageProcessingLogs('${q(id)}')/ErrorInformation`);
      const text = await (await client.raw('GET', `/MessageProcessingLogs('${q(id)}')/ErrorInformation/$value`)).text();
      const last = info?.LastErrorModelStepId ? String(info.LastErrorModelStepId) : undefined;
      detail.error = {
        ...(info?.Type ? { type: String(info.Type) } : {}),
        ...(last ? { lastFailingStep: last } : {}), ...(last && stepName(last) ? { lastFailingStepName: stepName(last)! } : {}),
        text: text.slice(0, 4000),
      };
    } catch { /* no error information */ }
  }
  const runs = await client.odata<Row[]>('GET', `/MessageProcessingLogs('${q(id)}')/Runs`);
  for (const run of runs ?? []) {
    const steps = await client.odata<Row[]>('GET', `/MessageProcessingLogRuns('${q(String(run.Id))}')/RunSteps`);
    steps.sort((a, b) => Number(a.ChildCount) - Number(b.ChildCount));
    for (const s of steps) {
      const stepId = String(s.ModelStepId ?? '');
      detail.steps.push({
        no: detail.steps.length + 1, status: String(s.Status ?? ''), stepId,
        ...(stepName(stepId) ? { stepName: stepName(stepId)! } : {}),
        ...(s.Activity ? { activity: String(s.Activity) } : {}), ...(s.Error ? { error: String(s.Error).slice(0, 1000) } : {}),
        runId: String(run.Id), childCount: Number(s.ChildCount),
      });
    }
  }
  // measured: at log level INFO the tenant keeps steps for failed messages only
  if (!detail.steps.length && detail.status === 'COMPLETED' && detail.logLevel === 'INFO') {
    detail.note = 'no steps: at log level INFO Cloud Integration records processing steps only for failed messages; set the iFlow\'s log level to Debug or Trace (cpi_trace) to see them';
  }
  return detail;
}

// ---------- tracing (undocumented internal endpoint, behind the "experimental.trace" setting) ----------

/**
 * Set the message log level of a deployed iFlow (NONE, INFO, DEBUG, TRACE; TRACE expires after 10 minutes).
 * Same call as the Monitor UI: the management host serves it with the api key's token, XML only.
 */
export async function setLogLevel(client: CpiClient, iflow: string, level: 'NONE' | 'INFO' | 'DEBUG' | 'TRACE'): Promise<{ logLevel?: string; traceExpiresAt?: string }> {
  const res = await client.request('POST', `${client.key.url}/Operations/com.sap.it.op.tmn.commands.dashboard.webui.IntegrationComponentSetMplLogLevelCommand`, {
    body: JSON.stringify({ artifactSymbolicName: iflow, mplLogLevel: level, nodeType: 'IFLMAP', runtimeLocationId: 'cloudintegration' }),
    headers: { 'Content-Type': 'application/json', Accept: 'application/xml' },
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError('POST', 'IntegrationComponentSetMplLogLevelCommand', res.status, text);
  const tag = (t: string) => text.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
  return { ...(tag('logLevel') ? { logLevel: tag('logLevel')! } : {}), ...(tag('traceExpiresAt') ? { traceExpiresAt: tag('traceExpiresAt')! } : {}) };
}

export interface StepTrace { body: string; bodySize?: number; headers: Record<string, string>; properties: Record<string, string> }

// Runtime-internal headers and properties: left out of traces
const NOISE = /^(SAP_|Camel|SAPCamel|StatusProvider_)/;

/** What entered one step (the adapter's last trace is the response); only exists for messages processed at TRACE */
export async function stepTraces(client: CpiClient, runId: string, childCount: number, redact = redactor(), maxChars = 20000): Promise<StepTrace[]> {
  const traces = await client.odata<Row[]>('GET', `/MessageProcessingLogRunSteps(RunId='${q(runId)}',ChildCount=${childCount})/TraceMessages`);
  const out: StepTrace[] = [];
  for (const t of traces ?? []) {
    const tid = String(t.TraceId);
    const body = await (await client.raw('GET', `/TraceMessages(${tid}L)/$value`)).text();
    const pairs = async (nav: string) => Object.fromEntries((await client.odata<Row[]>('GET', `/TraceMessages(${tid}L)/${nav}`))
      .filter((p) => !NOISE.test(String(p.Name))).map((p) => [String(p.Name), redact(String(p.Name), String(p.Value ?? ''))]));
    out.push({
      body: body.length > maxChars ? `${body.slice(0, maxChars)}…(${body.length} characters)` : body,
      ...(t.PayloadSize !== undefined ? { bodySize: Number(t.PayloadSize) } : {}),
      headers: await pairs('Properties'), properties: await pairs('ExchangeProperties'),
    });
  }
  return out;
}
