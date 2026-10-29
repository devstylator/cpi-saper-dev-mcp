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
| `guidelines` | Before a deploy: `block` runs SAP's design guideline check and stops on new High findings (High findings the deployed version does not already have; everything counts as new when the iFlow is not deployed); `warn` runs it and reports; `off` skips it | `warn` |
| `login` | `client`: the agent works as the service key's technical client (client credentials); the tenant records the client id as the one who changed content. `user`: you log in with your own SAP account (`cpi_login`), and the tenant records you; needs a service instance that allows the authorization code grant (see below) | `client` |
| `loginPort` | Local port SAP's login page returns to (`http://localhost:<port>/callback`); must match the instance's `redirect-uris` | 8765 |
| `label` | Free text shown to the agent, for example "Personal trial" | — |

## General settings

| Parameter | What it does | Default |
|---|---|---|
| `defaultTenant` | Tenant used when a tool call names none | the only tenant, if there is one |
| `workspace` | Folder for pulled iFlows: `<workspace>/<package>/<iflow>/`, with SAP's file layout inside | the project folder |
| `confirm` | Actions that need your explicit approval before they run: `push`, `save_version`, `update_resource`, `deploy`, `undeploy`, `config_set`. The server asks you directly through the MCP client (elicitation), showing what will change. Clients without elicitation support are refused for these actions; remove an action from the list to allow it without a question | `["push", "deploy", "undeploy"]` |
| `experimental.trace` | Enables `cpi_trace`, which switches on tracing through an undocumented SAP endpoint | `false` |
| `auditLog` | File recording every change to a tenant: time, tenant, tool, artifact, result | `audit.log` next to the configuration file |
| `catalog` | Path to your own step catalog instead of the bundled one | bundled |
| `output.maxChars` | Longest body or payload returned to the agent before it is cut | 20000 |
| `redact` | Extra header and property names whose values are hidden, in addition to the built-in list (names containing auth, passport, password, secret, token, cookie or credential) | — |
| `timeouts.deploySeconds` | How long `cpi_deploy` waits before reporting "still deploying" | 180 |
| `versioning.saveOn` | `deploy`: a new version is saved before every deploy (number and comment confirmed by you in the same dialog); `manual`: versions only when you ask (`cpi_save_version`) | `deploy` |
| `versioning.rules` | Your own versioning rules (Markdown, like a skill): when to raise the major, minor or patch part, and how to write the comment. Replaces the [default rules](../packages/core/rules/versioning.md) completely | default |

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
      "login": "user",
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

## Recording changes under your name

With the default `"login": "client"`, Cloud Integration shows the service key's client id (for example
`sb-…!b141479|it!b196`) as the one who changed, saved or deployed content: the tenant takes the user from the OAuth
token, and a client-credentials token belongs to the technical client. To have your own user recorded:

1. In the BTP cockpit (or with `cf create-service it-rt api <name> -c params.json`), create a **new** instance of
   *Process Integration Runtime*, plan `api`, with:
   ```json
   {
     "grant-types": ["authorization_code", "refresh_token"],
     "redirect-uris": ["http://localhost:8765/**"],
     "roles": ["…the same roles as your client-credentials instance…"]
   }
   ```
   Grant types cannot be changed on an existing instance (the broker refuses the update), so create a new one.
   Plain `http` redirect addresses are accepted for `localhost` only.
2. Create a service key for it and point the tenant's `apiKey` to that file, with `"login": "user"`.
3. Call `cpi_login` (ask your agent to log you in). Your client opens SAP's login page, or the agent gives you the
   link. After that, the tenant records your user, with the rights of your own role collections.

Without `refresh_token` in the grant types, a login lasts as long as one token (the instance's `token-validity`,
12 hours by default); with it, the login is renewed automatically. The login is stored in `tokens/` next to the
configuration, readable only by you. Calling deployed iFlows (`runtimeKey`) still uses the technical client.

## Versions

A push uploads a draft; versions are saved before every deploy (`versioning.saveOn: deploy`) or when you ask. The
agent proposes the number and a one-line comment by the versioning rules (it reads them with
`cpi_version_proposal`, which also lists the changes since the last saved version and a technical hint), and you
confirm or edit both in a dialog. Write your own rules as a Markdown file and point `versioning.rules` to it, for
example:

```markdown
# Our versioning rules
- Moving a script to Groovy 4 is minor.
- Any change to a mapping is at least minor.
- Comments in English, at most 80 characters.
```

Cloud Integration's API cannot store a version comment (only the designer can), so comments go to a changelog next to
the iFlow in your workspace: `<workspace>/<package>/<iflow>.CHANGELOG.md`, newest first, with date and user.

## Fixed rules (not configurable)

- Service key values are never returned to the agent and never written to logs.
- A `readonly` tenant is never changed.
- A push stops when the iFlow is locked in the designer or when the tenant's version changed since the last pull.
- The script runner cannot be used on a `readonly` tenant.

## Conventions

Team conventions such as step naming or required error handling are not server settings. Describe them in your
agent's own instructions, for example a Claude Code skill in your project.
