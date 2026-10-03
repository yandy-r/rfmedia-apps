# Code Analysis: Metadata Drift Detection and Reconciliation

> **Settled-contract note:** The approved implementation supersedes the early acquisition advice
> that relied only on fresh adapter instances and `openDatabaseReadOnly()`. The final contract uses
> an immutable existing-file database snapshot with a reviewed file identity, an identity-checked
> writable handoff, cancellable provider-neutral queries, and uncached library-version and exact
> track freshness reads.

## Executive Summary

Issue #125 fits the existing rfmedia command/action/library split without a schema migration or a
new media-server capability. The safest implementation is a pure reconciliation engine fed by one
I/O action: scan exact root-contained paths from a hardened read-only SQLite snapshot, bounded
local metadata reads, and a complete provider-neutral track snapshot; apply is rating-only, repeats
the scan after authorization, executes deterministic per-record targets, performs one guarded
SQLite update last, and verifies with fresh evidence.

The revised design's three boolean winner flags should be normalized by one shared function and
validated both before lazy action loading and at the action boundary. Non-rating findings belong in
`observedResiduals`; they must never become planned writes or blockers for the requested
rating/stat plan. Known rating/stat blockers make the preview non-executable and make executed
apply perform zero writes unless `--allow-partial` is explicit.

## Existing Code Structure

### CLI and presentation

- `packages/rfmedia-cli/src/cli.ts` statically imports each top-level command and registers it with
  `program.addCommand(...)`. Its `preAction` hook resolves the root `--json`/`--output` contract,
  loads configuration, and sets the shared output mode before a leaf action runs.
- `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts` is the closest presentation pattern:
  validate cheap invariants before `loadActions()`, keep the action import lazy, emit a stable
  `{ command, result }` JSON/YAML envelope, project an explicit fixed-column CSV row union, render
  human text on stderr, and let the command own `process.exitCode`.
- `packages/rfmedia-cli/src/lib/formatters/index.ts::formatOutput()` already neutralizes
  spreadsheet-formula-looking CSV cells. Reconciliation should pass an explicit `columns` array
  and pre-project nested evidence rather than depend on generic flattening.
- `packages/rfmedia-cli/src/lib/prompt.ts::confirm()` writes prompts to stderr and defaults to No;
  `isInteractive()` is the established TTY test.

### Reconciliation and rating precedents

- `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts` demonstrates complete acquisition followed
  by deterministic report construction, but its bridge identity/cache semantics must remain
  separate from file metadata reconciliation.
- `packages/rfmedia-cli/src/actions/plex-sync.ts` supplies useful rating-specific seams:
  response-driven paging via `advancePaginationOffset()`, exact file-path matching, native-step
  rating equivalence, bounded work through `processInParallel()`, `writeRating()`, and
  `MediaServerAdapter.metadata.updateTrackRating()`. Its mutation-by-default behavior and
  first-row path map are not suitable for the new command.
- `packages/rfmedia-cli/src/types/media-server.ts` already exposes every server capability V1
  needs: `MediaTrack.filePath`, normalized rating, artist/year/optional genres, native rating scale,
  paged `query.tracks()`, and `metadata.updateTrackRating()`.
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts::resolveRequiredMediaServerAdapter()`
  creates a provider-neutral adapter. A `PlexAdapter` owns a new instance-local cache at
  construction, and successful rating writes invalidate its query cache.

### File evidence and mutation

- `packages/rfmedia-cli/src/lib/metadata.ts::readExtendedMetadata()` returns one normalized
  metadata projection. A returned object distinguishes absent fields; a `null` return means parse
  failure and must become typed failed evidence rather than a missing tag.
- `packages/rfmedia-cli/src/lib/audio.ts::findAudioFiles()` currently follows symbolic links. It
  cannot be called unchanged for reconciliation discovery.
- `packages/rfmedia-cli/src/lib/tag-writer.ts::writeRating()` is the public pathname write boundary.
  MP3 and FLAC are supported; OGG/Opus and M4A/AAC return explicit unsupported results. It clamps
  invalid numbers, so the planner/action must validate a finite `0..1` winner before calling it.
- Existing hardened readers in `lib/integrity.ts`, `lib/convert.ts`, and
  `lib/conversion-metadata.ts` establish the repository's `lstat`/regular-file/no-symlink and
  device/inode/stat fingerprint patterns. The feature can reuse that pattern around
  `readExtendedMetadata()` and `writeRating()` without broadening the conversion subsystem.

### SQLite evidence

- `packages/rfmedia-cli/src/lib/db.ts::openReconciliationDatabaseReadOnly()` is the required scan
  boundary. It rejects non-regular paths, symlinks, active sidecars, oversized files, unstable
  reads, and schema drift, then returns an in-memory query-only snapshot plus the reviewed file
  identity. `withReconciliationDatabaseWritable()` later pins and verifies that identity before a
  guarded write without initializing or migrating the database.
- `initializeDatabase()` is writable and may create directories, enable WAL, initialize schema,
  and migrate. It must not be called during scan, preview, blocked execution, or declined
  execution.
- `inventory` rows are operation-scoped. `DbInventoryEntry` already contains the exact columns
  needed by the feature: row and operation IDs, provenance paths, `mtime`, `size`, `rating`,
  `genre`, `year`, `artist`, `dest_path`, hash, and copied time.
- `getInventoryFingerprintCandidates()` is a useful validation precedent, but it queries by
  `source_path`; reconciliation joins by `inventory.dest_path` and therefore needs a separate
  typed query.

## Implementation Patterns

### Pure engine

Create `packages/rfmedia-cli/src/lib/reconciliation.ts` with no filesystem, SQL, Commander,
logging, prompting, or adapter imports. Recommended exported symbols are:

- `normalizeReconciliationPath()` for lexical absolute normalization and root containment checks;
  path comparisons remain case-sensitive and never use basenames.
- `normalizeReconciliationValue()` helpers for rating, text, and year. Preserve source display
  values separately from canonical comparison keys.
- `ratingsShareNativeStep()` moved or generalized from `plex-sync.ts`, accepting the adapter's
  `MediaServerNativeRatingScale`.
- `buildReconciliationReport(input)` to index file, database, and server observations, preserve
  duplicate database/server paths as ambiguity, classify findings, and return stable sorted output.
- `resolveReconciliationStrategy(flags)` to count `fileWins`, `dbWins`, and `serverWins`, require
  exactly one, and return the closed strategy union.
- `buildReconciliationPlan(report, strategy)` to plan only rating and selected stale-stat writes,
  separate non-rating `observedResiduals`, and calculate blockers/actionability.
- `reconciliationResultStatus(...)` or equivalent exhaustive reducer for closed
  status/success/exit-code semantics.

Use discriminated observation unions rather than optional bags, for example
`present | missing | unavailable | invalid | failed`. Keep `null` rating distinct from zero and
make finding IDs/order deterministic from path, field, code, target, operation ID, and server ID.

### One-of winner flags

In `packages/rfmedia-cli/src/commands/reconcile.ts`, define three boolean `Option` instances:

```ts
new Option("--file-wins", "Use embedded file ratings as authority").conflicts(["dbWins", "serverWins"]);
```

Apply the equivalent conflicts to all three options. Commander conflicts provide immediate
multiple-flag diagnostics, but they do not prove at least one flag is present. The action callback
must call `resolveReconciliationStrategy(cmdOptions)` before `loadActions()`. The action must call
the same resolver again so direct/programmatic callers cannot bypass the invariant.

Do not use a default strategy, a string `--strategy`, an `argParser`, or `--yes`/`--execute`
implication. `--yes` and `--allow-partial` are inert without `--execute`.

### Unsupported and partial repair

The planner should expose two independent views:

- `requestedFields: ["rating"]` plus stale-stat maintenance: the only V1 mutation plan;
- `observedResiduals`: artist, genre, and year findings, including unavailable server genre.

Non-rating residuals do not make a rating plan non-executable and do not count as requested drift.
Blockers are limited to the requested plan: missing/invalid/ambiguous winner rating, ambiguous
database/server identity, failed evidence, missing stale destination, unsupported required file
format, and changed/stale preconditions.

Before approval, compute all known blockers:

- without `--allow-partial`, any blocker yields `executable: false`; an execution request returns
  `blocked` and acquires no writable dependency;
- with `--allow-partial`, only records whose target sequence is independently actionable may run;
  blocked records remain stable outcomes and final status stays `partial`/nonzero while requested
  drift remains;
- preview itself succeeds with exit zero whether actionable or blocked;
- an unsupported rating target is a requested-plan blocker, while an unsupported non-rating
  target is observation-only.

This avoids an implicit SQLite-only repair and does not require generic artist/genre/year writers,
adapter changes, field-selection syntax, or a schema migration.

### Acquisition and freshness

`packages/rfmedia-cli/src/actions/reconcile.ts` should expose an injectable dependency surface and
compose these stages:

1. Resolve the source root, verify it is an existing non-symlink directory, and discover audio
   candidates without following symlinks.
2. For each candidate, verify root containment and capture `dev`, `ino`, `size`, `mtimeMs`, and
   `ctimeMs`; read metadata; `lstat` again; classify changed/read/parse failures.
3. Resolve the existing database path with precedence
   `--tracking-database` -> `resolveUndoDatabasePath(config)`, open only with
   `openReconciliationDatabaseReadOnly()`, retain its reviewed identity, query candidate rows, and
   close in `finally`.
4. Call a newly resolved adapter, bracket the complete `query.tracks()` drain with uncached
   `query.libraryContentVersion()` reads, and pass the caller's `AbortSignal` to every provider
   query. Reject a changed content version, stalled/changing/inconsistent totals, oversize totals,
   and duplicate exact paths rather than selecting a row.
5. Feed immutable observations to the pure engine and return the report/preview.

For executed apply, do not reuse the preview adapter as final proof. Call the resolver for each
authoritative acquisition/reacquisition, and use uncached `query.trackById()` plus
`query.libraryContentVersion()` for targeted pre-write and post-write freshness. The
provider-neutral query options carry an optional `AbortSignal`; the signal is never part of query
cache identity, and the two targeted freshness methods must bypass response caches.

Before a file write, repeat containment, `lstat`, regular/no-symlink, and full stat fingerprint
comparison, validate the winning rating, call `writeRating()`, then reread metadata. This honors
the settled design while documenting the existing writer's final pathname-swap race rather than
claiming descriptor-level atomicity.

Within a record, use deterministic target order: file, server, then database, omitting the authority
plane and already-equal targets. Stop later targets for that record after a failure. Open writable
SQLite only after execute authorization, blocker policy, and approval; keep database transactions
short and never hold one during a file or provider call.

### Guarded database helpers

Add narrow helpers to `packages/rfmedia-cli/src/lib/db.ts`, with input/result contracts in
`packages/rfmedia-cli/src/types/db.ts`:

- `getReconciliationInventoryCandidates(db, rootPath, operationId?, limit?)`
  selects explicit inventory columns by exact `dest_path` root scope and optional operation,
  preserves duplicates, validates every `unknown` row, sorts deterministically, and rejects
  `limit + 1` results. Prefer `substr(dest_path, 1, length(?)) = ?` with a normalized
  root-plus-separator over an unescaped `LIKE` prefix.
- `updateReconciliationInventory(db, update)` performs one short transaction and updates rating,
  size, and integer-millisecond mtime by row ID plus expected `operation_id`, `dest_path`, `mtime`,
  `size`, and null-safe prior rating. Exactly one changed row is success; zero is
  `stale-evidence`. A primary-key predicate makes more than one row an invariant failure.

Do not use `INSERT OR REPLACE`, select the newest operation implicitly, delete stale rows, update
non-rating metadata, modify `copied_at`, or persist server snapshots.

## Integration Points

### Files to create

| File                                                  | Exact responsibility                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/reconciliation.ts`    | Closed planes, fields, observation/finding/plan/outcome/result/status/count contracts and schema literal.                              |
| `packages/rfmedia-cli/src/lib/reconciliation.ts`      | Pure normalization, exact-path join, ambiguity classification, strategy resolution, rating/stat planning, blocker and result reducers. |
| `packages/rfmedia-cli/src/lib/reconciliation.test.ts` | Table-driven pure contract tests and deterministic ordering.                                                                           |
| `packages/rfmedia-cli/src/actions/reconcile.ts`       | Safe acquisition, dependency injection, read-only preview, authorization rechecks, target execution, and post-scan.                    |
| `packages/rfmedia-cli/src/actions/reconcile.test.ts`  | No-write gates, fresh-adapter calls, blocker/partial behavior, one verified rating apply, and mid-record failure.                      |
| `packages/rfmedia-cli/src/commands/reconcile.ts`      | `scan`/`apply` grammar, winner options, presentation, CSV projection, confirmation integration, and exit code.                         |
| `packages/rfmedia-cli/src/commands/reconcile.test.ts` | Pre-lazy-load flag validation, machine/non-TTY gates, one output document, summary-only CSV, and exit semantics.                       |

### Files to modify

| File                                                               | Symbols/change                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/cli.ts`                                  | Import/register `reconcileCommand`; no global option changes.                                               |
| `packages/rfmedia-cli/src/types/index.ts`                          | Re-export public reconciliation contracts and new DB helper types if intended public.                       |
| `packages/rfmedia-cli/src/types/db.ts`                             | Add guarded reconciliation candidate/update input types without importing action types.                     |
| `packages/rfmedia-cli/src/lib/db.ts`                               | Add root/operation candidate query, runtime row validator reuse, and guarded exact update.                  |
| `packages/rfmedia-cli/src/lib/db.test.ts`                          | Real temporary SQLite tests for scope, duplicate preservation, cap, empty result, and stale guarded update. |
| `packages/rfmedia-cli/src/lib/audio.ts`                            | Add a reconciliation-safe no-follow discovery option/helper while preserving current default behavior.      |
| `packages/rfmedia-cli/src/lib/audio.test.ts`                       | Prove the new discovery mode does not traverse directory/file symlinks.                                     |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`           | Add root `reconcile`, leaves, exact leaf options, and winner flags.                                         |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`            | Mirror the Bash hierarchy/options.                                                                          |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`           | Add path-aware parent/leaf predicates and exact options.                                                    |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` | Add order-sensitive root/leaf parity and reject mutation options on `scan`.                                 |

No change is required in `types/media-server.ts`, `lib/adapters/plex-adapter.ts`, private Plex
modules, `schema.sql`, or migrations for V1.

## Code Conventions

- Use strict TypeScript, readonly results, discriminated unions, exhaustive `never` switches, no
  `any`, and `.js` ESM import suffixes.
- Exported functions require JSDoc. Keep provider wire types and private `adapters/plex/*` imports
  below `plex-adapter.ts`; architecture checks scan raw import strings, including type-only imports.
- Validate `unknown` from SQLite, metadata/provider boundaries, and Commander option records before
  constructing typed observations.
- Use `vi.hoisted()` and `vi.clearAllMocks()` in mocked tests. Adapter-resolver tests without an
  explicit token must isolate `RFMEDIA_PLEX_AUTH_DIR`.
- Close every read-only/writable database in `finally`; do not let a scan/preview create a database
  or SQLite sidecar.
- Keep all machine stdout in `formatOutput()`, all human/prompt output on stderr, and set
  `process.exitCode` only after output has been emitted.

## Dependencies and Services

- `commander` v14: nested commands and mutual conflicts; manual exactly-one validation remains
  necessary.
- `music-metadata`: existing single-pass metadata projection; `null` is parse failure.
- `better-sqlite3`: synchronous bound queries and short guarded update transactions.
- `p-limit` through `processInParallel()`: bounded reads/applies with input-indexed results.
- `MediaServerAdapter`: provider-neutral paging, native rating precision, and non-throwing rating
  updates.
- `@rfmedia/common`: active output mode, machine-format detection, and JSON/YAML/CSV serialization.
- `node:fs/promises`: `lstat`/stat fingerprint checks and exact root safety around pathname reads
  and writes.

## Gotchas and Warnings

- The revised feature spec contains the settled winner flags/rating-only boundary; older research
  prose that still says `--strategy` or SQLite non-rating repair is stale.
- Commander conflict names are camel-cased option attributes (`dbWins`, `serverWins`), not dashed
  CLI spellings. A focused command test should pin this.
- A machine format is never approval. `--execute` in JSON/YAML/CSV or non-TTY mode must require
  explicit `--yes` before any writable dependency.
- `findAudioFiles()` follows symlinks today. Changing its default would risk unrelated copy/sync
  behavior; add an opt-in no-follow path.
- Superseded by the settled acquisition contract: a metadata read/parse failure aborts acquisition.
  The action emits no typed `read-failed` finding or reconciliation result; the command emits a
  sanitized error envelope and exits nonzero.
- An empty `MediaTrack.filePath` is unmatched. Duplicate server paths and duplicate inventory
  destinations must remain ambiguous even when their ratings agree.
- Database `NULL` for artist/genre/year is usually absent production evidence, not an instruction
  to clear another plane.
- File rating writes can change size/mtime; capture fresh post-write stat values before the guarded
  database update.
- Provider-neutral queries accept an optional `AbortSignal`, which adapters propagate to in-flight
  requests. Cancellation still stops only at provider and target boundaries; completed external
  writes remain truthful outcomes and are not rolled back.
- Three planes have no shared transaction. Never roll forward the SQLite row after an earlier
  target failure, and never report full convergence without a fresh post-scan.

## Focused Tests

1. `lib/reconciliation.test.ts`: exact root/path join, duplicate ambiguity, missing versus zero,
   native-step rating equivalence, text/year normalization, rating-only plan, non-rating residual
   separation, blocker fail-close/allow-partial, and stable sort.
2. `lib/db.test.ts`: exact `dest_path` root plus optional operation, wildcard-looking roots,
   duplicates preserved, hard cap, valid empty scope, guarded rating/stat update, and zero-row stale
   refusal.
3. `actions/reconcile.test.ts`: scan/preview/blocked/declined paths never call writable open or any
   writer; executed machine mode requires `--yes`; execute uses uncached library-version and exact
   track freshness reads with cancellable query options; one MP3/FLAC rating path updates external
   targets before DB and post-verifies; one failure prevents later targets and yields partial.
4. `commands/reconcile.test.ts`: zero/multiple flags reject before `loadActions`, each single flag
   normalizes correctly, `--yes`/`--allow-partial` are inert without execute, JSON/YAML envelope is
   singular, empty CSV has summary row and fixed columns, output precedes nonzero exit state.
5. `shell-completions/templates.spec.ts`: identical Bash/Zsh/Fish root hierarchy, apply-only winner
   and mutation flags, scan-only read options, and no regression of nested `lidarr reconcile`.

Do not duplicate existing exhaustive tag-format, adapter HTTP/cache, read-only SQLite hardening, or
generic formatter coverage.

## Recommended Implementation Layering

1. Define the reconciliation type contract and pure engine with its focused tests.
2. Add and test no-follow discovery plus bounded inventory query/guarded update helpers.
3. Build the action against injected file/DB/adapter seams and prove all no-write gates before
   adding the successful apply case.
4. Add the command/presenter, register it, and prove exactly-one/machine-output behavior.
5. Update all three static completion templates together and run the parity test.
6. Add operator documentation and lifecycle files after the public code contract is stable.

The first two layers can proceed independently. The action depends on both; the command depends on
the action result contract; completions depend only on the settled command grammar.
