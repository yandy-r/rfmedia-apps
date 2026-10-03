# Engineering Practices: Issue #56 Action Tests

## Executive Summary

Extend the three co-located action suites and add one `migrate-tracking.test.ts`; do not build a
new test framework. The verify suites already own broad, deterministic conflict harnesses, while
the sync suite already pins the critical materialize -> hash -> inventory ordering. The remaining
value is a small contract matrix for missing-file repair, ordinary sync orchestration, and durable
legacy migration/deletion safety.

Tests should drive exported action entry points and assert public result objects plus filesystem,
database, inventory, and cleanup boundaries. Do not export private helpers for coverage, assert log
wording, duplicate lower-level algorithms, or add a repository-wide coverage threshold.

## Existing Reusable Code

| Existing code                                                                                     | Reuse                                                                                                                            | Constraint                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/actions/verify-album.test.ts#createVerifyOptions` and its hoisted mocks                      | Extend the current conflict, staged replacement, tier evidence, sequential parallel-runner, input, database, and abort harness.  | Keep its real temporary directories only for isolation; behaviorally important I/O remains mocked.                            |
| `src/actions/verify-filter.test.ts#createVerifyOptions` and its hoisted mocks                     | Extend the existing rating, layout, conversion, tier, conflict, evidence, and batch harness.                                     | Album and filter destination semantics differ enough from verify-album that a shared harness would obscure intent.            |
| `src/actions/sync.test.ts#createOptions` and `mocks`                                              | Add stable spies for the inventory/database/input/delete/scan boundaries and reuse the existing destination fingerprint fixture. | `vi.clearAllMocks()` preserves the deliberate mock implementations; avoid a blanket `resetAllMocks()`.                        |
| `src/test-utils/mock-lifecycle.ts#clearMocksPreservingImplementations`                            | Named precedent for clearing call history while retaining hoisted ESM mock defaults.                                             | Importing it is optional; changing mature suites solely to adopt it is unrelated churn.                                       |
| `src/test-utils/filesystem.ts`                                                                    | Reuse only if a test needs real isolated files.                                                                                  | Migration discovery should use a virtual filesystem; a real `fast-glob` from `process.cwd()` can capture developer artifacts. |
| `src/lib/tiered-verification.ts#verifyFileByTier`                                                 | Mock explicit `present`, `missing`, and mismatch outcomes at the action boundary.                                                | Its hashing/byte/metadata algorithms already belong to `tiered-verification.test.ts`; do not retest them here.                |
| `src/lib/inventory.ts#computeAlbumSyncDiff` and `computeFilterSyncDiff`                           | Return small `SyncDiff` fixtures to test action routing and aggregation.                                                         | Diff classification is already a library responsibility; action tests should not reconstruct its mtime/rating logic.          |
| `src/lib/completed-tracker.ts#initializeTracking` and private `migrateLegacyTracking`             | Reuse the existing parse/normalize/database-record behavior when making manual migration durable.                                | Do not copy this private algorithm into the action or write tests that bless count-only migration.                            |
| `src/lib/history.ts#migrateLegacyHistory`                                                         | Preserve the single history-import owner and test the action's routing to it.                                                    | It currently always calls `getHistoryDir()`; `MigrateOptions.historyPath` affects discovery but not import.                   |
| `src/lib/db.ts` action mocks used by `playlist.test.ts`, `plex-query.test.ts`, and `sync.test.ts` | Use an opaque connection and assert initialize/operation/status/close calls without a real native database.                      | Real SQLite integration belongs in existing database/library suites, not every action scenario.                               |

## Modularity Design

Keep the production boundary and the test boundary aligned:

```text
exported action entry point
  -> mocked orchestration dependencies
     -> public result and mutation/lifecycle assertions
```

- Verify through `executeAlbumVerify()`, `executeAlbumVerifyWithFileInput()`,
  `executeFilterVerify()`, and `executeFilterVerifyWithFileInput()`. Private task construction and
  repair functions remain implementation details.
- Sync through `executeSyncWithFileInput()`. Mock diff computation and inventory persistence, but
  let `syncFile()` execute indirectly so destination handling, write ordering, and counters are
  covered together.
- Migrate through `executeMigrate()`. Mock `fast-glob`, selected `node:fs/promises` functions,
  database setup, history migration, confirmation, and path resolution. Do not expose
  `discoverLegacyTrackingFiles()`, `groupTrackingFilesByOperation()`, or `deleteLegacyFiles()` just
  to call them directly.
- If migration tests expose the known no-op, share the existing migration behavior through one
  library-owned seam. The action should orchestrate discovery, import, and deletion eligibility;
  it should not become a second parser/database writer.

## Shared vs Feature-Specific

Shared test conventions are `vi.hoisted()` ESM mocks, deterministic sequential replacements for
`processInParallel()`, POSIX absolute fixture paths, public result assertions, and explicit cleanup
checks. These are conventions, not justification for a new helper module.

Keep feature-specific:

- album suffix expansion and artist/album destination paths;
- filter eligibility, collision allocation, structure preservation, and conversion paths;
- sync diff fixtures, inventory lifecycle, downgraded deletion, and scan capability;
- tracking filename/content fixtures, history headers, migration proof, and deletion eligibility.

The two verify suites repeat some mock declarations, but their task layouts, evidence ownership,
and repair semantics differ. The sync and migration suites share even less. Extraction would add
indirection without a stable common contract.

## KISS and Rule-of-Three Choices

- Add only the scenarios that protect data correctness, authorized mutation, resumability, and
  truthful counters. Do not multiply equivalent ranges, ratings, suffix counts, or log variants.
- Retain the existing verify conflict cases; they already cover skip/overwrite, keep/remove,
  interactive apply-to-all, force, trash, dry-run, rename refusal, and failed staged validation.
- Use small local builders such as `emptyDiff()` and mode-specific option factories in
  `sync.test.ts`; two or three lines of local fixture setup are clearer than a generic scenario DSL.
- Use one local virtual-file map in `migrate-tracking.test.ts`. Do not add a reusable in-memory
  filesystem package or a repository-wide filesystem mock.
- Apply rule-of-three to behavior owners, not incidental test syntax. Tracking parsing already
  exists in `completed-tracker.ts` and again in `migrate-tracking.ts`; a repair would be the third
  copy, so consolidate production migration logic before adding another parser. Test harness
  repetition across two semantically different verify suites is not the same abstraction signal.
- Keep the issue's 80% target as a focused measurement for the four actions. Do not modify
  `vitest.config.ts` to impose a global threshold or write inert branch tests to chase the number.

## Testable Seams and Anti-Patterns

### Verify

Drive tier outcomes with `verifyFileByTier`; drive extras with `findExtraFiles`; drive mutations
through `replaceFileWithValidatedStage`, `copyOrLink`, `remove`, and `moveToTrash`. For batch tests,
control `readSourcePaths`, `normalizePathResolved`, the read-only evidence database, and abort
registration. Assert exact issue paths, counters, repair counters, database close, and cleanup
unregistration. Do not assert spinner/logger text or call the tier verifier's internal algorithms.

### Sync

Drive classification with `computeAlbumSyncDiff`/`computeFilterSyncDiff`. Observe
`appendSourceRecord`, `copyOrLink`/`convertFile`, `calculateHash`,
`createFileInventoryEntry`, `appendFileRecord`, `remove`, and the database lifecycle. Preserve the
existing ordering assertion: destination materialization precedes hashing, which precedes inventory
persistence. A critical updated-file fixture must return an existing destination with `force:
false`; it should prove that an item classified as updated is replaced rather than silently skipped.

### Migrate tracking

Have `fast-glob` return explicit absolute sidecar paths. Partially mock `node:fs/promises` so
`readFile`, `readdir`, and `unlink` are controlled; use simple directory-entry objects for history.
Assert import calls/records and returned counts before allowing deletion assertions. A test that
only observes `operations` and `sources` would encode the current false-success behavior. Also pin
database close on both success and rejection and prove that `historyPath` reaches the importer, not
only discovery.

Anti-patterns:

- exporting private production helpers or adding test-only options;
- mocking the action under test or asserting its private call graph;
- using the real working tree, home history directory, trash, SQLite database, or media scanner;
- snapshots of large result/log objects when a few exact contract assertions suffice;
- treating attempted copies/deletes or discovered line counts as successful durable work;
- duplicating `inventory.ts`, `tiered-verification.ts`, or `history.ts` unit coverage in action tests.

## Minimal Critical Test Matrix

| Suite                      | Minimum new contract                                                                                                                                                    | Why it earns its place                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `verify-album.test.ts`     | One dense no-fix case with present, missing, mismatch, and extra artifacts; one missing repair whose recheck becomes present.                                           | Covers the issue's detection states and proves that final fix counters come from observation, not an attempted copy. |
| `verify-album.test.ts`     | One `executeAlbumVerifyWithFileInput()` case proving CLI > per-path > config range precedence, contained source failure, one evidence preload/close, and abort cleanup. | Covers the exported batch boundary once without repeating conflict permutations.                                     |
| `verify-filter.test.ts`    | One dense eligibility case with eligible-present, eligible-missing, filtered-out, and extra; one missing repair table for flat and preserve-structure destinations.     | Proves selection and exact destination mapping while avoiding a full layout cross-product.                           |
| `verify-filter.test.ts`    | One batch case with a successful and failed source, range precedence, canonical paths, shared evidence, and cleanup.                                                    | Pins the multi-source boundary and failure containment.                                                              |
| `sync.test.ts`             | One album diff containing new, updated, and unchanged files; the updated destination already exists.                                                                    | Pins truthful classification and exposes the current generic existing-destination skip risk.                         |
| `sync.test.ts`             | Existing destination with `force` false/true; missing source followed by valid source.                                                                                  | Proves overwrite policy and per-source continuation with exact `ENOENT` failure data.                                |
| `sync.test.ts`             | Filter downgrade table: deletion disabled, already absent, success, failure, and dry-run.                                                                               | Covers destructive policy with one compact table.                                                                    |
| `sync.test.ts`             | Database success/partial lifecycle and scan gating for changed, unchanged/failed, and dry-run runs.                                                                     | Proves durable operation status, close/unregister behavior, and external side-effect gating.                         |
| `migrate-tracking.test.ts` | Dry-run discovery with completed/failed pairs, comments/blanks, invalid names, and two input basenames sharing one hash.                                                | Pins parsing/counting and catches hash-only grouping collisions without database mutation.                           |
| `migrate-tracking.test.ts` | Non-dry-run tracking import plus history import from an explicit path; assert durable import calls/records and returned counts.                                         | Refuses the current count-only TODO and discovery/import path mismatch.                                              |
| `migrate-tracking.test.ts` | Routing for `trackingOnly`/`historyOnly`; deletion table for decline/confirm/force/dry-run; partial unlink failure.                                                     | Covers option gates and ensures cleanup is confirmed, selective, and failure-tolerant.                               |
| `migrate-tracking.test.ts` | Import rejection closes the database and retains every unproven legacy file.                                                                                            | Protects the highest-risk resource leak and data-loss boundary.                                                      |

## Build vs Depend

| Concern              | Decision                                                                                | Rationale                                                                             |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Test runner/mocking  | Reuse Vitest 4 and native `vi.hoisted()` mocks.                                         | Already configured for Node/ESM and used by all target suites.                        |
| Filesystem isolation | Build tiny local fixtures with existing temp helpers or a virtual path map.             | `memfs`/mock-fs would add a dependency for a narrow orchestration test.               |
| Concurrency          | Reuse the existing sequential `processInParallel` mock.                                 | Scheduler behavior is out of scope; deterministic action aggregation is the contract. |
| Database             | Mock action boundaries; reuse existing real-DB library tests for persistence internals. | Avoids native SQLite coupling and keeps failures attributable to the action.          |
| Coverage             | Use the existing V8 provider with focused file inclusion.                               | No new dependency or global threshold is needed.                                      |
| Shared fixtures      | Keep local builders until a third suite needs the same domain fixture.                  | Current similarities are superficial and feature semantics differ.                    |

## Overengineering and Regression Risks

- A shared verify harness could destabilize 41 existing tests while contributing no new contract.
- Replacing all mock implementations during lifecycle cleanup can make later tests order-dependent.
- Real globbing can discover and delete workspace files if a cleanup test is misconfigured.
- Count-only migration tests can make a data-loss implementation appear correct.
- Broad force/existence changes in `syncFile()` can fix updated files while overwriting unrelated new
  destinations; the action needs classification-aware intent, not a global bypass.
- Deleting the discovery list rather than a proven-migrated list can erase malformed, collided, or
  failed legacy inputs.

## Open Questions

- What database-owned API should manual tracking migration call so operation identity includes
  both input basename and options hash without exposing the existing private helper?
- Should malformed discovery/import errors remain warnings or be added to `MigrateResult.errors`?
  Regardless, their files must remain deletion-ineligible.
- Should focused 80% coverage be enforced in a one-off verification command or a checked-in scoped
  threshold? Prefer the command unless maintainers explicitly want a permanent per-file gate.
