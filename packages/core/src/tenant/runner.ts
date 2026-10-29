// Client of the script runner iFlow (https://github.com/devstylator/CPI_Iflow_GroovyScriptExe): runs one Groovy
// script on the tenant without deploying it, inside a real script step (1.x: Groovy 2.4, 2.x: Groovy 4).
// API: docs/script-runner.openapi.yaml. The runner executes any code; callers allow it on development tenants only.
import { CpiClient, HttpError, mplIdOf } from './client.js';

export interface ScriptRunInput {
  script: string;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  properties?: Record<string, string>;
  /** function to call instead of processData */
  function?: string;
  /** script step generation; default: 2 when the script imports the v2 API (com.sap.it.script.v2.api), else 1 */
  groovyVersion?: 1 | 2;
}

export interface Changes { set: Record<string, string | null>; removed: string[] }

export interface ScriptRunResult {
  ok: boolean;
  status: number;
  groovyVersion: 1 | 2;
  ms: number;
  messageLogId?: string;
  /** "<exception>: <message> @ line <n>" or the compiler message */
  error?: string;
  console: string;
  body: string;
  /** what the script set or removed (runner 1.0.12+) */
  delta?: { headers: Changes; properties: Changes };
}

const b64 = (v: string | Uint8Array) => Buffer.from(v).toString('base64');
const unb64 = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'base64').toString('utf8') : '');

/** Script step generation a script is written for: the v2 Message API marks script step 2.x */
export const groovyVersionOf = (script: string): 1 | 2 => (/com\.sap\.it\.script\.v2\.api/.test(script) ? 2 : 1);

export async function runScript(client: CpiClient, runnerPath: string, input: ScriptRunInput): Promise<ScriptRunResult> {
  const headers = input.headers ?? {};
  const properties = { ...(input.properties ?? {}), ...(input.function ? { runnerFunction: input.function } : {}) };
  // the runner passes headers and properties as "Name=Value;Name=Value"
  for (const [k, v] of Object.entries({ ...headers, ...properties })) {
    if (/[;=]/.test(k + v)) throw new Error(`"${k}": the script runner cannot pass ";" or "=" in names or values; set such values inside the script`);
  }
  const pairs = (m: Record<string, string>) => b64(Object.entries(m).map(([k, v]) => `${k}=${v}`).join(';'));
  const groovyVersion = input.groovyVersion ?? groovyVersionOf(input.script);
  const url = `${client.key.url}/http${runnerPath}`;
  const started = Date.now();
  const res = await client.request('POST', url, {
    body: JSON.stringify({ inputScript: b64(input.script), inputPayload: b64(input.body ?? ''), inputHdrs: pairs(headers), inputParams: pairs(properties) }),
    headers: { 'Content-Type': 'application/json', 'groovy-version': String(groovyVersion) },
  });
  const text = await res.text();
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (res.status === 404) throw new Error(`script runner not found at ${runnerPath} (HTTP 404): is the runner iFlow deployed, and is "scriptRunner" in the configuration its path?`);
    throw new HttpError('POST', runnerPath, res.status, text);
  }
  const mpl = mplIdOf(res, text);
  const error = out.error ? unb64(out.error) : undefined;
  return {
    ok: !error && res.ok,
    status: res.status,
    groovyVersion,
    ms: Date.now() - started,
    ...(mpl ? { messageLogId: mpl } : {}),
    ...(error ? { error } : {}),
    console: unb64(out.console),
    body: unb64(out.payload),
    ...(out.delta ? { delta: out.delta as ScriptRunResult['delta'] & object } : {}),
  };
}
