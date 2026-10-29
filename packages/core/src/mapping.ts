// Read-only view of a message mapping (.mmap, the XI/PI mapping-tool format <xiObj xmlns="urn:sap-com:xi">):
// one line per target field, "target <- expression", plus source/target messages and function libraries.
// Editor positions (viewData) and empty UDF storage are ignored.
import { DOMParser, type Element, type Node } from '@xmldom/xmldom';

const isEl = (n: Node | null | undefined): n is Element => !!n && n.nodeType === 1;
const kids = (el: Element | undefined, name?: string): Element[] =>
  Array.from(el?.childNodes ?? []).filter((n): n is Element => isEl(n) && (!name || n.localName === name));
const first = (el: Element | undefined, name: string) => kids(el, name)[0];
const deep = (el: Element | null | undefined, name: string): Element[] =>
  (el ? Array.from(el.getElementsByTagName('*')).filter((n) => n.localName === name) : []);

export interface MessageRef { kpos: number; file: string; root: string; type: string }
export interface MappingView {
  sources: MessageRef[];
  targets: MessageRef[];
  /** Groovy function files (UDFs) the mapping uses */
  functionLibs: Array<{ file: string }>;
  /** prefix -> namespace URI, as far as the mapping declares them */
  namespaces: Record<string, string>;
  multiplicity?: string;
  /** one entry per mapped target field, in mapping order */
  fields: Array<{ target: string; expr: string }>;
}

// lnkRole entries: SOURCE_IFR_MESS / TARGET_IFR_MESS (message schema) and UsedFuncLib (Groovy function files)
function links(root: Element) {
  const out = { sources: [] as MessageRef[], targets: [] as MessageRef[], functionLibs: [] as Array<{ file: string }> };
  for (const role of deep(root, 'lnkRole')) {
    const key = deep(role, 'key')[0];
    const elems = kids(key, 'elem').map((e) => (e.textContent ?? '').trim());
    const kpos = Number(role.getAttribute('kpos')) || 1;
    const message = () => ({ kpos, file: `${elems[1]}/${elems[0]}`, root: elems[2] ?? '', type: key?.getAttribute('typeID') ?? '' });
    switch (role.getAttribute('role')) {
      case 'SOURCE_IFR_MESS': out.sources.push(message()); break;
      case 'TARGET_IFR_MESS': out.targets.push(message()); break;
      case 'UsedFuncLib': out.functionLibs.push({ file: `${elems[1]}/${elems[0]}` }); break;
      default:
    }
  }
  for (const list of [out.sources, out.targets]) list.sort((a, b) => a.kpos - b.kpos);
  return out;
}

interface RenderContext { target: string; defined: Map<string, string>; sharedRef: (uid: string) => string }

// Expression tree of one brick. Func: fname(args, param=value); fns = "dflt" (standard library) or the name of
// a function library entry (Groovy UDF file). Src: source path, with {ctx …} when a context is set.
// A brick with only object_uid refers to the result of another brick with that uid (shared between targets).
function render(brick: Element, ctx: RenderContext): string {
  const type = brick.getAttribute('type');
  const uid = brick.getAttribute('object_uid');
  if (!type && uid) return ctx.sharedRef(uid);
  if (type === 'Src') {
    const c = brick.getAttribute('context');
    // the context is always an ancestor of the path, so its last step names it unambiguously
    return `${brick.getAttribute('path')}${c ? ` {ctx ${c.split('/').pop()}}` : ''}`;
  }
  if (type === 'Func') {
    const name = brick.getAttribute('fname');
    const lib = brick.getAttribute('fns');
    const args = kids(brick, 'arg').map((a) => [Number(a.getAttribute('pin') ?? 0), first(a, 'brick')] as const)
      .sort((x, y) => x[0] - y[0]).map(([, b]) => (b ? render(b, ctx) : '?'));
    // UDFs carry an empty "context" binding (their MappingContext/Container argument): not shown
    const params = deep(first(brick, 'bindings'), 'param').map((p) => [p.getAttribute('name') ?? '', first(p, 'value')?.textContent ?? ''] as const)
      .filter(([k, v]) => !(k === 'context' && v === ''));
    if (name === 'const' && params.length === 1 && params[0]![0] === 'value') return JSON.stringify(params[0]![1]);
    const text = `${lib && lib !== 'dflt' ? `${lib}.` : ''}${name}(${[...args, ...params.map(([k, v]) => `${k}=${JSON.stringify(v)}`)].join(', ')})`;
    if (uid) ctx.defined.set(uid, ctx.target);
    return text;
  }
  return `?${type}`;
}

export function readMapping(xml: string): MappingView {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (root?.localName !== 'xiObj') throw new Error('not a message mapping (.mmap): root element is not xiObj');
  const transformation = deep(root, 'transformation')[0];
  const namespaces = Object.fromEntries(deep(first(transformation, 'namespaces'), 'property')
    .map((p) => [(p.textContent ?? '').trim(), p.getAttribute('name') ?? '']));
  const multiplicity = deep(root, 'Multiplicity')[0]?.textContent?.trim();

  // two passes: a shared result may be referenced before the brick that defines it
  const dsts = kids(transformation, 'brick').filter((b) => b.getAttribute('type') === 'Dst');
  const defined = new Map<string, string>();
  const pass = (final: boolean) => dsts.map((dst) => {
    const target = dst.getAttribute('path') ?? '';
    const ctx: RenderContext = {
      target, defined,
      sharedRef: (uid) => (final && defined.has(uid) ? `(same as ${defined.get(uid)})` : `(shared ${uid})`),
    };
    const arg = first(first(dst, 'arg'), 'brick');
    return { target, expr: arg ? render(arg, ctx) : '(not mapped)' };
  });
  pass(false);
  return { ...links(root), namespaces, ...(multiplicity ? { multiplicity } : {}), fields: pass(true) };
}

/** Text form: header, then one line per target field in mapping order */
export function mappingText(m: MappingView): string {
  const out: string[] = [];
  for (const s of m.sources) out.push(`source ${s.kpos}: ${s.root} (${s.file})`);
  for (const t of m.targets) out.push(`target ${t.kpos}: ${t.root} (${t.file})`);
  if (m.multiplicity && m.multiplicity !== '1:1') out.push(`multiplicity: ${m.multiplicity}`);
  for (const f of m.functionLibs) out.push(`functions: ${f.file}`);
  for (const [prefix, uri] of Object.entries(m.namespaces)) out.push(`namespace ${prefix} = ${uri}`);
  out.push('');
  for (const f of m.fields) out.push(`${f.target} <- ${f.expr}`);
  return out.join('\n');
}
