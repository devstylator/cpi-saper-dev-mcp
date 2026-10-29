# cpi-saper-dev-mcp

An MCP server that lets an AI agent **develop** SAP Cloud Integration (CPI) content: edit iFlows, Groovy scripts
and XSLT as local files under git, check them locally, then push, deploy and test them on a development tenant.

> **Status: in development, not released yet.** The design has been tested on a BTP trial tenant with a
> prototype; the MCP server itself is being built in this repository.

## What it will do

- **Read** packages, iFlows and their status; pull an iFlow into a local folder.
- **Understand** an iFlow without reading BPMN XML: a compact model, a Mermaid diagram, readable message mappings.
- **Edit** iFlows safely: insert steps with correct default settings from a bundled step catalog
  ([catalog/](catalog/)), change settings, headers and properties; keep the file formatted like SAP's designer.
- **Check** locally: structure validation, XSLT 1.0–3.0 runs, readable model-level diffs (also for `git diff`).
- **Test on the tenant** (development tenants only): push, run SAP's design guideline check, deploy, send a test
  message, read the message log with the failing step by name, run a single Groovy script without deploying.

## Requirements

- Node.js 22 or later.
- A Cloud Integration tenant (a BTP trial works) and two service keys of the *Process Integration Runtime*
  service: plan `api` (OData API) and plan `integration-flow` (calling deployed iFlows).
- **Optional, for running Groovy scripts on the tenant:** the script runner iFlow from
  [devstylator/CPI_Iflow_GroovyScriptExe](https://github.com/devstylator/CPI_Iflow_GroovyScriptExe) deployed on a development tenant.
  Its API is described in [docs/script-runner.openapi.yaml](docs/script-runner.openapi.yaml). The runner executes
  any code it receives, so never deploy it on test or production tenants.

## Documentation

- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md): where local checks differ from Cloud Integration.
- [docs/script-runner.openapi.yaml](docs/script-runner.openapi.yaml): API of the script runner iFlow.

## License

[MIT](LICENSE)
