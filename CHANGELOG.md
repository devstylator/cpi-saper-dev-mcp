# Changelog

All notable changes of the `cpi-saper-dev-mcp` server. Versions follow [semantic versioning](https://semver.org/);
before 1.0, names and behaviour may still change between versions.

## 0.9.0-beta.3 (2026-11-05)

### Fixed

- `add_exception_subprocess` moved its own new subprocess below the pool when the pool had to grow, without its line
  (seen as a subprocess outside the pool and a slanted arrow from Error Start); a growing pool now also moves the
  lines of the pools below it.
- A Receiver box whose line would cross an exception subprocess, with the place above the pool taken, now moves to
  the side instead of keeping the crossing line.

### Added

- `iflow_validate` warns when the diagram no longer matches the model (an element drawn outside its pool or
  subprocess, a line not at its elements) and points to `iflow_edit` `layout`.
- `cpi_send_message`: the same request answered the same way several times in a row gets a note; from the tenth
  time it is refused until the request changes (seen: an agent resent one request 33 times).
- The server's instructions and `iflow_edit` say not to edit `.iflw` XML directly.

## 0.9.0-beta.2 (2026-11-04)

### Added

- `toolLog` setting: every tool call (arguments, result, duration) as one JSON line, for debugging how agents use
  the server. Off by default.
- `cpi_push` runs SAP's model check on the uploaded version and returns its errors (`modelCheck`); `cpi_check`
  returns the issues as a list.

### Fixed

- Step and adapter must fit (measured on the tenant): `iflow_edit` `add_adapter` refuses, and `iflow_validate`
  reports, adapters that Send, Request Reply or Content Enricher do not support (for example HTTP on Send), so
  `cpi_push` stops before such a version exists.
- `add_adapter` on a Content Enricher drew the line from the step to the Receiver box; SAP's model check wants it
  from the box to the step.

## 0.9.0-beta.1 (2026-11-04)

### Added

- `iflow_edit`: local integration processes: `add_local_process`, `remove_local_process`, Process Call and Looping
  Process Call with `insert_step` `process` (and `loop` for the looping one); `layout` handles iFlows with several
  processes (one pool per process, stacked); a branching edit lays out only its own process.
- `iflow_validate`: calls pointing to no local process, a looping call without its loop, unquoted values in Camel loop
  conditions.
- `iflow_edit` `set_start`: timer start (scheduled iFlow) or back to a message start. The schedule is always
  externalized (parameter of type `custom:schedule`): run once, every n minutes or hours, or a cron schedule, with
  start, end and time zone. `params_set` and `cpi_config_set` take schedule objects; `iflow_validate` warns about a
  timer whose schedule is not externalized.

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
- iFlows with local integration processes cannot be laid out or branched by `iflow_edit` (added in 0.9.0-beta.1).
- Not offered by design: creating or deleting packages, editing message mappings, managing locks.
- Planned: `lint`, PNG rendering, user roles for sender authorization.
