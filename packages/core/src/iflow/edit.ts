// Semantic edits of an .iflw DOM. Changes are surgical (untouched bytes stay identical) and new elements are
// formatted the way SAP's designer writes them, so git diffs stay small and the designer opens the result.
import type { Document, Element, Node } from '@xmldom/xmldom';
import { byTag, children, encodeTable, idIndex, NS, readProps, decodeTable, type Props } from './model.js';
import { scheduleTable, type Schedule } from '../schedule.js';

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
  let named = [...byTag(doc, 'messageFlow'), ...['callActivity', 'serviceTask', 'exclusiveGateway', 'parallelGateway', 'subProcess', 'startEvent', 'endEvent', 'intermediateCatchEvent']
    .flatMap((t) => byTag(doc, t))].filter((e) => e.getAttribute('name') === ref);
  // Sender/Receiver boxes only when no step or adapter has the name (boxes are often named like their adapter)
  if (!named.length) named = byTag(doc, 'participant').filter((e) => e.getAttribute('name') === ref);
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

const isExceptionSub = (el: Element): boolean =>
  el.localName === 'subProcess' && readProps(el).activityType === 'ErrorEventSubProcessTemplate';

/**
 * The horizontal band that moves when a step is inserted or removed at `a`: inside a subprocess its own box;
 * in a process the pool, but above an exception subprocess drawn below the main row (and below one drawn above),
 * so the main flow and the subprocess shift independently.
 */
function bandFor(doc: Document, a: { x: number; y: number; w: number; h: number }, container: Node): [number, number] {
  if (isEl(container) && container.localName === 'subProcess') {
    const sh = shapeOf(doc, container.getAttribute('id')!);
    if (sh) { const b = bounds(sh); return [b.y, b.y + b.h]; }
  }
  const poolIds = new Set(children(byTag(doc, 'collaboration')[0]!, 'participant').map((p) => p.getAttribute('id')));
  const pool = byTag(doc, 'BPMNShape', NS.bpmndi).filter((s) => poolIds.has(s.getAttribute('bpmnElement'))).map(bounds)
    .find((b) => b.x <= a.x && a.x + a.w <= b.x + b.w && b.y <= a.y && a.y + a.h <= b.y + b.h);
  let [top, bottom] = pool ? [pool.y, pool.y + pool.h] : [-Infinity, Infinity];
  for (const sub of isEl(container) ? children(container, 'subProcess') : []) {
    const sh = shapeOf(doc, sub.getAttribute('id')!);
    if (!sh) continue;
    const b = bounds(sh);
    if (b.y >= a.y + a.h) bottom = Math.min(bottom, b.y - 1);
    else if (b.y + b.h <= a.y) top = Math.max(top, b.y + b.h + 1);
  }
  return [top, bottom];
}

/** Insert a step after another one (which must have exactly one outgoing flow), and open a gap in the diagram */
export function insertStepAfter(doc: Document, afterId: string, { name, properties, bpmn = 'callActivity', size = { w: 100, h: 60 }, flowId: onFlow }:
  { name: string; properties: Props; bpmn?: string; size?: { w: number; h: number }; flowId?: string }): { stepId: string; newFlowId: string } {
  const index = idIndex(doc) as Map<string, Element | null>;
  const after = index.get(afterId);
  if (!after) throw new Error(`no element with id ${afterId}`);
  const outgoing = byTag(doc, 'sequenceFlow').filter((f) => f.getAttribute('sourceRef') === afterId && (!onFlow || f.getAttribute('id') === onFlow));
  if (outgoing.length !== 1) {
    throw new Error(`${afterId} must have exactly one outgoing flow to insert after it (has ${outgoing.length}); for a route of a router or a branch of a multicast, insert on the route ("route")`);
  }
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
  // Only the band holding A moves: other (local) process pools and the other row (main flow or subprocess) stay put.
  const [top, bottom] = bandFor(doc, a, container);
  // when the successor sits further right on the same row with room for the step and a gap on both sides
  // (as in a new iFlow: Start ... End), the step goes into that room and nothing moves
  const tShape = shapeOf(doc, targetId);
  const tb = tShape ? bounds(tShape) : undefined;
  const roomy = !!tb && Math.abs(tb.y + tb.h / 2 - (a.y + a.h / 2)) < 1 && tb.x - gapX >= W + 2 * GAP;
  if (!roomy) {
    const moved = new Set<string>();
    for (const s of shapes) {
      const b = bounds(s);
      if (b.y + b.h < top || b.y > bottom) continue;
      if (b.x >= gapX) { b.el.setAttribute('x', fmt(b.x + DX)); moved.add(s.getAttribute('bpmnElement')!); }
      else if (b.x + b.w > gapX) b.el.setAttribute('width', fmt(b.w + DX)); // the pool containing the gap grows
    }
    // edges leaving A start a pixel or two right of its border, so they must stay put
    const TOLERANCE = 5;
    for (const wp of byTag(doc, 'waypoint', NS.di)) {
      const y = Number(wp.getAttribute('y'));
      if (y >= top && y <= bottom && Number(wp.getAttribute('x')) > gapX + TOLERANCE) wp.setAttribute('x', fmt(Number(wp.getAttribute('x')) + DX));
    }
    followAdapters(doc, moved, DX, top, bottom);
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
    throw new Error(`${stepId} has an adapter connected; remove the adapter first (remove_adapter)`);
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
      const [top, bottom] = bandFor(doc, s, step.parentNode!);
      const edgeX = s.x + s.w;
      const moved = new Set<string>();
      for (const sh of shapes) {
        const b = bounds(sh);
        if (b.y + b.h < top || b.y > bottom) continue;
        if (b.x >= edgeX) { b.el.setAttribute('x', fmt(b.x - dx)); moved.add(sh.getAttribute('bpmnElement')!); }
        else if (b.x + b.w > edgeX) b.el.setAttribute('width', fmt(b.w - dx)); // the pool containing the gap shrinks
      }
      for (const wp of byTag(doc, 'waypoint', NS.di)) {
        const y = Number(wp.getAttribute('y'));
        if (y >= top && y <= bottom && Number(wp.getAttribute('x')) >= edgeX) wp.setAttribute('x', fmt(Number(wp.getAttribute('x')) - dx));
      }
      followAdapters(doc, moved, -dx, top, bottom);
    }
  }
  removeEl(outFlow);
  removeEl(step);
}

// ---------- adapters (message flows between a Sender/Receiver box and the process) ----------

const BOX = { w: 100, h: 140 };
type Bounds = ReturnType<typeof bounds>;

/** Bounds of the process pools (Integration Process, Local Integration Processes) */
function poolBounds(doc: Document): Array<Bounds & { id: string }> {
  const ids = new Set(children(byTag(doc, 'collaboration')[0]!, 'participant').filter((p) => p.getAttribute('ifl:type') === 'IntegrationProcess').map((p) => p.getAttribute('id')));
  return byTag(doc, 'BPMNShape', NS.bpmndi).filter((x) => ids.has(x.getAttribute('bpmnElement'))).map((x) => ({ ...bounds(x), id: x.getAttribute('bpmnElement')! }));
}
const poolAround = (doc: Document, b: { x: number; y: number; w: number; h: number }) =>
  poolBounds(doc).find((p) => p.x <= b.x && b.x + b.w <= p.x + p.w && p.y <= b.y && b.y + b.h <= p.y + p.h);
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Place a Sender/Receiver box. A start event's sender sits left of the pool, level with the event (as in a new
 * iFlow). Every other box (receivers, Poll Enrich senders) sits below the pool under its step, so its line runs
 * straight down instead of along the flow; above the pool when something is in the way below.
 */
function placeBox(doc: Document, shape: Element, step: Bounds, sideways: boolean) {
  const pool = poolAround(doc, step);
  const others = byTag(doc, 'BPMNShape', NS.bpmndi).filter((x) => x !== shape).map(bounds);
  const free = (c: { x: number; y: number }) => !others.some((b) => overlaps({ ...c, ...BOX }, b));
  let c: { x: number; y: number };
  if (sideways) {
    c = { x: (pool ? pool.x : step.x) - 110 - BOX.w, y: step.y + step.h / 2 - BOX.h / 2 };
  } else {
    const x = step.x + step.w / 2 - BOX.w / 2;
    const below = { x, y: (pool ? pool.y + pool.h : step.y + step.h) + 60 };
    const above = { x, y: (pool ? pool.y : step.y) - 60 - BOX.h };
    // the line runs straight down (or up) from the step: it must not cross other shapes inside the pool, such as
    // an exception subprocess drawn below the main row
    const pools = new Set(poolBounds(doc).map((p) => `${p.x},${p.y}`));
    const inside = others.filter((b) => !pools.has(`${b.x},${b.y}`) && !(b.x === step.x && b.y === step.y));
    const cx = step.x + step.w / 2;
    const clear = (c: { y: number }) => {
      const [y1, y2] = c.y > step.y ? [step.y + step.h, c.y] : [c.y + BOX.h, step.y];
      return !inside.some((b) => b.x <= cx && cx <= b.x + b.w && b.y < y2 && y1 < b.y + b.h);
    };
    const good = (c: { x: number; y: number }) => free(c) && clear(c);
    c = good(below) || (!good(above) && (free(below) || !free(above))) ? below : above;
  }
  while (!free(c)) c = { x: c.x, y: Math.max(...others.filter((b) => overlaps({ ...c, ...BOX }, b)).map((b) => b.y + b.h)) + 30 };
  const b = bounds(shape).el;
  b.setAttribute('x', fmt(c.x)); b.setAttribute('y', fmt(c.y));
}

/** When a box was placed above the top of the diagram, move the whole diagram down so it starts at y 20 again */
function keepOnCanvas(doc: Document) {
  const shapes = byTag(doc, 'BPMNShape', NS.bpmndi).map(bounds);
  const dy = 20 - Math.min(...shapes.map((b) => b.y));
  if (!shapes.length || dy <= 0) return;
  for (const b of shapes) b.el.setAttribute('y', fmt(b.y + dy));
  for (const wp of byTag(doc, 'waypoint', NS.di)) wp.setAttribute('y', fmt(Number(wp.getAttribute('y')) + dy));
}

/** Message flow lines run from centre to centre, as the designer draws them */
function routeAdapters(doc: Document, touching?: Set<string>) {
  const centre = (id: string) => { const sh = shapeOf(doc, id); if (!sh) return undefined; const b = bounds(sh); return [b.x + b.w / 2, b.y + b.h / 2] as const; };
  for (const mf of byTag(doc, 'messageFlow')) {
    const [from, to] = [mf.getAttribute('sourceRef')!, mf.getAttribute('targetRef')!];
    if (touching && !touching.has(from) && !touching.has(to)) continue;
    const edge = edgeOf(doc, mf.getAttribute('id')!);
    const wps = edge ? children(edge, 'waypoint', NS.di) : [];
    const [a, z] = [centre(from), centre(to)];
    if (wps.length < 2 || !a || !z) continue;
    wps[0]!.setAttribute('x', fmt(a[0])); wps[0]!.setAttribute('y', fmt(a[1]));
    wps.at(-1)!.setAttribute('x', fmt(z[0])); wps.at(-1)!.setAttribute('y', fmt(z[1]));
  }
}

/**
 * After steps moved sideways by dx: boxes below or above the pool that are connected to a moved step move along
 * (boxes inside the moved band already did), and the lines of the moved steps' adapters are re-drawn.
 */
function followAdapters(doc: Document, moved: Set<string>, dx: number, top: number, bottom: number) {
  for (const mf of byTag(doc, 'messageFlow')) {
    const ends = [mf.getAttribute('sourceRef')!, mf.getAttribute('targetRef')!];
    const step = ends.find((e) => moved.has(e));
    const box = ends.find((e) => e !== step);
    const sh = step && box && !moved.has(box) ? shapeOf(doc, box) : undefined;
    if (!sh) continue;
    const b = bounds(sh);
    if (b.y + b.h < top || b.y > bottom) { b.el.setAttribute('x', fmt(b.x + dx)); moved.add(box!); }
  }
  routeAdapters(doc, moved);
}

export type AdapterDirection = 'Sender' | 'Receiver';
// SAP spells the receiver type this way
const PARTICIPANT_TYPE: Record<AdapterDirection, string> = { Sender: 'EndpointSender', Receiver: 'EndpointRecevier' };

/**
 * Which adapter direction an element takes: a message start event or a Poll Enrich is fed by a sender adapter;
 * Request Reply, Send, Content Enricher and a message end event call a receiver.
 */
export function adapterDirectionFor(el: Element): AdapterDirection {
  const kind = el.localName;
  const message = children(el, 'messageEventDefinition').length > 0;
  if (kind === 'startEvent' && message) return 'Sender';
  if (kind === 'endEvent' && message) return 'Receiver';
  if (kind === 'serviceTask') return readProps(el).activityType === 'PollEnrich' ? 'Sender' : 'Receiver';
  throw new Error(`${el.getAttribute('id')} (${kind}${message ? '' : ', no message event'}) cannot have an adapter; ` +
    'adapters connect to a message start event, a message end event, Request Reply, Send, Content Enricher or Poll Enrich');
}

/**
 * Connect an adapter to a step: a message flow (with the given settings) between the step and a Sender/Receiver
 * box. The box is the one named in `participant` (created if no such box exists), else the first box of that
 * direction without an adapter, else a new one ("Receiver1", ...), placed beside the process like the designer does.
 */
export function addAdapter(doc: Document, stepId: string, { name, properties, direction, participant }:
  { name: string; properties: Props; direction: AdapterDirection; participant?: string }): { flowId: string; participantId: string; participantName: string; createdParticipant: boolean } {
  const index = idIndex(doc) as Map<string, Element | null>;
  const step = index.get(stepId);
  if (!step) throw new Error(`no element with id ${stepId}`);
  if (adapterDirectionFor(step) !== direction) throw new Error(`${stepId} needs a ${adapterDirectionFor(step).toLowerCase()} adapter, not a ${direction.toLowerCase()} adapter`);
  const collab = byTag(doc, 'collaboration')[0]!;
  const flows = children(collab, 'messageFlow');
  const taken = flows.find((f) => f.getAttribute('sourceRef') === stepId || f.getAttribute('targetRef') === stepId);
  if (taken) throw new Error(`${stepId} already has an adapter (${taken.getAttribute('id')} "${taken.getAttribute('name')}"); remove it first`);

  const type = PARTICIPANT_TYPE[direction];
  const boxes = children(collab, 'participant').filter((p) => p.getAttribute('ifl:type') === type);
  const connected = (p: Element) => flows.some((f) => [f.getAttribute('sourceRef'), f.getAttribute('targetRef')].includes(p.getAttribute('id')));
  const named = participant ? children(collab, 'participant').find((p) => p.getAttribute('id') === participant || p.getAttribute('name') === participant) : undefined;
  if (named && named.getAttribute('ifl:type') !== type) throw new Error(`${participant} is not a ${direction.toLowerCase()} box`);
  let box = participant ? named : boxes.find((p) => !connected(p));
  const plane = byTag(doc, 'BPMNPlane', NS.bpmndi)[0]!;
  const stepShape = shapeOf(doc, stepId);
  if (!stepShape) throw new Error(`${stepId} has no diagram shape`);
  const sideways = direction === 'Sender' && step.localName === 'startEvent';
  const created = !box;
  if (!box) {
    const names = new Set(children(collab, 'participant').map((p) => p.getAttribute('name')));
    let boxName = participant;
    for (let n = 1; !boxName; n++) if (!names.has(`${direction}${n}`)) boxName = `${direction}${n}`;
    const boxId = newId(index, 'Participant');
    box = elementNS(doc, 'bpmn2:participant', { id: boxId, 'ifl:type': type, name: boxName });
    const ext = elementNS(doc, 'bpmn2:extensionElements');
    const props: Props = {
      ...(direction === 'Sender' ? { enableBasicAuthentication: 'false' } : {}),
      'ifl:type': type, cmdVariantUri: `ctype::FlowstepVariant/cname::${direction}/version::1.0`, componentVersion: '1.0',
    };
    for (const [k, v] of Object.entries(props)) ext.appendChild(iflProperty(doc, k, v));
    box.appendChild(ext);
    insertAfterEl(collab, box, children(collab, 'participant').filter((p) => p.getAttribute('ifl:type') !== 'IntegrationProcess').at(-1) ?? children(collab, 'participant')[0]!);
    const shape = elementNS(doc, 'bpmndi:BPMNShape', { bpmnElement: boxId, id: `BPMNShape_${boxId}` });
    shape.appendChild(elementNS(doc, 'dc:Bounds', { height: fmt(BOX.h), width: fmt(BOX.w), x: '0.0', y: '0.0' }));
    insertAfterEl(plane, shape, byTag(doc, 'BPMNShape', NS.bpmndi).at(-1)!);
    placeBox(doc, shape, bounds(stepShape), sideways);
  } else if (!connected(box) && !sideways) {
    // a free box (like the one a new iFlow comes with) is moved under its step
    const shape = shapeOf(doc, box.getAttribute('id')!);
    if (shape) placeBox(doc, shape, bounds(stepShape), false);
  }
  keepOnCanvas(doc);
  const boxId = box.getAttribute('id')!;
  const boxName = box.getAttribute('name') ?? boxId;
  if (direction === 'Receiver' && connected(box)) throw new Error(`${boxName} already has an adapter; a receiver box takes one adapter`);

  const flowId = newId(index, 'MessageFlow');
  const [from, to] = direction === 'Sender' ? [boxId, stepId] : [stepId, boxId];
  const flow = elementNS(doc, 'bpmn2:messageFlow', { id: flowId, name, sourceRef: from, targetRef: to });
  const ext = elementNS(doc, 'bpmn2:extensionElements');
  for (const [k, v] of Object.entries({ ...properties, ...('system' in properties ? { system: boxName } : {}) })) ext.appendChild(iflProperty(doc, k, v));
  flow.appendChild(ext);
  insertAfterEl(collab, flow, flows.at(-1) ?? children(collab, 'participant').at(-1)!);

  // edge from centre to centre, as the designer draws message flows
  const centre = (id: string) => { const b = bounds(shapeOf(doc, id)!); return [b.x + b.w / 2, b.y + b.h / 2] as const; };
  const edge = elementNS(doc, 'bpmndi:BPMNEdge', { bpmnElement: flowId, id: `BPMNEdge_${flowId}`, sourceElement: `BPMNShape_${from}`, targetElement: `BPMNShape_${to}` });
  for (const [x, y] of [centre(from), centre(to)]) edge.appendChild(elementNS(doc, 'di:waypoint', { x: fmt(x), 'xsi:type': 'dc:Point', y: fmt(y) }));
  insertAfterEl(plane, edge, byTag(doc, 'BPMNEdge', NS.bpmndi).at(-1) ?? byTag(doc, 'BPMNShape', NS.bpmndi).at(-1)!);
  keepOnCanvas(doc);
  return { flowId, participantId: boxId, participantName: boxName, createdParticipant: created };
}

/** Remove an adapter (message flow and its edge); the Sender/Receiver box stays, as in the designer */
export function removeAdapter(doc: Document, flowId: string) {
  const flow = idIndex(doc).get(flowId);
  if (flow?.localName !== 'messageFlow') throw new Error(`${flowId} is not an adapter (message flow)`);
  const edge = edgeOf(doc, flowId);
  if (edge) removeEl(edge);
  removeEl(flow);
}

// ---------- routers and multicasts ----------

/** A route (sequence flow) by id or unique name */
export function findRoute(doc: Document, ref: string): Element {
  const flows = byTag(doc, 'sequenceFlow');
  const hit = flows.filter((f) => f.getAttribute('id') === ref);
  const named = hit.length ? hit : flows.filter((f) => f.getAttribute('name') === ref);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error(`"${ref}" names ${named.length} routes (${named.map((f) => f.getAttribute('id')).join(', ')}); use the id`);
  throw new Error(`no route (sequence flow) with id or name "${ref}"`);
}

const flowEl = (doc: Document, id: string, from: string, to: string, name?: string) =>
  elementNS(doc, 'bpmn2:sequenceFlow', { id, ...(name ? { name } : {}), sourceRef: from, targetRef: to });
const withProps = (doc: Document, el: Element, props: Props) => {
  if (!Object.keys(props).length) return el;
  const ext = elementNS(doc, 'bpmn2:extensionElements');
  for (const [k, v] of Object.entries(props)) ext.appendChild(iflProperty(doc, k, v));
  el.insertBefore(ext, el.firstChild);
  return el;
};
const condition = (doc: Document, flowId: string, text: string) =>
  elementNS(doc, 'bpmn2:conditionExpression', { id: `FormalExpression_${flowId}_${Date.now()}`, 'xsi:type': 'bpmn2:tFormalExpression' }, text);
const setRefs = (el: Element, tag: 'incoming' | 'outgoing', ids: string[]) => {
  for (const r of children(el, tag)) removeEl(r);
  const doc = el.ownerDocument!;
  // incoming before outgoing, after the settings, as the designer writes them
  const anchor = tag === 'incoming' ? children(el, 'outgoing')[0] ?? Array.from(el.childNodes).filter(isEl).find((c) => !['extensionElements', 'incoming'].includes(c.localName ?? ''))
    : Array.from(el.childNodes).filter(isEl).find((c) => !['extensionElements', 'incoming', 'outgoing'].includes(c.localName ?? ''));
  const indent = indentBefore(Array.from(el.childNodes).filter(isEl)[0] ?? el);
  for (const id of ids) {
    const r = elementNS(doc, `bpmn2:${tag}`, {}, id);
    if (anchor) { el.insertBefore(doc.createTextNode(indent), anchor); el.insertBefore(r, anchor); } else { el.appendChild(doc.createTextNode(indent)); el.appendChild(r); }
  }
  // keep the closing tag on its own line
  if (!anchor && ids.length) el.appendChild(doc.createTextNode(indentBefore(el)));
};
const refsOf = (el: Element, tag: 'incoming' | 'outgoing') => children(el, tag).map((r) => r.textContent?.trim() ?? '');

/** New elements of a branching edit: model elements after `ref`, shapes and edges at a temporary place until layout */
function addDiagram(doc: Document, shapes: Array<{ id: string; w: number; h: number }>, edges: Array<{ id: string; from: string; to: string }>) {
  const plane = byTag(doc, 'BPMNPlane', NS.bpmndi)[0]!;
  let last = byTag(doc, 'BPMNShape', NS.bpmndi).at(-1)!;
  for (const s of shapes) {
    const sh = elementNS(doc, 'bpmndi:BPMNShape', { bpmnElement: s.id, id: `BPMNShape_${s.id}` });
    sh.appendChild(elementNS(doc, 'dc:Bounds', { height: fmt(s.h), width: fmt(s.w), x: '0.0', y: '0.0' }));
    insertAfterEl(plane, sh, last);
    last = sh;
  }
  for (const e of edges) {
    const edge = elementNS(doc, 'bpmndi:BPMNEdge', { bpmnElement: e.id, id: `BPMNEdge_${e.id}`, sourceElement: `BPMNShape_${e.from}`, targetElement: `BPMNShape_${e.to}` });
    for (let i = 0; i < 2; i++) edge.appendChild(elementNS(doc, 'di:waypoint', { x: '0.0', 'xsi:type': 'dc:Point', y: '0.0' }));
    insertAfterEl(plane, edge, byTag(doc, 'BPMNEdge', NS.bpmndi).at(-1) ?? last);
  }
}

/** The single outgoing flow of the element a branch is inserted after */
function splitPoint(doc: Document, afterId: string) {
  const index = idIndex(doc) as Map<string, Element | null>;
  const after = index.get(afterId);
  if (!after) throw new Error(`no element with id ${afterId}`);
  const out = byTag(doc, 'sequenceFlow').filter((f) => f.getAttribute('sourceRef') === afterId);
  if (out.length !== 1) throw new Error(`${afterId} must have exactly one outgoing flow to add a router or multicast after it (has ${out.length})`);
  const flow = out[0]!;
  const target = index.get(flow.getAttribute('targetRef')!)!;
  if (!target) throw new Error(`${flow.getAttribute('id')} leads nowhere`);
  return { index, after, flow, target, container: flow.parentNode as Element };
}

/** A message end event, like the one a process ends with */
function endEventEl(doc: Document, id: string, name: string, props: Props, incoming: string) {
  const e = withProps(doc, elementNS(doc, 'bpmn2:endEvent', { id, name }), props);
  e.appendChild(elementNS(doc, 'bpmn2:incoming', {}, incoming));
  e.appendChild(elementNS(doc, 'bpmn2:messageEventDefinition'));
  return e;
}

export interface RouteInput { name: string; condition?: string; end?: boolean }

/**
 * Add a router after a step: one route per entry, all leading to the step that followed (or each to its own End
 * event with end: true). Exactly one route has no condition: the default route. Conditions are XPath
 * (expressionType "XML") or Camel Simple ("NonXML"), the same for all routes of a router.
 */
export function addRouter(doc: Document, afterId: string, { name, gatewayProps, routeProps, endProps, routes }:
  { name: string; gatewayProps: Props; routeProps: Props; endProps: Props; routes: RouteInput[] }): { gatewayId: string; routeIds: string[]; endIds: string[] } {
  if (routes.length < 2) throw new Error('a router needs at least two routes');
  const defaults = routes.filter((r) => !r.condition?.trim());
  if (defaults.length !== 1) throw new Error(`exactly one route must have no condition (the default route); ${defaults.length ? defaults.map((r) => `"${r.name}"`).join(', ') : 'none'} has none`);
  const names = routes.map((r) => r.name);
  if (new Set(names).size !== names.length) throw new Error('route names must be different');
  const { index, after, flow, target, container } = splitPoint(doc, afterId);
  const targetId = target.getAttribute('id')!;
  const gatewayId = newId(index, 'ExclusiveGateway');
  // the default route first: it stays on the main row
  const ordered = [defaults[0]!, ...routes.filter((r) => r !== defaults[0])];
  const ids = ordered.map(() => newId(index, 'SequenceFlow'));
  const ends = ordered.map((r) => (r.end ? newId(index, 'EndEvent') : undefined));
  const endNames = new Set(byTag(doc, 'endEvent').map((e) => e.getAttribute('name')));

  const gw = elementNS(doc, 'bpmn2:exclusiveGateway', { default: ids[0]!, id: gatewayId, name });
  withProps(doc, gw, gatewayProps);
  gw.appendChild(elementNS(doc, 'bpmn2:incoming', {}, flow.getAttribute('id')!));
  for (const id of ids) gw.appendChild(elementNS(doc, 'bpmn2:outgoing', {}, id));
  insertAfterEl(container, gw, after);
  let ref: Element = gw;
  ordered.forEach((r, i) => {
    if (!ends[i]) return;
    let n = 1; let endName = `End ${r.name}`;
    while (endNames.has(endName)) endName = `End ${r.name} ${++n}`;
    endNames.add(endName);
    const e = endEventEl(doc, ends[i]!, endName, endProps, ids[i]!);
    insertAfterEl(container, e, ref); ref = e;
  });
  // A -> router; routes after A's flow
  const oldFlowId = flow.getAttribute('id')!;
  flow.setAttribute('targetRef', gatewayId);
  let fref: Element = flow;
  ordered.forEach((r, i) => {
    const f = withProps(doc, flowEl(doc, ids[i]!, gatewayId, ends[i] ?? targetId, r.name), routeProps);
    if (r.condition?.trim()) f.appendChild(condition(doc, ids[i]!, r.condition.trim()));
    insertAfterEl(container, f, fref); fref = f;
  });
  const toTarget = ids.filter((_, i) => !ends[i]);
  setRefs(target, 'incoming', [...refsOf(target, 'incoming').filter((x) => x !== oldFlowId), ...toTarget]);
  addDiagram(doc, [{ id: gatewayId, w: 40, h: 40 }, ...ends.filter((e): e is string => !!e).map((id) => ({ id, w: 32, h: 32 }))],
    ids.map((id, i) => ({ id, from: gatewayId, to: ends[i] ?? targetId })));
  return { gatewayId, routeIds: ids, endIds: ends.filter((e): e is string => !!e) };
}

/**
 * Add a parallel or sequential multicast after a step: one branch per name; with join (the default) the branches
 * meet in a Join before the step that followed; without, the first branch leads to that step and every other one
 * ends in its own End event. A sequential multicast runs the branches in the order given.
 */
export function addMulticast(doc: Document, afterId: string, { name, gatewayProps, joinProps, endProps, branches, join, sequential }:
  { name: string; gatewayProps: Props; joinProps: Props; endProps: Props; branches: string[]; join: boolean; sequential: boolean }):
  { gatewayId: string; joinId?: string; branchIds: string[]; endIds: string[] } {
  if (branches.length < 2) throw new Error('a multicast needs at least two branches');
  if (new Set(branches).size !== branches.length) throw new Error('branch names must be different');
  const { index, after, flow, target, container } = splitPoint(doc, afterId);
  const targetId = target.getAttribute('id')!;
  const gatewayId = newId(index, 'ParallelGateway');
  const joinId = join ? newId(index, 'ParallelGateway') : undefined;
  const ids = branches.map(() => newId(index, 'SequenceFlow'));
  const joinOut = join ? newId(index, 'SequenceFlow') : undefined;
  const ends = branches.map((_, i) => (!join && i > 0 ? newId(index, 'EndEvent') : undefined));
  const props = sequential
    ? { ...gatewayProps, routingSequenceTable: ids.map((id, i) => `<row><cell>${i + 1}</cell><cell>${id}</cell></row>`).join('') }
    : gatewayProps;

  const gw = withProps(doc, elementNS(doc, 'bpmn2:parallelGateway', { id: gatewayId, name }), props);
  gw.appendChild(elementNS(doc, 'bpmn2:incoming', {}, flow.getAttribute('id')!));
  for (const id of ids) gw.appendChild(elementNS(doc, 'bpmn2:outgoing', {}, id));
  insertAfterEl(container, gw, after);
  let ref: Element = gw;
  if (joinId) {
    const j = withProps(doc, elementNS(doc, 'bpmn2:parallelGateway', { id: joinId, name: 'Join' }), joinProps);
    for (const id of ids) j.appendChild(elementNS(doc, 'bpmn2:incoming', {}, id));
    j.appendChild(elementNS(doc, 'bpmn2:outgoing', {}, joinOut!));
    insertAfterEl(container, j, ref); ref = j;
  }
  ends.forEach((e, i) => { if (e) { const el = endEventEl(doc, e, `End ${branches[i]}`, endProps, ids[i]!); insertAfterEl(container, el, ref); ref = el; } });
  const oldFlowId = flow.getAttribute('id')!;
  flow.setAttribute('targetRef', gatewayId);
  let fref: Element = flow;
  ids.forEach((id, i) => { const f = flowEl(doc, id, gatewayId, joinId ?? ends[i] ?? targetId, branches[i]); insertAfterEl(container, f, fref); fref = f; });
  if (joinId) { const f = flowEl(doc, joinOut!, joinId, targetId); insertAfterEl(container, f, fref); }
  setRefs(target, 'incoming', [...refsOf(target, 'incoming').filter((x) => x !== oldFlowId), ...(joinId ? [joinOut!] : [ids[0]!])]);
  addDiagram(doc, [{ id: gatewayId, w: 40, h: 40 }, ...(joinId ? [{ id: joinId, w: 40, h: 40 }] : []), ...ends.filter((e): e is string => !!e).map((id) => ({ id, w: 32, h: 32 }))],
    [...ids.map((id, i) => ({ id, from: gatewayId, to: joinId ?? ends[i] ?? targetId })), ...(joinId ? [{ id: joinOut!, from: joinId, to: targetId }] : [])]);
  return { gatewayId, ...(joinId ? { joinId } : {}), branchIds: ids, endIds: ends.filter((e): e is string => !!e) };
}

/**
 * Change a router's route: its name, its condition, or make it the default route. The routes then swap roles: the
 * route that was the default takes over this route's condition (a router has exactly one route without one).
 */
export function setRoute(doc: Document, ref: string, { name, condition: cond, makeDefault }: { name?: string; condition?: string; makeDefault?: boolean }): string {
  const route = findRoute(doc, ref);
  const id = route.getAttribute('id')!;
  const gw = idIndex(doc).get(route.getAttribute('sourceRef')!);
  if (gw?.localName !== 'exclusiveGateway') throw new Error(`${id} is not a route of a router`);
  const isDefault = gw.getAttribute('default') === id;
  const setCond = (f: Element, text: string | undefined) => {
    const old = children(f, 'conditionExpression')[0];
    if (old) removeEl(old);
    if (!text) return;
    // routes of a router carry their settings, so the condition goes after the last child
    const last = Array.from(f.childNodes).filter(isEl).at(-1);
    if (!last) throw new Error(`${f.getAttribute('id')} has no route settings; set its condition in the designer`);
    insertAfterEl(f, condition(doc, f.getAttribute('id')!, text), last);
  };
  const done: string[] = [];
  if (name !== undefined) { route.setAttribute('name', name); done.push(`renamed to "${name}"`); }
  if (makeDefault && !isDefault) {
    const old = idIndex(doc).get(gw.getAttribute('default') ?? '');
    const moved = cond?.trim() || children(route, 'conditionExpression')[0]?.textContent?.trim();
    if (old) {
      if (!moved) throw new Error(`give ${id} a condition or pass "condition": the old default route ${old.getAttribute('id')} takes it`);
      setCond(old, moved);
    }
    setCond(route, undefined);
    gw.setAttribute('default', id);
    done.push(`made the default route${old ? `; ${old.getAttribute('id')} takes the condition ${moved}` : ''}`);
  } else if (cond !== undefined) {
    if (isDefault) throw new Error(`${id} is the default route and has no condition; make another route the default first (set_route default: true)`);
    if (!cond.trim()) throw new Error('a route other than the default needs a condition');
    setCond(route, cond.trim());
    done.push(`condition ${cond.trim()}`);
  }
  if (!done.length) throw new Error('nothing to change: pass name, condition or default');
  return `${id}: ${done.join(', ')}`;
}

/**
 * Remove a router or multicast whose routes are empty again: every route leads straight to the same next element
 * (or to a Join, or to an End event of its own). The step before is connected to that element; the router or
 * multicast, its routes, its Join and those End events go.
 */
export function removeGateway(doc: Document, ref: string): string {
  const gw = findElement(doc, ref);
  const gwId = gw.getAttribute('id')!;
  const type = readProps(gw).activityType;
  if (!['exclusiveGateway', 'parallelGateway'].includes(gw.localName ?? '') || type === 'Join') {
    throw new Error(`${gwId} is not a router or multicast${type === 'Join' ? ' (a Join goes with its multicast)' : ''}`);
  }
  const index = idIndex(doc);
  const flows = byTag(doc, 'sequenceFlow');
  const inc = flows.filter((f) => f.getAttribute('targetRef') === gwId);
  if (inc.length !== 1) throw new Error(`${gwId} must have exactly one incoming flow (has ${inc.length})`);
  const routes = flows.filter((f) => f.getAttribute('sourceRef') === gwId);
  const targetOf = (f: Element) => index.get(f.getAttribute('targetRef')!)!;
  const ownEnd = (el: Element) => el.localName === 'endEvent' && flows.filter((f) => f.getAttribute('targetRef') === el.getAttribute('id')).length === 1
    && !byTag(doc, 'messageFlow').some((m) => [m.getAttribute('sourceRef'), m.getAttribute('targetRef')].includes(el.getAttribute('id')));
  const joins = new Set(routes.map(targetOf).filter((t) => readProps(t).activityType === 'Join'));
  let join = joins.size === 1 ? [...joins][0]! : undefined;
  if (join && flows.some((f) => f.getAttribute('targetRef') === join!.getAttribute('id') && f.getAttribute('sourceRef') !== gwId)) join = undefined;
  const joinOut = join ? flows.find((f) => f.getAttribute('sourceRef') === join!.getAttribute('id')) : undefined;
  const dflt = routes.find((f) => f.getAttribute('id') === gw.getAttribute('default')) ?? routes[0]!;
  const next = joinOut ? targetOf(joinOut) : targetOf(dflt);
  const blocked = routes.filter((f) => { const t = targetOf(f); return t !== next && t !== join && !ownEnd(t); });
  if (blocked.length) {
    throw new Error(`routes of ${gwId} still have steps: ${blocked.map((f) => `${f.getAttribute('name') ?? f.getAttribute('id')} -> ${targetOf(f).getAttribute('name') ?? targetOf(f).getAttribute('id')}`).join(', ')}; remove those first`);
  }
  const gone = new Set<string>([gwId, ...routes.map((f) => f.getAttribute('id')!)]);
  for (const f of routes) { const t = targetOf(f); if (t !== next && t !== join) gone.add(t.getAttribute('id')!); }
  if (join) { gone.add(join.getAttribute('id')!); gone.add(joinOut!.getAttribute('id')!); }
  const inFlow = inc[0]!;
  inFlow.setAttribute('targetRef', next.getAttribute('id')!);
  setRefs(next, 'incoming', [...refsOf(next, 'incoming').filter((x) => !gone.has(x)), inFlow.getAttribute('id')!]);
  for (const di of [...byTag(doc, 'BPMNShape', NS.bpmndi), ...byTag(doc, 'BPMNEdge', NS.bpmndi)]) if (gone.has(di.getAttribute('bpmnElement')!)) removeEl(di);
  for (const id of gone) { const el = index.get(id); if (el?.parentNode) removeEl(el); }
  const edge = edgeOf(doc, inFlow.getAttribute('id')!);
  if (edge) edge.setAttribute('targetElement', `BPMNShape_${next.getAttribute('id')}`);
  return `removed ${gwId}${join ? ` and its Join ${join.getAttribute('id')}` : ''} with ${routes.length} routes; ${inFlow.getAttribute('sourceRef')} leads to ${next.getAttribute('id')} again`;
}

// ---------- local integration processes ----------

/** A process by id or name that is a local integration process (processType directCall) */
export function findLocalProcess(doc: Document, ref: string): Element {
  const p = findProcess(doc, ref);
  if (readProps(p).processType !== 'directCall') throw new Error(`${p.getAttribute('id')} "${p.getAttribute('name')}" is not a local integration process`);
  return p;
}

const plainEvent = (doc: Document, tag: 'startEvent' | 'endEvent', id: string, name: string, flow: string) => {
  const el = elementNS(doc, `bpmn2:${tag}`, { id, name });
  const ext = elementNS(doc, 'bpmn2:extensionElements');
  const cname = tag === 'startEvent' ? 'StartEvent' : 'EndEvent';
  ext.appendChild(iflProperty(doc, 'cmdVariantUri', `ctype::FlowstepVariant/cname::${cname}`));
  ext.appendChild(iflProperty(doc, 'activityType', cname));
  el.appendChild(ext);
  el.appendChild(elementNS(doc, tag === 'startEvent' ? 'bpmn2:outgoing' : 'bpmn2:incoming', {}, flow));
  return el;
};

/**
 * Add a local integration process, as the designer does: a pool (540 x 220) below all pools, its process (the
 * catalog's settings: processType directCall, transactional handling from the calling process) with Start -> End.
 * Steps go in with insert_step after its start; a Process Call or Looping Process Call calls it.
 */
export function addLocalProcess(doc: Document, { name, processProps }: { name?: string; processProps: Props }): { processId: string; startId: string; endId: string; name: string } {
  const index = idIndex(doc) as Map<string, Element | null>;
  const collab = byTag(doc, 'collaboration')[0]!;
  const pools = children(collab, 'participant').filter((p) => p.getAttribute('ifl:type') === 'IntegrationProcess');
  const names = new Set(byTag(doc, 'process').map((p) => p.getAttribute('name')));
  let procName = name;
  for (let n = 1; !procName; n++) if (!names.has(`Local Integration Process ${n}`)) procName = `Local Integration Process ${n}`;
  if (names.has(procName)) throw new Error(`a process named "${procName}" exists already`);
  const processId = newId(index, 'Process');
  const startId = newId(index, 'StartEvent');
  const endId = newId(index, 'EndEvent');
  const flowId = newId(index, 'SequenceFlow');
  const poolId = `Participant_${processId}`;
  index.set(poolId, null);

  const participant = elementNS(doc, 'bpmn2:participant', { id: poolId, 'ifl:type': 'IntegrationProcess', name: procName, processRef: processId });
  participant.appendChild(elementNS(doc, 'bpmn2:extensionElements'));
  insertAfterEl(collab, participant, pools.at(-1) ?? children(collab, 'participant').at(-1)!);
  const proc = withProps(doc, elementNS(doc, 'bpmn2:process', { id: processId, name: procName }), processProps);
  proc.appendChild(plainEvent(doc, 'startEvent', startId, `Start ${procName}`, flowId));
  proc.appendChild(plainEvent(doc, 'endEvent', endId, `End ${procName}`, flowId));
  proc.appendChild(flowEl(doc, flowId, startId, endId));
  insertAfterEl(doc.documentElement!, proc, byTag(doc, 'process').at(-1)!);

  // below every pool, left-aligned with the first one; events where the designer puts them in a new pool
  const shapes = pools.map((p) => shapeOf(doc, p.getAttribute('id')!)).filter((x): x is Element => !!x).map(bounds);
  const x = shapes.length ? Math.min(...shapes.map((b) => b.x)) : 250;
  const y = shapes.length ? Math.max(...byTag(doc, 'BPMNShape', NS.bpmndi).map(bounds).map((b) => b.y + b.h)) + 60 : 60;
  const plane = byTag(doc, 'BPMNPlane', NS.bpmndi)[0]!;
  let last = byTag(doc, 'BPMNShape', NS.bpmndi).at(-1)!;
  const put = (id: string, b: { x: number; y: number; w: number; h: number }) => {
    const sh = elementNS(doc, 'bpmndi:BPMNShape', { bpmnElement: id, id: `BPMNShape_${id}` });
    sh.appendChild(elementNS(doc, 'dc:Bounds', { height: fmt(b.h), width: fmt(b.w), x: fmt(b.x), y: fmt(b.y) }));
    insertAfterEl(plane, sh, last); last = sh;
    return b;
  };
  put(poolId, { x, y, w: 540, h: 220 });
  const sb = put(startId, { x: x + 42, y: y + 82, w: 32, h: 32 });
  const eb = put(endId, { x: x + 453, y: y + 82, w: 32, h: 32 });
  const edge = elementNS(doc, 'bpmndi:BPMNEdge', { bpmnElement: flowId, id: `BPMNEdge_${flowId}`, sourceElement: `BPMNShape_${startId}`, targetElement: `BPMNShape_${endId}` });
  for (const b of [sb, eb]) edge.appendChild(elementNS(doc, 'di:waypoint', { x: fmt(b.x + b.w / 2), 'xsi:type': 'dc:Point', y: fmt(b.y + b.h / 2) }));
  insertAfterEl(plane, edge, byTag(doc, 'BPMNEdge', NS.bpmndi).at(-1) ?? last);
  return { processId, startId, endId, name: procName };
}

/** Remove a local integration process with everything in it; refused while a Process Call calls it */
export function removeLocalProcess(doc: Document, ref: string): string {
  const proc = findLocalProcess(doc, ref);
  const id = proc.getAttribute('id')!;
  const callers = byTag(doc, 'callActivity').filter((c) => readProps(c).activityType === 'ProcessCallElement' && readProps(c).processId === id);
  if (callers.length) throw new Error(`${id} is called by ${callers.map((c) => `${c.getAttribute('id')} "${c.getAttribute('name')}"`).join(', ')}; remove those calls first`);
  const ids = new Set<string>();
  const collect = (el: Element) => { const x = el.getAttribute('id'); if (x) ids.add(x); for (const c of children(el)) collect(c); };
  collect(proc);
  const adapter = byTag(doc, 'messageFlow').find((m) => ids.has(m.getAttribute('sourceRef')!) || ids.has(m.getAttribute('targetRef')!));
  if (adapter) throw new Error(`a step in ${id} has an adapter (${adapter.getAttribute('id')}); remove it first (remove_adapter)`);
  const participant = children(byTag(doc, 'collaboration')[0]!, 'participant').find((p) => p.getAttribute('processRef') === id);
  if (participant) ids.add(participant.getAttribute('id')!);
  for (const di of [...byTag(doc, 'BPMNShape', NS.bpmndi), ...byTag(doc, 'BPMNEdge', NS.bpmndi)]) if (ids.has(di.getAttribute('bpmnElement')!)) removeEl(di);
  if (participant) removeEl(participant);
  removeEl(proc);
  return `removed local integration process ${id} "${proc.getAttribute('name')}" with its content`;
}

/**
 * The loop of a Looping Process Call, as the designer writes it: a standardLoopCharacteristics child with the
 * maximum and the condition (the step's loopId names it). Returns the loop's id.
 */
export function setLoop(el: Element, { condition, max = 100 }: { condition: string; max?: number }): string {
  const doc = el.ownerDocument!;
  for (const old of children(el, 'standardLoopCharacteristics')) removeEl(old);
  const stamp = Date.now();
  const id = `StandardLoopCharacteristics_${stamp}`;
  const loop = elementNS(doc, 'bpmn2:standardLoopCharacteristics', { id, loopMaximum: String(max) });
  loop.appendChild(elementNS(doc, 'bpmn2:loopCondition', { id: `FormalExpression_${stamp}`, 'xsi:type': 'bpmn2:tFormalExpression' }, condition));
  insertAfterEl(el, loop, Array.from(el.childNodes).filter(isEl).at(-1)!);
  return id;
}

// ---------- start event: message or timer ----------

/**
 * Make a process's start event a timer start (a scheduled iFlow: no sender) or a message start again. The schedule is
 * always externalized (the user's rule): scheduleKey is {{parameter}} and the table goes into parameters.prop, as the
 * designer's "Externalize" writes it; an existing parameter keeps its name. Returns the parameter for the caller to
 * write. A timer start is refused while a sender adapter is connected.
 */
export function setStart(doc: Document, { process, kind, schedule = 'once', parameter }: { process?: string; kind: 'message' | 'timer'; schedule?: Schedule; parameter?: string }):
  { message: string; parameter?: { name: string; table: string } } {
  const proc = findProcess(doc, process);
  if (readProps(proc).processType === 'directCall') throw new Error(`${proc.getAttribute('id')} is a local integration process: it is started by a Process Call`);
  const starts = children(proc, 'startEvent');
  if (starts.length !== 1) throw new Error(`${proc.getAttribute('id')} must have exactly one start event (has ${starts.length})`);
  const start = starts[0]!;
  const id = start.getAttribute('id')!;
  const index = idIndex(doc) as Map<string, Element | null>;
  const docEl = start.ownerDocument!;
  const timer = children(start, 'timerEventDefinition')[0];
  if (kind === 'timer') {
    const sender = byTag(doc, 'messageFlow').find((m) => m.getAttribute('targetRef') === id);
    if (sender) throw new Error(`${id} has a sender adapter (${sender.getAttribute('id')} "${sender.getAttribute('name')}"); a scheduled iFlow has none: remove it first (remove_adapter)`);
    const table = scheduleTable(schedule);
    const existing = timer ? readProps(timer).scheduleKey?.match(/^\{\{([^{}]+)\}\}$/)?.[1] : undefined;
    const name = parameter ?? existing ?? 'timer_schedule';
    if (/[{}]/.test(name) || !name.trim()) throw new Error(`"${name}" is not a usable parameter name`);
    const what = schedule === 'once' ? 'runs once after deploy' : 'every' in schedule ? `every ${schedule.every} ${schedule.unit}` : `cron ${schedule.cron}`;
    const where = schedule !== 'once' && schedule.timeZone ? ` (${schedule.timeZone})` : schedule === 'once' ? '' : ' (UTC)';
    if (timer) { setProperties(timer, { scheduleKey: `{{${name}}}` }); return { message: `${id}: schedule ${what}${where}, parameter ${name}`, parameter: { name, table } }; }
    for (const c of [...children(start, 'extensionElements'), ...children(start, 'messageEventDefinition')]) removeEl(c);
    const def = elementNS(docEl, 'bpmn2:timerEventDefinition', { id: newId(index, 'TimerEventDefinition') });
    withProps(docEl, def, { scheduleKey: `{{${name}}}`, componentVersion: '1.4', cmdVariantUri: 'ctype::FlowstepVariant/cname::intermediatetimer/version::1.4.0', activityType: 'StartTimerEvent' });
    insertAfterEl(start, def, Array.from(start.childNodes).filter(isEl).at(-1)!);
    return { message: `${id}: timer start, ${what}${where}, externalized as parameter ${name}`, parameter: { name, table } };
  }
  if (!timer) return { message: `${id} is a message start already` };
  removeEl(timer);
  withProps(docEl, start, { cmdVariantUri: 'ctype::FlowstepVariant/cname::MessageStartEvent/version::1.0', componentVersion: '1.0' });
  // the settings on their own line, indented like the start event's other children
  const ext = children(start, 'extensionElements')[0]!;
  const inner = indentBefore(children(start, 'outgoing')[0] ?? start);
  start.insertBefore(docEl.createTextNode(inner), ext);
  prettify(ext, inner.replace(/^\n/, ''));
  insertAfterEl(start, elementNS(docEl, 'bpmn2:messageEventDefinition'), Array.from(start.childNodes).filter(isEl).at(-1)!);
  return { message: `${id}: message start again; connect a sender with add_adapter (the schedule parameter stays in parameters.prop)` };
}

// ---------- exception subprocess ----------

/** The process an operation means: by id or name, else the one with a message start event (the main process) */
export function findProcess(doc: Document, ref?: string): Element {
  const processes = byTag(doc, 'process');
  if (ref) {
    const p = processes.find((x) => x.getAttribute('id') === ref || x.getAttribute('name') === ref);
    if (!p) throw new Error(`no process "${ref}"; processes: ${processes.map((x) => `${x.getAttribute('id')} "${x.getAttribute('name')}"`).join(', ')}`);
    return p;
  }
  const main = processes.filter((p) => children(p, 'startEvent').some((e) => children(e, 'messageEventDefinition').length));
  if (main.length === 1) return main[0]!;
  if (processes.length === 1) return processes[0]!;
  throw new Error(`name the process (${processes.map((x) => `${x.getAttribute('id')} "${x.getAttribute('name')}"`).join(', ')})`);
}

const errorEvent = (doc: Document, tag: 'startEvent' | 'endEvent', attrs: Record<string, string>, flow: string) => {
  const el = elementNS(doc, `bpmn2:${tag}`, attrs);
  el.appendChild(elementNS(doc, tag === 'startEvent' ? 'bpmn2:outgoing' : 'bpmn2:incoming', {}, flow));
  const def = elementNS(doc, 'bpmn2:errorEventDefinition');
  const ext = elementNS(doc, 'bpmn2:extensionElements');
  const [cname, type] = tag === 'startEvent' ? ['ErrorStartEvent', 'StartErrorEvent'] : ['ErrorEndEvent', 'EndErrorEvent'];
  ext.appendChild(iflProperty(doc, 'cmdVariantUri', `ctype::FlowstepVariant/cname::${cname}`));
  ext.appendChild(iflProperty(doc, 'activityType', type));
  def.appendChild(ext);
  el.appendChild(def);
  return el;
};

const SUB = { w: 400, h: 140 };

/**
 * Add an exception subprocess to a process, as the designer's palette does: Error Start -> Error End (the message
 * fails and the error goes back to the sender), or with end "message" Error Start -> End (the subprocess sends the
 * reply). It is drawn below the main row inside the pool, which grows; boxes below the pool move down with it.
 */
export function addExceptionSubprocess(doc: Document, { process, name = 'Exception Subprocess 1', end = 'error' }:
  { process?: string; name?: string; end?: 'error' | 'message' }): { subId: string; startId: string; endId: string; processId: string } {
  const proc = findProcess(doc, process);
  const processId = proc.getAttribute('id')!;
  const existing = children(proc, 'subProcess').find(isExceptionSub);
  if (existing) throw new Error(`${processId} already has an exception subprocess (${existing.getAttribute('id')} "${existing.getAttribute('name')}"); a process takes one`);
  const collab = byTag(doc, 'collaboration')[0]!;
  const poolId = children(collab, 'participant').find((p) => p.getAttribute('processRef') === processId)?.getAttribute('id');
  const poolShape = poolId ? shapeOf(doc, poolId) : undefined;
  if (!poolShape) throw new Error(`${processId} has no pool in the diagram`);

  const index = idIndex(doc) as Map<string, Element | null>;
  const subId = newId(index, 'SubProcess');
  const startId = newId(index, 'StartEvent');
  const endId = newId(index, 'EndEvent');
  const flowId = newId(index, 'SequenceFlow');

  // 1) model, in the order the designer writes it: settings, end, start, flow
  const sub = elementNS(doc, 'bpmn2:subProcess', { id: subId, name });
  const ext = elementNS(doc, 'bpmn2:extensionElements');
  for (const [k, v] of Object.entries({ componentVersion: '1.1', activityType: 'ErrorEventSubProcessTemplate', cmdVariantUri: 'ctype::FlowstepVariant/cname::ErrorEventSubProcessTemplate/version::1.1.0' })) {
    ext.appendChild(iflProperty(doc, k, v));
  }
  sub.appendChild(ext);
  if (end === 'error') sub.appendChild(errorEvent(doc, 'endEvent', { id: endId, name: 'Error End 1' }, flowId));
  else {
    const e = elementNS(doc, 'bpmn2:endEvent', { id: endId, name: 'End 1' });
    const eExt = elementNS(doc, 'bpmn2:extensionElements');
    eExt.appendChild(iflProperty(doc, 'componentVersion', '1.1'));
    eExt.appendChild(iflProperty(doc, 'cmdVariantUri', 'ctype::FlowstepVariant/cname::MessageEndEvent/version::1.1.0'));
    e.appendChild(eExt);
    e.appendChild(elementNS(doc, 'bpmn2:incoming', {}, flowId));
    e.appendChild(elementNS(doc, 'bpmn2:messageEventDefinition'));
    sub.appendChild(e);
  }
  sub.appendChild(errorEvent(doc, 'startEvent', { id: startId, name: 'Error Start 1' }, flowId));
  sub.appendChild(elementNS(doc, 'bpmn2:sequenceFlow', { id: flowId, sourceRef: startId, targetRef: endId }));
  insertAfterEl(proc, sub, children(proc).at(-1)!);

  // 2) diagram: below everything the process already draws, left-aligned with it
  const own = new Set(children(proc).map((n) => n.getAttribute('id')));
  const inner = byTag(doc, 'BPMNShape', NS.bpmndi).filter((x) => own.has(x.getAttribute('bpmnElement'))).map(bounds);
  const pool = bounds(poolShape);
  const left = inner.length ? Math.min(...inner.map((b) => b.x)) : pool.x + 20;
  const top = (inner.length ? Math.max(...inner.map((b) => b.y + b.h)) : pool.y) + 40;
  const box = { x: left, y: top, ...SUB };
  const plane = byTag(doc, 'BPMNPlane', NS.bpmndi)[0]!;
  const lastShape = byTag(doc, 'BPMNShape', NS.bpmndi).at(-1)!;
  const shapeEl = (id: string, b: { x: number; y: number; w: number; h: number }) => {
    const sh = elementNS(doc, 'bpmndi:BPMNShape', { bpmnElement: id, id: `BPMNShape_${id}` });
    sh.appendChild(elementNS(doc, 'dc:Bounds', { height: fmt(b.h), width: fmt(b.w), x: fmt(b.x), y: fmt(b.y) }));
    return sh;
  };
  const ev = (x: number) => ({ x, y: box.y + 46, w: 32, h: 32 });
  const [sb, eb] = [ev(box.x + 33), ev(box.x + box.w - 84)];
  const shapes = [shapeEl(subId, box), shapeEl(endId, eb), shapeEl(startId, sb)];
  shapes.reduce((ref, sh) => { insertAfterEl(plane, sh, ref); return sh; }, lastShape);
  const edge = elementNS(doc, 'bpmndi:BPMNEdge', { bpmnElement: flowId, id: `BPMNEdge_${flowId}`, sourceElement: `BPMNShape_${startId}`, targetElement: `BPMNShape_${endId}` });
  for (const b of [sb, eb]) edge.appendChild(elementNS(doc, 'di:waypoint', { x: fmt(b.x + b.w / 2), 'xsi:type': 'dc:Point', y: fmt(b.y + b.h / 2) }));
  insertAfterEl(plane, edge, byTag(doc, 'BPMNEdge', NS.bpmndi).at(-1) ?? shapes.at(-1)!);

  // the pool grows around it (20 below, as the designer leaves); boxes under the pool move down by as much
  fitPool(doc, poolShape, box);
  replaceBoxes(doc, proc);
  return { subId, startId, endId, processId };
}

/** Place the boxes of a process's adapters again (all but start-event senders), e.g. after the pool changed */
function replaceBoxes(doc: Document, proc: Element) {
  const own = new Set(children(proc).map((n) => n.getAttribute('id')));
  for (const mf of byTag(doc, 'messageFlow')) {
    const [from, to] = [mf.getAttribute('sourceRef')!, mf.getAttribute('targetRef')!];
    const stepId = own.has(from) ? from : own.has(to) ? to : undefined;
    const step = stepId ? idIndex(doc).get(stepId) : undefined;
    if (!step || step.localName === 'startEvent') continue;
    const [box, stepShape] = [shapeOf(doc, stepId === from ? to : from), shapeOf(doc, stepId!)];
    if (box && stepShape) placeBox(doc, box, bounds(stepShape), false);
  }
  routeAdapters(doc);
  keepOnCanvas(doc);
}

/** Grow a pool to hold a box (20 below and right); shapes below the old pool move down, adapter lines follow */
function fitPool(doc: Document, poolShape: Element, box: { x: number; y: number; w: number; h: number }) {
  const pool = bounds(poolShape);
  const grow = box.y + box.h + 20 - (pool.y + pool.h);
  if (box.x + box.w + 20 > pool.x + pool.w) pool.el.setAttribute('width', fmt(box.x + box.w + 20 - pool.x));
  if (grow <= 0) return;
  const oldBottom = pool.y + pool.h;
  pool.el.setAttribute('height', fmt(pool.h + grow));
  const moved = new Set<string>();
  for (const sh of byTag(doc, 'BPMNShape', NS.bpmndi)) {
    const b = bounds(sh);
    if (sh !== poolShape && b.y >= oldBottom) { b.el.setAttribute('y', fmt(b.y + grow)); moved.add(sh.getAttribute('bpmnElement')!); }
  }
  routeAdapters(doc, moved);
}

/** Remove a process's exception subprocess with everything in it (steps inside must not have adapters) */
export function removeExceptionSubprocess(doc: Document, process?: string): string {
  const proc = findProcess(doc, process);
  const sub = children(proc, 'subProcess').find(isExceptionSub);
  if (!sub) throw new Error(`${proc.getAttribute('id')} has no exception subprocess`);
  const ids = new Set([sub, ...children(sub)].map((n) => n.getAttribute('id')).filter((x): x is string => !!x));
  const adapter = byTag(doc, 'messageFlow').find((m) => ids.has(m.getAttribute('sourceRef')!) || ids.has(m.getAttribute('targetRef')!));
  if (adapter) throw new Error(`a step in the exception subprocess has an adapter (${adapter.getAttribute('id')} "${adapter.getAttribute('name')}"); remove it first (remove_adapter)`);
  for (const di of [...byTag(doc, 'BPMNShape', NS.bpmndi), ...byTag(doc, 'BPMNEdge', NS.bpmndi)]) if (ids.has(di.getAttribute('bpmnElement')!)) removeEl(di);
  removeEl(sub);
  return sub.getAttribute('id')!;
}

// ---------- layout ----------

/** The straight route through a subprocess, start to end; refuses branches and stray elements */
function straightChain(container: Element): { chain: Element[]; chainFlows: Element[] } {
  const nodes = flowNodes(container);
  const where = container.getAttribute('name') ?? container.getAttribute('id');
  const starts = nodes.filter((n) => n.localName === 'startEvent');
  if (starts.length !== 1) throw new Error(`layout needs exactly one start event in "${where}" (has ${starts.length})`);
  const flows = children(container, 'sequenceFlow');
  const chain: Element[] = [starts[0]!];
  const chainFlows: Element[] = [];
  for (;;) {
    const id = chain.at(-1)!.getAttribute('id');
    const out = flows.filter((f) => f.getAttribute('sourceRef') === id);
    if (!out.length) break;
    if (out.length > 1) throw new Error(`layout handles straight exception subprocesses only; ${id} has ${out.length} outgoing routes: use the designer`);
    chainFlows.push(out[0]!);
    const next = nodes.find((n) => n.getAttribute('id') === out[0]!.getAttribute('targetRef'));
    if (!next || chain.includes(next)) throw new Error(`layout: loop or broken route at ${id}`);
    chain.push(next);
  }
  if (chain.length !== nodes.length) {
    const rest = nodes.filter((n) => !chain.includes(n)).map((n) => n.getAttribute('id'));
    throw new Error(`layout: not on the route in "${where}": ${rest.join(', ')}: use the designer`);
  }
  return { chain, chainFlows };
}

/** The flow nodes of a process or subprocess (steps, events, gateways), without exception subprocesses */
const flowNodes = (container: Element) =>
  children(container).filter((n) => !['extensionElements', 'sequenceFlow', 'documentation'].includes(n.localName ?? '') && !isExceptionSub(n));

type Placed = { x: number; y: number; w: number; h: number; el: Element };

/** Straighten or bend an edge between two placed shapes: same row straight, otherwise at right angles */
function routeEdge(doc: Document, flowId: string, a: Placed, b: Placed, centred: boolean, over?: number) {
  const edge = edgeOf(doc, flowId);
  if (!edge) return;
  const wps = children(edge, 'waypoint', NS.di);
  const [acx, acy, bcx, bcy] = [a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2];
  let pts: Array<[number, number]>;
  // over the top of the elements between (a route that skips them on the same row), as the designer draws it
  if (over !== undefined) pts = [[acx, a.y], [acx, over], [bcx, over], [bcx, b.y]];
  else if (Math.abs(acy - bcy) < 1) pts = centred ? [[acx, acy], [bcx, bcy]] : [[a.x + a.w, acy], [b.x, bcy]];
  // into a branch row: down (or up) from the source, then right into the target
  else if (b.x > a.x + a.w && isBranching(doc, flowId)) {
    pts = [[acx, bcy > acy ? a.y + a.h : a.y], [acx, bcy], [b.x, bcy]];
  } else pts = [[a.x + a.w, acy], [bcx, acy], [bcx, bcy > acy ? b.y : b.y + b.h]]; // back from a branch: right, then up or down
  // reuse the first and last waypoint elements, replace the ones between
  for (const wp of wps.slice(1, -1)) removeEl(wp);
  const [first, last] = [wps[0]!, wps.at(-1)!];
  first.setAttribute('x', fmt(pts[0]![0])); first.setAttribute('y', fmt(pts[0]![1]));
  last.setAttribute('x', fmt(pts.at(-1)![0])); last.setAttribute('y', fmt(pts.at(-1)![1]));
  for (const [x, y] of pts.slice(1, -1)) {
    const wp = elementNS(doc, 'di:waypoint', { x: fmt(x), 'xsi:type': 'dc:Point', y: fmt(y) });
    edge.insertBefore(doc.createTextNode(indentBefore(last)), last);
    edge.insertBefore(wp, last);
  }
}
/** True when the flow leaves a node with several outgoing flows (a route or branch, not the way back) */
const isBranching = (doc: Document, flowId: string) => {
  const f = idIndex(doc).get(flowId);
  const src = f?.getAttribute('sourceRef');
  return !!src && byTag(doc, 'sequenceFlow').filter((x) => x.getAttribute('sourceRef') === src).length > 1;
};

const poolShapeOf = (doc: Document, proc: Element) => {
  const id = children(byTag(doc, 'collaboration')[0]!, 'participant').find((p) => p.getAttribute('processRef') === proc.getAttribute('id'))?.getAttribute('id');
  return id ? shapeOf(doc, id) : undefined;
};
const procName = (proc: Element) => `"${proc.getAttribute('name') ?? proc.getAttribute('id')}"`;
/** The integration processes first (as in the file), then the local ones: the order pools are stacked in */
const processesInOrder = (doc: Document) => {
  const all = byTag(doc, 'process');
  const local = (p: Element) => readProps(p).processType === 'directCall';
  return [...all.filter((p) => !local(p)), ...all.filter(local)];
};

/** Move a process's pool with everything drawn in it (shapes and the lines of its flows) */
function moveProcess(doc: Document, proc: Element, dx: number, dy: number) {
  if (!dx && !dy) return;
  const ids = new Set<string>();
  const collect = (el: Element) => { const id = el.getAttribute('id'); if (id) ids.add(id); for (const c of children(el)) collect(c); };
  collect(proc);
  const pool = poolShapeOf(doc, proc);
  for (const sh of byTag(doc, 'BPMNShape', NS.bpmndi)) {
    if (sh !== pool && !ids.has(sh.getAttribute('bpmnElement')!)) continue;
    const b = bounds(sh); b.el.setAttribute('x', fmt(b.x + dx)); b.el.setAttribute('y', fmt(b.y + dy));
  }
  for (const e of byTag(doc, 'BPMNEdge', NS.bpmndi)) {
    if (!ids.has(e.getAttribute('bpmnElement')!)) continue;
    for (const wp of children(e, 'waypoint', NS.di)) { wp.setAttribute('x', fmt(Number(wp.getAttribute('x')) + dx)); wp.setAttribute('y', fmt(Number(wp.getAttribute('y')) + dy)); }
  }
}

/**
 * Lay out every process of the iFlow (see layoutProcess): the first integration process stays where it is, every
 * other pool is stacked below it, left-aligned, 60 apart.
 */
export function layoutStraight(doc: Document): string {
  const procs = processesInOrder(doc);
  if (!procs.length) throw new Error('the iFlow has no integration process');
  const lines: string[] = [];
  let below: number | undefined;
  let left: number | undefined;
  for (const proc of procs) {
    const pool = poolShapeOf(doc, proc);
    if (!pool) throw new Error(`process ${procName(proc)} has no pool in the diagram`);
    if (below !== undefined) { const b = bounds(pool); moveProcess(doc, proc, left! - b.x, below + 60 - b.y); }
    const msg = layoutProcess(doc, proc);
    lines.push(procs.length > 1 ? `${procName(proc)}: ${msg}` : msg);
    const b = bounds(pool);
    // the next pool goes below this one and below the Sender/Receiver boxes placed under it
    const ids = new Set<string>();
    const collect = (el: Element) => { const id = el.getAttribute('id'); if (id) ids.add(id); for (const c of children(el)) collect(c); };
    collect(proc);
    const boxes = byTag(doc, 'messageFlow').flatMap((m) => [m.getAttribute('sourceRef')!, m.getAttribute('targetRef')!].filter((x) => !ids.has(x))
      .filter(() => ids.has(m.getAttribute('sourceRef')!) || ids.has(m.getAttribute('targetRef')!)));
    const boxBottoms = boxes.map((id) => shapeOf(doc, id)).filter((x): x is Element => !!x).map(bounds).map((x) => x.y + x.h);
    below = Math.max(b.y + b.h, ...boxBottoms); left ??= b.x;
  }
  routeAdapters(doc);
  keepOnCanvas(doc);
  return lines.join('; ');
}

/**
 * Lay out the process holding an element again (after a branching edit) and keep the rest of the diagram clear of it:
 * when its pool grew, everything below its old bottom moves down by as much (other pools keep their arrangement).
 */
export function layoutAround(doc: Document, elementId: string): string {
  let proc = idIndex(doc).get(elementId) ?? null;
  while (proc && proc.localName !== 'process') proc = proc.parentNode as Element | null;
  if (!proc) throw new Error(`${elementId} is not in a process`);
  const pool = poolShapeOf(doc, proc);
  if (!pool) throw new Error(`process ${procName(proc)} has no pool in the diagram`);
  const before = bounds(pool);
  const mine = new Set<string>();
  const collect = (el: Element) => { const id = el.getAttribute('id'); if (id) mine.add(id); for (const c of children(el)) collect(c); };
  collect(proc);
  // boxes connected to this process are placed by its layout
  for (const mf of byTag(doc, 'messageFlow')) {
    const [a, b] = [mf.getAttribute('sourceRef')!, mf.getAttribute('targetRef')!];
    if (mine.has(a) || mine.has(b)) { mine.add(a); mine.add(b); mine.add(mf.getAttribute('id')!); }
  }
  const msg = layoutProcess(doc, proc);
  const grow = bounds(pool).y + bounds(pool).h - (before.y + before.h);
  if (grow > 0 && byTag(doc, 'process').length > 1) {
    for (const sh of byTag(doc, 'BPMNShape', NS.bpmndi)) {
      const b = bounds(sh);
      if (sh !== pool && !mine.has(sh.getAttribute('bpmnElement')!) && b.y >= before.y + before.h) b.el.setAttribute('y', fmt(b.y + grow));
    }
    for (const e of byTag(doc, 'BPMNEdge', NS.bpmndi)) {
      if (mine.has(e.getAttribute('bpmnElement')!)) continue;
      for (const wp of children(e, 'waypoint', NS.di)) if (Number(wp.getAttribute('y')) >= before.y + before.h) wp.setAttribute('y', fmt(Number(wp.getAttribute('y')) + grow));
    }
  }
  routeAdapters(doc);
  keepOnCanvas(doc);
  return msg;
}

/**
 * Lay out one process inside its pool, left to right: every element in the column of its longest path from the
 * start (so joins come after all their branches); the first route of a router or multicast stays on its row, every
 * further route gets a new row below; the standard gap of 50 between columns, 40 between rows. An exception
 * subprocess (straight inside) goes in a row below; the pool is fitted; the start event's sender sits left of the
 * pool and every other Sender/Receiver box below or above its step.
 */
function layoutProcess(doc: Document, proc: Element): string {
  const subs = children(proc, 'subProcess');
  const other = subs.find((x) => !isExceptionSub(x));
  if (other) throw new Error(`layout handles exception subprocesses only; ${other.getAttribute('id')} is another kind of subprocess: use the designer`);
  const nodes = flowNodes(proc);
  const byId = new Map(nodes.map((n) => [n.getAttribute('id')!, n]));
  const starts = nodes.filter((n) => n.localName === 'startEvent');
  if (starts.length !== 1) throw new Error(`layout needs exactly one start event in process ${procName(proc)} (has ${starts.length}): use the designer`);
  const flows = children(proc, 'sequenceFlow');
  const out = (id: string) => {
    // in the order the node lists them (the designer's order: the first route stays on the row)
    const order = children(byId.get(id)!, 'outgoing').map((o) => o.textContent?.trim());
    return flows.filter((f) => f.getAttribute('sourceRef') === id)
      .sort((a, b) => (order.indexOf(a.getAttribute('id')!) + 1 || 99) - (order.indexOf(b.getAttribute('id')!) + 1 || 99));
  };

  // columns: longest path from the start (Kahn's order; a loop is refused)
  const indeg = new Map(nodes.map((n) => [n.getAttribute('id')!, 0]));
  for (const f of flows) if (byId.has(f.getAttribute('targetRef')!)) indeg.set(f.getAttribute('targetRef')!, indeg.get(f.getAttribute('targetRef')!)! + 1);
  const col = new Map<string, number>();
  const queue = [starts[0]!.getAttribute('id')!];
  col.set(queue[0]!, 0);
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    seen.add(id);
    for (const f of out(id)) {
      const t = f.getAttribute('targetRef')!;
      if (!byId.has(t)) continue;
      col.set(t, Math.max(col.get(t) ?? 0, col.get(id)! + 1));
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  const stray = nodes.filter((n) => !seen.has(n.getAttribute('id')!)).map((n) => n.getAttribute('id'));
  if (stray.length) throw new Error(`layout: ${stray.join(', ')} not reachable from the start, or in a loop: use the designer`);
  // rows: depth first; the first route keeps the row, every further one opens the next free row
  const row = new Map<string, number>();
  let rows = 0;
  const visit = (id: string, r: number) => {
    if (row.has(id)) return;
    row.set(id, r);
    out(id).forEach((f, i) => {
      const t = f.getAttribute('targetRef')!;
      if (byId.has(t) && !row.has(t)) visit(t, i === 0 ? r : ++rows);
    });
  };
  visit(starts[0]!.getAttribute('id')!, 0);
  // compact: a branch row moves up to the first row below its origin that is free in its columns (one column of
  // margin for the bends), so branches far apart share a row
  const span = (r: number) => {
    const cs = nodes.filter((n) => row.get(n.getAttribute('id')!) === r).map((n) => col.get(n.getAttribute('id')!)!);
    return cs.length ? [Math.min(...cs) - 1, Math.max(...cs) + 1] as const : undefined;
  };
  for (let r = 2; r <= rows; r++) {
    const mine = span(r);
    if (!mine) continue;
    const origin = Math.max(0, ...flows.filter((f) => row.get(f.getAttribute('targetRef')!) === r && row.get(f.getAttribute('sourceRef')!) !== r)
      .map((f) => row.get(f.getAttribute('sourceRef')!) ?? 0));
    for (let q = origin + 1; q < r; q++) {
      const other = span(q);
      if (other && other[0] <= mine[1] && mine[0] <= other[1]) continue;
      for (const [id, x] of row) if (x === r) row.set(id, q);
      break;
    }
  }
  const used = [...new Set(row.values())].sort((x, y) => x - y);
  for (const [id, x] of row) row.set(id, used.indexOf(x));
  rows = used.length - 1;

  const collab = byTag(doc, 'collaboration')[0]!;
  const poolShape = poolShapeOf(doc, proc);
  if (!poolShape) throw new Error(`process ${procName(proc)} has no diagram shape`);
  const shapeBounds = new Map(nodes.map((n) => {
    const sh = shapeOf(doc, n.getAttribute('id')!);
    if (!sh) throw new Error(`${n.getAttribute('id')} has no diagram shape`);
    return [n.getAttribute('id')!, bounds(sh)];
  }));

  // edge ends on borders or centres, as the file already does
  const GAP = 50, ROW_GAP = 40;
  const first = shapeBounds.get(starts[0]!.getAttribute('id')!)!;
  const firstEdge = edgeOf(doc, out(starts[0]!.getAttribute('id')!)[0]?.getAttribute('id') ?? '');
  const firstWp = firstEdge && children(firstEdge, 'waypoint', NS.di)[0];
  const centred = !!firstWp && Math.abs(Number(firstWp.getAttribute('x')) - (first.x + first.w / 2)) < 1;

  const cols = Math.max(...col.values()) + 1;
  const colW = Array.from({ length: cols }, (_, c) => Math.max(...nodes.filter((n) => col.get(n.getAttribute('id')!) === c).map((n) => shapeBounds.get(n.getAttribute('id')!)!.w)));
  const colX: number[] = [];
  colW.reduce((x, w, c) => { colX[c] = x; return x + w + GAP; }, first.x);
  const rowH = Array.from({ length: rows + 1 }, (_, r) => Math.max(...nodes.filter((n) => row.get(n.getAttribute('id')!) === r).map((n) => shapeBounds.get(n.getAttribute('id')!)!.h)));
  const rowCy: number[] = [];
  rowH.reduce((top, h, r) => { rowCy[r] = r === 0 ? first.y + first.h / 2 : top + h / 2; return (r === 0 ? first.y + first.h / 2 + h / 2 : top + h) + ROW_GAP; }, 0);
  const placed = new Map<string, Placed>();
  for (const n of nodes) {
    const id = n.getAttribute('id')!;
    const b = shapeBounds.get(id)!;
    const c = col.get(id)!;
    const x = cols === nodes.length || rows === 0 ? colX[c]! : colX[c]! + (colW[c]! - b.w) / 2;
    const y = rowCy[row.get(id)!]! - b.h / 2;
    b.el.setAttribute('x', fmt(x)); b.el.setAttribute('y', fmt(y));
    placed.set(id, { x, y, w: b.w, h: b.h, el: b.el });
  }
  for (const f of flows) {
    const [sId, tId] = [f.getAttribute('sourceRef')!, f.getAttribute('targetRef')!];
    const [a, b] = [placed.get(sId), placed.get(tId)];
    if (!a || !b) continue;
    // a route along its row that would run through the elements between: over their top
    const between = row.get(sId) === row.get(tId) ? nodes.filter((n) => {
      const id = n.getAttribute('id')!;
      return row.get(id) === row.get(sId) && col.get(id)! > col.get(sId)! && col.get(id)! < col.get(tId)!;
    }) : [];
    const over = between.length ? Math.min(...between.map((n) => placed.get(n.getAttribute('id')!)!.y)) - 15 : undefined;
    routeEdge(doc, f.getAttribute('id')!, a, b, centred, over);
  }
  let right = Math.max(...[...placed.values()].map((b) => b.x + b.w));
  let bottom = Math.max(...[...placed.values()].map((b) => b.y + b.h));
  const pool = bounds(poolShape);
  const placedAll: Array<readonly [Element, Placed]> = nodes.map((n) => [n, placed.get(n.getAttribute('id')!)!] as const);

  const sub = subs[0];
  const inner = sub ? straightChain(sub) : undefined;
  if (sub && inner) {
    // the subprocess box below the rows: events 33 in from its border, 46 down, as the designer draws them
    const subShape = shapeOf(doc, sub.getAttribute('id')!);
    if (!subShape) throw new Error(`${sub.getAttribute('id')} has no diagram shape`);
    const box = bounds(subShape);
    const top = bottom + 40;
    const rowPlaced = placeRow(doc, inner.chain, inner.chainFlows, first.x + 33, top + 62, true);
    const w = Math.max(SUB.w, rowPlaced.at(-1)!.x + rowPlaced.at(-1)!.w + 52 - first.x);
    box.el.setAttribute('x', fmt(first.x)); box.el.setAttribute('y', fmt(top));
    box.el.setAttribute('width', fmt(w)); box.el.setAttribute('height', fmt(SUB.h));
    // a lone end event sits at the right end, as in a new subprocess
    if (inner.chain.length === 2) {
      const e = rowPlaced[1]!;
      e.el.setAttribute('x', fmt(first.x + w - 84));
      const edge = edgeOf(doc, inner.chainFlows[0]!.getAttribute('id')!);
      if (edge) children(edge, 'waypoint', NS.di).at(-1)!.setAttribute('x', fmt(first.x + w - 84 + e.w / 2));
      rowPlaced[1] = { ...e, x: first.x + w - 84 };
    }
    right = Math.max(right, first.x + w);
    bottom = top + SUB.h;
    inner.chain.forEach((n, i) => placedAll.push([n, rowPlaced[i]!]));
  }
  pool.el.setAttribute('width', fmt(right + GAP - pool.x));
  // the pool keeps its height unless the content needs more (20 below a subprocess, 40 below branch rows)
  const need = bottom + (sub ? 20 : rows ? ROW_GAP : 0) - pool.y;
  if (sub || need > pool.h) pool.el.setAttribute('height', fmt(Math.max(sub ? 0 : pool.h, need)));

  // Sender/Receiver boxes connected to the flow
  let boxes = 0;
  for (const mf of children(collab, 'messageFlow')) {
    const [from, to] = [mf.getAttribute('sourceRef')!, mf.getAttribute('targetRef')!];
    const hit = placedAll.find(([n]) => [from, to].includes(n.getAttribute('id')!));
    if (!hit) continue;
    const box = shapeOf(doc, hit[0].getAttribute('id') === from ? to : from);
    if (!box) continue;
    placeBox(doc, box, { ...hit[1] }, hit[0].localName === 'startEvent' && hit[0].parentNode === proc);
    boxes++;
  }
  const where = rows ? `in ${cols} columns and ${rows + 1} rows` : 'in one row';
  return `laid out ${nodes.length} elements ${where}${inner ? ` and ${inner.chain.length} in the exception subprocess below` : ''} ` +
    `(pool width ${right + GAP - pool.x}), ${boxes} Sender/Receiver box(es) placed`;
}

/** Place a chain in one row from x, centred on cy, with the standard gap; straighten its edges */
function placeRow(doc: Document, chain: Element[], chainFlows: Element[], x: number, cy: number, centred: boolean): Placed[] {
  const GAP = 50;
  const placed = chain.map((n) => {
    const sh = shapeOf(doc, n.getAttribute('id')!);
    if (!sh) throw new Error(`${n.getAttribute('id')} has no diagram shape`);
    const b = bounds(sh);
    b.el.setAttribute('x', fmt(x)); b.el.setAttribute('y', fmt(cy - b.h / 2));
    const r = { x, y: cy - b.h / 2, w: b.w, h: b.h, el: b.el };
    x += b.w + GAP;
    return r;
  });
  chainFlows.forEach((f, i) => routeEdge(doc, f.getAttribute('id')!, placed[i]!, placed[i + 1]!, centred));
  return placed;
}

export function rename(el: Element, name: string) {
  if (el.localName === 'collaboration') throw new Error('the iFlow itself cannot be renamed here');
  el.setAttribute('name', name);
}
