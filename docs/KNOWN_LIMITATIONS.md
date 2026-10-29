# Known limitations: where local tools differ from Cloud Integration

Collected during development so they can go into the final MCP documentation. Each entry says what differs,
what it means for the user, and how it was established (**measured** on the trial tenant or locally, or
**assumed**: not verified yet). Add new entries as they are found; keep the date.

## XSLT run locally (SaxonJS) — added 2026-10-28

Local runs use SaxonJS 2.7.0 (npm `saxon-js`, XSLT 3.0) inside the Node process. Cloud Integration runs XSLT
Mapping steps with Saxon for Java. Results match for standard XSLT 1.0/2.0/3.0; the cases below can differ.

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| Java extension functions (`xmlns:x="java:…"`) are not available | The stylesheet fails with `XPST0017 Unknown function` locally, but may work on the tenant | Test such mappings on the tenant | Measured locally |
| Schema-aware XSLT (`xsl:import-schema`, typed validation) is not supported by SaxonJS | Schema-aware stylesheets cannot be run locally | Test on the tenant | Assumed (SaxonJS documentation) |
| Exact Saxon edition and version on the tenant are not known | Rare differences in function behaviour or error messages are possible | Treat a local pass as a strong check, not proof | Not verified |
| Output serialisation (indentation, whitespace, attribute quoting) can differ | Byte-wise comparisons with tenant output can fail although the XML is equal | Compare parsed XML, not text | Assumed |
| Headers and exchange properties are passed as `xsl:param` by name, as strings. When a header and a property have the same name, the property wins locally | CPI's precedence for equal names, and whether it passes non-string values, are unknown | Avoid equal names | Not verified on the tenant |
| `document()` and `xsl:include`/`xsl:import` resolve relative to the stylesheet file on disk | Lookups of other iFlow resources work locally; how CPI resolves them was not checked | — | Measured locally (relative file), not verified on the tenant |
| Error line numbers are approximate. Compile errors are located exactly when the failing expression appears once in the file; runtime errors only name the enclosing element (for example the template) | The agent may have to look around the reported line | The error text quotes the expression (compile errors) | Measured locally |
| Only the principal result is returned; `xsl:result-document` outputs are dropped | Multi-output stylesheets are only partly checked | — | By design of the local runner |
| The step's options "source from header/property" and output format (`mappingoutputformat`: Bytes/String) are not emulated | Input is always the given XML text, output always text | — | By design of the local runner |
| `xsl:message` is collected and shown separately; on the tenant it goes to the system log, not to the message | — | — | Measured locally |

## Message mappings (read-only view) — added 2026-10-28

Message mappings can be read, compared and explained, but not run or edited (by design: message
mappings are supported for reading only). The mapping runtime is SAP-proprietary.

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| No local execution | A mapping's output cannot be checked locally | Deploy and send a test message | By design |
| No editing | The agent cannot change a mapping | Edit in the designer; the agent reads it back with `mmap`/`diff` | By design |
| Queue and context functions (`removeContexts`, `splitByValue`, `collapseContexts`, …) show as function names only; their effect on value queues is not explained | Mappings that depend on context handling need SAP knowledge to read | — | By design |
| Groovy function bodies (UDFs) are not part of the view; only `Lib.fn(...)` calls and the file names | The agent reads the script files separately | — | By design |
| Namespace prefixes are listed only as far as the mapping declares them; others come from the XSD files | A prefix may appear without its URI | Read the XSD | Measured (sample) |
| Target fields that are not mapped are not listed | — | Compare with the target XSD | By design |
| Multi-mappings (n:m) and mapping parameters were not in the samples | Their view is untested | — | Not verified |

## Groovy scripts run on the tenant (script runner iFlow) — added 2026-10-27/28

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| The runner executes any posted code with the runtime's permissions; there is no sandbox | Must never be deployed on test or production tenants | DEV/trial only; MCP config names the runner URL per tenant | By design |
| Header and property names and values sent in `inputHdrs`/`inputParams` cannot contain `;` or `=` | Such test values cannot be passed | Set them inside the script, or extend the runner | Measured |
| Only one script file per run; other script files of the iFlow and script collections cannot be imported | Scripts that call shared code cannot be run as they are | Inline the shared code for the test | Measured |
| The script runs inside the runner iFlow, after its own steps | Headers and properties include the runner's (`CamelHttp*`, `SAP_*`); the real step would see the iFlow's own | Use `delta` (what the script changed) rather than the full lists | Measured |
| Credential-like values (names with auth, passport, password, secret, token, cookie, credential) are returned as `<hidden>` | Scripts that set such values cannot be checked by value | — | By design |
| Error line numbers refer to the posted script; there is no file name | — | — | Measured |
| Limits: request body up to 40 MB, about 60 s per call | Large or slow tests fail | — | 40 MB measured from the iFlow; 60 s from the toolkit docs |
| Script step 1.x runs Groovy 2.4.21, step 2.x Groovy 4.0.29; a script sent to the wrong one fails to compile | Same as on the tenant (useful: catches v1/v2 mix-ups) | `groovy-version` header, chosen automatically from the imports | Measured |

## Step catalog and editing — added 2026-10-28

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| The catalog is harvested from one palette iFlow (one fresh instance of every step and adapter) on a BTP trial tenant (2026-10-28); other tenants may already offer newer component versions | New steps may be one version behind the tenant's designer | An iFlow keeps the version it already uses; maintainers re-harvest for each MCP release | By design |
| Senders AMQP, Kafka, XI, SuccessFactors and Ariba have no catalog entry yet | They cannot be added from the catalog | Clone an existing one (`--like`) | Measured (missing from the palette) |
| Inserting covers steps with one input and one output only; routers, multicasts, events and adapters cannot be inserted yet | — | Edit in the designer | Current state |
| Removing a step works for steps with one incoming and one outgoing flow and no adapter (Request Reply, Send) | — | Edit in the designer | Current state |
| After removing a step from a branched layout (several rows, joins), some edge waypoints can stay slightly shifted; the model and the result of a straight sequence are exact | Cosmetic: a line in the diagram may bend | Use the designer's auto-layout | Measured (494 insert+remove round trips on 20 iFlows: model identical in all; byte-identical for straight sequences) |
| Content Modifier rows can use the types constant, expression, xpath, header and property; other sources (global or local variable, number range) are not offered yet | — | Edit in the designer | Current state |
| `iflow_edit` does not create script or mapping files; it lists the missing ones | The agent writes the file with its own file tools | — | By design |
| Reading and writing an iFlow normalises empty values written as `<value></value>` to `<value/>`, the designer's form | A first edit of a file produced by other tools can show these lines in a text diff | Use the model-level diff | Measured |

## Comparing iFlows — added 2026-10-28

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| Elements are matched by id; a step deleted and re-added in the designer shows as removed plus added | — | — | By design |
| Layout changes are counted, not listed | Pure layout edits show only as a count | Use the designer or the diagram view | By design |
| `#n` step numbers exist only in tool output and shift when steps are inserted | A number is valid for one view of the iFlow only | Tools refer to steps by id | By design |

## Changing the tenant — added 2026-10-29

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| Confirmations need a client with MCP elicitation (e.g. Claude Code 2.1.76+, VS Code with Copilot); other clients are refused for the actions in `confirm` | Claude Desktop and older clients cannot push or deploy while confirmations are on | Remove the action from `confirm`, or use a supporting client | By design |
| A push is refused when the tenant's content changed since the pull; there is no merge | Designer edits and local edits cannot be combined automatically | Pull again with overwrite and re-apply the local changes (`iflow_diff` lists them) | By design |
| Single files are not uploaded on their own; changed scripts or mappings go up with the whole iFlow (`cpi_push`) | Every upload is a version anyway, so one upload per change keeps the history clean | — | By design |
| The deploy gate compares SAP's guideline findings with those recorded at the last deploy through this tool (the check cannot run on older versions) | With `guidelines: block`, every High finding blocks the first deploy through the tool | Fix the findings, or use `warn` | By design |
| `cpi_trace` changes the iFlow's log level through an undocumented endpoint; TRACE ends after 10 minutes by itself, and the level is not set back | Messages after those 10 minutes are logged at the previous level only if SAP restores it | — | Measured (expiry), assumed (restore) |
| Without `"login": "user"`, the tenant records the service key's client id (e.g. `sb-…\|it!b196`) as the changing user; CPI takes the user from the OAuth token and offers no "on behalf of" field | Changes cannot be traced to a person | `"login": "user"` with an authorization-code service instance | Measured |
| The grant types of a service instance cannot be changed after it is created ("Updating the grant type is not allowed") | An existing instance cannot be switched to user login | Create a new instance | Measured |
| Without the `refresh_token` grant, a user login lasts one token lifetime (`token-validity`, 12 h by default) | Log in again with `cpi_login` | Create the instance with both grant types | Measured |
| Calls to deployed iFlows (`cpi_send_message`, the script runner) still use the technical client of `runtimeKey` | Message logs show the client as sender | — | Current state |
| Every upload through the API is an entry in the version history (labelled with the uploaded manifest's `Bundle-Version`, with the upload's `Comment`); there is no unversioned draft, and "save as version" adds a second entry without a comment | Each push is a version, so related edits should be pushed together | The tool sets number and comment on every push; it does not use "save as version" | Measured |
| The version history (numbers, comments, users) cannot be read through the API; the `Comment` field can be written but reads back empty | The agent does not see comments made in the designer | The changelog next to the iFlow (`<iflow>.CHANGELOG.md`) keeps the comments written through the tool | Measured |
| The API returns only the current content of an iFlow (asking for older version numbers answers 404) | Changes since the last version are taken from the last pull or push | Pull before working | Measured |
| The tenant reports an iFlow's version from its `MANIFEST.MF` (`Bundle-Version`); uploading an older local manifest created history entries with old numbers | Fixed: every push writes the new version number into the manifest | — | Measured |
| Pushing a new iFlow (one that does not exist on the tenant) is not supported yet | — | Create it in the designer, pull, then edit | Current state |

## Tenant access — added 2026-10-27/28

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| Deploying through the API skips SAP's design guideline check, which the designer runs | Deploys can succeed that the designer would refuse | Run the guideline check before deploying (`ExecuteIntegrationDesigntimeArtifactsGuidelines`) | Measured |
| SAP's guideline check is textual (`getBody(java.io.Reader)` passes, `getBody(Reader)` is flagged) | Equivalent code can be flagged | Write the forms the check accepts | Measured |
| Step-level trace uses an undocumented internal endpoint; TRACE expires after 10 minutes | May break with SAP updates | Behind an "experimental" flag | Measured |
| On the BTP trial, API deploys often fail with "Service Manager instance not bound. Object Store credentials could not be fetched." (resource limits) | Automated deploys are unreliable on trial | Deploy in the designer, then continue | Measured |
