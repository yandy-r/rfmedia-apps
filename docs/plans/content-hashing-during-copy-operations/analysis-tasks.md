# Task Structure Analysis: Content Hashing During Copy Operations

## Executive Summary

Structure issue #111 as four phases: establish current baseline and harden the two shared
foundations, prove action-level ordering across album/filter/sync, produce performance and
documentation evidence, then complete PR/review/CI/merge cleanup. The critical path is:

```text
database + filesystem hardening
  -> action ordering/failure proof
  -> full validation + benchmark evidence
  -> documentation/ROADMAP + delivery
```

Database and filesystem work can proceed independently. After both APIs stabilize, album, filter,
and sync audits can run in parallel because they own separate action/test files. Documentation can
start from the frozen feature spec while action tests run, but claims and benchmark numbers must be
finalized only after current validation. Queue/MCP/completion coverage is regression-only and should
not become a production-code task because those surfaces already delegate correctly and expose no
new option.

Keep tasks to one production file plus its focused test wherever practical. Do not create a new
hasher service, schema version, artifact table, hash index, CLI flag, MCP field, or shell completion
change. PR #233 already provides the architecture; these tasks harden and prove it.

## Recommended Phase Structure

### Phase 1: Shared boundaries and baseline

#### Task 1.1: Capture baseline and freeze invariants

- **Files**: no production edits; use existing focused tests and
  `docs/plans/content-hashing-during-copy-operations/feature-spec.md` as the contract.
- **Work**: Run the current filesystem, integrity, DB, inventory, album, filter, MCP-adapter, queue,
  and completion tests before changes. Record failures and verify current schema version 9,
  nullable legacy hashes, and current benchmark seam.
- **Boundary**: Do not treat PR #233's historical report as current proof and do not change scope
  based on incidental failing unrelated tests.
- **Validation**: Capture exact commands/results for later comparison.

#### Task 1.2: Harden database compatibility and digest validation

- **Files**: `packages/rfmedia-cli/src/lib/db.ts` and
  `packages/rfmedia-cli/src/lib/db.test.ts`.
- **Work**:
  - preflight an existing database's `metadata.schema_version` before executing `schema.sql`;
  - reject versions greater than `CURRENT_SCHEMA_VERSION` without schema DDL;
  - distinguish new/unversioned databases from malformed version metadata;
  - validate every non-null `contentHash` as 64 lowercase hexadecimal characters in both single and
    batch inventory write APIs;
  - prove invalid batch input commits zero rows.
- **Boundary**: Keep schema version 9, `schema.sql`, the guarded v8-to-v9 migration, positional
  statements, nullable historical values, and current read APIs unchanged.
- **Validation**: New v9 DB, v8 migration, v9 reopen, future-version `sqlite_schema`/metadata
  immutability, valid/invalid single writes, valid/invalid batch transaction, `NULL` retrieval.

Task 1.2 intentionally combines future-schema preflight and hash validation because both changes
live in `db.ts`/`db.test.ts`; splitting them would create merge conflicts without improving review.

#### Task 1.3: Harden stream cancellation, retry isolation, and partial cleanup

- **Files**: `packages/rfmedia-cli/src/lib/filesystem.ts` and
  `packages/rfmedia-cli/src/lib/filesystem.test.ts`.
- **Work**:
  - pass the existing `AbortSignal` into `pipeline()`;
  - recreate read/write streams, transparent transform, and SHA-256 state for every retry;
  - track whether the destination existed before the helper attempted creation;
  - remove only a newly created partial destination after cancellation or exhausted retry;
  - preserve timestamp restoration and actionable error classification.
- **Boundary**: Do not add atomic temp-file replacement, recursive cleanup, symlink policy, new
  dependencies, or a user-facing hash toggle.
- **Validation**: Known copy digest, hardlink digest, cancellation, retry-after-failure with a clean
  digest, exhausted failure cleanup, and preservation of a pre-existing destination.

#### Task 1.4: Confirm final-file hashing error semantics

- **Files**: `packages/rfmedia-cli/src/lib/integrity.ts` and
  `packages/rfmedia-cli/src/lib/integrity.test.ts` only if current coverage exposes a gap.
- **Work**: Verify `calculateHash()` returns lowercase SHA-256, propagates read errors, and can honor
  cancellation if action integration requires it. Preserve `verifyFileIntegrity()` as the separate
  source/destination comparison.
- **Boundary**: This is audit-first. If current behavior already satisfies the feature spec, add no
  production edit and retain tests as evidence.

Phase 1 parallelization: Tasks 1.2 and 1.3 can start together. Task 1.4 is independent and may run
beside them. Task 1.1 runs first as a short baseline checkpoint.

### Phase 2: Action ordering and delegated integration proof

These tasks start after the shared DB/hash contracts stabilize. Each action task should begin by
adding a failing test for a demonstrated gap; do not refactor branches whose existing tests already
prove the invariant.

#### Task 2.1: Audit album copy hash persistence and completion ordering

- **Files**: `packages/rfmedia-cli/src/actions/copy-album.ts` and
  `packages/rfmedia-cli/src/actions/copy-album.test.ts`.
- **Work**: Prove regular copy, hardlink, conversion, parallel suffix, and accepted destination
  paths finalize a digest and batch-write inventory before `recordCompletedAlbumCopy()` or source
  completion. Prove dry-run, hash failure, and DB failure do not mark completion.
- **Boundary**: Preserve current one-pass copy helper, one-row-per-logical-inventory semantics,
  worker model, plugin surface, and batch write API. Change ordering only where a test demonstrates
  a violation.
- **Depends on**: Tasks 1.2 and 1.3; Task 1.4 if its API changes.

#### Task 2.2: Audit filter copy final-destination persistence

- **Files**: `packages/rfmedia-cli/src/actions/copy-filter.ts` and
  `packages/rfmedia-cli/src/actions/copy-filter.test.ts`.
- **Work**: Prove copied, hardlinked, converted, overwritten, renamed, and explicitly adopted
  destinations use their final path/hash before successful tracking. Cover dry-run, hash failure,
  and DB validation failure without completion.
- **Boundary**: Do not consolidate all filter branches into a new copy service or change conflict,
  result, hook, progress, or output contracts.
- **Depends on**: Task 1.2; Task 1.4 only if final-file hashing changes.

#### Task 2.3: Add focused sync inventory-hash coverage

- **Files**: `packages/rfmedia-cli/src/actions/sync.ts` and a new focused
  `packages/rfmedia-cli/src/actions/sync.test.ts` if no existing action test owns this behavior.
- **Work**: Prove ordinary copy, hardlink, and conversion store the hash for the destination
  represented by sync's existing one-row-per-source inventory model. Prove dry-run, hash failure,
  and inventory failure are non-success outcomes.
- **Boundary**: Do not redesign range inventory identity, deletion policy, diff calculation, or
  legacy JSONL behavior.
- **Depends on**: Task 1.2 and Task 1.4 if changed.

#### Task 2.4: Verify portable inventory compatibility

- **Files**: `packages/rfmedia-cli/src/lib/inventory.ts` and
  `packages/rfmedia-cli/src/lib/inventory.test.ts` only if missing coverage requires edits.
- **Work**: Prove present, `NULL`, and omitted database/JSONL hashes map without fabrication or loss.
  Confirm `appendFileRecord()` passes the finalized digest to the DB API.
- **Boundary**: Audit-first; no new table/model or implicit hash calculation in the adapter.
- **Depends on**: Task 1.2.

#### Task 2.5: Run delegation and completion regressions

- **Files**: no production edits expected; existing
  `packages/rfmedia-cli/src/actions/queue.test.ts`,
  `packages/rfmedia-cli/src/actions/queue-adapter.test.ts`,
  `packages/rfmedia-cli/src/mcp/adapters.spec.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`.
- **Work**: Prove queue/MCP still delegate to album/filter/sync actions and existing Bash/Zsh/Fish
  templates remain unchanged.
- **Boundary**: Do not add hash fields to queue serialization, MCP schemas/results, or completion
  templates.
- **Depends on**: Tasks 2.1-2.3 for final regression, though tests may be run earlier.

Phase 2 parallelization: Tasks 2.1, 2.2, 2.3, and 2.4 own separate files and can run concurrently
after their Phase 1 prerequisites. Task 2.5 is the integration checkpoint after they converge.

### Phase 3: Performance evidence and documentation

#### Task 3.1: Strengthen and run the direct-copy benchmark

- **Files**: `packages/rfmedia-cli/benchmarks/copy.bench.ts` and, only if shared fixture support is
  needed, `packages/rfmedia-cli/benchmarks/helpers.ts`.
- **Work**: Compare the identical SQLite-tracked direct-copy workload with benchmark-only hashing
  disabled/enabled. Add representative file-size coverage or a reproducible configuration,
  repeated samples, medians/spread, throughput, and peak-memory evidence. Report hardlink and
  conversion cost separately if measured.
- **Boundary**: Keep `benchmarkDisableContentHashing` internal; add no CLI/config toggle or CI
  wall-clock threshold. Do not tune concurrency/buffers without profiling evidence.
- **Depends on**: Tasks 1.3 and 2.1.

#### Task 3.2: Correct tracking and sync documentation

- **Files**: `packages/rfmedia-cli/README.md`,
  `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`, and
  `packages/rfmedia-cli/docs/features/sync-command.doc.md`.
- **Work**: Remove stale claims that only sync populates inventory, document schema version 9,
  `content_hash`, database/legacy routing, `NULL` legacy rows, tracking-disabled behavior, and sync's
  existing inventory semantics.
- **Depends on**: Frozen feature spec; may start during Phase 2, finalize after action validation.

#### Task 3.3: Document fingerprint, verification, interruption, and performance semantics

- **Files**: `docs/features/file-integrity-verification.md`,
  `docs/features/file-integrity-quick-reference.md`, and
  `packages/rfmedia-cli/docs/features/graceful-interruption.md`.
- **Work**: Distinguish persisted write-time fingerprinting from `copy --verify`, describe
  conversion and hardlink snapshot semantics, and document new-path-only partial cleanup.
- **Follow-up file**: Update
  `packages/rfmedia-cli/docs/features/performance-benchmarks.md` in a separate small docs commit/task
  with the exact benchmark method and current evidence, keeping the first task to three files.
- **Depends on**: Tasks 1.3, 2.1-2.3, and benchmark method from Task 3.1.

#### Task 3.4: Update roadmap and closeout artifacts

- **Files**: `ROADMAP.md` and the workflow-generated current implementation report/plan artifact
  only if required by the selected plan executor.
- **Work**: Mark all three #111 references shipped, credit PR #233 as the initial implementation,
  keep #116 as downstream verification, and add the closeout PR link once known.
- **Boundary**: Do not rewrite historical PR #233 validation as current evidence.
- **Depends on**: Completed implementation/validation and known PR number; final roadmap link is a
  late delivery edit.

Phase 3 parallelization: Benchmark execution and the first documentation drafts can proceed in
parallel. Performance claims and ROADMAP status finalize only after validation.

### Phase 4: Full validation and delivery lifecycle

#### Task 4.1: Run proportional validation

- **Files**: no implementation edits unless a real regression is found.
- **Work**: Run focused tests first, then package typecheck/test/build, completion regression, root
  repository gates, Markdown checks, benchmark/report validation, and `git diff --check`.
- **Depends on**: All implementation and documentation tasks.

#### Task 4.2: Create and review the closeout PR

- **Files**: `.github/pull_request_template.md` is the body source; no template edit.
- **Work**: Commit intentional scope, push the worktree branch, open a PR with exact validation and
  `Closes #111`, perform structured code review, fix every actionable finding, rerun affected/full
  tests, and resolve review threads.
- **Depends on**: Task 4.1.

#### Task 4.3: CI, squash merge, and cleanup

- **Work**: Monitor all required checks to green, distinguish external review latency from code
  failure, squash merge, verify issue #111 closed, delete the remote/local branch, and remove the
  dedicated worktree safely.
- **Depends on**: Review fixes committed/pushed and green CI.

## Task Granularity Recommendations

- Pair each production module with its focused test. This makes failure contracts reviewable and
  avoids one late test-only task that obscures which behavior each test protects.
- Combine database preflight and digest validation because they share `db.ts`/`db.test.ts`; do not
  run agents concurrently on the same files.
- Keep filesystem changes separate from action changes. The shared helper should stabilize before
  album action tests depend on new abort/cleanup behavior.
- Give album, filter, and sync separate tasks. These modules are large and have distinct copy,
  conversion, conflict, and completion flows; combining them would create an unreviewable task.
- Make inventory/integrity audits conditional. If current source/tests already prove the feature
  spec, record evidence rather than editing files to manufacture work.
- Keep each documentation task to two or three related files. The README/tracking/sync set and the
  integrity/interruption set have different audiences and validation needs.
- Treat benchmark code and benchmark results as one evidence task, but keep performance docs in a
  small follow-up so code review is not buried in prose.
- Do not create implementation tasks for queue, MCP, shell completions, Plex/playlist/watch, schema
  v10, an artifact ledger, hash index, or #116 behavior. Queue/MCP/completions require regression
  checks only; the rest is explicitly deferred.

## Dependency Analysis

```text
Baseline 1.1
   |
   +--> DB 1.2 --------+--> Album 2.1 --+
   |                   +--> Filter 2.2 -+--> Delegation 2.5 --+
   |                   +--> Sync 2.3 ---+                     |
   |                   +--> Inventory 2.4                     |
   |                                                           +--> Full validation 4.1
   +--> Filesystem 1.3 -----> Album 2.1 --> Benchmark 3.1 -----+          |
   |                                                           |          v
   +--> Integrity 1.4 ------> Filter/Sync as needed             +--> Docs 3.2/3.3
                                                                       |
                                                             Roadmap 3.4
                                                                       |
                                                                       v
                                                               PR/review 4.2
                                                                       |
                                                                       v
                                                               CI/merge 4.3
```

### Parallel batches

| Batch | Parallel tasks                                               | Join condition                                  |
| ----- | ------------------------------------------------------------ | ----------------------------------------------- |
| A     | 1.2 database, 1.3 filesystem, 1.4 integrity audit            | Shared APIs/tests green                         |
| B     | 2.1 album, 2.2 filter, 2.3 sync, 2.4 inventory audit         | In-scope action invariants green                |
| C     | 3.1 benchmark, 3.2 tracking docs, initial 3.3 integrity docs | Current evidence captured and claims reconciled |
| D     | 2.5 delegation regression, complete 3.3 docs, 3.4 roadmap    | Full scope ready for validation                 |

Do not parallelize Tasks 1.2 subparts or multiple documentation edits to the same file. Task 3.4's
final PR link cannot complete until Task 4.2 creates the PR; use a placeholder-free two-step roadmap
edit or update the link immediately after PR creation.

## File-to-Task Mapping

| File                                                                | Primary task    | Notes                                              |
| ------------------------------------------------------------------- | --------------- | -------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/db.ts`                                | 1.2             | Future-schema preflight and digest validation      |
| `packages/rfmedia-cli/src/lib/db.test.ts`                           | 1.2             | Schema immutability, validation, rollback evidence |
| `packages/rfmedia-cli/src/lib/filesystem.ts`                        | 1.3             | Signal, retry state, partial cleanup               |
| `packages/rfmedia-cli/src/lib/filesystem.test.ts`                   | 1.3             | Real-file error/cancellation tests                 |
| `packages/rfmedia-cli/src/lib/integrity.ts`                         | 1.4             | Audit-first final-file hashing                     |
| `packages/rfmedia-cli/src/lib/integrity.test.ts`                    | 1.4             | Digest/error/cancel proof if needed                |
| `packages/rfmedia-cli/src/actions/copy-album.ts`                    | 2.1             | Batch inventory/completion ordering                |
| `packages/rfmedia-cli/src/actions/copy-album.test.ts`               | 2.1             | Album method/failure matrix                        |
| `packages/rfmedia-cli/src/actions/copy-filter.ts`                   | 2.2             | Final path/hash and tracking order                 |
| `packages/rfmedia-cli/src/actions/copy-filter.test.ts`              | 2.2             | Filter method/conflict/failure matrix              |
| `packages/rfmedia-cli/src/actions/sync.ts`                          | 2.3             | Existing inventory-row hash contract               |
| `packages/rfmedia-cli/src/actions/sync.test.ts`                     | 2.3             | New focused action test if required                |
| `packages/rfmedia-cli/src/lib/inventory.ts`                         | 2.4             | Present/null/omitted mapping audit                 |
| `packages/rfmedia-cli/src/lib/inventory.test.ts`                    | 2.4             | Portable compatibility evidence                    |
| `packages/rfmedia-cli/src/actions/queue.test.ts`                    | 2.5             | Delegation regression only                         |
| `packages/rfmedia-cli/src/actions/queue-adapter.test.ts`            | 2.5             | Queue adapter regression only                      |
| `packages/rfmedia-cli/src/mcp/adapters.spec.ts`                     | 2.5             | MCP delegation/options regression only             |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`  | 2.5             | No-change completion regression                    |
| `packages/rfmedia-cli/benchmarks/copy.bench.ts`                     | 3.1             | Like-for-like benchmark                            |
| `packages/rfmedia-cli/benchmarks/helpers.ts`                        | 3.1 conditional | Representative fixture support only if needed      |
| `packages/rfmedia-cli/README.md`                                    | 3.2             | Correct stale sync-only inventory claims           |
| `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md` | 3.2             | Schema v9 and DB flow                              |
| `packages/rfmedia-cli/docs/features/sync-command.doc.md`            | 3.2             | DB/JSONL and sync hash behavior                    |
| `docs/features/file-integrity-verification.md`                      | 3.3             | Fingerprint vs verification                        |
| `docs/features/file-integrity-quick-reference.md`                   | 3.3             | User-facing distinction/examples                   |
| `packages/rfmedia-cli/docs/features/graceful-interruption.md`       | 3.3             | Partial cleanup/cancellation                       |
| `packages/rfmedia-cli/docs/features/performance-benchmarks.md`      | 3.3 follow-up   | Current method/evidence                            |
| `ROADMAP.md`                                                        | 3.4             | Mark all #111 locations shipped                    |
| `.github/pull_request_template.md`                                  | 4.2 read-only   | Required PR body baseline                          |

`schema.sql`, `migrations.ts`, DB/inventory types, command files, MCP schema, queue production code,
and shell completion templates are intentionally absent from edit tasks. They are verified context
or regression surfaces; the feature spec prohibits unnecessary changes.

## Optimization Opportunities

- **Run baseline once, not per task.** Share exact baseline commands/results across action work.
- **Exploit file ownership.** DB and filesystem tasks can run in parallel; album/filter/sync tasks
  can run in parallel after shared APIs settle.
- **Use audit-first tasks.** Avoid no-op production edits in `integrity.ts` or `inventory.ts` when
  focused tests already cover the contract.
- **Keep retry tests deterministic.** Inject or mock stream/open failure at a known attempt rather
  than depending on timers and multi-gigabyte fixtures.
- **Reuse shared validation.** One private digest validator in `db.ts` protects single and batch
  writes without exporting a new public API.
- **Minimize database setup duplication.** Extend existing temporary v8/v9 DB fixtures in
  `db.test.ts`; add a future-version fixture and snapshot only relevant schema/metadata facts.
- **Avoid action-wide rewrites.** Add narrow assertions around existing inventory/completion calls,
  then move only statements that violate ordering.
- **Batch slow gates.** Run focused tests during each task, then full package/root validation once
  after integration and once after review fixes.
- **Make benchmark variance visible.** Prefer a small reusable fixture parameter over repeated large
  committed binaries. Capture raw samples and calculate medians/spread outside a CI pass/fail gate.
- **Draft docs concurrently.** Tracking and integrity docs can be drafted during action work, but
  benchmark numbers and final behavior claims wait for current evidence.
- **Leave completions untouched.** Running the existing parity test is faster and safer than
  mechanically rewriting generated templates when the command surface did not change.

## Implementation Strategy Recommendations

1. **Work test-first at each boundary.** Add failing future-schema/hash-validation tests, then DB
   code; add cancellation/cleanup tests, then filesystem code; add action failure-order tests before
   moving action statements.
2. **Preserve the merged architecture.** Reuse `copyOrLinkWithHash()`, `calculateHash()`, inventory
   adapters, prepared writes, schema version 9, and existing tracking identity.
3. **Keep changes surgical.** No new service class, table/index, CLI/MCP/result field, completion
   template, copy-surface expansion, or downstream verification feature.
4. **Integrate in dependency order.** Land DB/filesystem foundations first, then action tasks, then
   benchmark/docs. Rebase or merge parallel branches only at phase joins to minimize conflicts.
5. **Use proportional validation.** Focused real-file/SQLite tests for each task; package-wide tests
   after Phase 2; repository-wide gates after docs; rerun affected/full suites after review fixes.
6. **Report performance honestly.** Apply the <5% target to repeated direct byte-copy measurements,
   separate hardlink/conversion observations, and label high-variance results inconclusive.
7. **Treat documentation as acceptance evidence.** Correct the stale sync-only inventory statements,
   define write-time fingerprinting precisely, and preserve `--verify` as a distinct behavior.
8. **Finish the full lifecycle.** Use the PR template with `Closes #111`, run a structured review,
   fix findings, monitor CI to green, squash merge, verify issue/ROADMAP state, and remove branch and
   worktree.
