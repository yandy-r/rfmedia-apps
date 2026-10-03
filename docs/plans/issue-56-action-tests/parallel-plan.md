# Issue #56 Critical Action Coverage Implementation Plan

Expand the four requested action suites through distinct behavioral contracts, while correcting
only the production defects those contracts directly expose. Verification remains observation
based, sync preserves classification through materialization and persistence, and migration gains
library-owned durable proof before any legacy cleanup. Work is split into disjoint file owners in
one dedicated feature worktree, followed by per-file coverage, completion parity, documentation,
ROADMAP, repository hooks, registered CI, review, and squash-merge closeout.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-test-56-action-coverage
- **Branch**: `test/56-action-coverage`
- This worktree and branch already exist and track `origin/master`; implementation must use them
  directly and must not create, move, or remove another worktree.

## Critically Relevant Files and Documentation

- `docs/plans/issue-56-action-tests/feature-spec.md`: accepted scope, invariants, and coverage bar
- `docs/plans/issue-56-action-tests/shared.md`: repository architecture and implementation patterns
- `packages/rfmedia-cli/src/actions/verify-album.ts`: album verification and final re-observation flow
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: filter eligibility, allocation, and repair flow
- `packages/rfmedia-cli/src/actions/sync.ts`: inventory-classified materialization and persistence flow
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts`: manual migration discovery and cleanup owner
- `packages/rfmedia-cli/src/lib/completed-tracker.ts`: existing legacy sidecar parsing and DB writes
- `packages/rfmedia-cli/src/lib/history.ts`: existing JSONL history import owner
- `packages/rfmedia-cli/src/lib/filesystem.ts`: path, staging, removal, and partial-file primitives
- `packages/rfmedia-cli/src/lib/db.ts`: operation, completed/failed source, history, and lifecycle APIs
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Bash/Zsh/Fish parity contract
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Bash completion template
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Zsh completion template
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Fish completion template
- `packages/rfmedia-cli/README.md`: public migration promises and examples
- `packages/rfmedia-cli/docs/features/undo-history-system.md`: history migration semantics
- `ROADMAP.md`: live issue completion references

## Implementation Plan

### Phase 1: Independent Action Contracts and Durable Import Seams

#### Task 1.1: Prove Album Missing and Repair Truth Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-56-action-tests/feature-spec.md`
- `docs/plans/issue-56-action-tests/shared.md`
- `packages/rfmedia-cli/src/actions/verify-album.ts`
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/verify-album.test.ts`

Extend the existing exported-action harness with only missing behavioral partitions: dense missing
detection without mutation, successful staged repair followed by final-path re-observation, and a
failed final recheck that remains unresolved. Add one range/batch lifecycle case only if it proves a
currently uncovered resource or precedence contract. Reuse the suite's hoisted mocks, restore
path-sensitive defaults in each test, keep workers deterministic, and do not repeat the existing
mismatch, extra-file, force, trash, prompt, or dry-run matrix. Run this file alone and its focused
coverage; do not edit production code or shared helpers.

#### Task 1.2: Prove Filter Eligibility and Exact Missing Mapping Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-56-action-tests/feature-spec.md`
- `docs/plans/issue-56-action-tests/shared.md`
- `packages/rfmedia-cli/src/actions/verify-filter.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`

Cover eligible missing files while proving filtered-out sources never enter the expected set.
Exercise exact flat and one representative structured or ranged destination mapping, successful
repair with final re-observation, and failed recheck truth. Add a contained batch-failure case only
if necessary for a distinct uncovered contract. Preserve this suite's allocation/evidence mocks;
do not introduce a shared verify harness or duplicate its existing mismatch, extra, prompt, force,
trash, conversion, and dry-run permutations. Run the file alone and inspect focused coverage.

#### Task 1.3: Preserve Sync Classification, Ordering, and Safe Cleanup Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-56-action-tests/feature-spec.md`
- `docs/plans/issue-56-action-tests/shared.md`
- `packages/rfmedia-cli/src/actions/sync.ts`
- `packages/rfmedia-cli/src/actions/sync.test.ts`
- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/inventory.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/sync.ts`
- `packages/rfmedia-cli/src/actions/sync.test.ts`

Carry explicit `new` versus `updated` intent into the existence decision so an inventory-classified
update can replace its represented destination without globally forcing unrelated new collisions.
Retain `materialize -> hash -> append inventory -> count` and one inventory row per source. Add
scenario-dense tests for new/updated/unchanged counts, missing-source and per-file continuation,
database versus legacy lifecycle, abort partial-file cleanup, and media-scan gating. For downgrade
cleanup, treat persisted destination paths as untrusted and prove component-aware containment and
regular-file safety without weakening it under force; keep the outside-root sentinel intact. Do
this action-locally using existing filesystem APIs; do not modify `lib/filesystem.ts`, inventory
diff algorithms, or public action/MCP shapes. Run focused tests and coverage.

#### Task 1.4: Expose Durable Tracking-Sidecar Import Proof Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-56-action-tests/feature-spec.md`
- `docs/plans/issue-56-action-tests/shared.md`
- `packages/rfmedia-cli/src/lib/completed-tracker.ts`
- `packages/rfmedia-cli/src/lib/completed-tracker.test.ts`
- `packages/rfmedia-cli/src/lib/db.ts`
- `packages/rfmedia-cli/src/lib/schema.sql`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/completed-tracker.ts`
- `packages/rfmedia-cli/src/lib/completed-tracker.test.ts`

Promote or wrap the existing private legacy importer as one library-owned, compatibility-preserving
seam. Accept explicit operation identity and optional completed/failed sidecar paths, preserve input
identity in addition to options hash and mode, transact writes, read back durable equivalence, and
return counts plus exact files proven imported or already equivalent. Automatic initialization
must retain its current behavior. Use real temporary SQLite tests for same-hash distinct inputs,
completed/failed rows, malformed input, transaction failure, and already-equivalent idempotency.
Keep proof types internal to this library boundary and make no schema change.

#### Task 1.5: Make History Migration Root-Consistent and Atomic Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-56-action-tests/feature-spec.md`
- `docs/plans/issue-56-action-tests/shared.md`
- `packages/rfmedia-cli/src/lib/history.ts`
- `packages/rfmedia-cli/src/lib/db.ts`
- `packages/rfmedia-cli/src/lib/schema.sql`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/history.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/lib/history.ts`

Allow `migrateLegacyHistory()` to accept the resolved history directory while retaining
`getHistoryDir()` as its default. Fully validate a JSONL session before it becomes cleanup-eligible,
import atomically, read back equivalence, and return per-file imported/already-equivalent/failed
proof. A malformed or conflicting session must remain deletion-ineligible and must not leave a
partial session. Add real temporary SQLite coverage for custom paths, valid import, malformed
retention, equivalence, and transaction failure. Preserve automatic migration callers and schema.

### Phase 2: Migration Action Orchestration

#### Task 2.1: Persist Manual Migration and Gate Every Cleanup Depends on [1.4, 1.5]

**READ THESE BEFORE TASK**

- `docs/plans/issue-56-action-tests/feature-spec.md`
- `docs/plans/issue-56-action-tests/shared.md`
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts`
- `packages/rfmedia-cli/src/lib/completed-tracker.ts`
- `packages/rfmedia-cli/src/lib/history.ts`
- `packages/rfmedia-cli/src/types/results.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/migrate-tracking.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/migrate-tracking.ts`

Replace count-only tracking migration with the Task 1.4 importer, grouping by captured input
identity plus options hash and rejecting duplicate/malformed groups. Resolve history once and pass
the same root to discovery and Task 1.5 import. Build deletion candidates solely from durable
per-file proof; `--force` bypasses only confirmation. Immediately before non-recursive unlink,
revalidate captured-root containment, regular-file identity, and symlink safety, then contain
sibling unlink failures. Put database ownership in `try/finally` so non-dry-run closes exactly once;
dry-run must never initialize DB, import, prompt, unlink, or otherwise mutate. Cover routing flags,
same-hash distinct inputs, custom history root, malformed/partial input, selective cleanup,
confirmation/force, unlink errors, and thrown-import close behavior while preserving `MigrateResult`.

### Phase 3: Evidence, Documentation, Completion Parity, and ROADMAP

#### Task 3.1: Enforce Per-Action Critical Coverage Depends on [1.1, 1.2, 1.3, 2.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-56-action-tests/feature-spec.md`
- `packages/rfmedia-cli/vitest.config.ts`
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`
- `packages/rfmedia-cli/src/actions/sync.test.ts`
- `packages/rfmedia-cli/src/actions/migrate-tracking.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- None unless a named action misses the accepted threshold; return that gap to its original owner.

Run the four focused suites together and V8 coverage with explicit includes for each action file.
Require at least 80% statements and lines for every named file, not just their aggregate. If a file
misses, identify a distinct uncovered behavioral partition, reactivate that suite's original owner,
and repeat its focused test/coverage gate before recomputing all four files. Do not add decorative
logs, private-helper tests, redundant permutations, or a global threshold. Re-run files alone and
together to expose mock leakage.

#### Task 3.2: Document Durable Migration Semantics Depends on [2.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-56-action-tests/feature-spec.md`
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/undo-history-system.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/undo-history-system.md`

Align the two user-facing documents with the implemented behavior: durable or already-equivalent
success, proof-gated per-file `--delete-old`, force as prompt bypass only, partial failures retained,
and one explicit history root used for discovery and import. Audit verify/sync documentation and
leave it unchanged when the fix restores already documented behavior. Follow markdownlint and do
not describe internal proof types.

#### Task 3.3: Audit Bash, Zsh, and Fish Completion Parity Depends on [1.1, 1.2, 1.3, 2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/index.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- `packages/rfmedia-cli/src/commands/migrate.ts`
- `packages/rfmedia-cli/src/commands/sync.ts`
- `packages/rfmedia-cli/src/commands/verify.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Confirm no command, option, result, or completion surface changed. Audit the Bash, Zsh, and Fish
templates explicitly and run their parity suite under Node 22. Record the audit result for the PR;
do not edit generated/templates merely to create a diff.

### Phase 4: Repository Verification and Full Delivery

#### Task 4.1: Run Node 22 Package, Repository, and Hook Gates Depends on [3.1, 3.2, 3.3]

**READ THESE BEFORE TASK**

- `.mise.toml`
- `lefthook.yml`
- `.github/workflows/rfmedia-cli.yml`
- `package.json`
- `packages/rfmedia-cli/package.json`

**Instructions**

Files to Create

- None.

Files to Modify

- None unless a gate exposes a defect attributable to this change; return it to the owning task.

Under `mise exec`, run focused tests and per-file coverage, rfmedia typecheck/full suite/coverage,
completion parity, architecture and generated-client gates, build, Markdown lint, and
`git diff --check`. Run generated Lidarr/codegen gates serially. Exercise the real repository hook
path without bypassing lefthook; if `better-sqlite3` has a Node ABI mismatch, rebuild it under the
pinned Node 22 runtime before diagnosing source. If `graphify-out/graph.json` exists in this
worktree, run `graphify update .`; otherwise record the graph as absent rather than initializing a
new one. Confirm the diff contains only intended issue #56 work; committed-clean verification
belongs to Task 4.3.

#### Task 4.2: Close ROADMAP Issue #56 Parity Depends on [4.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `.github/ISSUE_TEMPLATE/enhancement.yml`
- `docs/plans/issue-56-action-tests/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`

Refresh live GitHub issue state immediately before editing. Remove all three live #56 references,
keep headings and counts internally consistent, and record completion using the ROADMAP's existing
shipped/archive convention without rewriting unrelated history. Run Markdown formatting/lint and
verify no stale live #56 reference remains.

#### Task 4.3: Review, Publish, Resolve, and Squash-Merge Depends on [4.2]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/issue-56-action-tests/parallel-plan.md`
- `docs/plans/issue-56-action-tests/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None unless code review or registered CI produces an actionable finding.

Run a final code review over the feature diff and resolve all valid findings with focused
reverification. Commit intentionally, verify the worktree is clean after that intended commit, then
push the active branch and open a PR using every required template section and `Closes #56`.
Report exact command outcomes plus unchanged CLI/MCP/schema/completion audits. Monitor registered
CI for the active head SHA, inspect every review thread and comment, apply necessary fixes without
shortcuts, and re-run affected gates. Once CI is green and threads are resolved, squash-merge,
verify the issue is closed and remote default branch contains the merge, delete the remote feature
branch, remove only this dedicated worktree, and confirm the primary checkout and unrelated
worktrees remain untouched.

## Advice

- Migration discovery counts are preview information only; durable read-back proof is the sole
  authority for cleanup.
- Tracking identity is `(input identity, options hash, mode)`. Hash-only grouping silently combines
  unrelated runs and must never return cleanup proof.
- An inventory destination is untrusted data. Component-aware canonical containment and a
  regular-file check are mandatory even when force is set.
- Updated sync work may overwrite only the destination represented by its inventory classification;
  global force would turn a narrow correction into a new-file collision regression.
- Keep successful verification, sync, and migration counters at their final truth boundary:
  re-observation, persisted inventory, and committed/equivalent DB rows respectively.
- The existing worktree is the only implementation boundary. Workers must not stage, format,
  revert, or commit files owned by another task, and broad auto-fixers are unsafe during parallel
  batches.
