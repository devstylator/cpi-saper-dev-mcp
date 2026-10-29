import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authorizeUrl, exchangeCode, loadServiceKey, newState, selectTenant, tokenUser, waitForCode } from '@cpi-saper-dev-mcp/core';
import { context, tokenStoreOf } from '../context.js';
import { toolError, toolResult } from '../result.js';

const WAIT_MS = 300_000;

export function registerLoginTools(server: McpServer) {
  server.registerTool(
    'cpi_login',
    {
      title: 'Log in to a tenant as the user',
      description:
        'For tenants with "login": "user": log in with the user\'s own SAP account, so the tenant records the user ' +
        '(not a technical client) as the one who changed or deployed content. Opens SAP\'s login page: through the ' +
        'client when it can open links (MCP URL elicitation), otherwise returns the link for the user to open; the ' +
        'login then completes in the background within 5 minutes. logout: true forgets the login.',
      inputSchema: { tenant: z.string().optional(), logout: z.boolean().default(false) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ tenant: tenantName, logout }) => {
      try {
        const ctx = await context(server);
        const tenant = selectTenant(ctx.config, tenantName);
        if (tenant.login !== 'user') throw new Error(`tenant "${tenant.name}" uses the service key's technical client ("login": "client"); nothing to log in`);
        const store = tokenStoreOf(ctx.config, tenant);
        if (logout) {
          store.clear();
          return toolResult({ tenant: tenant.name, loggedIn: false });
        }
        const key = loadServiceKey(tenant.apiKey);
        const state = newState();
        const url = authorizeUrl(key, tenant.loginPort, state);
        const listener = waitForCode(tenant.loginPort, state, WAIT_MS);
        const complete = async () => {
          const tokens = await exchangeCode(key, await listener.code, tenant.loginPort);
          store.write(tokens);
          return { ...tokenUser(tokens.accessToken), staysLoggedIn: tokens.refreshToken ? 'renewed automatically' : `until ${new Date(tokens.expires).toISOString()}` };
        };

        if (server.server.getClientCapabilities()?.elicitation?.url) {
          // the client shows the link (with its domain) and opens it after the user agrees
          const r = await server.server.elicitInput({
            mode: 'url', elicitationId: state, url,
            message: `Log in to Cloud Integration tenant "${tenant.name}" with your own account, so changes are recorded under your name.`,
          });
          if (r.action !== 'accept') {
            listener.cancel();
            throw new Error(r.action === 'decline' ? 'the user declined the login' : 'the login was cancelled');
          }
          return toolResult({ tenant: tenant.name, loggedIn: true, ...(await complete()) });
        }
        // no URL elicitation: hand the link over and finish in the background
        complete().catch((e: Error) => console.error(`cpi-saper-dev-mcp: login for ${tenant.name} not completed: ${e.message}`));
        return toolResult({
          tenant: tenant.name, loggedIn: false, loginUrl: url,
          next: 'Ask the user to open loginUrl in a browser on this machine and log in (within 5 minutes). ' +
            'Then call cpi_tenants to see that the login is active.',
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
