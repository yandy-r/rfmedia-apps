# Issue #304 Integration Research: Lidarr Plan Claim Lock

**Status:** Superseded pre-design artifact; retained for historical context and not the
implementation source of truth.
**Canonical design:** [`design.md`](../issue-304-claim-lock-secure-store/design.md)
**Canonical plan:** [`parallel-plan.md`](../issue-304-claim-lock-secure-store/parallel-plan.md)

## Overview

Issue #304 is an internal, behavior-preserving migration of the last bespoke Lidarr plan claim
lock onto `src/lib/secure-store/acquireExclusiveLock`. The safe integration boundary is a thin
adapter in `plan-engine.ts`: callers must continue to receive the existing `LidarrPlanClaim` and
Lidarr error types while the shared lock owns publication, ownership checks, stale-owner recovery,
and release.

There is no database schema change, network protocol change, external API change, CLI option
change, or new external service. The lock remains a local-filesystem coordination record that gates
existing Lidarr mutations, deferred-queue database work, and plan-history writes.

## Relevant Files

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: public claim interfaces, current lock
  implementation, Lidarr path/error taxonomy, and default claim path.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`: canonical `acquireExclusiveLock`, lock record,
  staleness, ownership, waiting, and release semantics.
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`: absolute-path resolution, owner-only parent
  validation, bounded private reads, and inode assertions used by the shared lock.
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`: private staged creation, atomic `link()`
  publication, directory durability, and temporary-file naming.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`: `SecureStoreError` codes, sanitized path
  retention, and raw-errno mapping.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: supported import boundary; consumers must use
  this barrel rather than deep imports.
- `packages/rfmedia-cli/src/lib/errors.ts`: externally observable `LidarrPlanAlreadyRunningError`
  and `LidarrPlanArtifactError` contracts.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`: already-migrated Lidarr lock
  adapter and the closest error-translation/release precedent.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: general apply coordinator, lazy artist-add claim
  activation, real-apply claim lifecycle, signal cleanup, and callback fan-out.
- `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.ts`: independent real-delete
  claim lifecycle with ownership checks around reads, dispatch, and history.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`: lazily activates the claim after
  read-only preflight and passes the ownership assertion into entry execution.
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`: artist mutation dispatch and
  history boundaries protected by the assertion callback.
- `packages/rfmedia-cli/src/actions/lidarr/apply-album-mutation-execution.ts`: album mutation and
  history boundaries protected by the assertion callback.
- `packages/rfmedia-cli/src/actions/lidarr/apply-deferred-replay.ts`: claim checks around claiming,
  restoring, and replaying durable deferred work.
- `packages/rfmedia-cli/src/actions/lidarr/apply-deferred-replay-entry.ts` and
  `apply-deferred-replay-outcomes.ts`: per-entry replay and terminal-outcome persistence boundaries.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-entry-execution.ts`,
  `apply-artist-add-entry-execution.ts`, `apply-target-execution.ts`, and `apply-target-types.ts`:
  typed callback plumbing and last-moment ownership checks before remote mutations or durable
  markers.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: unchanged claim compatibility tripwire.
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`: shared lock acquisition,
  staleness, binding, full-record ownership, displacement, and release contracts.
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`: end-to-end claim-loss behavior during
  normal and deferred apply.
- `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.test.ts`: contention must
  block target reads and deletion.
- `docs/plans/issue-288-secure-store-migration/design.md`: predecessor design, including the exact
  deferral rationale and option mapping for this issue.

## API Endpoints and Internal APIs

### Public/internal claim contract to preserve

There is no HTTP endpoint or RPC surface. The relevant exported TypeScript API is:

```ts
export interface LidarrPlanClaimDependencies {
  readonly claimDirectory?: string;
  readonly hostname?: () => string;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly randomUUID?: () => string;
}

export interface LidarrPlanClaim {
  readonly path: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

acquireLidarrPlanClaim(planId, dependencies?): Promise<LidarrPlanClaim>
```

Externally observable behavior is:

- `planId` and the injected ownership token must be UUID-shaped; invalid values currently fail as
  `LidarrPlanValidationError` before a claim is returned.
- `path` is the absolute `${claimDirectory}/${planId}.lock` path.
- A live or foreign-host owner, a malformed partial record, and ownership loss surface as
  `LidarrPlanAlreadyRunningError`. Its message remains
  `Lidarr plan <planId> is already being applied`, with `planId` and `claimPath` fields.
- `assertOwned()` resolves only while the full record and `{dev, ino}` still match. It fails after
  release, after unlink, and after replacement even if the replacement copies the token.
- `release()` is idempotent and must never unlink a replacement claim. A malformed replacement is
  treated as not-owned and left in place.
- A same-host owner is reclaimed only when `isProcessAlive(pid)` proves it dead. An old record on a
  different host is never reclaimed.
- Acquisition is fail-fast on contention; it does not wait for a live owner.

### Shared lock adapter mapping

The shared call should retain the existing dependency surface and use these option semantics:

| Shared option                                     | Required value                                    | Reason                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `subject`                                         | Fixed local literal such as `"Lidarr plan claim"` | No file- or server-derived bytes in messages.                                                                                              |
| `deadlineEpochMs`                                 | The injected acquisition epoch                    | A zero-length deadline preserves fail-fast contention while still allowing the shared lock's one stale-owner steal.                        |
| `now`                                             | Adapter from `() => Date` to `() => number`       | Preserves deterministic clock injection; capturing one epoch also preserves the current single acquisition timestamp.                      |
| `maxAgeMs`                                        | `null`                                            | Disables the shared 120-second cross-host age steal. A healthy apply can legitimately exceed two minutes and the claim has no renewal API. |
| `hostname`, `pid`, `isProcessAlive`, `randomUUID` | Existing injected sources                         | Preserves test/embedding seams and same-host dead-pid recovery.                                                                            |
| `signal`                                          | Omitted                                           | Claim acquisition currently has no cancellation input and never waits.                                                                     |

Do not add `binding` merely for uniformity. The claim path is already namespaced by `planId`, and
the existing on-disk record has no binding. Passing `binding: planId` would make every pre-migration
claim unparseable to the current shared parser, permanently blocking recovery of a same-host claim
left by a crashed older build. If design later requires a binding, secure-store needs an explicit
legacy unbound-record compatibility rule first.

The adapter needs separate operation arms because the same shared error has different claim
meaning depending on context:

| Operation | Shared failure                                       | Lidarr-visible result                                                                  |
| --------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Acquire   | `SECURE_STORE_LOCK_BUSY`                             | `LidarrPlanAlreadyRunningError`                                                        |
| Acquire   | `SECURE_STORE_CORRUPT`                               | `LidarrPlanAlreadyRunningError`; leave bytes unchanged                                 |
| Assert    | missing/mismatch/released (`SECURE_STORE_LOCK_BUSY`) | `LidarrPlanAlreadyRunningError`                                                        |
| Assert    | malformed record (`SECURE_STORE_CORRUPT`)            | `LidarrPlanAlreadyRunningError`                                                        |
| Release   | `SECURE_STORE_CORRUPT`                               | Resolve without unlinking; current malformed-replacement behavior treats it as foreign |
| Any       | `SECURE_STORE_UNSAFE_PATH`                           | `LIDARR_PLAN_UNSAFE_PATH`, preserving path-redaction rules for invalid input           |
| Any read  | `SECURE_STORE_TOO_LARGE`                             | `LIDARR_PLAN_TOO_LARGE`                                                                |
| Any       | raw/unclassified I/O or other secure-store code      | `LIDARR_PLAN_IO`, retaining the original failure as `cause`                            |

The acquisition translator must not be reused blindly by `assertOwned()` or `release()`: doing so
would make release throw `AlreadyRunning` for an unreadable replacement and could mask the real
apply failure from a `finally` block.

## Persistence and Filesystem Schema

The durable name and record are part of the compatibility boundary:

- Default directory:
  `${RFMEDIA_PLAN_DIR:-~/.config/rfmedia/plans}/lidarr-claims`.
- Test/embedding override: `LidarrApplyActionOptions.claimDirectory`; there is no CLI flag or config
  file field for it.
- Published file: `<plan UUID>.lock`.
- Existing compact JSON schema, with no newline:

  ```json
  { "host": "host", "pid": 42, "createdAt": "2026-07-22T12:00:00.000Z", "ownershipToken": "uuid" }
  ```

- Claim records are bounded to 4096 bytes. Missing directories are created owner-only; the
  published file is private and atomically linked into place.
- Ownership is the conjunction of the complete normalized record and `{dev, ino}`. Neither the
  token nor inode alone is sufficient because inode reuse and copied tokens are both possible.
- `link()` is the mutual-exclusion primitive. Both implementations document local-filesystem
  semantics; NFS/SMB hard-link behavior is not a supported lock guarantee.

Shared-store delegation strengthens durability by syncing the containing directory after
publication and best-effort after unlink, and explicitly `chmod(0600)`s a staged file after open.
It also changes the ephemeral stage name from
`.${planId}.<uuid>.claim.tmp` to `.${basename(lockPath)}.<uuid>.tmp`. No caller should depend on the
stage name, but orphan-cleanup or operational tooling must not mistake it for a published claim.

## Internal Services and Data Flow

```text
CLI lidarr apply
  -> executeLidarrApply / executeLidarrTrackFilterApply
     -> acquireLidarrPlanClaim
        -> secure-store acquireExclusiveLock
     -> assertOwned callback
        -> pre-dispatch checks
        -> deferred SQLite claim/restore/replay boundaries
        -> Lidarr API mutations
        -> verification and JSONL history persistence
     -> finally release
```

- Dry runs never acquire a claim and remain read-only.
- Artist-add performs read-only preflight first, then lazily activates the claim immediately before
  the first real entry execution.
- Other real applies acquire before mutation admission and pass a zero-argument assertion callback
  through the execution modules. This callback shape must remain unchanged; it is intentionally
  decoupled from the lock implementation.
- Track-file deletion owns its claim locally and checks before target reads, before bulk deletion,
  and before terminal history persistence.
- Global cleanup aborts admission, waits for the action to settle, and then the action's outer
  `finally` releases the claim. Release failures therefore have masking risk.
- Deferred replay uses the callback around SQLite intent transitions. The database schema and SQL
  are unchanged; the migration changes only the filesystem lock protecting those transitions.

The production `assertOwned` fan-out is concentrated in twelve claim-related action modules. The
separate `profile-presets.ts` references use `LidarrPresetApplyLock`, not `LidarrPlanClaim`, and must
not be mechanically rewritten as part of this issue.

## External Services

- **Lidarr:** no endpoint, request body, retry policy, authentication, or client code changes. The
  claim continues to prevent concurrent remote mutations for one sealed plan.
- **SQLite deferred-intent database:** no schema or query change. Claim loss still prevents or
  restores replay transitions before remote dispatch.
- **Plan history JSONL:** no schema or path change. Ownership checks remain immediately adjacent to
  history writes where the action code currently places them.
- **Plex/media scan integration:** no change; scans remain downstream of apply results.
- **Docker, GitHub, and other services:** no runtime integration.

## Configuration

- `RFMEDIA_PLAN_DIR` remains the only operator-facing path seam and indirectly controls the default
  claim directory.
- `claimDirectory` remains a TypeScript test/embedding override on apply options and claim
  dependencies; it is not promoted to CLI/YAML/environment configuration.
- No new timeout, max-age, lock-renewal, or cancellation configuration should be introduced.
  `maxAgeMs: null` and fail-fast deadline behavior are invariants, not user preferences.

## Architectural Patterns

- **Adapter preserves domain errors:** shared filesystem primitives remain behind Lidarr-specific
  errors and interfaces, matching the migrated preset-lock pattern.
- **Capability callback fan-out:** action modules receive `() => Promise<void>` instead of a lock
  object, preventing persistence details from leaking into mutation executors.
- **Check at irreversible boundaries:** ownership is reasserted before remote dispatch and durable
  state transitions, not only once at acquisition.
- **Compare-and-unlink:** release re-reads and compares the whole record plus inode before unlinking.
- **Fail closed:** malformed partial publication is contention, never permission to steal or repair.
- **Local atomic publication:** a private staged file is fsynced and published with `link()`; the
  target is never overwritten.
- **Barrel-only shared imports:** `plan-engine.ts` imports secure-store APIs from
  `../secure-store/index.js`, keeping architecture checks and module ownership intact.

## Gotchas and Edge Cases

- The shared default steals any record older than 120 seconds, including live cross-host owners.
  Omitting `maxAgeMs: null` can split ownership during a healthy long-running apply.
- A deadline equal to the injected clock still permits the stale-owner check before the deadline
  failure. This is what preserves one immediate same-host dead-pid recovery without introducing
  waiting.
- The corrupt partial-claim test requires byte identity after failure. Never delete, rewrite,
  quarantine, or normalize a record that maps to `SECURE_STORE_CORRUPT`.
- `resolveSecurePath` retains a sanitized path on `SecureStoreError.path` and embeds it in
  `remediation`; the Lidarr invalid-input contract omits `planPath` and does not echo the offending
  path. Validate with the existing Lidarr resolver before shared delegation or translate without
  copying shared path/remediation text.
- The shared reader rejects group/other-accessible lock files, while the bespoke reader accepts
  them. Normally produced claims are private, but a manually created `0644` legacy claim changes
  classification. Treat this as an integration decision, not an accidental escaping
  `SecureStoreError`.
- The record parsers are not byte-identical: the current parser requires exactly four keys; the
  shared parser tolerates unknown keys and optionally understands `binding`. This can change
  whether an extended legacy record is considered corrupt or eligible for stale recovery.
- Current injected `randomUUID` supplies only the ownership token; shared locking also forwards its
  UUID source to stage naming and may call it again on retry. A constant test seam therefore also
  creates a constant stage suffix. Validate the token in the adapter before I/O to preserve
  `LidarrPlanValidationError`, and document/avoid orphan-stage collision risk.
- Current owner metadata accepts a broader set of injected values than secure-store (for example an
  empty hostname or non-positive safe-integer pid). Shared lock rejects these as corruption. They
  are test/embedding seams, but this is still a behavior delta if not normalized or explicitly
  accepted.
- `release()` latches before its ownership read in both implementations. Once a release attempt
  starts, later calls are no-ops even if the first attempt encounters I/O failure.
- The general apply and track-filter apply acquire claims through different coordinators. Updating
  only `apply.ts` does not migrate the track-file deletion path.
- `profile-presets.ts` is already a separate secure-store consumer. Its `assertOwned()` errors use
  `LIDARR_PRESET_LOCK_LOST`, so its adapter must not be consolidated with the plan-claim translator.
- Do not migrate the remaining plan-engine safe-parent walk, readers, or artifact/history writers
  here. Issue #305 depends on this adapter and handles their broader error taxonomy separately.

## Test and Verification Boundaries

The issue's primary abort criterion is that
`packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` passes unmodified. Its claim tests pin:

- one live owner, fail-fast contention, explicit release, and reacquisition;
- full-record/inode displacement detection and non-destructive release;
- malformed partial publication mapping to `LidarrPlanAlreadyRunningError` with byte-identical
  preservation;
- no age-based reclamation of an old foreign-host owner.

Supporting integration tests pin behavior beyond the claim unit:

- `apply.test.ts`: loss before normal dispatch produces the existing already-running error and no
  mutation; loss before deferred replay restores the pending intent and permits a later resume.
- `apply-artist-add-entry-execution.test.ts`: a rejected ownership callback prevents the durable
  marker and artist POST.
- `apply-track-filter-execution.test.ts`: a competing claim prevents both target reads and bulk
  deletion.
- `secure-store.test.ts`: `maxAgeMs: null`, same-host dead-pid recovery, fail-fast busy behavior,
  corrupt binding, full-record/inode ownership, post-release assertion failure, and idempotent
  non-destructive release.

Verification should use the issue's commands from `packages/rfmedia-cli` under Node 22 via the
repository runtime:

```bash
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts
npm run typecheck
npm run check:architecture
```

Then run the root `npm run test:run`. Also verify no bespoke claim `link()` remains in
`plan-engine.ts`, `LidarrPlanClaim` is unchanged, all three action acquisition sites still release
in `finally`, and no Bash/Zsh/Fish completion changes are needed because no CLI surface changes.

## Integration Risks

- **Critical:** default age stealing can create two simultaneous owners during a long apply.
- **Critical:** an escaping `SecureStoreError` changes public error class, message, fields, and CLI
  formatting; corruption and path failures need explicit translation.
- **High:** translating release like acquisition can mask an in-flight mutation failure and leave
  operators with a misleading contention error.
- **High:** adding `binding` without legacy handling strands claims from older builds after a crash.
- **High:** losing checks at any callback handoff can permit remote mutation or history/SQLite
  transition after ownership displacement.
- **Medium:** shared private-mode enforcement and looser unknown-key parsing differ from the bespoke
  reader and should be consciously accepted or adapted.
- **Medium:** clock and UUID adapters have different call-count semantics from the current
  implementation; stateful test seams can expose the difference.
- **Low:** shared directory fsync and stage naming alter implementation details but not the
  published claim contract.

## Relevant Docs

- GitHub issue #304: <https://github.com/yandy-r/rfmedia-apps/issues/304>
- GitHub issue #305: <https://github.com/yandy-r/rfmedia-apps/issues/305>
- `docs/plans/issue-288-secure-store-migration/design.md`: predecessor architecture and explicit
  claim-lock deferral.
- `docs/plans/issue-288-secure-store-migration/plan.md`: shipped shared-lock option, ownership, and
  translator design.
