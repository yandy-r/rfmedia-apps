# Integration Analysis: Copy Conflict Strategy Validation

## Executive Summary

Issue #302 is confined to the internal `rfmedia` configuration boundary: YAML/JSON is parsed by
`loadConfig`, `validateCopyConfig` rebuilds a typed `CopyConfigOptions`, and the missing assignment
currently discards `copy.conflictStrategy`. There are no HTTP APIs, database migrations, or remote
service changes; the repair must retain only `skip`, `overwrite`, `rename`, or `ask`, report invalid
values as `ConfigError` at `copy.conflictStrategy`, and add a compile-time `keyof
CopyConfigOptions` coverage fence.

## API Endpoints

- No REST, HTTP, or generated-client endpoint is in scope.
- The local MCP tools `rfmedia.copy.album` and `rfmedia.copy.filter` are downstream consumers, not
  network endpoints. Their input schemas already constrain an explicit tool argument to the same
  four values in `packages/rfmedia-cli/src/mcp/schema.ts`, while
  `packages/rfmedia-cli/src/mcp/adapters.ts` resolves argument, loaded
  `copy.conflictStrategy`, then the non-interactive default `skip`.
- A retained configured `ask` reaches the MCP adapter's existing non-interactive guard and is
  rejected; the validator should not duplicate or bypass that execution-context rule.

## Database

No database table, query, migration, or persisted record is involved. The tracking/completion
database can record copy outcomes, but it neither stores nor resolves `conflictStrategy`; the
strategy affects filesystem conflict handling after options are built.

## External Services

- No Plex, Lidarr, Docker, registry, or other external service call changes.
- `js-yaml` parsing, secret-template processing, and config-file search precedence remain unchanged
  in `packages/rfmedia-cli/src/lib/config.ts`; this issue starts after parsing, when the raw `copy`
  object is validated.
- Runtime effects remain local filesystem decisions in
  `packages/rfmedia-cli/src/actions/copy-album.ts`,
  `packages/rfmedia-cli/src/actions/copy-filter.ts`, and
  `packages/rfmedia-cli/src/lib/conflict-resolver.ts`. The existing action layer owns skip,
  overwrite, rename, and interactive ask semantics.

## Integration Points

- **Type source:** `packages/rfmedia-cli/src/types/config.ts` declares
  `CopyConfigOptions.conflictStrategy?: ConflictStrategy`;
  `packages/rfmedia-cli/src/types/conflict.ts` defines the four-value union.
- **Load boundary:** `packages/rfmedia-cli/src/lib/config.ts` parses the first valid YAML/JSON config,
  delegates `copy` to `validateCopyConfig`, and stores the validated result through
  `packages/rfmedia-cli/src/lib/loaded-config.ts`. Add the presence-preserving validation branch
  here so omission remains `undefined` and invalid types or strings carry the exact
  `copy.conflictStrategy` property path.
- **Drift protection:** mirror the adjacent `HandledPlexConfigOptionKey` pattern with a handled copy
  key union, `Exclude<keyof CopyConfigOptions, HandledCopyConfigOptionKey>`, and a
  conditional-`never` constant. This is compile-time coverage only; it should not change the
  repository's current behavior of dropping unknown runtime keys.
- **Tests:** extend `packages/rfmedia-cli/src/lib/config.test.ts` through public `validateConfig`.
  Cover all four accepted values, an invalid enum string, and a non-string value, asserting both
  `ConfigError` and `propertyPath === "copy.conflictStrategy"`. A YAML `loadConfig` round trip is
  useful evidence that parsing plus validation preserves the value.
- **MCP consumption:** once retained, both copy adapters already honor configured strategy with
  explicit MCP arguments taking precedence. Focused adapter coverage may prove this without
  changing schemas or adapter code.
- **CLI caveat:** `packages/rfmedia-cli/src/commands/copy.ts` currently derives strategy from the
  Commander option (default `ask`) and does not fall back to `copyConfig.conflictStrategy`.
  Therefore the stated validator fix activates the configured value for existing direct config
  consumers such as MCP, but does not by itself alter CLI option precedence. Plan generation also
  strips any non-explicit Commander strategy by design; do not accidentally freeze a config
  default into plan artifacts while repairing validation.
- **Docs/examples:** `rfmedia.example.yaml` lists the `copy` defaults but currently omits
  `conflictStrategy`. `packages/rfmedia-cli/README.md` documents the MCP restriction on `ask` but
  has no config example for this field. `docs/internal/plex-jwt-deferrals.md` and the
  `docs/plans/plex-config-validation-289/` artifacts identify #302 as the deliberately separate
  follow-up; no external documentation is required.
