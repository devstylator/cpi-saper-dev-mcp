// Structural checks an agent gets as feedback before anything reaches the tenant.
import type { Document, Element, Node } from '@xmldom/xmldom';
import { ADAPTER_INTO_STEP, adapterMisfit } from './adapter-fit.js';
import { byTag, children, decodeTable, NS, parseVariant, readProps, resourceRefs, serializeIflw, type Props } from './model.js';

export interface Issue { severity: 'error' | 'warning'; code: string; msg: string }

const NOT_A_STEP = new Set(['sequenceFlow', 'extensionElements', 'documentation', 'incoming', 'outgoing']);
const isEl = (n: Node | null | undefined): n is Element => !!n && n.nodeType === 1;

export interface ValidateContext {
  /** paths below src/main/resources, e.g. "script/script1.groovy" (enables the missing-resource check) */
  resourceFiles?: Set<string>;
  /** parameter names declared in parameters.propdef (enables the undeclared-parameter check) */
  declaredParameters?: Set<string>;
}

/**
 * Settings a step cannot do without, by component name. Cloud Integration refuses these only when it generates the
 * runtime (at deploy) or, for mappings, on every message. error: the refusal was observed on a tenant; warning: assumed.
 */
const REQUIRED: Record<string, { key: string; when?: (p: Props) => boolean; what: string; severity: Issue['severity'] }[]> = {
  GeneralSplitter: [{ key: 'splitExprValue', what: 'the split expression (XPath)', severity: 'error' }],
  Camel: [{ key: 'splitExprValue', what: 'the split expression', severity: 'warning' }],
  SimpleSignMessage: [{ key: 'privateKeyAlias', what: 'the private key alias', severity: 'error' }],
  XMLDigitalSignMessage: [{ key: 'privateKeyAlias', what: 'the private key alias', severity: 'warning' }],
  XSLTMapping: [{ key: 'mappinguri', when: (p) => p.mappingSource === 'mappingSrcIflow', what: 'the mapping file (iflow_edit "mapping")', severity: 'error' }],
  MessageMapping: [{ key: 'mappinguri', when: (p) => p.mappingReference === 'static', what: 'the mapping file (iflow_edit "mapping")', severity: 'error' }],
  Filter: [{ key: 'wrapContent', what: 'the XPath expression (iflow_edit "expression")', severity: 'error' }],
  GroovyScript: [{ key: 'script', what: 'the script file', severity: 'error' }],
  JavaScript: [{ key: 'script', what: 'the script file', severity: 'error' }],
};

/** Steps that only work with an adapter attached; error: observed on a tenant, warning: assumed */
const NEEDS_ADAPTER: Record<string, { what: string; severity: Issue['severity'] }> = {
  contentEnricherWithLookup: { what: 'a receiver adapter to fetch the lookup message from', severity: 'error' },
  ExternalCall: { what: 'a receiver adapter (Request Reply calls it)', severity: 'warning' },
  Send: { what: 'a receiver adapter', severity: 'warning' },
  PollEnrich: { what: 'a sender adapter to poll from', severity: 'warning' },
};

/** Issues the tenant reports only at deploy: they do not block edits or uploads, which the tenant accepts */
export const DEPLOY_CHECKS = new Set(['MISSING_SETTING', 'NO_ADAPTER', 'INVALID_SETTING']);

/** HTTP receiver authentication values as the designer writes them; a value that differs only in case is refused (observed: "none") */
const HTTP_RECEIVER_AUTH = ['None', 'Basic', 'Client Certificate', 'Principal Propagation', 'OAuth2 Client Credentials', 'OAuth2 SAML Bearer Assertion', 'OAuth2 Authorization Code'];

/** Sender authorization values the tenant accepts (observed: None and Basic are refused at deploy) */
const SENDER_AUTH = new Set(['RoleBased', 'ClientCertificate']);

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

  const messageFlows = byTag(doc, 'messageFlow');
  const adapterOn = new Set(messageFlows.flatMap((mf) => [mf.getAttribute('sourceRef'), mf.getAttribute('targetRef')]));
  for (const el of [...byTag(doc, 'callActivity'), ...byTag(doc, 'serviceTask')]) {
    const p = readProps(el);
    const cname = parseVariant(p.cmdVariantUri).cname ?? p.activityType ?? '';
    const label = `${el.getAttribute('id')} (${el.getAttribute('name') ?? ''})`;
    for (const r of REQUIRED[cname] ?? []) {
      if (!p[r.key]?.trim() && (!r.when || r.when(p))) add(r.severity, 'MISSING_SETTING', `${label}: ${r.key} is empty; set ${r.what}`);
    }
    const need = NEEDS_ADAPTER[cname];
    if (need && !adapterOn.has(el.getAttribute('id'))) add(need.severity, 'NO_ADAPTER', `${label} needs ${need.what} (iflow_edit add_adapter)`);
    // measured: SAP's model check refuses these step/adapter pairs ("not supported for the adapter"), and a Content
    // Enricher whose adapter points away from it; the tenant accepts the upload, so they are caught here, before a version
    for (const mf of messageFlows.filter((f) => f.getAttribute('sourceRef') === el.getAttribute('id') || f.getAttribute('targetRef') === el.getAttribute('id'))) {
      const misfit = adapterMisfit(cname, readProps(mf).cmdVariantUri ?? '');
      if (misfit) add('error', 'ADAPTER_NOT_SUPPORTED', `${label}: ${misfit}`);
      if (ADAPTER_INTO_STEP.has(cname) && mf.getAttribute('sourceRef') === el.getAttribute('id')) {
        add('error', 'ADAPTER_DIRECTION', `${label}: its adapter ${mf.getAttribute('id')} must point from the receiver box to the step (SAP: "You must connect from external system to" it); remove it and add it again with iflow_edit add_adapter`);
      }
    }
    // a Process Call or Looping Process Call must name an existing local process; a looping one its loop element
    if (p.activityType === 'ProcessCallElement') {
      const target = p.processId ? byTag(doc, 'process').find((x) => x.getAttribute('id') === p.processId) : undefined;
      if (!p.processId?.trim()) add('error', 'MISSING_SETTING', `${label}: processId is empty; set the local integration process to call (iflow_edit insert_step "process")`);
      else if (!target) add('error', 'INVALID_SETTING', `${label}: calls ${p.processId}, which is not a process of this iFlow`);
      else if (readProps(target).processType !== 'directCall') add('error', 'INVALID_SETTING', `${label}: calls ${p.processId}, which is not a local integration process`);
      if (p.subActivityType === 'LoopingProcess') {
        const loop = children(el, 'standardLoopCharacteristics')[0];
        if (!loop || loop.getAttribute('id') !== p.loopId) add('error', 'INVALID_SETTING', `${label}: the loop (standardLoopCharacteristics ${p.loopId ?? ''}) is missing; insert the step with "loop"`);
        // measured: SAP's model check refuses "${property.i} < 3" ("Invalid format of condition expression value");
        // "${property.i} < '3'" passes
        const cond = loop ? children(loop, 'loopCondition')[0]?.textContent?.trim() ?? '' : '';
        if (p.expressionType !== 'XML' && /(?:<=|>=|!=|=|<|>)\s*(?!['"$])[^\s')]+/.test(cond)) {
          add('error', 'INVALID_SETTING', `${label}: loop condition "${cond}": put the compared value in quotes (e.g. < '3'); SAP's model check refuses it otherwise`);
        }
      }
    }
    // measured by a tester: a Groovy step 2.x finds its script only under script/v2/ ("Script file '…' not found")
    const version = parseVariant(p.cmdVariantUri).version ?? '';
    if (cname === 'GroovyScript' && version.startsWith('2.') && p.script && !p.scriptBundleId?.trim() && !p.script.startsWith('v2/')) {
      add('error', 'INVALID_SETTING', `${label}: a Groovy Script ${version} step takes its script from script/v2/; set script to "v2/${p.script}" and move the file there`);
    }
    // a header or property name starting with a digit or holding spaces is refused by SAP's model check (tester report)
    for (const table of ['headerTable', 'propertyTable'] as const) {
      const rows = p[table] ? decodeTable(p[table]!) : [];
      for (const r of Array.isArray(rows) ? rows : []) {
        const name = Array.isArray(r) ? '' : String((r as Record<string, string>).Name ?? '');
        if (name && /^\d|\s/.test(name)) add('warning', 'INVALID_SETTING', `${label}: ${table === 'headerTable' ? 'header' : 'property'} name "${name}" starts with a digit or has spaces; Cloud Integration refuses such names`);
      }
    }
  }
  // measured by a tester: Camel Simple conditions (NonXML) compare with =, the tenant refuses == at deploy
  for (const f of byTag(doc, 'sequenceFlow')) {
    const cond = children(f, 'conditionExpression')[0]?.textContent ?? '';
    if (readProps(f).expressionType === 'NonXML' && /==/.test(cond)) {
      add('error', 'INVALID_SETTING', `route ${f.getAttribute('id')} (${f.getAttribute('name') ?? ''}): condition "${cond.trim()}" uses ==; Camel Simple compares with = (also !=, >, >=, <, <=, contains, in, regex)`);
    }
  }
  // the user's rule: a timer's schedule is always externalized (configurable on the tenant without a new version)
  for (const t of byTag(doc, 'timerEventDefinition')) {
    const key = readProps(t).scheduleKey ?? '';
    if (!/^\{\{[^{}]+\}\}$/.test(key.trim())) {
      add('warning', 'SCHEDULE_NOT_EXTERNALIZED', `${(t.parentNode as Element).getAttribute('id')}: the timer's schedule is not externalized; iflow_edit set_start writes it as a parameter`);
    }
  }
  // measured: "entryId,fail" let no header through; the list is separated by |
  const allowed = byTag(doc, 'collaboration')[0] ? readProps(byTag(doc, 'collaboration')[0]!).allowedHeaderList : undefined;
  if (allowed?.includes(',')) add('warning', 'ALLOWED_HEADERS', `allowedHeaderList "${allowed}": headers are separated by | (with commas no header gets through): "${allowed.split(/\s*,\s*/).join('|')}"`);
  for (const part of byTag(doc, 'participant')) {
    const type = part.getAttribute('ifl:type') || readProps(part)['ifl:type'];
    const name = part.getAttribute('name') ?? '';
    if ((type === 'EndpointRecevier' || type === 'EndpointSender') && /\s/.test(name)) {
      // observed for receivers ("Whitespace not allowed in Receiver name"); assumed for senders
      add(type === 'EndpointRecevier' ? 'error' : 'warning', 'INVALID_SETTING',
        `${part.getAttribute('id')}: ${type === 'EndpointRecevier' ? 'Receiver' : 'Sender'} name "${name}" contains whitespace, which Cloud Integration refuses; rename it (iflow_edit rename)`);
    }
  }
  for (const mf of byTag(doc, 'messageFlow')) {
    const p = readProps(mf);
    const label = `${mf.getAttribute('id')} (${mf.getAttribute('name') ?? ''})`;
    if (p.direction === 'Receiver' && p.ComponentType === 'HTTP' && p.authenticationMethod) {
      const known = HTTP_RECEIVER_AUTH.find((v) => v.toLowerCase() === p.authenticationMethod!.toLowerCase());
      if (known && known !== p.authenticationMethod) add('error', 'INVALID_SETTING', `${label}: authenticationMethod "${p.authenticationMethod}" must be written "${known}"`);
    }
    if (p.direction !== 'Sender' || p.senderAuthType === undefined) continue;
    if (!SENDER_AUTH.has(p.senderAuthType)) add('error', 'INVALID_SETTING', `${label}: senderAuthType "${p.senderAuthType}" is refused by Cloud Integration; use RoleBased (with userRole) or ClientCertificate`);
    else if (p.senderAuthType === 'ClientCertificate' && !p.clientCertificates?.trim()) add('error', 'MISSING_SETTING', `${label}: senderAuthType ClientCertificate needs clientCertificates (at least one certificate row)`);
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
