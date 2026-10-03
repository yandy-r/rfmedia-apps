# Issue 304 Code Analysis

**Status:** Superseded pre-design artifact; retained for historical context and not the
implementation source of truth.
**Canonical design:** [`design.md`](../issue-304-claim-lock-secure-store/design.md)
**Canonical plan:** [`parallel-plan.md`](../issue-304-claim-lock-secure-store/parallel-plan.md)

## Executive Summary

`acquireLidarrPlanClaim()` is already the correct domain boundary: its callers consume only
`{ path, assertOwned(), release() }`, while the bespoke implementation below it duplicates the
publication, stale-owner, ownership, and owner-safe-unlink machinery now provided by
`secure-store/acquireExclusiveLock()`. The implementation should therefore be a delete-and-delegate
refactor inside `plan-engine.ts`, with an adapter that preserves Lidarr validation, fail-fast
contention, same-host dead-pid recovery, cross-host non-stealing, and Lidarr error classes.

The change boundary is unusually strict. The plan/history path walk, bounded reader, and atomic
writers in `plan-engine.ts` remain local for issue #305, including their legitimate `link()` use.
The action layer, public claim interfaces, existing compatibility tests, completion templates, and
public feature documentation should remain byte-identical.

## Existing Code Structure

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
  - Imports private-mode/path constants from `../secure-store/index.js`, but does not yet import the
    shared lock or shared error class.
  - Defines the public `LidarrPlanClaimDependencies` and `LidarrPlanClaim` interfaces near the top.
    These types are consumed by action code and must not change.
  - Still contains the private `CLAIM_MAX_BYTES`, `ClaimRecord`, `parseClaimRecord()`, `readClaim()`,
    `claimIsOwned()`, and `unlinkClaimIfOwned()` implementation.
  - `acquireLidarrPlanClaim()` validates the plan UUID, resolves the claim directory, builds
    `<claimDirectory>/<planId>.lock`, records `{ host, pid, createdAt, ownershipToken }`, performs a
    two-attempt hard-link publication loop, and returns the domain capability.
  - `defaultIsProcessAlive()` treats every probe failure except `ESRCH` as alive. It is part of the
    claim's compatibility policy and must remain, even after the surrounding private lock helpers
    are deleted.
  - The same file also owns plan/history path hardening and artifact publication. Its
    `FileIdentity`, `SafeParent`, `sameIdentity()`, `prepareSafeParent()`,
    `assertSafeParentUnchanged()`, `assertOpenedFileIdentity()`, `readBoundedFile()`, and filesystem
    imports are still used outside the claim block and are not dead after the migration.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`
  - `acquireExclusiveLock(path, options)` is the canonical implementation. It publishes the same
    compact four-field record when no `binding` is supplied and proves full-record plus `{dev, ino}`
    ownership.
  - A zero deadline still permits the immediate create and one immediate same-host-dead-owner steal;
    it prevents only the backoff/wait path.
  - `maxAgeMs` defaults to 120 seconds and enables cross-host age stealing. Passing `null` disables
    that rule while retaining same-host pid recovery.
  - The returned `SecureStoreLock` is frozen, latches `released`, makes repeat release a no-op, and
    refuses to unlink a replacement record.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`
  - `SecureStoreError` has stable codes, a sanitized `path`, and remediation text. Raw errors that
    cannot be faithfully classified remain raw.
  - Only the code and original error should be inspected by the adapter; shared message,
    remediation, and path values must not be copied into Lidarr-facing messages.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`
  - This is the shipped adapter precedent. It validates domain metadata first, converts its
    Date-returning clock to epoch milliseconds, explicitly passes `deadlineEpochMs`, `maxAgeMs`, the
    local liveness probe, and injected UUID source, then wraps the shared lock behind its original
    capability.
  - It deliberately uses different failure policies for acquisition, assertion, and release.
- `packages/rfmedia-cli/src/lib/errors.ts`
  - `LidarrPlanAlreadyRunningError` carries `planId` and `claimPath` and has no constructor options.
  - `LidarrPlanArtifactError` carries the existing `LIDARR_PLAN_UNSAFE_PATH` and `LIDARR_PLAN_IO`
    classifications and accepts a cause.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
  - Acquires a claim only for real applies, forwards a closure calling `claim.assertOwned()` through
    mutation/replay/history boundaries, and releases from its outer `finally`.
  - Artist-add activates the claim lazily after dry-run/admission work; other real plans acquire it
    before mutation execution.
- `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.ts`
  - Owns an independent real-apply claim lifecycle and releases in `finally`; the outer apply action
    intentionally has no claim for this route.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
  - Its real-filesystem claim tests pin live contention, explicit release/reacquisition, displaced
    ownership with a copied token, corrupt partial publication left byte-identical, and refusal to
    reclaim an old foreign-host claim.
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
  - Pins shared dead-pid recovery, fail/busy behavior, `maxAgeMs: null`, legacy record handling,
    full-record/inode ownership, release idempotence, and corrupt-record classification.

## Implementation Patterns

- **Domain adapter over a shared primitive:** Import `acquireExclusiveLock` and `SecureStoreError`
  through `../secure-store/index.js`; do not deep-import `lock.js` or `errors.js`. Return a new frozen
  `LidarrPlanClaim` exposing only `path`, `assertOwned()`, and `release()` rather than leaking
  `ownershipToken`, `binding`, or the shared type.
- **Validate before shared I/O:** Preserve the current order: validate `planId`, resolve the supplied
  claim directory with `resolveLidarrStoragePath()`, derive the lock path, validate host/pid owner
  metadata, and validate the injected ownership UUID before calling the shared lock. The UUID
  wrapper should validate every shared request because the shared writer may use the source for both
  ownership and staging names.
- **Clock adapter:** Keep `LidarrPlanClaimDependencies.now: () => Date` unchanged. Use `Date.now` when
  absent, otherwise a closure returning `dependencies.now().getTime()`. Pass that same closure as
  `now` and evaluate it for `deadlineEpochMs`.
- **Explicit policy options:** Use subject `"Lidarr plan claim"`, `deadlineEpochMs: nowMs()`, and
  `maxAgeMs: null`. Forward the already-resolved host and pid, the local
  `dependencies.isProcessAlive ?? defaultIsProcessAlive`, and the validating UUID source. Do not
  pass `binding`; the validated plan UUID already selects the filename and a binding would make the
  existing four-field record incompatible.
- **Operation-specific error translation:** Follow the preset adapter's three-policy structure, not
  one generic catch-all.
  - Acquire: `SECURE_STORE_LOCK_BUSY` and `SECURE_STORE_CORRUPT` become
    `LidarrPlanAlreadyRunningError`.
  - Assert: a released, missing, displaced, busy, or corrupt lock becomes
    `LidarrPlanAlreadyRunningError`.
  - Release: suppress only `SECURE_STORE_CORRUPT`, because malformed replacement bytes prove the
    record is foreign and must remain untouched. Translate genuine safety/I/O failures; repeat
    release remains a no-op in the held shared capability.
  - Any `SECURE_STORE_UNSAFE_PATH` or `SECURE_STORE_PERMISSIONS` becomes a
    `LIDARR_PLAN_UNSAFE_PATH` artifact error. Other shared failures and raw I/O become
    `LIDARR_PLAN_IO`.
  - Re-throw already-constructed `LidarrPlanValidationError` and `LidarrPlanArtifactError`
    unchanged so validation order and taxonomy do not drift.
- **Fixed local diagnostics:** Construct Lidarr errors from local literals such as inability to
  acquire/assert/release the claim. Preserve the original failure only as `cause`; never interpolate
  `error.message`, `SecureStoreError.path`, or `.remediation`.

## Integration Points

The only production integration point that should change is the implementation behind
`acquireLidarrPlanClaim()`. Existing callers intentionally remain storage-agnostic:

1. `executeLidarrApply()` validates and preflights before a real claim is activated.
2. It passes `() => claim.assertOwned()` into artist/album mutation, deferred replay, verification,
   and history persistence helpers.
3. `executeLidarrTrackFilterApply()` acquires and checks its own claim around destructive deletion
   and durable history.
4. Both lifecycles release in `finally`; release translation must therefore avoid masking an apply
   failure while still surfacing genuine path/I/O faults when no earlier failure exists.

Files expected to change for implementation and closeout:

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: add the adapter and delete only private claim
  mechanics.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: update stale module documentation so it says
  plan/history walks, readers, and writers remain local for #305 while claim locking delegates.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`: replace the stale UUID-pattern comment that
  says plan/preset modules declare byte-identical copies; they now consume the exported pattern for
  boundary validation.
- `docs/internal/plex-jwt-deferrals.md`: change the duplicate-lock inventory and mark #304 resolved
  while retaining #305.
- `ROADMAP.md`: update only during closeout, reconciled against live issue state.

Files and surfaces to keep untouched:

- `packages/rfmedia-cli/src/lib/errors.ts` and the public `LidarrPlanClaimDependencies` /
  `LidarrPlanClaim` declarations.
- All `packages/rfmedia-cli/src/actions/lidarr/**` claim consumers and callback types.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`,
  `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`, and their fixtures/snapshots.
- `plan.ts`, the plan/history readers and writers in `plan-engine.ts`, completion templates, command
  registration, README files, and `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`.

## Code Conventions

- TypeScript is strict NodeNext ESM; relative source imports use the emitted `.js` suffix and type
  imports are separated with `import type` when needed.
- Shared secure-store consumers import exclusively from `secure-store/index.ts`.
- Error conversion helpers return a typed error and callers `throw` them; causes use native
  `ErrorOptions` where the target class supports it.
- Capability objects are frozen before return. Optional fields are added with conditional spreads
  rather than explicit `undefined` values.
- Injected dependencies are resolved once before I/O. Local defaults are retained when their
  semantics differ from shared defaults.
- Comments explain policy reasons—zero wait, disabled age stealing, and local liveness semantics—not
  the mechanics visible in the code.
- Markdown files require blank lines around headings and must pass the repository markdown lint.

## Dependencies and Services

- No package dependency, config key, environment variable, command option, or completion entry is
  required. The implementation uses Node 22 built-ins and the existing in-package secure-store.
- `createPrivateFileAtomically()` supplies `0o600` staging, hard-link no-clobber publication,
  parent/file identity checks, directory durability, and cleanup. `acquireExclusiveLock()` layers
  retry/stale policy and owner-safe release over it.
- The shared reader enforces private file mode (`mode & 0o077 === 0`), unlike the old claim reader.
  The adapter must translate that shared permission failure to the established unsafe-path artifact
  taxonomy rather than exposing a secure-store code.
- Verification is under the repository's Node 22 contract. The focused gates are the unmodified
  plan-engine claim suite, secure-store suite, and Bash/Zsh/Fish completion parity suite, followed by
  typecheck, architecture, repository tests, markdown lint, format check, and `git diff --check`.

## Gotchas and Warnings

- Never omit `maxAgeMs: null`. The default 120-second age rule can steal a healthy long-running apply
  on another host; the claim has no renewal mechanism.
- A deadline equal to `nowMs()` is not equivalent to skipping acquisition. The shared loop still
  gets its immediate create and one dead-owner recovery attempt before checking remaining time.
- Do not substitute `isProcessAliveByDefault`. For errors other than `ESRCH`, the current Lidarr
  policy fails closed as alive; the shared default is more permissive.
- Do not pass `binding`. The existing on-disk record has exactly four fields. The shared parser is
  byte-compatible only when `binding` is absent.
- The shared parser is not an exact-key parser, and the shared reader adds a private-mode gate. These
  are known semantic differences. They must not surface as `SECURE_STORE_*` codes or justify
  broadening this issue into the #305 reader/path migration.
- `LidarrPlanAlreadyRunningError` currently lacks an `ErrorOptions` constructor, although the design
  requires the shared failure to be retained only as `cause`. Keep `errors.ts` untouched by attaching
  the native `Error.cause` on the locally constructed instance in a narrow helper; do not widen the
  public constructor solely for this refactor.
- The injected UUID source is used more often by the shared implementation than by the old lock: it
  can produce both the ownership token and staging suffix. Validate every value and avoid assuming
  the seam is called exactly once.
- Do not remove `nodeRandomUUID`, `nodeHostname`, `link`, `open`, `rm`, `unlink`, `FileHandle`,
  `PRIVATE_FILE_MODE`, or the local path/identity helpers merely because they appear in the old claim
  block; all remain live in plan construction, artifact publication, or history writing.
- Release runs in `finally`. Suppressing every release error would hide real custody failures;
  throwing every release error would mask the apply failure. Only corrupt replacement content is
  the legacy-compatible suppression case.
- Dry runs must continue to avoid claims. Moving claim acquisition upward or into a shared action
  helper would violate this contract.
- The remaining `link()` in `writeLidarrPlanArtifact()` is intentional and belongs to #305. A grep
  that expects zero `link()` calls in `plan-engine.ts` is incorrect; only the claim-private link loop
  should disappear.

## Task-Specific Guidance

1. Extend the existing secure-store barrel import in `plan-engine.ts` with
   `acquireExclusiveLock`, `SecureStoreError`, and any needed lock type. Add a fixed claim subject
   and narrow translators near the claim boundary rather than near generic plan validation.
2. Preserve the public interfaces verbatim. Resolve and validate all inputs before the shared call,
   including non-empty host, positive safe-integer pid, a valid Date-to-epoch result, and every UUID
   emitted by the injected source.
3. Call `acquireExclusiveLock(claimPath, { subject, deadlineEpochMs: nowMs(), maxAgeMs: null, now:
nowMs, hostname: () => host, pid, isProcessAlive, randomUUID })` with no signal and no binding.
4. Wrap the held lock with the existing `LidarrPlanClaim` shape. Translate assertion and release
   failures at the callback boundary; do not return the shared lock directly.
5. Delete `CLAIM_MAX_BYTES`, `ClaimRecord`, `parseClaimRecord()`, `readClaim()`, `claimIsOwned()`, and
   `unlinkClaimIfOwned()`. Retain `defaultIsProcessAlive()` and audit imports by actual remaining use.
6. Update only the two secure-store comments in source. Defer plan/history filesystem code and all
   action changes to their owning issues.
7. Run the existing focused suites without editing them. Treat any required compatibility-test,
   completion, or action-layer change as evidence that the adapter changed behavior and should be
   re-scoped before proceeding.
8. Before closeout, confirm the claim test file and public interfaces are byte-identical to the merge
   base, the claim-private helpers are absent, action releases still live in `finally`, and artifact
   publication still retains its independent hard-link path.
