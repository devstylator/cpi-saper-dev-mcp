// Externalized parameters of an iFlow: declared in src/main/resources/parameters.propdef (name, type, required,
// description; the designer also records where a parameter is used under <param_references>) with their values in
// parameters.prop (Java properties). Settings use them as {{name}}. Both files are edited as text, so everything this
// code does not touch stays byte for byte as the designer wrote it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ParamDef { name: string; type: string; required: boolean; description: string }
export interface ParamInput { name: string; value?: string; type?: string; required?: boolean; description?: string }

/** Types the designer offers for externalized parameters */
export const PARAM_TYPES = ['xsd:string', 'xsd:integer', 'xsd:long', 'xsd:boolean', 'xsd:date', 'xsd:time', 'xsd:dateTime'];

const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The <parameter> block of one name */
const blockOf = (name: string) => new RegExp(`<parameter>(?:(?!</parameter>)[\\s\\S])*?<name>${rx(escapeXml(name))}</name>[\\s\\S]*?</parameter>`);
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function escapeXml(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const tag = (block: string, t: string) => {
  const m = block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>|<${t}/>`));
  return m?.[1] !== undefined ? unescapeXml(m[1]) : '';
};

export function readPropdef(xml: string): ParamDef[] {
  return [...xml.matchAll(/<parameter>([\s\S]*?)<\/parameter>/g)].map((m) => ({
    name: tag(m[1]!, 'name'), type: tag(m[1]!, 'type') || 'xsd:string', required: tag(m[1]!, 'isRequired') === 'true', description: tag(m[1]!, 'description'),
  }));
}

// ---------- Java properties (the escaping java.util.Properties.store writes) ----------

const escapeProp = (s: string, key: boolean) => s.replace(/[\\:=#! \t\n\r\f]|[^\x20-\x7e]/g, (c, i: number) => {
  if (c === ' ') return key || i === 0 ? '\\ ' : ' ';
  const named: Record<string, string> = { '\\': '\\\\', ':': '\\:', '=': '\\=', '#': '\\#', '!': '\\!', '\t': '\\t', '\n': '\\n', '\r': '\\r', '\f': '\\f' };
  return named[c] ?? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
});
const unescapeProp = (s: string) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) =>
  c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c);

/** Values by name; comment lines and line continuations handled as Java does */
export function readProp(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const logical = text.replace(/\\\r?\n[ \t\f]*/g, '').split(/\r?\n/);
  for (const line of logical) {
    if (/^\s*([#!]|$)/.test(line)) continue;
    const m = line.trimStart().match(/^((?:\\.|[^:=\s\\])*)\s*[:=\s]\s*(.*)$/) ?? [line, line.trim(), ''];
    out.set(unescapeProp(m[1]!), unescapeProp(m[2]!));
  }
  return out;
}

/** Java's timestamp comment, as the tenant writes it ("#Mon Nov 02 10:12:48 UTC 2026") */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = (d = new Date()) => {
  const two = (n: number) => String(n).padStart(2, '0');
  return `#${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
};

// ---------- editing ----------

const NEW_PROPDEF = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><parameters></parameters>';
const block = (p: ParamDef) =>
  `<parameter>\n    <key/>\n    <name>${escapeXml(p.name)}</name>\n    <type>${p.type}</type>\n    <isRequired>${p.required}</isRequired>\n` +
  `    <constraint/>\n    ${p.description ? `<description>${escapeXml(p.description)}</description>` : '<description/>'}\n    <additionalMetadata/>\n  </parameter>`;

/**
 * Declare, change or remove parameters in an iFlow folder: parameters.propdef and parameters.prop are created when
 * missing; a changed parameter keeps what is not given; a removed one also leaves the designer's references.
 * Returns one line per change.
 */
export function setParams(dir: string, set: ParamInput[], remove: string[] = []): string[] {
  const res = join(dir, 'src', 'main', 'resources');
  const defPath = join(res, 'parameters.propdef');
  const propPath = join(res, 'parameters.prop');
  let xml = existsSync(defPath) ? readFileSync(defPath, 'utf8') : NEW_PROPDEF;
  let prop = existsSync(propPath) ? readFileSync(propPath, 'utf8') : `${stamp()}\n`;
  const defs = new Map(readPropdef(xml).map((d) => [d.name, d]));
  const log: string[] = [];
  const propLine = (name: string) => new RegExp(`^${rx(escapeProp(name, true))}\\s*[=:].*$`, 'm');

  for (const name of remove) {
    if (!defs.has(name)) throw new Error(`parameter "${name}" is not declared; declared: ${[...defs.keys()].join(', ') || 'none'}`);
    xml = xml.replace(blockOf(name), '');
    xml = xml.replace(new RegExp(`<reference [^>]*param_key="${rx(escapeXml(name))}"[^>]*/>`, 'g'), '');
    prop = prop.replace(propLine(name), '').replace(/\n\n+/g, '\n');
    defs.delete(name);
    log.push(`removed ${name}`);
  }
  for (const p of set) {
    if (!p.name.trim() || /[{}]/.test(p.name)) throw new Error(`"${p.name}" is not a usable parameter name`);
    const old = defs.get(p.name);
    const def: ParamDef = { name: p.name, type: p.type ?? old?.type ?? 'xsd:string', required: p.required ?? old?.required ?? false, description: p.description ?? old?.description ?? '' };
    if (!PARAM_TYPES.includes(def.type)) throw new Error(`${p.name}: type "${def.type}" is not one of ${PARAM_TYPES.join(', ')}`);
    if (p.value !== undefined) {
      if (def.type === 'xsd:integer' || def.type === 'xsd:long') { if (!/^-?\d+$/.test(p.value)) throw new Error(`${p.name}: "${p.value}" is not a whole number`); }
      if (def.type === 'xsd:boolean' && !/^(true|false)$/.test(p.value)) throw new Error(`${p.name}: "${p.value}" is not true or false`);
    }
    if (!old) {
      xml = /<param_references>/.test(xml) ? xml.replace('<param_references>', `${block(def)}<param_references>`) : xml.replace(/<\/parameters>\s*$/, `${block(def)}</parameters>`);
      log.push(`declared ${p.name} (${def.type}${def.required ? ', required' : ''})`);
    } else if (def.type !== old.type || def.required !== old.required || def.description !== old.description) {
      xml = xml.replace(blockOf(p.name), (b) => b.replace(/<type>[^<]*<\/type>/, `<type>${def.type}</type>`).replace(/<isRequired>[^<]*<\/isRequired>/, `<isRequired>${def.required}</isRequired>`)
        .replace(/<description>[\s\S]*?<\/description>|<description\/>/, def.description ? `<description>${escapeXml(def.description)}</description>` : '<description/>'));
      log.push(`changed ${p.name} (${def.type}${def.required ? ', required' : ''})`);
    }
    if (p.value !== undefined) {
      const line = `${escapeProp(p.name, true)}=${escapeProp(p.value, false)}`;
      prop = propLine(p.name).test(prop) ? prop.replace(propLine(p.name), line) : `${prop.replace(/\n?$/, '\n')}${line}\n`;
      log.push(`${p.name} = ${p.value}`);
    }
    defs.set(p.name, def);
  }
  mkdirSync(dirname(defPath), { recursive: true });
  writeFileSync(defPath, xml);
  writeFileSync(propPath, prop);
  return log;
}

/** Declared parameters with their values (from the iFlow folder's files) */
export function readParams(dir: string): Array<ParamDef & { value?: string }> {
  const res = join(dir, 'src', 'main', 'resources');
  const defs = existsSync(join(res, 'parameters.propdef')) ? readPropdef(readFileSync(join(res, 'parameters.propdef'), 'utf8')) : [];
  const values = existsSync(join(res, 'parameters.prop')) ? readProp(readFileSync(join(res, 'parameters.prop'), 'utf8')) : new Map<string, string>();
  return defs.map((d) => ({ ...d, ...(values.has(d.name) ? { value: values.get(d.name)! } : {}) }));
}
