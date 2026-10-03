# Issue 288 — Migrate duplicate private-file-mode primitives onto src/lib/secure-store

Status: design, ready for implementation.
Branch: `chore/288-secure-store`.
Package under change: `packages/rfmedia-cli`.
Baseline: `origin/master` `b5cc7475` — 169 test files / 4252 tests passing.
Branch total: 169 test files / 4257 tests — `+5`, every one of them a new `it` block in
`src/lib/secure-store/secure-store.test.ts` (four in commit 1, one added by the post-review
legacy-record fix). No test is dropped, renamed or edited.

Every file:line citation below was verified by direct read against this worktree. Where the three
input designs disagreed on a fact, the disagreement is settled inline with the citation.

## Context

PR #251 introduced `packages/rfmedia-cli/src/lib/secure-store/` as the canonical home for hardened
private-file persistence:

- `PRIVATE_DIRECTORY_MODE = 0o700` / `PRIVATE_FILE_MODE = 0o600` (`paths.ts:29`, `paths.ts:32`),
  both already exported and already re-exported through the barrel at `index.ts:32-33`.
- Full path-component safety walks from the filesystem root, rejecting symlinks, foreign owners and
  group/other-writable leaf components (`paths.ts:98-169`).
- `O_NOFOLLOW`-bounded reads with `{dev,ino}` re-assertion (`paths.ts:303-356`).
- Atomic create/replace with a mandatory post-open `handle.chmod` (`atomic.ts:80-105`, `:142-205`).
- A `link()`-based inter-process lock with jittered backoff, deadline and stale steal
  (`lock.ts:264-350`).

It is consumed only by the Plex credential store today, by design. Its own module docblock
(`index.ts:5-11`) names the four sites that "can later be migrated onto it as a delete-and-delegate",
and #288 is that follow-up.

Four pre-existing sites still carry their own copies. Verification found a fifth fact the issue does
not record: there are **six** private-mode expressions in production, not four.

```text
$ grep -rn '0o600\|0o700' packages/rfmedia-cli/src --include='*.ts' \
    | grep -v '\.test\.\|\.spec\.' | grep -v 'secure-store/'
src/lib/conversion-metadata.ts:706          handle = await open(inputPath, "wx+", 0o600);
src/lib/plan.ts:67                          const PRIVATE_DIRECTORY_MODE = 0o700;
src/lib/plan.ts:68                          const PRIVATE_FILE_MODE = 0o600;
src/lib/plan.ts:1134                        (JSDoc prose)
src/lib/plan.ts:1135                        (JSDoc prose)
src/lib/plan.ts:1515                        (JSDoc prose)
src/lib/lidarr/profile-preset-persistence.ts:20   const PRIVATE_DIRECTORY_MODE = 0o700;
src/lib/lidarr/profile-preset-persistence.ts:21   const PRIVATE_FILE_MODE = 0o600;
src/lib/tag-writer/mp3-publisher.ts:384     stageHandle = await open(stagePath, "wx+", 0o600);
src/lib/lidarr/plan-engine.ts:189           const PRIVATE_DIRECTORY_MODE = 0o700;
src/lib/lidarr/plan-engine.ts:190           const PRIVATE_FILE_MODE = 0o600;
src/lib/filesystem.ts:939                   const stagedHandle = await open(stagedPath, "wx+", 0o600);
```

`docs/internal/plex-jwt-deferrals.md:154` says "four places" and characterises `filesystem.ts`'s
literal as an "owner-only file/directory mode". Both statements are wrong and are corrected by this
work.

## Decision summary

The goal of #288 is one implementation of "write a secret safely", not a rename of six integers. The
plan therefore widens `src/lib/secure-store/` once, additively, in a single commit, and then
delete-and-delegates exactly the one site where delegation is provably safe with its protected test
file untouched — `lidarr/profile-preset-persistence.ts`, the module secure-store was modelled on.
That site sheds roughly 250 lines: its safe-parent walk (`:146-273`), both atomic writers
(`:858-947`) and its bespoke `link()` lock (`:745-856`).

The other three sites take their constants and nothing more, and each refusal is backed by a test
that a deeper migration provably breaks rather than by a preference:

- **`lidarr/plan-engine.ts`** cannot delegate its bounded reader. The shared reader gates on
  `(before.mode & FOREIGN_ACCESS_BITS) !== 0` at `paths.ts:330`, _before_ the size check at
  `paths.ts:333`. Three plan-engine tests seed fixtures with a plain `writeFile` — mode `0o644`
  under umask 022 — and then read them: `plan-engine.test.ts:1750` expects `LIDARR_PLAN_TOO_LARGE`,
  `:1691` expects `LIDARR_PLAN_CHECKSUM_MISMATCH`, `:2076` expects `LidarrPlanValidationError`. All
  three would instead get `SECURE_STORE_PERMISSIONS`. Delegating only its _walk_ is no better: three
  callers classify on the raw errno that `prepareSafeParent` currently rethrows unwrapped
  (`plan-engine.ts:3893`, `:3898`), most sharply at `:4436` where `if (hasCode(error, "ENOENT"))
return []` makes a missing history file resolve to an empty array. Eager wrapping would need a
  translator threaded through the whole 4818-line file.
- **`plan.ts`** cannot delegate its writer, because both atomic writers call `prepareSafeParent`
  internally (`atomic.ts:143`, `:184`), and that walk rejects a group-writable leaf.
  `plan.test.ts:397` creates its parent with `mkdir(realDir, { recursive: true })` and **no mode**;
  under umask 002 that is `0o775`, `0o775 & 0o022 === 0o020`, and the write at `:399` would start
  failing. Today it passes under any umask because `ensurePrivateArtifactDirectory` force-chmods to
  `0o700` first (`plan.ts:1089`). Introducing a new umask sensitivity into `plan.test.ts` is exactly
  the class of breakage `scripts/test-run.sh` exists to prevent.
- **`filesystem.ts:939`** must not import `PRIVATE_FILE_MODE` at all: its `0o600` is a transient
  staging floor, not a private-document mode.

Two real defects found on the way are recorded and deliberately **not** bundled, because an
observable change must never ship disguised as a refactor: `plan.ts:1178` chmods the published
artifact _by path_ after the rename (chmod(2) follows symlinks and has no `O_NOFOLLOW` form), and
`filesystem.ts:939` has no post-open chmod so a `0277` umask yields a `0o400` stage.

## Current state

| #   | Site                                                 | What it duplicates                                                                                                                                                                                               | LOC (file) | Verdict        | Risk   |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | ------ |
| 1   | `src/lib/plan.ts:67-68`                              | `PRIVATE_DIRECTORY_MODE` / `PRIVATE_FILE_MODE`, plus `MAX_PATH_LENGTH` (`:66`), a symlink-component walk (`:1034-1065`), a directory hardener (`:1067-1106`) and a staging/publish block (`:1165-1178`)          | 1650       | constants-only | medium |
| 2   | `src/lib/lidarr/plan-engine.ts:189-190`              | The same two constants, plus `MAX_PATH_LENGTH` (`:191`), `UUID_PATTERN` (`:193`), a complete third copy of the safe-path + atomic-write stack (`:3821-3999`) and a `link()` claim lock (`:4652-4818`)            | 4818       | constants-only | low    |
| 3   | `src/lib/filesystem.ts:939`                          | An inline `0o600` literal — **not** a named constant, and not the same concept                                                                                                                                   | 1309       | do-not-migrate | low    |
| 4   | `src/lib/lidarr/profile-preset-persistence.ts:20-21` | The same two constants, `MAX_PATH_LENGTH` (`:22`), `LOCK_MAX_BYTES` (`:23`), `UUID_PATTERN` (`:29`), the safe-parent walk (`:146-273`), both atomic writers (`:858-947`) and a `link()` origin lock (`:745-856`) | 1003       | delegate-full  | high   |

Site 4 is 100% `node:fs/promises` — `grep -c 'Sync(' src/lib/lidarr/profile-preset-persistence.ts`
returns 0 — which is why the shared surface must gain an async bounded reader before it can absorb
this module.

## Shared surface changes

All additions are optional with defaults that leave the Plex credential store — the only consumer
today — byte-identical. Every one is justified by a concrete consumer in this PR, plus (for two of
them) a latent defect already live inside `secure-store` itself.

### 1. `paths.ts` — async bounded private read

```ts
export async function readBoundedPrivateFile(
  filePath: string,
  maximumBytes: number,
  subject: string,
): Promise<BoundedPrivateRead | undefined>;
```

Exact async mirror of `readBoundedPrivateFileSync` (`paths.ts:303-356`), same order:
`resolveSecurePath` → `prepareSafeParent(false)` → `open(O_RDONLY|O_NOFOLLOW)` → `handle.stat` →
`0o077` gate → bounded read at offset 0 → re-stat → `sameIdentity` → `assertOpenedFileIdentity` →
`assertSafeParentUnchanged`. `undefined` on `ENOENT`, matching the sync twin.

**Justification.** There is no async reader today (`paths.ts:303` and its barrel re-export at
`index.ts:34` are the only hits). Site 4 has zero `Sync(` calls, so delegating onto the sync reader
would inject blocking syscalls into the Lidarr apply path. It also fixes a defect already live in
`secure-store`: `lock.ts:166` `readExistingLock` calls the _sync_ reader from inside
`async acquireExclusiveLock`, reached at `:325`, so every contended poll blocks the event loop.
`readExistingLock` becomes `async` and awaits the new reader; both call sites are already in async
context. The sync variant stays exported — `credential-store.ts` needs it for synchronous adapter
construction.

### 2. `paths.ts` / `lock.ts` — export two generic scalars

```ts
// paths.ts
export const SECURE_STORE_MAX_PATH_LENGTH = 4_096; // was private at paths.ts:35
// lock.ts
export const SECURE_STORE_UUID_PATTERN: RegExp; // was private at lock.ts:70
```

**Justification.** `MAX_PATH_LENGTH = 4096` is declared **four** times at identical values —
`paths.ts:35`, `plan.ts:66`, `plan-engine.ts:191`, `profile-preset-persistence.ts:22` — and
`UUID_PATTERN` three times byte-identically (`lock.ts:70`, `plan-engine.ts:193`,
`profile-preset-persistence.ts:29`). Without these exports, a constants-only migration at sites 1
and 2 leaves duplication standing and `ROADMAP.md:58`'s exit criterion stays false. The
`SECURE_STORE_` prefix follows the convention already set by `SECURE_STORE_LOCK_MAX_AGE_MS`
(`lock.ts:47`) for names too generic to sit unqualified on a shared barrel; `PRIVATE_FILE_MODE` and
`PRIVATE_DIRECTORY_MODE` stay unprefixed because they are already distinctive.

Deliberately **not** exported: `FOREIGN_WRITE_BITS` (`paths.ts:38`), `FOREIGN_ACCESS_BITS`
(`paths.ts:41`), `assertSafeDirectory` (`paths.ts:98`) and `LOCK_MAX_BYTES` (`lock.ts:50`). After
site 4 delegates its walk and its lock, nothing in this PR consumes them. The remaining inline
`0o022` masks (`filesystem.ts:913`, `conversion-metadata.ts:690`, `mp3-publisher.ts:95`/`:113`,
`db/reconciliation-database.ts:334`/`:372`) are media/database trust checks with different
semantics; sharing a credential-module constant with them would be false reuse.

### 3. `atomic.ts` — harden `syncDirectory` in place

```ts
export async function syncDirectory(path: string): Promise<void>; // signature unchanged
```

`atomic.ts:71-78` gains, in order: a `process.platform === "win32"` short-circuit; `O_DIRECTORY`
alongside `O_RDONLY|O_NOFOLLOW`; and `rethrowAsSecureStoreError` wrapping.

**Justification.** `plan-engine.ts:3919-3938` is strictly stronger than the shared version on
exactly these axes — win32 guard at `:3921`, `O_DIRECTORY` at `:3926` (without it a regular-file
path is silently fsynced instead of erroring), plus identity re-assertions. Adopting the current
shared form anywhere would be a security downgrade and a Windows regression; `constants.O_DIRECTORY`
is `undefined` on win32, so the platform guard is not optional. `syncDirectory` also lacks error
wrapping today (no `rethrowAsSecureStoreError` in its body), so `credential-store.ts:431`, which
calls it directly, sees raw errnos.

A separate `syncSafeParentDirectory(parent, subject)` is **not** added: no consumer in this PR needs
the `SafeParent`-taking form, and `release()` (below) can fsync `parent.path` through the hardened
`syncDirectory`.

### 4. `lock.ts` — per-call-site staleness policy

```ts
export interface SecureStoreLockOptions {
  // ...existing fields unchanged...
  /**
   * Age after which a lock is stolen on ANY host. `null` disables the age rule
   * entirely. Default `SECURE_STORE_LOCK_MAX_AGE_MS`.
   */
  readonly maxAgeMs?: number | null;
}
```

`isStale` (`lock.ts:235-243`) skips the age branch when `maxAgeMs === null`.

**Justification, and an honest correction.** `lock.ts:242` reads
`return nowEpochMs - Date.parse(record.createdAt) > SECURE_STORE_LOCK_MAX_AGE_MS;` — no host guard,
no liveness guard — and `SecureStoreLock` (`lock.ts:85-92`) has no `renew()`, so `createdAt` never
advances. A Lidarr preset apply drives per-entry network mutations with `assertOwned()` between each
and routinely exceeds two minutes, so a healthy in-flight run would have its lock stolen cross-host
after 120 s and then fail its next `assertOwned()` mid-flight. That contradicts a shipped guarantee
at `packages/rfmedia-cli/docs/features/lidarr-quality-presets.md:281-282`: "A live owner is never
forcibly replaced. Recovery removes a stale lock only when the recorded owner is on the same host
and its process is demonstrably dead."

Two of the three input designs claimed this option is _test-mandatory_. It is not, and the claim is
withdrawn. `profile-preset-persistence.test.ts:88` freezes `now: () => new Date(
"2026-07-25T12:00:00.000Z")`, and that same clock stamps `createdAt`, so the age is 0 in every
preset test — including `:155-168` ("never recovers a dead owner recorded on another host"), which
passes with or without the option. `plan-engine.test.ts:2159-2188` _is_ an unconditional
counterexample (createdAt `10:00` vs injected now `12:00` = 7,200,000 ms > 120,000 ms), but this PR
does not migrate the plan-engine claim, so that test never reaches the shared `isStale`.
`maxAgeMs: null` is adopted on **production correctness and documented-guarantee grounds only**, and
is pinned by a new test rather than an existing one.

### 5. `lock.ts` — caller-supplied binding

```ts
export interface SecureStoreLockRecord {
  readonly host: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly ownershipToken: string;
  /** Opaque caller-supplied binding, re-asserted on read. */
  readonly binding?: string;
}
// SecureStoreLockOptions gains: readonly binding?: string;
// SecureStoreLock gains:        readonly binding?: string;
```

`parseLockRecord` (`lock.ts:143-163`) returns `undefined` when a `binding` was supplied and
`record.binding !== options.binding`; `readExistingLock` then throws `SECURE_STORE_CORRUPT` exactly
as it already does for any unparseable record (`lock.ts:172`/`:176`).

**Legacy acceptance (amended).** A record that carries no `binding` key but whose `originDigest`
equals the expected binding satisfies the expectation and parses normally, with `binding` left
absent on the returned record. This is the shape the shipped `profile-preset-persistence.ts` writes.
Without it, a pre-#288 lock file classifies as corrupt **before** `isStale()` is consulted, so the
same-host-dead-pid steal is unreachable; combined with `maxAgeMs: null` (which removes the only
other steal rule) a lock stranded by the shipped build would never self-heal after upgrade. The
legacy shape can only ever _satisfy_ an expectation, never relax one: a record carrying a `binding`
that differs is still rejected regardless of its `originDigest`.

**Justification.** The record is exactly four fields (`lock.ts:73-82`) and `parseLockRecord` picks
those four and silently drops extras. `profile-preset-persistence.ts:768` writes an `originDigest`
into its record and `:683-698` requires `value["originDigest"] === expectedDigest`, so a lock file
relocated from another origin's path is detected as foreign. That check cannot be expressed today.
The on-disk key name may change from `originDigest` to `binding` because
`profile-preset-persistence.test.ts:109` reads `originDigest` off the **lock object**, not the file,
and its rewrite at `:184-186` spreads the parsed JSON key-agnostically. The outcome of a mismatch is
unchanged: today a bad digest makes `readLock` return `undefined`, which yields `not stale` and
therefore `LIDARR_PRESET_ALREADY_RUNNING`; after migration `SECURE_STORE_CORRUPT` maps to the same
code.

### 6. `lock.ts` — `assertOwned()` and a release latch

```ts
export interface SecureStoreLock {
  readonly path: string;
  readonly ownershipToken: string;
  readonly binding?: string;
  /** Throws `SECURE_STORE_LOCK_BUSY` when the record no longer matches. */
  assertOwned(): Promise<void>;
  /** Idempotent; a second call is a no-op. */
  release(): Promise<void>;
}
```

`assertOwned()` re-reads the record and proves `ownershipToken` + `host` + `pid` + `createdAt` +
`binding` + `{dev,ino}` all still match, and fails once `release()` has run. `release()` sets the
latch and now also fsyncs `parent.path` through the hardened `syncDirectory`.

**Justification.** `SecureStoreLock` is exactly `{ path, ownershipToken, release }` today.
`profile-preset-persistence.ts:806-810` exposes `assertOwned` as public API and
`profile-preset-persistence.test.ts:151` and `:188` assert on it directly. The helpers needed to
rebuild it externally (`readExistingLock` `lock.ts:165`, `unlinkLockIfOwned` `lock.ts:181`) are
module-private. The full-field comparison — rather than `unlinkLockIfOwned`'s token+inode pair
(`lock.ts:189-195`) — preserves the `host`/`pid`/`createdAt` axes pinned at
`profile-preset-persistence.ts:721-724`. The release fsync preserves
`profile-preset-persistence.ts:738`, which secure-store's release does not do today; without it,
migration would be a durability regression.

One correction to the record: the "~58 `assertOwned` references across 13 files" figure quoted in
two input designs is wrong, and it was wrong in a load-bearing way.
`grep -rn assertOwned src/actions/lidarr/` returns **68 references across 15 files**, and essentially
all of them are `plan-engine`'s **claim** `assertOwned` threaded as `args.assertOwned` /
`claim.assertOwned`. The **preset** lock's `assertOwned` has only four references:
`src/actions/lidarr/profile-presets.ts:620`, `:637`, `:680` and its test. The large fan-out is a
reason to defer the plan-engine claim; it is not evidence for this surface change. The four preset
references are.

### 7. `index.ts` — barrel completeness

```ts
export { removeOrphanedTemporaryFiles } from "./atomic.js";
export type { OrphanedTemporarySweepInput } from "./atomic.js";
```

Plus every symbol added above, and the module docblock at `index.ts:5-11` retargeted at what
actually remains duplicated after this PR.

**Justification.** `removeOrphanedTemporaryFiles` (`atomic.ts:236`) and
`OrphanedTemporarySweepInput` (`atomic.ts:206`) are exported from `atomic.ts` but absent from
`index.ts:39-44`, which is why `src/lib/adapters/plex/enrollment.ts:32` deep-imports
`../../secure-store/atomic.js` — the only barrel violation in the repo. Closing the gap lets
`enrollment.ts:32` move to the barrel and stops new consumers copying the pattern. Leaving the
docblock's stale "these four can later be migrated" text in the canonical module's own header is how
the next agent re-litigates decisions this PR settles with evidence.

### Deliberately not added

`classifySecureStoreFailure(error): SecureStoreFailure`. The _insight_ behind it is load-bearing and
is adopted as a rule below — `rethrowAsSecureStoreError` (`errors.ts:194-202`) maps only
`ELOOP`/`ENOTDIR` → `UNSAFE_PATH` and `EACCES`/`EPERM` → `PERMISSIONS` and rethrows everything else
unchanged, so `ENOSPC`/`EIO`/`EROFS` escape raw, and `src/commands/lidarr.ts:258-281` reads `.code`
_structurally_ off any object and forwards it into the machine JSON/CSV envelope at `:347`. An
escaping `ENOSPC` would silently replace `LIDARR_PRESET_IO` in user-visible output and TypeScript
cannot catch it. But exactly one site in this PR needs a translator, and a shared classifier for one
consumer is speculative surface. The rule is stated instead, and enforced locally: **every site
translator must have an explicit non-`SecureStoreError` arm mapping to its own `*_IO` code.**

`prepareSafeDirectory` is also not added: only `plan.ts` needed it, and `plan.ts` is constants-only.

## Per-site migration

### Site 1 — `src/lib/plan.ts` (constants-only)

**Verdict:** constants-only.

**Exact edits.** Delete `plan.ts:66-68` (`MAX_PATH_LENGTH`, `PRIVATE_DIRECTORY_MODE`,
`PRIVATE_FILE_MODE`). Add `import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE,
SECURE_STORE_MAX_PATH_LENGTH } from "./secure-store/index.js";` and update the single
`MAX_PATH_LENGTH` reference at `plan.ts:1021`. The six mode use sites — `:1071`, `:1089`, `:1171`,
`:1178`, `:1528`, `:1530` — are textually unchanged.

Explicitly **do not touch** `validateArtifactPath` (`:1018-1032`), `assertNoSymlinkComponents`
(`:1034-1065`), `ensurePrivateArtifactDirectory` (`:1067-1106`), `writePlanArtifact`'s
staging/publish block (`:1165-1178`), the serializer at `:1156`, `readRawPlanArtifact`, or
`appendPlanAudit` (`:1520-1541`).

**Why nothing deeper.**

- Delegating the writer unavoidably delegates the walk (`atomic.ts:143` and `:184` both call
  `prepareSafeParent`), and the walk rejects a group-writable leaf. `plan.test.ts:396-399` creates
  its parent with no mode; under umask 002 that is `0o775` and the test starts failing. CI would not
  catch it — `.github/workflows/rfmedia-cli.yml:56` runs `npm run test:coverage --workspace
packages/rfmedia-cli`, which is a bare `vitest run` (`packages/rfmedia-cli/package.json:19`) under
  the ambient umask; only the root `npm run test:run` normalizes it (`scripts/test-run.sh`).
- `validateArtifactPath` cannot be replaced by `resolveSecurePath`. `plan.ts:1023` rejects
  `inputPath.split(/[\\/]/u).includes("..")` **before** `resolve()`; `resolveSecurePath`
  (`paths.ts:87-96`) checks only length and terminal-control characters and then calls `resolve()`,
  which normalizes `..` away. `plan.test.ts:417-425` pins `..` rejection on **both** the read and
  the write path.
- `ensurePrivateArtifactDirectory`'s unconditional `directoryHandle.chmod(PRIVATE_DIRECTORY_MODE)`
  at `:1089` is what makes `plan.test.ts:312` and `:805` (`dirStat.mode & 0o777 === 0o700`) true.
  The shared walk only proves "not group/other-writable"; it never tightens (`paths.ts:11-13`
  forbids silent repair). Delegating would leave a pre-existing `0o755` plan directory at `0o755`.
- `appendPlanAudit` is structurally un-migratable: it opens with
  `O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW` at `:1525-1528`, and `grep -rn O_APPEND src/lib/secure-store`
  returns nothing — `atomic.ts:90` opens only `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` and
  `AtomicWriteInput.text` is the whole payload.
- `writePlanArtifact`'s `PLAN_EXISTS` / `overwrite` contract straddles both writers and would need
  `inspectExistingArtifact` (`:1108-1130`) to start returning a `FileIdentity`, plus a
  `rename` → `link` switch that adds a hardlink-support requirement to an operator-relocatable
  `RFMEDIA_PLAN_DIR`.

**Observable deltas.** None. Value-identical substitution of three module-private constants.

**Tests touched.** None. `plan.test.ts` (40 `it` blocks) and `src/lib/__snapshots__/plan.test.ts.snap`
pass byte-identical. The snapshot is far less fragile than the issue implies: `plan.test.ts:321-326`
does `writePlanArtifact` → `readFile` → `toMatchSnapshot`, so it captures only
`JSON.stringify(canonical, null, 2) + "\n"` from `plan.ts:1156` and is blind to modes, staging
names, fsync and error shapes. The genuinely fragile assertions are elsewhere — `:315` (`readdir`
equals exactly `["plan-roundtrip.json"]`), `:417-425`, and `:768-796` (`logWarn` exactly once
matching both `/audit ledger/` and `/EACCES/`) — and a constants-only change approaches none of them.

### Site 2 — `src/lib/lidarr/plan-engine.ts` (constants-only)

**Verdict:** constants-only.

**Exact edits.** Delete `plan-engine.ts:189-191` and `:193` (`PRIVATE_DIRECTORY_MODE`,
`PRIVATE_FILE_MODE`, `MAX_PATH_LENGTH`, `UUID_PATTERN`). Import the four from
`../secure-store/index.js`, aliasing `SECURE_STORE_MAX_PATH_LENGTH` and `SECURE_STORE_UUID_PATTERN`
at the import site. Leave `CLAIM_MAX_BYTES` (`:192`) and `CHECKSUM_PATTERN` (`:194`) alone. The
single `MAX_PATH_LENGTH` reference is at **`plan-engine.ts:3846`** — one input design instructed
editing `:194`, which is `CHECKSUM_PATTERN`; that instruction is wrong and is dropped. The five mode
use sites — `:3895` mkdir, `:3904` chmod, `:4036`/`:4392`/`:4763` staging opens — are textually
unchanged.

Explicitly **do not touch** `prepareSafeParent` (`:3880-3909`), `syncSafeParentDirectory`
(`:3919-3938`), `readBoundedFile` (`:3948-3984`), `writeLidarrPlanArtifact`,
`appendLidarrPlanHistory`, or `acquireLidarrPlanClaim` (`:4652-4818`).

**Why nothing deeper.** Four independent blockers, each verified:

1. **Reader.** The shared reader's `0o077` gate at `paths.ts:330` fires before the size check at
   `:333`, breaking `plan-engine.test.ts:1750`, `:1691` and `:2076`, all of which read fixtures
   written by a plain `writeFile`. This was the single fatal flaw in the highest-scoring input
   design.
2. **Reader, second axis.** `readLidarrPlanHistory` destructures
   `({ text } = await readBoundedFile(path, ...))` at `plan-engine.ts:4434`. The shared async reader
   returns `undefined` for a missing file, so the destructure would throw a `TypeError`, the
   `ENOENT → []` guard at **`:4436`** would never fire, and a missing history file would become
   `LIDARR_PLAN_IO` instead of `[]`. (Two input designs cited `:4429` for this guard; `:4429` is
   `throw validationError("invalid plan identity for history lookup");`.)
3. **Walk.** `prepareSafeParent` rethrows non-`ENOENT` errno raw at `:3893` and `:3898`, and three
   callers classify on it — `:4098-4106`, `:4409` and `:4436-4440`. Eager wrapping needs a
   translator at every one of them.
4. **`syncDirectory`.** Swapping `syncSafeParentDirectory` (`:3919-3938`) for the shared version
   would be a downgrade, which is why the shared version is hardened in commit 1 instead.

The claim lock (`:4652-4818`) is deferred for its own reasons: `plan-engine.test.ts:2139-2157`
requires a corrupt partial claim to yield `LidarrPlanAlreadyRunningError` **and** be left
byte-identical, where `secure-store` throws `SECURE_STORE_CORRUPT`; `plan-engine.test.ts:2159-2188`
inverts under the shared age rule; and `claim.assertOwned` is threaded through 68 references across
15 files.

**Observable deltas.** None.

**Tests touched.** None. `plan-engine.test.ts` passes unmodified; `:1658` and `:1794` already assert
the `0o600` outcomes the substituted constants produce.

### Site 3 — `src/lib/filesystem.ts:939` (do-not-migrate)

**Verdict:** do-not-migrate. Name the literal locally; do **not** import `PRIVATE_FILE_MODE`.

**Exact edits.** Add, beside the existing module constants near `filesystem.ts:41-44`:

```ts
/**
 * Mode the replacement stage is CREATED with, so a half-built artifact is
 * unobservable to other users. This is a transient window, not a published
 * mode — see `publishMode` / `preserveDestinationMode` and the relaxing
 * `chmod` at the last pre-rename point. Deliberately NOT secure-store's
 * PRIVATE_FILE_MODE, which names a permanent property of a credential
 * document.
 */
const STAGE_PRIVATE_MODE = 0o600;
```

Use it at `filesystem.ts:939`. Change nothing else — not the `0o022` gate at `:913`, not
`resolvePublishMode`, not the `chmod` at `:1022`, and add no post-open chmod.

**Why not migrate.** Verified end to end:

- `resolvePublishMode` (`:849-873`) computes the published mode **before** staging;
  `readDestinationSnapshot` captures the destination's `mode & 0o777` at `:831`; and
  `stagedHandle.chmod(publishMode)` at `:1022` — confirmed by grep to be the **only** `chmod` in the
  1309-line file — _relaxes_ the stage at the last pre-rename point.
- `convert.ts:710-713` passes `preserveDestinationMode: true` with
  `missingDestinationMode: 0o666 & ~process.umask()`, so every conversion publishes at ~`0o644`.
  `filesystem.test.ts:192` asserts the destination lands at `0o640` and the `it.each` at `:200-212`
  asserts a computed `0o640`/`0o604`. Neither is `0o600`.
- Importing `PRIVATE_FILE_MODE` would encode a false invariant and invite a later "consistency" pass
  to add a mandatory `chmod(PRIVATE_FILE_MODE)` that breaks `convert.ts` and three tests.
- Adopting `prepareSafeParent` here would be a regression, not a gain: `filesystem.ts:899-917` does
  `realpath(dirname)` + one `stat` + `& 0o022`, with no uid check and no symlink rejection —
  `realpath` _resolves_ symlinked parents. `secure-store` rejects symlink components (`paths.ts:104`)
  and rejects a leaf not owned by the current uid (`paths.ts:108-111`), which would refuse to write
  into ordinary media libraries under root-owned `/mnt` or `/srv` ancestors.
  `filesystem.test.ts:616-647` stages _through_ a symlinked parent (`symlink(originalParent,
linkedParent, "dir")`, `materialize` and `validate` both run) and fails only at commit with
  `/parent changed/i`; `prepareSafeParent` would reject before `materialize`.
- The shared writers cannot express this contract at all. `AtomicWriteInput` carries `text: string`
  and owns the transaction (`atomic.ts:37-48`), while `replaceFileWithValidatedStage` inverts
  control, handing the open `FileHandle` to `options.materialize(stagedPath, signal, stagedHandle)`
  at `filesystem.ts:944` and to `options.validate` at `:958`, and threads an `AbortSignal`
  throughout.

**Observable deltas.** Zero — a literal becomes a named constant at the same value.

**Tests touched.** None. `filesystem.test.ts` (52 `it` blocks) passes unmodified: `:100`
(`mode & 0o077 === 0`), `:105`/`:185`/`:231` (stage exactly `0o600`), `:111` (destination `0o600` on
the non-converting path), `:192` (`mode & 0o7777 === 0o640`), `:236` (computed `0o640`/`0o604`),
`:284` (`/group- or world-writable/i` from the plain `Error` at `:913-916`), `:335`/`:368`
(`0o640` as the tripwire proving the `:1022` chmod landed).

### Site 4 — `src/lib/lidarr/profile-preset-persistence.ts` (delegate-full)

**Verdict:** delegate-full — constants, path layer, bounded reader, both atomic writers, and the
origin lock.

**Exact edits.**

| Delete                                                                    | Replace with                                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `:20-22` `PRIVATE_DIRECTORY_MODE`, `PRIVATE_FILE_MODE`, `MAX_PATH_LENGTH` | imports from `../secure-store/index.js`                                    |
| `:23` `LOCK_MAX_BYTES`, `:29` `UUID_PATTERN`                              | `SECURE_STORE_UUID_PATTERN`; the byte ceiling moves inside the shared lock |
| `:146-171` `assertSafeDirectory`                                          | (subsumed)                                                                 |
| `:173-201` `prepareSafeParent`                                            | `prepareSafeParent(path, createMissing, subject)`                          |
| `:203-213` `assertSafeParentUnchanged`                                    | shared equivalent                                                          |
| `:215-225` `assertOpenedFileIdentity`                                     | shared equivalent                                                          |
| `:227-234` `syncDirectory`, `:236-240` `removeIfPresent`                  | shared `syncDirectory`; removal is internal to the writers                 |
| `:242-272` `readBoundedFile`                                              | `readBoundedPrivateFile`                                                   |
| `:858-902` `createAtomicFile`                                             | `createPrivateFileAtomically`                                              |
| `:904-947` `replaceAtomicFile`                                            | `replacePrivateFileAtomically`                                             |
| `:745-856` `acquireLidarrPresetApplyLock` body                            | a ~60-line wrapper over `acquireExclusiveLock`                             |

Keep, unchanged: `resolveStoragePath` as the outer façade, `canonicalizeOrigin`, `originDigest`, the
module-level `ownedLocks` WeakMap (`:742`) that `createLidarrPresetApplyJournal` requires
(`:954-957`), the exported `LidarrPresetApplyLock` shape `{ path, originDigest, assertOwned,
release }`, every journal schema validator, and every `LidarrPresetPersistenceErrorCode`. The
exported signature does not change: `src/actions/lidarr/profile-presets.ts:590-592` stays a
single-argument call.

**Lock wrapper options — all explicit, none defaulted:**

```ts
const nowMs = dependencies.now ? () => dependencies.now!().getTime() : Date.now;

await acquireExclusiveLock(lockPath, {
  subject: "Lidarr preset apply lock",
  deadlineEpochMs: nowMs(), // fail fast: zero wait. See "Lock semantics".
  maxAgeMs: null, // no age-based steal. See "Lock semantics".
  binding: digest, // replaces the bespoke originDigest record key
  now: nowMs,
  hostname: dependencies.hostname,
  pid: dependencies.pid,
  isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive,
  randomUUID: dependencies.randomUUID,
});
```

`isProcessAlive` deliberately passes the module's own `defaultIsProcessAlive` (`:302-309`,
`!hasCode(error, "ESRCH")` — an unknown errno means **alive**) rather than inheriting
`isProcessAliveByDefault` (`lock.ts:130-137`, only `EPERM` means alive). The two defaults are
steal-permissive in opposite directions for errnos that are neither `EPERM` nor `ESRCH`; migrating a
lock must not silently migrate its liveness policy.

**Error translation — two tables, not one.** This is the correction of the fatal flaw that sank the
highest-scoring input design, which routed everything through a single acquisition table and
therefore turned `profile-preset-persistence.test.ts:188` red.

Acquisition (`acquireLidarrPresetApplyLock`):

| From                                                   | To                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `SECURE_STORE_LOCK_BUSY`                               | `LIDARR_PRESET_ALREADY_RUNNING`                                                                                               |
| `SECURE_STORE_CORRUPT`                                 | `LIDARR_PRESET_ALREADY_RUNNING` (matches today's swallow-to-`undefined` → not-stale → `ALREADY_RUNNING` at `:708-711`/`:841`) |
| `SECURE_STORE_UNSAFE_PATH`, `SECURE_STORE_PERMISSIONS` | `LIDARR_PRESET_UNSAFE_PATH`                                                                                                   |
| `SECURE_STORE_CANCELLED`                               | `LIDARR_PRESET_IO` (unreachable: no signal is passed)                                                                         |
| anything else (raw errno)                              | `LIDARR_PRESET_IO`                                                                                                            |

`assertOwned()` — its **own** arm, not the table above:

| From                                                                          | To                        |
| ----------------------------------------------------------------------------- | ------------------------- |
| any failure of the shared `assertOwned()`, including `SECURE_STORE_LOCK_BUSY` | `LIDARR_PRESET_LOCK_LOST` |

Document I/O (`readBoundedPrivateFile`, `createPrivateFileAtomically`,
`replacePrivateFileAtomically`):

| From                                                   | To                                |
| ------------------------------------------------------ | --------------------------------- |
| `SECURE_STORE_UNSAFE_PATH`, `SECURE_STORE_PERMISSIONS` | `LIDARR_PRESET_UNSAFE_PATH`       |
| `SECURE_STORE_TOO_LARGE`                               | `LIDARR_PRESET_JOURNAL_TOO_LARGE` |
| `SECURE_STORE_VERSION_CONFLICT`                        | `LIDARR_PRESET_JOURNAL_EXISTS`    |
| `SECURE_STORE_CORRUPT`                                 | `LIDARR_PRESET_JOURNAL_INVALID`   |
| anything else (raw errno)                              | `LIDARR_PRESET_IO`                |

**Observable deltas.** See the consolidated table below. The two that matter most:

- Fail-fast is preserved exactly. With `deadlineEpochMs = nowMs()`, a contended acquire reaches
  `lock.ts:335-344` with `retryImmediately === false` (the record is readable and not stale), so
  `remainingMs = deadlineEpochMs - now() === 0` and `SECURE_STORE_LOCK_BUSY` throws on the first
  pass with no sleep.
- The issue's "mode-mask semantics" risk does **not** bite here. The mandatory post-open
  `handle.chmod(PRIVATE_FILE_MODE)` is already present at all three write sites (`:781`, `:872`,
  `:919`), byte-identical to `atomic.ts:93-95`. The four mode assertions at
  `profile-preset-persistence.test.ts:126-129` are umask-proof today and stay umask-proof.

**Tests touched.** None. `profile-preset-persistence.test.ts` (9 tests) must pass byte-identical —
this is the issue's own abort criterion. All nine traced:

| Test       | Assertion                                                                                            | Why it holds                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `:105-107` | immediate `LIDARR_PRESET_ALREADY_RUNNING`                                                            | `deadlineEpochMs = nowMs()` → `remainingMs === 0` → `LOCK_BUSY` on the first pass                   |
| `:109`     | `first.originDigest`                                                                                 | stays on the returned wrapper object                                                                |
| `:110-111` | double `release()` is a no-op                                                                        | shared `release()` gains a `released` latch                                                         |
| `:126-129` | four `0o700`/`0o600` mode assertions                                                                 | `paths.ts:150`/`:161` mkdir+chmod, `atomic.ts:91`/`:95` open+handle.chmod                           |
| `:142-144` | immediate `instanceof LidarrPresetPersistenceError`                                                  | acquisition translator throws the site's own class                                                  |
| `:151`     | `recovered.assertOwned()` resolves                                                                   | same-host dead-owner steal, then `retryImmediately` at `lock.ts:339`                                |
| `:155-168` | never recovers a foreign-host dead owner                                                             | host guard at `lock.ts:241` fails; age is 0 under the frozen clock and disabled by `maxAgeMs: null` |
| `:170-181` | symlinked `locks` dir → `LIDARR_PRESET_UNSAFE_PATH`                                                  | `paths.ts:104` → acquisition translator                                                             |
| `:182-190` | pid-99 same-token new-inode displacement → `LIDARR_PRESET_LOCK_LOST`; `release()` must not unlink it | `assertOwned()`'s own arm; `unlinkLockIfOwned` returns false on the inode axis                      |
| `:214`     | replace produces a **new** inode                                                                     | `replacePrivateFileAtomically` stages then renames                                                  |
| `:246-303` | journal validation codes                                                                             | validators are untouched                                                                            |
| `:326-334` | journal path swap → `UNSAFE_PATH`, no stranded `.tmp`                                                | `assertOpenedFileIdentity` + `atomic.ts`'s `finally`-based removal                                  |

`src/actions/lidarr/profile-presets.test.ts:458` (`toHaveBeenCalledWith(
"https://lidarr.example.test")`, an exact single-argument assertion) is likewise untouched, because
the exported signature does not change.

**Abort criterion, mechanically checkable.** `grep -c 'message'
src/lib/lidarr/profile-preset-persistence.test.ts` must stay **0** and `grep -c 'code:'` must stay
**10**. If the file needs any edit, this commit is dropped from the PR and refiled; the rest stands.

## Behaviour deltas

| #   | Where                          | Change                                                                                                      | Fix or regression risk?                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `secure-store/lock.ts:166`     | Contended lock polling stops blocking the event loop (sync reader called from `async acquireExclusiveLock`) | **Fix.** Latent defect inside secure-store. No test observes it.                                                                                                                                                                                                                                                |
| 2   | `secure-store/atomic.ts:71-78` | `syncDirectory` becomes a win32 no-op and rejects a non-directory path (`O_DIRECTORY`)                      | **Fix.** `secure-store.test.ts` exercises it only through a real directory.                                                                                                                                                                                                                                     |
| 3   | `secure-store/atomic.ts:71-78` | `syncDirectory` now wraps errors via `rethrowAsSecureStoreError`                                            | **Fix.** `credential-store.ts:431` sees raw errnos today.                                                                                                                                                                                                                                                       |
| 4   | `secure-store/lock.ts:181-202` | `release()` becomes idempotent and now fsyncs the parent directory                                          | **Fix.** Also required so site 4 does not lose `:738`'s fsync.                                                                                                                                                                                                                                                  |
| 5   | `secure-store/lock.ts:85-92`   | `assertOwned()` added; fails after `release()`                                                              | **Fix.** New capability; no existing consumer.                                                                                                                                                                                                                                                                  |
| 6   | Preset lock record on disk     | Fifth key renamed `originDigest` → `binding`, with the legacy key still accepted on read                    | **Neutral.** Nothing reads the file directly; the test reads the lock object. A pre-#288 record whose `originDigest` matches the expected binding still parses, so the same-host-dead-pid steal continues to clear a stranded lock and the recovery contract in `lidarr-quality-presets.md:281-282` stays true. |
| 7   | Preset lock corrupt record     | `SECURE_STORE_CORRUPT` → `LIDARR_PRESET_ALREADY_RUNNING`                                                    | **Neutral.** Same user-visible code as today's swallow path. No test covers it.                                                                                                                                                                                                                                 |
| 8   | Preset journal/lock reads      | New `mode & 0o077` rejection (`paths.ts:330`)                                                               | **Fix, with a caveat.** An operator-chmod'd `0o640` journal now fails closed. Everything the code writes is `0o600`; the test's fixtures use explicit `{ mode: 0o600 }`.                                                                                                                                        |
| 9   | Preset lock staleness          | Age-based cross-host steal explicitly disabled (`maxAgeMs: null`)                                           | **Regression avoided.** Adopting the default would steal a healthy >120 s apply's lock cross-host and contradict `lidarr-quality-presets.md:281-282`.                                                                                                                                                           |
| 10  | Preset lock contention         | Still fails fast; still `LIDARR_PRESET_ALREADY_RUNNING`                                                     | **No change**, by explicit deadline choice.                                                                                                                                                                                                                                                                     |
| 11  | Preset writers                 | Stage cleanup moves from a `catch` to a `finally` (`atomic.ts:161`/`:198`)                                  | **Fix.** Strictly stronger; pinned by `:331-333`.                                                                                                                                                                                                                                                               |
| 12  | Preset errors                  | Raw `ENOSPC`/`EIO`/`EROFS` now map to `LIDARR_PRESET_IO` instead of escaping                                | **Fix.** Prevents a raw errno replacing `LIDARR_PRESET_IO` in the machine envelope at `commands/lidarr.ts:347`.                                                                                                                                                                                                 |
| 13  | `enrollment.ts:32`             | Deep import → barrel import                                                                                 | **Fix.** Removes the only barrel violation.                                                                                                                                                                                                                                                                     |
| 14  | Sites 1, 2                     | Constant identifiers now imported                                                                           | **None.** Value-identical.                                                                                                                                                                                                                                                                                      |
| 15  | Sites 3, 5, 6                  | Inline literals become named local constants                                                                | **None.** Value-identical, same call sites.                                                                                                                                                                                                                                                                     |

No delta is user-visible on the Plex credential path, on plan artifacts, on Lidarr plan artifacts,
or on media conversion.

## Lock semantics

Only one call site adopts the shared lock in this PR: `acquireLidarrPresetApplyLock`. The
plan-engine claim keeps its own implementation and therefore contributes no deadline decision.

### Today

`profile-preset-persistence.ts:745-856`, verified by direct read:

- No backoff. `grep -c 'setTimeout\|sleep\|delay'` on the file returns 0; the only loop is
  `for (let attempt = 0; attempt < 2; attempt += 1)` at `:771` with no sleep and no clock
  comparison.
- No deadline. `dependencies.now` (`:66`) is used exactly once, at `:758`, to stamp `createdAt`, and
  is never compared to a clock.
- No `AbortSignal`. The type is never imported.
- Contention throws **immediately**: `LidarrPresetPersistenceError`, code
  `LIDARR_PRESET_ALREADY_RUNNING`, message "Another preset apply owns this Lidarr origin"
  (`:841-847`, `:851-855`).
- Stale steal is **same-host AND dead-pid only** (`:837-840`). There is no age rule anywhere in the
  module.
- Ownership proof is token + host + pid + createdAt + `{dev,ino}` (`:715-727`), plus an
  `originDigest` cross-check inside `parseLockRecord` (`:683-698`).

### The shared lock

`acquireExclusiveLock` (`lock.ts:264-350`) waits with jittered backoff
(`min(50 * 2^n + rand(0,50), 2000) ms`, `lock.ts:52-63`) until `deadlineEpochMs`, then throws
`SECURE_STORE_LOCK_BUSY`. It steals **exactly once** per acquisition when the owner is a dead pid on
this host **or** when `nowEpochMs - Date.parse(record.createdAt) > SECURE_STORE_LOCK_MAX_AGE_MS`
regardless of host and regardless of liveness (`lock.ts:241-242`). There is no `renew()`, so
`createdAt` never advances.

### The two explicit choices, and why

| Option            | Value                          | Why this value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deadlineEpochMs` | `nowMs()` — i.e. **zero wait** | Three reasons. (a) It reproduces today's semantics exactly, which is what keeps `profile-preset-persistence.test.ts:105-107` and `:142-144` green without editing them. (b) The sole production caller, `src/actions/lidarr/profile-presets.ts:590-592`, acquires the lock **before** its `AbortController` (`:593`), its signal forwarders (`:595-600`) and its `registerGlobalCleanup` (`:607-616`, whose name derives from `lock.originDigest` at `:602`) exist — so a waiting acquisition would be uninterruptible by Ctrl-C. (c) `src/commands/lidarr-presets.ts` prints one dim "Preparing complete Lidarr preset review…" line and then goes silent, and emits nothing at all under `--output json\|csv`, so a wait would be indistinguishable from a hang. Introducing a real wait is a UX change that requires moving the acquisition after the controller; it belongs in its own issue. |
| `maxAgeMs`        | `null` — age rule **disabled** | A preset apply drives per-entry network mutations with `assertOwned()` between each and routinely exceeds two minutes. With the default, a second process arriving at 121 s would steal a _live_ owner's lock, and the owner's next `assertOwned()` would fail mid-flight, leaving Lidarr half-mutated. `lidarr-quality-presets.md:281-282` ships the opposite as a guarantee. No existing test forces this choice — the preset suite freezes its clock so the age is always 0 — so it is pinned by a new test instead (see Test strategy).                                                                                                                                                                                                                                                                                                                                                       |

Neither value is exposed as a CLI flag. A new option long would force simultaneous edits to
`shell-completions/bash.ts`, `zsh.ts` and `fish.ts` plus the order-sensitive
`lidarr_preset_apply_opts` literal in `templates.spec.ts`, and would break
`profile-presets.test.ts:458`'s exact single-argument assertion. They are module-level decisions with
the comments above attached at the call site.

### What a user sees on contention

Unchanged. A second `rfmedia lidarr presets apply` against the same canonical origin fails
immediately with `LIDARR_PRESET_ALREADY_RUNNING` and the message "Another preset apply owns this
Lidarr origin", surfaced through `src/commands/lidarr.ts:258-281` into the human output and into the
`--output json|csv` envelope at `:347`. No wait, no partial progress, no new exit code.

## Out of scope

| Item                                                                                                         | Reason                                                                                                                                                                                                                                                                                                                                                                                     | Follow-up issue?                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/tag-writer/mp3-publisher.ts:384` — `open(stagePath, "wx+", 0o600)`                                  | Same _idiom_ as `filesystem.ts:939`, different concept again: the stage is private, mutated, then the **source's** mode is restored via `cp --preserve=mode,ownership,xattr` and asserted at `:428-434` before the rename at `:453`. Gets a local `STAGE_PRIVATE_MODE`, not a shared import.                                                                                               | No — closed by this PR's naming commit.                                                                                                      |
| `src/lib/conversion-metadata.ts:706` — `open(inputPath, "wx+", 0o600)`                                       | A third concept: an **unlinked descriptor** (`unlink` at `:711`) passed to ffmpeg via `/proc/self/fd`, never published. The mode's only job is to narrow the open→unlink window. `secure-store` has no vocabulary for it. Gets a local `UNLINKED_DESCRIPTOR_MODE`.                                                                                                                         | No — closed by this PR's naming commit.                                                                                                      |
| `src/lib/db/reconciliation-database.ts:334`/`:372`                                                           | Carries the `0o022` foreign-write mask, not a private-mode constant. Different trust model (a user-visible database, not a credential).                                                                                                                                                                                                                                                    | No.                                                                                                                                          |
| `plan-engine.ts` claim lock (`:4652-4818`)                                                                   | `plan-engine.test.ts:2139-2157` requires a corrupt partial claim to yield `LidarrPlanAlreadyRunningError` **and** be left byte-identical; `:2159-2188` inverts under the shared age rule; `claim.assertOwned` is threaded through 68 references across 15 files. Migrating it in the same PR makes the diff unreviewable and the revert unit useless.                                      | **Yes.** Mapping already worked out: `maxAgeMs: null`, `deadlineEpochMs = now()`, `CORRUPT → AlreadyRunning`, plus an `assertOwned` adapter. |
| `plan.ts` / `plan-engine.ts` path walks and atomic writers                                                   | Blocked by the reader mode gate, raw-errno classification, and the umask-002 walk hazard documented per-site above. Needs a per-site error translator that is a change of its own size.                                                                                                                                                                                                    | **Yes**, one issue covering both, explicitly dependent on the claim-lock issue for plan-engine.                                              |
| `plan.ts:1178` — `chmod(artifactPath, PRIVATE_FILE_MODE)` **by path** after the rename at `:1177`            | A real defect: `chmod(2)` follows symlinks and has no `O_NOFOLLOW` form, so a name swapped between `:1177` and `:1178` is chmod-ed instead of the artifact. The fix is two lines (chmod the open handle before close, as `atomic.ts:93-95` does), but it is a security change and must not ship inside a chore commit.                                                                     | **Yes**, security-hardening issue.                                                                                                           |
| `filesystem.ts:939` — missing post-open chmod                                                                | Under umask 0277 the stage lands `0o400`, and on the non-converting `verify --fix` path (`verify-album.ts:344`, `verify-filter.ts:477` pass no mode option) that `0o400` is **published** as the destination mode, where `filesystem.test.ts:111` pins `0o600`. Genuine behaviour change on its own merits.                                                                                | **Yes**, bug issue.                                                                                                                          |
| `plan.ts` `appendPlanAudit`                                                                                  | Needs `O_APPEND` to an existing inode. `grep -rn O_APPEND src/lib/secure-store` returns nothing; `atomic.ts:90` opens only `O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW` and `AtomicWriteInput.text` is the whole payload. An `appendPrivateLine` primitive is a genuinely new capability with its own test burden, and `plan.ts:1530` already performs the mandatory chmod it would centralise. | Only if a second append-mode consumer appears.                                                                                               |
| `profile-preset-persistence.ts:766` — `LIDARR_PRESET_JOURNAL_INVALID` thrown for bad **lock** owner metadata | A journal code on a lock failure, surfaced through the machine envelope. Pre-existing; renaming it is a user-visible code change.                                                                                                                                                                                                                                                          | **Yes**, small chore.                                                                                                                        |

## Test strategy

### Suites that must pass UNMODIFIED

| Suite                                                                                     | Why it is the tripwire                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/lidarr/profile-preset-persistence.test.ts` (9 tests)                             | The issue's abort criterion. Mechanically checkable: 0 occurrences of `message`, exactly 10 `code:` assertions.                                                                                      |
| `src/lib/plan.test.ts` (40 `it` blocks) **and** `src/lib/__snapshots__/plan.test.ts.snap` | Byte-identical. Key anchors `:312`/`:805`, `:315`, `:321-326`, `:328-336`, `:396-407`, `:417-425`, `:436-441`, `:768-796`.                                                                           |
| `src/lib/lidarr/plan-engine.test.ts`                                                      | `:1658`/`:1794` (`0o600`), `:1691`, `:1696-1706` (an existing `0o750` parent must not be chmod-ed), `:1715`, `:1723-1725`, `:1750`, `:1756-1770`, `:2076`, `:2081-2113`, `:2139-2157`, `:2159-2188`. |
| `src/lib/filesystem.test.ts` (52 `it` blocks)                                             | `:100`, `:105`, `:111`, `:185`, `:192`, `:231`, `:236`, `:284`, `:335`, `:368`, `:616-647`.                                                                                                          |
| `src/lib/secure-store/secure-store.test.ts` (6 pre-existing tests)                        | Proves the widening is additive.                                                                                                                                                                     |
| `src/actions/lidarr/profile-presets.test.ts`                                              | `:458`'s exact single-argument `acquireLidarrPresetApplyLock` assertion.                                                                                                                             |
| `src/actions/copy-plan.test.ts`, `copy-plan.integration.spec.ts`                          | `:281`/`:892` assert `name === "PlanArtifactError"`.                                                                                                                                                 |
| `src/lib/error-formatters.test.ts`                                                        | `:98-125` pins the `PLAN_CHECKSUM_MISMATCH` suggestion; `error-formatters.ts:81` gates on `error instanceof PlanArtifactError`.                                                                      |
| `src/lib/tag-writer/*.test.ts`, `src/lib/conversion-metadata.test.ts`                     | Cover the two renamed literals.                                                                                                                                                                      |
| `shell-completions/templates.spec.ts`                                                     | Untouched — no CLI flag is added.                                                                                                                                                                    |

### New tests — five, all in `src/lib/secure-store/secure-store.test.ts`

Four (1, 2, 3, 4) land in commit 1; 3b was added afterwards by the post-review legacy-record fix.
The file goes 6 → 11 tests, and the full suite goes 4252 → 4257.

`vitest.config.ts` declares no coverage thresholds, so there is nothing to pad for. Each test pins a
**new** primitive that a later commit's correctness depends on and that nothing else covers.

1. **`readBoundedPrivateFile` async contract.** Returns `undefined` for a missing file; rejects a
   `0o640` file with `SECURE_STORE_PERMISSIONS` without repairing it; rejects past the ceiling with
   `SECURE_STORE_TOO_LARGE`. _Critical because_ commit 5 deletes a bespoke async reader in favour of
   it, and the two divergences from that reader — the `0o077` gate and `ENOENT → undefined` rather
   than a raw throw — are exactly the accepted deltas. There is zero async-reader coverage today.
2. **`maxAgeMs: null` disables the age steal.** A foreign-host record with `createdAt` two hours
   before the injected `now` is **not** reclaimed; the same fixture with the default `maxAgeMs`
   **is**. _Critical because_ this is the only place the option is proven — the preset suite's frozen
   clock makes the age 0, so no existing test can pin it, and without a test the option would be a
   silent, unverified behaviour switch guarding a documented user guarantee.
3. **`assertOwned()` and the release latch.** A same-`ownershipToken`, new-inode displacement throws
   `SECURE_STORE_LOCK_BUSY`; a subsequent `release()` does not unlink the replacement; `assertOwned()`
   after `release()` throws. _Critical because_ it mirrors `profile-preset-persistence.test.ts:182-190`
   at the shared layer, so the primitive is covered independently of its one consumer, and because a
   `binding` mismatch is exercised in the same block (a record carrying a different binding is not
   accepted as the caller's own — replacing `profile-preset-persistence.ts`'s `originDigest`
   cross-check, which nothing else would pin).
   3b. **Legacy `originDigest` acceptance.** A pre-#288 record with a dead same-host pid is stolen under
   `maxAgeMs: null` when its `originDigest` matches the expected binding, and is still rejected as
   corrupt when it does not. _Critical because_ it is the only thing keeping a lock stranded by the
   shipped build recoverable across the upgrade: the corrupt classification fires before `isStale()`,
   and `maxAgeMs: null` leaves no second steal rule.
4. **Hardened `syncDirectory`.** Rejects a regular-file path, proving `O_DIRECTORY` landed.
   _Critical because_ it prevents a future refactor silently reverting to the weaker form and
   re-breaking the guarantee `plan-engine.ts:3919-3938` relies on.

**Explicitly not added:** tests asserting that a site imports a constant (the compiler enforces it),
and per-site regression tests duplicating what `plan.test.ts` / `plan-engine.test.ts` /
`profile-preset-persistence.test.ts` already assert.

### Gate commands

Run from the repo root:

```bash
npm run test:run                                    # normalizes umask 022 + unsets FORCE_COLOR
npm run typecheck --workspace packages/rfmedia-cli  # pretypecheck: codegen:lidarr:check + check:architecture + test:architecture
npm run build -w packages/rfmedia-cli
npm run lint:md
npm run format:check
```

Per-file iteration must use `umask 022 && env -u FORCE_COLOR npx vitest run <file>` from
`packages/rfmedia-cli`. `scripts/test-run.sh` is the **only** runner that normalizes the
environment; `.github/workflows/rfmedia-cli.yml:56` invokes the workspace script directly and
inherits the ambient umask.

`node scripts/check-direct-plex-imports.mjs` (686 lines) enforces Plex/Lidarr dependency direction
and `FETCH_OWNERS`; there is no import-layering rule constraining `src/lib/*` →
`src/lib/secure-store/*`, and this PR adds no network call, so it is unaffected.

## Completion checks

### Check 1 — "duplicate private-file-mode primitives are migrated onto `src/lib/secure-store` at all four named sites"

**Satisfied for three of four; amended for the fourth, and the amendment is a net widening.**

Sites 1, 2 and 4 delete their constants and import from `secure-store`; site 4 additionally deletes
its walk, reader, both writers and its lock. Site 3 (`filesystem.ts:939`) is **not** migrated: its
`0o600` is a transient staging floor that `filesystem.ts:1022` relaxes, that `convert.ts:710-713`
publishes at ~`0o644`, and that `filesystem.test.ts:192`/`:236` pin at `0o640`/`0o604`. Importing
`PRIVATE_FILE_MODE` there would encode a false invariant. It gets a named local constant instead.

The amendment widens rather than narrows the check: verification found **six** production
private-mode expressions, not four — `tag-writer/mp3-publisher.ts:384` and
`conversion-metadata.ts:706` carry the identical `open(path, "wx+", 0o600)` idiom and appear in
neither the issue nor `docs/internal/plex-jwt-deferrals.md:152-157`. All six are addressed.

**Amended check 1:** _every private-file-mode expression in production either delegates to
`secure-store` or carries a named local constant with a documented reason, and no site is left with
weaker behaviour than `secure-store`._

### Check 2 — "`grep -rn '0o600|0o700' packages/rfmedia-cli/src` has no remaining inline literals outside `src/lib/secure-store/`"

**Cannot hold as literally written; amended in two parts.**

The grep returns 64 hits, of which **46 are in `.test.ts`/`.spec.ts` files** — `plan.test.ts:310`,
`profile-preset-persistence.test.ts:126-129`, `filesystem.test.ts:105`, and so on. Those literals are
precisely what pins the behaviour being preserved. Check 3 forbids editing
`profile-preset-persistence.test.ts` at all, so checks 2 and 3 are **mutually unsatisfiable** as
written.

**Amended check 2a (production):** after this PR,

```bash
grep -rn "0o600\|0o700" packages/rfmedia-cli/src --include='*.ts' \
  | grep -v '\.test\.\|\.spec\.' | grep -v 'secure-store/'
```

returns exactly **6** hits — three named-constant declarations (`filesystem.ts` `STAGE_PRIVATE_MODE`,
`mp3-publisher.ts` `STAGE_PRIVATE_MODE`, `conversion-metadata.ts` `UNLINKED_DESCRIPTOR_MODE`) and
three JSDoc prose lines (`plan.ts:1134`, `:1135`, `:1515`) that document behaviour and are correct
as written. Zero literals remain at a call site, down from 6 today (12 lines including the six
constant declarations being deleted).

**Amended check 2b (tests):** test files are out of scope by construction.

### Check 3 — "`profile-preset-persistence.test.ts` must pass UNMODIFIED, and the `plan.ts` snapshot must not change"

**Satisfied, and the whole design is built around it.**

All nine preset tests are traced in the site-4 table above; the two that a naive migration breaks
are resolved by explicit options and a second translator arm rather than by editing the test —
`:105-107`/`:142-144` by `deadlineEpochMs = nowMs()`, and `:188` by giving `assertOwned()` its own
`LIDARR_PRESET_LOCK_LOST` mapping instead of routing it through the acquisition table. The abort
criterion stays measurable (0 `message`, 10 `code:`); if it fails, commit 5 is dropped and refiled.

`src/lib/__snapshots__/plan.test.ts.snap` is untouched because `plan.ts` is constants-only and
`plan.ts:1156` plus the canonicalizers are explicitly out of scope.

### Check 4 — "deadlines for the shared lock must be chosen EXPLICITLY per call site"

**Satisfied. There is exactly one new call site**, and both of its policy values are named
module-level decisions with rationale attached: `deadlineEpochMs: nowMs()` and `maxAgeMs: null`.
Neither is defaulted and neither is a CLI flag. The plan-engine claim keeps its own lock, so it
contributes no deadline decision; that deferral is recorded in the ADR.

### Additional required outputs

`ROADMAP.md` carries #288 in four coupled places that must move together: the narrative at `:38`, the
Next Up row at `:55`, the hardcoded section count at `:151`
(`### Medium priority — copy, verify & metadata (11)` → `(10)`), and the backlog row at `:164`. The
exit criterion at `:58-59` currently reads "Duplicate private-file persistence is gone" and must be
amended to record what shipped and what is tracked by the follow-ups. Per `ROADMAP.md:257-259`
nothing moves to `docs/roadmap-archive.md`, because the post-JWT-hygiene sprint only closes once
issue #289 closes too.

`docs/internal/plex-jwt-deferrals.md` lives at the **repo root**;
`packages/rfmedia-cli/docs/internal/` does not exist. Edits: the header at `:8`, the Q4 row at `:79`,
the §8 item at `:152-157` (corrected from "four places" to six, and corrected on `filesystem.ts`,
whose literal is a stage-privacy floor rather than an owner-only publication mode), and the §9
follow-up row at `:185`, plus new rows for the deferred locks and the two filed defects.

## Commit sequence

1. `feat(rfmedia): widen secure-store into the shared private-file persistence surface`
2. `chore(rfmedia): source Lidarr plan-engine private-file modes from secure-store`
3. `chore(rfmedia): source plan artifact private-file modes from secure-store`
4. `refactor(rfmedia): name the transient staging modes in media publication paths`
5. `refactor(rfmedia): migrate Lidarr preset persistence and its origin lock onto secure-store`
6. `docs(internal): record the secure-store migration and correct the duplicate-site inventory`
7. `docs(roadmap): close the secure-store private-file migration (#288)`

Commit 1 is additive and lands first so no later revert strands an export. Commits 2-4 are
mechanical. Commit 5 is the only high-risk one and is deliberately last among the code commits, so
dropping it requires no rebase of the surface work or the docs. Commits 6-7 are docs-only and use
`docs(internal):` / `docs(roadmap):` per repo convention so they stay out of release notes.

## Risks and rollback

| Risk                                                                                                                     | Likelihood                  | Mitigation                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit 5 needs an edit to `profile-preset-persistence.test.ts`                                                           | Low — all nine tests traced | Drop commit 5, refile. The other six commits stand; that is exactly why it is ordered last.                                                                                                                                                                                                |
| The `binding` rename orphans a lock file written by an older build                                                       | Mitigated in design         | `parseLockRecord` accepts a legacy record whose `originDigest` equals the expected binding, so the same-host-dead-pid steal still clears it and the documented recovery step in `lidarr-quality-presets.md` still applies. Pinned by `secure-store.test.ts`.                               |
| An `0o640` preset journal written by an operator now fails closed                                                        | Very low                    | Documented as delta 8. Recovery is `chmod 600`. Called out in the PR body under Risk and Rollback.                                                                                                                                                                                         |
| `maxAgeMs: null` reintroduces the wedge the age rule guards against (a crashed cross-host owner leaves a permanent lock) | Low                         | This is the pre-existing, documented, _intended_ behaviour of the preset lock (`lidarr-quality-presets.md:281-282`); manual removal is the documented recovery. Adopting the age steal instead would break live applies.                                                                   |
| The hardened `syncDirectory` rejects a path some caller passes that is not a directory                                   | Very low                    | Both callers pass `parent.path` from `prepareSafeParent`, which already proved it is a directory. Pinned by new test 4.                                                                                                                                                                    |
| CI does not re-validate the squashed merge                                                                               | Certain                     | Both CLI workflows declare `push.branches: [main]` while the default branch is `master`, and there is no `workflow_dispatch`. The `pull_request` run is the only gate, so it must be green on the **full** suite, not just touched files. Verify `mergeable` before blaming a missing run. |
| A local `umask 002` shell reports spurious failures                                                                      | Certain if not normalized   | Always run through `npm run test:run`, or `umask 022 && env -u FORCE_COLOR …`.                                                                                                                                                                                                             |

**Rollback.** Each commit is independently revertible in reverse order. `git revert` of commit 5
restores `profile-preset-persistence.ts` wholesale with no dependency on commits 2-4. Reverting
commit 1 requires first reverting commit 5. Commits 2-4 are two-line-plus-import changes and can be
reverted in any order.
