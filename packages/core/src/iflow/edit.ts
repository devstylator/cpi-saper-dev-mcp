// Semantic edits of an .iflw DOM. Changes are surgical (untouched bytes stay identical) and new elements are
// formatted the way SAP's designer writes them, so git diffs stay small and the designer opens the result.
import type { Document, Element, Node } from '@xmldom/xmldom';
import { byTag, children, encodeTable, idIndex, NS, readProps, decodeTable, type Props } from './model.js';

const isEl = (n: Node | null | undefined): n is Element => !!n && n.nodeType === 1;
const fmt = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n)); // SAP writes coordinates as floats

// Always max+1 (never re-use a freed number): monitoring data (RunSteps.ModelStepId) refers to these ids.
function newId(index: Map<string, Element | null>, prefix: string): string {
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  const max = Math.max(0, ...[...index.keys()].map((id) => Number(id.match(re)?.[1] ?? 0)));
  index.set(`${prefix}_${max + 1}`, null);
  return `${prefix}_${max + 1}`;
}

function elementNS(doc: Document, qname: string, attrs: Record<string, string> = {}, text?: string): Element {
  const prefix = qname.split(':')[0] as keyof typeof NS;
  const el = doc.createElementNS(NS[prefix], qname);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.includes(':')) el.setAttributeNS(NS[k.split(':')[0] as keyof typeof NS], k, v); else el.setAttribute(k, v);
  }
  if (text !== undefined) el.appendChild(doc.createTextNode(text));
  return el;
}

function iflProperty(doc: Document, key: string, value: string): Element {
  const p = elementNS(doc, 'ifl:property');
  const k = doc.createElement('key'); k.appendChild(doc.createTextNode(key));
  const v = doc.createElement('value');
  if (value !== '') v.appendChild(doc.createTextNode(value)); // the designer writes empty values as <value/>
  p.appendChild(k); p.appendChild(v);
  return p;
}

// Pretty-print a new subtree the way SAP's editor does (4-space steps, text-only leaves inline).
const INDENT_UNIT = '    ';
function prettify(node: Element, indent: string) {
  const kids = Array.from(node.childNodes).filter(isEl);
  if (!kids.length) return;
  const doc = node.ownerDocument!;
  for (const k of kids) {
    node.insertBefore(doc.createTextNode(`\n${indent}${INDENT_UNIT}`), k);
    prettify(k, indent + INDENT_UNIT);
  }
  node.appendChild(doc.createTextNode(`\n${indent}`));
}
const indentBefore = (el: Element) => {
  const prev = el.previousSibling;
  return prev?.nodeType === 3 && /^\s+$/.test(prev.nodeValue ?? '') ? prev.nodeValue! : '\n';
};
// Insert `node` as the sibling right after element `ref`, with ref's indentation.
function insertAfterEl(parent: Node, node: Element, ref: Element) {
  const ws = indentBefore(ref);
  prettify(node, ws.replace(/^\n/, ''));
  const text = parent.ownerDocument!.createTextNode(ws);
  parent.insertBefore(text, ref.nextSibling);
  parent.insertBefore(node, text.nextSibling);
}
// Remove an element together with the whitespace before it
function removeEl(el: Element) {
  const prev = el.previousSibling;
  if (prev?.nodeType === 3 && /^\s+$/.test(prev.nodeValue ?? '')) prev.parentNode!.removeChild(prev);
  el.parentNode!.removeChild(el);
}

const bounds = (shape: Element) => {
  const b = children(shape, 'Bounds', NS.dc)[0]!;
  return { el: b, x: Number(b.getAttribute('x')), y: Number(b.getAttribute('y')), w: Number(b.getAttribute('width')), h: Number(b.getAttribute('height')) };
};
const shapeOf = (doc: Document, id: string) => byTag(doc, 'BPMNShape', NS.bpmndi).find((s) => s.getAttribute('bpmnElement') === id);
const edgeOf = (doc: Document, id: string) => byTag(doc, 'BPMNEdge', NS.bpmndi).find((e) => e.getAttribute('bpmnElement') === id);

// ---------- references ----------

/** An element by id, or by its exact name when that is unique; "integrationFlow" is the iFlow's own settings */
export function findElement(doc: Document, ref: string): Element {
  if (ref === 'integrationFlow') {
    const c = byTag(doc, 'collaboration')[0];
    if (!c) throw new Error('not an iFlow: no collaboration');
    return c;
  }
  const byId = idIndex(doc).get(ref);
  if (byId) return byId;
  const named = [...byTag(doc, 'messageFlow'), ...['callActivity', 'serviceTask', 'exclusiveGateway', 'parallelGateway', 'subProcess', 'startEvent', 'endEvent', 'intermediateCatchEvent']
    .flatMap((t) => byTag(doc, t))].filter((e) => e.getAttribute('name') === ref);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error(`"${ref}" names ${named.length} elements (${named.map((e) => e.getAttribute('id')).join(', ')}); use the id`);
  throw new Error(`no element with id or name "${ref}"`);
}

// ---------- properties ----------

/** Set existing ifl:property values; unknown keys are rejected unless allowNewKeys (typos would be silently ignored by the runtime) */
export function setProperties(el: Element, values: Props, { allowNewKeys = false } = {}) {
  const doc = el.ownerDocument!;
  let ext = children(el, 'extensionElements')[0];
  const props = new Map(ext ? children(ext, 'property', NS.ifl).map((p) => [keyOf(p), p]) : []);
  const unknown = Object.keys(values).filter((k) => !props.has(k));
  if (unknown.length && !allowNewKeys) {
    throw new Error(`${el.getAttribute('id') ?? el.localName}: unknown setting(s) ${unknown.join(', ')}; existing: ${[...props.keys()].sort().join(', ')}`);
  }
  for (const [k, v] of Object.entries(values)) {
    const p = props.get(k);
    if (p) {
      const value = Array.from(p.childNodes).find((n): n is Element => isEl(n) && n.localName === 'value')!;
      while (value.firstChild) value.removeChild(value.firstChild);
      if (v !== '') value.appendChild(doc.createTextNode(v));
    } else {
      if (!ext) {
        ext = elementNS(doc, 'bpmn2:extensionElements');
        el.insertBefore(ext, el.firstChild);
      }
      const all = children(ext, 'property', NS.ifl);
      const np = iflProperty(doc, k, v);
      if (all.length) insertAfterEl(ext, np, all.at(-1)!); else ext.appendChild(np);
    }
  }
}
// <key> and <value> have no namespace in SAP's files
function keyOf(p: Element) {
  return Array.from(p.childNodes).find((n): n is Element => isEl(n) && n.localName === 'key')?.textContent ?? '';
}

// ---------- Content Modifier tables ----------

export interface TableRowInput {
  name: string;
  value: string;
  /** source of the value; constant (default), expression (Camel Simple), xpath, header, property */
  type?: 'constant' | 'expression' | 'xpath' | 'header' | 'property';
  /** Java type, e.g. java.lang.String; for xpath the result type */
  datatype?: string;
  /** Create (default) or Delete (remove the header/property at runtime) */
  action?: 'Create' | 'Delete';
}
const DEFAULT_COLUMNS = ['Action', 'Type', 'Value', 'Default', 'Name', 'Datatype'];

/** Add or change rows (by name) and remove rows in a Content Modifier's headerTable or propertyTable */
export function editTable(el: Element, table: 'headerTable' | 'propertyTable', { set = [], remove = [] }: { set?: TableRowInput[]; remove?: string[] }) {
  const props = readProps(el);
  if (!(table in props)) throw new Error(`${el.getAttribute('id')}: has no ${table} (not a Content Modifier?)`);
  const decoded = props[table] ? decodeTable(props[table]!) : [];
  if (!Array.isArray(decoded) || decoded.some(Array.isArray)) throw new Error(`${el.getAttribute('id')}: ${table} has an unexpected format`);
  const rows = decoded as Array<Record<string, string>>;
  const columns = rows[0] ? Object.keys(rows[0]) : DEFAULT_COLUMNS;
  for (const name of remove) {
    const i = rows.findIndex((r) => r.Name === name);
    if (i < 0) throw new Error(`${el.getAttribute('id')}: ${table} has no row "${name}"`);
    rows.splice(i, 1);
  }
  for (const r of set) {
    const row: Record<string, string> = {
      Action: r.action ?? 'Create', Type: r.type ?? 'constant', Value: r.value, Default: '', Name: r.name,
      Datatype: r.datatype ?? (r.type === 'xpath' ? 'java.lang.String' : ''),
    };
    const shaped = Object.fromEntries(columns.map((c) => [c, row[c] ?? '']));
    const i = rows.findIndex((x) => x.Name === r.name);
    if (i >= 0) rows[i] = shaped; else rows.push(shaped);
  }
  setProperties(el, { [table]: rows.length ? encodeTable(rows) : '' });
}

// ---------- insert / remove steps ----------

/** Insert a step after another one (which must have exactly one outgoing flow), and open a gap in the diagram */
export function insertStepAfter(doc: Document, afterId: string, { name, properties, bpmn = 'callActivity', size = { w: 100, h: 60 } }:
  { name: string; properties: Props; bpmn?: string; size?: { w: number; h: number } }): { stepId: string; newFlowId: string } {
  const index = idIndex(doc) as Map<string, Element | null>;
  const after = index.get(afterId);
  if (!after) throw new Error(`no element with id ${afterId}`);
  const outgoing = byTag(doc, 'sequenceFlow').filter((f) => f.getAttribute('sourceRef') === afterId);
  if (outgoing.length !== 1) throw new Error(`${afterId} must have exactly one outgoing flow to insert after it (has ${outgoing.length})`);
  const flow = outgoing[0]!;
  const flowId = flow.getAttribute('id')!;
  const targetId = flow.getAttribute('targetRef')!;
  const target = index.get(targetId)!;
  const container = flow.parentNode!;
  const stepId = newId(index, bpmn[0]!.toUpperCase() + bpmn.slice(1));
  const newFlowId = newId(index, 'SequenceFlow');

  // 1) process model: A --flow--> NEW --newFlow--> B
  const step = elementNS(doc, `bpmn2:${bpmn}`, { id: stepId, name });
  const ext = elementNS(doc, 'bpmn2:extensionElements');
  for (const [k, v] of Object.entries(properties)) ext.appendChild(iflProperty(doc, k, v));
  step.appendChild(ext);
  step.appendChild(elementNS(doc, 'bpmn2:incoming', {}, flowId));
  step.appendChild(elementNS(doc, 'bpmn2:outgoing', {}, newFlowId));
  insertAfterEl(container, step, after);
  flow.setAttribute('targetRef', stepId);
  insertAfterEl(container, elementNS(doc, 'bpmn2:sequenceFlow', { id: newFlowId, sourceRef: stepId, targetRef: targetId }), flow);
  for (const inc of children(target, 'incoming')) if (inc.textContent?.trim() === flowId) inc.textContent = newFlowId;

  // 2) diagram: open a gap right of A, place NEW in it, re-route the two edges
  const shapes = byTag(doc, 'BPMNShape', NS.bpmndi);
  const aShape = shapeOf(doc, afterId);
  if (!aShape) throw new Error(`${afterId} has no diagram shape`);
  const a = bounds(aShape);
  const W = size.w, H = size.h, GAP = 50, DX = W + GAP;
  const gapX = a.x + a.w;
  // Only the horizontal band of the pool holding A moves; other (local) process pools stay put.
  const poolIds = new Set(children(byTag(doc, 'collaboration')[0]!, 'participant').map((p) => p.getAttribute('id')));
  const pool = shapes.filter((s) => poolIds.has(s.getAttribute('bpmnElement'))).map(bounds)
    .find((b) => b.x <= a.x && a.x + a.w <= b.x + b.w && b.y <= a.y && a.y + a.h <= b.y + b.h);
  const [top, bottom] = pool ? [pool.y, pool.y + pool.h] : [-Infinity, Infinity];
  for (const s of shapes) {
    const b = bounds(s);
    if (b.y + b.h < top || b.y > bottom) continue;
    if (b.x >= gapX) b.el.setAttribute('x', fmt(b.x + DX));
    else if (b.x + b.w > gapX) b.el.setAttribute('width', fmt(b.w + DX)); // the pool containing the gap grows
  }
  // edges leaving A start a pixel or two right of its border, so they must stay put
  const TOLERANCE = 5;
  for (const wp of byTag(doc, 'waypoint', NS.di)) {
    const y = Number(wp.getAttribute('y'));
    if (y >= top && y <= bottom && Number(wp.getAttribute('x')) > gapX + TOLERANCE) wp.setAttribute('x', fmt(Number(wp.getAttribute('x')) + DX));
  }
  const cy = a.y + a.h / 2;
  const nx = gapX + GAP;
  // Older exports put edge ends on shape borders, newer ones on shape centres: follow the file's convention.
  const oldEdge = edgeOf(doc, flowId);
  const firstWp = oldEdge && children(oldEdge, 'waypoint', NS.di)[0];
  const centred = !!firstWp && Math.abs(Number(firstWp.getAttribute('x')) - (a.x + a.w / 2)) < 1;
  const plane = byTag(doc, 'BPMNPlane', NS.bpmndi)[0]!;
  const shape = elementNS(doc, 'bpmndi:BPMNShape', { bpmnElement: stepId, id: `BPMNShape_${stepId}` });
  shape.appendChild(elementNS(doc, 'dc:Bounds', { height: fmt(H), width: fmt(W), x: fmt(nx), y: fmt(cy - H / 2) }));
  insertAfterEl(plane, shape, aShape);

  if (oldEdge) {
    const last = children(oldEdge, 'waypoint', NS.di).at(-1)!;
    last.setAttribute('x', fmt(centred ? nx + W / 2 : nx)); last.setAttribute('y', fmt(cy));
    oldEdge.setAttribute('targetElement', `BPMNShape_${stepId}`);
  }
  const t = bounds(shapeOf(doc, targetId)!);
  const edge = elementNS(doc, 'bpmndi:BPMNEdge', {
    bpmnElement: newFlowId, id: `BPMNEdge_${newFlowId}`, sourceElement: `BPMNShape_${stepId}`, targetElement: `BPMNShape_${targetId}`,
  });
  const ends = centred ? [[nx + W / 2, cy], [t.x + t.w / 2, t.y + t.h / 2]] : [[nx + W, cy], [t.x, t.y + t.h / 2]];
  for (const [x, y] of ends) edge.appendChild(elementNS(doc, 'di:waypoint', { x: fmt(x!), 'xsi:type': 'dc:Point', y: fmt(y!) }));
  insertAfterEl(plane, edge, oldEdge ?? byTag(doc, 'BPMNEdge', NS.bpmndi).at(-1)!);
  return { stepId, newFlowId };
}

/**
 * Remove a step that has one incoming and one outgoing flow; its predecessor is connected to its successor.
 * When the successor sits to the right on the same row, the gap is closed (the mirror of insertStepAfter).
 */
export function removeStep(doc: Document, stepId: string) {
  const index = idIndex(doc);
  const step = index.get(stepId);
  if (!step) throw new Error(`no element with id ${stepId}`);
  if (!['callActivity', 'serviceTask'].includes(step.localName ?? '')) throw new Error(`${stepId} is a ${step.localName}; only steps can be removed`);
  const incoming = byTag(doc, 'sequenceFlow').filter((f) => f.getAttribute('targetRef') === stepId);
  const outgoing = byTag(doc, 'sequenceFlow').filter((f) => f.getAttribute('sourceRef') === stepId);
  if (incoming.length !== 1 || outgoing.length !== 1) {
    throw new Error(`${stepId} must have exactly one incoming and one outgoing flow to be removed (has ${incoming.length} and ${outgoing.length})`);
  }
  if (byTag(doc, 'messageFlow').some((m) => m.getAttribute('sourceRef') === stepId || m.getAttribute('targetRef') === stepId)) {
    throw new Error(`${stepId} has an adapter connected (Request Reply/Send); remove the adapter in the designer`);
  }
  const [inFlow, outFlow] = [incoming[0]!, outgoing[0]!];
  const targetId = outFlow.getAttribute('targetRef')!;
  const outId = outFlow.getAttribute('id')!;
  inFlow.setAttribute('targetRef', targetId);
  const target = index.get(targetId)!;
  for (const inc of children(target, 'incoming')) if (inc.textContent?.trim() === outId) inc.textContent = inFlow.getAttribute('id');
  // diagram: the incoming edge now ends where the outgoing one ended
  const inEdge = edgeOf(doc, inFlow.getAttribute('id')!);
  const outEdge = edgeOf(doc, outId);
  if (inEdge && outEdge) {
    const end = children(outEdge, 'waypoint', NS.di).at(-1)!;
    const last = children(inEdge, 'waypoint', NS.di).at(-1)!;
    last.setAttribute('x', end.getAttribute('x')!); last.setAttribute('y', end.getAttribute('y')!);
    inEdge.setAttribute('targetElement', outEdge.getAttribute('targetElement') ?? `BPMNShape_${targetId}`);
  }
  const shape = shapeOf(doc, stepId);
  const targetShape = shapeOf(doc, targetId);
  const sourceShape = shapeOf(doc, inFlow.getAttribute('sourceRef')!);
  if (outEdge) removeEl(outEdge);
  if (shape) {
    // close the gap: everything right of the removed step (in the same pool band) moves left by the step's width
    // plus the standard gap, exactly undoing the shift insertStepAfter makes; skipped when the successor would
    // then overlap the predecessor (a layout made by hand with tighter spacing)
    const s = bounds(shape);
    const t = targetShape ? bounds(targetShape) : undefined;
    const p = sourceShape ? bounds(sourceShape) : undefined;
    const dx = s.w + 50;
    const fits = t && p && t.x >= s.x + s.w && t.x - dx >= p.x + p.w;
    removeEl(shape);
    if (fits) {
      const shapes = byTag(doc, 'BPMNShape', NS.bpmndi);
      const poolIds = new Set(children(byTag(doc, 'collaboration')[0]!, 'participant').map((p) => p.getAttribute('id')));
      const pool = shapes.filter((x) => poolIds.has(x.getAttribute('bpmnElement'))).map(bounds)
        .find((b) => b.x <= s.x && s.x + s.w <= b.x + b.w && b.y <= s.y && s.y + s.h <= b.y + b.h);
      const [top, bottom] = pool ? [pool.y, pool.y + pool.h] : [-Infinity, Infinity];
      const edgeX = s.x + s.w;
      for (const sh of shapes) {
        const b = bounds(sh);
        if (b.y + b.h < top || b.y > bottom) continue;
        if (b.x >= edgeX) b.el.setAttribute('x', fmt(b.x - dx));
        else if (b.x + b.w > edgeX) b.el.setAttribute('width', fmt(b.w - dx)); // the pool containing the gap shrinks
      }
      for (const wp of byTag(doc, 'waypoint', NS.di)) {
        const y = Number(wp.getAttribute('y'));
        if (y >= top && y <= bottom && Number(wp.getAttribute('x')) >= edgeX) wp.setAttribute('x', fmt(Number(wp.getAttribute('x')) - dx));
      }
    }
  }
  removeEl(outFlow);
  removeEl(step);
}

export function rename(el: Element, name: string) {
  if (el.localName === 'collaboration') throw new Error('the iFlow itself cannot be renamed here');
  el.setAttribute('name', name);
}
