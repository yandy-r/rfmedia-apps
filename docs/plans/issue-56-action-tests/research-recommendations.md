# Issue 56 Action-Test Recommendations

## Executive Summary

Implement issue #56 as a focused contract-testing change, not a new test framework or a broad
coverage exercise. Extend the existing `verify-album`, `verify-filter`, and `sync` suites, add one
`migrate-tracking.test.ts`, and test exported action entry points with mocked filesystem, inventory,
database, prompt, and scan boundaries. Preserve the existing 41-test verify conflict matrix and the
sync fingerprint-ordering tests; they already cover most mismatch, extra-file, strategy, dry-run,
and staged-repair behavior.

The same PR should fix migration correctness defects exposed by the critical tests. The current
manual tracking migration reports success without writing records, custom `historyPath` is used for
discovery but not import, database close is not exception-safe, and `deleteOld` can unlink every
discovered file without proof of durable migration. Landing tests that accept those behaviors would
codify false success and a direct data-loss path. Keep the fixes narrow, reuse the existing tracking
and history migration owners, and make deletion eligibility derive from successful import rather
than discovery.

Interpret the issue's 80% target as at least 80% statements and lines for each of the four named
action modules, measured with focused V8 inclusion. Reach it through scenario-dense contract tests,
not log assertions, private-helper exports, branch tours, duplicated layout matrices, or a new
repository-wide threshold. The behavioral acceptance oracle remains protection against false
completeness, unauthorized mutation, lost resumability, and unsafe cleanup.

## Implementation Recommendations

### 1. Preserve and extend the existing action harnesses

- Add tests in `verify-album.test.ts`, `verify-filter.test.ts`, and `sync.test.ts`; create only
  `migrate-tracking.test.ts`.
- Drive `executeAlbumVerify*`, `executeFilterVerify*`, `executeSyncWithFileInput()`, and
  `executeMigrate()`. Do not export same-file private helpers for testing.
- Continue using hoisted Vitest boundary mocks and the existing deterministic sequential parallel
  runner. Restore deliberate defaults in `beforeEach()`; do not replace the suites' lifecycle with
  blanket `resetAllMocks()` calls.
- Assert public results and observable mutation, persistence, ordering, and cleanup boundaries.
  Avoid logger/spinner prose and lower-level tier, inventory-diff, parser, or SQLite algorithms.
- Add no dependency. Native temporary paths plus narrow Vitest mocks cover the required behavior;
  migration globbing and deletion must remain mocked so tests cannot discover or remove workspace
  artifacts.

### 2. Add only the missing verification contracts

For album verification, add one dense no-fix case containing present, missing, size-mismatched, and
extra artifacts, then one missing repair that becomes present only after staged re-verification.
Include a failed repair/recheck assertion in the same scenario family so an attempted copy cannot
be counted as repaired. Add one batch-boundary case only if needed for coverage: it should prove
range precedence, contained source failure, one evidence preload/close, and abort cleanup.

For filter verification, add one eligibility case containing eligible-present, eligible-missing,
filtered-out, and extra files. Add a compact two-row missing-repair table for flat and one
structure-preserving ranged or converted destination. Assert the exact precomputed source and
destination mapping and that failed re-verification remains unresolved. Do not repeat the existing
conflict-strategy or layout cross-products.

### 3. Cover sync orchestration and fix only demonstrated defects

- Use mocked `computeAlbumSyncDiff()` / `computeFilterSyncDiff()` results rather than retesting diff
  algorithms.
- Add one album diff with new, updated, and unchanged files. The updated file's destination must
  already exist; it must be replaced and persisted as updated. The current generic
  `!force && pathExists(destPath)` guard is likely to skip it, so make overwrite intent
  classification-aware instead of broadly forcing every destination.
- Prove a missing source yields structured `ENOENT` data and does not prevent a later valid source.
- Cover downgrade cleanup with a compact table: disabled, destination already absent, success,
  failure, and dry-run. Assert that dry-run computes counts without removal.
- Treat inventory `destPath` values as untrusted claims before downgrade cleanup. Canonicalize the
  selected destination once, require component-aware containment, reject symlinked parents and
  non-regular leaves, and use non-recursive deletion. Add real temporary-root cases for `../`, an
  absolute outside-root path, a symlinked parent, and a directory substituted for the expected
  file. `force` must not bypass these checks.
- Preserve and build on the existing semantic ordering assertion:
  `materialize -> hash final destination -> append inventory -> count success`. Hash or inventory
  failure must not advance success, and later work must continue.
- Cover database success/partial status, close/unregister behavior, legacy-vs-database routing, and
  scan gating. A scan is allowed only after a real successful change, never for unchanged-only,
  failed-only, or dry-run execution.

If the updated-existing test exposes the current skip defect, fix it in this PR because truthful
updated-file reconciliation is part of the issue's critical sync contract. Do not broaden the fix
to removed-source policy or redesign the one-inventory-row-per-source model.

### 4. Repair migration safety before asserting success or deletion

Implement these minimal production corrections with their action tests:

1. Move or expose one library-owned legacy tracking import seam derived from the existing private
   `completed-tracker.ts` migrator. It must create/find the operation using both input basename and
   options hash, then record completed and failed sources. Do not copy the parser/database writer
   into the action.
2. Group sidecars by `(inputFile, hash)`, not hash alone, so different input lists with identical
   options do not collide.
3. Let `migrateLegacyHistory()` accept an optional directory that defaults to `getHistoryDir()`,
   and pass the resolved `historyPath` from the action.
4. Validate a complete history session before mutation, import it transactionally, and distinguish
   `imported`, `already-equivalent`, and `failed`. A valid header plus malformed operation, or an
   existing non-equivalent session, must remain deletion-ineligible.
5. Make database cleanup exception-safe with `try/finally`; close exactly once after initialization
   on success or failure.
6. Track migration eligibility per legacy file or operation group. `deleteOld` may include only
   files whose equivalent records were durably imported or already proven present. Malformed,
   collided, failed, or unproven files remain on disk. `force` bypasses confirmation only; it never
   bypasses migration proof.
7. Bind discovery and cleanup to one canonical root, disable symlink traversal, and revalidate each
   candidate as the same contained regular file immediately before non-recursive unlink. Derive the
   root from the captured working directory for now; adding a new CLI option is unnecessary.

The migration action suite should prove preview discovery, durable non-dry-run import, identity
isolation, custom history routing, domain flags, confirmation/force behavior, selective cleanup,
partial unlink failure, and close-on-error. Assert importer outcomes before deletion; counts of
parsed lines are insufficient evidence. Add a focused library integration test with a real temporary
SQLite database for transaction and read-back equivalence, while action scenarios mock that proven
library seam. This keeps persistence fidelity in its owner without coupling every action case to
native SQLite.

### 5. Treat coverage as a measured constraint, not test design input

Run focused behavioral tests first, then a V8 report with only the four action modules included.
Require at least 80% statements and lines per file, not merely 80% aggregate. If a file remains
below target, inspect uncovered branches and add only tests for a distinct input partition, mutation
policy, failure boundary, or lifecycle guarantee. Do not add assertions-free invocations, test
decorative output, expose internals, duplicate rating/range/codec permutations, or change the
global Vitest configuration. Record the per-file results in the PR.

## Improvement Ideas

- Add small local builders such as `emptyDiff()`, mode-specific option factories, and a virtual
  legacy-file map when repeated setup obscures the scenario. Keep them inside their owning suite.
- Return explicit migration proof from the shared importer, including migrated counts and eligible
  file paths. This makes cleanup authorization structural rather than inferred from summary counts.
- Use semantic event arrays for sync and migration ordering. They produce clearer failures than
  cross-mock invocation indices.
- Surface malformed/import failures through stable structured paths and codes in
  `MigrateResult.errors` where possible. Human-readable logs can remain supplemental.
- Update migrate-tracking feature documentation only for corrected durability, cleanup, or custom
  path behavior. No README, completion template, dependency, MCP schema, or database migration
  change is warranted.

## Risk Assessment

| Risk                                                                         | Severity | Mitigation                                                                                                                             |
| ---------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Count-only migration followed by cleanup deletes the only resumability state | Critical | Do not permit deletion until durable import is proven; test retained files on every import failure.                                    |
| Hash-only grouping merges unrelated input lists                              | High     | Key operation groups by input basename plus options hash and cover equal-hash inputs.                                                  |
| Custom history discovery and default-path import disagree                    | High     | Pass the resolved directory into the single history importer and test the exact path.                                                  |
| Updated sync entries are silently skipped because their destination exists   | High     | Carry classification-aware replacement intent into `syncFile()` and test an existing updated destination.                              |
| Corrupt inventory can direct downgrade cleanup outside the destination       | Critical | Validate record shape and canonical containment; reject symlinks/non-files and test outside-root sentinels with a real temporary tree. |
| Partially parsed history can be reported migrated and fully deleted          | Critical | Validate then transact a whole session; require committed read-back equivalence before cleanup.                                        |
| Database/resource cleanup leaks on thrown migration work                     | Medium   | Use `try/finally` and assert one close on success and rejection.                                                                       |
| Mock defaults leak between tests                                             | Medium   | Re-establish scenario defaults in `beforeEach()` and run the full package suite after focused tests.                                   |
| Real glob/delete operations touch developer files                            | Critical | Mock `fast-glob`, `readFile`, `readdir`, and `unlink`; never scan the worktree in migration tests.                                     |
| Coverage chasing creates brittle filler                                      | Medium   | Measure per file after contract tests and admit only distinct behavioral partitions.                                                   |
| Shared verify harness refactor destabilizes mature tests                     | Medium   | Extend each existing suite locally; defer abstraction until a stable third consumer exists.                                            |

## Alternative Approaches

### Tests only, defer production defects

Not recommended. It either leaves required migration success tests failing or forces tests to bless
false counters and unsafe deletion. If scope is externally constrained to tests only, omit
non-dry-run success/deletion assertions and open blocking follow-ups for all four migration defects;
do not mark issue #56 complete.

### Broad integration tests with real filesystem and SQLite

Use real persistence only in the library suites that own parsing and database behavior. At the
action layer it increases native/runtime coupling and makes destructive failures hard to inject.
The recommended hybrid boundary tests give deterministic path, ordering, and lifecycle coverage
without risking real state.

### New shared test framework or fake-filesystem dependency

Reject. The verify harnesses have different layout and evidence semantics, while sync and migration
share little beyond Vitest conventions. Local fixtures are smaller and more diagnostic.

### Global 80% coverage threshold

Reject for this issue. A repository-wide threshold expands scope to unrelated modules and can
encourage filler. Use a focused include command and publish the four per-file measurements.

### Separate migration-fix PR

Acceptable only if release policy requires isolation, but issue #56 must then remain open until the
fix lands and the action tests prove it. The preferred single PR keeps each exposed defect adjacent
to its regression test and avoids a window where cleanup remains unsafe.

## Task Breakdown Preview

### Phase 1: Baseline and harness extension

1. Run the three existing focused suites and capture current per-file coverage.
2. Extend the existing hoisted mocks only for the new observable boundaries; add no shared helper
   module or dependency.

### Phase 2: Verification contracts

3. Add album dense detection, missing repair/recheck, and only the necessary batch lifecycle case.
4. Add filter eligibility, flat/structured missing repair, failure persistence, and only the
   necessary batch lifecycle case.

### Phase 3: Sync contracts and narrow repair

5. Add new/updated/unchanged aggregation with an existing updated destination, then make the
   smallest classification-aware replacement fix if the test fails.
6. Add missing-source continuation, downgrade policy/failure and containment, database/legacy
   lifecycle, and scan gating while retaining the existing persistence-order tests.

### Phase 4: Migration correctness and action suite

7. Introduce one reusable library-owned transactional tracking importer, identity-safe grouping,
   atomic history validation/import with directory injection, exception-safe close, contained
   candidate revalidation, and proven-file deletion eligibility.
8. Add `migrate-tracking.test.ts` covering dry-run discovery, durable tracking/history import,
   same-hash distinct inputs, option routing, cleanup decision table, partial unlink failure, and
   retained files plus database close after import failure.

### Phase 5: Coverage and completion

9. Run focused tests and focused coverage; close meaningful per-file gaps until each named action
   reaches 80% statements and lines without filler.
10. Run rfmedia CLI typecheck, the full rfmedia suite, markdown lint, and the repository's normal
    registered gates. Update migration docs only if behavior changed, audit Bash/Zsh/Fish completion
    parity as unchanged, and update every live issue #56 ROADMAP reference consistently.

## Key Decisions Needed

- **Migration fixes in this PR:** Yes. They are required to make the requested critical tests
  truthful and to close a current data-loss path.
- **Updated-sync fix in this PR:** Yes, if the required existing-destination regression test exposes
  the observed generic skip. Keep it classification-aware and local.
- **Downgrade containment fix in this PR:** Yes. The issue's sync cleanup path currently trusts
  persisted destination paths and can recursively remove outside the selected destination; this is
  a release-blocking data-protection defect, not optional hardening.
- **Coverage interpretation:** At least 80% statements and lines for each named action file, using a
  focused report; no global threshold and no filler tests.
- **Migration identity:** `(input basename, options hash)`, matching database operation identity;
  hash alone is insufficient.
- **Cleanup contract:** Delete only individually proven migrated legacy files. Partial success does
  not authorize deleting failed or malformed siblings.
- **Migration error contract:** Prefer structured `MigrateResult.errors` for contained per-file
  failures; initialization or action-wide failures may reject, but must close the database and
  preserve all unproven files.

## Open Questions

1. Does an already-migrated operation/session make its matching legacy file deletion-eligible, and
   what database query is the authoritative proof?
2. Should a tracking group with one successfully imported sidecar and one failed sidecar permit
   deletion of only the successful file, or keep the pair atomically? The safer default is to keep
   the pair unless proof and cleanup eligibility are explicit per file.
3. Should malformed discovery/import failures expand the public `MigrateResult.errors` contract or
   remain warnings plus retained files? Structured errors are preferable, but any result-shape
   compatibility impact should be confirmed.
4. Is the legacy input basename always sufficient to reconstruct the database `inputFile`, or must
   discovery preserve the sidecar directory as part of the operation identity?
5. If meaningful critical scenarios leave an action just below 80%, should maintainers accept a
   documented exception or add another distinct lifecycle partition? Do not resolve the gap with
   log-only or private-helper tests.
