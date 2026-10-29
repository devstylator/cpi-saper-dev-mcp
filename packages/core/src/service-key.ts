// Service keys of the "Process Integration Runtime" service, as downloaded from BTP.
// Values are read only to authenticate; nothing in here returns or logs clientid/clientsecret.
import { readFileSync } from 'node:fs';

export interface ServiceKey {
  clientid: string;
  clientsecret: string;
  /** tenant host (plan "api": management host; plan "integration-flow": runtime host), no trailing slash */
  url: string;
  tokenurl: string;
}

const FIELDS = ['clientid', 'clientsecret', 'url', 'tokenurl'] as const;

/** Accepts { "oauth": { clientid, clientsecret, url, tokenurl } } (BTP download) or the same fields at top level */
export function loadServiceKey(path: string): ServiceKey {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const o = (typeof raw.oauth === 'object' && raw.oauth !== null ? raw.oauth : raw) as Record<string, unknown>;
  const missing = FIELDS.filter((f) => typeof o[f] !== 'string' || o[f] === '');
  if (missing.length) {
    throw new Error(`${path}: field(s) ${missing.join(', ')} not found (expected a Process Integration Runtime service key)`);
  }
  return {
    clientid: o.clientid as string,
    clientsecret: o.clientsecret as string,
    url: (o.url as string).replace(/\/+$/, ''),
    tokenurl: o.tokenurl as string,
  };
}

export type ServiceKeyStatus =
  | { status: 'ok'; host: string }
  | { status: 'missing' | 'invalid'; problem: string };

/** State of a key file for display: never contains secret values, only the tenant host */
export function checkServiceKey(path: string): ServiceKeyStatus {
  try {
    return { status: 'ok', host: new URL(loadServiceKey(path).url).host };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { status: 'missing', problem: `file not found: ${path}` };
    // JSON.parse messages can quote file content: report the kind of problem only
    if (e instanceof SyntaxError) return { status: 'invalid', problem: `${path}: not valid JSON` };
    return { status: 'invalid', problem: err.message };
  }
}
