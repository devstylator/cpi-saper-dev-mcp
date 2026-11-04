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
| In Groovy 4 (script step 2.x) `XmlParser`, `XmlSlurper` and the other XML tools are in `groovy.xml.*`; `org.apache.groovy.xml.*` does not exist at runtime. SAP's guideline finding `GROOVY_MIGRATION_IMPORT_USAGE` only says to use imports compatible with Groovy 4.x (added 2026-11-02) | Following the finding literally gives "unable to resolve class" | `import groovy.xml.XmlParser`; check with `script_run` before pushing | Measured (tester report) |
| Script step 1.x runs Groovy 2.4.21, step 2.x Groovy 4.0.29; a script sent to the wrong one fails to compile | Same as on the tenant (useful: catches v1/v2 mix-ups) | `groovy-version` header, chosen automatically from the imports | Measured |

## Step catalog and editing — added 2026-10-28

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| The catalog is harvested from one palette iFlow (one fresh instance of every step and adapter) on a BTP trial tenant (2026-10-28); other tenants may already offer newer component versions | New steps may be one version behind the tenant's designer | An iFlow keeps the version it already uses; maintainers re-harvest for each MCP release | By design |
| The catalog has 31 adapter variants (the palette's); senders AMQP, Kafka, XI, SuccessFactors and Ariba and receivers such as XI, Kafka, SuccessFactors have no entry yet | `add_adapter` refuses them | Add them in the designer; once an iFlow has one, `set` can change it | Measured (missing from the palette) |
| A Groovy Script step 2.x takes its script from `script/v2/` ("Script file '…' not found" otherwise); Camel Simple route conditions compare with `=` (`==` is refused at deploy); header or property names starting with a digit are refused by SAP's model check (added 2026-11-02, tester report) | Deploys fail late | `iflow_validate` reports all three; `insert_step` refuses a 2.x script outside `v2/` | Reported by a tester; the checks run on 16 real iFlows without false findings |
| Local integration processes (added 2026-11-04): `add_local_process` writes the pool and process as the designer does (`LocalIntegrationProcess` 1.1.3, `processType` directCall, transactional handling from the calling process, plain Start/End); a Process Call names its target in `processId`; a Looping Process Call also needs a `standardLoopCharacteristics` element (condition, `loopMaximum`) that its `loopId` names, which `insert_step` `loop` writes. The loop condition is checked after each round (a condition `i < '3'` ran 3 rounds) | — | — | Measured (SAP's sample and the current designer as ground truth; deployed and run) |
| In a Camel Simple loop condition the compared value must be quoted: `${property.i} < 3` is refused by SAP's model check ("Invalid format of condition expression value"), `${property.i} < '3'` passes (added 2026-11-04) | Unquoted numbers fail late | `iflow_validate` reports it | Measured |
| Timer start (added 2026-11-04): `set_start` always externalizes the schedule (the timer's `scheduleKey` is `{{parameter}}`, the table goes to `parameters.prop`, type `custom:schedule`, as the designer's Externalize writes it). Schedules: run once; simple (every n minutes 1-59 or hours 1-23, `schedule1` `simple.repeat=…&simple.every=n`); advanced (Quartz cron fields, as the designer's dropdowns produce them); optional start and end (`from`, `until`) and time zone (IANA id, default UTC). A plain cron in `schedule1` without the table's other rows was refused by SAP's model check ("Invalid scheduler configuration") | — | — | Measured: run once, simple and advanced tables recorded from the designer and reproduced; model check; runs observed |
| The Configurations API shows and takes a schedule in a short form of its own: `simple.repeat=MINUTES --simple.every=30 --tz=NST --startAt=… --endAt=…` or `<cron fields> --tz=…`; the tenant turns it back into the full table. `cpi_config_set` `schedules` builds it from a schedule object. "Run once" has no recorded short form and cannot be configured that way | Run once is set with `set_start` and a push | — | Measured |
| A time zone's label in the table is "( UTC <standard offset> ) <name>(<id>)"; the runtime reads only the id. The labels the tool builds match the tenant's (Europe/Warsaw checked) | — | — | Measured |
| An exception subprocess that ends with End (`end: "message"`) answers the sender with its reply (HTTP 200) and the message log shows COMPLETED; with Error End the message fails (added 2026-11-02) | A handled error is not visible as failed in monitoring | Use Error End when failures must show, or set a custom status | Measured |
| The allowed headers of an iFlow (`allowedHeaderList`) are separated by `\|`; with commas no header reaches the flow and nothing reports it (added 2026-11-02) | Headers a test sends are silently dropped | `iflow_validate` warns about commas | Measured |
| Branches (added 2026-11-02): `add_router` (routes with XPath or Camel Simple conditions, exactly one default route without a condition; routes rejoin the next step or end in their own End event), `add_multicast` (parallel or sequential, branches meet in a Join by default; put a Gather after it to combine the messages), steps on a route with `insert_step` `route`, `set_route` (name, condition, default; making a route the default gives the old default its condition), `remove_gateway` (once the routes have no steps; takes the Join and the routes' own End events along). Other events (timer start, error and escalation end) cannot be inserted yet. An exception subprocess is added with its own operation (`add_exception_subprocess`, added 2026-11-02): Error Start → Error End, or Error Start → End with `end: "message"`; steps go inside with `insert_step` after its Error Start | Branched flows cannot be built yet | Add branches in the designer | Current state |
| `add_exception_subprocess` draws the subprocess below the main row, 400 wide, as the designer does; the pool grows to hold it and boxes below the pool move down. Inserting a step in one row (main flow or subprocess) moves only that row. `remove_exception_subprocess` does not shrink the pool again (added 2026-11-02) | Cosmetic: an empty band can stay after a removal | `layout` | Current state |
| `iflow_validate` checks a few settings that Cloud Integration refuses only when it builds the runtime at deploy: empty split expression, Filter expression, private key alias, mapping or script file; Content Enricher, Request Reply, Send and Poll Enrich without adapter; sender `senderAuthType` other than `RoleBased`/`ClientCertificate`, and `ClientCertificate` without certificates; Receiver box names with whitespace (Sender: warning); HTTP receiver `authenticationMethod` written in another case than the designer's (`none` for `None`). Errors are refusals seen on the trial tenant (General Splitter, Filter, Simple Signer, mappings, Content Enricher, HTTPS sender, Receiver name, HTTP receiver authentication), warnings are assumed. Other deploy checks are not covered, for example whether a step accepts the message type of the step before it (Message Digest after XML to JSON is refused) (added 2026-10-30) | A local pass does not guarantee the deploy works | Deploy on the development tenant; the deploy reports the failing step by name | Measured (tester reports); no false findings on 12 real iFlows |
| A Filter keeps its XPath in the setting `wrapContent` (the same key holds the body in a Content Modifier); `xpathType` is only the value type (Boolean, Integer, Node, Nodelist, String). An XPath in `xpathType` is refused at deploy ("Invalid value … in 'Value Type'"), an empty `wrapContent` too ("Xpath not defined"). With `Nodelist`, the result can have several root elements, which later XML steps (XSLT, XML parsers) refuse with "Illegal to have multiple roots" (added 2026-11-02) | Filters built from raw settings fail at deploy or at runtime | Use `expression` on `insert_step` or `set`; wrap a node list before XML steps, or filter to one node | Measured (tester report; SAP's own sample uses `wrapContent`); value type list from SAP's documentation |
| A mapping step needs three settings pointing to its file: `mappinguri` (`dir://mapping/xslt/…/x.xsl`, message mappings `dir://mmap/…/x.mmap`), `mappingpath` (without extension) and `mappingname`. With only `mappingpath`, the deploy succeeds and every message fails (`mappingClass is null`); local validation cannot see this (added 2026-10-30) | Mapping steps built from raw settings break at runtime | Use `mapping` on `insert_step` or `set`, which writes all three | Measured: XSLT and message mapping (SAP's mapping sample: step settings identical, deployed and run, 2026-11-02) |
| `add_adapter` places a start event's sender left of the pool and every other Sender/Receiver box below the pool under its step (above when a box is in the way or its line would cross a shape in the pool, such as an exception subprocess; the diagram then moves down so it starts at the top again); boxes below follow their step when steps are inserted or removed; lines are straight, centre to centre | Cosmetic: with many adapters the boxes can crowd | `layout` or the designer | Current state |
| `layout` arranges every process in its own pool, left to right inside: each element in the column of its longest path from the start, so a Join comes after all its branches; the first route of a router or multicast stays on its row, the others get rows below (rows are shared where branches do not overlap); lines into and out of branches bend at right angles, a route that skips elements on its row goes over their top; an exception subprocess (straight inside) below. The first integration process stays where it is, every other pool is stacked below it (and below the Sender/Receiver boxes under it). A branching edit lays out only its own process and moves what is below down when its pool grew, so a designer's arrangement of the other pools stays. A process with several start events is refused (updated 2026-11-04) | `layout` replaces a designer's two-dimensional arrangement of pools with a stack | The designer's auto-layout | Checked on every iFlow at hand, incl. SAP's sample with 8 processes: model unchanged, no overlapping shapes |
| A step inserted where the next element is far enough away on the same row goes into that room and nothing moves; otherwise everything to its right moves to open a gap | Removing such a step later closes the gap, so the layout can end up tighter than before | — | By design |
| Removing a step works for steps with one incoming and one outgoing flow; an adapter on it must be removed first (`remove_adapter`, which keeps the Sender/Receiver box, as the designer does) | — | — | Current state |
| After removing a step from a branched layout (several rows, joins), some edge waypoints can stay slightly shifted; the model and the result of a straight sequence are exact | Cosmetic: a line in the diagram may bend | Use the designer's auto-layout | Measured (494 insert+remove round trips on 20 iFlows: model identical in all; byte-identical for straight sequences) |
| Content Modifier rows can use the types constant, expression, xpath, header and property; other sources (global or local variable, number range) are not offered yet | — | Edit in the designer | Current state |
| `iflow_edit` does not create script or mapping files; it lists the missing ones | The agent writes the file with its own file tools | — | By design |
| Reading and writing an iFlow normalises empty values written as `<value></value>` to `<value/>`, the designer's form | A first edit of a file produced by other tools can show these lines in a text diff | Use the model-level diff | Measured |

## Externalized parameters — added 2026-11-02

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| Configuring a value on the tenant (`cpi_config_set`, or "Configure" in the designer) writes the iFlow's design-time `parameters.prop` without a new version | A pulled copy would look outdated and the next push would be refused | `cpi_config_set` updates the local `parameters.prop` and the pulled state; values configured in the designer need a pull | Measured |
| A `cpi_push` uploads the local `parameters.prop`, so it replaces values configured on the tenant since the pull | — | Pull before editing, or configure again after the push | By design |
| The current designer also writes `<param_references>` in `parameters.propdef` (which setting uses a parameter); `params_set` does not write them, but keeps the existing ones (and removes those of a removed parameter) | The designer may not show where a new parameter is used; the tenant configures and runs it | — | Measured (tenant lists and runs a parameter declared without references) |
| A parameter can be used by a message mapping instead of a setting; such parameters have no `{{name}}` in the iFlow | `params_set` lists them as not used in the iFlow, without warning | — | By design |

## Status, endpoints, security material — added 2026-11-02

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| `cpi_status` ignores `META-INF/MANIFEST.MF` on the local side: a push writes the version into it and the tenant (or the designer) rewrites it | A manifest edited by hand does not show as a local change | — | By design (as `cpi_push`) |
| `cpi_status` downloads every artifact it checks | Slow for many pulled artifacts | Pass `iflow` or `package` | By design |
| `cpi_endpoints` lists what the tenant reports as service endpoints (`ServiceEndpoints`): HTTP endpoints of deployed iFlows | Endpoints of other adapters (for example SFTP polling) are probably not listed | — | Measured for HTTPS senders; other adapters assumed |
| A newly deployed iFlow appears in the tenant's endpoint list only after a while (more than a few seconds) | Right after a deploy `cpi_endpoints` would find nothing | For one running iFlow it builds the URL from the HTTPS sender's path (`source: "sender adapter"`) | Measured (2026-11-02, tester report reproduced) |
| `cpi_security_material` copies listed fields only (names, types, validity, deploy status) | User names, client ids and certificate content are not shown either | Look them up in the tenant's monitor | By design |

## Runtime data — added 2026-11-02

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| A data store or variable appears on the tenant once an iFlow wrote to it; global ones have no iFlow (`IntegrationFlow` empty) | `cpi_datastores` and `cpi_variables` show only what was written | — | Measured |
| A data store entry's content comes as a zip with `body` and `headers.prop`; a variable's as a zip with `headers.prop`, the value under the variable's name next to the message ids of the run that wrote it | The tools return body, headers and value | — | Measured |
| Variables cannot be written through the API (create and update answered 403) | A variable can be read and deleted, not set | Explore later: a generated helper iFlow with Write Variables for global ones | Measured (403; missing role not ruled out) |
| JMS: the lists `Queues`, `MessagingQueues` (+ messages, + the iFlows using a queue) and the broker answer; `JmsQueues` and `JmsMessages` answer 501 on a trial. A queue names its iFlows by display name; the tools match them to Ids through the deployed artifacts and refuse changes when that fails | — | — | Measured |
| JMS retry and move take a JSON body (`queueName` / `sourceQueue` + `targetQueue`, and `jmsMessageIds`, `jmsMessageId`, `mplId` or `createdBefore`), found through the tenant's field checks; they apply to failed messages, and a retried message gets a new JMS id | Ids from an earlier listing go stale after a retry | List the queue again (`cpi_queues`) | Measured (retry by id, activate/deactivate, delete); move checked against a missing queue only (one queue on the trial) |
| Deleting a JMS message through `JmsMessages(...)` answers 204 for any id, also one that does not exist | The tools delete through `MessagingMessages(...)`, which checks the id | — | Measured |
| Number ranges are global (no iFlow, no package): changing them needs a development tenant only. The API takes all values as text and `Rotate` as `true`/`false` (anything else: HTTP 500) | — | — | Measured |
| Persisted messages (Persist step) are found per message log; an entry's content is the plain body, its headers are the entry's properties | `cpi_message_store` needs the message log id | `cpi_messages` finds it | Measured |
| Duplicate-check entries (idempotent repository) are created by SFTP/FTP senders marking files as processed and by Idempotent Process Call steps; the catalog has no Idempotent Process Call step yet | `cpi_duplicate_checks` and `cpi_duplicate_check_delete` were run on a tenant without entries: listing and refusals checked, reading and deleting real entries not yet | Create test entries with an Idempotent Process Call step in the designer | Partly measured |
| The Write Variables step keeps its variables as table rows without cell names: name, data type, value type, value, `local`/`global` | `iflow_edit` can write them as raw `variable` setting | — | Measured (SAP sample, deployed and run) |

## Script collections — added 2026-11-02

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| A script step uses a collection's script with two settings, `scriptBundleId` (the collection's Id) and `script` (the file name); the iFlow's manifest gets `Require-Capability: scriptcollection.<Id>;resolution:=optional;bundleType:String="ScriptCollection";source:String="reference"`, which the collection matches with `Provide-Capability` | `iflow_edit` writes both like the designer | — | Measured (a reference made in the designer, then run) |
| The tenant labels a collection upload with the manifest's `Bundle-Version`, and the version is repeated in `Provide-Capability`; the tenant wraps the manifest lines itself | `script_collection_push` sets both | — | Measured |
| The collection entity has no comment field | Version comments of collections exist only in the changelog next to the folder | — | Measured (API metadata) |
| An iFlow uses the deployed version of a collection: scripts added since then are missing at runtime; `resolution:=optional` lets the iFlow deploy without the collection | `cpi_deploy` checks that each collection exists in the iFlow's package, has the scripts and runs its latest version | Deploy the collection first | Collection checks measured; runtime failure without the collection assumed |
| `script_run` runs a collection's script like any other: by its file, or by the iFlow step that uses it (the collection pulled into the same package folder). As for every script, only that one file is sent, so a script that uses code from another script file cannot run as it is | — | Inline the other file's code for the test | Measured |

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
| A failed deploy stops the version that was running before: Cloud Integration removes it before it builds the new one (added 2026-10-30) | A broken push followed by a deploy takes the running iFlow down | `cpi_deploy` says so in the confirmation and in the result (`previouslyRunning`); deploy the previous version again if needed | Measured (tester report) |
| Settings the tenant needs only at deploy (see `iflow_validate` above) block neither `iflow_edit` nor `cpi_push`: the tenant accepts such uploads, and a flow may be finished in the designer (added 2026-10-30) | A push can succeed although the deploy will fail | Both tools list these findings (`beforeDeploy`, `deployWillFail`) | By design |
| `iflow_create` creates the iFlow on the tenant and then pulls it; it refuses beforehand when the local folder already exists, since a refused pull would leave the new iFlow behind (added 2026-11-02) | If the pull still fails (network), the iFlow exists on the tenant without a local copy | The error says so: `cpi_pull` it, or `iflow_delete` it | Measured (tester report: a refused pull left a 1.0.0 scaffold; after the fix, refused with nothing created) |
| `iflow_delete` deletes the design-time artifact with its whole version history; deployed iFlows are refused first (added 2026-10-30) | Cannot be undone | Confirmation is in the default `confirm` list | Measured (delete, decline, deployed and package refusals) |
| The tenant reports an iFlow's version from its `MANIFEST.MF` (`Bundle-Version`); uploading an older local manifest created history entries with old numbers | Fixed: every push writes the new version number into the manifest | — | Measured |
| Pushing a new iFlow (one that does not exist on the tenant) is not supported yet | — | Create it in the designer, pull, then edit | Current state |

## Tenant access — added 2026-10-27/28

| Difference | Impact | Workaround | Basis |
|---|---|---|---|
| Deploying through the API skips SAP's design guideline check, which the designer runs | Deploys can succeed that the designer would refuse | Run the guideline check before deploying (`ExecuteIntegrationDesigntimeArtifactsGuidelines`) | Measured |
| SAP's guideline check is textual (`getBody(java.io.Reader)` passes, `getBody(Reader)` is flagged) | Equivalent code can be flagged | Write the forms the check accepts | Measured |
| Step-level trace uses an undocumented internal endpoint; TRACE expires after 10 minutes | May break with SAP updates | Behind an "experimental" flag | Measured |
| At message log level INFO, Cloud Integration keeps the processing steps of failed messages only; completed messages have a run with no steps (added 2026-10-30) | `cpi_message` shows `steps: []` for successful messages, with a note | Set the log level to Debug or Trace (`cpi_trace` sets Trace for 10 minutes) | Measured (12 iFlows: INFO completed 0 steps, failed 3–6; TRACE completed 4–14) |
| An iFlow calling another iFlow's HTTPS endpoint on the same tenant gets 401: the endpoint needs the role `ESBMessaging.send`, and a deployed iFlow has no credentials of its own (added 2026-11-02) | iFlow-to-iFlow calls over HTTP fail until credentials are set up | Use ProcessDirect between iFlows on one tenant, or a credential deployed on the tenant (security material) referenced by the adapter. Never copy service key values into an iFlow: they would be stored in its content | Measured (tester report) |
| On the BTP trial, API deploys often fail with "Service Manager instance not bound. Object Store credentials could not be fetched." (resource limits) | Automated deploys are unreliable on trial | Deploy in the designer, then continue | Measured (on 2026-11-02 an API deploy on the same trial took 8 s without errors: it varies) |
