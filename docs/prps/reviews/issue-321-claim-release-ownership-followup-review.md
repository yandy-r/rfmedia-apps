# Issue 321 Claim Release Ownership Follow-up Review

**Reviewed**: 2026-08-08T02:09:29Z
**Mode**: Local
**Branch**: fix/321-claim-release-ownership
**Decision**: APPROVE

## Summary

The corrective change keeps strict secure-store reads as the default while allowing only owned-lock
release cleanup to accept group/other read bits. Foreign write/execute bits remain rejected, and exact
record and device/inode checks remain in place before unlinking. Independent review found and fixed a
concurrent-release regression plus an overbroad mode relaxation.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `packages/rfmedia-cli/src/lib/secure-store/lock.ts:520` — Moving the release latch after
  cleanup allowed simultaneous calls to the documented-idempotent `release()` method to race. A
  200-iteration probe produced raw `ENOENT` rejections when both calls attempted the unlink.
  [correctness]
  - **Status**: Fixed
  - **Category**: Correctness
  - **Resolution**: Store and return one in-flight release promise, set `released` only after successful
    cleanup, and clear the promise after rejection so a repaired retry can run. Focused coverage proves
    exact-promise coalescing, post-success idempotence, shared rejection, and a fresh successful retry.

- **[F002]** `packages/rfmedia-cli/src/lib/secure-store/paths.ts:356` — The initial compatibility
  mode skipped every group/other permission bit, so a foreign-writable lock could be changed between
  record verification and unlink while retaining its inode. [security]
  - **Status**: Fixed
  - **Category**: Security
  - **Resolution**: Rename the unshipped policy to `allow-foreign-read`, permit only `0o044`, and
    reject group/other write or execute bits through `0o033`. Focused coverage proves `0o644`
    compatibility, unchanged `0o620` rejection, and retained size and symlink gates.

### MEDIUM

- **[F003]** `packages/rfmedia-cli/src/lib/secure-store/paths.ts:378` — The real pre-push hook exposed
  a latent acquisition race: an incumbent could unlink its lock after the contender's descriptor
  read but before the pathname identity recheck, leaking raw `ENOENT` instead of entering the
  existing immediate-retry path. [correctness]
  - **Status**: Fixed
  - **Category**: Correctness
  - **Resolution**: Catch only target `ENOENT` from the asynchronous reader's final pathname check,
    revalidate the captured parent, and return missing. The shared identity helper remains unchanged
    for atomic writers. A deterministic descriptor-stat seam pins the exact interleaving.

- **[F004]** `packages/rfmedia-cli/src/lib/secure-store/lock.ts:502` — After release cleanup became
  asynchronous and success-latched, `assertOwned()` could still succeed while cleanup was in flight
  even though the lock was about to be removed. [correctness]
  - **Status**: Fixed
  - **Category**: Correctness
  - **Resolution**: Reject ownership assertions whenever a release promise is in flight. A
    deterministic safe-parent gate proves the rejection, then induces cleanup failure and proves
    state reset, ownership recovery, and successful retry after repair.

- **[F005]** `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts:207` — After the
  branch was rebased onto PR #327, CI exposed that the preset consumer still expected its owned
  `0o644` lock to remain after non-throwing release, contradicting the corrected shared release
  contract. [correctness]
  - **Status**: Fixed
  - **Category**: Correctness
  - **Resolution**: Update the existing consumer test, without adding coverage or changing
    production, to assert `ENOENT` after shared release proves the full record and inode and removes
    the owned widened-mode lock. Adjacent foreign-record and unsafe-parent cases remain unchanged.

- **[F006]** `packages/rfmedia-cli/src/lib/secure-store/lock.ts:505` — An ownership assertion that
  began before release could stall in its asynchronous record read, then return successfully after
  release had started because only the entry latch was checked. [correctness]
  - **Status**: Fixed
  - **Category**: Correctness
  - **Resolution**: Recheck the release latch immediately after the awaited ownership read. A
    deterministic two-descriptor gate proves the assertion began first, release became in flight,
    and the overlapping assertion rejects before cleanup continues.

### LOW

None.

## Final Review

No open correctness, security, durability, API, or scope findings remain. Foreign-read compatibility
is release-only; acquisition, assertion, stale stealing, and publication-failure cleanup retain strict
mode validation. Foreign write/execute bits, foreign record bytes, and replacement inodes remain
protected, and the widened-mode Lidarr contract proves deletion plus immediate same-process
reacquisition.

## Validation Results

| Check                                         | Result                                                  |
| --------------------------------------------- | ------------------------------------------------------- |
| Secure-store, Lidarr, preset, and Plex suites | Pass, 124/124                                           |
| Concurrent two-release probe                  | Pass, 0 rejections across 200 iterations                |
| Type check and architecture checks            | Pass                                                    |
| Package build                                 | Pass                                                    |
| Targeted Prettier and Markdown lint           | Pass                                                    |
| Shell completion audit                        | Pass, Bash/Zsh/Fish templates unchanged                 |
| Scoped whitespace check                       | Pass with repository-compatible `trailing-space` policy |

The user-global Git configuration additionally enables `indent-with-non-tab`, which conflicts with
the repository's Prettier `useTabs: false` output for deeply nested TypeScript. No tabs were inserted;
`git -c core.whitespace=trailing-space diff --check HEAD` passes.

## Files Reviewed

- `docs/plans/issue-321-claim-release-ownership-followup/design.md` (Added)
- `docs/plans/issue-321-claim-release-ownership-followup/parallel-plan.md` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/secure-store/index.ts` (Modified)
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts` (Modified)
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts` (Modified)
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts` (Modified)
