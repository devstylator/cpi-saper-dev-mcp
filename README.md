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
| `cpi_login` | Log in with your own SAP account, so the tenant records **you** (not a technical client) as the one who changed or deployed content ([how to set it up](docs/CONFIGURATION.md#recording-changes-under-your-name)) | **Available** |
| `cpi_tenants` | Configured tenants and what the agent may do on each (read only, or development with writes) | **Available**, v1 |
| `cpi_packages` | List packages; a package can be named by its ID or its display name | **Available**, v1 |
| `cpi_artifacts` | List the iFlows of a package with version and runtime status | **Available**, v1 |
| `cpi_pull` | Download an iFlow into the local workspace (`<workspace>/<package>/<iflow>/`, SAP's file layout); never overwrites local changes unless asked | **Available**, v1 |
| `cpi_status` | Compare local, last pulled and tenant versions: modified, new, conflict | Planned, v1 |
| `cpi_runtime_status` | Deployment state and deploy errors, with step IDs translated to step names | **Available**, v1 |
| `cpi_endpoints` | HTTP endpoint URLs of deployed iFlows | Planned |
| `cpi_security_material` | Names, types and expiry dates of credentials and keys (never their values) | Planned |
| `cpi_config_get` | Configured values of externalized parameters | Planned |

### Understand

| Tool | What it does | Status |
|---|---|---|
| `iflow_describe` | Compact model of an iFlow (steps, adapters, settings, routes, decoded header tables) instead of BPMN XML; steps numbered `#1`, `#2` … in flow order | **Available**, v1 |
| `iflow_render` | Mermaid diagram of an iFlow; PNG later | **Available** (Mermaid), v1 |
| `iflow_diff` | Model-level changes between two versions: steps added or removed, settings old → new, table rows, rewired flows; ignores layout and IDs the designer regenerates. Also available as a `git diff` driver | **Available**, v1 |
| `mapping_describe` | Message mapping as one line per target field, `target <- expression` (read-only) | **Available** |
| `templates_list` | The bundled step and adapter catalog ([catalog](packages/core/catalog/)): 106 variants with default settings | **Available**, v1 |

### Edit locally

| Tool | What it does | Status |
|---|---|---|
| `iflow_edit` | Semantic edits in one all-or-nothing batch: insert a step from the catalog (with settings, headers, properties; for XSLT and message mappings the mapping file), remove a step, add or remove an adapter (sender to a start event or Poll Enrich, receiver from Request Reply, Send, Content Enricher or an end event; the Sender/Receiver box is reused or created, receivers drawn below their step), tidy the layout of a straight flow, change settings of steps, adapters or the iFlow (unknown keys refused), rename, edit Content Modifier headers and properties. Keeps SAP's formatting, lays out the diagram, refuses edits that would break the iFlow, supports a dry run | **Available**, v1 |
| `params_set` | Keep externalized parameters (`parameters.prop`/`.propdef`) consistent | Planned |

### Check

| Tool | What it does | Status |
|---|---|---|
| `iflow_validate` | Structural checks: dangling flows, missing diagram shapes, unreachable steps, missing script or mapping files, undeclared parameters | **Available**, v1 |
| `xslt_run` | Run an XSLT (1.0–3.0) locally with headers and properties as parameters, like a CPI XSLT Mapping step; errors with line numbers | **Available** |
| `script_run` | Run one Groovy script on the tenant without deploying (script runner iFlow, development tenants only); Groovy 2.4 or 4 chosen from the script's imports; returns body, headers, properties, console output and what changed | **Available** |
| `cpi_guidelines` | Run SAP's design guideline check on the tenant (deploys through the API skip it) | **Available**, v1 |
| `cpi_check` | Run the tenant's model check ("Check for problems") | **Available**, v1 |
| `lint` | Local rules for common mistakes, including those SAP's guideline check flags | Planned |

### Tenant: change (development tenants only)

Changes ask for your confirmation, and every version needs a number and comment you confirm. For letting AI agents
test the server on their own there is an
[unattended test mode](docs/CONFIGURATION.md#unattended-test-mode-test-only): **test only, not for real
development.**

| Tool | What it does | Status |
|---|---|---|
| `cpi_push` | Upload a local iFlow as a **new version**: the agent proposes number and one-line comment by the versioning rules, you confirm both in a dialog, and Cloud Integration's version history shows exactly that entry. Refuses when the tenant changed since the pull or the iFlow is open in the designer | **Available**, v1 |
| `cpi_version_proposal` | The versioning rules (default or your own file), the local changes since the last version and a hint (major/minor/patch), so the agent can propose number and comment | **Available**, v1 |
| `cpi_save_version` | Record the tenant's current content as a new version with number and comment, for example after work in the designer | **Available**, v1 |
| `iflow_create` | Create an empty iFlow in an allowed package (as the designer does: Sender and Receiver box, Start → End, version 1.0.0) and pull it; build it with `iflow_edit`, then `cpi_push` gives it its first version | **Available**, v1 |
| `cpi_deploy` | Deploy the current version and wait; SAP's guideline check as an optional gate; errors are reported with step names | **Available**, v1 |
| `cpi_undeploy` | Remove a deployed iFlow from the runtime | **Available** |
| `cpi_config_set` | Set externalized parameter values | Planned |

### Test

| Tool | What it does | Status |
|---|---|---|
| `cpi_send_message` | Call a deployed iFlow's HTTP endpoint; fetches a CSRF token when the sender adapter requires one (the HTTPS sender default); returns status, response and the message log ID (also for failed calls) | **Available**, v1 |
| `cpi_messages` | Search message processing logs | **Available**, v1 |
| `cpi_message` | One message log: status, error, and the processing steps by name | **Available**, v1 |
| `cpi_trace` | Body, headers and properties as they entered each step of one message. Uses an undocumented SAP endpoint to switch on tracing, so it sits behind an "experimental" setting | **Available** |

**Safety:** changes are only allowed on tenants configured as development tenants, in allowed packages that are not
read-only content. A push stops when the iFlow is open in the designer or changed on the tenant since the pull. Push,
deploy and undeploy ask **you** for confirmation through the MCP client (MCP *elicitation*, showing the actual
changes); clients that cannot ask are refused rather than skipping the question. Every change is written to an audit
log, and credential values are never shown to the agent. With `"login": "user"`, the tenant records your own user
for every change instead of the service key's technical client.

## Try the development version

The tools marked **Available** above work: reading packages and iFlows, pulling them, understanding, editing and
checking them locally, running XSLT and Groovy scripts, and pushing, deploying and testing on a development tenant.

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

[Apache License 2.0](LICENSE). Created by Damian Kolasa ([devstylator](https://github.com/devstylator)).
Free to use, change and share, also commercially; copies and modified versions must keep the [NOTICE](NOTICE)
file, which credits the original creator, and mark the files they changed.
