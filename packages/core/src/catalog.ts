// Step and adapter catalog: default settings of every component variant, harvested by maintainers from a palette
// iFlow (one fresh instance of each element) and bundled with the package.
// Key = cmdVariantUri without its version ("ctype::FlowstepVariant/cname::Enricher",
// "ctype::AdapterVariant/cname::sap:AMQP/tp::WS/mp::AMQP1.0/direction::Receiver"); every version seen is kept,
// because an iFlow may need to stay on the version it already uses (GroovyScript 1.1.2 vs 2.0.0).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Document } from '@xmldom/xmldom';
import { byTag, parseVariant, readProps, type Props } from './iflow/model.js';

export interface CatalogVersion {
  cmdVariantUri?: string;
  properties: Props;
  eventDefinition?: { element: string; properties: Props };
  attributes?: Record<string, string>;
  size?: { w: number; h: number };
  /** where this version was harvested */
  seen: string;
}

export interface CatalogEntry {
  kind: 'adapter' | 'step' | 'event' | 'process' | 'participant' | 'route';
  /** BPMN element: callActivity, serviceTask, exclusiveGateway, messageFlow, ... */
  bpmn: string;
  /** palette name without its number: "Content Modifier" */
  label: string;
  versions: Record<string, CatalogVersion>;
  latest: string;
}

export interface Catalog {
  format: number;
  sources: Array<{ iflow: string; version?: string; harvested: string; tenant?: string; zip?: string }>;
  entries: Record<string, CatalogEntry>;
}

export const BUNDLED_CATALOG = fileURLToPath(new URL('../catalog/cpi-catalog.json', import.meta.url));

export function loadCatalog(path: string = BUNDLED_CATALOG): Catalog {
  const c = JSON.parse(readFileSync(path, 'utf8')) as Catalog;
  if (c.format !== 1 || typeof c.entries !== 'object') throw new Error(`${path}: not a step catalog (format 1)`);
  return c;
}

export const variantKey = (uri: string) => uri.replace(/\/version::[^/]*/, '');

export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Entries by full key, cname ("Enricher", "sap:HTTP") or label ("Content Modifier"), case-insensitive */
export function findEntries(catalog: Catalog, query: string): Array<[string, CatalogEntry]> {
  const exact = catalog.entries[query];
  if (exact) return [[query, exact]];
  const q = query.toLowerCase();
  return Object.entries(catalog.entries).filter(([key, e]) =>
    (parseVariant(key).cname ?? '').toLowerCase() === q || e.label.toLowerCase() === q);
}

/**
 * Version to use for a new element: the one the iFlow already uses for this variant if the catalog has it
 * (an iFlow should not mix versions), otherwise the catalog's latest, or the one asked for.
 */
export function pickVersion(entry: CatalogEntry, key: string, doc: Document, wanted?: string): { version: string; reason: string } {
  if (wanted) {
    if (!entry.versions[wanted]) throw new Error(`${key}: no version ${wanted} in the catalog (has ${Object.keys(entry.versions).join(', ')})`);
    return { version: wanted, reason: 'requested' };
  }
  const used = byTag(doc, entry.bpmn).map(readProps).map((p) => p.cmdVariantUri).filter((u): u is string => !!u && variantKey(u) === key)
    .map((u) => parseVariant(u).version).filter((v): v is string => !!v && !!entry.versions[v]).sort(cmpVersion);
  return used.length ? { version: used[0]!, reason: 'already used in this iFlow' } : { version: entry.latest, reason: 'latest in catalog' };
}
