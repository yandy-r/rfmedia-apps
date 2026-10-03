# Issue #56 Action Tests: Technical Research

## Executive Summary

Issue [#56](https://github.com/yandy-r/rfmedia-apps/issues/56) asks for critical action-level
coverage of album verification, filter verification, sync, and legacy tracking migration, with
filesystem isolation and explicit missing, extra, size-mismatch, and fix-conflict cases. The issue's
snapshot is stale: `verify-album.test.ts`, `verify-filter.test.ts`, and `sync.test.ts` now exist and
47 focused tests pass, but `migrate-tracking.test.ts` is still absent and important action branches
remain uncovered.

The implementation should extend the existing suites rather than recreate them. Current focused
line coverage is 59.73% for `verify-album.ts`, 63.87% for `verify-filter.ts`, 46.54% for `sync.ts`,
and 0% for `migrate-tracking.ts`. The issue's 80% target should be measured explicitly against
these four action files, but tests should be driven by the contracts below rather than by inert
logging lines.

## Scope Decisions

- Modify only the four co-located action test files named by the issue. Three are existing files;
  create `migrate-tracking.test.ts`.
- Exercise exported action entry points. Do not export private helpers or introduce test-only
  production APIs merely to improve coverage.
- Preserve existing verify conflict tests. They already cover mismatch `skip`/`overwrite`, extra
  `remove`/`keep`, interactive selection, apply-to-all, non-interactive behavior, dry-run, `--force`,
  trash, rename refusal, staged repair validation, and tiered verification.
- Treat the 80% figure as a verification criterion for each affected action's line and statement
  coverage. Do not add a repository-wide threshold to `vitest.config.ts`; that would broaden this
  issue to unrelated modules.
- No CLI option, result schema, database schema, or completion change is required for test work.
  Production changes are justified only if a new contract test exposes one of the migration defects
  documented below.

## Data Models

This issue does not require a new production data model. Tests should assert the existing public
contracts in `types/results.ts`: `VerifyCommandResult`, `SyncResult`, and `MigrateResult`, including
their counters, issue/failure collections, conflict/fix results, legacy-file metadata, and deletion
errors. Test fixtures should use the existing `VerifyOptions`, `SyncOptions`, and `MigrateOptions`
types rather than parallel test-only shapes.

No SQLite schema or JSON result change is needed. If critical migration tests justify the minimal
correctness fixes described below, they should reuse existing operation, completed/failed source,
and history-session records; they must not introduce a new table, column, or wire field.

## Architecture Design

### Verify album

`commands/verify.ts` builds `VerifyOptions` and calls
`executeAlbumVerifyWithFileInput()`. That entry point resolves CLI/file/single-source input, applies
range precedence (`cliRange` over per-path `range` over `configRange`), opens verification evidence
once for non-quick tiers, installs an abort cleanup, and aggregates per-source results.
`executeAlbumVerify()` is the narrower single-source seam used by the current tests.

For each source album, `processAlbumVerification()` expands the configured suffix range and invokes
`verifyAlbumCopy()` through `processInParallel()`. Verification maps every source file to an expected
destination, records missing files, delegates present-file checking to `verifyFileByTier()`, and
uses `findExtraFiles()` after constructing the expected filename set. With `fix`, missing and
mismatched files are staged and reverified; extras are kept, removed, or trashed according to the
resolved conflict; a full post-repair pass determines final counters.

### Verify filter

`commands/verify.ts` calls `executeFilterVerifyWithFileInput()`. It resolves and canonicalizes
sources, computes per-source range precedence, shares one evidence preload across the batch, and
selects flat/preserve-structure verification or filter album mode. `executeFilterVerify()` remains
the current single-source test seam.

The action discovers audio files, reads rating and optional metadata filters, builds deterministic
destination tasks (including collision allocation and conversion names), verifies tasks in
parallel, and finds extras per destination directory. Fix mode applies the same conflict semantics
as album verification and then rebuilds the result from re-verification. Files that do not meet the
filter are not expected destinations and must not be reported missing.

### Sync

`commands/sync.ts` and the MCP adapter both call `executeSyncWithFileInput()`. The action prefers
`copyOptions.cliSourceEntries`, otherwise reads `copyOptions.file`, chooses database or legacy
inventory mode, optionally resets inventory, loads or initializes it, and installs abort, partial
file, and database cleanup handlers.

Each source is checked independently. Album mode delegates diff classification to
`computeAlbumSyncDiff()`; filter mode delegates to `computeFilterSyncDiff()` and optionally removes
downgraded destinations. New and updated files flow through `syncFile()`, which builds each range
destination, skips existing destinations unless forced, materializes the first copy, links later
suffixes, hashes the represented destination, and appends exactly one inventory record. Per-file
and per-source errors are accumulated in `SyncResult`. Database mode finally records completed,
partial, or failed operation status, closes the database, and optionally triggers a media scan only
after non-dry-run writes.

### Migrate tracking

`commands/migrate.ts` validates mutually exclusive `--tracking-only` and `--history-only` flags and
calls `executeMigrate()`. The action conditionally opens SQLite, discovers tracking sidecars with
`fast-glob`, parses filenames and entry counts, groups completed/failed files by hash, discovers
history JSONL headers, delegates history migration, optionally confirms deletion, unlinks each
legacy file independently, and returns aggregate counts plus deletion errors.

The migration action is the orchestration seam; parsing and deletion behavior can be covered
through its exported entry point by controlling its imported dependencies. Command flag parsing is
already outside the issue's named files and should not be duplicated here.

## Relevant Files

- `packages/rfmedia-cli/src/actions/verify-album.ts`: album/range verification, fix resolution,
  evidence lifecycle, and multi-source aggregation.
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`: existing 20-test conflict and tiered
  verification harness; extend in place.
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: rating selection, destination task layout,
  verification/fix behavior, and multi-source aggregation.
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`: existing 21-test conflict, layout, and
  tiered verification harness; extend in place.
- `packages/rfmedia-cli/src/actions/sync.ts`: incremental sync orchestration, materialization,
  downgrade removal, inventory persistence, cleanup, and scan triggering.
- `packages/rfmedia-cli/src/actions/sync.test.ts`: existing six-test fingerprint-persistence suite;
  expand its mock surface and scenarios.
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts`: legacy discovery, grouping, history
  migration, deletion, and result summary.
- `packages/rfmedia-cli/src/actions/migrate-tracking.test.ts`: new action test file.
- `packages/rfmedia-cli/src/lib/tiered-verification.ts`: authoritative verification outcomes and
  counter aggregation; mock at the verify action boundary rather than retest its internals.
- `packages/rfmedia-cli/src/lib/inventory.ts`: authoritative sync diff and persistence behavior;
  its own tests cover diff algorithms, so action tests should provide diff results as fixtures.
- `packages/rfmedia-cli/src/lib/completed-tracker.ts`: contains a private legacy tracking migrator
  used during normal tracking initialization.
- `packages/rfmedia-cli/src/lib/history.ts`: contains `migrateLegacyHistory()` and the history
  directory resolver.
- `packages/rfmedia-cli/src/types/results.ts`: public result counters asserted by action tests.
- `packages/rfmedia-cli/src/types/options.ts`: `MigrateOptions` contract.
- `packages/rfmedia-cli/vitest.config.ts`: Node/V8 coverage configuration; no change recommended.
- `.github/workflows/rfmedia-cli.yml`: registered Node 22 typecheck and full coverage gate.
- `ROADMAP.md`: three live references to #56 require completion-parity updates when the issue ships.

## Exact Test and Mocking Boundaries

### Shared rules

- Use `vi.hoisted()` for mock state referenced by ESM `vi.mock()` factories.
- Reset calls and restore deliberate defaults in `beforeEach()`. Existing verify suites depend on
  `clearAllMocks()` preserving implementations; do not replace it indiscriminately with
  `resetAllMocks()`.
- Assert public result objects and mutation boundaries, not log phrasing or private helper calls.
- Keep `processInParallel()` deterministic in action tests by using the existing sequential mock.
  Parallel scheduling itself belongs to `parallel.test.ts`.
- Use POSIX-looking absolute paths and `node:path` to build expected paths. Do not depend on the
  developer's music tree, home directory, process-global database, or real trash.

### Verify suites

Retain their current real temporary-directory setup only for test isolation. All behaviorally
important I/O stays mocked:

- `../lib/filesystem.js`: `pathExists`, size lookup, directory creation, staged replacement,
  copy/link, removal, trash, and open-file verification target.
- `node:fs/promises`: album `readdir` and file `stat` only. Preserve real `mkdtemp`, `mkdir`, and
  `rm` by spreading the original module as the suites already do.
- `../lib/audio.js`, `../lib/ratings.js`, and `../lib/verify.js`: source discovery, eligibility,
  expected filenames, and extras.
- `../lib/tiered-verification.js`: return explicit `present`, `missing`, or `size-mismatch`
  outcomes. Do not reproduce tier algorithms in action tests.
- `../lib/conflict-resolver.js`: decision-only mocks for strategy and interactive branches; assert
  actual filesystem adapter calls made by the action.
- `../lib/db.js`: read-only evidence candidates and close behavior.
- `../lib/input-file.js`, `../lib/signal-handler.js`, `../lib/parallel.js`: batch entry and cleanup
  seams.

Do not create a shared verify test utility in this issue. The suites have similar mocks but
different directory layouts, evidence ownership, rating dependencies, and fix behavior; extracting
them would turn a focused coverage issue into a risky harness refactor.

### Sync suite

Expand the current single `mocks` object and module factories; do not use the real filesystem or
SQLite:

- Inventory: mock input loading/path resolution, load/initialize/reset, album/filter diff,
  source/file append, entry construction, and options hash.
- Filesystem/content: mock existence, size, ensure, copy/link, conversion, hash, removal, and
  partial cleanup.
- Database: expose stable spies for initialize/create operation/count update/status update/close.
- Rating and scan: control rating reads and a capability-bearing scan adapter.
- Signal/progress: retain deterministic cleanup registration and disabled progress.

Use a small `emptyDiff()` fixture and mode-specific option builders. This keeps each test focused on
action orchestration rather than re-specifying inventory's diff algorithm.

### Migrate suite

Create one hoisted virtual filesystem fixture keyed by absolute path:

- mock `fast-glob` to return selected tracking sidecars;
- partially mock `node:fs/promises` for `readdir`, `readFile`, and `unlink`;
- mock `pathExists` for the chosen history directory;
- mock database initialization/close with an opaque connection;
- mock `migrateLegacyHistory`, config/database path resolution, confirmation, and logger methods.

Prefer this virtual fixture over real cwd scans: `discoverLegacyTrackingFiles()` defaults to
`process.cwd()` and a real glob could accidentally include developer artifacts. Assertions must
cover returned `MigrateResult`, calls at the database/history/deletion seams, and cleanup; logs are
not the contract.

## Critical Test Matrix

The following is the minimum implementation-ready matrix. Rows marked **existing** should be
retained, not rewritten or duplicated.

| File                       | Scenario and setup                                                                                                                                                      | Required assertions                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-album.test.ts`     | **Existing:** size mismatch with strategy `skip` and `overwrite`                                                                                                        | Skip leaves mismatch unresolved and performs no write; overwrite uses validated staging and final counters come from re-verification.                                                    |
| `verify-album.test.ts`     | **Existing:** extra destination with overwrite/skip/force/trash                                                                                                         | Overwrite maps to remove, skip maps to keep, force preserves compatibility, trash never calls direct removal.                                                                            |
| `verify-album.test.ts`     | New dense detection case: one present source file, one absent expected destination, one size mismatch, and one extra file across a single suffix                        | `verified`, `missing`, `sizeMismatch`, `extra`, `expectedTotal`, and issue paths are exact; no mutation occurs when `fix: false`.                                                        |
| `verify-album.test.ts`     | New missing-file fix case with first verification missing and recheck present                                                                                           | The exact source/destination pair goes through staged repair; result changes to verified, `copiedFiles`/`repairedFiles`/`reverifiedFiles` increment, and `remainingIssues` becomes zero. |
| `verify-album.test.ts`     | New batch/range case through `executeAlbumVerifyWithFileInput()` with CLI entries covering CLI, per-path, and config range precedence plus one source without any range | Generated suffix destinations prove precedence; missing range is a contained `failed` entry; abort cleanup and evidence database close occur once for the batch.                         |
| `verify-filter.test.ts`    | **Existing:** mismatch conflicts, extra conflicts, force/trash, interactive and staged repair outcomes                                                                  | Preserve the current assertions; they already satisfy the issue's conflict-scenario requirement.                                                                                         |
| `verify-filter.test.ts`    | New dense eligibility/detection case: eligible present, eligible missing, filtered-out source, and extra destination                                                    | Only eligible files contribute to `expectedTotal`; missing and extra paths/counters are exact; filtered-out input is neither verified nor missing.                                       |
| `verify-filter.test.ts`    | New missing-file fix case, parameterized for flat and preserve-structure destinations                                                                                   | Repair uses the exact allocated path, re-verification clears the issue, and mutation/result counters agree.                                                                              |
| `verify-filter.test.ts`    | New batch case through `executeFilterVerifyWithFileInput()` with one source failing and one succeeding, plus range precedence                                           | Source failures are contained and successful counters remain; input paths are canonicalized; shared evidence is preloaded once and cleanup unregisters once.                             |
| `sync.test.ts`             | Existing fingerprint copy/hardlink/conversion table and hash/inventory failure cases                                                                                    | Preserve write -> hash -> inventory ordering, one record for the represented first range destination, and no persistence in dry-run.                                                     |
| `sync.test.ts`             | Album action aggregation: diff has one new, one updated, one unchanged; use a single-suffix range                                                                       | Result reports 1/1/1; source scan record precedes writes; exact destination paths are materialized; updated files are not miscounted as new.                                             |
| `sync.test.ts`             | Existing destination, parameterized `force: false/true`                                                                                                                 | Without force the action skips materialization and inventory append; with force it rewrites and persists.                                                                                |
| `sync.test.ts`             | Missing source followed by valid source                                                                                                                                 | Missing source produces an `ENOENT` failure without aborting the later source; `sourcesScanned`, `failedFiles`, and successful counters remain consistent.                               |
| `sync.test.ts`             | Filter downgrade deletion, parameterized destination absent, removal success, and removal failure                                                                       | Absent counts as already deleted; success calls `remove`; failure records source/destination/code and does not increment deleted. `deleteDowngraded: false` performs no removal.         |
| `sync.test.ts`             | Database lifecycle, parameterized all-success and one-source-failure                                                                                                    | Initializes/loads database inventory, creates one operation, updates exact counts and `completed`/`partial` status, closes once, and unregisters all cleanup names.                      |
| `sync.test.ts`             | Input/inventory boundaries: no file or paths, empty input file, reset inventory, and dry-run initialization                                                             | Required-input and empty-file errors are exact; reset routes once only outside dry-run; dry-run never initializes or resets persistent inventory.                                        |
| `sync.test.ts`             | Scan adapter gating, parameterized successful write, no changes, write failure, and dry-run                                                                             | Scan triggers only after a non-dry-run new/updated success; scan failure is non-fatal and does not change sync counters.                                                                 |
| `migrate-tracking.test.ts` | Dry-run tracking discovery with paired completed/failed files sharing a hash, a second hash, comments/blank lines, and an invalid filename                              | Files group into two operations; sources equal non-comment entries; invalid names are ignored; no database or unlink call occurs.                                                        |
| `migrate-tracking.test.ts` | History discovery at explicit `historyPath` with valid, empty, non-header, malformed, and non-JSONL entries                                                             | Only valid JSONL headers appear in `legacyFiles`; operation count excludes the header; malformed input is contained rather than rejecting the action.                                    |
| `migrate-tracking.test.ts` | `trackingOnly` and `historyOnly` routing                                                                                                                                | Each mode skips the other discovery/migration dependency and returns a zero-valued result for the skipped domain.                                                                        |
| `migrate-tracking.test.ts` | `deleteOld` decision table: confirmation false, confirmation true, `force`, and dry-run                                                                                 | Decline performs no unlink; confirmation/force deletes discovered paths; force bypasses prompt; dry-run performs neither prompt nor unlink.                                              |
| `migrate-tracking.test.ts` | Partial deletion failure across multiple files                                                                                                                          | Deletion continues after an `unlink` rejection; `filesDeleted` counts successes and `errors` preserves failed path/message/code.                                                         |
| `migrate-tracking.test.ts` | Database/history migration success and thrown-error cleanup                                                                                                             | Returned counts mirror the migration dependency; database closes exactly once on success and on rejection. The rejection case is expected to expose the current missing `try/finally`.   |
| `migrate-tracking.test.ts` | Non-dry-run tracking migration of completed and failed entries                                                                                                          | Assert actual database record calls, not just discovered counts. This test must not accept the current TODO/no-op as successful migration.                                               |

## Production Defects Likely Exposed by the Matrix

These are evidence-based exceptions to the tests-only default. Keep any fix minimal and in the
existing modules; do not create a new schema.

1. **Tracking migration is currently a no-op.** `migrateTrackingFiles()` increments counts but has
   an explicit TODO instead of inserting completed/failed sources. A passing test that merely
   asserts those counts would bless data loss. The preferred repair is to reuse the existing legacy
   migration logic from `completed-tracker.ts` through one internal shared function. If making that
   private helper importable is judged too broad, move the logic to an existing migration-focused
   library module rather than duplicating parsers in the action.
2. **Custom history path is discovery-only.** The action discovers `options.historyPath`, then calls
   `migrateLegacyHistory(db)`, which independently reads `getHistoryDir()`. A custom path can be
   reported but not migrated. The smallest coherent fix is an optional history-directory parameter
   on the existing helper, defaulting to its current directory, with the action passing the resolved
   directory.
3. **Database close is not exception-safe.** `executeMigrate()` closes the connection only at the
   normal tail of the function. A rejected discovery or history migration leaks it. Wrap action work
   in `try/finally`; keep summary/result behavior unchanged.
4. **Deletion means discovered, not proven migrated.** With `--delete-old`, tracking files may be
   deleted after the current no-op and history files may be deleted even when a custom-path migration
   read a different directory. Do not assert deletion as safe until the first two defects are fixed
   or explicitly constrain deletion to files with proven successful migration.

If issue #56 is required to remain absolutely tests-only, the first, second, and fourth cases must
be raised as blocking follow-up issues and unsafe success-path assertions must be omitted. The
recommended outcome is to fix these small correctness defects in the same PR because the requested
critical tests directly demonstrate them.

## Architectural Patterns

- **Exported action as integration seam:** Action tests mock lower-level adapters while asserting
  exported results and mutations. No private helper exports are needed.
- **Result-oriented failure containment:** Verify and sync collect per-file/per-source failures;
  migrate collects unlink failures. Tests must prove later work continues where designed.
- **Decision before mutation:** Verify conflict resolution selects `skip`, `overwrite`, `remove`,
  or `keep` before filesystem calls; assertions should connect each decision to the adapter call and
  final unresolved count.
- **Verify after repair:** Both verify actions derive final truth from re-verification, not from a
  successful copy call. Tests must use sequenced mock outcomes.
- **Incremental persistence:** Sync hashes only after materialization and appends inventory before
  reporting a file copied. Existing event-order assertions are the authoritative pattern.
- **Batch-scoped resources:** Verification evidence and sync/migration databases are opened once
  and closed once. Cleanup is part of the action contract, including error paths.

## Gotchas and Edge Cases

- The verify suites' temporary directories do not represent the content under test because most
  filesystem methods are mocked. Do not infer integration coverage from `mkdtemp()` alone.
- `vi.clearAllMocks()` clears calls but retains mock implementations. Several defaults are restored
  manually; a new test that uses `mockResolvedValueOnce()` must leave enough later values for the
  automatic post-fix recheck.
- `pathExists()` is used for source directories, destination directories, and individual files.
  A boolean mock without path-sensitive behavior can accidentally turn a missing-file case into a
  missing-source error or make inventory files appear present.
- Verify fix counters are not authoritative until re-verification. `skip` and refused `rename`
  remain unresolved even when the conflict-resolution record itself reports success.
- Filter flat layout can allocate suffixes for duplicate basenames. Expected paths should be
  asserted from the action's allocated destinations, not reconstructed from source basenames alone.
- Sync records only the first range destination in inventory. This is deliberate one-row-per-source
  semantics; do not expect one inventory row per suffix.
- Sync's `failedCount` derives from `result.failed.length`, while `processedCount` subtracts that
  value from sources scanned. Multiple file failures under one source can make these operation
  counts counterintuitive. The matrix should reveal current behavior before broadening scope.
- `migrateTrackingFiles()` groups solely by hash, so two input basenames with the same hash collapse
  into one operation and the later completed/failed file overwrites the earlier file reference.
  Confirm whether hash uniqueness across input files is a valid legacy invariant before locking it
  into a test.
- Tracking discovery uses the process cwd and offers no path option. Always mock `fast-glob`; never
  run the test against the worktree.
- `migrateLegacyHistory()` skips already-migrated sessions, so discovered session counts and
  actually migrated counts can differ. Assert the helper's returned counts for non-dry-run results.

## Validation Commands

Run under the repository's pinned Node 22 runtime:

```bash
mise exec -- npm run test:run -w packages/rfmedia-cli -- \
  src/actions/verify-album.test.ts \
  src/actions/verify-filter.test.ts \
  src/actions/sync.test.ts \
  src/actions/migrate-tracking.test.ts

mise exec -- npm run test:coverage -w packages/rfmedia-cli -- \
  src/actions/verify-album.test.ts \
  src/actions/verify-filter.test.ts \
  src/actions/sync.test.ts \
  src/actions/migrate-tracking.test.ts \
  --coverage.reporter=text \
  --coverage.include=src/actions/verify-album.ts \
  --coverage.include=src/actions/verify-filter.ts \
  --coverage.include=src/actions/sync.ts \
  --coverage.include=src/actions/migrate-tracking.ts

mise exec -- npm run typecheck -w packages/rfmedia-cli
mise exec -- npm run test:rfmedia
mise exec -- npm run lint:md
```

The focused coverage report should show at least 80% statements and lines for each affected action.
If the critical matrix leaves a file below target, add scenario-dense tables around meaningful
input, mutation, failure, or cleanup contracts; do not export internals or assert decorative logs
solely to move the number.

Current research verification passed:

```text
3 focused test files passed; 47 tests passed.
Affected-action focused line coverage: 52.09% aggregate.
```

## Completion, Template, and Documentation Impact

- Use `.github/pull_request_template.md` without removing sections. `## Testing` must list exact
  focused, coverage, typecheck, full rfmedia, and markdown commands with outcomes.
- Use `Closes #56` under `## Related Issues` so merge closes the issue.
- Update all live #56 references in `ROADMAP.md` from pending/backlog to shipped/completed and keep
  counts/headings consistent. Do not leave one of the sprint, backlog, or cross-cutting rows stale.
- No user-facing README or feature documentation is needed for tests-only behavior. If migration
  correctness changes are included, update the migrate-tracking documentation only where current
  behavior claims migration/deletion or custom-history-path semantics.
- Bash, Zsh, and Fish completion templates require no edits because no command, option, argument,
  or enum changes. Record this audit in the PR; the normal full suite still exercises completion
  parity.
- No database migration, MCP schema, JSON result shape, or package dependency is needed.

## Open Questions

1. Is the issue's 80% target required per action file (recommended interpretation) or as one
   aggregate across the four files? Record the answer in the implementation plan/PR.
2. May the completion PR fix the no-op tracking migration, custom-history-path mismatch, and missing
   close-on-error that critical tests expose, or must those be separately tracked blockers?
3. Is a tracking operation hash globally unique, or only unique for an input basename? If only the
   latter, grouping must use both `inputFile` and `hash` before writing a regression test.
4. Should `--delete-old` delete every discovered legacy file after a partially successful batch,
   or only files proven migrated? The safer contract is per-file proof before deletion.

## Relevant Documentation

- [Issue #56](https://github.com/yandy-r/rfmedia-apps/issues/56)
- `packages/rfmedia-cli/README.md` testing and coverage guidance
- `packages/rfmedia-cli/docs/features/verify-command.doc.md`
- `packages/rfmedia-cli/docs/features/sync-command.doc.md`
- `.github/pull_request_template.md`
- `.github/workflows/rfmedia-cli.yml`
