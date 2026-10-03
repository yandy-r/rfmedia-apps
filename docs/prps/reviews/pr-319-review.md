# PR Review #319 — chore(rfmedia): migrate Lidarr claim lock

**Reviewed**: 2026-08-08T00:30:44Z
**Mode**: PR
**Author**: yandy-r
**Branch**: chore/304-claim-lock-secure-store → master
**Decision**: REQUEST CHANGES

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/ (branch: chore/304-claim-lock-secure-store)

## Summary

The migration is well-scoped and its security boundary is sound, but a post-publication failure in
the shared lock path can leave a live-owner claim behind even though acquisition reported failure.
The review also found two smaller documentation-maintenance issues.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4753` — Delegating acquisition to `acquireExclusiveLock()` loses the bespoke claim loop's rollback after publication. `createPrivateFileAtomically()` links the claim before its post-link identity, parent, and directory-fsync checks; if one of those checks throws, the shared lock propagates the error without returning a capability or unlinking the just-published record. A forced directory-sync `EIO` reproduces a `LIDARR_PLAN_IO` result with the four-field claim still present, after which an immediate retry reports `LidarrPlanAlreadyRunningError` because the orphan names the still-live current PID. The caller therefore failed to acquire a claim it nevertheless leaves owned, violating the behavior-preserving migration and potentially wedging subsequent applies. [correctness]
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Make lock publication report or retain the published identity and compare-and-unlink that exact record and inode before propagating any post-link verification or durability failure, without deleting a concurrent replacement. Extend the existing single critical test block with a fault-injected post-link failure that proves the target is absent afterward and a subsequent zero-wait acquisition succeeds.

### MEDIUM

- **[F002]** `docs/plans/issue-304-claim-lock-secure-store/analysis-tasks.md:78` — Several newly committed analysis and research artifacts still present superseded instructions as current: this task says `lock.ts` is JSDoc-only and forbids runtime/test changes, while `research-patterns.md` directs the ownership UUID seam through shared locking without the final separate `temporaryUUID` decision. Those statements conflict with the canonical `design.md` and `parallel-plan.md`, but unlike the prototype evidence files they carry no superseded banner. [quality]
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Add a prominent historical or superseded notice to each pre-design analysis and research artifact that links to `design.md` and `parallel-plan.md`, or update the conflicting prescriptive sections so the directory has one unambiguous source of truth.

### LOW

- **[F003]** `packages/rfmedia-cli/src/lib/secure-store/lock.ts:337` — The release-durability comment still says "both callers" and lists only the credential store and preset apply path, even though this PR adds the Lidarr plan claim as a third `release()`-from-`finally` consumer. [quality]
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Reword this as an invariant of all production lock consumers, or add the plan-claim call sites, so the comment does not require another caller-count update.

## Validation Results

| Check      | Result |
| ---------- | ------ |
| Type check | Pass   |
| Lint       | Pass   |
| Tests      | Pass   |
| Build      | Pass   |

## Files Reviewed

- `docs/internal/plex-jwt-deferrals.md` (Modified)
- `docs/plans/issue-304-claim-lock-secure-store/analysis-code.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/analysis-context.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/analysis-tasks.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/design.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/parallel-plan.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/prototype-evidence.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/prototype-plan-evidence.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/research-architecture.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/research-docs.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/research-integration.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/research-patterns.md` (Added)
- `docs/plans/issue-304-claim-lock-secure-store/shared.md` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` (Modified)
- `packages/rfmedia-cli/src/lib/secure-store/index.ts` (Modified)
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts` (Modified)
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts` (Modified)
