# Issue 305 Secure-Store Plan I/O Implementation Plan

Migrate copy-plan artifacts and Lidarr plan/history persistence onto the canonical secure-store
primitives without changing any public or serialized contract. The implementation reuses the
strict-default reader seam, adds one final-parent policy, publishes it through the supported barrel,
and then assigns `plan.ts` and
`plan-engine.ts` to independent owners in the shared feature worktree. Domain assertions, payloads,
and the copy snapshot remain unchanged; fixture creation declares safe modes explicitly so the
permissive-umask matrix tests production behavior rather than unsafe fixture accidents. Focused
shared tests cover only the new policy behavior.
Closeout includes the overlapping #306 hardening, exact shell-completion audit, adversarial review,
registered green CI, squash merge, live issue/ROADMAP reconciliation, and dedicated-worktree cleanup.

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-305-secure-store-plan-io/` (branch: `chore/305-secure-store-plan-io`)

All parallel and sequential tasks share this one existing feature worktree. Agents receive disjoint
file ownership; no child worktrees or fan-in merges are used.

## Critically Relevant Files and Documentation

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`: Shared safe-parent and bounded-reader policy seam.
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`: Canonical atomic create/replace and descriptor hardening.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: Supported barrel and migration boundary.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`: Shared taxonomy and raw-errno boundary.
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`: New policy contract coverage.
- `packages/rfmedia-cli/src/lib/plan.ts`: Copy-plan adapter and excluded audit append.
- `packages/rfmedia-cli/src/lib/plan.test.ts`: Protected copy compatibility suite.
- `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`: Protected byte baseline.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Lidarr plan/history adapter and translator.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: Protected Lidarr compatibility suite.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`: Shipped Lidarr adapter precedent.
- `packages/rfmedia-cli/src/lib/adapters/plex/credential-store.ts`: Total translation/create-replace precedent.
- `packages/rfmedia-cli/src/lib/errors.ts`: Stable domain error classes and codes.
- `packages/rfmedia-cli/src/lib/error-formatters.ts`: Concrete PlanArtifactError consumer.
- `packages/rfmedia-cli/src/lib/error-formatters.test.ts`: Protected formatter compatibility contract.
- `packages/rfmedia-cli/src/actions/copy-plan.test.ts`: Copy action boundary contract.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Bash/Zsh/Fish exact-parity gate.
- `docs/plans/issue-305-secure-store-plan-io/design.md`: Canonical decisions and abort criteria.
- `docs/plans/issue-288-secure-store-migration/design.md`: Original secure-store invariants.
- `docs/plans/issue-304-claim-lock-secure-store/design.md`: Existing Lidarr adapter precedent.
- `docs/internal/plex-jwt-deferrals.md`: Secure-store follow-up record.
- `ROADMAP.md`: Live issue inventory and sprint state.
- `.github/pull_request_template.md`: Required PR content and verification sections.

## Implementation Plan

### Phase 0: Establish the Isolated Baseline

#### Task 0.1: Verify Worktree State and Freeze Protected Contracts Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-305-secure-store-plan-io/design.md`
- `docs/plans/issue-305-secure-store-plan-io/shared.md`
- `docs/plans/issue-288-secure-store-migration/design.md`
- `docs/plans/issue-304-claim-lock-secure-store/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None beyond the already attributable planning directory.

- Fetch/prune remotes, inspect configured remotes and worktrees, and confirm this branch starts from
  merged #304 on current GitHub `master`. Preserve the primary checkout and unrelated worktree.
- Treat issue #321 as the corrective prerequisite after PR #322. Corrective PR #326 shipped as
  `cda0b106`; refresh this feature branch onto that GitHub `master` before freezing hashes. Do not
  implement against a stale `plan-engine.ts`, reader policy, or protected test baseline.
- Attribute every existing diff to the planning workflow. If any foreign edit appears, preserve it
  before continuing and do not overwrite, stage, or discard it.
- Enforce the repository Node 22 contract with `mise exec`; rebuild `better-sqlite3` only if the
  runtime ABI proves stale.
- Record SHA-256 hashes for `packages/rfmedia-cli/src/lib/plan.test.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`,
  `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`,
  `packages/rfmedia-cli/src/actions/copy-plan.test.ts`, and
  `packages/rfmedia-cli/src/lib/error-formatters.test.ts`.
- Confirm #305 and related #306 are open, #304 is closed, and no child issue is attached to #305.
- Run the protected copy suite under umasks `022`, `002`, and `077` and the protected Lidarr suite under
  umask `022`. These baseline runs already passed during research; record rather than repeat them
  if the tree and runtime are unchanged.

### Phase 1: Add the Strict-Default Shared Policy Surface

#### Task 1.1: Reuse Reader Policy and Implement Final-Parent Policy Depends on [0.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
- `docs/plans/issue-305-secure-store-plan-io/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`

- Reuse PR #326's exported bounded-read policy unchanged: `"owner-only"` remains the default and
  plan readers explicitly select `"allow-foreign-read"`. Do not add a duplicate reader policy or
  rename the existing one. Add only the descriptive final-parent policy required by #305;
  omission must preserve validate-only/no-repair behavior.
- Preserve `"allow-foreign-read"` semantics: accept foreign read bits such as `0o044`, but reject
  any foreign write or execute bits (`mode & 0o033`). Retain path resolution, parent validation,
  no-follow open, regular-file checks, byte ceiling, both descriptor stats, identity/path checks,
  parent revalidation, close cleanup, and missing-as-`undefined`.
- Implement harden-private only on the final parent. Verify type and ownership, open with
  `O_DIRECTORY | O_NOFOLLOW`, prove pathname/handle identity, call handle `chmod(0o700)`, and verify
  final type, owner, mode, and identity. Never chmod an unverified pathname or any ancestor.
- Keep the synchronous reader signature and strict behavior unchanged; no synchronous caller needs
  compatibility mode in this issue.
- Retain PR #326's focused tests for strict rejection, `"allow-foreign-read"` acceptance of `0o644`,
  rejection of foreign write/execute bits, size limits, and symlink protections. Add only the
  smallest #305 tests for validate-only mode preservation, harden-private `0o775` to `0o700`, and
  writer propagation yielding `0o600` under umask `0277`. Do not duplicate reader or domain tests.

#### Task 1.2: Thread and Publish the Parent Policy Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `docs/plans/issue-288-secure-store-migration/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`

- Add the optional final-parent policy to `AtomicWriteInput` and pass it through both create and
  replace parent preparation calls. Keep sibling staging, open-handle file chmod, fsync, link/
  rename, identity assertions, directory durability, and cleanup unchanged.
- Add focused create-and-replace assertions proving each writer actually propagates the selected
  harden-private policy; direct `prepareSafeParent()` coverage alone is insufficient.
- Export the new policy/options only through the barrel. Update module JSDoc to describe plan I/O as
  a shared consumer and to distinguish strict defaults from explicit plan compatibility.
- Correct stale provenance comments that call migrated persistence an untouched reference, without
  changing runtime behavior elsewhere.
- Run the focused secure-store suite, package typecheck, and architecture check. Search production
  imports to confirm no new deep import of `paths.ts` or `atomic.ts`.

### Phase 2: Migrate Domain Adapters in Parallel

#### Task 2.1: Replace Copy-Plan Artifact Mechanics Depends on [1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/plan.ts`
- `packages/rfmedia-cli/src/lib/errors.ts`
- `packages/rfmedia-cli/src/lib/error-formatters.ts`
- `packages/rfmedia-cli/src/actions/copy-plan.test.ts`
- `docs/plans/issue-305-secure-store-plan-io/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/plan.ts`

- Retain `validateArtifactPath()` ahead of all shared calls; do not normalize away literal `..`
  refusal or change root/NUL/length classification.
- Replace the local component walk and parent hardener with shared harden-private preparation.
  Preserve the current write ordering by hardening before target inspection.
- Make existing-target inspection return `FileIdentity | undefined` while retaining regular-file,
  no-symlink, `PLAN_EXISTS`, and raw inspection behavior.
- Keep canonical serialization and the byte cap local. Use shared create for absence and shared
  expected-identity replace for overwrite. Pass harden-private through either writer.
- Replace the artifact reader with an `"allow-foreign-read"` bounded read; convert `undefined` to existing
  `PLAN_IO` before the current JSON/validation/checksum flow.
- Add total domain translation: preserve existing plan errors, map shared unsafe/permission,
  too-large, and create-conflict outcomes to stable Plan codes, and map all remaining shared/raw
  failures to `PLAN_IO` with fixed text and `cause`.
- Keep audit append local. It may call shared harden-private parent preparation but must retain one
  no-follow `O_APPEND` write, `0o600` hardening, best-effort failure, and one warning. Keep audit
  lookup and plan pruning local.
- Remove obsolete imports/helpers and the post-rename pathname `chmod`; do not edit protected tests
  or the snapshot.

#### Task 2.2: Replace Lidarr Plan and History Mechanics Depends on [1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`
- `packages/rfmedia-cli/src/lib/errors.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `docs/plans/issue-304-claim-lock-secure-store/design.md`
- `docs/plans/issue-305-secure-store-plan-io/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

- Keep `resolveLidarrStoragePath()` as the first, non-disclosing domain path gate.
- Delete the local storage identity types, comparer, safe-directory/walk helpers, parent recheck,
  directory sync, opened-file recheck, bounded reader, existence guard, and local staging writers.
- Keep plan schema/checksum/version serialization and size bounds local, then publish with shared
  create. Translate create conflict to `LIDARR_PLAN_EXISTS`.
- Read plan and history documents with `"allow-foreign-read"`. Convert missing plan to
  `LIDARR_PLAN_IO`, missing history lookup to `[]`, and missing history update to shared create.
- Preserve an existing history read's identity for shared replace. Keep JSONL parsing, exact plan
  identity, reduction/order, entry and byte caps, trailing newline, and blocking directory fsync.
- Generalize the common #304 shared/raw I/O mapping without changing claim-specific busy/corrupt
  acquire/assert/release behavior. Preserve already-typed Lidarr errors before translation. Map
  shared unsafe/permission to `LIDARR_PLAN_UNSAFE_PATH`, too-large to
  `LIDARR_PLAN_TOO_LARGE`, and create conflict to `LIDARR_PLAN_EXISTS`; map every remaining
  shared/raw/unknown failure to `LIDARR_PLAN_IO` with fixed non-disclosing text and `cause`.
  Reject invalid paths before shared resolution and handle each missing result before destructuring.
- Remove obsolete Node imports only after checking all non-persistence uses. Do not edit the
  protected plan-engine test.

Tasks 2.1 and 2.2 may run concurrently because they own disjoint files in the same feature
worktree. Neither may stage, commit, push, rebase, or edit the other's file.
Neither parallel lane may run package-wide typecheck/build/format, integration suites, Git index
operations, or graph updates while the other is editing. Rendezvous before Task 3.1.

### Phase 3: Prove Focused Compatibility

#### Task 3.1: Run Shared, Copy, and Lidarr Contract Gates Depends on [2.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
- `packages/rfmedia-cli/src/lib/plan.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `packages/rfmedia-cli/src/actions/copy-plan.test.ts`
- `packages/rfmedia-cli/src/lib/error-formatters.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- None. Return failures to the owning source task.

- Run secure-store tests, copy-plan tests under umasks `022`, `002`, and `077`, and plan-engine tests
  under `022` and `002`; use separate sequential shells so umask evidence cannot interfere. The
  shared writer test changes `process.umask()` after Vitest startup to prove `0277` without making
  Vitest's own cache directories unwritable.
- Run copy action, error formatter, and shell-completion parity tests. Then run package typecheck,
  architecture, and build serially.
- Prove all five protected files match their baseline hashes: both domain tests, the copy snapshot,
  `copy-plan.test.ts`, and `error-formatters.test.ts`. Confirm public signatures and byte-pinned
  fixtures did not change.
- Search both domain modules for duplicate parent-walk, bounded-reader, staging-writer, identity,
  and directory-sync helpers. Confirm audit append remains local and there is no path `chmod` after
  rename in `plan.ts`.
- Audit Bash, Zsh, and Fish templates and record no change required; any template diff is an
  accidental scope expansion.
- After both implementation lanes rendezvous, run `graphify update .` from the repository root of
  the #305 feature worktree, never from `packages/rfmedia-cli` or another checkout.

### Phase 4: Review the Implementation Before Publishing

#### Task 4.1: Run Independent Code Review and Fix Validated Findings Depends on [3.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-305-secure-store-plan-io/design.md`
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
- `packages/rfmedia-cli/src/lib/plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**Instructions**

Files to Create

- `docs/prps/reviews/issue-305-secure-store-plan-io-review.md`

Files to Modify

- Only files directly implicated by validated findings, in 1–3-file fix units.

- Use the mandatory code reviewer after code changes, then run the repository code-review workflow
  against the complete local delta. Review security ordering, race resistance, strict defaults,
  domain translation, absence semantics, byte stability, audit exclusion, tests, and scope.
- Validate every finding against current source before changing anything. Dispatch same-file fixes
  to one owner, rerun its focused umask matrix, and update the review artifact with resolution.
- Run a final independent review after fixes. Proceed only with no critical/high findings and no
  unresolved correctness/security findings.

### Phase 5: Publish the Verified PR and Reconcile Documentation

#### Task 5.1: Commit, Push Through Hooks, and Open the Template PR Depends on [4.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `lefthook.yml`
- `docs/plans/issue-305-secure-store-plan-io/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

- Commit planning, shared surface, and domain adapters in intentional reviewable commits. Preserve
  protected files and unrelated worktrees.
- Push only to the configured upstream GitHub remote through the real pre-push hook; do not bypass
  lefthook. Diagnose and fix the real hook path if it fails.
- Open the PR using every required template section. Include exact commands/results, no-change
  completion audit, rollback, and both `Closes #305` and `Closes #306`.
- Record the authoritative PR number before writing any closeout reference.

#### Task 5.2: Finalize ADR and Live ROADMAP Closeout Depends on [5.1]

**READ THESE BEFORE TASK**

- `docs/internal/plex-jwt-deferrals.md`
- `ROADMAP.md`
- `docs/roadmap-archive.md`
- GitHub issues #305, #306, #307, and #308

**Instructions**

Files to Create

- None.

Files to Modify

- `docs/internal/plex-jwt-deferrals.md`
- `ROADMAP.md`

- Record the actual PR and completed plan/history delegation, preserving the audit append exclusion
  and the historical #288/#304 split.
- Fetch live issue data immediately before editing. Project the post-merge inventory by removing
  #305 and #306 only, recompute all affected totals/category/priority counts, renumber Sprint 2,
  update Current Focus and the secure-artifact row, and leave #307/#308 open.
- Leave `docs/roadmap-archive.md` unchanged unless its documented whole-sprint rule is now met; do
  not archive individual rows early.
- Run Markdown lint, `npm run format:check`, and `git diff --check`; commit, push through the real
  hook, and update the PR body with final verification if the active head changed.

### Phase 6: Complete Review, CI, Merge, and Cleanup

#### Task 6.1: Resolve Every Review Thread and Keep the Active Head Green Depends on [5.2]

**READ THESE BEFORE TASK**

- `docs/prps/reviews/issue-305-secure-store-plan-io-review.md`
- `.github/pull_request_template.md`
- Current PR reviews, inline threads, file-level comments, and top-level comments.

**Instructions**

Files to Create

- None unless a validated review finding requires an updated review artifact.

Files to Modify

- Only files implicated by validated review or CI findings.

- Inspect all human and bot feedback, respond to and resolve every actionable thread, and apply the
  smallest root-cause fix. Dispatch fixes as bounded 1–3-file units with one owner per file, then
  rerun focused tests for the implicated ownership lane.
- Monitor registered CI for the current head SHA, not an obsolete commit. If any check fails, use
  its authoritative logs, fix the cause without skipping hooks/tests, push, and restart the wait on
  the new head.
- Require all registered checks green, no requested changes, no unresolved review threads, and a
  final clean independent review before merge.

#### Task 6.2: Squash Merge, Verify Closure, and Remove Only Dedicated State Depends on [6.1]

**READ THESE BEFORE TASK**

- Live PR metadata and checks for the active head.
- Live issue metadata for #305 and #306.
- `git worktree list --porcelain` and configured remotes.

**Instructions**

Files to Create

- None.

Files to Modify

- None.

- Squash merge the PR only after the full merge gate passes. Verify the authoritative merge commit,
  merged state, and automatic closure of #305 and #306.
- Switch orchestration to the primary checkout before any command that removes the feature
  worktree; never delete the current process's working directory.
- Fetch/prune, fast-forward the primary checkout to GitHub `master` if clean, and run
  `graphify update .` from the primary checkout after the merged source is present.
- Verify primary GitHub tracking alignment and repository cleanliness. Ordinary push scope does not
  authorize synchronizing the separate Forgejo remote.
- Remove only this dedicated worktree and its fully merged local/remote feature branch. Preserve the
  unrelated worktrees recorded in Task 0.1—including `feat/63-hierarchical-service-tagging` and
  `docs/roadmap-323` if it still exists—and all recoverable stashes from PR #319.
- Re-query live issue/ROADMAP parity and worktree/branch state for the final audit.

## Advice

- The parent policy must be threaded into the atomic writers; a one-time adapter hardening call does
  not protect the writer's later internal validation against races.
- `"allow-foreign-read"` is a bounded compatibility policy, not unrestricted mode acceptance: it
  accepts foreign read bits but rejects foreign write or execute bits (`0o033`) while retaining all
  path, type, size, identity, and parent checks.
- Copy and Lidarr parent semantics are intentionally opposite: copy restricts the final parent;
  Lidarr preserves a safe existing mode.
- Missing reads are values at the shared layer and distinct domain outcomes at each call site.
  Handle them before destructuring.
- Keep target inspection local and visible because it owns copy overwrite classification and the
  identity required for replacement; it is not a duplicate parent walk or writer.
- `appendPlanAudit()` and Lidarr history have different persistence contracts despite both being
  called append operations. Do not unify them.
- A shared/raw translator must be total. If an unmapped errno can escape, public error formatting
  and JSON contracts drift even when happy-path tests pass.
- Treat the protected file hashes and source-deletion searches as completion evidence alongside
  positive test results.
