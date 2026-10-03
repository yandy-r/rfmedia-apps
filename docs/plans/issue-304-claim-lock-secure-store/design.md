# Issue 304 — Migrate the Lidarr Plan Claim Lock onto Secure Store

Status: design complete, ready for implementation.
Branch: `chore/304-claim-lock-secure-store`.
Package under change: `packages/rfmedia-cli`.
Depends on: issue #288 (shipped by PR #309).
Unblocks: issue #305.

## Context

`acquireLidarrPlanClaim()` currently contains the package's last bespoke `link()`-based lock. It
publishes a private four-field JSON record, rejects concurrent application of the same sealed plan,
recovers only a demonstrably dead same-host owner, reasserts the complete record and inode before
irreversible work, and removes the lock only while the current process still owns it.

PR #309 made `src/lib/secure-store/acquireExclusiveLock()` the canonical implementation of those
mechanics and added most policy seams this site needs. Plan validation found two remaining
compatibility gaps: the shared parser accepts extra record keys that the claim parser rejects, and
the shared lock reuses the injected ownership UUID source for temporary names while the claim uses
an uninjected UUID source for staging. This issue closes those gaps additively before removing the
duplicate lock machinery, without changing the public `LidarrPlanClaimDependencies`,
`LidarrPlanClaim`, action-layer callbacks, CLI surface, on-disk published path, or observable Lidarr
error classes.

## Goals

- Delegate claim publication, contention handling, stale-owner recovery, ownership checks, and
  release to `acquireExclusiveLock()` through the `secure-store/index.ts` barrel.
- Preserve fail-fast contention and same-host-dead-pid recovery.
- Prevent age-based cross-host stealing for applies that legitimately exceed 120 seconds.
- Preserve `LidarrPlanAlreadyRunningError` for live contention, corrupt partial claims, and lost
  ownership while leaving corrupt/replacement bytes untouched.
- Preserve path redaction, validation order, dependency injection seams, idempotent release, and all
  existing action-layer call sites.
- Preserve exact four-key claim parsing so an extra-key record remains corrupt contention and can
  never be stolen, asserted, or released as though the extra data did not exist.
- Preserve ownership UUID injection without reusing that seam for staging filenames.
- Delete only claim-private machinery so #305 retains a clean, separate path/writer revert unit.

## Non-Goals

- Migrating plan/history path walks, bounded readers, atomic writers, or directory hardeners; #305
  owns those changes.
- Adding a lock `binding`, renewal, timeout, cancellation, CLI flag, config key, or environment
  variable.
- Changing the published claim filename or record schema.
- Editing the existing claim compatibility tests or public feature documentation.
- Removing every `link()` call from `plan-engine.ts`; artifact publication still legitimately uses
  `link()` until #305.

## Existing Contract

The claim path is `<claimDirectory>/<planId>.lock`, where `planId` is a validated UUID and the
default directory is `${RFMEDIA_PLAN_DIR}/lidarr-claims`. The published compact JSON record contains
exactly `host`, `pid`, `createdAt`, and `ownershipToken`. Ownership is the conjunction of that full
record and `{dev, ino}`; a copied token or reused inode alone is insufficient.

`LidarrPlanClaim` exposes only `path`, `assertOwned()`, and `release()`. Callers thread the assertion
through mutation, deferred-replay, verification, and history boundaries, and release from outer
`finally` blocks. Dry runs do not acquire a claim.

## Decision

Keep `acquireLidarrPlanClaim()` as a thin domain adapter and replace its internal record reader,
hard-link loop, ownership comparison, stale recovery, and compare-and-unlink helpers with one call
to `acquireExclusiveLock()`.

The call uses:

- `subject: "Lidarr plan claim"` so shared messages never include user-derived bytes;
- `deadlineEpochMs: nowMs()` to preserve zero-wait contention while allowing the shared algorithm's
  one immediate same-host-dead-owner recovery attempt;
- `maxAgeMs: null` because a healthy apply can exceed the shared 120-second default and the claim has
  no renewal API;
- the existing injected `hostname`, `pid`, `isProcessAlive`, `now`, and `randomUUID` seams;
- `strictRecordShape: true` so an existing or displaced claim must contain exactly the four legacy
  fields and no ignored extension keys;
- a separate temporary-name UUID source backed by `nodeRandomUUID`, leaving the injected UUID seam
  responsible only for the ownership token as before;
- no `binding`, because the validated plan UUID already names the lock path and adding a binding
  would make a pre-migration four-field record unrecoverable after a crash.

The adapter validates `planId`, the claim directory, owner metadata, and the injected ownership UUID
before shared I/O. It samples the Date-returning clock once and exposes that cached epoch to the
shared call, preserving the legacy single acquisition timestamp and zero-wait deadline without
changing the public dependency type. The returned object exposes only the existing claim surface;
shared-only fields remain internal.

## Shared Surface Amendment

`SecureStoreLockOptions` gains two optional, backward-compatible fields:

- `strictRecordShape?: boolean`, default `false`. When true, every acquisition, assertion, stale
  recovery, and release read rejects keys outside the exact record shape expected by that call. An
  unbound lock accepts exactly `host`, `pid`, `createdAt`, and `ownershipToken`; a bound lock accepts
  the corresponding binding or supported legacy-binding shape, but never unrelated keys.
- `temporaryUUID?: () => string`, defaulting to the existing ownership `randomUUID` source so every
  current consumer remains byte- and test-compatible. The claim adapter supplies `nodeRandomUUID`
  here while its existing injected source supplies the stable ownership token.

One focused test block in `secure-store.test.ts` covers the combined boundary: the ownership UUID
and temporary UUID sources remain distinct; acquisition rejects a same-host dead-owner record with
an extra key and leaves it byte-identical; and an extra-key mutation of a held lock makes
`assertOwned()` fail closed while `release()` preserves the foreign bytes. This is the only new test
planned; it proves behavior the existing shared suite does not cover and avoids editing the
issue-mandated unmodified plan-engine suite.

## Error Translation

Translation is operation-specific:

| Operation | Shared/raw failure                            | Lidarr result                                    |
| --------- | --------------------------------------------- | ------------------------------------------------ |
| Acquire   | `SECURE_STORE_LOCK_BUSY`                      | `LidarrPlanAlreadyRunningError`                  |
| Acquire   | `SECURE_STORE_CORRUPT`                        | `LidarrPlanAlreadyRunningError`; bytes unchanged |
| Assert    | busy, missing, replaced, released, or corrupt | `LidarrPlanAlreadyRunningError`                  |
| Release   | `SECURE_STORE_CORRUPT`                        | Resolve without unlinking                        |
| Any       | unsafe path or permissions                    | Existing unsafe-path artifact classification     |
| Any       | remaining shared code or raw I/O              | Existing Lidarr plan I/O classification          |

Already-constructed Lidarr validation/artifact errors pass through unchanged. Translators use fixed
local messages and retain the original error as `cause` only where the existing target error type
supports it; they never widen `LidarrPlanAlreadyRunningError` or expose `SecureStoreError.path`,
`.remediation`, or a raw path-bearing filesystem message.

Acquisition and assertion deliberately use distinct helpers: a shared corrupt record means
contention during acquisition and lost ownership during assertion. Release has a third policy
because throwing from a `finally` block could mask the real apply failure, and the legacy behavior
already treated malformed replacement bytes as foreign and left them untouched.

## Compatibility Decisions

### Liveness

Pass `dependencies.isProcessAlive ?? defaultIsProcessAlive` from `plan-engine.ts`. Its fail-closed
policy treats every probe failure except `ESRCH` as alive, which is stricter than the shared
default. Substituting the shared default would silently widen stale-owner recovery.

### UUID source

Validate the injected ownership token before I/O so an invalid UUID remains a
`LidarrPlanValidationError`. Pass `nodeRandomUUID` through the new temporary-name seam so the shared
implementation never consumes the injected ownership source for staging. The focused shared test
must prove both sources are used only for their intended roles.

### Legacy record

Do not pass `binding`. The shared four-field record remains byte-compatible with the old published
shape, so a same-host dead record left by an older build remains recoverable. Unknown-key and mode
classification differences must not escape the Lidarr adapter as new shared error codes.

The shared parser's value grammar remains deliberately stricter for malformed incumbents: it
requires a non-empty host and positive PID, while the removed parser accepted an empty host and any
safe-integer PID; conversely, the shared parser does not reject terminal-control host strings. The
shipped producer cannot create any of those records, and empty/control-character hosts cannot equal
the validated local host. The only observable seam delta is a hand-crafted same-host record with a
non-positive PID plus an injected liveness probe that reports it dead: the old code could reclaim
it, while the adapter classifies it as corrupt contention and preserves it. This fail-closed
malformed-record hardening is accepted explicitly; it does not change production record bytes,
public errors, or valid same-host dead-owner recovery.

### Release

Expose the shared idempotent release, suppress only a corrupt replacement as not-owned, and
translate genuine path/I/O failures without deleting foreign bytes. A second release remains a
no-op.

## Files and Change Boundaries

1. `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
   - Import shared lock/error APIs through the barrel.
   - Add narrow operation-specific translators and clock/UUID adapters.
   - Replace the bespoke claim acquisition block.
   - Delete only claim-private record/read/ownership/unlink code and constants.
2. `packages/rfmedia-cli/src/lib/secure-store/lock.ts`
   - Add the optional strict-record and temporary-UUID seams with backward-compatible defaults.
   - Thread strict parsing through acquire, assert, stale recovery, and release.
   - Correct stale UUID-pattern JSDoc after duplicate claim code is removed.
3. `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
   - Add one critical contract test for strict extra-key rejection, byte preservation, and separate
     ownership/staging UUID sources.
4. `packages/rfmedia-cli/src/lib/secure-store/index.ts`
   - Correct module JSDoc: claim locking now delegates; path walks/readers/writers remain local for
     #305.
5. `docs/internal/plex-jwt-deferrals.md`
   - Mark #304 resolved and record that shared locking is canonical while #305 remains open.
6. `ROADMAP.md`
   - Reconcile #304 closure and counts against live GitHub issue state immediately before closeout.

No existing plan-engine test, completion template, command registration, README, or public feature
guide should change if the migration is truly behavior-preserving. The one secure-store test above
is required to prove the newly exposed strict-parser and staging-UUID contract.

## Critical Verification

The existing plan-engine suite remains the unmodified compatibility contract. Add exactly one new
test block to the secure-store suite for the strict-record/temporary-UUID surface identified during
plan validation; do not add broader action tests or duplicate existing lock coverage.

From `packages/rfmedia-cli`, under Node 22:

```bash
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/shell-completions/templates.spec.ts
npm run typecheck
npm run check:architecture
```

From the repository root:

```bash
npm run test:run
npm run lint:md
npm run format:check
git diff --check
```

Additional invariants:

- `plan-engine.test.ts` is byte-identical to the merge base.
- The unrelated `plan.test.ts` snapshot remains byte-identical; `plan-engine.test.ts` has no snapshot.
- `LidarrPlanClaim` and `LidarrPlanClaimDependencies` are byte-identical.
- The old claim-block `link()` implementation and claim-private helpers are gone.
- Artifact publication remains intact and is not misreported as duplicate claim locking.
- Bash, Zsh, and Fish templates have no diff; their exact apply-option parity test passes.
- All action-layer claim consumers compile unchanged and their release paths remain in `finally`.

## Risks and Rollback

The highest risks are accidental age stealing, ignored extra record keys, escaping shared errors,
release masking, UUID-seam drift, and legacy record incompatibility. Each is controlled by an
explicit shared/adapter option or translation arm and proven by the one new primitive test plus the
unmodified compatibility suites. The implementation should keep the shared-surface amendment and
claim adapter in reviewable commits, followed by documentation/ROADMAP commits, so the migration can
be reverted independently from issue #305.
