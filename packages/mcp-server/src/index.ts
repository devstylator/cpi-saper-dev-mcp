#!/usr/bin/env node
// cpi-saper-dev-mcp: MCP server (stdio) for developing SAP Cloud Integration content.
// stdout carries the MCP protocol; diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTenantTools } from './tools/tenants.js';
import { registerTenantReadTools } from './tools/tenant-read.js';
import { registerUnderstandTools } from './tools/understand.js';
import { registerEditCheckTools } from './tools/edit-check.js';
import { registerTenantWriteTools } from './tools/tenant-write.js';
import { registerTestTools } from './tools/test.js';
import { registerLoginTools } from './tools/login.js';
import { context } from './context.js';
import { rulesOf } from './versioning.js';

const server = new McpServer(
  { name: 'cpi-saper-dev-mcp', version: '0.1.0' },
  {
    instructions:
      'Tools for developing SAP Cloud Integration (CPI) content. Start with cpi_tenants to see which tenants are ' +
      'configured and what may be done on each (readonly or development). Typical flow: cpi_packages -> cpi_artifacts -> ' +
      'cpi_pull (or iflow_create for a new iFlow) -> iflow_describe / iflow_render -> iflow_edit (steps and adapters from ' +
      'templates_list) -> iflow_validate / iflow_diff; ' +
      'check scripts with script_run and XSLT with xslt_run -> cpi_push -> cpi_deploy -> cpi_send_message -> cpi_message. ' +
      'Tools that change a tenant may ask the user to confirm; never try to work around a refusal.',
  },
);

registerTenantTools(server);
registerTenantReadTools(server);
registerUnderstandTools(server);
registerEditCheckTools(server);
registerTenantWriteTools(server);
registerTestTools(server);
registerLoginTools(server);

// The versioning rules in force (the project's own file, or the default), for the agent and for "what are our rules?"
server.registerResource(
  'versioning-rules',
  'cpi://rules/versioning',
  { title: 'Versioning rules', description: 'When to raise the major, minor or patch part of an iFlow version, and how to write the comment', mimeType: 'text/markdown' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: rulesOf(await context(server)) }] }),
);

await server.connect(new StdioServerTransport());
console.error('cpi-saper-dev-mcp: ready (stdio)');
