# Tiered Verification Implementation Plan

Close issue #116 by extending `rfmedia verify` with quick metadata checks, default stored-fingerprint verification, and cumulative deep byte comparison while preserving the existing album/filter traversal and repair authorization. Add a read-only schema-v9 evidence consumer, bounded and cancellation-aware integrity primitives, one shared per-file policy and aggregation contract, and evidence-preserving staged repair without adding a migration or dependency. Expose the additive result contract through the CLI and all completion templates, then update the canonical guides, README, benchmark evidence, and ROADMAP. Finish with repository validation, graph refresh, formal review/fix, green CI, squash merge, issue closure, and branch/worktree cleanup.

## Critically Relevant Files and Documentation

- `docs/plans/tiered-verification/feature-spec.md`: Authoritative semantics, edge cases, and acceptance criteria.
- `docs/plans/tiered-verification/shared.md`: Verified architecture, patterns, database tables, and required reading.
- `docs/plans/tiered-verification/research-security.md`: Read-only database, path, mutation, and repair threat model.
- `packages/rfmedia-cli/src/commands/verify.ts`: CLI options, mode dispatch, machine output, and exit decision.
- `packages/rfmedia-cli/src/actions/verify-album.ts`: Album/range traversal, extras, progress, and repair.
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: Flat, structured, and album-filter traversal and repair.
- `packages/rfmedia-cli/src/lib/integrity.ts`: Existing streaming SHA-256 boundary.
- `packages/rfmedia-cli/src/lib/db.ts`: Writable initializer and inventory access to keep separate from verification reads.
- `packages/rfmedia-cli/src/lib/filesystem.ts`: Copy, conversion support, path safety, and replacement primitives.
- `packages/rfmedia-cli/src/lib/verify.ts`: Expected-name, size, and extra-file helpers.
- `packages/rfmedia-cli/src/lib/schema.sql`: Schema-v9 evidence model and explicit non-touch file.
- `packages/rfmedia-cli/src/lib/migrations.ts`: Schema-version contract and explicit non-touch file.
- `packages/rfmedia-cli/docs/features/verify-command.doc.md`: Canonical user-facing verify contract.
- `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`: Canonical repair contract.
- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`: Issue #111 baseline producer contract.
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`: Benchmark methodology contract.
- `ROADMAP.md`: Issue #116 status and relationship to issue #111/PRs #233 and #248.
- `.github/pull_request_template.md`: Required PR body structure.

## Implementation Plan

### Phase 1: Contracts and Independent Foundations

#### Task 1.1: Define Additive Verification Contracts Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/tiered-verification/feature-spec.md`
- `packages/rfmedia-cli/src/types/options.ts`
- `packages/rfmedia-cli/src/types/results.ts`
- `packages/rfmedia-cli/src/types/index.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/types/options.ts`
- `packages/rfmedia-cli/src/types/results.ts`
- `packages/rfmedia-cli/src/types/index.ts`

Add `VerificationTier`, the required effective tier, and optional tracking-database path. Extend file statuses, reasons/evidence, aggregate counters, and repair results additively while preserving existing fields. Keep `not-applicable` distinct from the non-success `unverifiable` state, export every public contract, and allow expected downstream compile failures only until callers adopt the required tier.

**Validate**

- Run `npm run typecheck -w packages/rfmedia-cli`; temporary downstream errors must be limited to call sites scheduled later.

#### Task 1.2: Centralize Deterministic Destination Naming Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/verify.ts`
- `packages/rfmedia-cli/src/actions/copy-filter.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/verify.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/lib/verify.ts`

Add a pure, stable destination-name allocator for case-insensitive duplicate basenames using the established `-002`, `-003` convention. Cover converted extensions, case variants, directory separation, and input-order determinism; preserve existing expected-name and extra-file behavior.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/lib/verify.test.ts` and require all cases to pass.

#### Task 1.3: Implement Abort-Aware Integrity Primitives Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/integrity.ts`
- `packages/rfmedia-cli/src/lib/integrity.test.ts`
- `docs/plans/tiered-verification/research-security.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/integrity.ts`
- `packages/rfmedia-cli/src/lib/integrity.test.ts`

Make `calculateHash()` accept an optional `AbortSignal` and remove full-digest logging. Add fixed-buffer, short-read/EOF-correct direct comparison using open handles, regular-file validation, same-inode evidence, before/after stability checks, abort checkpoints, and `finally` cleanup. Use real temporary files for equal, different, empty, multi-chunk, unequal-length, hardlink, abort, and descriptor-cleanup tests; expose a deterministic test seam for concurrent mutation instead of relying on timing. Assert results and logs never expose full digests.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/lib/integrity.test.ts` and `npm run typecheck -w packages/rfmedia-cli`.

#### Task 1.4: Add Exact Read-Only Fingerprint Access Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/db.ts`
- `packages/rfmedia-cli/src/lib/db.test.ts`
- `packages/rfmedia-cli/src/types/db.ts`
- `packages/rfmedia-cli/src/lib/schema.sql`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/types/db.ts`
- `packages/rfmedia-cli/src/lib/db.ts`
- `packages/rfmedia-cli/src/lib/db.test.ts`

Add the joined fingerprint-candidate DTO, an existing-file read-only/query-only opener, and a parameterized inventory/operations candidate query ordered deterministically. Validate supported schema and returned path/hash/metadata values without executing schema, migrating, changing journal mode, or creating database/WAL/SHM files. Cover missing/old/new/malformed databases, empty source input, quoted paths, null/invalid hashes, duplicate candidates, deterministic ordering, and before/after filesystem/schema immutability.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/lib/db.test.ts` and require the no-mutation filesystem/schema assertions to pass.

#### Task 1.5: Add Staged Atomic Replacement Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`
- `docs/plans/tiered-verification/research-security.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`

Add a narrow helper that creates an exclusive private sibling artifact, invokes materialize and validate callbacks with an `AbortSignal`, revalidates containment and parent identity, atomically replaces the destination, and cleans the staged file on every pre-commit error. Require this staged-and-validated path for every repaired content artifact, including a missing destination. Prove an existing original survives materialization, validation, abort, and commit failures; do not introduce broad recursive cleanup or rebaseline behavior.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/lib/filesystem.test.ts` and require cleanup/original-preservation cases to pass.

#### Task 1.6: Implement Shared Tier Policy and Aggregation Depends on [1.1, 1.3, 1.4]

**READ THESE BEFORE TASK**

- `docs/plans/tiered-verification/feature-spec.md`
- `packages/rfmedia-cli/src/lib/integrity.ts`
- `packages/rfmedia-cli/src/lib/db.ts`
- `packages/rfmedia-cli/src/types/results.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/tiered-verification.ts`
- `packages/rfmedia-cli/src/lib/tiered-verification.test.ts`

Files to Modify

- None.

Implement exact destination/source/relative-path/conversion baseline resolution, exhaustive tier dispatch, quick size-plus-integer-mtime checks, default destination-hash comparison, and cumulative deep comparison. Converted output and same-inode hardlinks retain successful stored-hash evidence with direct comparison marked `not-applicable`; invalid, null, ambiguous, or unrepresented evidence is `unverifiable`. Add result initialization, outcome transition, merge, deterministic ordering, and one unresolved predicate. Cover quick with no database/content calls; default with valid, missing, null, malformed, ambiguous, converted, hardlink, and ranged evidence; deep with equal, different, unequal-length, missing-source, converted, same-inode, unstable, and aborted files; every unresolved counter and merge order; and additive `--verify-size` behavior.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/lib/tiered-verification.test.ts` and `npm run typecheck -w packages/rfmedia-cli`.

### Phase 2: CLI and Action Integration

#### Task 2.1: Wire the CLI and Machine Contract Depends on [1.1, 1.6]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/verify.ts`
- `packages/rfmedia-cli/src/cli.test.ts`
- `packages/rfmedia-cli/src/lib/tiered-verification.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/commands/verify.ts`
- `packages/rfmedia-cli/src/cli.test.ts`

Add parser-conflicting `--quick` and `--deep`, optional `--tracking-database`, and no-flag default tier. Resolve the database path as explicit CLI over configured tracking/undo compatibility over default, without initializing it; quick bypasses resolution entirely. Propagate the effective contract, preserve `--verify-size` as an additive precheck, announce the tier and differentiated summary in human output, extend JSON/YAML/table/CSV output additively without full digests, and drive process exit through the shared unresolved predicate including extras. Prove conflicts fail before action, database, or filesystem work.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/cli.test.ts` with explicit JSON/YAML/table/CSV assertions in that suite, then `npm run typecheck -w packages/rfmedia-cli`.

#### Task 2.2: Integrate Album Verification and Safe Repair Depends on [1.1, 1.3, 1.4, 1.5, 1.6]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/verify-album.ts`
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`
- `packages/rfmedia-cli/src/lib/tiered-verification.ts`
- `packages/rfmedia-cli/src/lib/filesystem.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/verify-album.ts`
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`

Preserve album-only/artist traversal, suffixes, range precedence, multiple/file input, conversion filenames, progress, extras, and conflict authorization. Preload candidates once only for content tiers, build absolute tasks, pass the worker signal into the shared verifier, and aggregate typed outcomes. Prove all tiers derive the same expected/missing/extra set, kept extras remain unresolved, converted quick is unavailable, converted/same-inode deep exposes `not-applicable`, and human progress/summary names the tier and counters. Stage and validate every repaired content artifact, preserve the destination on refusal/failure, and count success only after final-path selected-tier re-verification.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/actions/verify-album.test.ts` and require all traversal/tier/repair matrix cases to pass.

#### Task 2.3: Integrate Every Filter Verification Layout Depends on [1.1, 1.2, 1.3, 1.4, 1.5, 1.6]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/verify-filter.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`
- `packages/rfmedia-cli/src/lib/verify.ts`
- `packages/rfmedia-cli/src/lib/tiered-verification.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/verify-filter.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`

Preserve rating/metadata selection, flat, preserve-structure and album layouts, ranges, conversions, multiple-source precedence, and extras. Precompute deterministic destination tasks before parallel I/O, resolve exact evidence once, and exercise quick/default/deep across each layout plus duplicates, ranges, conversions, hardlinks, unavailable evidence, kept extras, and human progress/summary. Stage and validate every repaired content artifact, preserve destinations on refusal/failure, and use final-path tier rechecks and shared aggregation in every loop.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/actions/verify-filter.test.ts` and require all layout/tier/repair matrix cases to pass.

#### Task 2.4: Align Copy-Filter Destination Mapping Depends on [1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/copy-filter.ts`
- `packages/rfmedia-cli/src/actions/copy-filter.test.ts`
- `packages/rfmedia-cli/src/lib/verify.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/copy-filter.ts`
- `packages/rfmedia-cli/src/actions/copy-filter.test.ts`

Replace the private duplicate-name allocator with the shared helper without changing existing outputs. Add regressions proving copy and verify derive the same flat destination sequence for duplicate and case-variant basenames, including conversion.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/actions/copy-filter.test.ts src/lib/verify.test.ts`.

### Phase 3: Public Surface, Performance Evidence, and Documentation

#### Task 3.1: Update Bash, Zsh, and Fish Completion Templates Depends on [2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

Add `--quick`, `--deep`, and `--tracking-database` to verify with accurate evidence/cost descriptions and path argument handling. Add conflict-aware metadata where supported, but keep Commander as the authority.

**Validate**

- Run `npm run typecheck -w packages/rfmedia-cli` and inspect generated Bash/Zsh/Fish verify blocks.

#### Task 3.2: Enforce Completion Parity Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Assert all three generated scripts contain the same new verify flags, database-path completion behavior, and stable descriptions without weakening unrelated completion coverage.

**Validate**

- Run `npm run test:run -w packages/rfmedia-cli -- src/lib/shell-completions/templates.spec.ts`.

#### Task 3.3: Build Representative Tier Benchmarks Depends on [1.3, 1.4, 1.6, 2.2, 2.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/benchmarks/helpers.ts`
- `packages/rfmedia-cli/benchmarks/verify.bench.ts`
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/benchmarks/helpers.ts`
- `packages/rfmedia-cli/benchmarks/verify.bench.ts`

Create one exact inventory-backed fixture and compare production quick/default/deep paths with identical expected files, bytes, ranges, workers, and database state. Retain configurable scale/track-byte controls, report files/s and content-tier MiB/s, preserve the reduced CI smoke in `.github/workflows/rfmedia-cli.yml` without editing it unless broken, and keep the separate representative evidence run free of timing assertions.

**Validate**

- Run `npm run typecheck -w packages/rfmedia-cli` and `RFMEDIA_BENCH_SCALES=10 RFMEDIA_BENCH_TRACK_BYTES=1048576 npm run bench:rfmedia`; require all three tier rows without asserting ratios.

#### Task 3.4: Update Verify and Repair Guides Depends on [2.1, 2.2, 2.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/verify-command.doc.md`
- `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`
- `docs/plans/tiered-verification/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/docs/features/verify-command.doc.md`
- `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`

Document selection, guarantee/cost matrix, exact baseline coverage, conversions, hardlinks, missing evidence, instability, machine fields, exit behavior, repair proof/staging/refusal, dry-run, conflicts, and final recheck. Never imply a fingerprint is authenticity evidence or that verification backfills it.

**Validate**

- Run `npx prettier --check packages/rfmedia-cli/docs/features/verify-command.doc.md packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md` and `npm run lint:md -- packages/rfmedia-cli/docs/features/verify-command.doc.md packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`.

#### Task 3.5: Align Hashing, Database, and Integrity Guides Depends on [1.3, 1.4, 1.6, 2.1, 2.2, 2.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- `docs/features/file-integrity-verification.md`
- `docs/plans/tiered-verification/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- `docs/features/file-integrity-verification.md`

Explain issue #111/PRs #233 and #248 as the final-artifact fingerprint producer and #116 as its read-only schema-v9 consumer. Distinguish integrity from authenticity and copy-time read-back from later verification; document configured path precedence, no-create/no-migrate behavior, nullable legacy rows, ranged limitations, conversions, and no backfill. Audit older `docs/features/file-integrity-*.md` pages read-only for confusing scope; do not edit undeclared files, and report any remaining stale page as a non-blocking follow-up.

**Validate**

- Run `npx prettier --check packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md docs/features/file-integrity-verification.md` and `npm run lint:md -- packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md docs/features/file-integrity-verification.md`; confirm no schema-v10 or authenticity claim.

#### Task 3.6: Update the Main rfmedia CLI Reference Depends on [2.1, 2.2, 2.3, 3.4, 3.5]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/verify-command.doc.md`
- `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/README.md`

Update the synopsis, option table, tier comparison, default behavior, coverage terms, repair examples, machine shape, exit codes, and detailed-document links using the final implemented field names.

**Validate**

- Run `npx prettier --check packages/rfmedia-cli/README.md` and `npm run lint:md -- packages/rfmedia-cli/README.md`.

#### Task 3.7: Create the Implementation Checkpoint and Draft PR Depends on [2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/tiered-verification/feature-spec.md`
- `docs/plans/tiered-verification/parallel-plan.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None expected.

Run all focused suites plus package typecheck/build and `git diff --check`, audit the staged scope, create an intentional implementation checkpoint commit, push the feature branch, and open a draft template-compliant PR with `Closes #116`, exact validation outcomes, risk/rollback, and the current benchmark-smoke result. Capture the checkpoint commit and PR number for Tasks 3.8 and 3.9; do not begin formal review or merge yet.

**Validate**

- Require a clean checkpoint after `npm run typecheck -w packages/rfmedia-cli`, `npm run test:run -w packages/rfmedia-cli`, `npm run build:rfmedia`, and `git diff --check`; verify the draft PR body preserves every required template section and contains `Closes #116`.

#### Task 3.8: Record Benchmark Methodology and Evidence Depends on [3.7]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`
- `packages/rfmedia-cli/benchmarks/verify.bench.ts`
- `docs/plans/tiered-verification/feature-spec.md`

**Instructions**

Files to Create

- `docs/plans/tiered-verification/benchmark-results.md`

Files to Modify

- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`

Record the exact command, commit, Node version, storage/filesystem, cache qualification, file count/size, byte volume, workers, iterations, medians, files/s, MiB/s, and quick/deep ratio. State honestly whether the 10x target was achieved and keep CI limited to a smoke.

**Validate**

- Run `RFMEDIA_BENCH_SCALES=25 RFMEDIA_BENCH_TRACK_BYTES=8388608 npm run bench:rfmedia` against the Task 3.7 checkpoint, then `npx prettier --check packages/rfmedia-cli/docs/features/performance-benchmarks.md docs/plans/tiered-verification/benchmark-results.md` and `npm run lint:md -- packages/rfmedia-cli/docs/features/performance-benchmarks.md docs/plans/tiered-verification/benchmark-results.md`.

#### Task 3.9: Update ROADMAP with Real Delivery Evidence Depends on [3.4, 3.5, 3.6, 3.7, 3.8]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/plans/tiered-verification/feature-spec.md`
- `docs/plans/tiered-verification/benchmark-results.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`

Update every #116 entry using the actual draft PR number and benchmark evidence. Preserve issue #111 and PRs #233/#248 linkage and describe truthful historical ranged coverage. The implementation PR may change the checkbox/row to shipped because that edit becomes authoritative only when the PR merges; the draft state itself is not evidence that delivery has completed.

**Validate**

- Run `npx prettier --check ROADMAP.md`, `npm run lint:md -- ROADMAP.md`, and manually verify every #116 occurrence and PR link.

### Phase 4: Validation and Delivery

#### Task 4.1: Run Full Validation and Refresh the Knowledge Graph Depends on [2.4, 3.2, 3.8, 3.9]

**READ THESE BEFORE TASK**

- `package.json`
- `packages/rfmedia-cli/package.json`
- `docs/plans/tiered-verification/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- No tracked files expected; `graphify update .` may create ignored `graphify-out/` artifacts.

Run `npm run format:check`, rfmedia package typecheck/full tests/build, repository Markdown lint, `RFMEDIA_BENCH_SCALES=10 RFMEDIA_BENCH_TRACK_BYTES=1048576 npm run bench:rfmedia`, representative evidence review, `git diff --check`, and `graphify update .`. Verify all planned created files exist and schema/migrations are unchanged; audit the final diff for secrets and generated noise. Fix every in-scope failure, rerun affected focused/downstream gates, then commit and push benchmark/ROADMAP or validation fixes and update the draft PR body with final local evidence.

**Validate**

- Require zero in-scope failures from `npm run format:check`, `npm run typecheck -w packages/rfmedia-cli`, `npm run test:run -w packages/rfmedia-cli`, `npm run build:rfmedia`, `npm run lint:md`, `RFMEDIA_BENCH_SCALES=10 RFMEDIA_BENCH_TRACK_BYTES=1048576 npm run bench:rfmedia`, `git diff --check`, and `graphify update .`.

#### Task 4.2: Deliver Through Review, CI, Merge, and Cleanup Depends on [4.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/tiered-verification/feature-spec.md`
- `docs/plans/tiered-verification/parallel-plan.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None expected; review findings may require focused source/test/doc fixes.

Run the formal review workflow on the draft PR, fix every actionable finding, resolve review threads, and after each fix rerun affected focused suites, package typecheck/build, `git diff --check`, and `graphify update .` before committing and pushing. Mark the PR ready, monitor required CI to green, squash-merge, and verify #116 closed. From the primary checkout or another directory—not from inside the worktree being removed—update local `master`, remove the feature worktree/branch, and delete the remote feature branch without touching unrelated user changes.

**Validate**

- Require zero unresolved actionable review threads; use `gh pr checks <PR_NUMBER> --watch`, `gh pr view <PR_NUMBER> --json state,mergedAt,mergeCommit,statusCheckRollup`, and `gh issue view 116 --json state` to prove green checks, squash merge, and closure. From the primary checkout, use `git worktree list`, `git branch --list 'feat/116-tiered-verification'`, `git ls-remote --heads origin 'feat/116-tiered-verification'`, and `git status --short` to prove cleanup.

## Advice

- Treat `docs/plans/tiered-verification/feature-spec.md` as authoritative where research explored alternatives; do not broaden #116 into a destination-ledger migration.
- Quick must never resolve/open SQLite or read content, while default/deep must never silently fall back when exact evidence is absent.
- Precompute filter destination names before parallel work so duplicate mapping cannot depend on completion order.
- Hash the destination only once for default/deep and pass the worker signal through every active read; memory must remain bounded by workers times chunk size.
- Inventory paths are untrusted claims that may confirm current-scope identity but may never redirect reads or repairs outside the selected destination.
- Converted output and same-inode hardlinks can succeed with stored-hash coverage while the direct check is visibly `not-applicable`; that is not the same as `unverifiable`.
- Repair success is a final selected-tier recheck, not arithmetic based on copy/remove counts, and repair never refreshes the stored baseline.
- Keep `packages/rfmedia-cli/src/lib/schema.sql` and `packages/rfmedia-cli/src/lib/migrations.ts` unchanged; schema-v9 ranged gaps remain explicit coverage limitations.
- Run the 10x comparison as recorded evidence, not a CI wall-clock assertion, and report an unmet or inconclusive target honestly.
- The implementation PR may carry the ROADMAP completion edit with its own PR number; treat it as authoritative only when that PR merges.
