// A batch of semantic edits, applied in order to one iFlow DOM. Callers validate and write only if all succeed.
import type { Document } from '@xmldom/xmldom';
import { findEntries, pickVersion, type Catalog } from '../catalog.js';
import { editTable, findElement, insertStepAfter, removeStep, rename, setProperties, type TableRowInput } from './edit.js';
import { parseVariant, type Props } from './model.js';

export type EditOp =
  | {
    op: 'insert_step';
    /** id or unique name of the step to insert after */
    after: string;
    /** catalog entry: key, component name ("Enricher") or label ("Content Modifier") */
    type: string;
    version?: string;
    name?: string;
    /** settings to change from the catalog defaults (existing keys only) */
    settings?: Props;
    headers?: TableRowInput[];
    properties?: TableRowInput[];
  }
  | { op: 'remove_step'; step: string }
  | { op: 'set'; element: string; settings: Props; allowNewKeys?: boolean }
  | { op: 'rename'; element: string; name: string }
  | { op: 'headers' | 'properties'; step: string; set?: TableRowInput[]; remove?: string[] };

const TABLE_KEYS = new Set(['headerTable', 'propertyTable']);
const SCRIPT_STEPS = new Set(['GroovyScript', 'JavaScript']);

/** Applies the operations; returns one line per operation describing what happened */
export function applyEdits(doc: Document, ops: EditOp[], catalog: Catalog): string[] {
  const log: string[] = [];
  ops.forEach((op, i) => {
    const where = `operation ${i + 1} (${op.op})`;
    try {
      switch (op.op) {
        case 'insert_step': {
          const matches = findEntries(catalog, op.type);
          if (matches.length !== 1) {
            throw new Error(matches.length ? `"${op.type}" is ambiguous: ${matches.map(([k]) => k).join(', ')}` : `"${op.type}" is not in the catalog`);
          }
          const [key, entry] = matches[0]!;
          if (!['callActivity', 'serviceTask'].includes(entry.bpmn)) throw new Error(`${entry.label} (${entry.bpmn}) cannot be inserted as a step yet`);
          const { version, reason } = pickVersion(entry, key, doc, op.version);
          const properties: Props = { ...entry.versions[version]!.properties };
          const after = findElement(doc, op.after).getAttribute('id')!;
          for (const k of Object.keys(op.settings ?? {})) {
            if (TABLE_KEYS.has(k)) throw new Error(`use "headers"/"properties" instead of the raw ${k} setting`);
            if (!(k in properties)) throw new Error(`${entry.label} ${version} has no setting "${k}"; settings: ${Object.keys(properties).sort().join(', ')}`);
          }
          Object.assign(properties, op.settings);
          const cname = parseVariant(key).cname ?? '';
          if (SCRIPT_STEPS.has(cname) && !properties.script) {
            throw new Error(`${entry.label} needs settings.script: the file name under script/ (${version.startsWith('2.') ? 'v2/<name>.groovy for script step 2.x' : '<name>.groovy'})`);
          }
          const { stepId } = insertStepAfter(doc, after, {
            name: op.name ?? entry.label, properties, bpmn: entry.bpmn, ...(entry.versions[version]!.size ? { size: entry.versions[version]!.size! } : {}),
          });
          const el = findElement(doc, stepId);
          if (op.headers?.length) editTable(el, 'headerTable', { set: op.headers });
          if (op.properties?.length) editTable(el, 'propertyTable', { set: op.properties });
          log.push(`inserted ${stepId} "${op.name ?? entry.label}" (${entry.label} ${version}, ${reason}) after ${after}`);
          break;
        }
        case 'remove_step': {
          const id = findElement(doc, op.step).getAttribute('id')!;
          removeStep(doc, id);
          log.push(`removed ${id}`);
          break;
        }
        case 'set': {
          const el = findElement(doc, op.element);
          for (const k of Object.keys(op.settings)) if (TABLE_KEYS.has(k)) throw new Error(`use the "headers"/"properties" operation instead of the raw ${k} setting`);
          setProperties(el, op.settings, { allowNewKeys: op.allowNewKeys ?? false });
          log.push(`set ${Object.keys(op.settings).join(', ')} on ${el.getAttribute('id') ?? 'integrationFlow'}`);
          break;
        }
        case 'rename': {
          const el = findElement(doc, op.element);
          const old = el.getAttribute('name');
          rename(el, op.name);
          log.push(`renamed ${el.getAttribute('id')} "${old}" -> "${op.name}"`);
          break;
        }
        case 'headers':
        case 'properties': {
          const el = findElement(doc, op.step);
          editTable(el, op.op === 'headers' ? 'headerTable' : 'propertyTable', { set: op.set ?? [], remove: op.remove ?? [] });
          log.push(`${op.op} of ${el.getAttribute('id')}: ${[...(op.set ?? []).map((r) => `set ${r.name}`), ...(op.remove ?? []).map((n) => `removed ${n}`)].join(', ')}`);
          break;
        }
        default:
          throw new Error(`unknown operation ${(op as { op: string }).op}`);
      }
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
  });
  return log;
}
