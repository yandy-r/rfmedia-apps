# Issue 304 Claim-Lock Secure-Store Analysis Context

**Status:** Superseded pre-design artifact; retained for historical context and not the
implementation source of truth.
**Canonical design:** [`design.md`](../issue-304-claim-lock-secure-store/design.md)
**Canonical plan:** [`parallel-plan.md`](../issue-304-claim-lock-secure-store/parallel-plan.md)

## Executive Summary

Issue #304 is a behavior-preserving delete-and-delegate refactor. Keep
`acquireLidarrPlanClaim()` as the sole Lidarr domain boundary and replace only its bespoke lock
publication, stale-owner recovery, ownership proof, and release machinery with
`secure-store/acquireExclusiveLock()`.

The public contract must not move: `LidarrPlanClaimDependencies`, `LidarrPlanClaim`, every action
callback, CLI behavior, claim path, four-field record, and Lidarr-visible error class remain stable.
The adapter must make three policy choices explicit: fail-fast contention with
`deadlineEpochMs: now`, no age-based stealing with `maxAgeMs: null`, and no `binding` so claims left
by pre-migration builds remain recoverable.

The highest-risk work is not the delegation itself but compatibility at the boundary:

- Translate shared errors differently for acquire, assert, and release.
- Preserve the local fail-closed process-liveness policy.
- Reject invalid paths and owner metadata without exposing secure-store path/remediation fields.
- Leave malformed or replacement claims byte-identical and never unlink a foreign owner.
- Delete only claim-private code; issue #305 owns plan/history path walks, readers, and writers.

The existing real-filesystem claim suite is the acceptance contract and must pass unmodified. No
command, configuration, completion, public documentation, database, or external API change is
expected.

## Architecture Context

### Boundary and data flow

```text
rfmedia lidarr apply
  -> apply coordinator (dry runs stop before this boundary)
     -> acquireLidarrPlanClaim(plan.id)
        -> validate Lidarr inputs and build <claimDirectory>/<planId>.lock
        -> acquireExclusiveLock(claimPath, explicit Lidarr policy)
        -> translate SecureStoreError/raw I/O to Lidarr errors
     -> LidarrPlanClaim { path, assertOwned, release }
        -> assertOwned callback at remote-mutation, SQLite, verification, and history boundaries
        -> release from the existing outer finally block
```

`acquireLidarrPlanClaim()` is the only migration seam. The action layer continues to pass a
zero-argument `() => Promise<void>` capability, not a `SecureStoreLock`, so storage implementation
details and error codes do not fan out through the apply pipeline.

### Shared-lock option mapping

| Option             | Required mapping                                                  | Contract preserved                                                                       |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `subject`          | Fixed literal such as `"Lidarr plan claim"`                       | No user-derived bytes in shared messages.                                                |
| `deadlineEpochMs`  | Acquisition epoch from the injected clock                         | Zero-wait contention, while still permitting one immediate stale-owner recovery attempt. |
| `maxAgeMs`         | `null`                                                            | A healthy apply lasting over 120 seconds cannot be stolen locally or cross-host.         |
| `now`              | Adapter from the existing `() => Date` seam to epoch milliseconds | Existing dependency type and deterministic tests remain intact.                          |
| `hostname` / `pid` | Existing injected values, validated before delegation             | Published owner identity remains compatible.                                             |
| `isProcessAlive`   | `dependencies.isProcessAlive ?? defaultIsProcessAlive`            | Probe failures other than `ESRCH` remain fail-closed as “alive.”                         |
| `randomUUID`       | Existing seam with domain validation                              | Invalid ownership UUID remains a Lidarr validation failure.                              |
| `binding`          | Omit                                                              | Filename already binds the plan ID; the legacy four-key record stays parseable.          |
| `signal`           | Omit                                                              | Acquisition is fail-fast and the public claim API has no cancellation input.             |

The published record remains compact JSON with exactly `host`, `pid`, `createdAt`, and
`ownershipToken`, at `<claimDirectory>/<planId>.lock`. Ownership is the complete normalized record
plus `{dev, ino}`; neither a copied token nor a reused inode is sufficient.

### Operation-specific error mapping

| Adapter operation | Input failure                                 | Lidarr-visible result                                        |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Acquire           | `SECURE_STORE_LOCK_BUSY`                      | `LidarrPlanAlreadyRunningError(planId, claimPath)`           |
| Acquire           | `SECURE_STORE_CORRUPT`                        | Same already-running error; existing bytes remain untouched. |
| Assert            | busy, missing, replaced, released, or corrupt | Same already-running error, representing lost ownership.     |
| Release           | `SECURE_STORE_CORRUPT`                        | Resolve without unlinking; malformed replacement is foreign. |
| Any               | unsafe path or permissions                    | Existing `LIDARR_PLAN_UNSAFE_PATH` artifact classification.  |
| Any read          | too large                                     | Existing `LIDARR_PLAN_TOO_LARGE` artifact classification.    |
| Any               | remaining shared code or raw I/O              | Existing `LIDARR_PLAN_IO` classification.                    |
| Any               | existing Lidarr validation/artifact error     | Pass through unchanged.                                      |

Use separate acquire, assert, and release translators. Fixed local messages may retain the original
failure as `cause`, but must not reproduce `SecureStoreError.path`, `.remediation`, or a raw
path-bearing filesystem message.

### Apply lifecycle that must remain unchanged

- Dry runs never acquire a claim.
- General real applies acquire before mutation admission.
- Artist-add keeps its read-only preflight and lazily activates the claim immediately before real
  entry execution.
- Track-filter deletion owns an independent acquire/assert/finally-release lifecycle.
- Ownership is reasserted before remote dispatch and durable SQLite/history transitions.
- Signal cleanup stops admission and waits for the action to settle; the action's existing
  `finally` performs release.

## Critical Files Reference

| File                                                                           | Role and expected treatment                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`                           | Primary implementation site. Add the domain adapter/translators and delete only claim-private lock code.                                                                      |
| `packages/rfmedia-cli/src/lib/secure-store/index.ts`                           | Supported import barrel. Update stale module JSDoc to say claim locking delegates while #305 work remains local.                                                              |
| `packages/rfmedia-cli/src/lib/secure-store/lock.ts`                            | Canonical lock mechanics and option contract. Update stale UUID-pattern JSDoc only; avoid behavioral changes.                                                                 |
| `packages/rfmedia-cli/src/lib/secure-store/errors.ts`                          | Shared error taxonomy and path-bearing metadata that must be contained below the adapter.                                                                                     |
| `packages/rfmedia-cli/src/lib/secure-store/paths.ts`                           | Safe-path, private-mode, bounded-read, and inode guarantees used by the shared lock. Read-only for #304.                                                                      |
| `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`                          | Private staging, atomic `link()` publication, directory sync, and temporary naming. Read-only for #304.                                                                       |
| `packages/rfmedia-cli/src/lib/errors.ts`                                       | Authoritative Lidarr error classes and machine-visible codes. No public error-shape change.                                                                                   |
| `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`            | Closest shipped adapter precedent for explicit policy, local liveness, translation, and release suppression. Do not consolidate its preset-specific errors with claim errors. |
| `packages/rfmedia-cli/src/actions/lidarr/apply.ts`                             | Main and lazy artist-add claim lifecycles plus callback fan-out. Compile unchanged.                                                                                           |
| `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.ts`      | Separate deletion claim lifecycle. Compile unchanged.                                                                                                                         |
| `packages/rfmedia-cli/src/actions/lidarr/apply-*.ts`                           | Irreversible-boundary ownership checks across mutations, deferred replay, verification, and history. No signature edits.                                                      |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`                      | Unmodified compatibility tripwire for contention, recovery, displacement, corruption, and cross-host aging.                                                                   |
| `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`               | Primitive contract for zero deadline, disabled age theft, ownership identity, corruption, and release.                                                                        |
| `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`                        | Integration evidence for ownership loss before normal and deferred dispatch.                                                                                                  |
| `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.test.ts` | Proves contention blocks target reads and deletion.                                                                                                                           |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`             | Bash/Zsh/Fish exact-option parity gate; templates themselves must not change.                                                                                                 |
| `docs/plans/issue-288-secure-store-migration/design.md`                        | Architectural source for the decided claim mapping and #305 split. Historical; do not edit.                                                                                   |
| `docs/plans/issue-288-secure-store-migration/plan.md`                          | Shipped primitive and preset-adapter implementation precedent. Historical; do not edit.                                                                                       |
| `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`                      | Operator-visible claim contract. It must remain accurate without edits.                                                                                                       |
| `docs/internal/plex-jwt-deferrals.md`                                          | ADR/follow-up inventory. Mark #304 resolved and shared locking canonical while retaining #305.                                                                                |
| `ROADMAP.md`                                                                   | Live completion inventory. Reconcile only against current GitHub state during closeout.                                                                                       |
| `.github/pull_request_template.md`                                             | Required PR structure, exact verification evidence, docs rationale, risk/rollback, and `Closes #304`.                                                                         |

## Patterns to Follow

- **Domain adapter over shared primitive:** expose only `LidarrPlanClaim`; keep shared fields and
  `SecureStoreError` below `plan-engine.ts`.
- **Policy at the call site:** spell out zero-wait contention and disabled age stealing with
  comments explaining why they are correctness invariants, not defaults or tuning knobs.
- **Barrel-only imports:** import runtime values and types through `../secure-store/index.js`; retain
  Node ESM `.js` suffixes and use `import type` where applicable.
- **Fail closed:** a malformed, unreadable, live, or foreign-host record is never permission to
  overwrite, normalize, quarantine, or steal it.
- **Capability callback fan-out:** keep `assertOwned(): Promise<void>` and all zero-argument callback
  plumbing unchanged.
- **Check at irreversible boundaries:** preserve each assertion immediately before remote mutations
  and durable SQLite/history state changes.
- **Owner-safe release:** rely on full-record-plus-inode comparison, retain the release latch, and
  never unlink a replacement.
- **Operation-specific translation:** contention on acquire, ownership loss on assert, and
  best-effort non-masking behavior on release are distinct domain meanings.
- **Real-filesystem contract tests:** preserve injected clock/host/pid/liveness/UUID seams; do not
  replace the lock with mocks.
- **Focused deletion:** remove `CLAIM_MAX_BYTES`, `ClaimRecord`, parsing/reading/ownership/unlink
  helpers, and the bespoke acquisition loop only after proving they have no non-claim references.

## Cross-Cutting Concerns

### Security and filesystem safety

- Keep plan ID and claim-directory validation ahead of shared path handling so invalid input retains
  a fixed, redacted Lidarr message and `planPath: undefined`.
- Preserve owner-only `0o700` directories, `0o600` files, no-follow opens, atomic hard-link
  publication, directory durability, and full inode checks supplied by secure-store.
- The lock guarantee assumes local filesystem hard-link semantics; NFS/SMB is not a supported
  ownership boundary.
- The shared stage filename changes from `.<planId>.<uuid>.claim.tmp` to
  `.<lock-basename>.<uuid>.tmp`; it is ephemeral and must not be treated as a published claim.

### Compatibility gotchas

- The shared default age threshold is 120 seconds. Omitting `maxAgeMs: null` can create two live
  owners during a legitimate long-running apply.
- `deadlineEpochMs` equal to the injected current time still allows the shared algorithm's single
  stale-owner check before it returns busy; this is required for immediate same-host dead-pid
  recovery without waiting.
- The local liveness probe treats every error except `ESRCH` as alive. The shared default treats only
  `EPERM` as alive, so substituting it silently widens stealing.
- The old parser requires exactly four keys but does not reject group/other-readable modes; the
  shared reader enforces private mode and tolerates unknown keys. These edge classifications must be
  consciously translated and must never escape as a new public secure-store code.
- Secure-store rejects empty hostnames and non-positive pids. Validate owner metadata at the domain
  boundary so any stricter shared precondition is deliberate and path-free.
- The injected UUID source was previously used only for the ownership token; secure-store also uses
  it for stage names and may call it again on retry. Validate every shared UUID result, preserve the
  invalid-token Lidarr validation contract, and account for constant/stateful seam collision and
  call-count behavior.
- The clock seam also moves from one captured `Date` to a shared epoch callback. Preserve the
  acquisition timestamp semantics where possible and treat stateful clock call-count differences as
  a compatibility risk.
- `release()` latches before its ownership read. Later releases remain no-ops even if the first
  attempt encounters an I/O failure; do not add retry behavior accidentally.

### Error and lifecycle safety

- A `SecureStoreError` reaching the Lidarr command boundary changes class, code, fields, formatting,
  and redaction behavior. Exhaustively translate shared codes plus raw `ENOSPC`/`EIO`/`EROFS`-style
  failures.
- Suppress only corrupt replacement content during release. Genuine unsafe-path or I/O failures
  still translate, but release must not be remodeled as acquisition or mask the original apply
  failure with a misleading contention error.
- Preserve the existing `finally` ownership and cleanup ordering in both general and track-filter
  apply paths.

### Documentation and CLI parity

- Update only stale internal architecture statements and live closeout artifacts. Do not change
  public feature guides, READMEs, docs indexes, issue-288 historical plans, release notes, migration
  instructions, or troubleshooting guidance.
- No command, option, config key, environment variable, output field, or exit code changes. Bash,
  Zsh, and Fish templates must remain byte-identical; run their exact parity test as evidence.
- In the ADR, record secure-store as the single plan/preset/credential lock implementation while
  keeping #305 open for path walks/readers/writers.
- Update `ROADMAP.md` only after checking live issue/PR state and its coupled counts/tables. Do not
  archive #304 separately before the full Sprint 2 narrative closes.

### Verification discipline

Run under the repository's Node 22 contract with `mise exec -- ...`. Direct real-filesystem Vitest
runs require `umask 022` and `FORCE_COLOR` unset.

Required focused gates from `packages/rfmedia-cli`:

```bash
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/shell-completions/templates.spec.ts
npm run typecheck
npm run check:architecture
```

Required repository gates:

```bash
npm run test:run
npm run lint:md
npm run format:check
git diff --check
```

Also prove that the claim test and snapshots are unchanged, both public claim interfaces are
unchanged, all action consumers compile unchanged, and only the claim-specific `link()` block is
gone. Artifact publication still legitimately uses `link()` until #305, so a blanket zero-hit grep
is invalid.

## Parallelization Opportunities

| Stream                  | Ownership                                                                             | Can run in parallel                | Dependency / merge rule                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| A. Claim adapter        | `plan-engine.ts` only                                                                 | Yes, with B and C                  | Central path. Land before integrated verification. Avoid concurrent edits to this file. |
| B. Shared JSDoc cleanup | `secure-store/index.ts`, `secure-store/lock.ts`                                       | Yes, with A and C                  | Documentation-only source edits; no primitive behavior change.                          |
| C. ADR closeout draft   | `docs/internal/plex-jwt-deferrals.md`                                                 | Yes, with A and B                  | Final resolved row/PR number waits for authoritative PR state.                          |
| D. Compatibility review | Read-only comparison of interfaces, action consumers, tests, and claim-only deletions | After A, parallel with docs review | Must finish before broad tests; findings feed A rather than modifying tests.            |
| E. Focused verification | Claim, secure-store, completion, typecheck, architecture gates                        | After A and B are integrated       | Filesystem suites may run independently, but report exact Node/umask environment.       |
| F. Full verification    | Root tests, Markdown lint, formatting, diff checks                                    | After A-C converge                 | Final integration gate; avoid racing formatters against active edits.                   |
| G. ROADMAP/PR closeout  | `ROADMAP.md` and PR body                                                              | Last                               | Requires live GitHub issue/PR state and final verification results.                     |

Do not create parallel implementation streams for action modules, completion templates, public
docs, or tests: their expected state is no diff. The plan-engine adapter is a small, high-coupling
unit and should have one owner.

## Implementation Constraints

### Must remain byte- or behavior-compatible

- `LidarrPlanClaimDependencies` and `LidarrPlanClaim` declarations.
- Claim directory/default, `<planId>.lock` name, and four-field published record.
- UUID validation order and Lidarr validation class for bad plan IDs/ownership tokens.
- Immediate contention failure and one same-host-dead-pid recovery attempt.
- Never stealing a live or foreign-host owner solely because of age.
- Full-record-plus-inode ownership assertion before irreversible work.
- Idempotent, non-destructive release and corrupt/replacement byte preservation.
- All action-layer acquisition points, callbacks, dry-run behavior, and `finally` blocks.
- Lidarr error classes, codes, message shape, fields, and path-redaction guarantees.

### Explicitly out of scope

- Plan/history path walks, bounded readers, directory hardeners, atomic writers, or remaining
  artifact `link()` calls; issue #305 owns them.
- Lock renewal, timeout/cancellation surface, binding, new configuration, or CLI flags.
- Database schema/SQL, Lidarr API requests, retry policy, authentication, Plex scans, Docker, or
  other external integration.
- Changes to action modules, public docs, shell templates, existing claim tests, or snapshots.
- Refactoring the preset adapter or merging preset-specific and plan-claim error taxonomies.

### Abort criteria

- `plan-engine.test.ts` or its snapshots require an edit.
- Any shared error/path/remediation escapes the adapter.
- A malformed, live, aged cross-host, or replacement claim is modified or deleted.
- A healthy apply can lose ownership after 120 seconds.
- Any action caller or public claim interface needs a signature change.
- The implementation removes unrelated artifact/history filesystem machinery needed by #305.

## Key Recommendations

1. Implement one thin adapter in `plan-engine.ts`, modeled on preset persistence but with three
   claim-specific translators and no `binding`.
2. Pre-resolve the claim path and validate plan/owner inputs using Lidarr rules before invoking
   secure-store; use fixed translation messages and retain original failures only as `cause`.
3. Pass `deadlineEpochMs` explicitly, set `maxAgeMs: null`, and inject the local liveness probe.
   Treat each as a security/correctness invariant and document it beside the call.
4. Wrap the returned lock in exactly `{ path, assertOwned, release }`; translate assert loss to
   `LidarrPlanAlreadyRunningError` and suppress only corrupt replacement content on release.
5. Delete claim-private constants/types/helpers only after the adapter compiles. Audit remaining
   filesystem imports by usage because several still support artifact publication.
6. Keep every compatibility test unmodified and run focused tests before broad gates. If an
   uncovered translator branch truly needs a new test, add a separate narrow test only after
   confirming the existing compatibility suite itself needs no edits.
7. Review UUID/clock call-count behavior and private-mode/unknown-key classification explicitly;
   these are the non-obvious differences most likely to survive ordinary happy-path testing.
8. Complete internal JSDoc and ADR updates alongside code, but delay ROADMAP counts, resolved PR
   references, and final PR evidence until live state and all gates are authoritative.
