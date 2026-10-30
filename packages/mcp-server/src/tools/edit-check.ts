import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  applyEdits, describe, diffIflows, findElement, groovyVersionOf, loadServiceKey, mappingText, parseIflw, readMapping,
  resourceRefs, runScript, runXslt, selectTenant, serializeIflw, validate, CpiClient, type EditOp,
} from '@cpi-saper-dev-mcp/core';
import { catalogOf, context, localIflow, type ToolContext } from '../context.js';
import { toolError, toolResult } from '../result.js';

const iflowArg = z.string().describe('Local iFlow: its Id (searched as <workspace>/<package>/<id>/), its folder, or its .iflw file');
const ref = z.string().describe('Step id (preferred) or its exact, unique name');
const kv = z.record(z.string(), z.string());

const row = z.object({
  name: z.string(),
  value: z.string(),
  type: z.enum(['constant', 'expression', 'xpath', 'header', 'property']).default('constant')
    .describe('constant; expression = Camel Simple like ${header.x}; xpath; header/property = copy from another header/property'),
  datatype: z.string().optional().describe('Java type, e.g. java.lang.String (xpath result type)'),
  action: z.enum(['Create', 'Delete']).default('Create'),
});

const operation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert_step'),
    after: ref.describe('Step after which to insert (must have exactly one outgoing flow)'),
    type: z.string().describe('Catalog entry (templates_list): label like "Content Modifier", component name like "Enricher", or key'),
    version: z.string().optional().describe('Component version; default: the version this iFlow already uses, else the latest'),
    name: z.string().optional().describe('Step name; default: the catalog label'),
    settings: kv.optional().describe('Settings to change from the catalog defaults; script steps need "script" (file under script/, v2/<name>.groovy for 2.x)'),
    mapping: z.string().optional().describe('XSLT Mapping / Message Mapping: the file under src/main/resources, e.g. "mapping/orders.xsl" (a bare name means mapping/); sets mappinguri, mappingpath and mappingname as the designer does'),
    headers: z.array(row).optional().describe('Content Modifier: message headers to set'),
    properties: z.array(row).optional().describe('Content Modifier: exchange properties to set'),
  }),
  z.object({ op: z.literal('remove_step'), step: ref.describe('Step to remove (an adapter on it must be removed first)') }),
  z.object({
    op: z.literal('add_adapter'),
    step: ref.describe('Where the adapter connects: a message start event or Poll Enrich (sender adapter), Request Reply, Send, Content Enricher or a message end event (receiver adapter)'),
    type: z.string().describe('Adapter from the catalog (templates_list kind=adapter): label like "SFTP", component name like "sap:HTTP", or key when the label is ambiguous (OData); the direction follows from the step'),
    version: z.string().optional().describe('Adapter version; default: the version this iFlow already uses, else the latest'),
    name: z.string().optional().describe('Label of the connection in the diagram; default: the adapter type'),
    participant: z.string().optional().describe('Sender/Receiver box (id or name) to connect; a new box when no box has this name; default: a free box, else a new one'),
    settings: kv.optional().describe('Settings to change from the catalog defaults (e.g. urlPath for HTTPS, httpAddressWithoutQuery for HTTP)'),
  }),
  z.object({ op: z.literal('layout') }).describe('Tidy the diagram of a straight iFlow (Start -> steps -> End, one process, no branches): one evenly spaced row, the pool fitted, receivers below their steps; branched flows are refused'),
  z.object({ op: z.literal('remove_adapter'), adapter: z.string().describe('Adapter (message flow) id or unique name; its Sender/Receiver box stays') }),
  z.object({
    op: z.literal('set'),
    element: z.string().describe('Step, adapter (message flow) id or unique name, or "integrationFlow" for the iFlow\'s own settings'),
    settings: kv.optional(),
    mapping: z.string().optional().describe('XSLT Mapping / Message Mapping: the file under src/main/resources, e.g. "mapping/orders.xsl" (a bare name means mapping/); sets mappinguri, mappingpath and mappingname as the designer does'),
    allowNewKeys: z.boolean().default(false).describe('Allow keys the element does not have yet (normally a typo)'),
  }),
  z.object({ op: z.literal('rename'), element: z.string(), name: z.string() }),
  z.object({ op: z.literal('headers'), step: ref, set: z.array(row).optional(), remove: z.array(z.string()).optional().describe('Header names to drop from the table') }),
  z.object({ op: z.literal('properties'), step: ref, set: z.array(row).optional(), remove: z.array(z.string()).optional() }),
]);

/** A file in the workspace (relative or absolute path) or the resource a step of a local iFlow uses */
function fileArg(ctx: ToolContext, args: { file?: string | undefined; iflow?: string | undefined; step?: string | undefined }, what: string): string {
  if (args.file) return isAbsolute(args.file) ? args.file : resolve(ctx.workspace.root, args.file);
  if (!args.iflow || !args.step) throw new Error(`give the ${what} as "file", or as "iflow" plus "step"`);
  const { located, doc } = localIflow(ctx, args.iflow);
  const id = findElement(doc, args.step).getAttribute('id');
  const r = resourceRefs(doc).find((x) => x.step === id);
  if (!r || !located.dir) throw new Error(`step ${args.step} of ${args.iflow} uses no ${what} file`);
  return join(located.dir, 'src', 'main', 'resources', r.path);
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n…(cut: ${s.length} characters, limit output.maxChars = ${max})` : s);

export function registerEditCheckTools(server: McpServer) {
  server.registerTool(
    'iflow_edit',
    {
      title: 'Edit an iFlow',
      description:
        'Apply semantic edits to a local iFlow in one batch: insert a step from the catalog (with settings, headers, ' +
        'properties), remove a step (its neighbours are reconnected), add or remove an adapter (with its Sender/Receiver ' +
        'box), tidy the layout of a straight flow, change settings of a step, adapter or the iFlow, ' +
        'rename, and add/change/remove Content Modifier headers and properties. All operations succeed or nothing is ' +
        'written; edits that would introduce structural errors are refused. New elements are formatted like SAP\'s ' +
        'designer writes them and the diagram is laid out. Returns what changed (as iflow_diff) and the new step ids. ' +
        'Script and mapping files are not created: write them yourself (missing ones are listed under "filesToCreate").',
      inputSchema: {
        iflow: iflowArg,
        operations: z.array(operation).min(1),
        dryRun: z.boolean().default(false).describe('Show the result without writing the file'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ iflow, operations, dryRun }) => {
      try {
        const ctx = await context(server);
        const { located, doc } = localIflow(ctx, iflow);
        const before = parseIflw(serializeIflw(doc));
        const known = new Set(validate(before, located).map((i) => `${i.code} ${i.msg}`));
        const log = applyEdits(doc, operations as EditOp[], catalogOf(ctx.config));
        const issues = validate(doc, located).filter((i) => !known.has(`${i.code} ${i.msg}`));
        const filesToCreate = issues.filter((i) => i.code === 'MISSING_RESOURCE').map((i) => i.msg.replace(/^.* -> /, ''));
        const blocking = issues.filter((i) => i.severity === 'error' && i.code !== 'MISSING_RESOURCE');
        if (blocking.length) {
          throw new Error(`not written: the edits would introduce errors:\n${blocking.map((i) => `  ${i.code} ${i.msg}`).join('\n')}`);
        }
        if (!dryRun) writeFileSync(located.iflwPath, serializeIflw(doc));
        const changes = diffIflows(describe(before, { maxLen: 0 }), describe(doc, { maxLen: 0 }), { docA: before, docB: doc });
        return toolResult({
          file: relative(ctx.workspace.root, located.iflwPath),
          written: !dryRun,
          operations: log,
          changes,
          filesToCreate,
          warnings: issues.filter((i) => i.severity === 'warning').map((i) => `${i.code} ${i.msg}`),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'xslt_run',
    {
      title: 'Run an XSLT',
      description:
        'Run an XSLT (1.0, 2.0 or 3.0) locally like a CPI XSLT Mapping step: headers and exchange properties are ' +
        'passed as xsl:param by name. Returns the output, xsl:message texts, or the error with its code and line. ' +
        'Runs SaxonJS: Java extension functions and schema-aware XSLT are not available (see the known limitations).',
      inputSchema: {
        file: z.string().optional().describe('XSLT file (relative to the workspace or absolute)'),
        iflow: iflowArg.optional(),
        step: z.string().optional().describe('XSLT Mapping step of "iflow" (id or name), instead of "file"'),
        input: z.string().optional().describe('Input XML as text'),
        inputFile: z.string().optional().describe('Input XML file (relative to the workspace or absolute), instead of "input"'),
        headers: kv.optional(),
        properties: kv.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const ctx = await context(server);
        const xsl = fileArg(ctx, args, 'XSLT');
        const input = args.inputFile ? readFileSync(isAbsolute(args.inputFile) ? args.inputFile : resolve(ctx.workspace.root, args.inputFile), 'utf8') : args.input;
        if (input === undefined) throw new Error('give the input XML as "input" or "inputFile"');
        const r = runXslt({ stylesheetText: readFileSync(xsl, 'utf8'), stylesheetPath: xsl, input, headers: args.headers ?? {}, properties: args.properties ?? {} });
        const data = r.ok
          ? { ok: true, ms: r.ms, messages: r.messages, output: clip(r.output, ctx.config.output.maxChars) }
          : { ok: false, ms: r.ms, messages: r.messages, error: r.error };
        return { ...toolResult({ xslt: relative(ctx.workspace.root, xsl), ...data }), ...(r.ok ? {} : { isError: true }) };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'mapping_describe',
    {
      title: 'Read a message mapping',
      description:
        'Read a message mapping (.mmap) as text: source and target messages, Groovy function files, then one line per ' +
        'target field "target <- expression" (constants as values, standard functions by name, UDFs as File.function(), ' +
        '{ctx node} for contexts, "(same as <field>)" for shared results). Read-only.',
      inputSchema: {
        file: z.string().optional().describe('.mmap file (relative to the workspace or absolute)'),
        iflow: iflowArg.optional(),
        step: z.string().optional().describe('Message Mapping step of "iflow" (id or name), instead of "file"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const ctx = await context(server);
        const view = readMapping(readFileSync(fileArg(ctx, args, 'mapping'), 'utf8'));
        return { content: [{ type: 'text', text: mappingText(view) }], structuredContent: { ...view } };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'script_run',
    {
      title: 'Run a Groovy script on the tenant',
      description:
        'Run one Groovy script on a development tenant without deploying it, through the script runner iFlow ' +
        '(configured as "scriptRunner"). Script step 2.x (Groovy 4) is used when the script imports ' +
        'com.sap.it.script.v2.api, else 1.x (Groovy 2.4); override with groovyVersion. Returns the resulting body, ' +
        'printed output, what the script set or removed in headers and properties, and the error with its line. ' +
        'Header/property names and values cannot contain ";" or "=". Only one file: shared script code must be inlined.',
      inputSchema: {
        file: z.string().optional().describe('Groovy file (relative to the workspace or absolute)'),
        iflow: iflowArg.optional(),
        step: z.string().optional().describe('Script step of "iflow" (id or name), instead of "file"'),
        body: z.string().optional().describe('Message body the script receives'),
        bodyFile: z.string().optional().describe('File with the message body, instead of "body"'),
        headers: kv.optional(),
        properties: kv.optional(),
        function: z.string().optional().describe('Function to call instead of processData'),
        groovyVersion: z.union([z.literal(1), z.literal(2)]).optional(),
        tenant: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const ctx = await context(server);
        const tenant = selectTenant(ctx.config, args.tenant);
        if (tenant.role !== 'development') throw new Error(`tenant "${tenant.name}" is ${tenant.role}: scripts run only on development tenants`);
        if (!tenant.scriptRunner) throw new Error(`tenant "${tenant.name}" has no "scriptRunner" configured (path of the script runner iFlow)`);
        if (!tenant.runtimeKey) throw new Error(`tenant "${tenant.name}" has no "runtimeKey" (service key with plan integration-flow)`);
        const file = fileArg(ctx, args, 'script');
        const script = readFileSync(file, 'utf8');
        const body = args.bodyFile ? readFileSync(isAbsolute(args.bodyFile) ? args.bodyFile : resolve(ctx.workspace.root, args.bodyFile)) : args.body;
        const r = await runScript(new CpiClient(loadServiceKey(tenant.runtimeKey)), tenant.scriptRunner, {
          script,
          ...(body !== undefined ? { body: typeof body === 'string' ? body : new Uint8Array(body) } : {}),
          ...(args.headers ? { headers: args.headers } : {}),
          ...(args.properties ? { properties: args.properties } : {}),
          ...(args.function ? { function: args.function } : {}),
          groovyVersion: args.groovyVersion ?? groovyVersionOf(script),
        });
        const data = { script: relative(ctx.workspace.root, file), tenant: tenant.name, ...r, body: clip(r.body, ctx.config.output.maxChars) };
        return { ...toolResult(data), ...(r.ok ? {} : { isError: true }) };
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
