# Code Analysis: Issue 56 Critical Action Tests

## Executive Summary

Implementation should extend the exported action seams and existing hoisted-mock harnesses, while
fixing only defects directly exposed by critical contracts: observation-backed verification,
classification-aware sync replacement, ordered persistence, durable migration proof, and
proof-gated cleanup.

Line references describe the current dedicated-worktree baseline and will shift during edits.

## Code Structure

| Area                       | Current structure and anchor                                                                                                                               | Implementation consequence                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Album verification         | `actions/verify-album.ts:195-273` builds the expected set, records `missing`, delegates present files to `verifyFileByTier()`, and finds extras            | Extend the exported-action suite; do not retest tier algorithms                                        |
| Album repair               | `actions/verify-album.ts:276-371` stages, validates the open stage, publishes, then verifies the final path; `1025-1135` aggregates and rechecks the batch | Success must come from final observation, not a copy call                                              |
| Filter verification        | `actions/verify-filter.ts:150-195` carries source, allocated destination, and display path into `verifyTask()`                                             | Missing repair must preserve the allocated path, including structured/ranged layouts                   |
| Filter repair              | `actions/verify-filter.ts:384-528` groups issues and validates staged copy/conversion                                                                      | Extend the existing filter harness; keep its layout-specific setup separate                            |
| Sync file path             | `actions/sync.ts:193-345` builds suffix destinations, skips existing output, materializes, hashes, and appends inventory                                   | Carry new/updated classification into the existence decision; preserve one inventory record per source |
| Sync aggregation           | `actions/sync.ts:507-548` currently combines new and updated files, then infers classification with `includes()`                                           | Use an explicit local work item or overwrite-intent parameter rather than global `force`               |
| Sync lifecycle             | `actions/sync.ts:687-770` selects database/legacy inventory; `838-990` contains failures, gates scan, updates operation state, and closes                  | Add lifecycle and scan tests through `executeSyncWithFileInput()`                                      |
| Migration action           | `actions/migrate-tracking.ts:48-150` opens DB, routes domains, confirms cleanup, and returns `MigrateResult`                                               | Put exception-safe close around all non-dry-run work and derive cleanup from proof                     |
| Tracking migration defect  | `actions/migrate-tracking.ts:164-206` counts groups but has no persistence call                                                                            | Replace with a reusable library importer; tests must reject count-only success                         |
| History path defect        | `actions/migrate-tracking.ts:216-260` discovers from `historyPath`, but calls `migrateLegacyHistory(db)` without it                                        | Resolve one directory and pass it through discovery and import                                         |
| Cleanup defect             | `actions/migrate-tracking.ts:99-135` builds deletion candidates from every discovered file                                                                 | Delete only individually imported/already-equivalent files                                             |
| Existing tracking importer | `lib/completed-tracker.ts:691-740` parses, normalizes, and records completed/failed paths; `753-782` invokes it during automatic initialization            | Promote or wrap this owner; do not duplicate parser/DB writes in the action                            |
| Existing history importer  | `lib/history.ts:804-890` imports JSONL sessions and operations from `getHistoryDir()`                                                                      | Add an optional directory and return per-file proof needed by cleanup                                  |
| Public result contracts    | `types/results.ts:126-182`, `types/inventory.ts:103-132`, and `types/results.ts:239-283`                                                                   | Keep structured counters/failures authoritative; add proof types only at the internal seam if possible |

**Confidence**: High. Anchors were verified against the current source.

## Implementation Patterns

### Exported actions are the test seams

Drive these functions:

- `executeAlbumVerify()` and `executeAlbumVerifyWithFileInput()`;
- `executeFilterVerify()` and `executeFilterVerifyWithFileInput()`;
- `executeSyncWithFileInput()`;
- `executeMigrate()`.

Mock imported boundaries and assert returned result plus durable/observable effects. Keep
`repairContentArtifact()`, `fixFilteredTracks()`, `syncFile()`, discovery/grouping, and deletion
helpers private. Vitest same-file calls cannot be replaced by mocking an exported alias, and adding
test-only exports would couple tests to implementation.

### Verification is observe, repair, re-observe

Follow `verify-album.ts:310-371`: materialize into a private stage, validate via
`createOpenFileVerificationTarget()` and `verifyFileByTier()`, publish through
`replaceFileWithValidatedStage()`, then verify the final destination. The filter action should
retain the same stage-before-publish safety and participate in the action-level final recheck.

Tests should assert:

- the original issue has `status: "missing"` and exact `sourcePath`/relative `path`;
- a passing stage and final recheck increment `copiedFiles`, `repairedFiles`, and
  `reverifiedFiles`, then clear `remainingIssues`;
- failed materialization/stage/final verification remains in `failedFixes` and unresolved counts;
- `fix: false` and dry-run perform no mutation.

### Sync carries classification and commits success last

The current `syncFile()` skip at `sync.ts:267-272` cannot distinguish updated work. Pass explicit
updated intent from both album and filter loops; bypass the existence skip only for an inventory-
classified update. Do not set `options.force`, because that would overwrite unrelated new-file
collisions.

Preserve the existing ordering at `sync.ts:294-333`:

```text
materialize final destination
  -> calculateHash(final destination)
  -> createFileInventoryEntry(..., contentHash)
  -> appendFileRecord(...)
  -> aggregate new/updated success
```

`sync.test.ts:169-224` already proves this with semantic events. Reuse that pattern for update and
failure scenarios. Any copy, conversion, hash, entry, or append failure must return a
`SyncFailedOperation` and prevent success counting while later independent sources continue.

### Migration exposes proof to cleanup

Add one library-owned tracking import seam near `completed-tracker.ts:691` that accepts the database,
input identity, options hash, and optional completed/failed paths. It should create/find the
operation using `(inputFile, optionsHash, mode)`, record normalized sources, and return counts plus
the exact source files proven imported or already equivalent. Infer/validate `mode` from the
formatted hash prefix (`album-...` or `filter-...`); retain unsupported/malformed groups rather than
guessing.

Extend `migrateLegacyHistory()` with an optional directory defaulting to `getHistoryDir()` and
return per-file imported/already-present/failed proof. Validate a history session sufficiently
before making it cleanup-eligible; a skipped malformed operation cannot silently yield a
fully-proven file.

`executeMigrate()` should union only proven paths, apply confirmation/force to that list, and collect
per-unlink failures. Discovery metadata may remain in the user result, but it is not deletion
authority.

### Resources close in `finally`

Mirror `sync.ts:961-990`: the action that calls `initializeDatabase()` owns exactly one
`closeDatabase()` in `finally`. Dry-run never initializes SQLite. Contained import/deletion failures
may return in `MigrateResult.errors`; action-wide initialization/import failures may reject after
closing.

**Confidence**: High for the action and ordering patterns; Medium for the precise internal proof
type because it does not yet exist.

## Integration Points

- Commander delegates verification at `commands/verify.ts:708-713`, sync at
  `commands/sync.ts:418-419`, and migration at `commands/migrate.ts:82-83`. No command change is
  required.
- The MCP sync adapter delegates at `mcp/adapters.ts:503-527`. Keeping the action signature stable
  preserves MCP behavior; do not duplicate action scenarios in adapter tests.
- Read-only verification evidence uses `lib/db.ts:getInventoryFingerprintCandidates()` at line 842
  and `lib/tiered-verification.ts`; action tests mock these boundaries.
- Sync diff ownership remains in `lib/inventory.ts:computeAlbumSyncDiff()` and
  `computeFilterSyncDiff()`. Tests supply small diff fixtures rather than reconstruct mtime/rating
  algorithms.
- Mutation primitives remain in `lib/filesystem.ts`: `cleanupPartialFile()` at line 773,
  `replaceFileWithValidatedStage()` at 905, `pathExists()` at 1140, and `remove()` at 1193.
- Database operation APIs are `lib/db.ts:createOperation()` at 166, `recordCompleted()` at 296,
  `recordFailed()` at 339, operation status/count updates at 198/216, and `closeDatabase()` at 1912.
- Manual migration behavior documented at `packages/rfmedia-cli/README.md:3160-3235` must match
  durable import and successful-only cleanup after the fix.

**Confidence**: High.

## Files to Create or Modify

### Create

- `packages/rfmedia-cli/src/actions/migrate-tracking.test.ts` — action routing, dry-run, identity,
  history path, proof-gated cleanup, partial unlink, and close-on-error.

### Modify

- `packages/rfmedia-cli/src/actions/verify-album.test.ts` — missing detection, successful repair,
  failed recheck, and one batch/range lifecycle case.
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts` — eligibility-aware missing mapping,
  flat/structured repair, failed recheck, and one batch lifecycle case.
- `packages/rfmedia-cli/src/actions/sync.test.ts` — classification, continuation, downgrade,
  DB/legacy lifecycle, dry-run, and scan gating.
- `packages/rfmedia-cli/src/actions/sync.ts` — classification-aware updated overwrite and any
  directly proven operation-count fix.
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts` — durable import orchestration, composite
  identity, same history root, proof-filtered cleanup, and `finally` close.
- `packages/rfmedia-cli/src/lib/completed-tracker.ts` and its test — reusable tracking importer and
  durable/equivalence proof.
- `packages/rfmedia-cli/src/lib/history.ts` and its test — optional directory, validation, and
  per-file import/equivalence proof.
- `packages/rfmedia-cli/README.md` — correct migration details if current text overstates behavior.
- `ROADMAP.md` — remove all live #56 entries and record completion.

### Conditional only

- `packages/rfmedia-cli/src/types/results.ts` — only if the public `MigrateResult` must expose
  contained import failures; prefer an internal library proof type when public compatibility does
  not require a new field.

Do not modify `commands/`, MCP schemas/adapters, `schema.sql`, migrations, package dependencies,
Vitest global thresholds, or Bash/Zsh/Fish templates. Audit completion parity as unchanged.

**Confidence**: High. This matches the accepted feature scope.

## Conventions and Available Utilities

- TypeScript is strict ESM: use `node:` built-ins and `.js` on repository imports.
- Define ESM factory mocks with `vi.hoisted()` as in `sync.test.ts:7-102` and both verify suites.
- Use `vi.clearAllMocks()` and restore deliberate defaults in `beforeEach`; use
  `vi.restoreAllMocks()` for spies. Avoid blanket `vi.resetAllMocks()`.
- Partially mock `node:fs/promises` with `importOriginal` so real temp helpers remain available.
- Keep action parallelism deterministic with the existing sequential `processInParallel` mocks;
  set `workers: 1` in options.
- Reuse `src/test-utils/filesystem.ts:createTempTestDir()` (line 8), `cleanupTempDir()` (15), and
  `createTestFile()` (22) only where real paths/SQLite matter.
- Use a local `emptyDiff()` and typed option builders in `sync.test.ts`; keep migration's virtual
  file map local to its new suite. Do not add a generic filesystem or scenario framework.
- Available dependencies already cover the work: Vitest 4, V8 coverage, Node 22 filesystem APIs,
  `fast-glob`, and `better-sqlite3`. No package change is needed.
- Assert structured result fields, exact paths/codes, durable rows, prohibited side effects, and
  semantic ordering. Avoid full log snapshots, spinner text, and private call graphs.

**Confidence**: High.

## Database, API, and UI Guidance

### Database

No schema change is required. Existing tables in `lib/schema.sql` are sufficient:

- `operations` at line 8;
- `completed_sources` at 31;
- `failed_sources` at 44;
- `inventory` at 58;
- `history_sessions` at 110;
- `history_operations` at 127.

Tracking operation identity must include `input_file` and `options_hash`; do not group only by hash.
Use existing prepared DB APIs rather than SQL in the action. Add real temporary-SQLite read-back at
the library importer boundary; keep action tests on opaque DB mocks except for one durability seam
if public APIs cannot otherwise prove equivalence.

### API

No HTTP API exists here and no CLI/MCP surface changes. Keep exported action inputs/results
compatible. Any new migration proof contract should be an internal TypeScript return type between
the library and action.

### UI

N/A beyond CLI feedback. Human logger/table/prompt rendering is not the action contract. Tests may
assert a warning occurs when notification itself matters, but should prioritize typed results,
prompt absence in machine/dry-run paths, and exact mutation decisions.

**Confidence**: High.

## Gotchas

1. `sync.ts:267-272` skips updated existing destinations unless force is set; fixing this with
   global force would regress new-collision safety.
2. `sync.ts:315` increments per-suffix `created` before hashing/inventory. The outer action currently
   counts only when `syncFile()` succeeds, so preserve that containment and test range failures.
3. `sync.ts:971-980` derives completed source count from `result.failed.length`, which counts file
   failures, not failed sources. Multiple file failures can make source lifecycle counts wrong;
   cover the exact operation-count contract before changing it.
4. `migrate-tracking.ts:198-202` reports migrated operations/sources without writing SQLite.
5. `migrate-tracking.ts:464-480` groups by hash and overwrites same-type files from different input
   basenames; key by input plus hash.
6. `migrate-tracking.ts:102-105` deletes the discovery list, including malformed/unpersisted files.
7. `migrate-tracking.ts:137-140` closes only on the normal path; thrown discovery/import errors leak
   the connection.
8. `migrate-tracking.ts:227-253` discovers a custom history directory but the importer defaults to
   the home history directory.
9. `countTrackingFileEntries()` at `migrate-tracking.ts:427-434` converts read failure into zero;
   zero is not durable success and must not enable cleanup.
10. `history.ts:858-876` skips malformed operations after creating the session. Partial import must
    not mark the whole legacy file cleanup-safe without an explicit equivalence policy.
11. Real `fast-glob` defaults tracking discovery to `process.cwd()`; action tests must mock it or
    inject a controlled root so cleanup never touches worktree artifacts.
12. Existing verify suites already cover mismatch/extra strategies, force, trash, interactive,
    non-interactive, dry-run, and staged failure. Repeating those permutations is filler.
13. `vi.clearAllMocks()` preserves queued implementations; re-establish defaults explicitly so
    test-specific responses do not leak.
14. `better-sqlite3` is native and tied to Node ABI. Run through `mise exec` with the pinned Node 22
    runtime.

**Confidence**: High. Each gotcha is present in current source or repository test guidance.

## Verification

```bash
mise exec -- npm run test:run --workspace packages/rfmedia-cli -- \
  src/actions/verify-album.test.ts \
  src/actions/verify-filter.test.ts \
  src/actions/sync.test.ts \
  src/actions/migrate-tracking.test.ts

mise exec -- npm run test:coverage --workspace packages/rfmedia-cli -- \
  src/actions/verify-album.test.ts \
  src/actions/verify-filter.test.ts \
  src/actions/sync.test.ts \
  src/actions/migrate-tracking.test.ts

mise exec -- npm run typecheck --workspace packages/rfmedia-cli
mise exec -- npm run test:run --workspace packages/rfmedia-cli
git diff --check
```

Inspect statements and lines for each named action; the current `vitest.config.ts:11-18` uses V8
coverage but has no per-file threshold. Then run repository hooks and registered CI. Completion
templates should remain unchanged and parity tests should pass.

**Confidence**: High.
