# rfapps MCP Server

## Overview

`rfapps` now includes an MCP server entrypoint that exposes the existing CLI action layer over stdio
JSON-RPC. The MCP layer is intentionally thin: it validates tool arguments, delegates to existing
rfapps actions, and returns structured envelopes without re-implementing orchestration logic.

Run it with:

```bash
rfapps mcp
```

The server supports:

- `initialize`
- `tools/list`
- `tools/call`

## Startup and Transport

The current implementation uses stdio transport only. Each request must be a single JSON-RPC message
line (`\n` delimited) and each response is emitted as a JSON-RPC line.

Minimal handshake example:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

## Tool Catalog

### Read-oriented tools

- `rfapps.status`
- `rfapps.plan`
- `rfapps.history`
- `rfapps.drift.detect`
- `rfapps.drift.show`

### Mutation tools

- `rfapps.pull`
- `rfapps.deploy`
- `rfapps.rebuild`
- `rfapps.stop`
- `rfapps.delete`
- `rfapps.prune`
- `rfapps.apply`
- `rfapps.rollback`
- `rfapps.drift.reconcile`
- `rfapps.drift.import`

### Deliberately CLI-only

Several rfapps surfaces are intentionally absent from the tool catalog. `harden`, `lint`, `audit`,
`doctor`, `backup`, `update`, top-level `reconcile`, `import`, and `state` have no MCP tool, and the
`--scan` / `--scanner` / `--scan-fail-on` flags are likewise absent from the `rfapps.plan` and
`rfapps.deploy` input schemas.

**Hierarchical tags join that list.** There is no `rfapps.tag` tool, and `tag` appears in no input
schema — not on the shared target arguments, not on the `status` target arguments, and not on any
individual tool. Tag inspection (`rfapps tag list/show/suggest`) is an authoring and review workflow
whose output is a YAML block a human pastes into a reviewed configuration file, and `--tag` widens
seven to ten tool schemas at once for no consumer that asked for it. Neither belongs on an agent-
facing surface in v1.

The exclusion is enforced by construction, not by convention. Every adapter builds its raw CLI
option object with explicit literal keys and no spread, so the TypeScript-level `tag?` field on the
shared targeting options cannot leak onto the MCP path. The rule for anyone editing an adapter is
**"never create the `tag` key"**, not "never populate it": the tool input schemas are
`additionalProperties: false` and their strict-key check iterates the object's own keys, so even
`{ tag: undefined }` fails at runtime with `Unexpected properties at $: tag` while typechecking
clean.

There is also **no configuration-level default tag filter**. `--tag` is always explicit CLI input,
so an `rfapps.plan` or `rfapps.deploy` call can never be silently narrowed by a `tags:` block —
the same hazard the `scan` configuration section is held to. Every MCP invocation therefore resolves
services exactly as it did before hierarchical tagging existed.

Since no result type gained a field, the output schemas are unchanged as well. Note that
`rfapps.status` results still carry a `tag` property per service meaning the **image tag**; it is
unrelated to the taxonomy and predates it.

See [rfapps Tag Selector](rfapps-tag-selector.md) for the CLI contract.

## Argument Conventions

Tool arguments mirror existing rfapps command options with JSON-friendly shapes:

- `services` uses `string[]` (instead of comma-delimited CLI strings)
- `noSidecars` mirrors `--no-sidecars`
- `compose`, `envFile`, `profile` mirror compose resolution flags
- drift read tools accept `reportOnly`, matching `--report-only`
- `rfapps.rollback` accepts `toGeneration` and `toTime`, matching `--to-generation` / `--to-time`
- global execution controls are supported on each tool:
  - `dryRun`
  - `debug`
  - `verbose`
  - `yes`
  - `useDotenvx`
  - `useOp`

`rfapps.drift.reconcile` retains its existing tool name. Its additional arguments mirror the new
top-level reconciliation surface:

- `autoApply`: the sole mutation authorization; omitted or `false` requests a read-only report
- `yes`: must be exactly `true` whenever `autoApply` is `true`
- `showUnchanged`: accepted for CLI option parity; the structured result still accounts for every
  selected service
- `healthTimeout`: positive integer target-verification timeout in seconds

`yes: true` without `autoApply: true` does not authorize mutation. `dryRun: true` always vetoes
mutation, including when both authorization fields are present. This relationship is enforced by
the advertised input schema, so an auto-apply request without `yes: true` fails validation before
the action runs.

## Response and Error Semantics

Successful `tools/call` responses return:

- `isError: false`
- `structuredContent: { "ok": true, "result": ... }`

Failed `tools/call` responses return:

- `isError: true`
- `structuredContent: { "ok": false, "error": ... }`

Error payloads are normalized through shared `@rfmedia/common` formatting so MCP consumers receive
the same message/suggestion semantics as CLI usage.

Schema validation failures use `MCP_VALIDATION_ERROR` with deterministic field paths.

## Drift Tool Boundaries

`rfapps.drift.detect` and `rfapps.drift.show` are read-oriented tools. They return versioned drift
results with `schemaVersion`, category arrays that may include `runtime-status`, and masked secret
environment values.

`rfapps.drift.reconcile` and `rfapps.drift.import` remain mutation tools because they can recreate
containers or edit compose files. MCP clients should present them separately from read-only
diagnostics.

The reconciliation tool is report-first despite its mutation-tool classification. An omitted or
false `autoApply` returns the same complete, deterministic `reconcile.v1` report as the top-level
CLI and does not prompt, lock, persist, or mutate. An explicitly authorized call is:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "rfapps.drift.reconcile",
    "arguments": {
      "services": ["plex"],
      "autoApply": true,
      "yes": true,
      "healthTimeout": 120
    }
  }
}
```

The successful envelope's `structuredContent.result` is the full `reconcile.v1` object, not a
generic mutation acknowledgement or a per-service event. It includes canonical scope,
`actionFingerprint`, automation decision, one ordered service result per selected service, summary,
success, and stable exit code. The output schema exposes every comparison, action, reason, terminal
outcome, and optional final-drift projection. MCP transport still returns one JSON-RPC response;
the equivalent CLI machine mode writes one result document to stdout.

Services and profiles are code-point sorted, while drift categories use `image`, `environment`,
`ports`, `volumes`, `networks`, then `runtime-status`. Public environment drift includes variable
names and change kinds only. See
[rfapps Reconcile Command](rfapps-reconcile-command.md#reconcilev1-result) for the result contract
and [JSON Output Mode](json-output.md#reconcile-command) for automation examples.

## Reuse Boundary for rfmedia (#100)

### Shared in `@rfmedia/common`

- MCP tool contracts and registry helpers
- shared schema builders and validation errors
- shared MCP error normalization utilities

### rfapps-specific

- tool catalog and naming (`rfapps.*`)
- option/result schemas derived from rfapps types
- action adapters that bridge MCP payloads to rfapps actions

This split is intentional so rfmedia can reuse shared MCP primitives while shipping its own tool
registry and adapters.

## rfmedia Adoption Note

`rfmedia-cli` now follows the same layered MCP structure:

- schema contracts + tool-name constants (`rfmedia.*`)
- adapter translation layer that invokes existing rfmedia actions
- stdio JSON-RPC transport using the same envelope semantics

rfapps remains the authoritative reference for shared MCP architecture, while rfmedia documents its
own tool catalog and command-level usage in `packages/rfmedia-cli/README.md`.
