# Issue 304 — claim-lock implementation plan (analysis)

**Status:** Executable plan produced against the design analysis in
[`prototype-evidence.md`](./prototype-evidence.md) and hardened by four adversarial critics.
[`parallel-plan.md`](./parallel-plan.md) is the plan the shipped work actually followed.

Its literal gates and measured baselines remain accurate and reusable. Its edit list assumes the
pre-divergence design, so it does not describe the `strictRecordShape` / `temporaryUUID` work that
shipped — see the divergence table in [`prototype-evidence.md`](./prototype-evidence.md).

**Worktree root (every path below is absolute and anchored here):**
`/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock`

**Package root:** `<worktree>/packages/rfmedia-cli`

**Baseline:** `master` `c54b647b`. Measured in this worktree, not quoted from the design:

| Measurement                                    | Value                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Full `rfmedia-cli` suite                       | 172 files / **4482** tests passed                                   |
| `src/lib/lidarr/plan-engine.test.ts`           | **75** tests passed                                                 |
| `src/lib/secure-store/secure-store.test.ts`    | **11** tests passed (design says 10 — stale; the file is 371 lines) |
| `src/actions/lidarr/`                          | 25 files / **419** tests passed                                     |
| `plan-engine.ts`                               | 4820 lines                                                          |
| `sha256sum src/lib/lidarr/plan-engine.test.ts` | `ea0e4a7815a24accfa54b22226e41d1f6d7a462ed3ebfde9be6eb419174beea3`  |
| `git status --porcelain`                       | `?? docs/plans/issue-304-claim-lock-migration/` only                |

Branch target: 172 files / **4483** tests — exactly `+1`, the single new `it` in
`src/lib/secure-store/secure-store.test.ts` (Step 13).

---

## Owner decisions (settled — do not relitigate)

| id  | Decision                                                                                                                                                                                                        | Where it lands     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| D1  | Blocked-1 (an incumbent claim carrying foreign access bits, e.g. `0o644`) is classified **`LIDARR_PLAN_IO`** on the acquisition arm, **not** `LidarrPlanAlreadyRunningError`.                                   | Step 6             |
| D2  | The owner-metadata gate (empty `host`, or `pid <= 0`, supplied by the **caller**) **ships**, routed through the existing `validationError` helper so it reuses `LidarrPlanValidationError`. No new error class. | Step 9             |
| D3  | **One squashed commit** for the whole PR, subject `chore(rfmedia): …`, matching sibling migration #288 (`0640943f`), which shipped design + plan + code + ROADMAP together.                                     | Step 16            |
| D4  | A `plan.md` ships alongside `design.md`, matching every prior plan directory.                                                                                                                                   | this file, Step 16 |

D1 rationale to record in the code comment and the PR body: `LIDARR_PLAN_IO` carries a `code` into
the `--output json` envelope (`src/commands/lidarr.ts:341-357`), so the operator sees a diagnosable
permanent wedge and can act on it (`chmod 600 <claim>` or delete the claim file);
`LidarrPlanAlreadyRunningError` carries no `code` and would present an unresolvable state as a
transient one.

D2 rationale to record: without the gate, `acquireExclusiveLock` reports the caller's **own** invalid
`pid`/`host` as `SECURE_STORE_CORRUPT` (`lock.ts:407-409`), which the adapter would translate into
"plan already being applied" — a false statement about another process. It also keeps the `CORRUPT`
arm meaning exactly one thing: an unparseable incumbent.

---

## How to run the gates

**THE ONE RULE.** A bare `vitest` run under `umask 002`, or with `FORCE_COLOR` set in the
environment, produces spurious failures that have nothing to do with this change. Every test
invocation in this plan is therefore written in one of exactly two forms:

```bash
# Form A — targeted suite, from the PACKAGE root
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx vitest run <files...>

# Form B — full monorepo suite, from the WORKTREE root
# (scripts/test-run.sh sets `umask 022` and `unset FORCE_COLOR` itself)
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && npm run test:run
```

Non-test gates (`typecheck`, `build`, `format:check`, `lint:md`) run from the **worktree root** and
need no normalization.

**Every gate command in this plan is written with an absolute path.** The agent shell resets its cwd
between calls, and the main checkout at `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps` sits
at the same HEAD with its own `node_modules`; a relative-path gate would happily run the
**pre-migration** module and pass while proving nothing. Do not shorten these commands.

Shorthand used below:

```bash
export W=/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock
export P=$W/packages/rfmedia-cli
```

Shell state does not persist between calls, so re-export or inline the paths each time.

**Bootstrap:** already done in this worktree (`$W/node_modules`, `$P/node_modules` and
`$W/packages/rf-common/dist` all exist). If a fresh worktree is used, run `cd $W && npm ci`
serially before anything else — every gate fails without it.

---

## Change shape

**Migrate in place. Two source files change, plus two docs files.**

| File                                                             | Change                                                                         | Steps |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`             | 5 hunks: the claim region rewrite plus four deletions/one import edit above it | 2–11  |
| `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts` | exactly one new `it` block appended inside an existing `describe`              | 13    |
| `ROADMAP.md`                                                     | retire #304 from Sprint 2, the medium backlog and the counters                 | 15    |
| `docs/plans/issue-304-claim-lock-migration/{design,plan}.md`     | committed with the change (D3/D4)                                              | 16    |

**No `secure-store` production edit. No barrel edit. No new module. No new export.** All three
imported symbols (`acquireExclusiveLock`, `SecureStoreError`, `SecureStoreLock`) are already exported
from `src/lib/secure-store/index.ts`.

### Apply order

Steps 2–11 all touch `plan-engine.ts` and are ordered **strictly descending by line number**
(`:4654-4820` → `:792` → `:195` → `:159` → `:105`), so every anchor cited below stays valid as you
go. Steps 2–7 and 9 together form **one contiguous replacement of `plan-engine.ts:4654-4820`**;
write that region in a single edit, in the order the steps are listed (that is the final file
order), then continue upward with Steps 8, 10 and 11.

TypeScript **cannot be kept green between Steps 2 and 11.** Treat them as one atomic change; the
first legitimate compile gate is Step 12.

---

## Step 1 — Baseline pins and abort thresholds

### 1. Scope

No edits. Capture the values every later gate compares against, in this worktree.

### 1. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && git rev-parse --short HEAD \
  && git status --porcelain \
  && sha256sum packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts \
  && wc -l packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts \
       packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts ROADMAP.md
```

Expected, exactly:

```text
c54b647b
?? docs/plans/issue-304-claim-lock-migration/
ea0e4a7815a24accfa54b22226e41d1f6d7a462ed3ebfde9be6eb419174beea3  packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts
4820 packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts
 371 packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts
 288 ROADMAP.md
```

Then confirm the frozen suites are green **before** touching anything:

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx vitest run \
     src/lib/lidarr/plan-engine.test.ts src/lib/secure-store/secure-store.test.ts
```

Expected: `Test Files 2 passed (2)`, `Tests 86 passed (86)` (75 + 11).

Optionally capture the two pre-migration behaviour baselines the D1/D2 probes assert against (see
Steps 6 and 9). Against unmodified code they print `ACQUIRED (stole the 0o644 incumbent)` and
`ACCEPTED` three times. Both probe files live at `/tmp/`, **outside the repository**, so they never
contaminate a scope gate.

### 1. Rollback

N/A.

---

## Step 2 — `CLAIM_SUBJECT` and the preserved liveness probe

### 2. File and anchor

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, `defaultIsProcessAlive` at **`:4654-4661`**.
This is the first text of the contiguous `:4654-4820` replacement.

### 2. Resulting code

The function body is kept **verbatim** — do not retype it, and do not swap it for
`isProcessAliveByDefault`. Only the JSDoc and the preceding constant are new.

```ts
/** Short human name secure-store prints for this lock. */
const CLAIM_SUBJECT = "Lidarr plan claim";

/**
 * Liveness probe for the claim lock.
 *
 * Deliberately this module's own probe, not `isProcessAliveByDefault`
 * (`secure-store/lock.ts:173-180`): an errno that is neither ESRCH nor EPERM
 * means ALIVE here and DEAD there. With `maxAgeMs: null` the same-host-dead-pid
 * rule is the ONLY steal, so that divergence alone decides whether a
 * live-but-unprobeable owner is evicted mid-apply. Migrating a lock must not
 * silently migrate its liveness policy.
 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}
```

### 2. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && grep -n 'const CLAIM_SUBJECT = "Lidarr plan claim";' src/lib/lidarr/plan-engine.ts \
  && grep -c 'isProcessAliveByDefault' src/lib/lidarr/plan-engine.ts
```

Expected: one hit for `CLAIM_SUBJECT`; `0` for `isProcessAliveByDefault`.

### 2. Rollback

Trivially revertible in isolation only before Step 6 lands. After Step 6, roll back the whole
`:4654-4820` region as one unit.

---

## Step 3 — Delete the four superseded claim primitives

### 3. File and anchor

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, **`:4663-4735`**:

| Symbol               | Lines        | All uses in the repo (verified `grep -n`) | Superseded by                                     |
| -------------------- | ------------ | ----------------------------------------- | ------------------------------------------------- |
| `parseClaimRecord`   | `:4663-4693` | `:4700` only                              | `lock.ts:215-250` `parseLockRecord`               |
| `readClaim`          | `:4695-4706` | `:4713`, `:4808` only                     | `lock.ts:252-270` `readExistingLock`              |
| `claimIsOwned`       | `:4708-4722` | `:4729`, `:4784` only                     | `lock.ts:283-291` `isSameRecord` + `sameIdentity` |
| `unlinkClaimIfOwned` | `:4724-4735` | `:4791`, `:4798`, `:4816` only            | `lock.ts:293-319` `unlinkLockIfOwned`             |

### 3. Resulting code

Nothing. All four functions are deleted outright, along with the blank lines that separated them.

### 3. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && test -z "$(grep -nE 'parseClaimRecord|readClaim|claimIsOwned|unlinkClaimIfOwned' src/lib/lidarr/plan-engine.ts)" \
  && echo CLAIM_PRIMITIVES_GONE
```

Expected: `CLAIM_PRIMITIVES_GONE`.

### 3. Rollback

Part of the `:4654-4820` revert unit.

---

## Step 4 — Add `translateClaimFailure` (acquisition and release arm)

### 4. File and anchor

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, in the space vacated by Step 3, immediately
below `defaultIsProcessAlive` and above `acquireLidarrPlanClaim`.

### 4. Signature (from the design's sketch — reproduce exactly)

```ts
function translateClaimFailure(
  planId: string,
  claimPath: string,
  message: string,
  error: unknown,
): LidarrPlanAlreadyRunningError | LidarrPlanArtifactError | LidarrPlanValidationError;
```

### 4. Resulting code

```ts
/**
 * Maps a claim acquisition or release failure back onto this module's error
 * taxonomy.
 *
 * Leads with a pass-through arm so an error thrown by one of OUR injected seams
 * from inside `acquireExclusiveLock` survives unchanged.
 *
 * The explicit non-`SecureStoreError` tail is load-bearing:
 * `rethrowAsSecureStoreError` (`secure-store/errors.ts:194-203`) maps only
 * ELOOP/ENOTDIR and EACCES/EPERM and rethrows every other errno RAW, and
 * `src/commands/lidarr.ts:258-281` reads `.code` STRUCTURALLY off any thrown
 * object into the `--output json|csv` envelope. Without it a bare ENOSPC or a
 * bare `SecureStoreError` would inject a `SECURE_STORE_*` code into user-facing
 * machine output.
 */
function translateClaimFailure(
  planId: string,
  claimPath: string,
  message: string,
  error: unknown,
): LidarrPlanAlreadyRunningError | LidarrPlanArtifactError | LidarrPlanValidationError {
  if (
    error instanceof LidarrPlanAlreadyRunningError ||
    error instanceof LidarrPlanArtifactError ||
    error instanceof LidarrPlanValidationError
  ) {
    return error;
  }
  if (error instanceof SecureStoreError) {
    switch (error.code) {
      // Contention (`lock.ts:493`), a released latch (`:454`), a moved record
      // (`:462`), and an unparseable incumbent (`:263`, `:267`) are all
      // "someone else owns this claim" — #304's mandated arm, and what the
      // pre-migration `readClaim` swallow produced.
      case "SECURE_STORE_LOCK_BUSY":
      case "SECURE_STORE_CORRUPT":
        return new LidarrPlanAlreadyRunningError(planId, claimPath);
      case "SECURE_STORE_UNSAFE_PATH":
        return new LidarrPlanArtifactError("LIDARR_PLAN_UNSAFE_PATH", `${message}: ${error.message}`, claimPath, {
          cause: error,
        });
      case "SECURE_STORE_TOO_LARGE":
        return new LidarrPlanArtifactError("LIDARR_PLAN_TOO_LARGE", `${message}: ${error.message}`, claimPath, {
          cause: error,
        });
      // Owner decision D1 — see the block comment on this case in the plan of
      // record. `readBoundedPrivateFile` rejects any incumbent carrying group or
      // other access bits (`secure-store/paths.ts:345-347`) where the
      // pre-migration `readBoundedFile` had no mode gate at all, and
      // `maxAgeMs: null` leaves no second steal rule — so a `0o644` claim file
      // is a PERMANENT wedge. It is classified LIDARR_PLAN_IO, not
      // AlreadyRunning: `LidarrPlanArtifactError.code` reaches the machine
      // envelope at `commands/lidarr.ts:341-357`, so the operator sees a
      // diagnosable fault and can `chmod 600 <claim>` or delete it, whereas
      // `LidarrPlanAlreadyRunningError` carries no code and would report an
      // unresolvable state as a transient one.
      case "SECURE_STORE_PERMISSIONS":
      // SECURE_STORE_VERSION_CONFLICT never escapes (`lock.ts:439-443` swallows
      // exactly that code) and SECURE_STORE_CANCELLED is unreachable (no
      // `signal` is forwarded). Both fall to the defensive default.
      default:
        return new LidarrPlanArtifactError("LIDARR_PLAN_IO", `${message}: ${error.message}`, claimPath, {
          cause: error,
        });
    }
  }
  return new LidarrPlanArtifactError(
    "LIDARR_PLAN_IO",
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
    claimPath,
    { cause: error },
  );
}
```

Three things that must **not** be "fixed":

- `SecureStoreError.message` is `SECURE_STORE_MESSAGES[code](subject)` (`errors.ts:25-38`) and
  **never** embeds a path — only `remediation` does, and this adapter discards it. Interpolating
  `error.message` therefore leaks strictly less than the pre-migration `:4803`, which interpolated
  the raw errno message.
- Reconstruct `LidarrPlanAlreadyRunningError` from the adapter's own `claimPath`, never from
  `SecureStoreError.path` — the latter is the sanitized, 512-char-truncated form
  (`errors.ts:97-107`, `:139-146`).
- `case "SECURE_STORE_PERMISSIONS":` is written as an empty case label falling into `default:` on
  purpose, so D1 is visible at the switch. `noFallthroughCasesInSwitch` permits grouped labels with
  no statements between them.

### 4. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && grep -c 'SECURE_STORE_' src/lib/lidarr/plan-engine.ts \
  && grep -n 'case "SECURE_STORE_PERMISSIONS":' src/lib/lidarr/plan-engine.ts
```

Expected after Steps 4+5: `SECURE_STORE_PERMISSIONS` appears **twice** (once per translator) and the
D1 case label is present in `translateClaimFailure`. The full translator table is re-checked at
Step 12 by `tsc`.

### 4. Rollback

Part of the `:4654-4820` revert unit.

---

## Step 5 — Add `translateClaimOwnershipFailure` (the `assertOwned` arm)

### 5. File and anchor

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, immediately after `translateClaimFailure`.

### 5. Signature (from the design's sketch)

```ts
function translateClaimOwnershipFailure(
  planId: string,
  claimPath: string,
  error: unknown,
): LidarrPlanAlreadyRunningError | LidarrPlanArtifactError | LidarrPlanValidationError;
```

### 5. Resulting code

```ts
/**
 * Maps an ownership-verification failure back onto this module's taxonomy.
 *
 * A DISTINCT arm from `translateClaimFailure`, as #304 mandates, and the
 * divergence is the substance rather than a cosmetic split. Pre-migration,
 * `assertOwned` could produce ONLY `LidarrPlanAlreadyRunningError` or a
 * `LidarrPlanArtifactError` rethrown by `readClaim`; it could never produce
 * LIDARR_PLAN_IO. So a raw errno, and a file carrying foreign access bits, both
 * fail CLOSED here — a file at 0o644 is not one this acquisition wrote —
 * while the acquisition arm reports them as environment faults. A single shared
 * translator would change what `apply-deferred-replay.ts:373-378` and
 * `apply-deferred-replay-entry.ts:238-243` rethrow after their compensating
 * database writes, and what the `remoteSucceeded` swallow at `apply.ts:837-848`
 * classifies as `history-write-failed`.
 */
function translateClaimOwnershipFailure(
  planId: string,
  claimPath: string,
  error: unknown,
): LidarrPlanAlreadyRunningError | LidarrPlanArtifactError | LidarrPlanValidationError {
  if (
    error instanceof LidarrPlanAlreadyRunningError ||
    error instanceof LidarrPlanArtifactError ||
    error instanceof LidarrPlanValidationError
  ) {
    return error;
  }
  if (
    error instanceof SecureStoreError &&
    (error.code === "SECURE_STORE_UNSAFE_PATH" || error.code === "SECURE_STORE_TOO_LARGE")
  ) {
    return translateClaimFailure(planId, claimPath, "Unable to verify Lidarr plan claim ownership", error);
  }
  return new LidarrPlanAlreadyRunningError(planId, claimPath);
}
```

### 5. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && grep -n 'Unable to verify Lidarr plan claim ownership' src/lib/lidarr/plan-engine.ts
```

Expected: exactly one hit.

### 5. Rollback

Part of the `:4654-4820` revert unit.

---

## Step 6 — Rewrite `acquireLidarrPlanClaim`

### 6. File and anchor

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, `acquireLidarrPlanClaim` at **`:4737-4820`**
(JSDoc `:4737`, signature `:4738-4741`, body `:4742-4820`).

The exported signature, the `LidarrPlanClaimDependencies` shape (`:386-393`) and the returned
`LidarrPlanClaim` shape (`:395-399`) are **frozen**. `apply.ts:1159` types the claim structurally as
`Awaited<ReturnType<typeof acquireLidarrPlanClaim>>`, and `assertOwned` is threaded through 68
references across 15 files as a bare `() => Promise<void>`.

### 6. Resulting code

The owner-metadata gate inside this body is Step 9; it is shown here in place so the region can be
written in one pass.

```ts
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
  // Owner decision D2. `acquireExclusiveLock` rejects this owner metadata with
  // SECURE_STORE_CORRUPT (`lock.ts:407-409`), which the acquisition arm maps to
  // AlreadyRunning — reporting "another process owns the claim" for the
  // CALLER'S OWN bad pid would be a lie. Failing fast here also keeps the
  // CORRUPT arm meaning exactly one thing: an unparseable incumbent. Mirrors
  // `profile-preset-persistence.ts`'s equivalent gate.
  if (host.length === 0 || !Number.isSafeInteger(pid) || pid <= 0) {
    throw validationError("claim owner metadata must be a non-empty host and a positive pid");
  }

  // Preserves the ownership-token half of the pre-migration owner check
  // (`:4752-4754`): an injected seam yielding a non-UUIDv4 is a validation
  // failure, not a lock failure. Thrown from inside `acquireExclusiveLock`
  // (`lock.ts:418-421`, outside any try), it reaches the translator below as a
  // LidarrPlanValidationError and is rethrown unchanged.
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
      // `lock.ts:491` computes `options.deadlineEpochMs - now()`, and a literal
      // Date.now() against the tests' frozen 2026-07-22 clock leaves
      // remainingMs ~ +1.3e9, so the `<= 0` fast-fail never fires and
      // `lock.ts:495-501` sleeps against a clock that never advances.
      deadlineEpochMs: nowMs(),
      // No age-based steal. The pre-migration rule was same-host AND dead-pid
      // with no age clause; `maxAgeMs: null` short-circuits `lock.ts:360` and
      // leaves `lock.ts:359` as the only steal. A real apply drives per-entry
      // network mutations with assertOwned() between each and routinely
      // outlives SECURE_STORE_LOCK_MAX_AGE_MS.
      maxAgeMs: null,
      now: nowMs,
      hostname: () => host,
      pid,
      isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive,
      randomUUID,
      // NO `binding`: the on-disk record must stay exactly the four keys
      // host, pid, createdAt, ownershipToken, in that order.
      // NO `signal`: both production callers abort BEFORE acquiring.
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
        // inside a `finally` at both production call sites (`apply.ts:1593`,
        // `apply-track-filter-execution.ts:314`), so a throw here would mask
        // the real failure already in flight.
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

### 6. Things that must not be changed

- **Keep `resolveLidarrStoragePath` on the claim DIRECTORY.** It is shared with
  `readLidarrPlanArtifact` and is what keeps a hostile `claimDirectory` string yielding
  `{ code: "LIDARR_PLAN_UNSAFE_PATH", planPath: undefined }` with the input never echoed into
  `message` (pinned by `plan-engine.test.ts:1756-1771`). Letting `resolveSecurePath` become the sole
  gate would also let `claimDirectory: ""` through, because `join("", "<id>.lock")` resolves under
  the process CWD.
- **Drop the local `prepareSafeParent(claimPath, true)`** (pre-migration `:4747`).
  `acquireExclusiveLock` calls `prepareSafeParent(path, true, subject)` itself at `lock.ts:398`, so
  the directory is still created `0o700` and every parent component is still validated. Keeping both
  would be one duplicate walk with two error taxonomies for a single fault.
- **`path` is the adapter's own `claimPath`**, not `held.path`. Provably the same string, but
  `claimPath` is also what the two error constructors need.
- **Return an unfrozen plain object literal**, exactly `{ path, assertOwned, release }`. Do not
  `Object.freeze` it and do not add `ownershipToken`.
- The returned object must **not** be the `SecureStoreLock`; `held` is captured in the two closures
  and never escapes.

### 6. Gate

Structural:

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && grep -n 'maxAgeMs: null' src/lib/lidarr/plan-engine.ts \
  && grep -n 'deadlineEpochMs: nowMs()' src/lib/lidarr/plan-engine.ts \
  && test -z "$(grep -n 'binding:\|signal:' src/lib/lidarr/plan-engine.ts)" \
  && test -z "$(grep -n 'const parent = await prepareSafeParent(claimPath' src/lib/lidarr/plan-engine.ts)" \
  && echo CLAIM_OPTIONS_OK
```

Expected: one hit each for `maxAgeMs: null` and `deadlineEpochMs: nowMs()`; `CLAIM_OPTIONS_OK`.

Behavioural (**D1**) — proves Blocked-1 lands on `LIDARR_PLAN_IO` rather than silently wedging.
Write the probe to `/tmp`, outside the repository:

```bash
cat > /tmp/rfmedia-304-d1-probe.mts <<'PROBE'
import { mkdir, mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const W = "/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock";
const { acquireLidarrPlanClaim } = await import(`${W}/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`);

const root = await mkdtemp(join(tmpdir(), "claim-d1-"));
const claims = join(root, "claims");
await mkdir(claims, { recursive: true });
await chmod(claims, 0o700);
const planId = randomUUID();
const claimPath = join(claims, `${planId}.lock`);
await writeFile(
  claimPath,
  JSON.stringify({ host: hostname(), pid: 424242, createdAt: new Date().toISOString(), ownershipToken: randomUUID() }),
  { mode: 0o600 },
);
await chmod(claimPath, 0o644);
try {
  await acquireLidarrPlanClaim(planId, { claimDirectory: claims, isProcessAlive: () => false });
  console.log("ACQUIRED (stole the 0o644 incumbent)");
} catch (error) {
  const e = error as { constructor: { name: string }; code?: string; message: string };
  console.log(e.constructor.name, e.code ?? "<no code>", JSON.stringify(e.message));
}
PROBE
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx tsx /tmp/rfmedia-304-d1-probe.mts
```

Expected **after** this step:

```text
LidarrPlanArtifactError LIDARR_PLAN_IO "Unable to acquire Lidarr plan claim: Lidarr plan claim file is accessible to another user"
```

Measured **before** this step (recorded here so the delta is documented, not discovered):
`ACQUIRED (stole the 0o644 incumbent)`. Note the message carries **no path** — that is the leak
check, and it must stay true.

The `.mts` extension is mandatory: `tsx` transforms a bare `.ts` under this repo's config to CJS and
rejects top-level `await`.

### 6. Rollback

**Not trivially revertible.** Steps 2–7 and 9 are one contiguous region rewrite; five functions are
deleted and the 83-line acquisition body collapses, so there is no line-by-line diff to undo.
Roll back with `git checkout -- packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` (pre-commit) or
`git revert` of the single squashed commit (post-merge), and re-run Step 1's gate to confirm 4820
lines and 75 green claim tests. Because this is a squashed single-commit PR (D3), the revert unit is
the whole PR — including ROADMAP.md, which must then be re-authored to reinstate #304.

---

## Step 7 — Delete the pre-migration terminal throw and the bespoke staging name

### 7. File and anchor

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` — the tail of the replaced region,
pre-migration `:4757-4819`: the two-attempt publish loop, the bespoke staging name
`` `.${planId}.${nodeRandomUUID()}.claim.tmp` `` at `:4759`, the catch-block compensation at
`:4794-4817`, and the unreachable terminal `throw new LidarrPlanAlreadyRunningError` at `:4819`.

### 7. Resulting code

Nothing — all of it is subsumed by Step 6's delegation. Rationale worth knowing while reviewing:

- The bespoke staging name never matched the single naming rule at `secure-store/atomic.ts:135-144`,
  so `removeOrphanedTemporaryFiles` could never sweep an orphan it left. `createPrivateFileAtomically`
  now owns both producer and sweeper, so they cannot drift.
- The terminal throw was provably unreachable already; it existed only to satisfy the return type.
- Forwarding `randomUUID` into `acquireExclusiveLock` also pins the **staging** file suffix
  (`lock.ts:437` → `atomic.ts:140`). That is safe: `atomic.ts:181-187` removes the stage in a
  `finally` on **every** exit path, and that `finally` completes before the acquisition loop can
  `continue`, so iteration N+1 always finds the constant name free. Do **not** "fix" this by editing
  `lock.ts`.

### 7. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && test -z "$(grep -n 'claim.tmp' src/lib/lidarr/plan-engine.ts)" \
  && test "$(grep -c 'LidarrPlanAlreadyRunningError' src/lib/lidarr/plan-engine.ts)" = 4 \
  && echo CLAIM_LOOP_GONE
```

Expected: `CLAIM_LOOP_GONE`. The count is 4: the import at `:13`, plus one construction in each of
the two translators, plus the `instanceof` guards — verify by eye that none of them sits inside a
retry loop.

### 7. Rollback

Part of the `:4654-4820` revert unit (see Step 6).

---

## Step 8 — Delete `interface ClaimRecord`

### 8. File and anchor

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, **`:792-797`**, plus the blank line at `:798`
that separated it from `canonicalizeLidarrPlanOrigin`'s JSDoc at `:799`.

Before:

```ts
interface ClaimRecord {
  readonly host: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly ownershipToken: string;
}

/** Returns a canonical HTTP(S) origin and rejects path/query/auth variants. */
```

After: `createLidarrMutationExecutors`'s closing `}` at `:790`, one blank line, then the
`/** Returns a canonical HTTP(S) origin …` JSDoc. Superseded by `SecureStoreLockRecord`, which is
module-private to `lock.ts` and deliberately not on the barrel.

### 8. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && test -z "$(grep -n 'ClaimRecord' src/lib/lidarr/plan-engine.ts)" && echo CLAIMRECORD_GONE
```

Expected: `CLAIMRECORD_GONE`. (Pre-edit this grep returns 7 hits: the declaration plus six uses, all
inside the region deleted by Steps 3 and 6.)

### 8. Rollback

Trivially revertible on its own, but only meaningful together with Steps 2–7.

---

## Step 9 — The owner-metadata gate (D2)

### 9. File and anchor

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, inside `acquireLidarrPlanClaim`, immediately
after `const pid = dependencies.pid ?? process.pid;`. The code is written in Step 6; this step
exists because the gate is an owner decision with its own executable proof.

### 9. Resulting code

```ts
if (host.length === 0 || !Number.isSafeInteger(pid) || pid <= 0) {
  throw validationError("claim owner metadata must be a non-empty host and a positive pid");
}
```

Constraints:

- Route through the **existing** `validationError` helper imported from `./plan-validation.js`
  (`:165`), which returns `LidarrPlanValidationError`. **No new error class**, no new code string.
- The gate reads the already-resolved `host` and `pid` locals, and `hostname: () => host` is what is
  forwarded into `acquireExclusiveLock`, so the injected seam is called exactly once and the
  validated value is what reaches the record.
- The gate runs **after** `resolveLidarrStoragePath`, so a call that is simultaneously
  hostile-path and invalid-metadata still reports `LIDARR_PLAN_UNSAFE_PATH`. Do not hoist it.
- Reachable only through the test-only `hostname`/`pid` seams: no production caller passes either
  (`apply.ts:1188`, `:1441`, `apply-track-filter-execution.ts:234` pass only `claimDirectory`), and
  no existing test injects an out-of-range value (`grep 'pid: [-0-9]'` over the suite returns 42, 43,
  8, 7 and 99 only). So this cannot move any frozen test.

### 9. Gate

Structural:

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && grep -n 'claim owner metadata must be a non-empty host and a positive pid' src/lib/lidarr/plan-engine.ts \
  && test "$(grep -c 'class Lidarr.*Error extends' src/lib/lidarr/plan-engine.ts)" = 0 \
  && echo D2_NO_NEW_ERROR_CLASS
```

Expected: exactly one hit for the message; `D2_NO_NEW_ERROR_CLASS`.

Behavioural:

```bash
cat > /tmp/rfmedia-304-d2-probe.mts <<'PROBE'
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const W = "/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock";
const { acquireLidarrPlanClaim } = await import(`${W}/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`);
const { LidarrPlanValidationError } = await import(`${W}/packages/rfmedia-cli/src/lib/errors.ts`);

const root = await mkdtemp(join(tmpdir(), "claim-d2-"));
for (const bad of [{ pid: 0 }, { pid: -1 }, { hostname: () => "" }] as const) {
  try {
    await acquireLidarrPlanClaim(randomUUID(), { claimDirectory: join(root, "claims"), ...bad });
    console.log("ACCEPTED", JSON.stringify(Object.keys(bad)));
  } catch (error) {
    console.log(
      error instanceof LidarrPlanValidationError ? "VALIDATION" : (error as Error).constructor.name,
      JSON.stringify(Object.keys(bad)),
    );
  }
}
PROBE
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx tsx /tmp/rfmedia-304-d2-probe.mts
```

Expected **after** this step:

```text
VALIDATION ["pid"]
VALIDATION ["pid"]
VALIDATION ["hostname"]
```

Measured **before** this step (documented delta): `ACCEPTED` three times — today the bad record is
published. `LidarrPlanAlreadyRunningError` on any of the three lines means the gate is missing or
mis-ordered and `acquireExclusiveLock` is reporting the caller's own bad metadata as another
process's claim; that is exactly the failure D2 exists to prevent.

### 9. Rollback

Part of the `:4654-4820` revert unit (see Step 6). Removing only the gate is possible but
reintroduces the false "already being applied" report; do not do it without re-opening D2.

---

## Step 10 — Delete the dead `CLAIM_MAX_BYTES` and `isRecord` import specifier

### 10. Files and anchors

Two independent one-line deletions in
`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, applied in descending line order.

**10a — `:195`.** Before:

```ts
const CLAIM_MAX_BYTES = 4_096;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/u;
```

After — a single-line deletion; `CHECKSUM_PATTERN` becomes `:195` and nothing else moves:

```ts
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/u;
```

Do not add a blank line, a comment, or reorder anything. Superseded by `lock.ts:50`
`LOCK_MAX_BYTES = 4_096`.

**10b — `:159`.** Delete the whole line `isRecord,` (two-space indent) from the
`./plan-validation.js` named-import block
(`:157-167`). Exactly two hits exist file-wide (`:159` and `:4664`, inside the function deleted at
Step 3), and `plan-validation.ts` keeps exporting the symbol for its other consumers. Keep
`assertNoSensitiveKeys`, `requireBoolean`, `requireExactKeys`, `requirePositiveInteger`,
`requireRecord`, `requireString`, `validationError` and `type UnknownRecord`.

### 10. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && test -z "$(grep -n 'CLAIM_MAX_BYTES' src/lib/lidarr/plan-engine.ts)" \
  && test -z "$(grep -nE '^\s*isRecord,$' src/lib/lidarr/plan-engine.ts)" \
  && grep -n 'const CHECKSUM_PATTERN' src/lib/lidarr/plan-engine.ts \
  && grep -n 'validationError,' src/lib/lidarr/plan-engine.ts \
  && echo DEAD_SYMBOLS_GONE
```

Expected: `CHECKSUM_PATTERN` at `:195`, `validationError,` still imported, `DEAD_SYMBOLS_GONE`.

### 10. Note on why this is not compiler-enforced

`packages/rfmedia-cli/tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch` and `verbatimModuleSyntax` — but
**not** `noUnusedLocals`/`noUnusedParameters` — and the repository has **no ESLint**
(root `"lint": "npm run typecheck && npm run lint:md"`; no `eslint.config.*` anywhere). These
deletions are repo-policy hygiene ("No dead code"), and nothing in CI will catch their omission. The
grep gate above is the only enforcement.

### 10. Rollback

Trivially revertible (two lines).

---

## Step 11 — Extend the `secure-store` barrel import

### 11. File and anchor

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, **`:105-110`**. Before:

```ts
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  SECURE_STORE_MAX_PATH_LENGTH as MAX_PATH_LENGTH,
  SECURE_STORE_UUID_PATTERN as UUID_PATTERN,
} from "../secure-store/index.js";
```

After:

```ts
import {
  acquireExclusiveLock,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  SECURE_STORE_MAX_PATH_LENGTH as MAX_PATH_LENGTH,
  SECURE_STORE_UUID_PATTERN as UUID_PATTERN,
  SecureStoreError,
} from "../secure-store/index.js";
import type { SecureStoreLock } from "../secure-store/index.js";
```

Load-bearing details:

- `verbatimModuleSyntax: true` (`tsconfig.json:23`) ⇒ the type import **must** be a separate
  `import type` statement; an inline `type SecureStoreLock,` inside the value block is also legal but
  the separate line matches the #288 precedent in `profile-preset-persistence.ts`.
- The member order (`acquireExclusiveLock` first, `SecureStoreError` last) mirrors #288's import in
  `profile-preset-persistence.ts` exactly. Prettier does not sort imports; do not re-sort the block.
- **Barrel import only.** Never deep-import `../secure-store/lock.js`; `check:architecture` and the
  repo's no-deep-import rule both apply.
- **Nothing is added to the barrel.** All three symbols are already exported from
  `src/lib/secure-store/index.ts`.
- Do not move this block below the `CIRCULARITY GUARD` comment at `:129-134`.
- **Name-collision hazard:** `plan-engine.ts` declares its own `FileIdentity`, `SafeParent`,
  `sameIdentity`, `prepareSafeParent`, `assertSafeParentUnchanged` and `assertOpenedFileIdentity`.
  Broadening the named-import list beyond the six names above is a TS2440/TS2451 redeclaration error.

### 11. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && grep -n 'acquireExclusiveLock,\|SecureStoreError,\|import type { SecureStoreLock }' src/lib/lidarr/plan-engine.ts \
  && test -z "$(grep -rn 'secure-store/[a-z-]*\.js' src --include='*.ts' | grep -v '^src/lib/secure-store/' | grep -v 'secure-store/index.js')" \
  && echo IMPORTS_OK
```

Expected: three hits (the two named specifiers and the type import line), then `IMPORTS_OK`.

### 11. Rollback

Trivially revertible on its own; but with Steps 2–9 applied, reverting it breaks the build.

---

## Step 12 — First compile and frozen-suite gate

### 12. Scope

No edits. This is the first point at which TypeScript can be green, and the first point at which C1
(byte-identical `plan-engine.test.ts`) is provable against real behaviour.

### 12. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && npm run typecheck --workspace packages/rfmedia-cli
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx vitest run src/actions/lidarr/
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && sha256sum packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts \
  && git status --porcelain -- packages/rfmedia-cli
```

Expected:

| Gate                                                                                                    | Expected                                                                 |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `typecheck` (runs `codegen:lidarr:check`, `check:architecture`, `test:architecture` via `pretypecheck`) | exit 0; `OK: … production files`; `# fail 0`                             |
| `plan-engine.test.ts`                                                                                   | `Test Files 1 passed (1)`, `Tests 75 passed (75)`                        |
| `src/actions/lidarr/`                                                                                   | `Test Files 25 passed (25)`, `Tests 419 passed (419)`                    |
| `sha256sum plan-engine.test.ts`                                                                         | `ea0e4a7815a24accfa54b22226e41d1f6d7a462ed3ebfde9be6eb419174beea3`       |
| `git status --porcelain -- packages/rfmedia-cli`                                                        | exactly one line: `M packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` |

Diff shape sanity (informational, from the design's prototype): roughly `+120 / −148` before the
rationale comments, landing near `+160 / −148` with them; `plan-engine.ts` moves 4820 → ~4835.
Executable lines in the claim region drop from ~162 to ~125.

### 12. Abort criteria (hard)

**Stop and re-derive** — do not edit the test — if any of these hold:

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` needs an edit of any kind, or its
  sha256 is not `ea0e4a7815a24accfa54b22226e41d1f6d7a462ed3ebfde9be6eb419174beea3`.
- `git status --porcelain -- packages/rfmedia-cli` lists any `*.test.ts` other than
  `src/lib/secure-store/secure-store.test.ts` (which is not touched until Step 13).
- Any of the four frozen claim tests (`plan-engine.test.ts:2081-2113`, `:2115-2137`, `:2139-2157`,
  `:2159-2187`) fails.

If the test file needs an edit, the migration is re-scoped, not the test. Refile.

### 12. Rollback

`cd $W && git checkout -- packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` restores the
pre-migration file wholesale. Re-run Step 1's gate.

---

## Step 13 — The one new test

### 13. File and anchor

`packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`, inside the existing
`describe("acquireExclusiveLock staleness policy", …)` block (`:230-302`), appended after the
`"steals a legacy record whose binding lives under originDigest"` test that currently ends at `:301`.

**Exactly one new `it`. No other test may be added anywhere**, and no existing test may be edited.
The design's rationale: this is the only uncovered cell of the steal matrix. `secure-store.test.ts:101-119`
covers same-host + dead pid under the **default** `maxAgeMs`; `:231-261` covers `maxAgeMs: null`
blocking the **age** steal; in `plan-engine.test.ts` the `isProcessAlive: () => false` at `:2153`
never reaches the steal (the record is malformed and the corrupt classification fires first) and
`:2183` is cross-host. Under `maxAgeMs: null` the same-host-dead-pid rule becomes the **only** steal
path in the migrated claim, so a `maxAgeMs` or `binding` slip that broke it would ship green.

### 13. Resulting code

```ts
// The migrated Lidarr plan claim passes `maxAgeMs: null` with
// `deadlineEpochMs === now()`, which leaves the same-host-dead-pid rule as its
// ONLY steal path. Nothing else in the suite covers that cell: the default
// maxAgeMs covers dead-pid, and the null case above covers only the age rule.
it("steals a same-host dead-pid lock with maxAgeMs null and a zero remaining deadline", async () => {
  const nowEpochMs = Date.parse("2026-07-25T12:00:00.000Z");
  const abandoned: SecureStoreLockRecord = {
    host: hostname(),
    pid: 424_242,
    createdAt: new Date(nowEpochMs).toISOString(),
    ownershipToken: randomUUID(),
  };
  writeLockRecord(lockPath, abandoned);

  const stolen = await acquireExclusiveLock(lockPath, {
    subject: SUBJECT,
    deadlineEpochMs: nowEpochMs,
    now: () => nowEpochMs,
    isProcessAlive: () => false,
    maxAgeMs: null,
    pid: 4_321,
  });

  expect(stolen.ownershipToken).not.toBe(abandoned.ownershipToken);
  const republished = readRecord(lockPath);
  expect(republished.ownershipToken).toBe(stolen.ownershipToken);
  expect(republished.pid).toBe(4_321);
  expect(republished.binding).toBeUndefined();
  await stolen.release();
  expect(existsSync(lockPath)).toBe(false);
});
```

Notes:

- No new imports. `hostname`, `randomUUID`, `existsSync`, `readRecord`, `writeLockRecord`, `SUBJECT`,
  `lockPath` and `SecureStoreLockRecord` are all already in scope at the top of the file.
- The record's `createdAt` is set to the frozen clock, so the age rule could not fire even if
  `maxAgeMs` were wrong — the assertion isolates the liveness axis.
- `expect(republished.binding).toBeUndefined()` pins the four-key record shape the claim depends on.
- The test terminates without a real clock: the steal sets `retryImmediately`, so the loop re-enters
  and publishes before ever reaching the deadline arithmetic; `waitAbortable` is never called.

### 13. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && git diff --numstat -- packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts
```

Expected: `Test Files 1 passed (1)`, `Tests 12 passed (12)` (11 + 1). The `numstat` must show
**additions only** (`<n> 0 …`) — a non-zero deletion count means an existing test was edited.

Mutation check (optional but cheap, and the reason the test exists): temporarily change
`maxAgeMs: null` to `maxAgeMs: 0` in the new test and confirm it still passes, then change
`isProcessAlive: () => false` to `() => true` and confirm it **fails** with
`SECURE_STORE_LOCK_BUSY`. Revert both.

### 13. Abort criteria

Any pre-existing `secure-store.test.ts` test needs an edit ⇒ stop; the additivity claim has failed
and something in Steps 2–11 changed shared behaviour.

### 13. Rollback

Trivially revertible: delete the one `it` block.

---

## Step 14 — Shell completions: determination, no edit

### 14. Files inspected

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

### 14. Finding — **no change is needed. Do not touch any of these four files.**

Verified in this worktree, not assumed:

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && grep -rniE 'claim|--lock|maxage|deadline' src/lib/shell-completions/
```

returns exactly **one** line, and it is a comment about an unrelated word:

```text
src/lib/shell-completions/templates.spec.ts:1710:    // "sync" is claimed by the plex family in the shared word-scan arm, so
```

A broader `grep -rniE 'lock|claim'` over the same four files returns only:

- `--allow-partial[Execute independently actionable records despite b**lock**ers]` in `zsh.ts:479`
  and `fish.ts:182` — the substring `lock` inside "blockers";
- `extractZshCaseB**lock**`, `plexB**lock**`, `it("**lock**s the … tree across Bash, Zsh, and Fish")`
  in `templates.spec.ts` — helper names and test titles.

No completion candidate, option long, or subcommand in any of the three templates names the claim
lock, and none exists to add: `maxAgeMs`, `deadlineEpochMs`, `subject` and the liveness probe are all
**module-level decisions**, exactly as #288 recorded for the preset lock. This PR adds no flag, no
command, no option and no exit code, so the order-sensitive literals in `templates.spec.ts` — which
assert equality across bash, zsh and fish **simultaneously** — stay green untouched.

Independently: `src/mcp/schema.ts` contains **zero** occurrences of `lidarr` or `claim`
(`grep -ci 'lidarr\|claim' src/mcp/schema.ts` → `0`), so the closed-object MCP schema hazard does not
apply either.

### 14. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && git diff --exit-code -- packages/rfmedia-cli/src/lib/shell-completions/ \
  && echo COMPLETIONS_UNTOUCHED
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/shell-completions/templates.spec.ts
```

Expected: `COMPLETIONS_UNTOUCHED`, and the spec green with no diff.

### 14. Rollback

N/A — nothing changes.

---

## Step 15 — `ROADMAP.md`

### 15. Scope

Docs-only, one file: `ROADMAP.md` (288 lines at HEAD). #304 appears in **five** coupled places plus
two header counters, all verified present at the line numbers cited. **No `docs/roadmap-archive.md`
row:** Sprint 2 does not close with #304 (#305–#308 remain), and `ROADMAP.md:286-287` archives
narrative only when a full sprint closes.

### 15. Edits — apply strictly **bottom-up** (G1 → G6) so every anchor stays valid

**G1 — Cross-cutting themes, `:279`.** Replace the `Secure artifact I/O` row's rfmedia cell so the
range starts at #305:

```text
| Secure artifact I/O | —                                                          | #288, #304 shipped; [#305](https://github.com/yandy-r/rfmedia-apps/issues/305)–[#308](https://github.com/yandy-r/rfmedia-apps/issues/308) | Finish plan I/O migration                    |
```

Do not touch the other five rows; prettier will re-pad the table.

**G2 — medium-priority backlog table, `:192`.** Delete the whole row:

```text
| [#304](https://github.com/yandy-r/rfmedia-apps/issues/304) | Migrate the Lidarr plan claim lock onto `secure-store` |
```

The table then ends at `#134` (`:191`). Row count 10 → **9**.

**G3 — medium-priority heading, `:179`.**

```text
### Medium priority — copy, verify, policy & metadata (10)
```

becomes:

```text
### Medium priority — copy, verify, policy & metadata (9)
```

The low-priority heading at `:231` (`(27)`) and its `<summary>` at `:234` are **unchanged** — #304
was never in that table.

**G4 — Sprint 2 block, `:56-70`.** Delete the `#304` row, promote the remaining four, and restate
the `#305` dependency note now that #304 has shipped. Before (`:58-70`):

```text
Depends on shipped #288. Finish the claim-lock migration before the path-walk/writer work that
shares its error taxonomy:

| Order | Issue                                                                                              | Why now                                       |
| ----- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1     | [#304](https://github.com/yandy-r/rfmedia-apps/issues/304) Lidarr plan claim lock → secure-store   | Last duplicate `link()` lock; medium priority |
| 2     | [#305](https://github.com/yandy-r/rfmedia-apps/issues/305) Plan path walks & atomic writers        | Depends on #304 error taxonomy                |
| 3     | [#306](https://github.com/yandy-r/rfmedia-apps/issues/306) Harden published plan artifacts         | Security follow-through on plan publish       |
| 4     | [#307](https://github.com/yandy-r/rfmedia-apps/issues/307) `verify --fix` under restrictive umasks | Correctness under real operator umasks        |
| 5     | [#308](https://github.com/yandy-r/rfmedia-apps/issues/308) Lock-specific invalid-owner code        | Clearer failure taxonomy for locks            |

**Exit criteria:** Claim lock and remaining plan I/O sit on `secure-store`; publish/verify/lock
edge cases from #306–#308 are closed or explicitly deferred.
```

After:

```text
Depends on shipped #288 and #304. The claim-lock migration has landed, so the path-walk/writer work
that shares its error taxonomy is unblocked:

| Order | Issue                                                                                              | Why now                                 |
| ----- | -------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1     | [#305](https://github.com/yandy-r/rfmedia-apps/issues/305) Plan path walks & atomic writers        | Error taxonomy settled by #304          |
| 2     | [#306](https://github.com/yandy-r/rfmedia-apps/issues/306) Harden published plan artifacts         | Security follow-through on plan publish |
| 3     | [#307](https://github.com/yandy-r/rfmedia-apps/issues/307) `verify --fix` under restrictive umasks | Correctness under real operator umasks  |
| 4     | [#308](https://github.com/yandy-r/rfmedia-apps/issues/308) Lock-specific invalid-owner code        | Clearer failure taxonomy for locks      |

**Exit criteria:** Remaining plan I/O sits on `secure-store`; publish/verify/lock edge cases from
#306–#308 are closed or explicitly deferred.
```

The `### Sprint 2 — secure-store completion` heading at `:56` stays; the sprint does **not** close.

**G5 — Current focus narrative, `:43-46`.** Before:

```text
The #209 policy follow-through sprint is complete: #311–#314 shipped through PRs #315–#318.
Near-term focus is **Sprint 2** (`secure-store` completion #304–#308). rfapps medium UX and broader
rfmedia medium backlog can run in parallel. Larger Lidarr Phase E work waits until Sprint 2 lands
(or ownership differs).
```

After:

```text
The #209 policy follow-through sprint is complete: #311–#314 shipped through PRs #315–#318.
Near-term focus is **Sprint 2** (`secure-store` completion): the Lidarr plan claim lock (#304) now
delegates to `secure-store`, leaving #305–#308. rfapps medium UX and broader rfmedia medium backlog
can run in parallel. Larger Lidarr Phase E work waits until Sprint 2 lands (or ownership differs).
```

**G6 — header counters, `:8` and `:10`.** `:8` becomes the day the commit is authored:

```text
**Last updated:** <YYYY-MM-DD>
```

`:10` — **recompute at apply time**, counting #304 as closed. Do not hardcode; `ROADMAP.md:285`
makes regenerating this part of closing work:

```bash
gh issue list --state open --limit 300 --json number,labels | python3 -c "
import json,sys
d=json.load(sys.stdin)
n=lambda i:[l['name'] for l in i['labels']]
a=sum('rfapps-cli' in n(i) for i in d)
m=sum('rfapps-cli' not in n(i) and 'rfmedia-cli' in n(i) for i in d)
open304 = any(i['number']==304 for i in d)
print(f'**Open issues:** {len(d)-open304} (rfapps {a} · rfmedia {m-open304})')
"
```

The current line reads `**Open issues:** 82 (rfapps 36 · rfmedia 46)`; with #304 closing it should
print `81 (rfapps 36 · rfmedia 45)`. **Write whatever the script prints**, not that literal — issue
churn between now and apply time is expected.

**Normalization:** `cd $W && npx prettier --write ROADMAP.md` after all six edits.

### 15. Gate

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && test "$(grep -c '/issues/304' ROADMAP.md)" = 0 && echo OK_no_304_links
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && grep -qxF '### Medium priority — copy, verify, policy & metadata (9)' ROADMAP.md \
  && test "$(awk '/^### Medium priority — copy, verify, policy & metadata \(9\)$/{f=1;next} f&&/^### /{exit} f&&/^\| \[#/{c++} END{print c+0}' ROADMAP.md)" = 9 \
  && echo OK_medium_count
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && grep -qxF '### Low priority — docs, polish & future ideas (27)' ROADMAP.md && echo OK_low_untouched
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && grep -q '### Sprint 2 — secure-store completion' ROADMAP.md \
  && for n in 305 306 307 308; do grep -q "issues/$n" ROADMAP.md || echo "MISSING $n"; done; echo OK_sprint_intact
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && git diff --exit-code -- docs/roadmap-archive.md && echo OK_archive_untouched
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && npm run format:check && npm run lint:md
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && grep -n '^\*\*Open issues:\*\*' ROADMAP.md   # compare against the G6 script output
```

Expected: `OK_no_304_links`, `OK_medium_count`, `OK_low_untouched`, `OK_sprint_intact` (with no
`MISSING` lines), `OK_archive_untouched`, both lint gates pass, and `:10` matches the script.

`grep -c '/issues/304'` being 0 is the single strongest gate: #304 appears at `:44`, `:63`, `:64`,
`:192` and `:279`, so any omitted edit shows up here. Note `:64`'s "Depends on #304 error taxonomy"
is a bare `#304` with no link — G4 removes it, and a follow-up `grep -c '#304' ROADMAP.md` should
also be `0`.

### 15. Rollback

`git checkout -- ROADMAP.md`. Independently revertible from the source change, but under D3 they
ship in one commit, so a post-merge revert takes both.

---

## Step 16 — Full gate, format, and the single squashed commit

### 16. Full gate — every command this PR must pass

Run in this order, all from absolute paths:

```bash
# 1. Typecheck (pretypecheck runs codegen:lidarr:check + check:architecture + test:architecture)
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && npm run typecheck --workspace packages/rfmedia-cli

# 2. Architecture guards, explicitly (they also run above; run them alone so a failure is legible)
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && npm run check:architecture -w packages/rfmedia-cli \
  && npm run test:architecture -w packages/rfmedia-cli

# 3. Build (prebuild runs codegen:lidarr:check + check:architecture)
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && npm run build -w packages/rfmedia-cli

# 4. Full rfmedia-cli package suite
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx vitest run

# 5. Full monorepo suite (rf-common + rfmedia + rfapps + contracts)
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && npm run test:run

# 6. Formatting and markdown
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && npm run format:check && npm run lint:md

# 7. Scope and frozen-file proof
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && git status --porcelain \
  && sha256sum packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts
```

Expected:

| Gate                            | Expected                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`                     | exit 0, no TS output                                                                                                                          |
| `check:architecture`            | `OK: … production files`                                                                                                                      |
| `test:architecture`             | `# fail 0`                                                                                                                                    |
| `build`                         | exit 0                                                                                                                                        |
| package suite                   | `Test Files 172 passed (172)`, `Tests 4483 passed (4483)` — baseline 4482 **+1**                                                              |
| `npm run test:run`              | all four workspaces green                                                                                                                     |
| `format:check` / `lint:md`      | pass                                                                                                                                          |
| `git status --porcelain`        | exactly the four files listed under "Change shape" (`plan-engine.ts`, `secure-store.test.ts`, `ROADMAP.md`, and the untracked plan directory) |
| `sha256sum plan-engine.test.ts` | `ea0e4a7815a24accfa54b22226e41d1f6d7a462ed3ebfde9be6eb419174beea3`                                                                            |

Then run `graphify update .` from the worktree root per `CLAUDE.md`, and delete the two `/tmp`
probes.

### 16. Commit — one squashed commit (D3)

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock \
  && git add packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts \
             packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts \
             ROADMAP.md docs/plans/issue-304-claim-lock-migration/
```

Subject line (matches sibling migration #288, commit `0640943f`
`chore(rfmedia): migrate duplicate private-file-mode primitives onto secure-store (#309)`):

```text
chore(rfmedia): migrate the Lidarr plan claim lock onto secure-store
```

The body must name as **decisions**, not incidentals: `maxAgeMs: null`, `deadlineEpochMs: nowMs()`,
the retained local `defaultIsProcessAlive`, the two distinct translator arms, the D1
`LIDARR_PLAN_IO` classification and the D2 owner-metadata gate. It must record Blocked-1, Blocked-2
and Blocked-3. Footer: `Closes #304`.

Branch is `chore/304-claim-lock`. Push under `umask 022` with `FORCE_COLOR` unset — the lefthook
pre-push hook runs the suite and a stray `FORCE_COLOR` fails two `rf-common` logger tests and blocks
the push.

### 16. Rollback

The whole PR is one revert unit under D3: `git revert <sha>` restores `plan-engine.ts`,
`secure-store.test.ts` and `ROADMAP.md` together. Re-run Step 1's gate afterwards.

---

## Step 17 — PR body

Use `.github/pull_request_template.md` verbatim as the baseline; preserve `## Summary`,
`## Changes`, `## Testing`, `## Related Issues`, `## Breaking Changes`, `## Risk and Rollback` and
`## Checklist`.

`## Testing` must list the exact Step 16 commands and their pass/fail outcomes.
`## Related Issues` carries `Closes #304`.
`## Risk and Rollback` must state all three blocked behaviours plainly:

| Blocked | Statement for the PR body                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | An incumbent claim file carrying foreign access bits (e.g. `0o644`) is now a hard `LIDARR_PLAN_IO` failure instead of contention or a steal, and — because `maxAgeMs: null` removes the only other steal rule — a permanent wedge. Accepted by owner decision D1; recovery is `chmod 600 <claim>` or deleting the claim file. Untested; no fixture writes `0o644`.                                                                                                                    |
| 2       | Record-validation width changes in both directions: an incumbent with a fifth key or a control character in `host` flips from _corrupt_ to _valid_ (eligible for the same-host-dead-pid steal); an incumbent with `pid <= 0` flips from _valid_ to _corrupt_. Unreachable in production — this module writes exactly four keys with a real hostname and `process.pid`.                                                                                                                |
| 3       | Fail-fast is not absolute. `lock.ts:486-489` sits before the deadline check, so when the incumbent disappears between the failed `link()` and `readExistingLock`, a past deadline is bypassed for up to `LOCK_MAX_IMMEDIATE_RETRIES = 8` attempts and the acquisition usually **succeeds** where the old code threw `LidarrPlanAlreadyRunningError`. Accepted: the window is a genuine TOCTOU race in which the lock really is free, the retry count is bounded, and no sleep occurs. |

Also state the two "not blocked, but new" deltas: the claim directory is now `fsync`ed on publish
(`atomic.ts:177`) and best-effort on release (`lock.ts:317`), and the claim path length bound
tightens by 42 characters because `resolveSecurePath` bounds the **full** path where
`resolveLidarrStoragePath` bounded only the directory.

**CI note.** Both CLI workflows declare `push.branches: [main]` while the default branch is `master`,
so the `pull_request` run is the **only** gate and must be green on the full suite. A PR with merge
conflicts queues no `pull_request` run at all — check `mergeable` before blaming the workflow.

---

## Error-translation reference

Acquisition and release (`translateClaimFailure`):

| From                                                       | To                                                 | Why                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| `LidarrPlan{Validation,Artifact,AlreadyRunning}Error`      | rethrown unchanged                                 | our own injected seams (`randomUUID` wrapper, `resolveLidarrStoragePath`) |
| `SECURE_STORE_LOCK_BUSY`                                   | `LidarrPlanAlreadyRunningError(planId, claimPath)` | contention; pre-migration `:4814`                                         |
| `SECURE_STORE_CORRUPT`                                     | `LidarrPlanAlreadyRunningError`                    | #304's mandated arm; matches `readClaim`'s swallow-to-`undefined`         |
| `SECURE_STORE_UNSAFE_PATH`                                 | `LIDARR_PLAN_UNSAFE_PATH`                          | pre-migration ELOOP arm `:4802`                                           |
| `SECURE_STORE_TOO_LARGE`                                   | `LIDARR_PLAN_TOO_LARGE`                            | `readBoundedFile` threw the same code                                     |
| `SECURE_STORE_PERMISSIONS`                                 | `LIDARR_PLAN_IO`                                   | **D1** — behaviour delta, Blocked-1                                       |
| `SECURE_STORE_VERSION_CONFLICT` / `SECURE_STORE_CANCELLED` | `LIDARR_PLAN_IO` (defensive default)               | both unreachable                                                          |
| raw errno (`ENOSPC`/`EIO`/`EROFS`/`EEXIST`/`ENOENT`)       | `LIDARR_PLAN_IO`                                   | satisfies the "no `SecureStoreError` escapes" rule                        |

`assertOwned` (`translateClaimOwnershipFailure`):

| From                                                                | To                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `LidarrPlan{Validation,Artifact,AlreadyRunning}Error`               | rethrown unchanged                                                                        |
| `SECURE_STORE_UNSAFE_PATH` / `SECURE_STORE_TOO_LARGE`               | delegates to `translateClaimFailure`, stem `Unable to verify Lidarr plan claim ownership` |
| everything else, including raw errno and `SECURE_STORE_PERMISSIONS` | `LidarrPlanAlreadyRunningError` — fail closed                                             |

`release()`: `SECURE_STORE_CORRUPT` **and** `SECURE_STORE_PERMISSIONS` are swallowed and resolve;
everything else goes through `translateClaimFailure` with the stem
`Unable to release Lidarr plan claim`.

---

## Invariants that must hold at every step

1. **`packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` is byte-unmodified.** Measurable form:
   `sha256sum` = `ea0e4a7815a24accfa54b22226e41d1f6d7a462ed3ebfde9be6eb419174beea3`. If it moves, the
   step that moved it is wrong. This is #304's abort criterion, not a preference.
2. **`LidarrPlanClaim` stays exactly `{ path, assertOwned, release }`**, an unfrozen plain object
   literal, and `acquireLidarrPlanClaim(planId, dependencies = {})` keeps its signature and all six
   `LidarrPlanClaimDependencies` seams.
3. **The lock path stays `<claimDirectory>/<planId>.lock`** and the claim directory holds nothing
   else after acquisition (`plan-engine.test.ts:2092` asserts `readdir` equals exactly that).
4. **The on-disk record keeps exactly four keys in the order `host, pid, createdAt, ownershipToken`.**
   Never pass `binding`.
5. **No `AbortSignal` is forwarded into the lock.**
6. **No new tests beyond Step 13's single `it`**, and no test file other than
   `src/lib/secure-store/secure-store.test.ts` is touched. Full-suite total 4482 → **4483**.
7. **No `secure-store` production file is edited.** In particular, do not delete the `randomUUID,`
   forward at `lock.ts:437`.
8. **No `any`**, no `as any`, no non-null assertions. Type-only imports use `import type`
   (`verbatimModuleSyntax`).
9. **`secure-store` is imported only through `./secure-store/index.js`.**
10. **No new CLI surface** — no flag, command, option or exit code; `shell-completions/` and
    `src/mcp/schema.ts` untouched.
11. **Test commands run under `umask 022` with `FORCE_COLOR` unset**, from absolute paths rooted in
    this worktree.

---

## Design gaps found while validating, and how this plan resolves them

| #   | Gap in `design.md`                                                                                                                                                                                          | Resolution here                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The translator **bodies** are only sketched as signatures; the switch shape, the pass-through arm and where D1 lives are left to the implementer.                                                           | Steps 4 and 5 give the full literal bodies, with `SECURE_STORE_PERMISSIONS` written as an explicit empty case label above `default:` so D1 is visible at the switch.                                   |
| 2   | "a future code addition is a compile error at the switch" is not achievable as written — a `default:` arm silently absorbs an eighth code.                                                                  | Stated plainly. The `default:` arm is the design's own "defensive default"; exhaustiveness is not claimed. Do not add a `never` check that would break on a `secure-store` code addition.              |
| 3   | `secure-store.test.ts` is described as "371 lines, 10 `it` blocks". It is 371 lines with **11** `it` blocks (the legacy-`originDigest` steal test landed post-#288-review).                                 | Step 1 pins 11 → 12 and the branch total 4482 → 4483 by direct measurement in this worktree.                                                                                                           |
| 4   | The new test's code is described in prose only.                                                                                                                                                             | Step 13 gives the literal `it` block, its insertion anchor, and a mutation check that proves it can fail.                                                                                              |
| 5   | The D2 gate and the D1 classification have **no** executable verification anywhere — both are untested by design, and no frozen test can move if either is wrong or missing.                                | Steps 6 and 9 each carry a `/tmp` `tsx` probe with the pre-migration output measured and recorded, so the delta is proven rather than asserted. `.mts` is required or `tsx` rejects top-level `await`. |
| 6   | ROADMAP is described as "four coupled places plus two header counters" citing `:44`, `:63-64`, `:179`, `:192`, `:279`.                                                                                      | That is **five** places (`:44`, `:63`+`:64`, `:179`, `:192`, `:279`); `:64` carries a bare unlinked `#304`. Step 15 enumerates G1–G6 bottom-up and gates on `grep -c '#304' ROADMAP.md` = 0.           |
| 7   | The design's commit plan lists **two** commits (code, then docs + ROADMAP).                                                                                                                                 | Superseded by owner decision D3: one squashed commit, `chore(rfmedia): …`, matching #288's `0640943f`.                                                                                                 |
| 8   | Minor citation drift, all informational: `lock.ts:419` → `:419-421`; `readExistingLock` `lock.ts:253-269` → `:252-270`; the claim-region end line `:4818`/`:4820` varies between the design's own sections. | Corrected inline at each point of use. None changes an edit.                                                                                                                                           |
| 9   | Shell completions are dismissed in one clause of constraint C15 with no reproducible command.                                                                                                               | Step 14 gives the exact greps, the exact one-line output, and an explicit "do not touch these four files" determination with a `git diff --exit-code` gate.                                            |
