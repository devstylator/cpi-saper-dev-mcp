// Model-level comparison of two iFlows, and a line-per-fact text form of one iFlow for `git diff` (textconv).
// Elements are matched by id (the designer keeps ids across saves). Layout, and ids the designer regenerates
// on every save (route condition ids, loopId), are not reported as changes.
import type { Document } from '@xmldom/xmldom';
import { byTag, children, NS, type Container, type Decoded, type Flow, type IflowModel, type Step, type TableRow } from './model.js';

// Properties the designer rewrites on every save although nothing changed
const VOLATILE = new Set(['loopId']);
const SHORT = 200;

const q = (v: unknown) => (v === undefined ? '(none)' : JSON.stringify(v));
const clip = (s: string) => (s.length > SHORT ? `${s.slice(0, SHORT)}…(${s.length} chars)` : s);

interface Elem {
  what: string; id: string; name?: string; kind?: string; adapter?: string; type?: string; version?: string;
  direction?: string; no?: number; where?: string; defaultFlow?: string; from?: string; to?: string;
  config?: Record<string, Decoded>;
}
interface FlowAt extends Flow { where: string }

// Flatten a describe() model: id -> element with its container, flows separately
function flatten(model: IflowModel) {
  const elements = new Map<string, Elem>();
  const flows = new Map<string, FlowAt>();
  for (const p of model.participants) elements.set(p.id, { what: 'participant', ...p });
  for (const a of model.adapters) elements.set(a.id, { what: 'adapter', ...a });
  const walk = (container: Container, where: string) => {
    for (const s of container.steps) {
      const what = s.bpmn === 'subProcess' ? 'subprocess' : s.bpmn.endsWith('Gateway') ? 'gateway' : s.bpmn.endsWith('Event') ? 'event' : 'step';
      const { steps: _s, flows: _f, ...rest } = s;
      elements.set(s.id, { what, where, ...rest });
      if (s.steps) walk(s as Step & Container, s.name || s.id);
    }
    for (const f of container.flows) flows.set(f.id, { ...f, where });
  };
  for (const proc of model.processes) {
    elements.set(proc.id, { what: 'process', id: proc.id, name: proc.name, ...(proc.kind ? { kind: proc.kind } : {}) });
    walk(proc, proc.name);
  }
  return { elements, flows };
}

const ref = (el: Elem | undefined) => (el ? `${el.no ? `#${el.no} ` : ''}"${el.name || el.kind || el.id}"` : '?');
const title = (el: Elem) =>
  `${el.what} ${ref(el)} (${[el.kind ?? el.adapter ?? el.type, el.version].filter(Boolean).join(' ')}${el.direction ? `, ${el.direction}` : ''}) [${el.id}]`;

// Table rows (Content Modifier headers/properties, ...) are matched by Name, else by position
function diffTable(key: string, a: TableRow[], b: TableRow[], out: string[], indent: string) {
  const keyOf = (r: TableRow, i: number) => (!Array.isArray(r) && r.Name !== undefined ? r.Name : `row ${i + 1}`);
  const ma = new Map(a.map((r, i) => [keyOf(r, i), r]));
  const mb = new Map(b.map((r, i) => [keyOf(r, i), r]));
  const row = (r: TableRow) => (Array.isArray(r) ? r.join(' | ') : Object.entries(r).filter(([k, v]) => k !== 'Name' && v !== '').map(([k, v]) => `${k}=${q(v)}`).join(' '));
  for (const [k, r] of mb) if (!ma.has(k)) out.push(`${indent}+ ${key} ${k}: ${clip(row(r))}`);
  for (const k of ma.keys()) if (!mb.has(k)) out.push(`${indent}- ${key} ${k}`);
  for (const [k, r] of mb) {
    const o = ma.get(k);
    if (!o || JSON.stringify(o) === JSON.stringify(r)) continue;
    const ro = o as Record<string, string>, rn = r as Record<string, string>;
    const cols = Array.isArray(r) ? r.map((_, i) => String(i)) : [...new Set([...Object.keys(o), ...Object.keys(r)])];
    out.push(`${indent}~ ${key} ${k}: ${cols.filter((c) => ro[c] !== rn[c]).map((c) => `${c} ${q(ro[c])} -> ${q(rn[c])}`).join(', ')}`);
  }
}

function diffConfig(a: Record<string, Decoded> = {}, b: Record<string, Decoded> = {}, out: string[], indent: string) {
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    if (VOLATILE.has(k)) continue;
    const [va, vb] = [a[k], b[k]];
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    if (Array.isArray(va) || Array.isArray(vb)) diffTable(k, Array.isArray(va) ? va : [], Array.isArray(vb) ? vb : [], out, indent);
    else out.push(`${indent}~ ${k}: ${clip(q(va))} -> ${clip(q(vb))}`);
  }
}

function listConfig(config: Record<string, Decoded> = {}, out: string[], indent: string) {
  for (const [k, v] of Object.entries(config)) {
    if (VOLATILE.has(k)) continue;
    if (Array.isArray(v)) diffTable(k, [], v, out, indent);
    else out.push(`${indent}${k} = ${clip(q(v))}`);
  }
}

// Shapes whose position or size changed (layout), counted only
function layoutChanges(docA: Document, docB: Document): number {
  const boxes = (doc: Document) => new Map(byTag(doc, 'BPMNShape', NS.bpmndi).map((s) => {
    const b = children(s, 'Bounds', NS.dc)[0];
    return [s.getAttribute('bpmnElement'), ['x', 'y', 'width', 'height'].map((k) => b?.getAttribute(k)).join()];
  }));
  const [a, b] = [boxes(docA), boxes(docB)];
  return [...b].filter(([id, box]) => a.has(id) && a.get(id) !== box).length;
}

/** Lines describing the changes; empty = no model change. Display numbers (#n) are those of the new version. */
export function diffIflows(modelA: IflowModel, modelB: IflowModel, { docA, docB }: { docA?: Document; docB?: Document } = {}): string[] {
  const A = flatten(modelA), B = flatten(modelB);
  const out: string[] = [];
  const conf: string[] = [];
  diffConfig(modelA.integrationFlow, modelB.integrationFlow, conf, '  ');
  if (conf.length) out.push('~ integration flow settings', ...conf);

  for (const [id, el] of B.elements) {
    const old = A.elements.get(id);
    if (!old) {
      out.push(`+ ${title(el)}${el.where ? ` in "${el.where}"` : ''}`);
      listConfig(el.config, out, '    ');
      continue;
    }
    const lines: string[] = [];
    if ((old.name ?? '') !== (el.name ?? '')) lines.push(`    renamed from "${old.name}"`);
    if (old.version !== el.version) lines.push(`    version ${old.version} -> ${el.version}`);
    if (old.kind !== el.kind && el.kind !== undefined) lines.push(`    kind ${old.kind} -> ${el.kind}`);
    if (old.defaultFlow !== el.defaultFlow) lines.push(`    default route ${old.defaultFlow ?? '(none)'} -> ${el.defaultFlow ?? '(none)'}`);
    if (el.what === 'adapter' && (old.from !== el.from || old.to !== el.to)) lines.push(`    connects ${old.from} -> ${old.to} became ${el.from} -> ${el.to}`);
    diffConfig(old.config, el.config, lines, '    ');
    if (lines.length) out.push(`~ ${title(el)}`, ...lines);
  }
  for (const [id, el] of A.elements) if (!B.elements.has(id)) out.push(`- ${title({ ...el, no: undefined })}`);

  // Flows: compared as connections between named elements; flow ids themselves do not matter.
  // Numbers always refer to the new version; elements that no longer exist are shown by name only.
  const name = (els: Map<string, Elem>, id: string) => {
    const nb = B.elements.get(id);
    if (nb) return ref(nb);
    const na = els.get(id);
    return na ? ref({ ...na, no: undefined }) : '?';
  };
  const conn = (f: Flow, els: Map<string, Elem>) =>
    `${name(els, f.from)} -> ${name(els, f.to)}${f.name ? ` [${f.name}]` : ''}${f.condition ? ` if ${clip(f.condition)}` : ''}`;
  const edges = (m: ReturnType<typeof flatten>) => new Map([...m.flows.values()].map((f) => [`${f.from}>${f.to}`, f]));
  const [ea, eb] = [edges(A), edges(B)];
  for (const [k, f] of eb) {
    const o = ea.get(k);
    if (!o) out.push(`+ flow ${conn(f, B.elements)}`);
    else if (o.name !== f.name || o.condition !== f.condition) out.push(`~ flow ${conn(o, A.elements)}  became  ${conn(f, B.elements)}`);
  }
  for (const [k, f] of ea) if (!eb.has(k)) out.push(`- flow ${conn(f, A.elements)}`);

  if (docA && docB) {
    const moved = layoutChanges(docA, docB);
    if (moved) out.push(`  (layout: ${moved} shape${moved > 1 ? 's' : ''} moved or resized, not shown)`);
  }
  return out;
}

/** One fact per line, in flow order, no display numbers (an insert would renumber every later line) and no layout */
export function textconv(model: IflowModel): string {
  const out: string[] = [];
  const facts = (config: Record<string, Decoded> | undefined, indent: string) => {
    for (const [k, v] of Object.entries(config ?? {})) {
      if (VOLATILE.has(k)) continue;
      if (!Array.isArray(v)) { out.push(`${indent}${k} = ${q(v)}`); continue; }
      for (const r of v) {
        out.push(`${indent}${k}: ${Array.isArray(r) ? r.join(' | ') : Object.entries(r).filter(([, x]) => x !== '').map(([c, x]) => `${c}=${q(x)}`).join(' ')}`);
      }
    }
  };
  out.push('integration flow');
  facts(model.integrationFlow, '  ');
  for (const p of model.participants) out.push(`participant "${p.name}" (${p.type}) [${p.id}]`);
  for (const a of model.adapters) {
    out.push(`adapter "${a.name ?? ''}" ${a.adapter} ${a.version} ${a.direction}: ${a.from} -> ${a.to} [${a.id}]`);
    facts(a.config, '  ');
  }
  const emit = (container: Container, indent: string) => {
    const ordered = [...container.steps].sort((x, y) => (x.no ?? Infinity) - (y.no ?? Infinity));
    for (const s of ordered) {
      out.push(`${indent}${s.bpmn} "${s.name}" (${[s.kind, s.version].filter(Boolean).join(' ')}) [${s.id}]${s.defaultFlow ? ` default=${s.defaultFlow}` : ''}`);
      facts(s.config, `${indent}  `);
      if (s.steps) emit(s as Step & Container, `${indent}  `);
    }
    const label = (id: string) => `"${container.steps.find((s) => s.id === id)?.name ?? id}"`;
    for (const f of container.flows) out.push(`${indent}flow ${label(f.from)} -> ${label(f.to)}${f.name ? ` [${f.name}]` : ''}${f.condition ? ` if ${f.condition}` : ''} [${f.id}]`);
  };
  for (const proc of model.processes) {
    out.push(`process "${proc.name}" (${proc.kind}) [${proc.id}]`);
    emit(proc, '  ');
  }
  return out.join('\n');
}
