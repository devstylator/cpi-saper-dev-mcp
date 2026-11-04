# Changelog

All notable changes of the `cpi-saper-dev-mcp` server. Versions follow [semantic versioning](https://semver.org/);
before 1.0, names and behaviour may still change between versions.

## Unreleased

- `iflow_edit`: local integration processes: `add_local_process`, `remove_local_process`, Process Call and Looping
  Process Call with `insert_step` `process` (and `loop` for the looping one); `layout` handles iFlows with several
  processes (one pool per process, stacked); a branching edit lays out only its own process.
- `iflow_validate`: calls pointing to no local process, a looping call without its loop, unquoted values in Camel loop
  conditions.

## 0.9.0-beta.0 (2026-11-02)

First public beta. **For development tenants only**: do not connect a production tenant (see the README).

### Tools (51)

- **Tenant, read:** `cpi_tenants`, `cpi_packages`, `cpi_artifacts` (iFlows and script collections), `cpi_pull`,
  `cpi_status` (local vs pulled vs tenant: in sync, modified, changed on the tenant, conflict), `cpi_runtime_status`,
  `cpi_endpoints`, `cpi_security_material` (names, types, validity; never secrets), `cpi_config_get`.
- **Understand:** `iflow_describe`, `iflow_render` (Mermaid), `iflow_diff` (also as a `git diff` driver:
  `cpi-saper-dev-mcp textconv`), `mapping_describe` (message mappings, read-only), `templates_list` (step and adapter
  catalog).
- **Edit locally:** `iflow_edit`: steps from the catalog, adapters with their Sender/Receiver boxes, exception
  subprocess, routers and parallel/sequential multicasts with Join, steps on routes, XSLT and message mapping files,
  Filter expressions, scripts from script collections, settings, headers and properties, layout of the process;
  all-or-nothing batches with a dry run. `params_set` for externalized parameters.
- **Check:** `iflow_validate` (structure, missing files, undeclared parameters, and settings the tenant refuses only at
  deploy), `xslt_run`, `script_run` (Groovy on the tenant's script runner), `cpi_guidelines`, `cpi_check`.
- **Change the tenant (development tenants, allowed packages):** `iflow_create`, `iflow_delete`, `cpi_push` (every
  upload a version, number and comment confirmed by you), `cpi_version_proposal`, `cpi_save_version`, `cpi_deploy`
  (with SAP's guideline check as an optional gate), `cpi_undeploy`, `cpi_config_set`.
- **Script collections:** `script_collection_create`, `_pull`, `_push`, `_deploy`, `_delete`.
- **Test and monitor:** `cpi_send_message`, `cpi_messages`, `cpi_message`, `cpi_trace` (experimental), `cpi_login`.
- **Runtime data:** `cpi_datastores`, `cpi_datastore_entry`, `cpi_datastore_delete`, `cpi_variables`,
  `cpi_variable_delete`, `cpi_queues`, `cpi_queue_action` (JMS), `cpi_number_ranges`, `cpi_number_range_set`,
  `cpi_duplicate_checks`, `cpi_duplicate_check_delete`, `cpi_message_store`.

### Safety

Read-only and development roles per tenant, allowed packages, confirmation of changes through your MCP client
(configurable; `unattendedTestMode` for agent test runs only), an audit log, credential values never returned.

### Known gaps

- Tried against one tenant (a BTP trial); other tenants may answer differently in places
  ([docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) lists every difference found).
- iFlows with local integration processes cannot be laid out or branched by `iflow_edit` (added in the next version).
- Not offered by design: creating or deleting packages, editing message mappings, managing locks.
- Planned: `lint`, PNG rendering, user roles for sender authorization.
