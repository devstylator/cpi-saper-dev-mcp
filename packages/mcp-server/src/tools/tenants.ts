import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkServiceKey, type Config } from '@cpi-saper-dev-mcp/core';
import { currentConfig } from '../project.js';
import { tokenStoreOf } from '../context.js';
import { toolError, toolResult } from '../result.js';

// Who changes are recorded under: the logged-in user, or nobody yet (never token values)
function userLogin(config: Config, t: Config['tenants'][string]) {
  const s = tokenStoreOf(config, t).read();
  if (!s) return { user: null, next: 'call cpi_login' };
  const expired = !s.refreshToken && (s.expires ?? 0) <= Date.now();
  return expired ? { user: null, next: 'login expired: call cpi_login' }
    : { user: s.email ?? s.user ?? '(unknown)', since: s.loggedInAt, ...(s.refreshToken ? {} : { until: new Date(s.expires!).toISOString() }) };
}

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
      login: t.login === 'user' ? userLogin(config, t) : 'service key (technical client)',
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
        return toolResult(describeConfig(await currentConfig(server)));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
