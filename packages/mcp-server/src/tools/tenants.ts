import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkServiceKey, loadConfig, type Config } from '@cpi-saper-dev-mcp/core';
import { toolError, toolResult } from '../result.js';

// What the agent sees about the configuration: roles, modes, key state and host. Never key values.
export function describeConfig(config: Config) {
  return {
    configFile: config.path,
    defaultTenant: config.defaultTenant ?? null,
    tenants: Object.values(config.tenants).map((t) => ({
      name: t.name,
      label: t.label ?? null,
      role: t.role,
      deploy: t.deploy,
      allowedPackages: t.allowedPackages ?? 'all',
      scriptRunner: t.scriptRunner ?? null,
      guidelines: t.guidelines,
      apiKey: checkServiceKey(t.apiKey),
      runtimeKey: t.runtimeKey ? checkServiceKey(t.runtimeKey) : { status: 'not configured' },
    })),
    workspace: config.workspace,
    confirm: config.confirm,
    experimental: config.experimental,
  };
}

export function registerTenantTools(server: McpServer) {
  server.registerTool(
    'cpi_tenants',
    {
      title: 'Configured tenants',
      description:
        'List the configured Cloud Integration tenants and what may be done on each: role (readonly or ' +
        'development), deploy mode (api or manual: the user deploys in the designer), packages the agent may ' +
        'change, script runner, guideline check, and whether the service keys are present (with the tenant host). ' +
        'Also shows which actions need the user\'s confirmation.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return toolResult(describeConfig(loadConfig()));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
