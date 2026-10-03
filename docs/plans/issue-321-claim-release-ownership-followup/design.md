# Issue 321 Follow-up — Preserve Claim Ownership on Release

Status: design complete, ready for implementation.
Branch: `fix/321-claim-release-ownership`.
Depends on: PR #322, merged as `f1d6a0c4`.
Blocks: issue #305 plan/history secure-store migration.

## Context

PR #322 restored non-throwing release for a claim file whose mode becomes `0o644`, but post-merge
review identified a leak. The strict shared reader rejects foreign access bits before returning the
record and inode, `release()` marks its latch before cleanup, and the Lidarr adapter swallows the
permissions error. The call reports success while the still-owned claim remains on disk, so an
immediate same-process retry cannot acquire the plan.

The shared lock already has the correct deletion predicate once a read succeeds: full record
equality plus `{dev, ino}`, followed by another identity check immediately before unlink. The fix is
to let only release tolerate group/other read bits, preserve every write/execute and other read
safety check, and mark the lock released only after cleanup succeeds or ownership is demonstrably
absent/displaced.

## Goals

- Remove an owned claim whose mode alone widened to `0o644` without masking the surrounding error.
- Preserve foreign bytes and replaced inodes even when their modes allow foreign reads.
- Keep acquisition and `assertOwned()` on strict owner-only reads.
- Keep genuine unsafe-parent, path, and unlink failures actionable and retryable after repair.
- Reuse the bounded-reader policy required by #305 without globally weakening secure-store.
- Resolve the current PR #322 review thread with focused shared and domain evidence.

## Non-Goals

- Changing lock record bytes, contention, stale-owner recovery, max age, binding, public claim
  interfaces, CLI options, or configuration.
- Making acquisition/assertion accept non-private files.
- Swallowing all release failures or unlinking based on record equality without inode identity.
- Migrating plan/history persistence; #305 remains a separate worktree and PR.
- Addressing the distinct claim-symlink classification tracked by #323.

## Decision

Add an optional asynchronous bounded-read file-mode policy to `secure-store/paths.ts`:

- `owner-only` is the default and preserves current behavior;
- `allow-foreign-read` permits only group/other read bits (`0o044`) and continues to reject their
  write/execute bits (`0o033`).

Both modes retain `O_NOFOLLOW`, regular-file checks, byte bounds, before/after descriptor identity,
pathname identity, parent validation/revalidation, missing-as-`undefined`, and the observed mode in
the result. The synchronous reader stays unchanged and strict.

If the target is unlinked after its descriptor read but before the final pathname identity check,
the asynchronous reader revalidates the captured parent and returns `undefined`. This closes a
latent acquisition race exposed by the real pre-push hook: the open descriptor remains valid after
the incumbent releases its pathname, and lock acquisition already treats a missing incumbent as an
immediate retry. Identity mismatch, symlink, non-file, and parent replacement remain failures, and
the shared identity helper stays fail-closed for atomic writers.

Thread the option through the private lock reader, but opt into foreign-read compatibility only from
`unlinkLockIfOwned()`. Acquisition, stale recovery, and `assertOwned()` remain strict. Release still
requires exact record and inode equality before unlinking; a missing path, changed record, or
changed inode is treated as not owned and preserved.

Move `released = true` after `unlinkLockIfOwned()` returns. A successful unlink or a normal
not-owned return latches release. An unsafe parent, path error, or unlink failure leaves the latch
false so the caller can repair the environment and retry. While cleanup is in flight,
`assertOwned()` rejects instead of claiming ownership that is already being relinquished; a failed
cleanup clears that in-flight state before ownership can be asserted or release retried.

Remove `SECURE_STORE_PERMISSIONS` from the Lidarr release swallow. With foreign-read-compatible release
reads, a widened owned/foreign file reaches the ownership predicate; any remaining permissions
failure is a genuine parent/path/I/O fault and must retain the existing domain translation.

## Critical Tests

Extend `secure-store.test.ts` with one focused release-policy block covering four independent safety
axes:

1. Bounded read at `0o644` succeeds while `0o620`, oversize, and symlink cases still reject.
2. Same record and inode at `0o644`: release removes the path.
3. Same inode with foreign record bytes at `0o644`: release preserves the exact bytes.
4. New inode carrying the original record at `0o644`: release preserves the replacement.
5. In-flight release: ownership assertion rejects while cleanup is paused on a safe parent; after
   an induced unsafe-parent failure and repair, ownership assertion and a second release succeed,
   proving the in-flight state resets without committing the latch early.
6. Target unlink after the bounded descriptor read: the reader revalidates the parent and returns
   missing instead of leaking raw `ENOENT`.

Strengthen the existing plan-engine `0o644` release test additively: assert the path is absent and
immediate same-process reacquisition succeeds. Keep the genuine unsafe-parent release test and all
existing claim assertions unchanged.

## Files

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`: explicit async read policy.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: supported policy export.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`: release-only opt-in and latch ordering.
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`: ownership/identity/retry proof.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: remove the overbroad permissions swallow.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: domain removal and immediate retry proof.

## Verification

Under Node 22:

```bash
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts src/lib/lidarr/plan-engine.test.ts'
mise exec -- npm run typecheck -w packages/rfmedia-cli
mise exec -- npm run check:architecture -w packages/rfmedia-cli
mise exec -- npm run test:run
```

Also run targeted Prettier, Markdown lint, `git diff --check`, the real pre-push hook, and confirm
the public `LidarrPlanClaim` and `LidarrPlanClaimDependencies` declarations remain byte-identical.
Bash, Zsh, and Fish completion templates require no change because no command or option changes.

## Rollback

Keep the reader policy, shared lock behavior, and Lidarr adapter/tests in reviewable commits. If the
release-specific behavior regresses, revert the lock/adapter commit; strict defaults ensure existing
credential, acquisition, assertion, and preset consumers are unaffected by the additive read option.
