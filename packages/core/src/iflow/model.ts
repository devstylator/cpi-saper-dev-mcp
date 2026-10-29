// Reader for SAP Cloud Integration .iflw files and a compact model of them for agents.
// An .iflw is BPMN 2.0 XML: participants + message flows (adapters) in a collaboration, one bpmn2:process per
// (local) integration process, SAP settings as <ifl:property><key/><value/></ifl:property>, and a standard BPMN DI
// section with shape bounds and edge waypoints. Edits (later) change the DOM surgically so untouched bytes stay
// identical, which keeps git diffs small.
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';

export const NS = {
  bpmn2: 'http://www.omg.org/spec/BPMN/20100524/MODEL',
  bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI',
  ifl: 'http:///com.sap.ifl.model/Ifl.xsd',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
} as const;

export type { Document, Element };

export const parseIflw = (xml: string): Document => new DOMParser().parseFromString(xml, 'text/xml');
// Files use LF line ends, so any CR in the DOM came from a '&#13;' reference and must be re-escaped,
// otherwise the next XML parser normalises it away (silent payload change, e.g. in Content Modifier bodies).
export const serializeIflw = (doc: Document): string => new XMLSerializer().serializeToString(doc).replace(/\r/g, '&#13;');

const isEl = (n: Node | null | undefined): n is Element => !!n && n.nodeType === 1;
export const children = (el: Element | Document, local?: string, ns: string = NS.bpmn2): Element[] =>
  Array.from(el.childNodes).filter((n): n is Element => isEl(n) && n.namespaceURI === ns && (!local || n.localName === local));
export const byTag = (doc: Document | Element, local: string, ns: string = NS.bpmn2): Element[] =>
  Array.from(doc.getElementsByTagNameNS(ns, local));
const firstChildNamed = (el: Element, local: string) => Array.from(el.childNodes).find((n): n is Element => isEl(n) && n.localName === local);

export function idIndex(doc: Document): Map<string, Element> {
  const index = new Map<string, Element>();
  const walk = (el: Element) => {
    const id = el.getAttribute('id');
    if (id) index.set(id, el);
    for (const c of Array.from(el.childNodes)) if (isEl(c)) walk(c);
  };
  if (doc.documentElement) walk(doc.documentElement);
  return index;
}

// ---------- ifl:property helpers ----------

export type Props = Record<string, string>;

export function readProps(el: Element): Props {
  const ext = children(el, 'extensionElements')[0];
  const out: Props = {};
  if (!ext) return out;
  for (const p of children(ext, 'property', NS.ifl)) {
    out[firstChildNamed(p, 'key')?.textContent ?? ''] = firstChildNamed(p, 'value')?.textContent ?? '';
  }
  return out;
}

export type TableRow = Record<string, string> | string[];
export type Decoded = string | TableRow[] | Record<string, string>;

// Content Modifier header/property tables, timer schedules, etc. are stored as an escaped
// "<row><cell id='Name'>..</cell>...</row>" fragment inside a property value.
export function decodeTable(value: string): Decoded {
  if (!value.trimStart().startsWith('<row')) return value;
  try {
    const d = new DOMParser({ onError: () => {} }).parseFromString(`<t>${value}</t>`, 'text/xml');
    const rows: TableRow[] = Array.from(d.getElementsByTagName('row')).map((row) => {
      const cells = Array.from(row.getElementsByTagName('cell'));
      return cells.every((c) => c.getAttribute('id'))
        ? Object.fromEntries(cells.map((c) => [c.getAttribute('id')!, c.textContent ?? '']))
        : cells.map((c) => c.textContent ?? '');
    });
    // key/value rows (e.g. timer scheduleKey) read better as one object without the empty entries
    return rows.every((r) => Array.isArray(r) && r.length === 2)
      ? Object.fromEntries((rows as string[][]).filter(([, v]) => v !== '').map(([k, v]) => [k!, v!]))
      : rows;
  } catch {
    return value;
  }
}

export function encodeTable(rows: Array<Record<string, string>>): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');
  return rows.map((r) => `<row>${Object.entries(r).map(([k, v]) => `<cell id='${k}'>${esc(v)}</cell>`).join('')}</row>`).join('');
}

/** "ctype::FlowstepVariant/cname::Enricher/version::1.2.0" -> { ctype, cname, version } */
export const parseVariant = (uri = ''): Record<string, string> =>
  Object.fromEntries(uri.split('/').map((s) => s.split('::')).filter((a): a is [string, string] => a.length === 2));

// ---------- describe: a compact, token-efficient view for agents ----------

export interface Flow { id: string; from: string; to: string; name?: string; condition?: string }

export interface Step {
  id: string;
  name: string;
  bpmn: string;
  kind?: string;
  version?: string;
  /** display number in flow order (#1, #2, ...); never written into the iFlow */
  no?: number;
  defaultFlow?: string;
  eventSubProcess?: boolean;
  steps?: Step[];
  flows?: Flow[];
  config?: Record<string, Decoded>;
}

export interface Container { steps: Step[]; flows: Flow[] }
export interface Process extends Container { id: string; name: string; kind?: string }
export interface Participant { id: string; name: string; type: string; process?: string }
export interface Adapter {
  id: string; name?: string; from: string; to: string;
  adapter?: string; direction?: string; version?: string; config: Record<string, Decoded>;
}
export interface ResourceRef { step: string; type: 'script' | 'mapping' | 'resource'; path: string }

export interface IflowModel {
  integrationFlow: Record<string, Decoded>;
  participants: Participant[];
  adapters: Adapter[];
  processes: Process[];
  externalizedParameters: string[];
  resourceRefs: ResourceRef[];
}

const BOILERPLATE = new Set([
  'cmdVariantUri', 'componentVersion', 'activityType', 'subActivityType', 'ComponentNS', 'ComponentSWCVName', 'ComponentSWCVId',
  'ComponentType', 'direction', 'MessageProtocol', 'MessageProtocolVersion', 'TransportProtocol',
  'TransportProtocolVersion', 'Name', 'Description', 'system', 'Vendor', 'ifl:type',
]);
const NOT_A_STEP = new Set(['sequenceFlow', 'extensionElements', 'documentation', 'incoming', 'outgoing']);

function compactConfig(props: Props, maxLen: number): Record<string, Decoded> {
  const out: Record<string, Decoded> = {};
  for (const [k, v] of Object.entries(props)) {
    if (BOILERPLATE.has(k) || v === '') continue;
    const decoded = decodeTable(v);
    out[k] = typeof decoded === 'string' && maxLen && decoded.length > maxLen
      ? `${decoded.slice(0, maxLen)}…(${decoded.length} chars)`
      : decoded;
  }
  return out;
}

function describeContainer(container: Element, maxLen: number): Container {
  const steps: Step[] = [];
  const flows: Flow[] = [];
  for (const el of children(container)) {
    const tag = el.localName ?? '';
    if (tag === 'sequenceFlow') {
      const cond = children(el, 'conditionExpression')[0]?.textContent?.trim();
      const name = el.getAttribute('name');
      flows.push({
        id: el.getAttribute('id') ?? '', from: el.getAttribute('sourceRef') ?? '', to: el.getAttribute('targetRef') ?? '',
        ...(name ? { name } : {}), ...(cond ? { condition: cond } : {}),
      });
      continue;
    }
    if (NOT_A_STEP.has(tag)) continue;
    const eventDef = children(el).find((c) => c.localName?.endsWith('EventDefinition'));
    const props = { ...readProps(el), ...(eventDef ? readProps(eventDef) : {}) };
    const variant = parseVariant(props.cmdVariantUri);
    const version = variant.version ?? props.componentVersion;
    const kind = props.activityType
      ? props.activityType + (props.subActivityType ? `:${props.subActivityType}` : '')
      : (eventDef ? eventDef.localName!.replace('EventDefinition', '') : variant.cname);
    const step: Step = {
      id: el.getAttribute('id') ?? '', name: el.getAttribute('name') ?? '', bpmn: tag,
      ...(kind ? { kind } : {}), ...(version ? { version } : {}),
    };
    const dflt = el.getAttribute('default');
    if (dflt) step.defaultFlow = dflt;
    if (tag === 'subProcess') {
      // SAP marks exception sub-processes via activityType, not BPMN's triggeredByEvent
      step.eventSubProcess = props.activityType === 'ErrorEventSubProcessTemplate' || el.getAttribute('triggeredByEvent') === 'true';
      Object.assign(step, describeContainer(el, maxLen));
    }
    const config = compactConfig(props, maxLen);
    if (Object.keys(config).length) step.config = config;
    steps.push(step);
  }
  return { steps, flows };
}

/** maxLen: longer string values are cut (0 = never) */
export function describe(doc: Document, { maxLen = 160 }: { maxLen?: number } = {}): IflowModel {
  const collab = byTag(doc, 'collaboration')[0];
  if (!collab) throw new Error('not an iFlow: no bpmn2:collaboration element');
  const participants: Participant[] = children(collab, 'participant').map((p) => {
    const process = p.getAttribute('processRef');
    return {
      id: p.getAttribute('id') ?? '', name: p.getAttribute('name') ?? '', type: p.getAttributeNS(NS.ifl, 'type') ?? '',
      ...(process ? { process } : {}),
    };
  });
  const adapters: Adapter[] = children(collab, 'messageFlow').map((mf) => {
    const props = readProps(mf);
    const version = parseVariant(props.cmdVariantUri).version ?? props.componentVersion;
    return {
      id: mf.getAttribute('id') ?? '', ...(mf.getAttribute('name') ? { name: mf.getAttribute('name')! } : {}),
      from: mf.getAttribute('sourceRef') ?? '', to: mf.getAttribute('targetRef') ?? '',
      ...(props.ComponentType ? { adapter: props.ComponentType } : {}),
      ...(props.direction ? { direction: props.direction } : {}),
      ...(version ? { version } : {}),
      config: compactConfig(props, maxLen),
    };
  });
  const processes: Process[] = byTag(doc, 'process').map((proc) => {
    const kind = parseVariant(readProps(proc).cmdVariantUri).cname;
    return { id: proc.getAttribute('id') ?? '', name: proc.getAttribute('name') ?? '', ...(kind ? { kind } : {}), ...describeContainer(proc, maxLen) };
  });
  numberSteps(processes);
  const xml = serializeIflw(doc);
  const externalizedParameters = [...new Set([...xml.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]!))];
  return { integrationFlow: compactConfig(readProps(collab), maxLen), participants, adapters, processes, externalizedParameters, resourceRefs: resourceRefs(doc) };
}

// Display numbers (#1, #2, ...) in flow order, for talking about steps; never written into the iFlow.
// Main process first, then local processes, then exception sub-processes; within a container depth-first
// from the start events, routes in document order. Gateways count, events and sub-process frames do not.
// Numbers shift when steps are inserted, so match by id, never by number.
function numberSteps(processes: Process[]) {
  let n = 0;
  const later: Step[] = [];
  const walk = (container: Container) => {
    const byId = new Map(container.steps.map((s) => [s.id, s]));
    const next = new Map<string, string[]>();
    for (const f of container.flows) next.set(f.from, [...(next.get(f.from) ?? []), f.to]);
    const seen = new Set<string>();
    const visit = (id: string) => {
      const s = byId.get(id);
      if (seen.has(id) || !s) return;
      seen.add(id);
      if (!s.bpmn.endsWith('Event') && s.bpmn !== 'subProcess') s.no = ++n;
      for (const t of next.get(id) ?? []) visit(t);
    };
    for (const s of container.steps) if (s.bpmn === 'startEvent') visit(s.id);
    for (const s of container.steps) if (!seen.has(s.id) && s.bpmn !== 'subProcess') visit(s.id); // unreachable
    for (const s of container.steps) if (s.bpmn === 'subProcess') later.push(s);
  };
  const main = processes.filter((p) => p.kind === 'IntegrationProcess');
  for (const p of [...main, ...processes.filter((p) => !main.includes(p))]) walk(p);
  for (let i = 0; i < later.length; i++) walk(later[i] as Container); // walk() may append nested sub-processes
}

/** Files under src/main/resources that steps point to (scripts, mappings, XSLT, ...) */
export function resourceRefs(doc: Document): ResourceRef[] {
  const refs: ResourceRef[] = [];
  for (const el of [...byTag(doc, 'callActivity'), ...byTag(doc, 'serviceTask')]) {
    const p = readProps(el);
    const step = el.getAttribute('id') ?? '';
    if (p.script) refs.push({ step, type: 'script', path: `script/${p.script}` });
    // dir://mmap/src/main/resources/... (message mapping) or dir://mapping/xslt/src/main/resources/... (XSLT)
    const m = (p.mappinguri ?? '').match(/^dir:\/\/.*?\/src\/main\/resources\/(.+)$/);
    if (m) refs.push({ step, type: p.activityType === 'Mapping' ? 'mapping' : 'resource', path: m[1]! });
  }
  return refs;
}

// ---------- Mermaid: diagram that renders in Markdown, GitHub, VS Code preview and PR reviews ----------

export function toMermaid(model: IflowModel): string {
  const esc = (s: string | undefined) => String(s ?? '').replace(/"/g, '#quot;').replace(/[<>]/g, '');
  const lines = ['flowchart LR'];
  const node = (s: Step) => {
    // "#" starts a Mermaid entity code, so the display number is written as #35;
    const label = `${s.no ? `#35;${s.no} ` : ''}${esc(s.name || s.id)}<br/><i>${esc(s.kind || s.bpmn)}</i>`;
    if (s.bpmn.endsWith('Gateway')) return `${s.id}{"${label}"}`;
    if (s.bpmn.endsWith('Event')) return `${s.id}(("${esc(s.name || s.kind)}"))`;
    return `${s.id}["${label}"]`;
  };
  const emit = (container: Container, indent: string) => {
    for (const s of container.steps) {
      if (s.bpmn === 'subProcess') {
        lines.push(`${indent}subgraph ${s.id}["${esc(s.name || 'Sub-process')}"]`);
        emit(s as Container, `${indent}  `);
        lines.push(`${indent}end`);
      } else lines.push(indent + node(s));
    }
    for (const f of container.flows) {
      const label = f.name || f.condition;
      lines.push(`${indent}${f.from} -->${label ? `|"${esc(label).slice(0, 40)}"|` : ''} ${f.to}`);
    }
  };
  for (const p of model.participants.filter((p) => !p.process)) lines.push(`  ${p.id}[/"${esc(p.name)}"/]`);
  for (const proc of model.processes) {
    lines.push(`  subgraph ${proc.id}["${esc(proc.name)}"]`);
    emit(proc, '    ');
    lines.push('  end');
  }
  for (const a of model.adapters) lines.push(`  ${a.from} -.->|"${esc(a.adapter)}"| ${a.to}`);
  return lines.join('\n');
}
