# Issue 304 Claim-Lock Architecture Research

**Status:** Superseded pre-design artifact; retained for historical context and not the
implementation source of truth.
**Canonical design:** [`design.md`](../issue-304-claim-lock-secure-store/design.md)
**Canonical plan:** [`parallel-plan.md`](../issue-304-claim-lock-secure-store/parallel-plan.md)

## System Overview

The Lidarr apply pipeline uses one filesystem claim per sealed plan ID to prevent two processes from
mutating Lidarr from the same plan concurrently. `acquireLidarrPlanClaim()` owns the Lidarr-facing
contract, while the actual lock publication, stale-owner recovery, ownership proof, and safe unlink
can now be delegated to the canonical `secure-store` lock.

The migration boundary should remain entirely inside
`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: callers continue to receive the unchanged
`LidarrPlanClaim` shape (`path`, `assertOwned()`, `release()`), and the wrapper translates shared
`SecureStoreError` failures back into the existing Lidarr error taxonomy. This isolation is also the
prerequisite for issue #305, which can later reuse the same plan-engine error translation while
migrating the remaining path walks and atomic writers.

## Relevant Components

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:386` — injectable claim dependencies; its
  public shape should remain unchanged.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:395` — public `LidarrPlanClaim` contract used
  throughout real apply execution.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4654` — current liveness probe; unlike the
  secure-store default, every error other than `ESRCH` means "alive", so pass this probe explicitly
  to preserve fail-closed behavior.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4738` — migration seam. The bespoke record
  parsing, ownership comparison, hard-link publication, stale retry, and conditional unlink directly
  above/inside this function become a wrapper over `acquireExclusiveLock()`.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts:62` — supported barrel export for
  `acquireExclusiveLock`, `SecureStoreError`, and `SecureStoreLock`; do not deep-import `lock.ts`.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts:80` — shared on-disk record. With no `binding`,
  its four keys are byte-compatible with the existing claim record.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts:98` — shared held-lock contract. It already
  supplies full-record plus `{dev, ino}` ownership checks and idempotent, owner-safe release.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts:392` — canonical acquisition implementation:
  atomic publication, same-host dead-pid recovery, optional age recovery, deadline-based contention,
  and corrupt-record rejection.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts:128` — shared error carries a sanitized path
  and path-bearing remediation; these fields must not escape through plan validation failures.
- `packages/rfmedia-cli/src/lib/errors.ts:107` — existing artifact/safety/IO taxonomy that remains
  authoritative for non-contention plan failures.
- `packages/rfmedia-cli/src/lib/errors.ts:158` — `LidarrPlanAlreadyRunningError`; acquisition
  contention, corrupt existing claims, and lost ownership must retain this public error type.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts:1187` and `:1441` — main apply claim acquisition;
  the returned assertion is threaded into entry, deferred-replay, album, and artist execution, and
  release runs from the outer `finally` at `:1593`.
- `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.ts:233` — independent
  track-filter apply path that acquires, repeatedly asserts, and finally releases the same contract.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts:2081` — compatibility suite for live
  contention, explicit release, displacement, malformed publication, and cross-host aging. It is the
  acceptance contract and must remain unmodified.
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts:230` and `:304` — authoritative
  coverage for `maxAgeMs: null`, full ownership checks, the post-release latch, and corrupt records.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts:625` — existing adapter pattern
  for the same shared lock, including fail-fast deadline, disabled age stealing, explicit liveness
  injection, a dedicated `assertOwned` arm, and release compatibility.
- `docs/plans/issue-288-secure-store-migration/design.md:674` — records why this claim migration was
  deliberately deferred and fixes the required option/error mapping.

## Data Flow

1. A real Lidarr apply reads and validates a sealed plan, then calls
   `acquireLidarrPlanClaim(plan.id, dependencies)` before admitting remote mutations. Dry-run paths
   do not acquire a claim.
2. The wrapper validates the plan UUID and claim-directory input with the existing
   `resolveLidarrStoragePath()` behavior, then derives
   `<claimDirectory>/<planId>.lock`. Keeping this validation ahead of secure-store prevents invalid
   control-bearing or overlong input from being copied into `SecureStoreError.path` or
   `.remediation` and preserves `planPath: undefined` plus the fixed, path-free validation message.
3. The wrapper adapts the Date-returning dependency clock to epoch milliseconds and calls
   `acquireExclusiveLock(claimPath, options)` through the secure-store barrel. Required options are:
   `subject` set to a fixed local label, `deadlineEpochMs: now()` for zero-wait contention,
   `maxAgeMs: null`, the existing hostname/pid/liveness seams, and the existing UUID seam. No
   `binding` is needed because the plan ID is already encoded in the unique path.
4. Secure-store atomically publishes the same four-field JSON record. On `EEXIST`, it may reclaim
   only a demonstrably dead same-host owner. A live owner, a foreign-host owner, or an old
   foreign-host owner remains in place; with the deadline already reached, contention fails
   immediately rather than entering backoff.
5. The wrapper returns a `LidarrPlanClaim` adapter. Its `assertOwned()` delegates to the held lock
   before mutation admission, dispatch boundaries, verification, and durable history writes. Its
   `release()` delegates from existing `finally` blocks; secure-store checks the complete record and
   inode identity before unlinking, so a replacement claim is never removed.
6. Shared errors are translated at the wrapper boundary. Nothing in the 15-file apply fan-out needs
   to import secure-store types or change its signatures.

## Integration Points

- **Acquisition options are semantic, not tuning knobs.** `deadlineEpochMs: now()` preserves the
  current fail-fast API. `maxAgeMs: null` is mandatory because a healthy apply can exceed the
  shared 120-second default; age-based cross-host stealing would allow overlapping mutation runs.
- **Preserve the liveness rule explicitly.** Pass `dependencies.isProcessAlive ??
defaultIsProcessAlive`. Using `isProcessAliveByDefault` changes unknown process-probe failures
  from "owner may be alive" to "owner is dead" and can steal a live claim.
- **Keep UUID validation compatibility.** The current wrapper raises
  `LidarrPlanValidationError` for a non-UUID ownership token. Validate or wrap the injected UUID
  source before the shared call so `SECURE_STORE_CORRUPT` does not replace that behavior. Be aware
  that secure-store also uses its UUID source for staging names.
- **Use separate acquisition and ownership translators.** During acquisition,
  `SECURE_STORE_LOCK_BUSY` and `SECURE_STORE_CORRUPT` both mean
  `LidarrPlanAlreadyRunningError(planId, claimPath)`. The corrupt arm is required to leave a partial
  claim byte-identical instead of reclaiming it. During `assertOwned()`, both a mismatch/release
  latch (`SECURE_STORE_LOCK_BUSY`) and an unreadable replacement (`SECURE_STORE_CORRUPT`) mean the
  claim was lost and must independently translate to `LidarrPlanAlreadyRunningError`; do not reuse
  an acquisition helper whose other classifications or message context are acquisition-specific.
- **Retain release behavior.** The public method stays idempotent. The old reader treated malformed
  replacement contents as "not owned" and release therefore resolved without unlinking; the
  adapter should suppress the shared `SECURE_STORE_CORRUPT` case while translating genuine path/IO
  failures, matching the existing preset-lock adapter pattern.
- **Translate every escaping class.** Shared unsafe-path/permissions/too-large failures and raw
  `ENOSPC`/`EIO`/`EROFS` errors must become the corresponding existing
  `LidarrPlanArtifactError` classification rather than leaking a new `.code` into CLI machine
  output. Preserve already-constructed Lidarr validation/artifact errors unchanged.
- **Do not render shared paths in translated messages.** Use fixed local messages; never append
  `SecureStoreError.path`, `.remediation`, or a raw path-bearing filesystem message. Retaining the
  existing pre-resolution step is what satisfies the path-leakage test for invalid input.
- **Do not broaden issue #304.** `plan-engine.ts` still uses `FileHandle`, `link`, `unlink`, safe
  parent helpers, and file identities for plan artifacts and history. Remove only claim-specific
  pieces (`ClaimRecord`, `CLAIM_MAX_BYTES`, claim reader/ownership/unlink helpers, and the bespoke
  acquisition loop); issue #305 owns the remaining filesystem migration.
- **Tests stay as contract evidence.** The existing claim tests already prove the required
  contention, displacement, corrupt-record, byte-preservation, and no-cross-host-age-steal
  behavior. A need to edit them indicates a behavior change and should stop the migration.

## Key Dependencies

- **Node filesystem semantics:** secure-store relies on local-filesystem `link()` atomicity,
  owner-only `0o600` files, `0o700` directories, no-follow opens, directory synchronization, and
  `{dev, ino}` identity. NFS/SMB remains explicitly unsupported for reliable lock ownership.
- **Clock and process seams:** `now`, `hostname`, `pid`, `isProcessAlive`, and `randomUUID` are
  injectable through `LidarrPlanClaimDependencies`; the adapter must carry them through so the
  unchanged tests remain deterministic.
- **Error contracts:** `SecureStoreError.code` is an implementation detail below the adapter;
  `LidarrPlanAlreadyRunningError`, `LidarrPlanArtifactError`, and
  `LidarrPlanValidationError` remain the observable API above it.
- **Apply lifecycle:** the signal/cleanup registration in `apply.ts` waits for the action to settle,
  while claim release occurs in `finally`. The migration must not add waiting, move acquisition, or
  alter cleanup ordering.
- **Follow-on architecture:** [issue #304](https://github.com/yandy-r/rfmedia-apps/issues/304)
  removes the last duplicate lock; [issue #305](https://github.com/yandy-r/rfmedia-apps/issues/305)
  then migrates remaining plan path walks/writers without duplicating the translator boundary.
- **Verification contract:** run the unmodified plan-engine and secure-store suites, typecheck, the
  architecture gate, and the root test suite exactly as listed in issue #304. The repository's Node
  22 contract should be enforced with `mise exec -- ...` when those commands are executed.
