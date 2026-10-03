# Issue 321 Claim Release Ownership Follow-up Plan

Correct the post-PR #322 claim leak before #305 begins. First publish an explicit strict-default
asynchronous reader policy, then allow foreign read bits only for lock release while keeping foreign
write/execute rejection, full record/inode ownership checks, and retryable latch ordering. A focused
shared test block and an additive domain assertion prove owned cleanup, foreign preservation, and
retry after genuine error.

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-321-claim-release-ownership/` (branch: `fix/321-claim-release-ownership`)

## Critically Relevant Files and Documentation

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`: Bounded-reader mode gate.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: Supported barrel.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`: Ownership predicate and release latch.
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`: Shared lock contract.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Release error translation.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: Domain claim contract.
- `docs/plans/issue-321-claim-release-ownership-followup/design.md`: Canonical decisions.
- `.github/pull_request_template.md`: Required PR body.

## Implementation Plan

### Phase 1: Shared Reader Policy

#### Task 1.1: Add Foreign-Read-Compatible Async Read Mode Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `docs/plans/issue-321-claim-release-ownership-followup/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`

- Add the optional async reader mode with owner-only default and `allow-foreign-read` opt-in. Permit
  only group/other read bits; continue to reject their write/execute bits and retain every no-follow,
  bound, identity, parent, and cleanup check.
- Keep the synchronous reader signature and behavior unchanged. Export the new type only through
  the barrel and update JSDoc without claiming plan/history migration is complete.

### Phase 2: Release Semantics and Focused Tests

#### Task 2.1: Make Shared Lock Release Ownership-Aware and Retryable Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
- `docs/plans/issue-321-claim-release-ownership-followup/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`

- Thread the read mode into the private lock reader; use `allow-foreign-read` only for release.
- Preserve exact record plus inode ownership and the immediate pre-unlink identity assertion.
- Set the release latch only after cleanup returns, reject ownership assertions while cleanup is in
  flight, and clear in-flight state after genuine errors so ownership can be reasserted and release
  retried.
- Add one focused block proving owned `0o644` removal, foreign-record preservation, replacement-
  inode preservation, and unsafe-parent repair/retry. Avoid duplicate acquisition/assertion tests.

#### Task 2.2: Restore Total Lidarr Release Translation Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `docs/plans/issue-321-claim-release-ownership-followup/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`

- Remove the permissions swallow and its false not-owned rationale; retain corrupt-record
  preservation and genuine error translation.
- Extend the existing `0o644` release test to assert removal and immediate reacquisition. Keep the
  existing unsafe-parent rejection and displaced-ownership cases unchanged.

Tasks 2.1 and 2.2 may run in parallel after Task 1.1 because they own disjoint files. Neither lane
may run package-wide checks, formatting, staging, or Git operations before rendezvous.

### Phase 3: Verification and Delivery

#### Task 3.1: Run Focused and Repository Gates Depends on [2.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

- Run the two focused suites under umask `022`, completion parity, typecheck, architecture, build,
  root tests, format, Markdown lint, and whitespace checks under Node 22.
- If the real hook exposes lock disappearance between descriptor read and pathname recheck, handle
  only that target `ENOENT` as missing after parent revalidation; keep shared writer identity checks
  fail-closed and pin the branch with deterministic secure-store coverage.
- Prove public claim interfaces and Bash/Zsh/Fish templates have no diff.
- Run mandatory independent code review and fix every validated finding in bounded units.
- Commit and push through the real hook, open a template-compliant PR closing #321, resolve the PR
  #322 thread with evidence, keep registered CI green on the active head, squash merge, verify issue
  closure, and remove only this dedicated worktree/branch from a neutral checkout.

## Advice

- Foreign-read compatibility is release policy, not a relaxation of acquisition or assertion.
- Record equality without inode equality is insufficient; inode equality without record equality is
  also insufficient.
- A release latch records completed cleanup or lost ownership, not an attempted syscall.
- Do not fold #323's symlink taxonomy or #305's plan/history migration into this corrective PR.
