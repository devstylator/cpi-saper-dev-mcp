// Structural checks an agent gets as feedback before anything reaches the tenant.
import type { Document, Element, Node } from '@xmldom/xmldom';
import { byTag, children, NS, resourceRefs, serializeIflw } from './model.js';

export interface Issue { severity: 'error' | 'warning'; code: string; msg: string }

const NOT_A_STEP = new Set(['sequenceFlow', 'extensionElements', 'documentation', 'incoming', 'outgoing']);
const isEl = (n: Node | null | undefined): n is Element => !!n && n.nodeType === 1;

export interface ValidateContext {
  /** paths below src/main/resources, e.g. "script/script1.groovy" (enables the missing-resource check) */
  resourceFiles?: Set<string>;
  /** parameter names declared in parameters.propdef (enables the undeclared-parameter check) */
  declaredParameters?: Set<string>;
}

export function validate(doc: Document, { resourceFiles, declaredParameters }: ValidateContext = {}): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue['severity'], code: string, msg: string) => issues.push({ severity, code, msg });
  const index = new Map<string, Element>();
  const walk = (el: Element) => {
    const id = el.getAttribute('id');
    if (id) index.has(id) ? add('error', 'DUPLICATE_ID', id) : index.set(id, el);
    for (const c of Array.from(el.childNodes)) if (isEl(c)) walk(c);
  };
  if (doc.documentElement) walk(doc.documentElement);

  const shapes = new Set(byTag(doc, 'BPMNShape', NS.bpmndi).map((s) => s.getAttribute('bpmnElement')));
  const edges = new Set(byTag(doc, 'BPMNEdge', NS.bpmndi).map((s) => s.getAttribute('bpmnElement')));
  for (const diEl of [...byTag(doc, 'BPMNShape', NS.bpmndi), ...byTag(doc, 'BPMNEdge', NS.bpmndi)]) {
    if (!index.has(diEl.getAttribute('bpmnElement') ?? '')) add('error', 'DI_ORPHAN', `${diEl.getAttribute('id')} -> ${diEl.getAttribute('bpmnElement')}`);
  }

  for (const f of byTag(doc, 'sequenceFlow')) {
    const id = f.getAttribute('id') ?? '';
    const src = index.get(f.getAttribute('sourceRef') ?? '');
    const tgt = index.get(f.getAttribute('targetRef') ?? '');
    if (!src || !tgt) { add('error', 'DANGLING_FLOW', `${id}: ${f.getAttribute('sourceRef')} -> ${f.getAttribute('targetRef')}`); continue; }
    if (src.parentNode !== f.parentNode || tgt.parentNode !== f.parentNode) add('error', 'CROSS_CONTAINER_FLOW', id);
    if (!children(src, 'outgoing').some((o) => o.textContent?.trim() === id)) add('error', 'MISSING_OUTGOING', `${src.getAttribute('id')} lacks <outgoing>${id}`);
    if (!children(tgt, 'incoming').some((o) => o.textContent?.trim() === id)) add('error', 'MISSING_INCOMING', `${tgt.getAttribute('id')} lacks <incoming>${id}`);
    if (!edges.has(id)) add('warning', 'NO_DI_EDGE', id);
  }
  for (const io of [...byTag(doc, 'incoming'), ...byTag(doc, 'outgoing')]) {
    const ref = io.textContent?.trim() ?? '';
    if (!index.has(ref)) add('error', 'DANGLING_REF', `<${io.localName}>${ref} in ${(io.parentNode as Element).getAttribute('id')}`);
  }
  for (const mf of byTag(doc, 'messageFlow')) {
    for (const end of ['sourceRef', 'targetRef']) if (!index.has(mf.getAttribute(end) ?? '')) add('error', 'DANGLING_MESSAGE_FLOW', `${mf.getAttribute('id')}.${end}`);
    if (!edges.has(mf.getAttribute('id'))) add('warning', 'NO_DI_EDGE', mf.getAttribute('id') ?? '');
  }

  for (const c of [...byTag(doc, 'process'), ...byTag(doc, 'subProcess')]) {
    const nodes = children(c).filter((n) => !NOT_A_STEP.has(n.localName ?? ''));
    for (const n of nodes) if (!shapes.has(n.getAttribute('id'))) add('warning', 'NO_DI_SHAPE', n.getAttribute('id') ?? '');
    // every node should be reachable from a start event of its container
    const starts = nodes.filter((n) => n.localName === 'startEvent');
    if (!starts.length) { add('error', 'NO_START_EVENT', c.getAttribute('id') ?? ''); continue; }
    const next = new Map<string, string[]>();
    for (const f of children(c, 'sequenceFlow')) {
      const s = f.getAttribute('sourceRef') ?? '';
      next.set(s, [...(next.get(s) ?? []), f.getAttribute('targetRef') ?? '']);
    }
    const seen = new Set<string>();
    const stack = starts.map((s) => s.getAttribute('id') ?? '');
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    for (const n of nodes) {
      if (!seen.has(n.getAttribute('id') ?? '') && n.localName !== 'subProcess' && n.localName !== 'boundaryEvent') {
        add('warning', 'UNREACHABLE', `${n.getAttribute('id')} (${n.getAttribute('name') ?? ''})`);
      }
    }
  }

  if (resourceFiles) {
    for (const r of resourceRefs(doc)) {
      if (!resourceFiles.has(r.path)) add('error', 'MISSING_RESOURCE', `${r.step} -> src/main/resources/${r.path}`);
    }
  }
  if (declaredParameters) {
    for (const [, p] of serializeIflw(doc).matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (!declaredParameters.has(p!)) add('warning', 'UNDECLARED_PARAMETER', `{{${p}}} missing in parameters.propdef`);
    }
  }
  return issues;
}
