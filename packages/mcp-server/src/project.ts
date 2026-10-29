import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type Config } from '@cpi-saper-dev-mcp/core';

// The project folder: clients start servers with different working folders (VS Code's workspace-root .mcp.json
// has no cwd setting), so ask the client for its roots (open workspace folders) when it supports them.
// The first root with a .cpi/config.json wins, else the first root; without roots, the working folder.
export async function projectFolder(server: McpServer): Promise<string> {
  if (server.server.getClientCapabilities()?.roots) {
    try {
      const { roots } = await server.server.listRoots();
      const folders = roots.filter((r) => r.uri.startsWith('file://')).map((r) => fileURLToPath(r.uri));
      const chosen = folders.find((f) => existsSync(join(f, '.cpi', 'config.json'))) ?? folders[0];
      if (chosen) return chosen;
    } catch (e) {
      console.error(`cpi-saper-dev-mcp: roots/list failed, using the working folder (${(e as Error).message})`);
    }
  }
  return process.cwd();
}

/** Configuration for the current project, read fresh on every call */
export async function currentConfig(server: McpServer): Promise<Config> {
  return loadConfig({ cwd: await projectFolder(server) });
}
