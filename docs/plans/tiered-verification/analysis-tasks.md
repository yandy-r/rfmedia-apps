# Task Structure Analysis: Tiered Verification

## Executive Summary

Implement tiered verification through 18 file-bounded tasks plus two no-edit delivery gates. Every
implementation task owns one to three created or modified files and includes its nearest test or
documentation evidence. The dependency graph freezes public types first, builds independent
integrity/database/filesystem foundations in parallel, composes them into one tier-policy module,
then integrates album and filter actions concurrently.

The critical path is:

```text
T01 contracts
  -> T03 integrity + T04 read-only database
  -> T06 tier policy
  -> T08 album + T09 filter
  -> T13 benchmark
  -> T17 benchmark evidence
  -> T18 ROADMAP
  -> G01 full validation
  -> G02 PR/review/CI/merge cleanup
```

Two supporting paths run alongside it:

- `T02 destination naming -> T09 filter verification + T10 copy-filter adoption`
- `T07 CLI -> T11 completion templates -> T12 completion tests`, while documentation tasks fan out
  after the action contract is stable.

The accepted `feature-spec.md` controls semantics where exploratory research differs: exact
destination-bound fingerprints only, default evidence required by deep, converted/same-inode direct
comparison reported as `not-applicable`, unrepresented ranged artifacts reported as
`unverifiable`, and no implicit baseline creation. `packages/rfmedia-cli/src/lib/schema.sql` and
`packages/rfmedia-cli/src/lib/migrations.ts` are explicit non-touch files.

## Recommended Phase Structure

### Phase 1 — Contracts and independent foundations

Run T01 first. After it lands, T02, T03, T04, and T05 can proceed in parallel. T06 composes the
contract, content I/O, and database candidate types.

| Task | Purpose                                                                    | Files | Depends on    |
| ---- | -------------------------------------------------------------------------- | ----: | ------------- |
| T01  | Public verification option/result/database contracts                       |     3 | —             |
| T02  | Deterministic duplicate destination-name helper                            |     2 | T01           |
| T03  | Abort-aware hash and bounded stable byte comparison                        |     2 | T01           |
| T04  | Existing-file read-only DB opener and exact candidate query                |     3 | T01           |
| T05  | Atomic staged-replacement filesystem primitive                             |     2 | T01           |
| T06  | Pure tier dispatcher, baseline resolver, aggregation, unresolved predicate |     2 | T01, T03, T04 |

Phase exit: types compile; quick/default/deep policy is independently testable; database tests prove
no creation/migration/WAL mutation; content comparison is bounded, cancellation-aware, and stable;
repair staging preserves the original on failure.

### Phase 2 — CLI and action integration

T07 can start once T06 defines aggregation and unresolved semantics. T08 and T09 run in parallel.
T10 is deliberately separate so copy-filter regression coverage stays within the three-file limit.

| Task | Purpose                                                                   | Files | Depends on                   |
| ---- | ------------------------------------------------------------------------- | ----: | ---------------------------- |
| T07  | CLI flags, tier selection, database option, machine output, exit behavior |     2 | T01, T06                     |
| T08  | Album/range traversal integration and evidence-safe repair                |     2 | T01, T03, T04, T05, T06      |
| T09  | Flat/structured/album filter verification integration                     |     2 | T01, T02, T03, T04, T05, T06 |
| T10  | Make copy-filter consume the same destination-name helper                 |     2 | T02                          |

Phase exit: album and every filter layout use the same per-file outcomes, exact baselines, signal,
post-repair recheck, and aggregate semantics; duplicate destinations are mapped identically at copy
and verify time; extras and every unresolved evidence state drive nonzero status.

### Phase 3 — Public surface, evidence, and documentation

Completion templates and docs can fan out after T07–T10 stabilize the public contract. Benchmark
work waits for both actions so quick/default/deep measure the real workflows.

| Task | Purpose                                               | Files | Depends on                          |
| ---- | ----------------------------------------------------- | ----: | ----------------------------------- |
| T11  | Bash/Zsh/Fish verify option templates                 |     3 | T07                                 |
| T12  | Completion parity tests                               |     1 | T11                                 |
| T13  | Identical-workload quick/default/deep benchmark       |     2 | T03, T04, T06, T08, T09             |
| T14  | Verify command and auto-fix guides                    |     2 | T07, T08, T09                       |
| T15  | Copy-time/read-time integrity documentation alignment |     2 | T03, T04, T06, T08, T09             |
| T16  | Main rfmedia CLI reference                            |     1 | T07, T08, T09, T14, T15             |
| T17  | Benchmark methodology and recorded evidence           |     2 | T13                                 |
| T18  | ROADMAP completion and implementation PR linkage      |     1 | T14, T15, T16, T17; PR number known |

Phase exit: all shells advertise the same flags, all public docs use the accepted terminology,
representative benchmark evidence states whether the 10x target was met without a flaky CI timing
gate, and ROADMAP links issue #116 to the implementation PR and #111/PRs #233/#248.

### Phase 4 — Validation and delivery gates

These gates have no preplanned source-file edits. If validation or review finds a defect, create a
new fix task limited to one to three affected files, attach it to the finding, run its focused test,
then repeat the appropriate gate.

| Gate | Purpose                                                                                                             | Planned files | Depends on |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ------------: | ---------- |
| G01  | Full format, typecheck, tests, build, benchmark smoke/evidence review, docs lint, graph update, diff audit          |             0 | T01–T18    |
| G02  | Template-compliant PR, formal review, finding fixes, CI green, squash merge, issue closure, branch/worktree cleanup |             0 | G01        |

G01 should run, at minimum:

```bash
npm run format:check
npm run typecheck -w packages/rfmedia-cli
npm run test:run -w packages/rfmedia-cli
npm run build:rfmedia
npm run lint:md
RFMEDIA_BENCH_SCALES=10 RFMEDIA_BENCH_TRACK_BYTES=8388608 npm run bench:rfmedia
graphify update .
git diff --check
```

Run the full representative benchmark separately from the bounded smoke and record filesystem,
cache state, byte volume, worker count, iterations, medians, files/s, and MiB/s in T17.

## Task Granularity

### T01 — Define additive domain contracts

**Files (3):**

- `packages/rfmedia-cli/src/types/options.ts`
- `packages/rfmedia-cli/src/types/results.ts`
- `packages/rfmedia-cli/src/types/index.ts`

**Actions:** add `VerificationTier`; add `tier` and optional `trackingDatabase` to `VerifyOptions`;
extend `FileVerifyStatus`, `VerifiedFile`, `VerifyCommandResult`, fix/coverage evidence, and reason
enums additively; export every public type. Preserve current fields and make `not-applicable`
distinct from `unverifiable`.

**Validate:** `npm run typecheck -w packages/rfmedia-cli` may expose expected downstream compile
failures until callers receive default `tier`; do not weaken the required field to avoid those
call-site updates.

### T02 — Centralize deterministic destination naming

**Files (2):**

- `packages/rfmedia-cli/src/lib/verify.ts`
- `packages/rfmedia-cli/src/lib/verify.test.ts` (create)

**Actions:** add a pure allocator for case-insensitive duplicate basenames with stable `-002`,
`-003` suffixes; cover converted extensions, directory separation, input order, and case variants.
Keep `getExpectedDestFilename()` and `findExtraFiles()` behavior unchanged.

**Validate:**
`(cd packages/rfmedia-cli && npx vitest run src/lib/verify.test.ts)`.

### T03 — Implement abort-aware integrity primitives

**Files (2):**

- `packages/rfmedia-cli/src/lib/integrity.ts`
- `packages/rfmedia-cli/src/lib/integrity.test.ts`

**Actions:** add optional signal support to `calculateHash()`; remove full digest logging from
two-path comparison; add fixed-buffer `compareFileBytes()` with regular-file checks, short-read/EOF
correctness, same-inode evidence, pre/post open-handle stability, cancellation, and `finally`
cleanup. Use real temporary files for semantic tests.

**Validate:**
`(cd packages/rfmedia-cli && npx vitest run src/lib/integrity.test.ts)` and typecheck.

### T04 — Add exact read-only fingerprint access

**Files (3):**

- `packages/rfmedia-cli/src/types/db.ts`
- `packages/rfmedia-cli/src/lib/db.ts`
- `packages/rfmedia-cli/src/lib/db.test.ts`

**Actions:** add `DbInventoryFingerprint`; implement an existing-file, read-only/query-only opener
that validates supported schema without schema execution, migration, journal changes, or file/WAL/SHM
creation; add a parameterized inventory/operations join for exact candidates and runtime row/hash
validation. Return empty results for empty source input and fail closed on malformed/ambiguous rows.

**Validate:** `(cd packages/rfmedia-cli && npx vitest run src/lib/db.test.ts)`; assert filesystem
state and schema metadata remain unchanged after read-only open/query.

### T05 — Add staged atomic replacement

**Files (2):**

- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`

**Actions:** add a narrow helper that creates an exclusive private sibling temporary path, invokes
materialize/validate callbacks with `AbortSignal`, closes/flushes, revalidates containment/parent
identity, atomically renames into place, and cleans up on every pre-commit error. The original must
survive materialization, validation, abort, and commit failure.

**Validate:**
`(cd packages/rfmedia-cli && npx vitest run src/lib/filesystem.test.ts)`.

### T06 — Implement shared tier policy and aggregation

**Files (2):**

- `packages/rfmedia-cli/src/lib/tiered-verification.ts` (create)
- `packages/rfmedia-cli/src/lib/tiered-verification.test.ts` (create)

**Actions:** implement exact destination/source/conversion baseline resolution, exhaustive tier
dispatch, quick metadata comparison, default destination hash, cumulative deep byte comparison,
conversion/same-inode `not-applicable` evidence, unstable/unverifiable classifications, result
initialization/merge/transition helpers, deterministic issue ordering, and one unresolved predicate.
Quick must not call hash/byte/database helpers.

**Validate:**
`(cd packages/rfmedia-cli && npx vitest run src/lib/tiered-verification.test.ts)` and typecheck.

### T07 — Wire the CLI contract

**Files (2):**

- `packages/rfmedia-cli/src/commands/verify.ts`
- `packages/rfmedia-cli/src/cli.test.ts`

**Actions:** add conflicting `--quick`/`--deep`, explicit `--tracking-database`, no-flag default tier,
help text, option building, action propagation, tier/status/counters in machine output, and exit code
from the shared unresolved predicate. Keep `--verify-size` additive and prevent it from weakening a
tier. Assert conflicts occur before action/database/filesystem work.

**Validate:** `(cd packages/rfmedia-cli && npx vitest run src/cli.test.ts)` plus typecheck.

### T08 — Integrate album verification and safe repair

**Files (2):**

- `packages/rfmedia-cli/src/actions/verify-album.ts`
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`

**Actions:** preserve album-only/artist, suffix, multi-source, file-input, range precedence, expected
filename, and extra detection. Preload exact candidates once, build absolute per-file tasks, call the
shared verifier with the worker signal, aggregate typed outcomes, gate repair on source-to-baseline
proof, use staged replacement, and replace issues only after final-path tier recheck.

**Validate:**
`(cd packages/rfmedia-cli && npx vitest run src/actions/verify-album.test.ts)`.

### T09 — Integrate every filter verification layout

**Files (2):**

- `packages/rfmedia-cli/src/actions/verify-filter.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`

**Actions:** preserve rating/metadata selection, flat, preserve-structure, album mode, ranges,
conversion filename rules, multi-source precedence, and extras. Precompute destination tasks in
stable order with T02's helper before parallel I/O; use exact baseline resolution, shared outcomes,
safe staged repair, final recheck, and shared aggregate semantics in every verification loop.

**Validate:**
`(cd packages/rfmedia-cli && npx vitest run src/actions/verify-filter.test.ts)`.

### T10 — Align copy-filter destination mapping

**Files (2):**

- `packages/rfmedia-cli/src/actions/copy-filter.ts`
- `packages/rfmedia-cli/src/actions/copy-filter.test.ts`

**Actions:** replace the private duplicate allocator with T02's helper without changing output names;
add regressions proving copy and verify derive the same flat destination sequence for duplicate and
case-variant basenames, including conversion.

**Validate:**
`(cd packages/rfmedia-cli && npx vitest run src/actions/copy-filter.test.ts)`.

### T11 — Update all completion templates

**Files (3):**

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Actions:** add `--quick`, `--deep`, and `--tracking-database` to verify with accurate cost/evidence
descriptions. Add conflict-aware metadata in shells that support it without making shell behavior the
authority for invalid combinations.

**Validate:** package typecheck; T12 owns generated-script assertions.

### T12 — Enforce completion parity

**Files (1):**

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Actions:** assert all three generated scripts contain the new verify flags, database-path argument
handling, and stable descriptions; retain existing unrelated completion coverage.

**Validate:**
`(cd packages/rfmedia-cli && npx vitest run src/lib/shell-completions/templates.spec.ts)`.

### T13 — Build representative tier benchmarks

**Files (2):**

- `packages/rfmedia-cli/benchmarks/helpers.ts`
- `packages/rfmedia-cli/benchmarks/verify.bench.ts`

**Actions:** make benchmark options tier-complete; create one pre-populated exact inventory baseline;
run quick/default/deep on identical expected files, byte volumes, ranges, workers, and database
state; retain `RFMEDIA_BENCH_SCALES`/`RFMEDIA_BENCH_TRACK_BYTES`; expose file and byte throughput.
Do not add a timing assertion.

**Validate:** benchmark TypeScript check and a bounded smoke:

```bash
npm run typecheck -w packages/rfmedia-cli
RFMEDIA_BENCH_SCALES=10 RFMEDIA_BENCH_TRACK_BYTES=1048576 npm run bench:rfmedia
```

### T14 — Update verify and repair guides

**Files (2):**

- `packages/rfmedia-cli/docs/features/verify-command.doc.md`
- `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`

**Actions:** document tier selection, evidence/cost, exact baseline coverage, conversions, hardlinks,
unverifiable/unstable/not-applicable results, machine fields, exit behavior, staging, safe refusal,
dry-run, conflict strategies, and post-repair recheck.

**Validate:** Prettier and markdownlint on both files.

### T15 — Align hashing and integrity guides

**Files (2):**

- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`
- `docs/features/file-integrity-verification.md`

**Actions:** explain #111/PR #233/PR #248 as the final-artifact fingerprint producer and #116 as its
read-time consumer; distinguish integrity from authenticity; document schema-v9 null/ranged limits,
conversion semantics, and the no-backfill rule.

**Validate:** Prettier and markdownlint on both files.

### T16 — Update the rfmedia README

**Files (1):**

- `packages/rfmedia-cli/README.md`

**Actions:** update verify synopsis, option table, examples, default behavior, tier comparison,
coverage terminology, repair examples, machine result shape, exit codes, and links to detailed docs.

**Validate:** Prettier and markdownlint for the README.

### T17 — Record benchmark methodology and evidence

**Files (2):**

- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`
- `docs/plans/tiered-verification/benchmark-results.md` (create)

**Actions:** document the exact command, commit, Node version, filesystem/storage, warm/cold cache
qualification, file count/size, total bytes, workers, iterations, median quick/default/deep results,
files/s, MiB/s, and the computed quick/deep ratio. State honestly whether 10x was achieved and keep
CI limited to a smoke run.

**Validate:** rerun the recorded command, then Prettier and markdownlint both files.

### T18 — Update ROADMAP after the PR number exists

**Files (1):**

- `ROADMAP.md`

**Actions:** mark GitHub issue #116 shipped through the actual implementation PR, preserve links to
issue #111 and PRs #233/#248, and note truthful partial historical ranged coverage/follow-up status.
Do not mark complete when only a plan or draft implementation exists.

**Validate:** Prettier, markdownlint, and link/PR-number review.

## Dependency Analysis

### Wide dependency table

| Task | Direct prerequisites          | Transitive prerequisites      | Can run with       |
| ---- | ----------------------------- | ----------------------------- | ------------------ |
| T01  | —                             | —                             | —                  |
| T02  | T01                           | T01                           | T03, T04, T05      |
| T03  | T01                           | T01                           | T02, T04, T05      |
| T04  | T01                           | T01                           | T02, T03, T05      |
| T05  | T01                           | T01                           | T02, T03, T04      |
| T06  | T01, T03, T04                 | T01                           | —                  |
| T07  | T01, T06                      | T03, T04                      | T10                |
| T08  | T01, T03, T04, T05, T06       | —                             | T09, T10           |
| T09  | T01, T02, T03, T04, T05, T06  | —                             | T08, T10           |
| T10  | T02                           | T01                           | T07, T08, T09      |
| T11  | T07                           | T01, T03, T04, T06            | T08, T09, T10      |
| T12  | T11                           | T07 and its prerequisites     | T13–T15            |
| T13  | T03, T04, T06, T08, T09       | T01, T02, T05                 | T11, T12, T14, T15 |
| T14  | T07, T08, T09                 | all foundation tasks          | T11–T13, T15       |
| T15  | T03, T04, T06, T08, T09       | T01, T02, T05                 | T11–T14            |
| T16  | T07, T08, T09, T14, T15       | all foundation tasks          | T17                |
| T17  | T13                           | T01–T06, T08, T09             | T16                |
| T18  | T14, T15, T16, T17, PR number | implementation/public surface | —                  |
| G01  | T01–T18                       | all                           | —                  |
| G02  | G01                           | all                           | —                  |

### Dependency rules

1. Do not integrate actions before T06 freezes outcome and aggregate semantics; otherwise album and
   filter will recreate divergent status policy.
2. Do not open the database from T06 or the actions until T04 proves read-only behavior. Quick must
   bypass the database path entirely.
3. T08 and T09 share no files and are the main parallel implementation batch after foundations.
4. T10 may land as soon as T02 is available; T09 should not duplicate the allocator while waiting.
5. T11/T12 depend on the exact T07 option names and descriptions, not on action internals.
6. T13 waits for both actions so benchmark rows exercise production mapping and aggregation rather
   than only library microbenchmarks.
7. T14/T15 freeze user-visible semantics before T16 summarizes them in README.
8. T18 waits for recorded performance evidence and a real PR number; it is the last planned content
   edit before full validation/review.
9. Any review fix becomes a new task with explicit affected files and depends on the finding's
   originating task plus G01; rerun focused and downstream tests after it.

## File-to-Task Mapping

Every planned changed/created file has one owning task to avoid overlapping agents or ambiguous
review responsibility.

| Repository-relative path                                                       | Owner | Role                                    |
| ------------------------------------------------------------------------------ | ----- | --------------------------------------- |
| `packages/rfmedia-cli/src/types/options.ts`                                    | T01   | Tier/options contract                   |
| `packages/rfmedia-cli/src/types/results.ts`                                    | T01   | Per-file and aggregate outcomes         |
| `packages/rfmedia-cli/src/types/index.ts`                                      | T01   | Type exports                            |
| `packages/rfmedia-cli/src/lib/verify.ts`                                       | T02   | Shared deterministic destination naming |
| `packages/rfmedia-cli/src/lib/verify.test.ts`                                  | T02   | Naming/helper tests                     |
| `packages/rfmedia-cli/src/lib/integrity.ts`                                    | T03   | Abort-aware hash and byte comparison    |
| `packages/rfmedia-cli/src/lib/integrity.test.ts`                               | T03   | Real-file integrity tests               |
| `packages/rfmedia-cli/src/types/db.ts`                                         | T04   | Fingerprint candidate DTO               |
| `packages/rfmedia-cli/src/lib/db.ts`                                           | T04   | Read-only opener and candidate query    |
| `packages/rfmedia-cli/src/lib/db.test.ts`                                      | T04   | No-mutation and identity tests          |
| `packages/rfmedia-cli/src/lib/filesystem.ts`                                   | T05   | Staged atomic replacement               |
| `packages/rfmedia-cli/src/lib/filesystem.test.ts`                              | T05   | Original-preservation/cleanup tests     |
| `packages/rfmedia-cli/src/lib/tiered-verification.ts`                          | T06   | Tier policy, resolution, aggregation    |
| `packages/rfmedia-cli/src/lib/tiered-verification.test.ts`                     | T06   | Tier matrix tests                       |
| `packages/rfmedia-cli/src/commands/verify.ts`                                  | T07   | CLI and machine/exit contract           |
| `packages/rfmedia-cli/src/cli.test.ts`                                         | T07   | CLI regression tests                    |
| `packages/rfmedia-cli/src/actions/verify-album.ts`                             | T08   | Album integration/repair                |
| `packages/rfmedia-cli/src/actions/verify-album.test.ts`                        | T08   | Album integration tests                 |
| `packages/rfmedia-cli/src/actions/verify-filter.ts`                            | T09   | Filter integration/repair               |
| `packages/rfmedia-cli/src/actions/verify-filter.test.ts`                       | T09   | Filter layout tests                     |
| `packages/rfmedia-cli/src/actions/copy-filter.ts`                              | T10   | Copy-time naming reuse                  |
| `packages/rfmedia-cli/src/actions/copy-filter.test.ts`                         | T10   | Copy/verify mapping regression          |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`                       | T11   | Bash options                            |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`                        | T11   | Zsh options                             |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`                       | T11   | Fish options                            |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`             | T12   | Completion parity                       |
| `packages/rfmedia-cli/benchmarks/helpers.ts`                                   | T13   | Benchmark fixtures/options              |
| `packages/rfmedia-cli/benchmarks/verify.bench.ts`                              | T13   | Tier benchmark rows                     |
| `packages/rfmedia-cli/docs/features/verify-command.doc.md`                     | T14   | User verification guide                 |
| `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`                    | T14   | Safe repair guide                       |
| `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md` | T15   | Baseline producer contract              |
| `docs/features/file-integrity-verification.md`                                 | T15   | Cross-feature integrity guide           |
| `packages/rfmedia-cli/README.md`                                               | T16   | Main CLI reference                      |
| `packages/rfmedia-cli/docs/features/performance-benchmarks.md`                 | T17   | General benchmark method                |
| `docs/plans/tiered-verification/benchmark-results.md`                          | T17   | Reproducible #116 evidence              |
| `ROADMAP.md`                                                                   | T18   | Delivery status and links               |

Explicitly reuse without planned modification:

- `packages/rfmedia-cli/src/lib/config.ts` (`resolveUndoDatabasePath()` precedence);
- `packages/rfmedia-cli/src/lib/parallel.ts` (single bounded scheduler);
- `packages/rfmedia-cli/src/lib/signal-handler.ts` (global cancellation);
- `packages/rfmedia-cli/src/lib/schema.sql` and `packages/rfmedia-cli/src/lib/migrations.ts`
  (schema remains version 9);
- copy/sync/Plex/playlist/watch/video producers outside the named copy-filter mapping reuse.
