# UX Research: Critical Action Tests for Issue 56

## Executive Summary

The useful experience outcome of issue 56 is trust. An operator should be able to believe that
`verify`, `sync`, and `migrate-tracking` distinguish a preview from a mutation, report incomplete
work honestly, preserve recoverable state after partial failure, and never wait for a prompt in an
automation context. A developer should be able to understand a failed test from its scenario name
and assertions without reconstructing a large mock call graph.

The current verification suites already cover size mismatch, extra files, fix strategies,
interactive selection, non-interactive fallback, dry-run, and staged repair. Adding another
strategy-by-layout cross-product would be filler. The highest-value additions are missing-file
repair and failed re-verification for `verify-album` and `verify-filter`; ordinary diff lifecycle,
continuation, and downgrade behavior for `sync`; and durable import plus deletion safety for the
currently absent `migrate-tracking` action suite.

Use a small hybrid fixture model: real per-test temporary paths and, where durability is the
contract, a temporary SQLite database; mocked discovery, prompts, destructive filesystem calls,
media scans, and injected failures. Assert returned structured results and persisted state first,
mutation absence or ordering second, and log text only when notification is itself the contract.

**Confidence**: High. This follows the current action contracts, existing suites, shared test
utilities, and package test configuration.

## User Workflows

### Verify a copied album

An operator runs album verification after a copy or range expansion. The critical workflow is:

1. The action derives the expected destination artifacts for the requested suffix range.
2. A genuinely absent destination is reported as `missing`, with the expected total unchanged.
3. Without `--fix`, the result remains incomplete and no write occurs.
4. With `--fix`, the action materializes a staged artifact and verifies that artifact at the
   selected tier before treating it as repaired.
5. A failed copy or failed post-repair verification remains visible in both the unresolved count
   and failure details.

The test should use one source track and the smallest useful range. One absent member catches the
mapping and aggregation contract; exercising every suffix does not add operator value.

**Confidence**: High. Missing detection and repair are explicit paths in
[`verify-album.ts`](../../../packages/rfmedia-cli/src/actions/verify-album.ts), but the existing
suite defaults destination existence to true.

### Verify a filtered export

The operator expects only eligible tracks and expects their exact configured layout. A focused
workflow should prove that one eligible missing track is reported and repaired at its precomputed
destination while an ineligible track is not counted. A second representative path shape may cover
structured ranged or converted output, because that is where rebuilding a destination from a
basename can put a correct file in the wrong place.

Failure must remain actionable: the result should identify the relative destination, source when
available, and staged-verification reason. Assertions on a decorative success glyph or spinner
title would not protect this experience.

**Confidence**: High. The action carries `sourcePath` on verification issues and supports staged
validation; the existing suite already covers duplicate flat names and structured ranged
conversion, so only the missing-artifact seam is unproved.

### Run incremental sync

The operator expects a truthful reconciliation summary rather than a count of attempted work. The
minimum representative diff contains one new file, one updated file whose destination already
exists, and one unchanged file. The action should materialize new and updated output, persist the
final fingerprint only after materialization, skip unchanged output, and return distinct counters.

If one source is missing or one file fails, later independent sources should still run. The failure
entry should preserve `sourcePath`, `destPath` when known, the message, and an error code such as
`ENOENT`. A media-library scan should occur only after a real successful change, never for dry-run,
unchanged-only, or failed-only work.

**Confidence**: High. These fields are part of `SyncResult`; the existing sync suite proves only
fingerprint persistence ordering, dry-run exclusion from that path, and hash/inventory failure.

### Migrate legacy tracking and history

The operator first needs a safe preview, then a durable migration, then optional cleanup. The
workflow should distinguish:

- discovered files from successfully imported files;
- completed and failed sidecar entries from comments and blank lines;
- tracking-only and history-only routing;
- default and explicit history locations;
- confirmed cleanup from declined cleanup;
- partial deletion from complete migration success.

`--delete-old` is the highest-risk interaction. A test must make it impossible for discovery counts
alone to authorize deletion. Legacy files are recoverability artifacts and should remain whenever
their import is malformed, fails, or cannot be proven durable.

**Confidence**: High. The current action counts tracking groups without inserting records and forms
its deletion list from all discovered files, making this a critical operator-safety contract rather
than optional coverage.

### Maintain and diagnose the suites

A developer should be able to run each action suite alone, read names as behavioral sentences, and
locate the failed contract from Vitest output. Prefer names such as “keeps a failed missing repair
unresolved” over “handles missing files,” and use table-driven tests only when every row shares the
same setup, action, and assertion shape.

Keep scenario builders close to their action suite: `createOptions(overrides)`, a small expected
path helper, and named mock defaults are easier to debug than a generic fixture framework. Reuse the
existing shared helpers only for temporary directory lifecycle and dummy-file creation.

**Confidence**: High. This matches the repository's documented `vi.hoisted()` lifecycle and
[`filesystem.ts`](../../../packages/rfmedia-cli/src/test-utils/filesystem.ts) helpers.

## Best Practices

- **Name the risk and outcome.** Organize by operator contract—missing repair, partial sync,
  cleanup gating—not by private helper or branch number. Each test should have a one-sentence reason
  it would block a dangerous regression. **Confidence**: High.
- **Use Arrange–Act–Assert with one causal failure.** Set only the mocks relevant to the scenario,
  invoke the exported action once, then assert result, durable state, and prohibited side effects.
  Do not test same-file private helpers directly. **Confidence**: High.
- **Prefer result-state assertions.** Assert `remainingIssues`, `failedFixes`, sync counters,
  `failed[]`, migration counts, database rows, and retained legacy files. Mock calls are supporting
  evidence for “never mutate,” exact routing, or ordering. **Confidence**: High.
- **Use realistic paths without a fake filesystem universe.** Create one isolated root with
  `source`, `destination`, `history`, and `tracking` children. Real paths catch join/relative-path
  errors; mocks make `EACCES`, `ENOENT`, staged validation, and partial `unlink` deterministic.
  **Confidence**: High.
- **Make negative assertions explicit.** Dry-run tests should prove no copy, convert, remove,
  unlink, database initialization/write, inventory append, prompt, or media scan. A count alone does
  not prove preview safety. **Confidence**: High.
- **Prove ordering with semantic events.** An event list such as `materialize`, `hash`, `inventory`
  is clearer and less brittle than relying on global invocation order. Use the same technique for
  `import`, `verify persisted rows`, `delete`. **Confidence**: High.
- **Reset stable mock defaults in `beforeEach`.** Use `vi.clearAllMocks()` when implementations
  should survive, explicitly restore per-test defaults, and use `vi.restoreAllMocks()` for spies.
  Avoid routine `vi.resetAllMocks()`, which can erase hoisted implementations and create
  order-dependent failures. **Confidence**: High.
- **Assert diagnostics with stable data.** Prefer structured paths, error codes, reason/status
  values, and a distinctive message substring. Match full human prose only when the wording is a
  documented CLI contract. **Confidence**: High.
- **Cover partitions, not permutations.** One missing verification example per action, one
  mismatch/extra strategy matrix already present, one representative layout edge, and one failure
  at each persistence boundary are enough. Do not multiply rating thresholds, range sizes, codecs,
  prompt choices, or filesystem error codes unless behavior changes. **Confidence**: High.

## Error Handling

| Scenario                                 | Operator-visible contract                                                          | Stable test evidence                                                       | Avoid                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| Expected verification artifact is absent | Result is incomplete and identifies the expected relative path                     | Issue status/path, expected and actual counts, no mutation without `--fix` | Asserting only `pathExists` call count            |
| Missing repair cannot materialize        | Failure stays unresolved and is not counted as repaired                            | `failedFixes`, `remainingIssues`, `repairedFiles`, source/destination      | Exact stack trace or log punctuation              |
| Staged repair fails selected tier        | Original destination is not published as repaired                                  | Verification status/reason, failure entry, no successful replace/publish   | Mocking the action's private repair helper        |
| Extra removal fails                      | Other independent work continues; extra remains unresolved                         | Failed path/code and successful sibling outcomes                           | One test for every OS error code                  |
| Sync source is missing                   | `ENOENT` is reported and the following source still runs                           | `sourcesScanned`, `failed[]`, later source result                          | Failing the entire invocation in the mock         |
| Copy/conversion fails                    | File is failed; no fingerprint or inventory success is recorded                    | Structured failure plus absence of later persistence events                | Only asserting a warning call                     |
| Hash or inventory persistence fails      | Attempt is not counted as copied; resumability is not falsely advanced             | Counter remains zero, failure details, event sequence                      | Treating a completed copy call as overall success |
| Downgraded-file deletion fails           | Deletion failure is aggregated without hiding other sync results                   | `deletedFiles`, `failedFiles`, destination path/code                       | Duplicating new-file copy scenarios               |
| History JSONL is malformed               | Warning/failure is surfaced and file is retained                                   | Retained path, no imported row, stable diagnostic substring                | Snapshotting all console output                   |
| Tracking/history import fails            | Database closes; related legacy files remain; action is not reported as successful | Close call/state, no unlink, returned/rejected error contract              | Allowing cleanup from discovery alone             |
| Cleanup confirmation is declined         | No legacy file is deleted                                                          | Prompt once, zero `unlink`, `filesDeleted = 0`                             | Testing prompt library rendering                  |
| One legacy-file deletion fails           | Successful deletions count; failed file/path/code is reported                      | `filesDeleted`, `errors[]`, all intended attempts                          | Expecting fail-fast behavior                      |

**Confidence**: High for verification, sync, and deletion behavior represented by current result
types; Medium for whether migration import failures should be returned or thrown, which needs a
single explicit action contract.

## Performance UX

The existing three action suites—47 tests across verify album, verify filter, and sync—completed in
575 ms of Vitest duration and 0.97 seconds wall time in a single local run on 2026-08-07. This is a
baseline observation, not a performance gate. Focused additions should remain cheap enough to run
continuously during development.

Determinism requirements:

- run action fixtures with `workers: 1` unless concurrency itself is the contract;
- never depend on TTY state—mock `isInteractive`, prompt decisions, progress, and media scanning;
- avoid `process.chdir`, shared fixed paths, home-directory state, and the real user tracking DB;
- use a unique `mkdtemp` root per test or suite and always remove it in `afterEach`;
- use fixed ratings, hashes, paths, and operation records rather than random values or wall-clock
  equality;
- use ordered mock responses only when the call sequence is itself explicit, and reset those
  queues before each test;
- keep filesystem trees tiny and use mocks for destructive or permission-failure cases;
- run focused files first, then the package suite and coverage under the repository's Node 22
  runtime.

Suggested developer loop:

```bash
mise exec -- npm run test:run --workspace packages/rfmedia-cli -- \
  src/actions/verify-album.test.ts \
  src/actions/verify-filter.test.ts \
  src/actions/sync.test.ts \
  src/actions/migrate-tracking.test.ts

mise exec -- npm run test:coverage --workspace packages/rfmedia-cli
```

The issue's 80% target should be inspected for the four action modules, but coverage percentage is
not a reason to add assertions-free branch tours. The current Vitest configuration collects V8
coverage without a checked-in threshold, so critical contract scenarios remain the acceptance
oracle.

**Confidence**: High for configuration and deterministic test techniques; Medium for timing because
it is a single local measurement.

## Comparable Patterns

### Existing verify action suites

[`verify-album.test.ts`](../../../packages/rfmedia-cli/src/actions/verify-album.test.ts) and
[`verify-filter.test.ts`](../../../packages/rfmedia-cli/src/actions/verify-filter.test.ts) are the
right homes for missing-artifact additions. They already provide hoisted boundary mocks, isolated
temporary paths, serial parallel-work mocks, conflict strategies, dry-run, non-interactive mode,
and staged re-verification. Extend their scenario language and defaults rather than creating a
second verification harness.

**Confidence**: High.

### Sync persistence ordering

[`sync.test.ts`](../../../packages/rfmedia-cli/src/actions/sync.test.ts) uses a compact semantic
event list to prove `materialize -> hash -> inventory`, and proves that hash or inventory failure is
not counted as copied. This pattern should be retained while expanding the diff and partial-failure
matrix. It is more diagnostic than asserting a long list of unrelated calls.

**Confidence**: High.

### Lower-level migration and inventory tests

[`completed-tracker.test.ts`](../../../packages/rfmedia-cli/src/lib/completed-tracker.test.ts)
already proves legacy sidecar parsing and automatic migration at the library boundary.
[`inventory.test.ts`](../../../packages/rfmedia-cli/src/lib/inventory.test.ts) uses real temporary
files for diff behavior. The action suites should not repeat parsing or diff algorithms; they should
prove action routing, summaries, lifecycle, persistence proof, and cleanup safety.

**Confidence**: High.

### Shared filesystem fixture helpers

[`copy-filter.test.ts`](../../../packages/rfmedia-cli/src/actions/copy-filter.test.ts) demonstrates
the shared `createTempTestDir`, `createTestFile`, and `cleanupTempDir` helpers and verifies observable
database state in critical tracking cases. This is a useful model for a temporary migration database
without introducing a new fixture abstraction.

**Confidence**: High.

## Recommendations

### Must

1. Add one missing-artifact no-fix/fix contract to each verify suite, including a failed staged
   repair or re-verification that remains unresolved.
2. Add a sync scenario for new, updated-existing, and unchanged classification, plus missing-source
   continuation and downgrade delete/failure behavior.
3. Add an action-level migration suite that proves durable tracking/history import before cleanup;
   discovery counts must never authorize `--delete-old`.
4. Prove dry-run mutation absence and prompt-free execution across all newly covered mutation paths.
5. Assert structured results, durable rows/files, and preserved legacy artifacts; use call assertions
   only for absence, routing, and safety ordering.

**Confidence**: High. These are the smallest tests that protect the critical operator contracts.

### Should

1. Reuse the existing verify harnesses and shared temp-directory helpers; keep migration-specific
   discovery and database builders local to its suite.
2. Add assertion messages where a multi-step invariant would otherwise be opaque, especially
   “must not persist after hash failure” and “must not delete before durable import.”
3. Test explicit non-interactive strategies and assert prompt functions are not called; do not rely
   on the CI runner's TTY state.
4. Use one representative structured/ranged or converted filter destination to catch path mapping
   without cross-product duplication.
5. Check focused module coverage after contract tests are green, then run the complete rfmedia CLI
   suite to detect mock leakage and order dependence.

**Confidence**: High.

### Nice

1. Introduce tiny local scenario factories for diff records and migration file metadata if repeated
   literals begin to obscure intent.
2. Add a compact semantic-event assertion for migration ordering if cleanup becomes a multi-stage
   implementation.
3. Improve human-facing failure text only when a new test demonstrates that the current structured
   result cannot tell an operator which path failed or what remains recoverable.

**Confidence**: Medium. These improve maintenance but are not required to satisfy the critical
coverage request.

## Open Questions

1. Is issue 56 authorized to expose and fix production defects found by the tests, particularly the
   tracking migration TODO and deletion-before-durable-import path, or should failing tests be
   landed separately from production corrections?
2. Should migration failures be returned in `MigrateResult.errors`, thrown, or both? The suite needs
   one stable contract so database initialization/import errors are not asserted inconsistently.
3. Should `--history-path` control both discovery and actual import? The current action discovers
   from the override but calls a migration helper that uses the default history location.
4. Is cleanup atomic per migration domain, per file, or best-effort only for individually proven
   imports? This determines the correct partial-success deletion assertion.
5. Does the 80% goal apply to each named action module or aggregate touched-action coverage? The
   repository currently has no configured per-file threshold.

**Confidence**: Medium. These are product and scope decisions that cannot be resolved from the
current tests alone.
