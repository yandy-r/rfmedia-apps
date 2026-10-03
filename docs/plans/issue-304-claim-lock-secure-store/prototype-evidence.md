# Issue 304 — claim-lock design analysis

**Status:** Judged design analysis and measured evidence. [`design.md`](./design.md) is the as-built
record; [`parallel-plan.md`](./parallel-plan.md) is the as-built plan.

Produced by a three-candidate design workflow whose winner was chosen by adversarial judges, with
every load-bearing claim verified against a working prototype that was then reverted.

The shipped implementation deliberately diverges in three related places. Each divergence _resolves_
something this document had instead accepted, so where they differ, the shipped behaviour is the
stricter one:

| This document says                                                                        | What shipped                                                                                        | Landed in |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| "Blocked-2 — record-validation width" is an unpreservable divergence, declared acceptable | eliminated: `strictRecordShape: true` makes the shared parser demand exactly the four legacy fields | #319      |
| the injected `randomUUID` seam also names the staging file                                | split: `temporaryUUID` names the staging file, the injected seam keeps only the ownership token     | #319      |
| no `secure-store` production file is edited                                               | `lock.ts`, `atomic.ts` and `index.ts` gained the two additive, backward-compatible options above    | #319      |

Everything else here matches what shipped and is the reference for **#305**, which `ROADMAP.md`
scopes as depending on this error taxonomy: the per-code error-mapping table (acquisition arm vs
`assertOwned` arm), the behaviour-preservation table, and the analysis behind `maxAgeMs: null`,
`deadlineEpochMs`, and the ESRCH-vs-EPERM liveness-probe divergence.

Two defects found after #319 merged are tracked in #321 (fixed by #322) and #323 (open).
Status: design, ready for implementation.
Branch: `chore/304-claim-lock`.
Package under change: `packages/rfmedia-cli`.
Baseline: `master` `c54b647b` — 172 test files / 4482 tests passing.
Branch total: 172 test files / 4483 tests — `+1`, a single new `it` block in
`src/lib/secure-store/secure-store.test.ts`. No test is dropped, renamed or edited.

Every file:line citation below was verified by direct read against this worktree. Every behavioural
claim marked **measured** was produced by applying the migration as a throwaway prototype, running
it, and reverting; `git status --porcelain` is empty as of writing. Where the three input designs
disagreed on a fact, the disagreement is settled inline with the evidence that settled it.

## Problem

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4654-4820` carries a complete, bespoke,
`link()`-based inter-process lock — the last one in the repository. It duplicates
`src/lib/secure-store/lock.ts` primitive for primitive:

| plan-engine.ts                              | Lines | secure-store equivalent                                                       |
| ------------------------------------------- | ----- | ----------------------------------------------------------------------------- |
| `parseClaimRecord`                          | 31    | `lock.ts:215-250` `parseLockRecord`                                           |
| `readClaim`                                 | 12    | `lock.ts:253-269` `readExistingLock`                                          |
| `claimIsOwned`                              | 15    | `lock.ts:283-291` `isSameRecord` + `paths.ts:84` `sameIdentity`               |
| `unlinkClaimIfOwned`                        | 12    | `lock.ts:293-319` `unlinkLockIfOwned`                                         |
| the stage/`link`/verify/unlink publish loop | 62    | `atomic.ts:162-190` `createPrivateFileAtomically` driven by `lock.ts:416-502` |
| `interface ClaimRecord` (`:792-797`)        | 6     | `lock.ts` `SecureStoreLockRecord`                                             |
| `CLAIM_MAX_BYTES = 4_096` (`:195`)          | 1     | `lock.ts:52` `LOCK_MAX_BYTES = 4_096`                                         |

Issue #288 (`0640943f`, PR #309) established `src/lib/secure-store/` as the one implementation of
"take an exclusive lock safely" and deleted the second copy from
`lidarr/profile-preset-persistence.ts`. Its ADR names this third copy explicitly as the follow-up,
with the mapping already worked out —
`docs/plans/issue-288-secure-store-migration/design.md`, "Out of scope":

> `plan-engine.ts` claim lock (`:4652-4818`) … **Yes.** Mapping already worked out: `maxAgeMs: null`,
> `deadlineEpochMs = now()`, `CORRUPT → AlreadyRunning`, plus an `assertOwned` adapter.

The duplicate is not merely redundant, it is **weaker** than the shared lock on three axes and
**stronger** on none:

- No jittered backoff and no immediate-retry bound; exactly two attempts, hard-coded at `:4757`.
- The bespoke staging name (`:4759`, `.${planId}.${uuid}.claim.tmp`) does not match the one naming
  rule at `atomic.ts:135-144`, so `removeOrphanedTemporaryFiles` can never sweep an orphan it leaves.
- Neither publish nor release `fsync`s the parent directory; `atomic.ts:177` and `lock.ts:317` do.

It also blocks #305 ("Plan path walks & atomic writers"), which `ROADMAP.md:64` records as
"Depends on #304 error taxonomy".

## Constraints

The frozen contract, as a checklist. Every row is a hard gate on the implementation.

| #   | Constraint                                                                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `src/lib/lidarr/plan-engine.test.ts` must pass **byte-unmodified**.                                                                                               | Issue #304; the four claim tests are `:2081-2113`, `:2115-2137`, `:2139-2157`, `:2159-2187`.                                                                                                                                                                                                                                                                                                                |
| C2  | Public shape stays exactly `{ path, assertOwned, release }`, and stays an unfrozen plain literal.                                                                 | `plan-engine.ts:395-399` (decl), `:4781-4793` (the literal). `apply.ts:1159` types it structurally as `Awaited<ReturnType<typeof acquireLidarrPlanClaim>>`.                                                                                                                                                                                                                                                 |
| C3  | The exported signature `acquireLidarrPlanClaim(planId, dependencies = {})` and all six seams of `LidarrPlanClaimDependencies` keep their meaning.                 | `plan-engine.ts:386-393`, `:4738-4741`. Production passes only `claimDirectory` (`apply.ts:1188`, `:1441`; `apply-track-filter-execution.ts:234`).                                                                                                                                                                                                                                                          |
| C4  | The lock file path stays `<claimDirectory>/<planId>.lock`, and the claim directory holds nothing else after acquisition.                                          | `plan-engine.test.ts:2092` asserts `readdir` equals exactly `[<planId>.lock]`; `apply.test.ts:2569`/`:2654` `rm(join(claimDirectory, \`${plan.id}.lock\`))` mid-flight.                                                                                                                                                                                                                                     |
| C5  | Contention, a displaced record, and an unparseable incumbent all yield `LidarrPlanAlreadyRunningError`, message `Lidarr plan ${planId} is already being applied`. | `src/lib/errors.ts:157-168`. Pinned by class at `plan-engine.test.ts:2102`, `:2133`, `:2155`, `:2185`, `apply-track-filter-execution.test.ts:164`, and by **message regex** at `apply.test.ts:2578`, `:2660`.                                                                                                                                                                                               |
| C6  | An unparseable incumbent is left byte-identical on disk.                                                                                                          | `plan-engine.test.ts:2156` `resolves.toBe('{"host":"partial')` — exact string equality against the literal written at `:2146`.                                                                                                                                                                                                                                                                              |
| C7  | A foreign-host record two hours older than the injected clock is **never** reclaimed.                                                                             | `plan-engine.test.ts:2159-2187`; 7 200 000 ms is 60× `SECURE_STORE_LOCK_MAX_AGE_MS` (`lock.ts:47`).                                                                                                                                                                                                                                                                                                         |
| C8  | `assertOwned()` resolves `undefined`, and rejects with `LidarrPlanAlreadyRunningError` after a release or a displacement.                                         | `plan-engine.test.ts:2091`, `:2133`. Threaded through 68 references across 15 files as a bare `() => Promise<void>` (erased at `apply.ts:1190-1198` and `:1450-1455`).                                                                                                                                                                                                                                      |
| C9  | `release()` is idempotent, never unlinks a record it does not own, and never throws in the common paths.                                                          | `plan-engine.test.ts:2134-2136`. Both production callers invoke it inside a `finally` (`apply.ts:1593`, `apply-track-filter-execution.ts:314`).                                                                                                                                                                                                                                                             |
| C10 | The liveness policy stays fail-**closed**: an errno that is neither `ESRCH` nor `EPERM` means ALIVE.                                                              | `plan-engine.ts:4654-4661` `return !hasCode(error, "ESRCH")` vs `lock.ts:173-180` `return hasErrorCode(error, "EPERM")`. They invert on every other errno.                                                                                                                                                                                                                                                  |
| C11 | A hostile `claimDirectory` still produces `{ code: "LIDARR_PLAN_UNSAFE_PATH", planPath: undefined }` and never echoes the path into `message`.                    | `plan-engine.test.ts:1756-1771` pins the shared `resolveLidarrStoragePath` (`plan-engine.ts:3845-3857`) through `readLidarrPlanArtifact`.                                                                                                                                                                                                                                                                   |
| C12 | No `AbortSignal` is forwarded into the lock.                                                                                                                      | `apply-track-filter-execution.ts:209` runs `signal?.throwIfAborted()` **before** the claim at `:233`, and `apply-track-filter-execution.test.ts:290-311` asserts `rejects.toThrow("cancelled")`. `apply.ts:1441` also acquires before `signal.throwIfAborted()` at `:1442`.                                                                                                                                 |
| C13 | The on-disk record keeps exactly four keys in the order `host, pid, createdAt, ownershipToken`.                                                                   | `lock.ts:422-428` spreads `...(binding === undefined ? {} : { binding })`, so omitting `binding` reproduces `plan-engine.ts:4755` byte for byte and matches the replacement literal at `plan-engine.test.ts:2125-2130`.                                                                                                                                                                                     |
| C14 | No `SecureStoreError` may escape the adapter.                                                                                                                     | `src/commands/lidarr.ts:258-281` reads `.code` **structurally** off any thrown object into the `--output json\|csv` envelope at `:341-357`. A bare `SecureStoreError` would inject `code: "SECURE_STORE_LOCK_BUSY"` and the message `Lidarr plan claim is locked by another process` into user-facing JSON.                                                                                                 |
| C15 | No CLI surface changes.                                                                                                                                           | `maxAgeMs` / `deadlineEpochMs` are module-level decisions. `grep -i 'lock\|claim'` over `shell-completions/{bash,zsh,fish}.ts` and `templates.spec.ts` yields no completion candidate; the order-sensitive `templates.spec.ts:1792`/`:1815` literals stay green untouched. `src/mcp/schema.ts` contains **zero** occurrences of `lidarr` or `claim` (verified), so the closed-object hazard does not apply. |

## Design

**Migrate in place. One production file changes.** No new module, no new export, no barrel edit, no
test edit, no `secure-store` edit.

The claim is rewritten anyway — five functions are deleted outright and the 83-line acquisition body
collapses to a delegation plus a three-member wrapper — so a reviewer cannot diff old against new
line by line regardless of which file it lands in. Moving it buys nothing and costs the revert unit:
extracting `lidarr/plan-claim.ts` forces `LidarrPlanClaim` / `LidarrPlanClaimDependencies` to be
re-exported through `lidarr/index.ts:40`'s `export * from "./plan-engine.js"`, and it drags
`resolveLidarrStoragePath` — four non-claim callers at `plan-engine.ts:3883`, `:4007`, `:4067`,
`:4134`, and test-pinned by C11 — into a lock migration. That is #305's territory, which the #288 ADR
deliberately sequenced after this issue.

`plan-engine.ts` remains ~4800 lines, far past the ~500-line soft cap. That is pre-existing and out
of scope; splitting it is a change of its own size and must not ride inside a lock migration.

### The seven hunks

1. `plan-engine.ts:105-110` — extend the existing `../secure-store/index.js` import with
   `acquireExclusiveLock` and `SecureStoreError`, and add `import type { SecureStoreLock }` on its
   own line (`verbatimModuleSyntax: true`, `packages/rfmedia-cli/tsconfig.json:23`). **Nothing is
   added to the barrel** — all three are already exported at `secure-store/index.ts:21-67`.
2. `plan-engine.ts:159` — delete `isRecord,` from the `./plan-validation.js` import block.
3. `plan-engine.ts:195` — delete `const CLAIM_MAX_BYTES = 4_096;`. Leave `CHECKSUM_PATTERN` at `:196`.
4. `plan-engine.ts:792-797` — delete `interface ClaimRecord` and its trailing blank line.
5. `plan-engine.ts:4654-4820` — replace the whole block: keep `defaultIsProcessAlive` verbatim with
   a new rationale comment, delete `parseClaimRecord` / `readClaim` / `claimIsOwned` /
   `unlinkClaimIfOwned`, and rewrite `acquireLidarrPlanClaim` as the adapter below.
6. Same range — add `CLAIM_SUBJECT`, `translateClaimFailure`, `translateClaimOwnershipFailure`.
7. `src/lib/secure-store/secure-store.test.ts` — one new `it` block (see Verification plan).

Measured on the prototype: `1 file changed, 120 insertions(+), 148 deletions(-)`,
`plan-engine.ts` 4820 → 4793. The final adds ~40 further lines of rationale comments and the
four-line owner-metadata gate, landing near 4835; executable lines in the claim region still drop
from ~162 to ~125.

### What is deliberately kept

- **`resolveLidarrStoragePath` on the claim DIRECTORY** (`:4743-4745`, unchanged). It is shared with
  `readLidarrPlanArtifact` and is what satisfies C11. Letting `resolveSecurePath` (`paths.ts:97-106`)
  become the sole gate would throw a `SecureStoreError` with no `planPath` field and a different
  message, and would let `claimDirectory: ""` through — `join("", "<id>.lock")` is `"<id>.lock"`,
  which `resolve()` turns into a path under the process CWD. **Measured** with the prototype: `""`,
  `"x".repeat(4097)`, a C0 control, an ESC sequence and a bidi override each still yield
  `LidarrPlanArtifactError` / `LIDARR_PLAN_UNSAFE_PATH` / `planPath: undefined`, with the input never
  echoed into `message`.
- **`defaultIsProcessAlive` local and passed explicitly** (C10). A byte-identical independent copy
  already lives at `profile-preset-persistence.ts:212-219` and is likewise still passed explicitly
  after #288. De-duplicating the two is a separate chore.
- **Every other `plan-engine.ts` primitive.** Re-verified after the prototype: `hasCode` 15 uses,
  `prepareSafeParent` 5, `assertSafeParentUnchanged` 9, `assertOpenedFileIdentity` 11,
  `readBoundedFile` 5, `sameIdentity` 6 — all load-bearing for `writeLidarrPlanArtifact`,
  `readLidarrPlanArtifact` and `appendLidarrPlanHistory`. Migrating those is #305.

### What is deliberately dropped

The local `prepareSafeParent(claimPath, true)` at `:4747`. `acquireExclusiveLock` calls
`prepareSafeParent(path, true, subject)` itself at `lock.ts:398`, so the directory is still created
`0o700` and every parent component is still validated. Keeping both would be one duplicate walk with
two error taxonomies for a single fault. The observable delta is confined to a **hostile filesystem
parent** (a symlinked component, a foreign owner, or a group-writable leaf): the `code` is still
`LIDARR_PLAN_UNSAFE_PATH`, but `planPath` becomes `claimPath` instead of `undefined` and the message
text changes. No test covers that case for the claim path, and C11 — which covers hostile path
_strings_ — is preserved by keeping `resolveLidarrStoragePath`.

### Adapter signature sketch

```ts
/** Short human name secure-store prints for this lock. */
const CLAIM_SUBJECT = "Lidarr plan claim";

/**
 * Liveness probe for the claim lock.
 *
 * Deliberately this module's own probe, not `isProcessAliveByDefault`
 * (`lock.ts:173-180`): an errno that is neither ESRCH nor EPERM means ALIVE here
 * and DEAD there. With `maxAgeMs: null` the same-host-dead-pid rule is the ONLY
 * steal, so that divergence alone decides whether a live-but-unprobeable owner
 * is evicted mid-apply. Migrating a lock must not silently migrate its liveness
 * policy.
 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function translateClaimFailure(
  planId: string,
  claimPath: string,
  message: string,
  error: unknown,
): LidarrPlanAlreadyRunningError | LidarrPlanArtifactError | LidarrPlanValidationError;

function translateClaimOwnershipFailure(
  planId: string,
  claimPath: string,
  error: unknown,
): LidarrPlanAlreadyRunningError | LidarrPlanArtifactError | LidarrPlanValidationError;

/** Acquires an exclusive per-plan claim and recovers only demonstrably stale owners. */
export async function acquireLidarrPlanClaim(
  planId: string,
  dependencies: LidarrPlanClaimDependencies = {},
): Promise<LidarrPlanClaim> {
  if (!UUID_PATTERN.test(planId)) throw validationError("claim planId must be a UUID");
  const claimDirectory = resolveLidarrStoragePath(
    dependencies.claimDirectory ?? join(getDefaultPlanDir(), "lidarr-claims"),
  );
  const claimPath = join(claimDirectory, `${planId}.lock`);

  const host = dependencies.hostname?.() ?? nodeHostname();
  const pid = dependencies.pid ?? process.pid;
  // `acquireExclusiveLock` rejects this owner metadata with SECURE_STORE_CORRUPT
  // (lock.ts:407-409), which the acquisition arm maps to AlreadyRunning —
  // reporting "another process owns the claim" for the CALLER'S OWN bad pid
  // would be a lie. Failing fast here also keeps the CORRUPT arm meaning exactly
  // one thing: an unparseable incumbent. Mirrors
  // profile-preset-persistence.ts:606-610.
  if (host.length === 0 || !Number.isSafeInteger(pid) || pid <= 0) {
    throw validationError("claim owner metadata must be a non-empty host and a positive pid");
  }

  // Preserves the ownership-token half of the pre-migration owner check
  // (:4752-4754): an injected seam yielding a non-UUIDv4 is a validation
  // failure, not a lock failure. Thrown from inside `acquireExclusiveLock`
  // (lock.ts:418, outside any try), it reaches the translator below as a
  // LidarrPlanValidationError and is rethrown unchanged. Mirrors
  // profile-preset-persistence.ts:611-621.
  const randomUUID = (): string => {
    const value = (dependencies.randomUUID ?? nodeRandomUUID)();
    if (!UUID_PATTERN.test(value)) throw validationError("claim ownership token must be a UUID");
    return value;
  };
  const nowSource = dependencies.now;
  const nowMs = nowSource === undefined ? Date.now : (): number => nowSource().getTime();

  let held: SecureStoreLock;
  try {
    held = await acquireExclusiveLock(claimPath, {
      subject: CLAIM_SUBJECT,
      // Fail fast: zero wait, reproducing the pre-migration two-attempt loop,
      // which never slept. MUST be read from the SAME clock passed as `now`:
      // lock.ts:491 computes `options.deadlineEpochMs - now()`, and a literal
      // Date.now() against the tests' frozen 2026-07-22 clock leaves
      // remainingMs ~ +1.3e9, so the `<= 0` fast-fail never fires and
      // lock.ts:495-501 sleeps against a clock that never advances.
      deadlineEpochMs: nowMs(),
      // No age-based steal. The pre-migration rule (:4809-4812) was same-host
      // AND dead-pid with no age clause; `maxAgeMs: null` short-circuits
      // lock.ts:360 and leaves lock.ts:359 as the only steal. A real apply
      // drives per-entry network mutations with assertOwned() between each and
      // routinely outlives SECURE_STORE_LOCK_MAX_AGE_MS.
      maxAgeMs: null,
      now: nowMs,
      hostname: () => host,
      pid,
      isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive,
      randomUUID,
      // NO `binding`: the record must stay the exact four keys, in order (C13).
      // NO `signal`: see C12.
    });
  } catch (error) {
    throw translateClaimFailure(planId, claimPath, "Unable to acquire Lidarr plan claim", error);
  }

  return {
    path: claimPath,
    assertOwned: async (): Promise<void> => {
      try {
        await held.assertOwned();
      } catch (error) {
        throw translateClaimOwnershipFailure(planId, claimPath, error);
      }
    },
    release: async (): Promise<void> => {
      try {
        await held.release();
      } catch (error) {
        // A record we cannot parse, or one carrying foreign access bits, is not
        // a record this acquisition published: the pre-migration `readClaim`
        // resolved both to "not owned" without unlinking. `release()` runs
        // inside a `finally` at both production call sites, so a throw here
        // would mask the real failure already in flight.
        if (
          error instanceof SecureStoreError &&
          (error.code === "SECURE_STORE_CORRUPT" || error.code === "SECURE_STORE_PERMISSIONS")
        ) {
          return;
        }
        throw translateClaimFailure(planId, claimPath, "Unable to release Lidarr plan claim", error);
      }
    },
  };
}
```

### Seam bridge

| Seam                                | `LidarrPlanClaimDependencies` type | Forwarded as                                 | Note                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claimDirectory?: string`           | —                                  | not forwarded                                | consumed locally, preserving C4 and C11                                                                                                                                                                                                                                              |
| `hostname?: () => string`           | `() => string`                     | `hostname: () => host`                       | read once up front so the owner-metadata gate and the record see the same value                                                                                                                                                                                                      |
| `pid?: number`                      | `number`                           | `pid`                                        | `exactOptionalPropertyTypes` is not set, so no conditional spread is needed                                                                                                                                                                                                          |
| `now?: () => Date`                  | `() => Date`                       | `now: nowMs`                                 | **type bridge**: `SecureStoreLockOptions.now` is `() => number` epoch-ms (`lock.ts:130`). `lock.ts` reads it three times (`:425`, `:479`, `:491`) where the old code read it once (`:4750`) — harmless for the constant clocks the tests inject, but do not assume single evaluation |
| `isProcessAlive?: (pid) => boolean` | same                               | `isProcessAlive: … ?? defaultIsProcessAlive` | load-bearing, C10                                                                                                                                                                                                                                                                    |
| `randomUUID?: () => string`         | `() => string`                     | the validating wrapper                       | see below                                                                                                                                                                                                                                                                            |

`path` is the adapter's own `claimPath`, not `held.path`. They are provably the same string, but
`claimPath` is also what the two error constructors need, and `SecureStoreError.path` is the
**sanitized, 512-char-truncated** form (`errors.ts:97-107`, `:139-146`) — never reconstruct a
`LidarrPlanAlreadyRunningError` from it.

### Forwarding `randomUUID` is safe

`lock.ts:400` builds one function and hands it to both the ownership token (`:418`) and, via
`lock.ts:437`, to `createPrivateFileAtomically` → `atomic.ts:140`, the staging-file suffix. Since
`plan-engine.test.ts:2122` injects a **constant** UUID, a naive reading says a retry would re-open
the same staging name with `O_EXCL` and raise an `EEXIST` that neither
`rethrowAsSecureStoreError` (`errors.ts:194-203`) nor `lock.ts:441` maps.

That collision is **unreachable**. `atomic.ts:181-187`:

```ts
  } finally {
    // Swallowed deliberately: by here the document is either published or the
    // real failure is already in flight, and neither may be masked by the
    // cleanup. A stage that survives this is handled by
    // `removeOrphanedTemporaryFiles`.
    await removeIfPresent(temporaryPath).catch(() => undefined);
  }
```

The `finally` runs on **every** exit — success, the `link` `EEXIST`, a failed identity assertion —
and it runs before `acquireExclusiveLock`'s loop can `continue`. Iteration N+1 always finds the
constant-named stage absent. Not forwarding the seam would lose the ownership-token injection that
`plan-engine.test.ts:2122` requires. **Measured:** Test B passes and the full suite is green with the
seam forwarded.

This is why the alternative design's proposed one-line deletion of `randomUUID,` at `lock.ts:437` is
rejected — see Rejected alternatives.

## Error mapping

Two tables, as #304 mandates. Both lead with pass-through arms so an error thrown by one of **our**
injected seams from inside `acquireExclusiveLock` survives unchanged — the
`profile-preset-persistence.ts:133` pattern.

`SECURE_STORE_VERSION_CONFLICT` never escapes (`lock.ts:439-443` swallows exactly that code) and
`SECURE_STORE_CANCELLED` is unreachable (no `signal`, C12); both are listed for completeness because
`SecureStoreErrorCode` (`errors.ts:13-20`) is a closed seven-member union and both message tables are
`Object.freeze`d, so a future code addition is a compile error at the switch.

| `SecureStoreError.code`                                                                                                                              | Raised at                                                                             | Acquisition arm (`translateClaimFailure`)                                                      | `assertOwned` arm (`translateClaimOwnershipFailure`)                                                      | Pre-migration equivalent                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `SECURE_STORE_LOCK_BUSY`                                                                                                                             | `lock.ts:493` deadline; `:454` released latch; `:462` record moved                    | `LidarrPlanAlreadyRunningError(planId, claimPath)`                                             | `LidarrPlanAlreadyRunningError`                                                                           | `:4814` contention; `:4785` not-owned                                                                                                    |
| `SECURE_STORE_CORRUPT`                                                                                                                               | `lock.ts:263`, `:267` unparseable record; `:407-409` owner metadata; `:419` bad token | `LidarrPlanAlreadyRunningError` — **#304's mandated arm**                                      | `LidarrPlanAlreadyRunningError`                                                                           | `readClaim:4702-4705` swallowed parse failures to `undefined` ⇒ `stale === false` ⇒ `:4814`                                              |
| `SECURE_STORE_UNSAFE_PATH`                                                                                                                           | `paths.ts:103`, `:115-123`, `:161`, `:268-270`, `:343`, `:358`                        | `LidarrPlanArtifactError("LIDARR_PLAN_UNSAFE_PATH", "<stem>: <detail>", claimPath, { cause })` | delegates to the acquisition arm with the stem `Unable to verify Lidarr plan claim ownership`             | `:4802` ELOOP arm; `readClaim:4703` rethrew artifact errors                                                                              |
| `SECURE_STORE_TOO_LARGE`                                                                                                                             | `paths.ts:349`, `:355`                                                                | `LidarrPlanArtifactError("LIDARR_PLAN_TOO_LARGE", …)`                                          | delegates, same stem as above                                                                             | `readBoundedFile:3961` threw this code and `readClaim:4703` rethrew it                                                                   |
| `SECURE_STORE_PERMISSIONS`                                                                                                                           | `paths.ts:168`, `:346`                                                                | `LidarrPlanArtifactError("LIDARR_PLAN_IO", …)` — **behaviour delta, see Blocked-1**            | `LidarrPlanAlreadyRunningError` (fail closed: a file with foreign bits is not one this acquisition wrote) | `:4802` mapped `EACCES` to `LIDARR_PLAN_IO`; `readBoundedFile` had no mode check at all                                                  |
| `SECURE_STORE_VERSION_CONFLICT`                                                                                                                      | unreachable                                                                           | `LIDARR_PLAN_IO` (defensive default)                                                           | `LidarrPlanAlreadyRunningError` (default)                                                                 | n/a                                                                                                                                      |
| `SECURE_STORE_CANCELLED`                                                                                                                             | unreachable                                                                           | `LIDARR_PLAN_IO` (defensive default)                                                           | `LidarrPlanAlreadyRunningError` (default)                                                                 | n/a                                                                                                                                      |
| not a `SecureStoreError` — raw `ENOSPC`/`EIO`/`EROFS`/`EEXIST`/`ENOENT`, which `rethrowAsSecureStoreError` leaves **unmapped** (`errors.ts:194-203`) | any syscall                                                                           | `LidarrPlanArtifactError("LIDARR_PLAN_IO", …)`                                                 | `LidarrPlanAlreadyRunningError`                                                                           | acquisition: `:4801-4806`. `assertOwned`: `readClaim` swallowed every non-artifact throw to `undefined` ⇒ `claimIsOwned` false ⇒ `:4785` |
| `LidarrPlanValidationError` (our `randomUUID` wrapper, thrown at `lock.ts:418`)                                                                      | —                                                                                     | **pass through unchanged**                                                                     | pass through                                                                                              | `:4753-4754`, thrown before the loop                                                                                                     |
| `LidarrPlanArtifactError` / `LidarrPlanAlreadyRunningError`                                                                                          | —                                                                                     | pass through unchanged                                                                         | pass through                                                                                              | defensive                                                                                                                                |

The non-`SecureStoreError` arm is the one that satisfies C14: without it a raw `ENOSPC` would reach
`src/commands/lidarr.ts:258-281`'s structural `.code` read and land in the machine envelope in place
of `LIDARR_PLAN_IO`.

**Where the two arms genuinely diverge** — this is the substance of #304's "distinct arm" mandate,
not a cosmetic split:

- `SECURE_STORE_PERMISSIONS`: `LIDARR_PLAN_IO` on acquire (an environment fault an operator fixes
  with `chmod`; surfacing a code beats reporting "already running") but `LidarrPlanAlreadyRunningError`
  in `assertOwned` (a file at `0o644` is not one this acquisition wrote — fail closed).
- Raw errno: `LIDARR_PLAN_IO` on acquire, `LidarrPlanAlreadyRunningError` in `assertOwned`. This is
  exact parity: `assertOwned` could pre-migration produce **only** `LidarrPlanAlreadyRunningError` or
  a `LidarrPlanArtifactError` rethrown by `readClaim:4703` — never `LIDARR_PLAN_IO`. A single shared
  translator would change what `apply-deferred-replay.ts:373-378` and
  `apply-deferred-replay-entry.ts:238-243` rethrow after their compensating
  `restoreClaimedDeferredIntent` database writes, and what the `remoteSucceeded` swallow at
  `apply.ts:837-848` classifies as `history-write-failed`.
- The message stem differs, so a `LidarrPlanArtifactError.message` names the operation that failed.

**Release arm.** Swallows `SECURE_STORE_CORRUPT` **and** `SECURE_STORE_PERMISSIONS` and returns.
`unlinkLockIfOwned` (`lock.ts:293-319`) calls `readExistingLock(..., undefined)`, which throws on
both, whereas the old `unlinkClaimIfOwned` → `readClaim` resolved both to `undefined` ⇒
`claimIsOwned` false ⇒ `return false`. `profile-preset-persistence.ts:681` swallows `CORRUPT` only;
`PERMISSIONS` is added here because `readBoundedFile` (`plan-engine.ts:3950-3986`) had no mode check
where `readBoundedPrivateFile` (`paths.ts:345-347`) does — both codes prove the on-disk file is not a
record this acquisition published. Everything else is wrapped rather than rethrown raw, which is a
small hardening over the old release (C14 applies to `finally` paths too).

**User-facing surface is unchanged.** `LidarrPlanAlreadyRunningError` carries no `code`, so
`readLidarrFailureMetadata` reads `undefined` and only the message renders.
`LidarrPlanArtifactError.code` surfaces verbatim at `lidarr.ts:341-357`. Neither `planPath` nor
`claimPath` is ever rendered — there is no formatter arm for either class in
`src/lib/error-formatters.ts` or `src/lib/formatters/`. `safeLidarrApplyErrorMessage`
(`apply-target-errors.ts:21-25`) takes the `fallback` branch for both classes, so no message shape
leaks through the swallow-into-`uncertain` paths at `apply.ts:837-848`,
`apply-artist-add-entry-execution.ts:222-238`/`:407-422`/`:490-505`, or
`apply-album-mutation-execution.ts:169-181`.

`SecureStoreError.message` is `SECURE_STORE_MESSAGES[code](subject)` (`errors.ts:25-38`) and **never**
embeds a path — only `remediation` does, and the adapter discards it. So interpolating
`error.message` into `Unable to acquire Lidarr plan claim: …` leaks strictly less than the old
`:4803`, which interpolated the raw errno message. **Measured:** a `0o644` incumbent produces
`Unable to acquire Lidarr plan claim: Lidarr plan claim file is accessible to another user` — no path.

## Behaviour preservation

Every row **measured** by running the prototype unless marked otherwise.

| #   | Current observable behaviour                                                                                                                    | How the new design preserves it                                                                                                                                                                                                                                                                                                             | Test that pins it                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| B1  | Non-UUID `planId` throws `LidarrPlanValidationError` before any I/O.                                                                            | Unchanged, still the first statement.                                                                                                                                                                                                                                                                                                       | `plan-engine.test.ts:2076-2079`                                                                                             |
| B2  | Claim path is `<claimDirectory>/<planId>.lock`; the directory holds exactly that one entry after acquisition.                                   | `resolveLidarrStoragePath` + `join` kept verbatim; `atomic.ts:181-187`'s `finally` removes the stage.                                                                                                                                                                                                                                       | `plan-engine.test.ts:2092`; `apply.test.ts:2569`, `:2654`                                                                   |
| B3  | Hostile `claimDirectory` ⇒ `LIDARR_PLAN_UNSAFE_PATH`, `planPath: undefined`, path never echoed.                                                 | `resolveLidarrStoragePath` remains the first gate. Measured across five hostile inputs.                                                                                                                                                                                                                                                     | `plan-engine.test.ts:1756-1771` (through `readLidarrPlanArtifact`)                                                          |
| B4  | Record is exactly `{host, pid, createdAt, ownershipToken}` in that order.                                                                       | `binding` omitted, so `lock.ts:427`'s conditional spread emits nothing extra.                                                                                                                                                                                                                                                               | `plan-engine.test.ts:2125-2130` (the replacement literal must match)                                                        |
| B5  | Exactly one steal per acquisition, then fail.                                                                                                   | `hasStolen` latch (`lock.ts:476-484`) grants one steal; `retryImmediately` grants the re-attempt; the second `EEXIST` falls to `remainingMs <= 0` ⇒ `LOCK_BUSY`.                                                                                                                                                                            | `plan-engine.test.ts:2081-2113`; `secure-store.test.ts:253-260` pins that a zero remaining deadline still permits the steal |
| B6  | Staleness is same-host **and** dead-pid, with no age rule.                                                                                      | `maxAgeMs: null`. `isStale` (`lock.ts:352-362`) is literally `if (record.host === host && !isProcessAlive(record.pid)) return true; if (maxAgeMs === null) return false;` — the `:4809-4812` predicate with the age clause disabled. A faithful mapping, not an approximation.                                                              | `plan-engine.test.ts:2159-2187` (would invert under the default `maxAgeMs`)                                                 |
| B7  | A same-host dead-pid owner IS stolen and the claim republished.                                                                                 | Same as B6. Measured: `readdir` returns one entry and the republished record carries `pid: 8`.                                                                                                                                                                                                                                              | **Nothing.** See Verification plan — this is the new test.                                                                  |
| B8  | A malformed incumbent is contention and is left byte-identical.                                                                                 | `link()` refuses to clobber (`atomic.ts:167-174`) ⇒ `VERSION_CONFLICT`, swallowed at `lock.ts:440`; `readExistingLock` throws `CORRUPT` at `lock.ts:263` **before** the steal arm; the function's only `unlink` (`lock.ts:482`) requires a successfully parsed `existing` and is therefore unreachable. Structurally guaranteed, not lucky. | `plan-engine.test.ts:2139-2157`                                                                                             |
| B9  | A foreign-host record 2 h older than the clock is never reclaimed and survives.                                                                 | `maxAgeMs: null` disables the age steal; the host guard fails independently.                                                                                                                                                                                                                                                                | `plan-engine.test.ts:2159-2187`                                                                                             |
| B10 | Liveness is fail-closed on an unknown errno.                                                                                                    | `isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive`, kept local.                                                                                                                                                                                                                                                         | **Nothing** — all four fixtures inject the probe. Preserved by construction.                                                |
| B11 | `assertOwned()` resolves `undefined`; a displaced record (same token, different `pid`, new inode) rejects with `LidarrPlanAlreadyRunningError`. | `lock.ts:452-464` proves the whole record via `isSameRecord` + `sameIdentity`, identical to `claimIsOwned:4708-4722` modulo `binding` (both `undefined`); the `LOCK_BUSY` it throws maps to `AlreadyRunning`.                                                                                                                               | `plan-engine.test.ts:2091`, `:2133`                                                                                         |
| B12 | `release()` is idempotent and never unlinks a displaced record.                                                                                 | `lock.ts:466-471` sets `released` before awaiting; `unlinkLockIfOwned` returns `false` on `!isSameRecord` before touching anything (`lock.ts:300-307`).                                                                                                                                                                                     | `plan-engine.test.ts:2134-2136`                                                                                             |
| B13 | `release()` over an unparseable on-disk record resolves silently.                                                                               | The `SECURE_STORE_CORRUPT` swallow in the release arm. Measured: `RESOLVED`, bytes unchanged.                                                                                                                                                                                                                                               | **Nothing.** Pre-migration this was `readClaim` swallowing the parse error.                                                 |
| B14 | An injected non-UUID `randomUUID` throws `validationError("claim ownership token must be a UUID")` and leaves no file behind.                   | The validating wrapper, thrown from `lock.ts:418` outside any `try`, passed through by the translator. Measured: `LidarrPlanValidationError`, claim directory empty.                                                                                                                                                                        | `plan-engine.test.ts:2122` exercises the seam with a valid UUID; the non-UUID arm is uncovered but preserved                |
| B15 | The `LidarrPlanAlreadyRunningError` message reaches `apply.test.ts`'s regex through two compensating catch blocks.                              | Reconstructed with `new LidarrPlanAlreadyRunningError(planId, claimPath)`; `apply-deferred-replay.ts:373-378` and `apply-deferred-replay-entry.ts:238-243` rethrow unchanged.                                                                                                                                                               | `apply.test.ts:2578`, `:2660`                                                                                               |
| B16 | Cancellation before admission throws `"cancelled"`, not a lock error.                                                                           | No `signal` forwarded.                                                                                                                                                                                                                                                                                                                      | `apply-track-filter-execution.test.ts:290-311`                                                                              |

Full-suite evidence: 172 files / 4482 tests pass with the prototype applied and **zero** test files
edited (`git status --porcelain` showed only `plan-engine.ts` modified). `npx tsc --noEmit` exits 0.
`npm run check:architecture` reports `OK … 340 production files`; `npm run test:architecture` reports
`# fail 0`.

## Blocked behaviours

Three behaviours genuinely cannot be preserved through the shared lock. None is test-covered; all
three are stated in the PR body under Risk and Rollback.

### Blocked-1 — foreign access bits on an incumbent claim

`readBoundedPrivateFile` enforces `(before.mode & FOREIGN_ACCESS_BITS) !== 0 ⇒
SECURE_STORE_PERMISSIONS` unconditionally (`paths.ts:345-347`), **before** the size check;
`readBoundedFile` (`plan-engine.ts:3950-3986`) has no mode check at all. Today a `0o644` claim file
reads fine and yields contention (or a steal, if same-host and dead-pid). Post-migration it is a hard
failure, and because `maxAgeMs: null` removes the only other steal rule such a file becomes a
**permanent wedge**.

**Measured:** a `0o644` incumbent, same host, dead pid, produces
`LidarrPlanArtifactError` / `LIDARR_PLAN_IO` /
`Unable to acquire Lidarr plan claim: Lidarr plan claim file is accessible to another user`.

**Remedy.** Accept the delta and keep the `LIDARR_PLAN_IO` classification, so the operator gets a
`code` in the machine envelope (`lidarr.ts:341-357`) and an actionable message rather than a silent
"already being applied" wedge against a process nobody is running. Recovery is `chmod 600 <claim>` or
deleting the claim file. This module can only ever create the file at `PRIVATE_FILE_MODE` —
`atomic.ts:110` plus the explicit `handle.chmod(PRIVATE_FILE_MODE)` at `:114` that defeats a
restrictive umask — so foreign bits mean external tampering or a pre-existing foreign file. All four
frozen fixtures write `{ mode: 0o600 }`.

**Rejected remedy.** Adding a `SecureStoreLockOptions.acceptForeignAccessBits` seam would weaken,
repo-wide, the exact invariant #288 was built to establish, for one caller.

### Blocked-2 — record-validation width, in both directions

`parseClaimRecord` (`plan-engine.ts:4663-4693`) demands **exactly four keys**
(`Object.keys(value).length !== 4`), rejects a `host` matching `TERMINAL_CONTROL_PATTERN`, and
accepts any `Number.isSafeInteger` pid including `0` and negatives. `parseLockRecord`
(`lock.ts:215-250`) tolerates extra keys and control characters in `host`, but requires
`host.length > 0` and `pid > 0` and understands `binding`.

Net: an incumbent with a fifth key, or a control character in `host`, flips from _corrupt_ (never
stolen) to _valid_ (eligible for the same-host-dead-pid steal); an incumbent with `pid <= 0` flips
from _valid_ to _corrupt_. Unpreservable without forking `parseLockRecord`, which would reinstate the
duplicate this issue exists to delete.

**Remedy.** Declared acceptable. Neither shape is reachable in production: this module writes exactly
four keys with a real hostname and `process.pid`. The steal predicate's **input set** changes; its
**rule** does not. All four frozen tests still land on `LidarrPlanAlreadyRunningError`.

### Blocked-3 — fail-fast is not absolute

`lock.ts:486-489` sits **before** the deadline check:

```ts
if (retryImmediately && immediateRetries < LOCK_MAX_IMMEDIATE_RETRIES) {
  immediateRetries += 1;
  continue;
}

const remainingMs = options.deadlineEpochMs - now();
if (remainingMs <= 0) {
  throw secureStoreError("SECURE_STORE_LOCK_BUSY", subject, path);
}
```

with `retryImmediately = existing === undefined` (`lock.ts:475`). So when the incumbent lock
disappears between the failed `link()` and `readExistingLock`, a past deadline is bypassed for up to
`LOCK_MAX_IMMEDIATE_RETRIES = 8` attempts, and the acquisition usually **succeeds**. Pre-migration,
`readClaim` returning `undefined` gave `stale === false` and threw `LidarrPlanAlreadyRunningError`
(`plan-engine.ts:4808-4815`). **Measured:** a race that unlinks the incumbent mid-acquisition returns
`ACQUIRED`.

The same gate is what makes the one steal reachable under a zero remaining deadline — that half is
required (B5) and is independently pinned by `secure-store.test.ts:253-260`.

**Remedy.** Accept. The window is a genuine TOCTOU race in which the lock really is free, so
acquiring it is more correct than failing; the retry count is bounded and no sleep occurs
(`waitAbortable` is unreachable with a past deadline, so there is no hang). No test covers it.
Suppressing it would require a new `SecureStoreLockOptions` flag, which is a shared-surface change
that #304 does not justify.

**This is stated plainly because it contradicts the comment wording used by two of the three input
designs**, both of which asserted that `deadlineEpochMs: nowMs()` throws `SECURE_STORE_LOCK_BUSY`
"on the first pass". It does not, unconditionally. The comment shipped in the code must say
"reproducing the pre-migration loop, which never slept", not "on the first pass".

### Not blocked, but new

- The claim directory is now `fsync`ed on publish (`atomic.ts:177`) and best-effort on release
  (`lock.ts:317`); the old code did neither. Not observable by any claim test.
  `plan-engine.test.ts:1797-1869` spies on `FileHandle.prototype.sync` with an exact `events` array,
  but that spy is scoped to `appendLidarrPlanHistory` and restored in a `finally` at `:1866`; no
  claim code runs inside it. Full-suite green confirms.
- Owner-metadata (`host === ""`, `pid <= 0`) now throws `LidarrPlanValidationError` where the old
  code silently accepted it and published the bad record. Reachable only through the test-only
  `hostname`/`pid` seams — no production caller passes either, and no test injects an out-of-range
  value (`grep 'pid: [-0-9]'` over the suite returns 42, 43, 8, 7, 99 only). Without the gate, the
  measured outcome is `LidarrPlanAlreadyRunningError` for the caller's _own_ bad pid, which is a lie.
- The claim path length bound tightens by `len("/" + planId + ".lock") = 42` characters, because
  `resolveLidarrStoragePath` bounds the **directory** at 4096 (`:3848`) and `resolveSecurePath` then
  bounds the **full** path (`lock.ts:397`). Strictly more correct — the syscall uses the full path.

## Dead code removed

All from `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`. "Proof" is the exhaustive `grep -n`
hit list; every listed use is inside the deleted region.

| Symbol                                                                    | Lines        | All uses in the repository                                                                                                                        | Superseded by                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isRecord` (import specifier)                                             | `:159`       | `:159` (import), `:4664` (`parseClaimRecord`). Exactly two hits file-wide; the symbol stays exported by `plan-validation.ts` for other consumers. | —                                                                                                                                                                                                                                                           |
| `CLAIM_MAX_BYTES`                                                         | `:195`       | `:195`, `:4699`.                                                                                                                                  | `lock.ts:52` `LOCK_MAX_BYTES = 4_096`                                                                                                                                                                                                                       |
| `interface ClaimRecord`                                                   | `:792-797`   | `:792`, `:4663`, `:4697`, `:4710`, `:4726`, `:4755` — all claim-only.                                                                             | `SecureStoreLockRecord` (module-private to `lock.ts`, deliberately not on the barrel)                                                                                                                                                                       |
| `parseClaimRecord`                                                        | `:4663-4693` | `:4700` only.                                                                                                                                     | `lock.ts:215-250` `parseLockRecord`                                                                                                                                                                                                                         |
| `readClaim`                                                               | `:4695-4706` | `:4713`, `:4808` only.                                                                                                                            | `lock.ts:253-269` `readExistingLock`                                                                                                                                                                                                                        |
| `claimIsOwned`                                                            | `:4708-4722` | `:4729`, `:4784` only.                                                                                                                            | `lock.ts:283-291` `isSameRecord` + `paths.ts:84` `sameIdentity`, inside `SecureStoreLock.assertOwned`                                                                                                                                                       |
| `unlinkClaimIfOwned`                                                      | `:4724-4735` | `:4791`, `:4798`, `:4816` only.                                                                                                                   | `lock.ts:293-319` `unlinkLockIfOwned`, which additionally re-asserts the parent and best-effort `fsync`s the directory                                                                                                                                      |
| the two-attempt publish loop and its catch-block compensation             | `:4757-4818` | —                                                                                                                                                 | `atomic.ts:162-190` driven from `lock.ts:416-502`                                                                                                                                                                                                           |
| the bespoke staging name `` `.${planId}.${nodeRandomUUID()}.claim.tmp` `` | `:4759`      | —                                                                                                                                                 | `atomic.ts:135-144` `temporaryNamePrefix`, the single rule `removeOrphanedTemporaryFiles` (`atomic.ts:260`, `:272`) also matches on, so producer and sweeper can no longer drift                                                                            |
| the unreachable terminal `throw new LidarrPlanAlreadyRunningError`        | `:4819`      | —                                                                                                                                                 | Provably unreachable today: the loop at `:4757` either returns (`:4781`), throws at `:4800-4806`, or throws at `:4813-4815`; the only fall-through is a successful steal on attempt 0, which always re-enters. It exists solely to satisfy the return type. |

**Not removed, deliberately:**

- `defaultIsProcessAlive` (`:4654-4661`) — kept verbatim and still passed explicitly (C10). A
  byte-identical independent copy at `profile-preset-persistence.ts:212-219` is likewise still passed
  explicitly after #288; de-duplicating them is a separate chore.
- `LidarrPlanAlreadyRunningError` (import `:13`) — its three current uses (`:4785`, `:4814`, `:4819`)
  are all inside the deleted region, but the two new translators reconstruct it, so the import stays
  live. Confirmed by the prototype typecheck.
- `SECURE_STORE_MAX_PATH_LENGTH as MAX_PATH_LENGTH` (import `:108`) — its only other use, `:3848`, is
  inside `resolveLidarrStoragePath`, which this design keeps in place.
- `hasCode`, `FileIdentity`, `sameIdentity`, `resolveLidarrStoragePath`, `prepareSafeParent`,
  `assertSafeParentUnchanged`, `assertOpenedFileIdentity`, `readBoundedFile`,
  `TERMINAL_CONTROL_PATTERN`, `PRIVATE_FILE_MODE`, `PRIVATE_DIRECTORY_MODE`, `UUID_PATTERN`,
  `nodeHostname`, `nodeRandomUUID`, `link`, `unlink`, `rm` — every one has surviving non-claim
  callers. Migrating them is #305.

**Toolchain note, correcting a claim made by one input design:** `packages/rfmedia-cli/tsconfig.json`
sets `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch` and `verbatimModuleSyntax` —
but **not** `noUnusedLocals`/`noUnusedParameters` — and the repository has **no ESLint**
(root `package.json`: `"lint": "npm run typecheck && npm run lint:md"`; no `eslint.config.*`
anywhere). The dead-import removals in this section are repo-policy hygiene ("No dead code"), not a
compile requirement, and nothing in CI will catch them. They are a review-only responsibility.

## Out of scope

| Item                                                                                                                                                                    | Reason                                                                                                                                                                                                                                                                                                                       | Follow-up                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Splitting `plan-engine.ts` (4820 lines) into modules                                                                                                                    | The extraction that would make `plan-claim.ts` viable also drags `resolveLidarrStoragePath` (four non-claim callers, test-pinned by C11) into the same revert unit and pre-empts #305. Migrating in place matches the #288 precedent, which shrank `profile-preset-persistence.ts` from 1003 to 761 lines without moving it. | Yes, separate chore; it should follow #305, not precede it |
| `plan-engine.ts` path walks, bounded reader and atomic writers                                                                                                          | `readBoundedFile` has no mode gate and three callers classify on raw errnos (`:3997`, `:4330`, `:4438`); migrating them needs a translator threaded through the whole file.                                                                                                                                                  | **#305**, explicitly gated on this issue's error taxonomy  |
| De-duplicating `defaultIsProcessAlive` (also at `profile-preset-persistence.ts:212-219`) and `hasCode` (also at `profile-preset-persistence.ts:91`)                     | Hoisting either to a shared module couples two migrated locks and destabilises a second test suite.                                                                                                                                                                                                                          | Yes, small chore                                           |
| De-duplicating `TERMINAL_CONTROL_PATTERN` (`plan-engine.ts:199`, `plan-validation.ts:7`) or routing it onto `secure-store`'s `containsTerminalControl` (`errors.ts:82`) | Semantically equivalent but touches `canonicalizeLidarrPlanOrigin` (`:801`) and `plan-validation.ts`, both with independent suites.                                                                                                                                                                                          | Yes, small chore                                           |
| Deleting the `randomUUID,` forward at `lock.ts:437`                                                                                                                     | The staging collision it would guard against is unreachable — see Rejected alternatives.                                                                                                                                                                                                                                     | No                                                         |
| Moving the four claim tests out of `plan-engine.test.ts`                                                                                                                | #304 mandates that file pass UNMODIFIED. Satisfying the gate at an intermediate commit and breaking it at PR head is gate-gaming.                                                                                                                                                                                            | Yes, after this ships                                      |
| Any CLI flag for `maxAgeMs` / `deadlineEpochMs`                                                                                                                         | Module-level decisions, exactly as #288 recorded them (`design.md:654`). A new option long would force simultaneous edits to three completion templates plus the order-sensitive `templates.spec.ts:1792`/`:1815` literals.                                                                                                  | No                                                         |

## Verification plan

Run from the repository root unless stated otherwise.

```bash
npm run test:run                                    # scripts/test-run.sh: the ONLY runner that
                                                    # normalizes umask 022 and unsets FORCE_COLOR
npm run typecheck --workspace packages/rfmedia-cli  # pretypecheck: codegen:lidarr:check +
                                                    # check:architecture + test:architecture
npm run build -w packages/rfmedia-cli
npm run lint:md
npm run format:check
```

Per-file iteration, from `packages/rfmedia-cli`:

```bash
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts
umask 022 && env -u FORCE_COLOR npx vitest run src/actions/lidarr/
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts
umask 022 && env -u FORCE_COLOR npx tsc --noEmit -p tsconfig.json
```

Expected, all measured on the prototype:

| Gate                                           | Expected                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| `plan-engine.test.ts`                          | 75 passed, file byte-unmodified                      |
| `src/actions/lidarr/`                          | 25 files / 419 passed                                |
| full package suite                             | 172 files / 4482 passed → **4483** with the new test |
| `tsc --noEmit`                                 | exit 0, no output                                    |
| `check:architecture`                           | `OK: … 340 production files`                         |
| `test:architecture`                            | `# fail 0`                                           |
| `git status --porcelain` after the code commit | only `plan-engine.ts`                                |

**Mechanical abort criterion.** `git diff --name-only` for the code commit must list exactly
`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`. If any `*.test.ts` other than
`secure-store.test.ts` needs an edit, the migration is wrong; stop and refile.

### The one new test

`src/lib/secure-store/secure-store.test.ts` (371 lines, 10 `it` blocks) gains **one**, matching
the #288 precedent where only that file gained tests:

> **`maxAgeMs: null` still steals a same-host lock held by a dead pid.** Same-host record,
> `isProcessAlive: () => false`, `maxAgeMs: null`, and `deadlineEpochMs === now()`; the lock is
> stolen and reacquired in a single call, and the republished record carries the new pid.

This is the highest-value item in the change. It is the only cell of the steal matrix that nothing
covers: `secure-store.test.ts:101-119` covers same-host + dead pid under the **default** `maxAgeMs`,
`:231-261` covers `maxAgeMs: null` blocking the **age** steal, and in `plan-engine.test.ts` the
`isProcessAlive: () => false` at `:2153` never reaches the steal (the record is malformed and the
corrupt classification fires first) while `:2183` is cross-host. Under `maxAgeMs: null` the
same-host-dead-pid rule becomes the **only** steal path in the migrated claim, so a `maxAgeMs` or
`binding` slip that broke it would ship green. Measured working end to end; nothing would catch a
regression.

**Explicitly not added:** a test asserting that `plan-engine.ts` imports `acquireExclusiveLock` (the
compiler enforces it), and any test duplicating the four frozen claim tests.

### CI

Both CLI workflows declare `push.branches: [main]` while the default branch is `master`, and
`.github/workflows/rfmedia-cli.yml:56` invokes the workspace script directly and inherits the ambient
umask. The `pull_request` run is therefore the only gate and must be green on the **full** suite. A PR
with merge conflicts queues no `pull_request` run at all — check `mergeable` before blaming the
workflow.

### Commits

1. `refactor(rfmedia): migrate the Lidarr plan claim lock onto secure-store` — the seven hunks. The
   body must name `maxAgeMs: null`, `deadlineEpochMs: nowMs()`, the local `defaultIsProcessAlive`,
   the two translator tables and the owner-metadata gate as **decisions**, and must record
   Blocked-1/2/3. Footer `Closes #304`.
2. `docs(internal): add the issue-304 claim-lock migration design` + `ROADMAP.md`.

`ROADMAP.md` carries #304 in four coupled places plus two header counters, all verified present:
`:44` (Current focus narrative), `:63-64` (Sprint 2 table — delete row 1, promote #305 to order 1 and
restate or drop its "Depends on #304 error taxonomy" note), `:179`
(`### Medium priority — copy, verify, policy & metadata (10)` → `(9)`), `:192` (backlog row deleted),
`:279` (Cross-cutting themes row → `#305–#308`), plus `:8` (`**Last updated:**`) and `:10`
(`**Open issues:** 82 (rfapps 36 · rfmedia 46)` → `81 … 45`). **No** `docs/roadmap-archive.md` row:
Sprint 2 does not close with #304 (#305–#308 remain), and `ROADMAP.md`'s Maintenance section archives
only on a full sprint close.

## Rejected alternatives

### A. Extract `lidarr/plan-claim.ts` + `lidarr/plan-path-safety.ts` (the modularity design)

Rejected on scope and on one false premise.

- The second leaf exists only to break a cycle the extraction itself creates: `plan-claim.ts` would
  need `resolveLidarrStoragePath` from `plan-engine.ts` while `plan-engine.ts` re-exports
  `acquireLidarrPlanClaim`. Moving `resolveLidarrStoragePath` (four non-claim callers at `:3883`,
  `:4007`, `:4067`, `:4134`) and `TERMINAL_CONTROL_PATTERN` (consumed by
  `canonicalizeLidarrPlanOrigin` at `:801`) pulls the test-pinned artifact-path taxonomy
  (`plan-engine.test.ts:1756-1771`) into a lock migration's revert unit and pre-empts #305.
- Its Risk #1 — "`tsc` catches the dead imports, `noUnusedLocals` build failure if left" — is false;
  see the toolchain note above.
- Its edit table claims "exactly two deletions beyond the claim block" while missing that
  `LidarrPlanAlreadyRunningError` (`:13`) becomes dead **under that design**, because the translators
  move out of `plan-engine.ts`. Under the chosen design it stays live.
- Its open question floats moving the four frozen claim tests inside the same PR, which would break
  C1 at PR head.

The extraction is a good change; it is a different one, and it should follow #305.

### B. Delete the `randomUUID,` forward at `lock.ts:437` (the contract design's move M5)

Rejected: the justification is demonstrably false, and the proposed regression test is vacuous.

The claim was that forwarding a constant `randomUUID` makes a same-name `open(O_EXCL)` `EEXIST`
reachable through the immediate-retry loop. It is not: `atomic.ts:181-187` removes the staging file
in a `finally` on **every** exit path, and that `finally` completes before `acquireExclusiveLock` can
`continue`. Iteration N+1 always finds the name free. The proposed test — "survives a forced retry
with a constant `randomUUID`" — passes identically with and without the deletion, so it cannot fail
on unfixed code and would give a reviewer false confidence that a shared-module edit is covered.
Verified by reading `atomic.ts:162-190` and by the prototype's green full suite with the seam
forwarded.

Editing shipped `secure-store` code for a caller-specific migration also breaks the revert unit for
no gain.

### C. Keep a local `prepareSafeParent(claimPath, true)` in front of `acquireExclusiveLock`

Rejected. `acquireExclusiveLock` already walks the parent at `lock.ts:398`; keeping both is one
duplicate walk with two error taxonomies for a single fault, and the argument for it (preserving the
message and `planPath: undefined` for a hostile parent) does not apply to the case any test covers —
C11 is about hostile path _strings_, which `resolveLidarrStoragePath` still gates. The residual delta
is enumerated under "What is deliberately dropped".

### D. Map acquisition `SECURE_STORE_PERMISSIONS` to `LidarrPlanAlreadyRunningError`

Rejected in favour of `LIDARR_PLAN_IO`. It would preserve the statistically more common
pre-migration outcome for an unreadable incumbent, but it leaves the operator with a permanently
wedged claim (Blocked-1) and no diagnostic, because `LidarrPlanAlreadyRunningError` carries no
`code`. The `assertOwned` arm goes the other way on the same code, and that asymmetry is deliberate
— see Error mapping.

### E. Let `lock.ts:403`'s `isProcessAliveByDefault` supply the liveness probe

Rejected. `plan-engine.ts:4659` returns `!hasCode(error, "ESRCH")`; `lock.ts:178` returns
`hasErrorCode(error, "EPERM")`. They agree on `ESRCH` and `EPERM` and invert on every other errno.
Because `maxAgeMs: null` makes same-host-dead-pid the only steal rule, omitting the explicit forward
would silently flip the policy from fail-closed to fail-open and let a second process evict a
live-but-unprobeable owner mid-apply. No test would catch it (C10).

### F. Forward `args.options.signal` into `acquireExclusiveLock`

Rejected (C12). `apply-track-filter-execution.ts:209` already aborts before the claim at `:233`, and
`apply-track-filter-execution.test.ts:290-311` asserts `rejects.toThrow("cancelled")`. Forwarding the
signal would produce `SECURE_STORE_CANCELLED` instead — whose message happens to contain "cancelled",
so the test could pass for the wrong reason today and diverge later. Independently, `apply.ts:1441`
acquires before its `AbortController` cleanup is wired, so a waiting acquisition would be
uninterruptible.

### G. Pass a `binding`

Rejected (C13). Any non-`undefined` value adds a fifth key to the on-disk record (`lock.ts:427`),
breaking byte-equality with the pre-migration record and with the replacement literal at
`plan-engine.test.ts:2125-2130`, and making `isSameRecord`'s `current.binding === expected.binding`
axis live. `LidarrPlanClaim` has no `originDigest` analogue — there is nothing to bind.
