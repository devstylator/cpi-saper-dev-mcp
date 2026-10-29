import { relative } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describe, diffIflows, findEntries, iflowFromZip, toMermaid, validate } from '@cpi-saper-dev-mcp/core';
import { catalogOf, context, localIflow } from '../context.js';
import { toolError, toolResult } from '../result.js';

const iflowArg = z.string().describe(
  'Local iFlow: its Id (searched as <workspace>/<package>/<id>/), its folder, or its .iflw file; relative paths are resolved against the workspace',
);

export function registerUnderstandTools(server: McpServer) {
  server.registerTool(
    'iflow_describe',
    {
      title: 'Describe an iFlow',
      description:
        'Compact model of a local iFlow instead of BPMN XML: participants, adapters with settings, processes with steps ' +
        '(kind, version, settings, decoded header/property tables), routes with conditions, externalized parameters, ' +
        'and files the steps use. Steps carry a display number "no" in flow order (#1, #2, ...) for talking about ' +
        'them; refer to steps by id in tool calls, since numbers shift when steps are inserted. detail "summary" cuts ' +
        'long values at 160 characters, "full" keeps them.',
      inputSchema: { iflow: iflowArg, detail: z.enum(['summary', 'full']).default('summary') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ iflow, detail }) => {
      try {
        const ctx = await context(server);
        const { located, doc } = localIflow(ctx, iflow);
        return toolResult({ file: relative(ctx.workspace.root, located.iflwPath), ...describe(doc, { maxLen: detail === 'full' ? 0 : 160 }) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'iflow_render',
    {
      title: 'Diagram of an iFlow',
      description: 'Mermaid flowchart of a local iFlow (steps with their display numbers, routes, adapters). Show it to the user in a ```mermaid block.',
      inputSchema: { iflow: iflowArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ iflow }) => {
      try {
        const ctx = await context(server);
        const { doc } = localIflow(ctx, iflow);
        const mermaid = toMermaid(describe(doc));
        return { content: [{ type: 'text', text: `\`\`\`mermaid\n${mermaid}\n\`\`\`` }], structuredContent: { mermaid } };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'iflow_validate',
    {
      title: 'Check an iFlow',
      description:
        'Structural checks of a local iFlow before it goes to the tenant: duplicate ids, dangling or inconsistent flows, ' +
        'missing diagram shapes, unreachable steps, script/mapping files that do not exist, and {{parameters}} not ' +
        'declared in parameters.propdef. Errors would break the iFlow; warnings deserve a look.',
      inputSchema: { iflow: iflowArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ iflow }) => {
      try {
        const ctx = await context(server);
        const { located, doc } = localIflow(ctx, iflow);
        const issues = validate(doc, located);
        return toolResult({
          file: relative(ctx.workspace.root, located.iflwPath),
          errors: issues.filter((i) => i.severity === 'error').length,
          warnings: issues.filter((i) => i.severity === 'warning').length,
          issues,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'iflow_diff',
    {
      title: 'Changes in an iFlow',
      description:
        'Model-level changes of a local iFlow: steps and adapters added, removed, renamed or re-versioned, settings old -> ' +
        'new, table rows, and flows as connections between named steps. Layout and ids the designer regenerates on ' +
        'every save are left out. Without "against", compares with the state of the last cpi_pull (what was changed ' +
        'locally since); with "against", compares that iFlow (old) with this one (new). Numbers (#n) are those of the new version.',
      inputSchema: {
        iflow: iflowArg.describe('The new (or locally changed) iFlow'),
        against: z.string().optional().describe('The old iFlow (Id, folder or .iflw); default: the last pulled state of "iflow"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ iflow, against }) => {
      try {
        const ctx = await context(server);
        const now = localIflow(ctx, iflow);
        let oldDoc;
        let base: string;
        if (against) {
          const old = localIflow(ctx, against);
          oldDoc = old.doc;
          base = relative(ctx.workspace.root, old.located.iflwPath);
        } else {
          const pulled = now.located.dir ? ctx.workspace.pulledStateFor(now.located.dir) : undefined;
          if (!pulled) throw new Error(`no pulled state for ${iflow}: pull it with cpi_pull first, or give "against"`);
          oldDoc = iflowFromZip(pulled.zip);
          base = `last pull from ${pulled.state.tenant} (version ${pulled.state.version ?? '?'}, ${pulled.state.pulledAt})`;
        }
        const changes = diffIflows(describe(oldDoc, { maxLen: 0 }), describe(now.doc, { maxLen: 0 }), { docA: oldDoc, docB: now.doc });
        return {
          content: [{ type: 'text', text: `${base} -> ${relative(ctx.workspace.root, now.located.iflwPath)}\n${changes.length ? changes.join('\n') : 'no model changes'}` }],
          structuredContent: { old: base, new: relative(ctx.workspace.root, now.located.iflwPath), changes },
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'templates_list',
    {
      title: 'Step and adapter catalog',
      description:
        'The bundled catalog of Cloud Integration steps and adapters with their default settings, per variant and ' +
        'version. Without query: one line per variant (kind, label, versions, key). With query (key, component name ' +
        'like "Enricher" or "sap:HTTP", or label like "Content Modifier"): the matching entries with all default properties.',
      inputSchema: {
        query: z.string().optional(),
        kind: z.enum(['adapter', 'step', 'event', 'process', 'participant', 'route']).optional().describe('Only entries of this kind (list mode)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, kind }) => {
      try {
        const ctx = await context(server);
        const catalog = catalogOf(ctx.config);
        if (query) {
          const matches = findEntries(catalog, query);
          if (!matches.length) throw new Error(`"${query}" is not in the catalog; call templates_list without query to see all entries`);
          return toolResult({ matches: matches.map(([key, e]) => ({ key, ...e })) });
        }
        const entries = Object.entries(catalog.entries).filter(([, e]) => !kind || e.kind === kind)
          .map(([key, e]) => ({ key, kind: e.kind, label: e.label, versions: Object.keys(e.versions), latest: e.latest }));
        return toolResult({ sources: catalog.sources, entries });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
