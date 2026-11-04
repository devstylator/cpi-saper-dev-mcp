# cpi-saper-dev-mcp

[![CI](https://github.com/devstylator/cpi-saper-dev-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/devstylator/cpi-saper-dev-mcp/actions/workflows/ci.yml)

> [!WARNING]
> **For development tenants only. Do not connect this server to a production tenant**, not even with `role:
> readonly`. It is built for developing and testing on development systems: it uploads, deploys and deletes content,
> sends test messages, runs scripts, and reads and changes runtime data (data stores, variables, number ranges,
> queues). Its safety rules protect a development tenant from mistakes, not a production system from risk.

An MCP server that lets an AI agent **develop** SAP Cloud Integration (CPI) content: edit iFlows, Groovy scripts
and XSLT as local files under git, check them locally, then push, deploy and test them on a development tenant.

> **Status: public beta (0.9.0-beta).** Everything listed as Available was tried against a BTP trial tenant, by
> the author and by AI agents in test runs. Expect rough edges and report them as
> [issues](https://github.com/devstylator/cpi-saper-dev-mcp/issues); names and behaviour may still change before
> 1.0 ([CHANGELOG](CHANGELOG.md)).

## What it does

- **Read** packages, iFlows and their status; pull an iFlow into a local folder.
- **Understand** an iFlow without reading BPMN XML: a compact model, a Mermaid diagram, readable message mappings.
- **Edit** iFlows safely: insert steps with correct default settings from a bundled step catalog
  ([catalog](packages/core/catalog/)), change settings, headers and properties; keep the file formatted like SAP's designer.
- **Check** locally: structure validation, XSLT 1.0–3.0 runs, readable model-level diffs (also for `git diff`).
- **Test on the tenant** (development tenants only): push, run SAP's design guideline check, deploy, send a test
  message, read the message log with the failing step by name, run a single Groovy script without deploying.

## Tools

**Available** tools work and were tried against a real tenant; **Planned** means designed but not built yet.

The agent's own environment (for example Claude Code or VS Code) reads and writes the local files, so the server
adds no generic file tools.

### Tenant: read

| Tool | What it does | Status |
|---|---|---|
| `cpi_login` | Log in with your own SAP account, so the tenant records **you** (not a technical client) as the one who changed or deployed content ([how to set it up](docs/CONFIGURATION.md#recording-changes-under-your-name)) | **Available** |
| `cpi_tenants` | Configured tenants and what the agent may do on each (read only, or development with writes) | **Available** |
| `cpi_packages` | List packages; a package can be named by its ID or its display name | **Available** |
| `cpi_artifacts` | List the iFlows and script collections of a package with version and runtime status | **Available** |
| `cpi_pull` | Download an iFlow into the local workspace (`<workspace>/<package>/<iflow>/`, SAP's file layout); never overwrites local changes unless asked | **Available** |
| `cpi_status` | For every pulled iFlow and script collection (or one, or a package's): in sync, modified locally, changed on the tenant, or conflict, with pulled, tenant and deployed versions; with a package also what is not pulled | **Available** |
| `cpi_runtime_status` | Deployment state and deploy errors, with step IDs translated to step names | **Available** |
| `cpi_endpoints` | HTTP endpoint URLs of deployed iFlows | **Available** |
| `cpi_security_material` | Names, types, expiry (days left) and deploy status of keystore entries, user credentials, OAuth2 clients and secure parameters; passwords, secrets, user names, secure values and certificates are never returned | **Available** |
| `cpi_config_get` | Configured values of externalized parameters, compared with the local `parameters.prop` | **Available** |

### Understand

| Tool | What it does | Status |
|---|---|---|
| `iflow_describe` | Compact model of an iFlow (steps, adapters, settings, routes, decoded header tables) instead of BPMN XML; steps numbered `#1`, `#2` … in flow order | **Available** |
| `iflow_render` | Mermaid diagram of an iFlow; PNG later | **Available** (Mermaid) |
| `iflow_diff` | Model-level changes between two versions: steps added or removed, settings old → new, table rows, rewired flows; ignores layout and IDs the designer regenerates. Also available as a [`git diff` driver](#readable-git-diff) | **Available** |
| `mapping_describe` | Message mapping as one line per target field, `target <- expression` (read-only) | **Available** |
| `templates_list` | The bundled step and adapter catalog ([catalog](packages/core/catalog/)): 106 variants with default settings | **Available** |

### Edit locally

| Tool | What it does | Status |
|---|---|---|
| `iflow_edit` | Semantic edits in one all-or-nothing batch: insert a step from the catalog (with settings, headers, properties; for XSLT and message mappings the mapping file, for a Filter its XPath, for a script step a script from a script collection), remove a step, add or remove an adapter (sender to a start event or Poll Enrich, receiver from Request Reply, Send, Content Enricher or an end event; the Sender/Receiver box is reused or created, receivers drawn below their step), add or remove an exception subprocess (steps go inside like anywhere else), add routers (conditions, default route) and parallel or sequential multicasts with a Join, put steps on their routes, edit or remove them, add or remove local integration processes and call them (Process Call, Looping Process Call with its loop), make the start a timer (run once, every n minutes or hours, or cron; start and end, time zone; always externalized so the schedule can be configured), lay out the iFlow (branches in rows, exception subprocess below, one pool per process), change settings of steps, adapters or the iFlow (unknown keys refused), rename, edit Content Modifier headers and properties. Keeps SAP's formatting, lays out the diagram, refuses edits that would break the iFlow, supports a dry run | **Available** |
| `params_set` | Declare, change or remove externalized parameters: `parameters.propdef` and `parameters.prop` kept consistent in the designer's format; shows where each `{{name}}` is used | **Available** |

### Check

| Tool | What it does | Status |
|---|---|---|
| `iflow_validate` | Structural checks: dangling flows, missing diagram shapes, unreachable steps, missing script or mapping files, undeclared parameters; settings the tenant refuses only at deploy (empty split or Filter expression, key alias or mapping file, a Content Enricher or Request Reply without adapter, sender authorization values, Receiver names with spaces) | **Available** |
| `xslt_run` | Run an XSLT (1.0–3.0) locally with headers and properties as parameters, like a CPI XSLT Mapping step; errors with line numbers | **Available** |
| `script_run` | Run one Groovy script (also from a script collection) on the tenant without deploying (script runner iFlow, development tenants only); Groovy 2.4 or 4 chosen from the script's imports; returns body, headers, properties, console output and what changed | **Available** |
| `cpi_guidelines` | Run SAP's design guideline check on the tenant (deploys through the API skip it) | **Available** |
| `cpi_check` | Run the tenant's model check ("Check for problems"); `cpi_push` also runs it after every upload | **Available** |
| `lint` | Local rules for common mistakes, including those SAP's guideline check flags | Planned |

### Tenant: change (development tenants only)

Changes ask for your confirmation, and every version needs a number and comment you confirm. For letting AI agents
test the server on their own there is an
[unattended test mode](docs/CONFIGURATION.md#unattended-test-mode-test-only): **test only, not for real
development.**

| Tool | What it does | Status |
|---|---|---|
| `cpi_push` | Upload a local iFlow as a **new version**: the agent proposes number and one-line comment by the versioning rules, you confirm both in a dialog, and Cloud Integration's version history shows exactly that entry. Refuses when the tenant changed since the pull or the iFlow is open in the designer | **Available** |
| `cpi_version_proposal` | The versioning rules (default or your own file), the local changes since the last version and a hint (major/minor/patch), so the agent can propose number and comment | **Available** |
| `cpi_save_version` | Record the tenant's current content as a new version with number and comment, for example after work in the designer | **Available** |
| `iflow_create` | Create an empty iFlow in an allowed package (as the designer does: Sender and Receiver box, Start → End, version 1.0.0) and pull it; build it with `iflow_edit`, then `cpi_push` gives it its first version | **Available** |
| `cpi_deploy` | Deploy the current version and wait; SAP's guideline check as an optional gate; errors are reported with step names, one line per problem. A failed deploy also stops the version that was running (Cloud Integration's behaviour), which the confirmation and result point out | **Available** |
| `cpi_undeploy` | Remove a deployed iFlow or script collection from the runtime | **Available** |
| `iflow_delete` | Delete an iFlow with its whole version history (for cleaning up test iFlows); refuses deployed iFlows and always asks for confirmation by default | **Available** |
| `cpi_config_set` | Configure parameter values on the tenant like "Configure" in the designer (no new version; the running iFlow uses them after the next deploy), timer schedules as a schedule object; the local `parameters.prop` follows | **Available** |

### Script collections (development tenants only)

Scripts shared by the iFlows of a package. A Groovy or JavaScript step uses one with `iflow_edit` `insert_step`
`scriptCollection` (the collection's Id, `settings.script` the file name); the iFlow's manifest requirement is written
as the designer does. `iflow_validate` checks the script against a collection pulled into the same package folder, and
`cpi_deploy` refuses while a collection the iFlow uses is missing, in another package or not deployed in its latest version.

| Tool | What it does | Status |
|---|---|---|
| `script_collection_create` | Create an empty collection in an allowed package and pull it (`<workspace>/<package>/<id>/`, scripts in `src/main/resources/script/`) | **Available** |
| `script_collection_pull` | Download a collection; never overwrites local changes unless asked | **Available** |
| `script_collection_push` | Upload it as a new version: version and comment confirmed by you (hint: a removed script is major, a new one minor); the comment goes to the changelog, since the tenant keeps none for collections | **Available** |
| `script_collection_deploy` | Deploy it (before the iFlows that use it); with `deploy: manual` you deploy it in the designer | **Available** |
| `script_collection_delete` | Delete it with its version history; refuses a deployed collection; always asks by default | **Available** |

### Runtime data

What iFlows keep on the tenant between messages. Reading works on every configured tenant; changing only on
development tenants, for data of iFlows in allowed packages (global data: any development tenant; a JMS queue: every
iFlow using it must be in an allowed package), with your confirmation (`runtime_data`).

| Tool | What it does | Status |
|---|---|---|
| `cpi_datastores` | Data stores (Write steps): all stores with their iFlow or global, entries and overdue entries; with a store, its entries | **Available** |
| `cpi_datastore_entry` | One entry's stored message: body and headers (credential-like values hidden) | **Available** |
| `cpi_datastore_delete` | Delete entries or a whole store, for example to reset test data | **Available** |
| `cpi_variables` | Variables (Write Variables): all with their iFlow or global; with a name, its value | **Available** |
| `cpi_variable_delete` | Delete a variable, for example to restart a delta load | **Available** |
| `cpi_queues` | JMS broker (capacity, queues used of the maximum, warnings) and queues with messages, size, state and the iFlows that read or write them; with a queue, its messages (failed, retries, next retry, message log) | **Available** |
| `cpi_queue_action` | Retry failed messages now, move messages to another queue, delete messages, activate or deactivate a queue | **Available** |
| `cpi_number_ranges` | Number ranges (used by number range steps): min, max, current value, field length, rotate | **Available** |
| `cpi_number_range_set` | Create, change (for example reset the current value) or delete a number range; values checked before you are asked | **Available** |
| `cpi_duplicate_checks` | What was already processed and is skipped when it comes again (idempotent repository: file names of SFTP senders, ids of Idempotent Process Call steps), with expiry | **Available** |
| `cpi_duplicate_check_delete` | Remove such entries so the same file or id is processed again in the next test | **Available** |
| `cpi_message_store` | What the Persist steps of one message stored: entries, and an entry's body and headers | **Available** |

### Test

| Tool | What it does | Status |
|---|---|---|
| `cpi_send_message` | Call a deployed iFlow's HTTP endpoint; fetches a CSRF token when the sender adapter requires one (the HTTPS sender default); returns status, response and the message log ID (also for failed calls) | **Available** |
| `cpi_messages` | Search message processing logs | **Available** |
| `cpi_message` | One message log: status, error, and the processing steps by name (at log level INFO, SAP keeps steps for failed messages only) | **Available** |
| `cpi_trace` | Body, headers and properties as they entered each step of one message. Uses an undocumented SAP endpoint to switch on tracing, so it sits behind an "experimental" setting | **Available** |

### Not offered, by design

- **Creating or deleting packages.** Packages are set up by people (with their names, vendors and access); the agent
  works inside existing packages that the configuration allows.
- **Managing locks.** Message and design-time locks are held by the runtime and the designer for running work; the
  agent does not release them. Tools only report a lock where it blocks something (for example a push to an iFlow
  open in the designer).
- **Editing message mappings.** Message mappings can be read (`mapping_describe`) but not changed: edit them in the
  designer's mapping editor.

**Safety:** changes are only allowed on tenants configured as development tenants, in allowed packages that are not
read-only content. A push stops when the iFlow is open in the designer or changed on the tenant since the pull. Create,
delete, push, deploy and undeploy ask **you** for confirmation through the MCP client (MCP *elicitation*, showing the actual
changes); clients that cannot ask are refused rather than skipping the question. Every change is written to an audit
log, and credential values are never shown to the agent. With `"login": "user"`, the tenant records your own user
for every change instead of the service key's technical client.

## Install

Requires Node.js 22 or later. The server is published on npm as
[`cpi-saper-dev-mcp`](https://www.npmjs.com/package/cpi-saper-dev-mcp): your AI client starts it with `npx`, which
downloads it on first use. During the beta the examples use `cpi-saper-dev-mcp@beta` (the newest beta); to pin one
version, write for example `cpi-saper-dev-mcp@0.9.0-beta.2`.

Create `.cpi/config.json` in your project folder ([docs/CONFIGURATION.md](docs/CONFIGURATION.md)), then connect the
server to your AI client as shown below.

**How the server finds your configuration:** it asks the client which project folders are open (MCP *roots*) and
uses the first one that contains `.cpi/config.json`. Clients that do not report roots get the server's working
folder instead. Without a project, it falls back to `~/.config/cpi-saper-dev-mcp/config.json`, or to the file named
in the environment variable `CPI_MCP_CONFIG`.

### Claude Code

From your project folder:

```sh
claude mcp add cpi-saper-dev-mcp -- npx -y cpi-saper-dev-mcp@beta
```

### GitHub Copilot in VS Code

Add the server to your project in `.vscode/mcp.json` (create the file if it does not exist):

```json
{
  "servers": {
    "cpi-saper-dev-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "cpi-saper-dev-mcp@beta"],
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
      "command": "npx",
      "args": ["-y", "cpi-saper-dev-mcp@beta"]
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

### From source

To run the latest code from this repository instead:

```sh
git clone https://github.com/devstylator/cpi-saper-dev-mcp.git
cd cpi-saper-dev-mcp
npm install
npm test            # builds and runs the tests
```

and use `node /path/to/cpi-saper-dev-mcp/packages/mcp-server/dist/index.js` as the command (in place of
`npx -y cpi-saper-dev-mcp@beta`). `npm run pack:check` builds the npm package and tries it the way users install it.

### Readable git diff

`git diff` of an `.iflw` file shows BPMN XML and diagram coordinates. With the server as git's diff driver, it shows
the model instead, one fact per line (steps with their settings, adapters, flows; message mappings as
`target <- expression`), so a change reads as "+ step … / - flow …". In your repository:

```sh
printf '*.iflw diff=cpi\n*.mmap diff=cpi\n' >> .gitattributes
git config diff.cpi.textconv "npx -y cpi-saper-dev-mcp@beta textconv"
```

`npx` looks the package up on every start, which makes diffs of many files slow: for regular use install it once
(`npm install -g cpi-saper-dev-mcp@beta`) and use `cpi-saper-dev-mcp textconv` as the textconv command.

`git diff --no-textconv` still shows the XML. It applies wherever git shows diffs (`git diff`, `git log -p`, `git show`); merges are unchanged.

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
