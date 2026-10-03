# Task Structure Analysis: Issue 56 Action Tests

## Executive Summary

Use one read-only baseline gate, then fan out five disjoint implementation tasks inside the shared
feature worktree: album verification tests, filter verification tests, sync tests/fix, the tracking
importer, and the history importer. The migration action is the only implementation bottleneck and
must wait for both importer tasks; documentation, completion audit, focused coverage, ROADMAP
closeout, and full verification then converge sequentially. Parallel siblings never own the same
file.

## Recommended Phase Structure

### Phase 0: Baseline and Safety Gate

**Purpose**: Confirm the inherited suites, focused coverage baseline, runtime, and dirty-worktree
scope before any implementation edits.

**Suggested Tasks**:

- **Task 0.1 — sequential; depends on none; no file edits**: run the three existing action suites
  and focused V8 report under `mise exec`; capture per-file statements/lines and confirm that only
  planning artifacts are currently untracked. This gate establishes whether later failures are new.

**Parallelization**: None. Complete once before dispatch so every worker uses the same baseline.

### Phase 1: Independent Contracts and Library Seams

**Purpose**: Add the missing verification/sync contracts and establish the two reusable migration
seams without touching shared files from concurrent tasks.

**Suggested Tasks**:

- **Task 1.1 — parallel; depends on 0.1**: extend album verification coverage for dense missing
  detection, successful staged repair plus final recheck, failed recheck, and only the necessary
  batch/range lifecycle case. Modify only
  `packages/rfmedia-cli/src/actions/verify-album.test.ts`; preserve the existing mismatch/extra
  matrix and do not alter production code unless a new test exposes a separate defect.
- **Task 1.2 — parallel; depends on 0.1**: extend filter verification coverage for eligible versus
  filtered-out missing files, representative flat and structured/ranged destination mapping,
  successful repair/recheck, failed repair/recheck, and contained batch failure. Modify only
  `packages/rfmedia-cli/src/actions/verify-filter.test.ts`; do not create a shared verify harness.
- **Task 1.3 — parallel; depends on 0.1**: expand sync action coverage and implement the narrow
  production fix in `packages/rfmedia-cli/src/actions/sync.test.ts` and
  `packages/rfmedia-cli/src/actions/sync.ts`. Prove new/updated/unchanged counts, updated existing
  destination replacement without globally forcing new collisions, missing-source continuation,
  downgrade absent/success/failure behavior, database/legacy lifecycle, cleanup callbacks, and scan
  gating while retaining materialize-hash-persist ordering.
- **Task 1.4 — parallel; depends on 0.1**: expose one compatibility-preserving, library-owned
  completed/failed sidecar importer in
  `packages/rfmedia-cli/src/lib/completed-tracker.ts` and extend
  `packages/rfmedia-cli/src/lib/completed-tracker.test.ts`. Accept explicit operation identity and
  optional sidecar paths, transact writes, read back durable equivalence, and return counts plus
  per-file proof without changing automatic migration behavior.
- **Task 1.5 — parallel; depends on 0.1**: update
  `packages/rfmedia-cli/src/lib/history.ts` so `migrateLegacyHistory()` accepts an optional resolved
  directory while retaining `getHistoryDir()` as the default. Validate a complete session before
  reporting/importing it and return enough successful-file proof for action cleanup; the migration
  action test in Task 2.1 owns end-to-end custom-path and malformed-input regression coverage.

**Dependencies**: All five tasks require only Task 0.1 and are mutually independent.

**Parallelization**: Five-way fan-out is safe because every task has exclusive file ownership. If
the runtime has fewer slots, prioritize Tasks 1.4 and 1.5 because Task 2.1 waits for both.

### Phase 2: Migration Orchestration and Integrated Proof

**Purpose**: Replace count-only migration with durable, identity-safe import and proof-gated
cleanup at the exported action boundary.

**Suggested Tasks**:

- **Task 2.1 — sequential; depends on 1.4 and 1.5**: modify
  `packages/rfmedia-cli/src/actions/migrate-tracking.ts` and create
  `packages/rfmedia-cli/src/actions/migrate-tracking.test.ts`. Group by input identity plus options
  hash, call the reusable tracking importer, pass the same resolved history directory to discovery
  and import, derive deletion candidates only from proven imports/equivalence, revalidate cleanup
  targets, keep `--force` limited to prompt bypass, aggregate sibling unlink failures, and close the
  database exactly once in `finally`. Cover dry-run, routing flags, same-hash distinct inputs,
  custom path, malformed history, durable read-back, partial import/deletion, and close-on-error.

**Dependencies**: Task 2.1 consumes the APIs created by Tasks 1.4 and 1.5. It does not depend on the
verification or sync tasks.

**Parallelization**: Task 2.1 is sequential relative to the importer work but may begin while Tasks
1.1–1.3 are still running because its two owned files are disjoint.

### Phase 3: Coverage, Documentation, and Completion Parity

**Purpose**: Prove each named action reaches the issue target, document changed migration behavior,
audit unchanged completion surfaces, and prepare completion state without introducing filler tests.

**Suggested Tasks**:

- **Task 3.1 — sequential integration gate; depends on 1.1, 1.2, 1.3, and 2.1; no planned edits**:
  run all four focused suites together and the scoped V8 command with four explicit
  `--coverage.include` values. Require at least 80% statements and lines for every action file, not
  merely the aggregate. If a file misses target, return ownership to its original task and add only
  an uncovered behavioral partition; do not let this gate edit files concurrently.
- **Task 3.2 — parallel after migration; depends on 2.1**: update
  `packages/rfmedia-cli/README.md` and
  `packages/rfmedia-cli/docs/features/undo-history-system.md` only where final behavior requires it.
  Document durable success, per-file proof-gated `--delete-old`, force semantics, partial failure,
  and one custom history root for discovery/import. Leave verify/sync/schema docs unchanged when the
  implementation simply restores their existing promises.
- **Task 3.3 — parallel audit; depends on 1.1, 1.2, 1.3, and 2.1; no file edits**: audit Bash, Zsh,
  and Fish templates for unchanged command/option parity and run
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`. Record that no completion edit
  is required because no CLI surface changed.
- **Task 3.4 — sequential closeout; depends on 3.1, 3.2, and 3.3**: update only `ROADMAP.md` after
  focused contracts and coverage pass. Remove all three live #56 sprint/backlog/theme references,
  keep counts/headings consistent, and record shipped completion without rewriting historical
  archive data.

**Dependencies**: Task 3.2 and Task 3.3 can run concurrently with Task 3.1 because they own no
overlapping implementation/test files. Task 3.4 waits for every Phase 3 result so completion parity
cannot precede evidence.

**Parallelization**: Three-way fan-out for Tasks 3.1–3.3, then one serialized ROADMAP edit.

### Phase 4: Full Verification and Delivery Evidence

**Purpose**: Exercise package, repository, hook, and registered CI contracts after every code and
documentation change is present.

**Suggested Tasks**:

- **Task 4.1 — sequential; depends on 3.4; no planned edits**: under the pinned Node 22 runtime run
  rfmedia typecheck, the full rfmedia suite/coverage, architecture and generated-client checks,
  build, Markdown lint, `git diff --check`, completion parity, and the real pre-push hook path. Keep
  generated Lidarr gates serial and rebuild `better-sqlite3` under Node 22 if the ABI requires it.
- **Task 4.2 — sequential delivery evidence; depends on 4.1; no source edits**: review the final
  diff for test-only helpers or unproven deletion, use `.github/pull_request_template.md`, list exact
  commands/results, state the unchanged completion/schema/MCP audits, include `Closes #56`, and use
  the final head SHA for registered CI/review verification before merge closeout.

**Dependencies**: Strict chain from ROADMAP parity through local gates to external CI evidence.

## Task Granularity Recommendations

### Appropriate Task Sizes

- Keep each mature verify harness as a one-file task; their similar shapes hide different layout
  and evidence semantics.
- Pair `sync.ts` with `sync.test.ts` because the classification bug and regression contract must land
  atomically.
- Pair `completed-tracker.ts` with its existing real-database test because importer proof belongs to
  the library owner.
- Keep `history.ts` isolated so Task 2.1 can consume a settled optional-directory/proof API.
- Pair the migration action with its new action suite; together they stay within the three-file
  limit even if a small local type is required in the action module.

### Tasks to Split

- Do not combine all four action suites into one task: that would exceed the file limit, serialize
  independent work, and make mock leakage harder to diagnose.
- Do not combine importer libraries with migration orchestration: the action depends on both library
  contracts and needs a clean review boundary for destructive cleanup.
- Do not let a generic “coverage cleanup” task modify every suite. Return any gap to the task that
  already owns that test file.

### Tasks to Combine

- Keep each small production correction with its regression tests where the files already form one
  behavioral boundary (`sync`, completed-tracker, and migrate action).
- Combine the two migration user-doc edits because both describe the same manual/history cleanup
  behavior and have no code ownership conflict.

## Dependency Analysis

### Independent Tasks (Can Run in Parallel)

- Task 1.1 — album verification tests — `verify-album.test.ts`.
- Task 1.2 — filter verification tests — `verify-filter.test.ts`.
- Task 1.3 — sync orchestration/fix — `sync.ts`, `sync.test.ts`.
- Task 1.4 — tracking importer/proof — `completed-tracker.ts`, `completed-tracker.test.ts`.
- Task 1.5 — history directory/proof — `history.ts`.
- After Task 2.1, Task 3.2 documentation and Task 3.3 completion audit can run beside Task 3.1's
  read-only integrated coverage gate.

### Sequential Dependencies

- Task 0.1 must complete before Tasks 1.1–1.5 so regressions are measured against one baseline.
- Tasks 1.4 and 1.5 must complete before Task 2.1 because the action must consume library-owned
  proof rather than duplicate parsing or persistence.
- Tasks 1.1, 1.2, 1.3, and 2.1 must complete before Task 3.1 because its report measures all four
  final action modules together.
- Tasks 3.1–3.3 must complete before Task 3.4 because ROADMAP completion requires code, coverage,
  documentation, and parity evidence.
- Task 3.4 must complete before Task 4.1, and Task 4.1 before Task 4.2.

### Potential Bottlenecks

- **Migration API convergence**: Task 2.1 waits on both library seams; prioritize Tasks 1.4 and 1.5
  and agree on proof fields before dispatch.
- **Native SQLite runtime**: `better-sqlite3` ABI drift can make importer tests appear broken; enforce
  `.mise.toml` before debugging code.
- **Large mature verify suites**: mock default leakage can cause order-only failures. Each owner must
  restore deliberate defaults with `clearAllMocks()` and run its file both alone and in the full
  focused set.
- **Coverage gate**: a single low action can delay ROADMAP completion. Per-task focused coverage
  checks reduce late surprises without authorizing filler cases.
- **Shared worktree**: parallel workers must not format or stage unrelated files, run broad
  auto-fixers, or revert changes they do not own.

## File-to-Task Mapping

### Files to Create

| File                                                        | Suggested Task | Phase | Dependencies |
| ----------------------------------------------------------- | -------------- | ----- | ------------ |
| `packages/rfmedia-cli/src/actions/migrate-tracking.test.ts` | Task 2.1       | 2     | 1.4, 1.5     |

### Files to Modify

| File                                                        | Suggested Task | Phase | Dependencies  |
| ----------------------------------------------------------- | -------------- | ----- | ------------- |
| `packages/rfmedia-cli/src/actions/verify-album.test.ts`     | Task 1.1       | 1     | 0.1           |
| `packages/rfmedia-cli/src/actions/verify-filter.test.ts`    | Task 1.2       | 1     | 0.1           |
| `packages/rfmedia-cli/src/actions/sync.ts`                  | Task 1.3       | 1     | 0.1           |
| `packages/rfmedia-cli/src/actions/sync.test.ts`             | Task 1.3       | 1     | 0.1           |
| `packages/rfmedia-cli/src/lib/completed-tracker.ts`         | Task 1.4       | 1     | 0.1           |
| `packages/rfmedia-cli/src/lib/completed-tracker.test.ts`    | Task 1.4       | 1     | 0.1           |
| `packages/rfmedia-cli/src/lib/history.ts`                   | Task 1.5       | 1     | 0.1           |
| `packages/rfmedia-cli/src/actions/migrate-tracking.ts`      | Task 2.1       | 2     | 1.4, 1.5      |
| `packages/rfmedia-cli/README.md`                            | Task 3.2       | 3     | 2.1           |
| `packages/rfmedia-cli/docs/features/undo-history-system.md` | Task 3.2       | 3     | 2.1           |
| `ROADMAP.md`                                                | Task 3.4       | 3     | 3.1, 3.2, 3.3 |

No task modifies `vitest.config.ts`, database schema/migrations, Commander/MCP surfaces, package
dependencies, or the Bash/Zsh/Fish templates.

## Optimization Opportunities

### Maximize Parallelism

- Dispatch all five Phase 1 tasks after the single baseline; file ownership is completely disjoint.
- Prioritize the two importer tasks on constrained agent pools, then start Task 2.1 as soon as both
  complete while verify/sync work continues.
- Run documentation and completion audit concurrently with integrated focused coverage because
  their paths do not overlap.
- Require each task to run its smallest focused test/coverage command before handoff, reducing work
  at the convergence gate.

### Minimize Risk

- Derive verification truth from the final recheck and migration cleanup from durable per-file
  proof; attempted work and discovery counts are never success evidence.
- Use exact input plus options identity for sidecar grouping; hash-only grouping is unsafe.
- Validate/canonicalize cleanup candidates as contained regular files immediately before unlink.
- Keep dry-run before database initialization and every mutation; force must never bypass proof.
- Close initialized databases in `finally`, preserve the primary failure, and continue only for
  independent per-file/per-source errors represented by stable result fields.
- Avoid new dependencies, global coverage thresholds, generic fake filesystems, test-only exports,
  and duplicated verify/inventory algorithms.

## Implementation Strategy Recommendations

- Work contract-first: add failing scenario-dense tests at exported action seams, then make the
  smallest production correction in the file already responsible for the behavior.
- Treat library importers bottom-up and the migration action top-down only after their APIs settle;
  use a real temporary SQLite database for durable equivalence and narrow mocks for destructive
  discovery/unlink paths.
- Keep all tasks in the single feature worktree and enforce exclusive file ownership. Parallel
  siblings may read each other's changes but must not stage, format, or revert files outside their
  mapping.
- Validate in tiers: task-focused test, combined focused tests, per-file focused coverage, package
  typecheck/full suite, repository hooks, then registered CI/review state.
- Update migration docs to the final implemented semantics, audit existing verify/sync docs and all
  three completion templates as unchanged, and update ROADMAP only after evidence is green.
