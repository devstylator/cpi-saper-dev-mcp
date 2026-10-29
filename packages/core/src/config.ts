// Server configuration: one JSON file with general settings and a list of tenants (docs/CONFIGURATION.md).
// Relative paths are resolved from the folder of the configuration file; "~" is the home directory.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

export const CONFIRMABLE = ['create', 'push', 'save_version', 'update_resource', 'deploy', 'undeploy', 'config_set'] as const;
export type ConfirmableAction = (typeof CONFIRMABLE)[number];

const TenantSchema = z.object({
  label: z.string().optional(),
  role: z.enum(['development', 'readonly']).default('readonly'),
  apiKey: z.string().min(1),
  runtimeKey: z.string().min(1).optional(),
  deploy: z.enum(['api', 'manual']).default('api'),
  allowedPackages: z.array(z.string().min(1)).min(1).optional(),
  scriptRunner: z.string().startsWith('/').optional(),
  guidelines: z.enum(['block', 'warn', 'off']).default('warn'),
  login: z.enum(['client', 'user']).default('client'),
  loginPort: z.number().int().min(1024).max(65535).default(8765),
}).strict();

const ConfigSchema = z.object({
  defaultTenant: z.string().optional(),
  tenants: z.record(z.string().min(1), TenantSchema).refine((t) => Object.keys(t).length > 0, 'at least one tenant is required'),
  workspace: z.string().optional(),
  confirm: z.array(z.enum(CONFIRMABLE)).default(['create', 'push', 'deploy', 'undeploy']),
  experimental: z.object({ trace: z.boolean().default(false) }).strict().default({ trace: false }),
  auditLog: z.string().optional(),
  catalog: z.string().optional(),
  output: z.object({ maxChars: z.number().int().positive().default(20000) }).strict().default({ maxChars: 20000 }),
  redact: z.array(z.string().min(1)).default([]),
  timeouts: z.object({ deploySeconds: z.number().int().positive().default(180) }).strict().default({ deploySeconds: 180 }),
  versioning: z.object({ rules: z.string().optional() }).strict().default({}),
}).strict();

export interface TenantConfig {
  name: string;
  label?: string;
  role: 'development' | 'readonly';
  /** absolute path of the service key with plan "api" */
  apiKey: string;
  /** absolute path of the service key with plan "integration-flow" */
  runtimeKey?: string;
  deploy: 'api' | 'manual';
  /** undefined = all packages */
  allowedPackages?: string[];
  scriptRunner?: string;
  guidelines: 'block' | 'warn' | 'off';
  /** client: the service key's technical client (client credentials); user: the user logs in (cpi_login) */
  login: 'client' | 'user';
  /** local port of the login callback; must match the instance's redirect-uris */
  loginPort: number;
}

export interface Config {
  /** file the configuration was read from */
  path: string;
  defaultTenant?: string;
  tenants: Record<string, TenantConfig>;
  workspace: string;
  confirm: ConfirmableAction[];
  experimental: { trace: boolean };
  auditLog: string;
  /** undefined = bundled catalog */
  catalog?: string;
  output: { maxChars: number };
  redact: string[];
  timeouts: { deploySeconds: number };
  /** rules: own versioning rules file (else the bundled default) */
  versioning: { rules?: string };
}

export class ConfigError extends Error {}

export interface ConfigLocation {
  env?: NodeJS.ProcessEnv;
  /** project folder: where the server was started */
  cwd?: string;
  home?: string;
}

/** CPI_MCP_CONFIG, then <project>/.cpi/config.json, then ~/.config/cpi-saper-dev-mcp/config.json */
export function findConfig({ env = process.env, cwd = process.cwd(), home = homedir() }: ConfigLocation = {}): string {
  const candidates = [
    env.CPI_MCP_CONFIG && expandHome(env.CPI_MCP_CONFIG, home),
    join(cwd, '.cpi', 'config.json'),
    join(home, '.config', 'cpi-saper-dev-mcp', 'config.json'),
  ].filter((p): p is string => Boolean(p));
  if (env.CPI_MCP_CONFIG && !existsSync(candidates[0]!)) {
    throw new ConfigError(`CPI_MCP_CONFIG points to ${candidates[0]}, which does not exist`);
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new ConfigError(`no configuration found; looked for:\n${candidates.map((p) => `  ${p}`).join('\n')}`);
  return found;
}

const expandHome = (p: string, home: string) => (p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p);

export function loadConfig(location: ConfigLocation = {}): Config {
  const path = findConfig(location);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${path}: not valid JSON (${(e as Error).message})`);
  }
  return parseConfig(raw, path, location);
}

export function parseConfig(raw: unknown, path: string, { cwd = process.cwd(), home = homedir() }: ConfigLocation = {}): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(top level)'}: ${i.message}`);
    throw new ConfigError(`${path}: invalid configuration\n${issues.join('\n')}`);
  }
  const c = parsed.data;
  const base = dirname(path);
  const abs = (p: string) => {
    const e = expandHome(p, home);
    return isAbsolute(e) ? e : resolve(base, e);
  };

  const problems: string[] = [];
  const tenants: Record<string, TenantConfig> = {};
  for (const [name, t] of Object.entries(c.tenants)) {
    if (t.scriptRunner && t.role !== 'development') problems.push(`tenants.${name}.scriptRunner: only allowed with role "development"`);
    tenants[name] = {
      name,
      ...(t.label !== undefined && { label: t.label }),
      role: t.role,
      apiKey: abs(t.apiKey),
      ...(t.runtimeKey !== undefined && { runtimeKey: abs(t.runtimeKey) }),
      deploy: t.deploy,
      ...(t.allowedPackages !== undefined && { allowedPackages: t.allowedPackages }),
      ...(t.scriptRunner !== undefined && { scriptRunner: t.scriptRunner }),
      guidelines: t.guidelines,
      login: t.login,
      loginPort: t.loginPort,
    };
  }
  const names = Object.keys(tenants);
  const defaultTenant = c.defaultTenant ?? (names.length === 1 ? names[0] : undefined);
  if (c.defaultTenant !== undefined && !tenants[c.defaultTenant]) {
    problems.push(`defaultTenant: "${c.defaultTenant}" is not one of the tenants (${names.join(', ')})`);
  }
  if (problems.length) throw new ConfigError(`${path}: invalid configuration\n${problems.map((p) => `  ${p}`).join('\n')}`);

  return {
    path,
    ...(defaultTenant !== undefined && { defaultTenant }),
    tenants,
    workspace: c.workspace !== undefined ? abs(c.workspace) : cwd,
    confirm: c.confirm,
    experimental: c.experimental,
    auditLog: abs(c.auditLog ?? 'audit.log'),
    ...(c.catalog !== undefined && { catalog: abs(c.catalog) }),
    output: c.output,
    redact: c.redact,
    timeouts: c.timeouts,
    versioning: { ...(c.versioning.rules !== undefined ? { rules: abs(c.versioning.rules) } : {}) },
  };
}

/** The tenant a tool call means: the one named, else the default; clear error otherwise */
export function selectTenant(config: Config, name?: string): TenantConfig {
  const chosen = name ?? config.defaultTenant;
  if (chosen === undefined) {
    throw new ConfigError(`no tenant given and no defaultTenant configured; tenants: ${Object.keys(config.tenants).join(', ')}`);
  }
  const t = config.tenants[chosen];
  if (!t) throw new ConfigError(`unknown tenant "${chosen}"; tenants: ${Object.keys(config.tenants).join(', ')}`);
  return t;
}

/** Whether the agent may change this package: by Id or display name, "*" as wildcard, case-insensitive */
export function packageAllowed(tenant: TenantConfig, pkg: { id: string; name?: string }): boolean {
  if (tenant.role !== 'development') return false;
  if (!tenant.allowedPackages) return true;
  const matches = (pattern: string, value?: string) =>
    value !== undefined && new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(value);
  return tenant.allowedPackages.some((p) => matches(p, pkg.id) || matches(p, pkg.name));
}
