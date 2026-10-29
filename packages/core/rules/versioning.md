# Versioning rules (default of cpi-saper-dev-mcp)

Versions have the form MAJOR.MINOR.PATCH (for example 1.4.2). When a new version is saved, exactly one part goes up
and the parts after it start again at 0: 1.4.2 -> 1.4.3 (patch), 1.5.0 (minor), 2.0.0 (major).

The deciding question is: **who is affected by the change?** For an integration flow, "outside" means the systems
that call it (senders) and the systems it calls (receivers).

## Major (X.0.0): the change breaks a sender or a receiver

They have to change too. For example:
- the endpoint (address path) or the sender adapter changed
- authentication or the role required by the sender changed
- the request or response format is no longer compatible: a field removed or renamed, a type changed, a new
  required field
- a different target system or interface is called
- behaviour that others rely on was removed

## Minor (1.X.0): new behaviour, compatible with existing senders and receivers

For example:
- a new step, route or receiver
- new optional fields in the output
- new headers or properties for later steps or receivers
- a new externalized parameter with a default value
- error handling added
- a script moved to script step 2.x (Groovy 4)

## Patch (1.0.X): no new behaviour

Internal improvements and fixes. For example:
- a bug fix in a mapping or script
- changed settings such as timeouts, retries or logging
- renamed steps, layout changes
- fixes for findings of SAP's design guideline check

When unsure between two parts, choose the higher one and say why in the comment.

## Comment

Every version gets a comment of one line (at most about 100 characters) that says what changed, in plain words,
starting with the part: for example `minor: new step "Set trace headers" adds X-Trace and X-Ip headers`.
