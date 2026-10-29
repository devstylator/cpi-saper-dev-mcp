# Configuration

> **Development version.** The server already reads and validates this file (`cpi_tenants` shows the result); each
> setting takes effect as the tools that use it are built. Names and defaults may still change until the first release.

The server reads one JSON file with general settings and a list of tenants. Service keys stay in their own files;
the configuration only points to them, so it never contains secrets itself.

**Paths** in the file are resolved from the folder the configuration file is in; `~` is your home folder. The file is
read again on every tool call, so changes apply without restarting the server.

## Where the file is read from

The first one found is used:

1. the path in the environment variable `CPI_MCP_CONFIG`
2. `.cpi/config.json` in the project folder (keep `.cpi/` out of git: it is next to your service keys). The project
   folder is the first folder the client reports as open (MCP roots) that has this file, else the server's working folder
3. `~/.config/cpi-saper-dev-mcp/config.json` (one configuration for all projects)

## Tenants (`tenants.<name>`)

| Parameter | What it does | Default |
|---|---|---|
| `role` | `development`: the agent may push, save versions, deploy and run scripts. `readonly`: reading only; every changing tool refuses. Use `readonly` for test and production tenants | `readonly` |
| `apiKey` | Path to the service key JSON (*Process Integration Runtime*, plan `api`): packages, pull and push, deploy, message logs | required |
| `runtimeKey` | Path to the service key JSON (plan `integration-flow`): calling deployed iFlows (`cpi_send_message`, the script runner) | optional; without it those tools are unavailable |
| `deploy` | `api`: the agent deploys and waits for the result. `manual`: the agent pushes and saves a version, then asks you to deploy in the designer and continues when you confirm (useful on BTP trial tenants, where API deploys often fail for lack of resources) | `api` |
| `allowedPackages` | Packages the agent may change, by ID or display name, `*` as wildcard (for example `["Z01*"]`). Other packages stay read-only even on a development tenant | all |
| `scriptRunner` | Path of the [script runner iFlow](https://github.com/devstylator/CPI_Iflow_GroovyScriptExe) on this tenant (for example `/v2/test/script`). Without it, `script_run` is off. Only allowed with `role: development` | off |
| `guidelines` | Before a deploy: `block` runs SAP's design guideline check and stops on new High findings; `warn` runs it and reports; `off` skips it | `warn` |
| `label` | Free text shown to the agent, for example "Personal trial" | — |

## General settings

| Parameter | What it does | Default |
|---|---|---|
| `defaultTenant` | Tenant used when a tool call names none | the only tenant, if there is one |
| `workspace` | Folder for pulled iFlows: `<workspace>/<package>/<iflow>/`, with SAP's file layout inside | the project folder |
| `confirm` | Actions that need your explicit approval in the client before they run | `["push", "deploy", "undeploy"]` |
| `experimental.trace` | Enables `cpi_trace`, which switches on tracing through an undocumented SAP endpoint | `false` |
| `auditLog` | File recording every change to a tenant: time, tenant, tool, artifact, result | `audit.log` next to the configuration file |
| `catalog` | Path to your own step catalog instead of the bundled one | bundled |
| `output.maxChars` | Longest body or payload returned to the agent before it is cut | 20000 |
| `redact` | Extra header and property names whose values are hidden, in addition to the built-in list (names containing auth, passport, password, secret, token, cookie or credential) | — |
| `timeouts.deploySeconds` | How long `cpi_deploy` waits before reporting "still deploying" | 180 |

## Example

```json
{
  "defaultTenant": "trial",
  "tenants": {
    "trial": {
      "label": "Personal BTP trial",
      "role": "development",
      "apiKey": "keys/api.json",
      "runtimeKey": "keys/runtime.json",
      "deploy": "manual",
      "allowedPackages": ["Z01*"],
      "scriptRunner": "/v2/test/script",
      "guidelines": "block"
    },
    "customer-qa": {
      "role": "readonly",
      "apiKey": "~/keys/customer-qa-api.json"
    }
  },
  "experimental": { "trace": true }
}
```

## Fixed rules (not configurable)

- Service key values are never returned to the agent and never written to logs.
- A `readonly` tenant is never changed.
- A push stops when the iFlow is locked in the designer or when the tenant's version changed since the last pull.
- The script runner cannot be used on a `readonly` tenant.

## Conventions

Team conventions such as step naming or required error handling are not server settings. Describe them in your
agent's own instructions, for example a Claude Code skill in your project.
