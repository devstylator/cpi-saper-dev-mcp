// Run an XSLT (1.0/2.0/3.0) locally with SaxonJS, the way a CPI XSLT Mapping step would: message headers and
// exchange properties are offered as xsl:param (undeclared ones are ignored). Differences from CPI's Saxon for
// Java are listed in docs/KNOWN_LIMITATIONS.md.
import { pathToFileURL } from 'node:url';
import SaxonJS from 'saxon-js';

const TRANSFORM = `transform(map{
  'stylesheet-text': $xsl, 'stylesheet-base-uri': $base, 'source-node': parse-xml($src), 'delivery-format': 'serialized',
  'stylesheet-params': map:merge(for-each-pair($names, $values, function($k, $v) { map{ QName('', $k): $v } }))
})?output`;

export interface XsltError {
  code: string;
  message: string;
  /** exact line of a compile error (found through the quoted expression) */
  line?: number;
  /** approximate line, when the exact one could not be found */
  near?: number;
  /** runtime errors: line of the enclosing element (template or literal result element) */
  within?: number;
}

export type XsltResult =
  | { ok: true; output: string; messages: string[]; ms: number }
  | { ok: false; error: XsltError; messages: string[]; ms: number };

// SaxonJS writes xsl:message to the console; collect it instead
function captureConsole<T>(fn: () => T): { value: T; messages: string[] } {
  const messages: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved) as Array<keyof typeof saved>) console[k] = (...a: unknown[]) => { messages.push(a.join(' ')); };
  try {
    return { value: fn(), messages };
  } catch (e) {
    (e as { messages?: string[] }).messages = messages;
    throw e;
  } finally {
    Object.assign(console, saved);
  }
}

// SaxonJS line numbers are approximate (measured): compile errors report 1-2 lines early, runtime errors the
// line of the enclosing literal result element. Compile error messages quote the expression
// ("... in x.xsl {count((}"), so it is looked up in the stylesheet text for the exact line.
function errorLocation(e: { message?: string; xsltModule?: string; xsltLineNr?: unknown }, stylesheetText: string): Partial<XsltError> {
  const quoted = /on line (\d+) in [^{]*\{(.*)\}\s*:/s.exec(e.message ?? '');
  if (quoted) {
    const hits = stylesheetText.split('\n').flatMap((l, i) => (l.includes(quoted[2]!) ? [i + 1] : []));
    return hits.length === 1 ? { line: hits[0]! } : { near: Number(quoted[1]) };
  }
  if (e.xsltModule && !/^(xpath|compile|xslt)\w*\.xsl$/.test(e.xsltModule) && Number(e.xsltLineNr)) return { within: Number(e.xsltLineNr) };
  return {};
}

/** Headers first, then properties: a property wins over a header of the same name (CPI's precedence is not verified) */
export function runXslt({ stylesheetText, stylesheetPath, input, headers = {}, properties = {} }: {
  stylesheetText: string;
  /** used to resolve xsl:include, xsl:import and document() */
  stylesheetPath?: string;
  input: string;
  headers?: Record<string, string>;
  properties?: Record<string, string>;
}): XsltResult {
  const params = { ...headers, ...properties };
  const started = Date.now();
  try {
    const { value, messages } = captureConsole(() => SaxonJS.XPath.evaluate(TRANSFORM, null, {
      params: {
        xsl: stylesheetText,
        base: pathToFileURL(stylesheetPath ?? `${process.cwd()}/stylesheet.xsl`).href,
        src: input,
        names: Object.keys(params),
        values: Object.values(params).map(String),
      },
    }));
    return { ok: true, output: String(value), messages, ms: Date.now() - started };
  } catch (err) {
    const e = err as { code?: string; name?: string; message?: string; messages?: string[]; xsltModule?: string; xsltLineNr?: unknown };
    return {
      ok: false, messages: e.messages ?? [], ms: Date.now() - started,
      error: {
        code: String(e.code ?? e.name ?? 'ERROR').replace(/^Q\{[^}]*\}/, ''),
        message: String(e.message).replace(/ on line \d+ in [^{]*(?=\{)/, ' '),
        ...errorLocation(e, stylesheetText),
      },
    };
  }
}
