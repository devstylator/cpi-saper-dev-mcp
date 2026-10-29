# cpi-saper-dev-mcp

An MCP server that lets an AI agent **develop** SAP Cloud Integration (CPI) content: edit iFlows, Groovy scripts
and XSLT as local files under git, check them locally, then push, deploy and test them on a development tenant.

> **Status: in development, not released yet.** The design has been tested on a BTP trial tenant with a
> prototype; the MCP server itself is being built in this repository.

## What it will do

- **Read** packages, iFlows and their status; pull an iFlow into a local folder.
- **Understand** an iFlow without reading BPMN XML: a compact model, a Mermaid diagram, readable message mappings.
- **Edit** iFlows safely: insert steps with correct default settings from a bundled step catalog
  ([catalog](packages/core/catalog/)), change settings, headers and properties; keep the file formatted like SAP's designer.
- **Check** locally: structure validation, XSLT 1.0–3.0 runs, readable model-level diffs (also for `git diff`).
- **Test on the tenant** (development tenants only): push, run SAP's design guideline check, deploy, send a test
  message, read the message log with the failing step by name, run a single Groovy script without deploying.

## Tools

The MCP server is not released yet. **Available** tools work in the development version (see below);
**Prototyped** means the behaviour has been built and tested against a real tenant in the prototype and is being
moved into the server; **Planned** means designed but not built yet. **v1** marks the first release.

The agent's own environment (for example Claude Code or VS Code) reads and writes the local files, so the server
adds no generic file tools.

### Tenant: read

| Tool | What it does | Status |
|---|---|---|
| `cpi_tenants` | Configured tenants and what the agent may do on each (read only, or development with writes) | **Available**, v1 |
| `cpi_packages` | List packages; a package can be named by its ID or its display name | **Available**, v1 |
| `cpi_artifacts` | List the iFlows of a package with version and runtime status | **Available**, v1 |
| `cpi_pull` | Download an iFlow into the local workspace (`<workspace>/<package>/<iflow>/`, SAP's file layout); never overwrites local changes unless asked | **Available**, v1 |
| `cpi_status` | Compare local, last pulled and tenant versions: modified, new, conflict | Planned, v1 |
| `cpi_runtime_status` | Deployment state and deploy errors, with step IDs translated to step names | Prototyped, v1 |
| `cpi_endpoints` | HTTP endpoint URLs of deployed iFlows | Planned |
| `cpi_security_material` | Names, types and expiry dates of credentials and keys (never their values) | Planned |
| `cpi_config_get` | Configured values of externalized parameters | Planned |

### Understand

| Tool | What it does | Status |
|---|---|---|
| `iflow_describe` | Compact model of an iFlow (steps, adapters, settings, routes, decoded header tables) instead of BPMN XML; steps numbered `#1`, `#2` … in flow order | **Available**, v1 |
| `iflow_render` | Mermaid diagram of an iFlow; PNG later | **Available** (Mermaid), v1 |
| `iflow_diff` | Model-level changes between two versions: steps added or removed, settings old → new, table rows, rewired flows; ignores layout and IDs the designer regenerates. Also available as a `git diff` driver | **Available**, v1 |
| `mapping_describe` | Message mapping as one line per target field, `target <- expression` (read-only) | Prototyped |
| `templates_list` | The bundled step and adapter catalog ([catalog](packages/core/catalog/)): 106 variants with default settings | **Available**, v1 |

### Edit locally

| Tool | What it does | Status |
|---|---|---|
| `iflow_edit` | Semantic edits in one atomic batch: insert a step from the catalog, remove a step, change settings, headers and properties. Keeps the file formatted like SAP's designer and lays out the diagram | Prototyped (insert step), v1 |
| `params_set` | Keep externalized parameters (`parameters.prop`/`.propdef`) consistent | Planned |

### Check

| Tool | What it does | Status |
|---|---|---|
| `iflow_validate` | Structural checks: dangling flows, missing diagram shapes, unreachable steps, missing script or mapping files, undeclared parameters | **Available**, v1 |
| `xslt_run` | Run an XSLT (1.0–3.0) locally with headers and properties as parameters, like a CPI XSLT Mapping step; errors with line numbers | Prototyped |
| `script_run` | Run one Groovy script on the tenant without deploying (script runner iFlow, development tenants only); Groovy 2.4 or 4 chosen from the script's imports; returns body, headers, properties, console output and what changed | Prototyped |
| `cpi_guidelines` | Run SAP's design guideline check on the tenant (deploys through the API skip it) | Prototyped, v1 |
| `cpi_check` | Run the tenant's model check ("Check for problems") | Prototyped, v1 |
| `lint` | Local rules for common mistakes, including those SAP's guideline check flags | Planned |

### Tenant: change (development tenants only)

| Tool | What it does | Status |
|---|---|---|
| `cpi_push` | Upload a local iFlow; refuses when the tenant changed since the last pull or the iFlow is locked in the designer | Prototyped (upload), v1 |
| `cpi_update_resource` | Update one script or mapping file without uploading the whole iFlow | Prototyped, v1 |
| `cpi_save_version` | Save the iFlow as a new version | Prototyped, v1 |
| `iflow_create` | Create an empty iFlow on the tenant and pull it | Prototyped |
| `cpi_deploy` | Deploy and wait; errors are reported with step names | Prototyped, v1 |
| `cpi_undeploy` | Remove a deployed iFlow from the runtime | Planned |
| `cpi_config_set` | Set externalized parameter values | Planned |

### Test

| Tool | What it does | Status |
|---|---|---|
| `cpi_send_message` | Call a deployed iFlow's HTTP endpoint; returns status, response and the message log ID (also for failed calls) | Prototyped, v1 |
| `cpi_messages` | Search message processing logs | Prototyped, v1 |
| `cpi_message` | One message log: status, error, and the processing steps by name | Prototyped, v1 |
| `cpi_trace` | Body, headers and properties as they entered each step of one message. Uses an undocumented SAP endpoint to switch on tracing, so it sits behind an "experimental" setting | Prototyped |

**Safety:** changes are only allowed on tenants configured as development tenants; deploying asks for confirmation;
credential values are never shown to the agent.

## Try the development version

The tools marked **Available** above work: reading packages and iFlows, pulling them, and understanding and
checking them locally. Changing the tenant follows next.

```sh
git clone https://github.com/devstylator/cpi-saper-dev-mcp.git
cd cpi-saper-dev-mcp
npm install
npm test            # builds and runs the tests
```

Create `.cpi/config.json` in your project folder ([docs/CONFIGURATION.md](docs/CONFIGURATION.md)), then connect the
server to your AI client as shown below. In all examples, replace `/path/to/cpi-saper-dev-mcp` with the folder you
cloned into.

**How the server finds your configuration:** it asks the client which project folders are open (MCP *roots*) and
uses the first one that contains `.cpi/config.json`. Clients that do not report roots get the server's working
folder instead. Without a project, it falls back to `~/.config/cpi-saper-dev-mcp/config.json`, or to the file named
in the environment variable `CPI_MCP_CONFIG`.

### Claude Code

From your project folder:

```sh
claude mcp add cpi-saper-dev-mcp -- node /path/to/cpi-saper-dev-mcp/packages/mcp-server/dist/index.js
```

### GitHub Copilot in VS Code

Add the server to your project in `.vscode/mcp.json` (create the file if it does not exist):

```json
{
  "servers": {
    "cpi-saper-dev-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/cpi-saper-dev-mcp/packages/mcp-server/dist/index.js"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

VS Code asks you to trust the server the first time it starts it. The tools are then available to Copilot's agent in
Copilot Chat. `cwd` makes the project folder the server's working folder, so it finds `.cpi/config.json` even if
roots are not reported.

VS Code also reads a workspace-root `.mcp.json` in the shared format (the same file Claude Code uses), when the
setting `chat.mcp.workspaceRootConfig.enabled` is on:

```json
{
  "mcpServers": {
    "cpi-saper-dev-mcp": {
      "command": "node",
      "args": ["/path/to/cpi-saper-dev-mcp/packages/mcp-server/dist/index.js"]
    }
  }
}
```

This format has no working-folder setting; the server then relies on the roots VS Code reports.

### GitHub Copilot CLI and other projects

For all projects at once, add the server to Copilot's user configuration `~/.copilot/mcp-config.json` (or
`$COPILOT_HOME/mcp-config.json`), with the same `mcpServers` entry as above. Keep a shared configuration in
`~/.config/cpi-saper-dev-mcp/config.json` (with absolute paths to your service keys); a project's own
`.cpi/config.json` still takes precedence when the client reports that project as a root.

## Requirements

- Node.js 22 or later.
- A Cloud Integration tenant (a BTP trial works) and two service keys of the *Process Integration Runtime*
  service: plan `api` (OData API) and plan `integration-flow` (calling deployed iFlows).
- **Optional, for running Groovy scripts on the tenant:** the script runner iFlow from
  [devstylator/CPI_Iflow_GroovyScriptExe](https://github.com/devstylator/CPI_Iflow_GroovyScriptExe) deployed on a development tenant.
  Its API is described in [docs/script-runner.openapi.yaml](docs/script-runner.openapi.yaml). The runner executes
  any code it receives, so never deploy it on test or production tenants.

## Documentation

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): tenants, roles, service keys and safety settings (planned).
- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md): where local checks differ from Cloud Integration.
- [docs/script-runner.openapi.yaml](docs/script-runner.openapi.yaml): API of the script runner iFlow.

## License

[MIT](LICENSE)
