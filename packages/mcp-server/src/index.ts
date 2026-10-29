#!/usr/bin/env node
// cpi-saper-dev-mcp: MCP server (stdio) for developing SAP Cloud Integration content.
// stdout carries the MCP protocol; diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTenantTools } from './tools/tenants.js';
import { registerTenantReadTools } from './tools/tenant-read.js';
import { registerUnderstandTools } from './tools/understand.js';
import { registerEditCheckTools } from './tools/edit-check.js';

const server = new McpServer(
  { name: 'cpi-saper-dev-mcp', version: '0.1.0' },
  {
    instructions:
      'Tools for developing SAP Cloud Integration (CPI) content. Start with cpi_tenants to see which tenants are ' +
      'configured and what may be done on each (readonly or development). Typical flow: cpi_packages -> cpi_artifacts -> ' +
      'cpi_pull -> iflow_describe / iflow_render -> iflow_edit (steps from templates_list) -> iflow_validate / iflow_diff; ' +
      'check scripts with script_run and XSLT with xslt_run before pushing.',
  },
);

registerTenantTools(server);
registerTenantReadTools(server);
registerUnderstandTools(server);
registerEditCheckTools(server);

await server.connect(new StdioServerTransport());
console.error('cpi-saper-dev-mcp: ready (stdio)');
