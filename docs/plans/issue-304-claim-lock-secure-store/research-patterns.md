# Issue 304 Claim-Lock Secure-Store Research Patterns

**Status:** Superseded pre-design artifact; retained for historical context and not the
implementation source of truth.
**Canonical design:** [`design.md`](../issue-304-claim-lock-secure-store/design.md)
**Canonical plan:** [`parallel-plan.md`](../issue-304-claim-lock-secure-store/parallel-plan.md)

Issue #304 is a delete-and-delegate migration: retain the Lidarr claim API and its domain-specific
failure semantics while replacing only the bespoke lock implementation with the canonical
`secure-store` lock. The completed preset-lock migration is the closest analogue; the existing
plan-engine and secure-store tests already pin every load-bearing policy choice.

## Architectural Patterns

- **Domain adapter over a shared primitive:** `acquireLidarrPresetApplyLock` delegates acquisition to
  `acquireExclusiveLock`, then wraps the returned `SecureStoreLock` in the unchanged
  `LidarrPresetApplyLock` contract. Issue #304 should use the same shape for
  `LidarrPlanClaim`, keeping exactly `path`, `assertOwned()`, and `release()`.
  See `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts:596-688` and
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:386-399`.
- **Policy is explicit at the call site:** the shared lock owns atomic publication, bounded record
  reads, full-record plus inode ownership checks, stale-owner recovery, and idempotent release.
  Lidarr must supply its policy: `deadlineEpochMs` equal to the injected current time for zero-wait
  contention and `maxAgeMs: null` to disable cross-host age stealing. The same choices are explained
  at `profile-preset-persistence.ts:622-650`; the primitive implements them at
  `secure-store/lock.ts:352-383` and `:392-503`.
- **Preserve the local liveness policy:** keep `plan-engine.ts:4654-4661` and pass
  `dependencies.isProcessAlive ?? defaultIsProcessAlive` into `acquireExclusiveLock`. The local
  helper treats every probe failure except `ESRCH` as alive. This differs from
  `isProcessAliveByDefault` at `secure-store/lock.ts:173-180`, which treats only `EPERM` as alive.
  The preset migration explicitly preserves this distinction at
  `profile-preset-persistence.ts:647-650`.
- **No binding is needed:** the claim filename is already uniquely bound to the validated plan UUID
  (`<claimDirectory>/<planId>.lock`). Omitting `binding` also keeps the shared on-disk record at the
  legacy four fields (`host`, `pid`, `createdAt`, `ownershipToken`), as defined in
  `secure-store/lock.ts:79-95`.
- **Keep unrelated plan persistence local:** issue #304 migrates only the claim block at
  `plan-engine.ts:4654-4819`. The plan artifact/history path walk, bounded reader, and atomic writers
  have different mode and raw-errno contracts and remain intentionally local; this boundary is
  documented in `secure-store/index.ts:9-16` and
  `docs/plans/issue-288-secure-store-migration/design.md:378-417`.
- **Fan-out stops at the adapter:** `assertOwned` appears 68 times across 15 files under
  `src/actions/lidarr`, but consumers call the `LidarrPlanClaim` surface. Do not thread
  `SecureStoreLock`, its error codes, or new parameters into those call sites.

## Code Conventions

- Import runtime values and types from the supported barrel
  `../secure-store/index.js`; `secure-store/index.ts:18` explicitly forbids supported deep imports.
  Add `acquireExclusiveLock` and `SecureStoreError` to the existing value import and, if named
  locally, import `SecureStoreLock` with `import type`.
- Keep Node ESM `.js` import suffixes, `readonly` interface fields, explicit `Promise<void>` return
  annotations on adapter methods, and `unknown` catch values. These conventions are visible in
  `profile-preset-persistence.ts:15-23`, `:63-78`, and `:625-685`.
- Preserve `LidarrPlanClaimDependencies` byte-for-byte. Convert its `now?: () => Date` seam to the
  epoch-millisecond callback expected by secure-store rather than changing the public dependency
  type. Forward `hostname`, `pid`, `isProcessAlive`, and `randomUUID` so the existing deterministic
  tests continue to exercise the real filesystem implementation.
- Validate `planId` with `SECURE_STORE_UUID_PATTERN` and resolve the claim directory through the
  existing `resolveLidarrStoragePath` before calling the shared lock. This preserves the
  `LIDARR_PLAN_UNSAFE_PATH` contract for empty, overlong, or terminal-control-bearing input and
  prevents secure-store's path-bearing error/remediation fields from becoming the first observable
  failure.
- Use a fixed, non-sensitive subject literal such as `"Lidarr plan claim"`. Secure-store messages
  are subject-parameterized and never include file bytes (`secure-store/errors.ts:1-9`).
- Do not mechanically remove imports merely because the claim implementation stops using them.
  `nodeRandomUUID`, `nodeHostname`, `FileHandle`, `link`, `unlink`, and `rm` all still have non-claim
  uses elsewhere in `plan-engine.ts`. The claim-private `CLAIM_MAX_BYTES`, `ClaimRecord`,
  `parseClaimRecord`, `readClaim`, `claimIsOwned`, and `unlinkClaimIfOwned` can be removed once no
  references remain.
- Return the domain adapter rather than exposing shared-only fields (`ownershipToken`, `binding`).
  Freezing the adapter with `Object.freeze`, as the preset migration does, is consistent but must not
  add fields or alter `LidarrPlanClaim`'s public type.

## Error Handling

- **Acquisition contention:** translate `SECURE_STORE_LOCK_BUSY` to
  `LidarrPlanAlreadyRunningError(planId, claimPath)`. `deadlineEpochMs` equal to the current clock
  makes a live contention reach the deadline check without sleeping, preserving fail-fast behavior.
- **Corrupt existing record:** translate `SECURE_STORE_CORRUPT` to the same
  `LidarrPlanAlreadyRunningError`. Do not unlink, rewrite, or repair it. Shared acquisition first
  observes the atomic-create conflict and then fails while parsing at `secure-store/lock.ts:252-269`,
  before stale-owner removal at `:474-483`; therefore the malformed bytes remain untouched.
- **Ownership assertion:** wrap `held.assertOwned()` separately from acquisition. Shared
  `SECURE_STORE_LOCK_BUSY` means the record, complete owner tuple, or `{dev, ino}` identity no longer
  matches; shared `SECURE_STORE_CORRUPT` means a displaced record is unparseable. Both must surface as
  `LidarrPlanAlreadyRunningError`, matching the existing claim-level contract rather than leaking a
  `SecureStoreError`. The full ownership predicate is centralized in
  `secure-store/lock.ts:272-319` and used by `assertOwned` at `:445-464`.
- **Release:** delegate to the shared idempotent `release()`. If it encounters
  `SECURE_STORE_CORRUPT`, resolve without unlinking: the old `readClaim` treated malformed content as
  not owned, and the preset adapter preserves that exact behavior at
  `profile-preset-persistence.ts:673-683`. Never delete a replacement lock after ownership loss.
- **Other shared or raw failures:** translate them back into Lidarr's existing artifact taxonomy at
  the adapter boundary; do not let `SecureStoreError.code`, `.path`, or `.remediation`, or a raw
  `ENOSPC`/`EIO`/`EROFS`, escape. The preset translator demonstrates an exhaustive
  `SecureStoreError` switch plus an explicit non-`SecureStoreError` fallback at
  `profile-preset-persistence.ts:109-143`. Construct fresh Lidarr errors with fixed local messages
  and preserve the original as `cause`.
- **No path leak:** keep invalid-path rejection in `resolveLidarrStoragePath`, whose error omits
  `planPath` and the offending string (`plan-engine.ts:3841-3857`). Do not rethrow secure-store's
  path-bearing errors directly; `SecureStoreError` deliberately retains a sanitized `.path` and
  embeds it in `.remediation` (`secure-store/errors.ts:128-149`). The existing contract test at
  `plan-engine.test.ts:1756-1770` requires `planPath: undefined` and a message that does not echo the
  offending path.

## Testing Approach

- Treat `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` as an unmodified compatibility
  suite. If it needs edits, the migration changed behavior and must be re-scoped.
- The claim tests use real temporary directories and real filesystem mutations, with injected
  clock/host/pid/liveness/UUID seams rather than module mocks (`plan-engine.test.ts:70-96` and
  `:2081-2188`). Follow that convention; no `vi.mock` of secure-store is needed.
- Existing claim tripwires cover:
  - one live owner, fail-fast contention, explicit release, and reacquisition (`:2081-2113`);
  - displaced ownership and preservation of the replacement bytes after release (`:2115-2137`);
  - corrupt partial publication mapped to `LidarrPlanAlreadyRunningError` and left byte-identical
    (`:2139-2157`);
  - a two-hour-old foreign-host owner not being reclaimed (`:2159-2187`), which requires
    `maxAgeMs: null`.
- Shared primitive tests independently pin zero-deadline behavior, `maxAgeMs: null`, corruption,
  full-record/inode ownership, non-destructive release, and the post-release latch in
  `secure-store/secure-store.test.ts:141-161`, `:230-302`, and `:304-357`.
- The preset persistence suite is the migration precedent: it also uses the real filesystem and
  unchanged dependency seams to cover contention, same-host dead-owner recovery, cross-host refusal,
  path swapping, ownership loss, and idempotent release
  (`profile-preset-persistence.test.ts:97-192`).
- Verification commands from issue #304:

  ```bash
  cd packages/rfmedia-cli
  umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts
  umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts
  npm run typecheck
  npm run check:architecture
  cd ../..
  npm run test:run
  ```

- Completion checks: the plan-engine test file has no diff; `plan-engine.ts` contains no claim-lock
  `link()` implementation (the artifact writer may still legitimately use `link()`); all claim
  consumers compile unchanged; and only the shared `secure-store/lock.ts` owns lock publication.

## Patterns to Follow

1. Preserve validation and the public dependency/claim interfaces at the top of
   `acquireLidarrPlanClaim`.
2. Build the same claim path as today, create an epoch-millisecond clock adapter, and delegate once
   through `acquireExclusiveLock` with an explicit subject, zero-wait deadline,
   `maxAgeMs: null`, and all existing owner/liveness/UUID seams.
3. Translate acquisition errors locally: busy and corrupt become
   `LidarrPlanAlreadyRunningError`; unsafe, permission, remaining secure-store codes, and raw errnos
   become the appropriate existing Lidarr artifact error without exposing secure-store metadata.
4. Return a `LidarrPlanClaim` adapter whose `assertOwned` has its own loss translator and whose
   `release` is idempotent, preserves foreign/corrupt records, and never masks an in-flight failure.
5. Delete only the now-dead bespoke claim record/read/ownership/unlink machinery. Leave the plan
   artifact/history filesystem stack and all action-layer call sites untouched.
6. Prove the migration by running the existing plan-engine suite unmodified, then the shared lock
   suite, typecheck, architecture checks, and the repository test gate.
