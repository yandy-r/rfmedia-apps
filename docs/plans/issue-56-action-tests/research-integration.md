# Integration Research: Issue 56 Action Tests

## Integration Summary

Issue 56 strengthens four existing local action boundaries: album verification, filter
verification, incremental sync, and legacy tracking/history migration. It adds no HTTP route,
remote API, database table, schema migration, configuration key, CLI option, MCP schema, or
dependency. The production fixes should stay behind the current exported actions and reuse the
existing filesystem, inventory, history, tracking, database, signal, and media-server adapters.

The central integration rule is ownership: `migrate-tracking.ts` should orchestrate, while
`completed-tracker.ts` and `history.ts` parse and persist their own legacy formats; `sync.ts` should
carry diff classification into its existing per-file writer; the verify actions should continue to
delegate integrity decisions and staged replacement to shared libraries. Tests then target each
owner at the narrowest boundary that can prove the contract.

## Relevant Files

- `packages/rfmedia-cli/src/cli.ts`: registers `migrateCommand`, `syncCommand`, and `verifyCommand`
  and loads the process-wide validated configuration before actions run.
- `packages/rfmedia-cli/src/commands/migrate.ts`: Commander surface and machine-output projection
  for `migrate-tracking`/`migrate`.
- `packages/rfmedia-cli/src/commands/sync.ts`: Commander validation and `SyncOptions` construction.
- `packages/rfmedia-cli/src/commands/verify.ts`: Commander mode/tier selection and dispatch to album
  or filter actions.
- `packages/rfmedia-cli/src/mcp/adapters.ts`: `invokeSync()` MCP-to-action adapter; verify and
  migrate-tracking have no MCP tool.
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts`: discovery, migration orchestration,
  cleanup confirmation, summary, and `MigrateResult` owner.
- `packages/rfmedia-cli/src/actions/sync.ts`: diff execution, file materialization, inventory
  persistence, downgrade cleanup, resource lifecycle, and optional media scan.
- `packages/rfmedia-cli/src/actions/verify-album.ts`: ranged album expected-set verification and
  staged repair.
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: rating/metadata selection, filter layout,
  evidence loading, and staged repair.
- `packages/rfmedia-cli/src/lib/completed-tracker.ts`: authoritative legacy tracking parser and
  database recording semantics.
- `packages/rfmedia-cli/src/lib/history.ts`: authoritative legacy history JSONL parser and database
  migration semantics.
- `packages/rfmedia-cli/src/lib/inventory.ts`: dual SQLite/JSONL inventory router and sync diff.
- `packages/rfmedia-cli/src/lib/db.ts` and `packages/rfmedia-cli/src/lib/schema.sql`: database
  lifecycle, statements, relationships, and schema version.
- `packages/rfmedia-cli/src/lib/filesystem.ts`: copy/link/remove/trash, partial cleanup, stable file
  access, and validated staged replacement.
- `packages/rfmedia-cli/src/lib/tiered-verification.ts`: verification outcome and fingerprint
  resolution owner.
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`: optional media-server scan resolver.
- `packages/rfmedia-cli/src/lib/signal-handler.ts`: process-wide cancellation/cleanup registry.
- `packages/rfmedia-cli/src/types/inventory.ts`, `packages/rfmedia-cli/src/types/options.ts`, and
  `packages/rfmedia-cli/src/types/results.ts`: public internal option/result contracts.

## API and Command Surfaces

### HTTP and Remote APIs

There is no HTTP API for issue 56. Verify and migration are local-only. Sync may request a Plex
library scan through the existing `MediaServerAdapter`; it must not call `fetch` or Plex code
directly.

### Commander CLI

| Command                                      | Action boundary                                                                                | Relevant inputs                                                                                                    | Result/exit contract                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `rfmedia migrate-tracking` (alias `migrate`) | `executeMigrate(options)` in `packages/rfmedia-cli/src/actions/migrate-tracking.ts`            | `--delete-old`, `--force`, `--tracking-only`, `--history-only`, `--history-path`; global dry-run/output projection | `MigrateResult`; machine envelope is built in `commands/migrate.ts`; non-empty `errors` sets exit code 1 |
| `rfmedia sync [destination]`                 | `executeSyncWithFileInput(destination, options)` in `packages/rfmedia-cli/src/actions/sync.ts` | `--file` or `--paths`; album/filter mode; copy/link/convert; reset/delete downgrade; Plex; tracking backend        | `SyncResult`; `failedFiles > 0` sets exit code 1                                                         |
| `rfmedia verify <paths...>`                  | `executeAlbumVerifyWithFileInput()` or `executeFilterVerifyWithFileInput()`                    | source arguments or `--file`; album/filter mode; quick/default/deep tier; fix/conflict/trash options               | `VerifyCommandResult`; unresolved verification problems set exit code 1                                  |

`commands/migrate.ts` already rejects simultaneous `trackingOnly` and `historyOnly`. Command
parsing/output tests belong at this layer; issue 56 action tests should call the exported action
boundaries directly.

### MCP and Internal APIs

- `packages/rfmedia-cli/src/mcp/adapters.ts::invokeSync()` constructs the same `SyncOptions` and
  calls `executeSyncWithFileInput()`. Any sync fix therefore applies to both CLI and MCP callers.
- There is no verify or migrate-tracking adapter/schema entry under `packages/rfmedia-cli/src/mcp/`.
  Do not add one for test coverage.
- `executeAlbumVerify()`/`executeFilterVerify()` are useful single-source internal entry points;
  the `WithFileInput` variants own aggregation, signal hookup, and multi-source continuation.
- `InventoryContext` routes the same `loadInventory`, `appendFileRecord`, and reset APIs to SQLite
  when `db` plus `operationId` exist, otherwise to the legacy JSONL file.

## Database Schema and Relationships

No schema change is required. `packages/rfmedia-cli/src/lib/schema.sql` declares schema version 11.
The relevant relationships are:

```text
operations
  |--< completed_sources       UNIQUE(operation_id, source_path)
  |--< failed_sources          UNIQUE(operation_id, source_path)
  |--< inventory               UNIQUE(operation_id, source_path, relative_path)
  `--< completed_album_copies  UNIQUE(operation_id, source_path, album_name,
                                      suffix, rating_key)

history_sessions              UNIQUE(session_id)
  `--< history_operations
```

All child foreign keys use `ON DELETE CASCADE`; `initializeDatabase()` enables foreign keys. The
tables important to issue 56 are:

| Table                | Exact integration contract                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations`         | Parent identity and status for copy/sync/manual tracking import. Migration identity must preserve both `input_file` and `options_hash`; `mode`, rating/range/conversion keys, counts, and terminal status must remain truthful.                                 |
| `completed_sources`  | One normalized completed path per operation. Legacy completed lines map here through `recordCompleted()`.                                                                                                                                                       |
| `failed_sources`     | One normalized failed path/error per operation. Legacy failed lines map here through `recordFailed()`.                                                                                                                                                          |
| `inventory`          | Sync file metadata, absolute `dest_path`, optional SHA-256 `content_hash`, and copied timestamp. `recordInventoryFile()` validates new digest format; sync loads rows through `lib/inventory.ts`. Verify joins inventory to operations to obtain `convert_key`. |
| `history_sessions`   | Legacy JSONL header projection keyed by string `session_id`; stores version, command, timestamps, status, cwd, and operation count.                                                                                                                             |
| `history_operations` | Ordered filesystem operations linked to `history_sessions.id`; stores operation type, source/destination, created-directory flag, and conversion format.                                                                                                        |

`initializeDatabase()` in `packages/rfmedia-cli/src/lib/db.ts` performs a read-only compatibility
preflight, opens `better-sqlite3`, sets WAL, `synchronous=NORMAL`, a 5000 ms busy timeout, enables
foreign keys, executes the schema, and runs migrations. A failed initialization closes internally.
Callers own every successfully returned connection.

### Safe Persistence Seams

- Make the legacy importer in `packages/rfmedia-cli/src/lib/completed-tracker.ts` reusable/exported
  rather than duplicating parsing or SQL in `migrate-tracking.ts`. It should accept exact operation
  identity and sidecar paths and return per-file durable proof, not only counts.
- Extend `packages/rfmedia-cli/src/lib/history.ts::migrateLegacyHistory()` with an optional resolved
  history directory. Preserve `getHistoryDir()` as the default for existing automatic callers.
- Use one transaction per tracking operation/session where equivalence is all-or-nothing. Read back
  `completed_sources`, `failed_sources`, `history_sessions`, and `history_operations` before a
  source file becomes cleanup-eligible.
- Keep proof details internal if possible; `MigrateResult` in `types/results.ts` can retain its
  current external counters, `legacyFiles`, deletion count, and failures.

## Filesystem Integrations

### Verification

- Sources come from CLI `PathEntry[]` or `lib/input-file.ts::readSourcePaths()`.
- Album mode enumerates source album directories and expands configured suffix ranges. Filter mode
  uses `findAudioFiles()`, rating/metadata readers, and deterministic destination allocation.
- Quick verification avoids SQLite. Default/deep use read-only inventory fingerprints from
  `openDatabaseReadOnly()` and `getInventoryFingerprintCandidates()`.
- Missing/mismatch repair delegates to `replaceFileWithValidatedStage()` or
  `convertFileWithValidation()`, then re-runs `verifyFileByTier()`. Tests should assert this seam;
  shared filesystem tests own atomic/no-follow implementation details.
- Extra-file policy delegates to `remove()` or `moveToTrash()`. Dry-run and skip/keep must not call
  either boundary.

### Sync

- `lib/inventory.ts` resolves legacy inventory beside the input file as
  `{inputBasename}.inventory.{optionsHash}.jsonl`; database mode routes rows through `inventory`.
- The per-file ordering in `actions/sync.ts` is destination materialization, SHA-256 calculation,
  inventory entry creation, then append. Issue 56 must preserve that ordering.
- Carry explicit `new` versus `updated` intent from `syncFilterSource()`/`syncAlbumSource()` into
  `syncFile()`. Only an updated item may replace an existing represented destination without
  turning global `force` on for new collisions.
- Downgrade cleanup consumes `DowngradedFileInfo.destPath` from inventory. Validate/derive its
  containment under the requested destination before `remove()`.
- Signal cleanup tracks in-progress destinations and delegates partial cleanup to
  `cleanupPartialFile()`.

### Migration

- Tracking discovery currently uses `fast-glob` below `process.cwd()` for
  `*.completed.*.txt`/`*.failed.*.txt`. Group identity must include `inputFile` plus `hash`.
- History discovery reads `*.jsonl` from `options.historyPath ?? getHistoryDir()`. The exact same
  resolved directory must be passed to import and cleanup.
- Cleanup uses non-recursive `unlink()` and prompt confirmation. `force` may bypass only the
  prompt; deletion candidates must come from per-file persistence proof.

## Media-Server Scan Integration

Only sync integrates with a remote service. `resolveOptionalScanAdapter()` merges command overrides
with loaded Plex configuration and may return no adapter. When the adapter advertises
`capabilities.scan`, a non-dry run calls `adapter.scan.triggerSource(destination)` only after at
least one new or updated file is counted. Scan failure is logged as a warning and does not rewrite
the sync result. Dry-run prints intent but performs no scan; unchanged, deletion-only, and
failed-only runs perform no scan.

Tests should mock `resolveOptionalScanAdapter()` at the action-helper boundary and prove one scan
for a successful material change, zero scans otherwise, and best-effort handling of an unsuccessful
scan result.

## Configuration

- Configuration is loaded once through `packages/rfmedia-cli/src/cli.ts` and exposed by
  `packages/rfmedia-cli/src/lib/loaded-config.ts`.
- Migration database resolution is `undo.database`, then `tracking.database`, then
  `getDefaultDatabasePath()` (`~/.config/rfmedia/tracking.db`, falling back to the existing
  `~/.rfmedia/tracking.db`).
- Migration history resolution is CLI `--history-path`, then `undo.historyPath`, then
  `~/.rfmedia/history`.
- Sync backend selection is CLI `useLegacyTracking`, then `tracking.useLegacy`, then database mode.
  Its database path is CLI `trackingDatabase`, then `tracking.database`, then the database default.
- Verify default/deep accepts `--tracking-database`; otherwise it uses
  `resolveUndoDatabasePath()`. Quick tier must not open a database.
- Sync Plex options override loaded Plex URL/token/library/scan settings through the existing
  adapter factory. No credential should enter test fixtures or snapshots.

Issue 56 changes none of these keys or options, so Bash, Zsh, and Fish completion templates should
remain byte-for-byte unchanged after an explicit parity audit.

## Resource Lifecycles

| Action        | Acquisition                                                                                                                              | Normal/failure release contract                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrate       | Writable DB only when not dry-run                                                                                                        | Put `closeDatabase()` in `finally`; close exactly once after any discovery, import, prompt, or cleanup outcome. Dry-run opens nothing.                                     |
| Sync          | Optional writable DB/operation; abort controller; `sync-abort`, `sync-partial-files`, and optional `sync-database` cleanup registrations | In `finally`, unregister handlers, finalize operation counts/status while DB is open, then close exactly once. Preserve later-source continuation for per-source failures. |
| Album verify  | Optional read-only DB retained with loaded candidates; abort cleanup registration                                                        | Unregister abort handler and close retained DB in `finally`. Quick tier has no DB.                                                                                         |
| Filter verify | Optional read-only DB opened only while loading candidates; abort cleanup registration                                                   | Evidence loader closes immediately in its own `finally`; aggregation unregisters abort cleanup in `finally`. Quick tier has no DB.                                         |

Tests that mutate process-global signal handlers, loaded config, cwd, logger mode, or prompt mode
must restore them. Real SQLite tests need unique temporary database paths and explicit closure.

## Safe Issue 56 Integration Points

1. **Verification tests only:** extend `verify-album.test.ts` and `verify-filter.test.ts` at the
   exported action boundary for missing detection, staged repair, failed recheck, and final counts.
   Do not duplicate tier algorithms or the existing conflict matrix.
2. **Classification-aware sync write:** add a narrow internal parameter/discriminant to
   `syncFile()` in `actions/sync.ts`; do not add a CLI/MCP option or alter `SyncOptions` merely to
   distinguish diff-owned updates.
3. **Reusable tracking migration:** expose a library-owned importer from `completed-tracker.ts` that
   both automatic and manual migration can call. Preserve `(inputFile, optionsHash, mode)` identity.
4. **Directory-aware history migration:** accept an optional directory in `history.ts`, defaulting
   to `getHistoryDir()`, so automatic callers remain compatible and manual discovery/import agree.
5. **Proof-gated cleanup:** keep deletion-list construction in `migrate-tracking.ts`, but populate
   it only from library-returned `imported`/`alreadyEquivalent` file outcomes.
6. **Real persistence proof:** use a temporary SQLite database for importer equivalence tests;
   action tests may mock DB lifecycle and unlink/prompt failures around that proven seam.
7. **No surface expansion:** leave `commands/*`, MCP schema, shell completions, `schema.sql`, and
   package manifests unchanged unless a focused regression proves an existing projection defect.

## Integration Test Matrix

| Boundary          | Required proof                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify actions    | Missing expected path, successful staged recheck, failed recheck remains unresolved, database open/close by tier                                                                                                                          |
| Sync action       | New/updated/unchanged classification; updated existing destination replacement; missing-source continuation; downgrade remove/retain/failure; DB versus JSONL routing; hash/inventory failure ordering; scan gating; cleanup registration |
| Tracking importer | Separate same-hash input identities; completed/failed row equivalence; transaction failure retains sources; existing-equivalent versus conflicting state                                                                                  |
| History importer  | Custom directory forwarding; complete session/operation equivalence; malformed entry rollback/retention; already-equivalent session handling                                                                                              |
| Migration action  | Dry-run opens/writes/prompts/deletes nothing; route flags; confirmation/force; per-file cleanup eligibility; partial unlink aggregation; close-on-throw                                                                                   |

Run focused Vitest files first, then the full `rfmedia-cli` suite and typecheck. Use the repository's
pinned Node 22 runtime through `mise exec`. No generated Lidarr client or codegen gate is touched by
this feature.

## Open Questions

1. For manual tracking import, which command value should be stored in `operations.command` for
   legacy sidecars whose header does not encode the original copy command? Keep the value stable and
   document it; identity still requires input, options hash, and mode.
2. Should an already-present history session be cleanup-eligible only after full row equivalence,
   or always retained for explicit operator review? Full equivalence is the minimum safe automated
   rule.
3. In `--paths` sync, should the real YAML filename replace the action's current `yaml-paths`
   placeholder for durable operation/inventory identity? If changed, preserve MCP callers that pass
   inline `sources[]` and have no file identity.
