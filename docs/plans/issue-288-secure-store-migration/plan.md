# Issue 288 — implementation plan

Executable plan of record for
[`design.md`](design.md) (856 lines, authoritative — read it first). This file does not redesign
anything; it turns the design into an ordered, literal edit list with gates and abort criteria, and
records every correction applied after adversarial validation.

**Worktree root (all relative paths below are anchored here):**
`/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-288-secure-store`

**Package root:** `<worktree>/packages/rfmedia-cli`

**Baseline:** `origin/master` `b5cc7475`, 169 test files / 4252 tests green. (This plan was first
drafted against `7646f5b4` / 4238 tests; PR #303 moved master to 4252 before the branch landed, so
every count below is stated against `b5cc7475`.)

---

## How to run the gates

**THE ONE RULE.** A bare `vitest` run under `umask 002`, or with `FORCE_COLOR` set in the
environment, produces spurious failures that have nothing to do with this change. Every test
invocation in this plan is therefore written in one of exactly two forms:

```bash
# Form A — targeted suite, from the PACKAGE root
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-288-secure-store/packages/rfmedia-cli \
  && umask 022 && env -u FORCE_COLOR npx vitest run <files...>

# Form B — full suite, from the WORKTREE root (scripts/test-run.sh normalizes umask + FORCE_COLOR itself)
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-288-secure-store \
  && npm run test:run
```

Non-test gates (`typecheck`, `build`, `format:check`, `lint:md`) run from the **worktree root** and
need no normalization.

**Every gate command in this plan is written with an absolute path.** The agent shell resets its
cwd between calls, and the main checkout at
`/home/yandy/Projects/github.com/yandy-r/rfmedia-apps` contains a pristine `packages/rfmedia-cli`
that will happily satisfy a relative-path gate while proving nothing. Do not shorten these commands.

Shorthand used below:

```bash
export W=/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-288-secure-store
export P=$W/packages/rfmedia-cli
```

Shell state does not persist between calls, so re-export or inline the paths each time.

**Bootstrap (once, if `node_modules` is absent in the worktree):** `cd $W && npm ci`, serially,
before any other command.

---

## Commit graph

| id  | title                                                                                        | files touched                                                                                        | depends on | risk     | revertible alone   |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------- | -------- | ------------------ |
| c0  | `docs(internal): add the secure-store migration design and plan of record`                   | `docs/plans/issue-288-secure-store-migration/{design.md,plan.md}`                                    | —          | none     | yes                |
| c1  | `feat(rfmedia): widen secure-store into the shared private-file persistence surface`         | `src/lib/secure-store/{paths,atomic,lock,index,secure-store.test}.ts`, `adapters/plex/enrollment.ts` | c0         | medium   | no — c5 depends    |
| c2  | `chore(rfmedia): source Lidarr plan-engine private-file modes from secure-store`             | `src/lib/lidarr/plan-engine.ts`                                                                      | c1         | low      | yes                |
| c3  | `chore(rfmedia): source plan artifact private-file modes from secure-store`                  | `src/lib/plan.ts`                                                                                    | c1         | low      | yes                |
| c4  | `refactor(rfmedia): name the transient staging modes in media publication paths`             | `src/lib/filesystem.ts`, `src/lib/tag-writer/mp3-publisher.ts`, `src/lib/conversion-metadata.ts`     | c0         | low      | yes                |
| c5  | `refactor(rfmedia): migrate Lidarr preset persistence and its origin lock onto secure-store` | `src/lib/lidarr/profile-preset-persistence.ts`                                                       | c1         | **high** | **no** — see below |
| c6  | `docs(internal): record the secure-store migration and correct the duplicate-site inventory` | `docs/internal/plex-jwt-deferrals.md`                                                                | c1–c5      | low      | yes                |
| c7  | `docs(roadmap): close the secure-store private-file migration (#288)`                        | `ROADMAP.md`, `docs/roadmap-archive.md`                                                              | c1–c6      | low      | yes                |

**Revert units, stated honestly.** The design's claim that "the other six commits stand" if c5 is
dropped is **not true as written**: c6's §8 text and c7's exit criterion both assert as fact that
the preset lock now delegates, and both pin that assertion with a `grep` gate. The real revert unit
is **c5 + c6 + c7**. See "Abort criteria" under c5 for the exact re-authoring list.

`c4` is independent of `c1`–`c3` (it touches none of their files) and is ordered fourth only to keep
the branch linear.

---

## Commit 0 — `docs(internal): add the secure-store migration design and plan of record`

### Scope

`docs/plans/issue-288-secure-store-migration/` is currently **untracked**
(`git status --porcelain` → `?? docs/plans/issue-288-secure-store-migration/`). Committing it first
makes the working tree clean, so every later commit's scope gate is meaningful, and satisfies the
repo rule that internal planning artifacts live under `docs/plans` with a `docs(internal):` subject.

### Edits

1. `git add docs/plans/issue-288-secure-store-migration/design.md docs/plans/issue-288-secure-store-migration/plan.md`

No file content changes.

### Gates

```bash
cd $W && npm run format:check && npm run lint:md
cd $W && test -z "$(git status --porcelain)" && echo TREE_CLEAN
```

Expected: both pass; the tree is clean after the commit.

### Abort criteria

None. If `lint:md` or `format:check` flags either markdown file, run `npx prettier --write` on it and
re-run — do not drop the commit.

---

## Commit 1 — `feat(rfmedia): widen secure-store into the shared private-file persistence surface`

### Scope

Purely additive widening of `src/lib/secure-store/`. Every addition is optional with a default, so
the Plex credential store's on-disk bytes are unchanged: its only lock call site
(`src/lib/adapters/plex/credential-store.ts:435-441`) passes neither `maxAgeMs` nor `binding`, the
new `binding` key is appended **last** in the record literal, and `JSON.stringify` omits
`undefined`-valued properties.

Compiler facts that shape the edits: `tsconfig.json` has **no** `exactOptionalPropertyTypes`, but
does have `verbatimModuleSyntax` (type-only exports must use `export type`) and
`noPropertyAccessFromIndexSignature`. Prettier `printWidth` is 100.

### Edits

#### E1 — `src/lib/secure-store/paths.ts`

**E1a.** Line 18. Before:

```ts
import { chmod, lstat, mkdir } from "node:fs/promises";
```

After:

```ts
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
```

**E1b.** Lines 34-35. Replace the two-line `MAX_PATH_LENGTH` declaration with:

```ts
/**
 * Longest filesystem path the secure store will operate on.
 *
 * Exported because `plan.ts`, `lidarr/plan-engine.ts` and
 * `lidarr/profile-preset-persistence.ts` each declare this same ceiling at the
 * same value. The `SECURE_STORE_` prefix follows the convention already set by
 * `SECURE_STORE_LOCK_MAX_AGE_MS` for names too generic to sit unqualified on a
 * shared barrel; `PRIVATE_FILE_MODE` and `PRIVATE_DIRECTORY_MODE` stay
 * unprefixed because they are already distinctive.
 */
export const SECURE_STORE_MAX_PATH_LENGTH = 4_096;
```

**E1c.** Line 90: `inputPath.length > MAX_PATH_LENGTH ||` →
`inputPath.length > SECURE_STORE_MAX_PATH_LENGTH ||`.

**E1d.** Line 57: `/** Result of {@link readBoundedPrivateFileSync}. */` →
`/** Result of {@link readBoundedPrivateFile} and {@link readBoundedPrivateFileSync}. */`

**E1e.** Insert the async bounded reader immediately **above** the JSDoc block that currently starts
at line 286 (`/**\n * Reads an owner-only file synchronously with a hard byte ceiling.`), separated
by one blank line:

```ts
/**
 * Reads an owner-only file with a hard byte ceiling, without blocking the event
 * loop.
 *
 * Exact asynchronous mirror of {@link readBoundedPrivateFileSync}: opens with
 * `O_NOFOLLOW` so a symlink is rejected by the kernel, refuses any file carrying
 * a group or other permission bit, bounds the read, and re-asserts both the file
 * identity and the parent directory afterwards. Nothing is repaired: a `0o640`
 * file is reported with a `chmod 600` remedy, never fixed.
 *
 * Exported from the barrel for parity with {@link readBoundedPrivateFileSync},
 * which `adapters/plex/credential-store.ts:277` and `:386` already consume.
 *
 * @param filePath - File to read.
 * @param maximumBytes - Hard ceiling on the number of bytes read.
 * @param subject - Short human name of the protected document.
 * @returns The decoded contents and identity, or `undefined` when the file (or
 *   one of its parent directories) does not exist.
 * @throws {SecureStoreError} `SECURE_STORE_PERMISSIONS` for a group/other
 *   readable file, `SECURE_STORE_TOO_LARGE` past the ceiling, and
 *   `SECURE_STORE_UNSAFE_PATH` for a symlink, non-file, or mid-read swap.
 */
export async function readBoundedPrivateFile(
  filePath: string,
  maximumBytes: number,
  subject: string,
): Promise<BoundedPrivateRead | undefined> {
  const path = resolveSecurePath(filePath, subject);
  let parent: SafeParent;
  try {
    parent = await prepareSafeParent(path, false, subject);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    rethrowAsSecureStoreError(error, subject, path);
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, path);
    }
    if ((before.mode & FOREIGN_ACCESS_BITS) !== 0) {
      throw secureStoreError("SECURE_STORE_PERMISSIONS", subject, path);
    }
    if (before.size > maximumBytes) {
      throw secureStoreError("SECURE_STORE_TOO_LARGE", subject, path);
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maximumBytes + 1, 0);
    const after = await handle.stat();
    if (bytesRead > maximumBytes || after.size > maximumBytes) {
      throw secureStoreError("SECURE_STORE_TOO_LARGE", subject, path);
    }
    if (!sameIdentity(before, after)) {
      throw secureStoreError("SECURE_STORE_UNSAFE_PATH", subject, path);
    }
    const identity: FileIdentity = { dev: after.dev, ino: after.ino };
    await assertOpenedFileIdentity(path, identity, subject);
    await assertSafeParentUnchanged(parent, subject);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      identity,
      mode: after.mode,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
```

Do **not** "fix" these three things:

- `prepareSafeParent(path, false, subject)` with `createMissing === false` lets an `ENOENT` from
  `lstat` reach `rethrowAsSecureStoreError`, which has no `ENOENT` mapping and rethrows it **raw** —
  which the `hasErrorCode(error, "ENOENT") → undefined` guard consumes. Identical to the sync path.
- Definite assignment for `handle` type-checks because the `catch` either returns or calls
  `rethrowAsSecureStoreError`, whose return type is `never`.
- The check order is load-bearing and must match `paths.ts:327-344` exactly: `isFile` → `0o077` gate
  → size → read → re-stat → size again → `sameIdentity` → `assertOpenedFileIdentity` →
  `assertSafeParentUnchanged`.

**E1f.** In the now-shifted sync reader's JSDoc, replace the opening line
`* Reads an owner-only file synchronously with a hard byte ceiling.` with:

```text
 * Synchronous counterpart of {@link readBoundedPrivateFile}, for the
 * adapter-construction read path that must stay synchronous.
```

Keep the rest of that block verbatim.

#### E2 — `src/lib/secure-store/atomic.ts`

**E2a.** Immediately above `removeIfPresent` (before line 60):

```ts
/**
 * Subject attached to failures raised by {@link syncDirectory}, which takes a
 * bare path so its callers' signatures stay unchanged and has no document
 * subject to forward. Every message stays a fixed local literal either way.
 */
const DIRECTORY_SYNC_SUBJECT = "Secure store directory";
```

**E2b.** Replace lines 66-78 (`syncDirectory` and its JSDoc) in full with:

```ts
/**
 * Flushes a directory entry so a `link`/`rename` survives a power loss.
 *
 * `O_DIRECTORY` is mandatory: without it a regular-file path is silently fsynced
 * instead of erroring. `lidarr/plan-engine.ts:3919-3938` already carries this
 * hardening, so adopting the weaker form anywhere would be a downgrade.
 * `constants.O_DIRECTORY` is `undefined` on win32, so the platform guard is not
 * optional.
 *
 * @param path - Directory to fsync. A no-op on win32.
 * @throws {SecureStoreError} `SECURE_STORE_UNSAFE_PATH` when `path` is not a
 *   directory or is a symlink, `SECURE_STORE_PERMISSIONS` when it cannot be
 *   opened. Every other `errno` is rethrown unchanged.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    rethrowAsSecureStoreError(error, DIRECTORY_SYNC_SUBJECT, path);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
```

`FileHandle` (line 24) and `rethrowAsSecureStoreError` (line 27) are already imported. No import
changes in this file.

Consequence to accept, not work around: an `EACCES` raised inside `syncDirectory` while called from
`createPrivateFileAtomically` (line 157) or `replacePrivateFileAtomically` (line 194) is now already
a `SecureStoreError` when it reaches those writers' `catch`, so
`rethrowAsSecureStoreError(error, input.subject, input.path)` passes it through with the generic
subject and the **directory** path. The `code` is identical and no test observes the subject or path
of that failure.

#### E3 — `src/lib/secure-store/lock.ts`

**E3a — imports.** Line 23: `import { createPrivateFileAtomically } from "./atomic.js";` →
`import { createPrivateFileAtomically, syncDirectory } from "./atomic.js";`

Lines 30-37: replace `readBoundedPrivateFileSync,` with `readBoundedPrivateFile,` (the sync reader is
no longer used in this file).

**E3b — export the UUID pattern.** Replace line 70 with:

```ts
/**
 * UUIDv4 shape of the ownership token.
 *
 * Exported because `lidarr/plan-engine.ts` and
 * `lidarr/profile-preset-persistence.ts` declare byte-identical copies.
 */
export const SECURE_STORE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
```

Update both references: line 158 (inside `parseLockRecord`) and line 289 (inside
`acquireExclusiveLock`).

**E3c — `SecureStoreLockRecord` gains `binding`** (lines 72-82). Append after `ownershipToken`:

```ts
  /**
   * Opaque caller-supplied binding, re-asserted on read. Absent when the caller
   * supplied none, so a record written without one is byte-identical to a
   * pre-#288 record.
   */
  readonly binding?: string;
```

**E3d — `SecureStoreLock`** (lines 84-92). Replace the whole interface:

```ts
/** A held exclusive lock. */
export interface SecureStoreLock {
  /** Absolute path of the lock file, safe to surface to an operator. */
  readonly path: string;
  /** UUIDv4 identifying this acquisition. */
  readonly ownershipToken: string;
  /** The binding this acquisition was made under, when one was supplied. */
  readonly binding?: string;
  /**
   * Re-reads the record and proves `ownershipToken`, `host`, `pid`,
   * `createdAt`, `binding` and `{dev,ino}` all still match.
   *
   * @throws {SecureStoreError} `SECURE_STORE_LOCK_BUSY` when the record no
   *   longer matches or {@link SecureStoreLock.release} has already run,
   *   `SECURE_STORE_CORRUPT` when the record on disk is unparseable.
   */
  assertOwned(): Promise<void>;
  /**
   * Unlinks the lock, but only while this acquisition still owns it.
   * Idempotent: a second call is a no-op.
   */
  release(): Promise<void>;
}
```

**E3e — `SecureStoreLockOptions`** (lines 94-112). Append after `randomUUID`:

```ts
  /**
   * Age after which a lock is stolen on ANY host, regardless of liveness.
   * `null` disables the age rule entirely — required by call sites whose
   * critical section legitimately outlives the default and that document "a
   * live owner is never forcibly replaced". Defaults to
   * {@link SECURE_STORE_LOCK_MAX_AGE_MS}.
   */
  readonly maxAgeMs?: number | null;
  /**
   * Opaque caller-supplied binding written into the record and re-asserted on
   * every read during acquisition. A record carrying a different binding is
   * treated as unparseable, so acquisition fails `SECURE_STORE_CORRUPT`.
   */
  readonly binding?: string;
```

**E3f — `parseLockRecord`** (lines 143-163). Replace in full:

```ts
function parseLockRecord(value: unknown, expectedBinding: string | undefined): SecureStoreLockRecord | undefined {
  if (!isPlainRecord(value)) return undefined;
  const host = value["host"];
  const pid = value["pid"];
  const createdAt = value["createdAt"];
  const ownershipToken = value["ownershipToken"];
  const binding = value["binding"];
  if (binding !== undefined && typeof binding !== "string") return undefined;
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof createdAt !== "string" ||
    !Number.isSafeInteger(Date.parse(createdAt)) ||
    typeof ownershipToken !== "string" ||
    !SECURE_STORE_UUID_PATTERN.test(ownershipToken)
  ) {
    return undefined;
  }
  if (expectedBinding !== undefined && binding !== expectedBinding) return undefined;
  return {
    host,
    pid,
    createdAt,
    ownershipToken,
    ...(binding === undefined ? {} : { binding }),
  };
}
```

The early `binding` type guard is a **separate statement on purpose**: folding it into the big `||`
chain leaves `binding` typed `unknown` after the chain and the spread then fails to type-check.

**E3g — `readExistingLock`** (lines 165-179). Becomes async and takes the expected binding:

```ts
async function readExistingLock(
  lockPath: string,
  subject: string,
  expectedBinding: string | undefined,
): Promise<ExistingLock | undefined> {
  const read = await readBoundedPrivateFile(lockPath, LOCK_MAX_BYTES, subject);
  if (read === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch (error) {
    throw secureStoreError("SECURE_STORE_CORRUPT", subject, lockPath, error);
  }
  const record = parseLockRecord(parsed, expectedBinding);
  if (record === undefined) {
    throw secureStoreError("SECURE_STORE_CORRUPT", subject, lockPath);
  }
  return { record, identity: read.identity };
}
```

This is the second justification for the async reader: `lock.ts:166` called the **sync** reader from
inside `async acquireExclusiveLock`, so every contended poll blocked the event loop.

**E3h — `unlinkLockIfOwned`** (lines 181-202):

```ts
async function unlinkLockIfOwned(
  lockPath: string,
  expected: SecureStoreLockRecord,
  identity: FileIdentity,
  parent: SafeParent,
  subject: string,
): Promise<boolean> {
  const current = await readExistingLock(lockPath, subject, undefined);
  if (
    current === undefined ||
    current.record.ownershipToken !== expected.ownershipToken ||
    !sameIdentity(current.identity, identity)
  ) {
    return false;
  }
  await assertOpenedFileIdentity(lockPath, identity, subject);
  await unlink(lockPath).catch((error: unknown) => {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  });
  await assertSafeParentUnchanged(parent, subject);
  // Best-effort: the unlink has already happened and both callers invoke
  // release() from inside a `finally` (credential-store.ts:470,
  // actions/lidarr/profile-presets.ts:894-897). A durability hint must never
  // mask the real failure that is already in flight.
  await syncDirectory(parent.path).catch(() => undefined);
  return true;
}
```

Three things that must NOT change:

- **No binding filter here.** Design item 6 contrasts `assertOwned`'s full-field comparison with
  "`unlinkLockIfOwned`'s token+inode pair (`lock.ts:189-195`)". Passing a binding filter would turn
  "this is not my lock" from `return false` into a thrown `SECURE_STORE_CORRUPT`, breaking the silent
  no-op that `profile-preset-persistence.test.ts:188-190` requires after c5.
- **The fsync is gated on ownership**, matching `profile-preset-persistence.ts:730-739` and the
  `if (removed) await syncDirectory(...)` precedent at `credential-store.ts:431`. It sits after
  `assertSafeParentUnchanged` so the directory is proven safe before it is opened. Placing it here
  rather than in `release()` also covers the steal path at line 333.
- **The `.catch(() => undefined)` is required, not optional.** See "Corrections applied" C9.

**E3i — `isStale`** (lines 235-243). Replace in full:

```ts
function isStale(
  record: SecureStoreLockRecord,
  host: string,
  nowEpochMs: number,
  isProcessAlive: (pid: number) => boolean,
  maxAgeMs: number | null,
): boolean {
  if (record.host === host && !isProcessAlive(record.pid)) return true;
  if (maxAgeMs === null) return false;
  return nowEpochMs - Date.parse(record.createdAt) > maxAgeMs;
}
```

**E3j — `acquireExclusiveLock`** (lines 264-354).

JSDoc (lines 245-263): insert after "…regardless of host." (lines 251-252):

```text
 * Passing `maxAgeMs: null` disables the age rule entirely, leaving the
 * same-host-dead-pid rule as the only steal. Passing a `binding` makes an
 * existing record carrying a different one unparseable, so acquisition fails
 * `SECURE_STORE_CORRUPT` rather than waiting behind a foreign owner.
```

Option resolution: after line 275 (`const isProcessAlive = options.isProcessAlive ?? …;`) add:

```ts
const binding = options.binding;
const maxAgeMs = options.maxAgeMs === undefined ? SECURE_STORE_LOCK_MAX_AGE_MS : options.maxAgeMs;
```

`??` is **wrong** here and must not be used: `null ?? SECURE_STORE_LOCK_MAX_AGE_MS` would silently
re-enable the age steal the caller just disabled.

Record construction (lines 292-297):

```ts
const record: SecureStoreLockRecord = {
  host,
  pid,
  createdAt: new Date(now()).toISOString(),
  ownershipToken,
  ...(binding === undefined ? {} : { binding }),
};
```

The spread is **last** so that, with no binding, `JSON.stringify(record)` produces today's exact
bytes. That is the byte-identity guarantee for the Plex credential store's lock file.

Returned lock (lines 314-323) — replace the whole `if (identity !== undefined) { … }` block:

```ts
if (identity !== undefined) {
  const held = identity;
  let released = false;
  const lock: SecureStoreLock = {
    path,
    ownershipToken,
    ...(binding === undefined ? {} : { binding }),
    assertOwned: async (): Promise<void> => {
      if (released) {
        throw secureStoreError("SECURE_STORE_LOCK_BUSY", subject, path);
      }
      const current = await readExistingLock(path, subject, undefined);
      if (
        current === undefined ||
        current.record.ownershipToken !== record.ownershipToken ||
        current.record.host !== record.host ||
        current.record.pid !== record.pid ||
        current.record.createdAt !== record.createdAt ||
        current.record.binding !== record.binding ||
        !sameIdentity(current.identity, held)
      ) {
        throw secureStoreError("SECURE_STORE_LOCK_BUSY", subject, path);
      }
    },
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      await unlinkLockIfOwned(path, record, held, parent, subject);
    },
  };
  return Object.freeze(lock);
}
```

Load-bearing details:

- `assertOwned` reads with **no** binding filter and compares `binding` as one of six axes, so a
  foreign binding yields `SECURE_STORE_LOCK_BUSY` (honouring its JSDoc) while acquisition yields
  `SECURE_STORE_CORRUPT` (honouring design §5). The binding filter belongs to acquisition only.
- The `released` latch is set **before** any I/O, so a second `release()` is a pure no-op.
- The explicit `const lock: SecureStoreLock` annotation (rather than annotating the
  `Object.freeze(...)` expression) keeps the conditional spread assignable.

Contended read (line 325): `const existing = await readExistingLock(path, subject, binding);`

Staleness call (line 330): `isStale(existing.record, host, now(), isProcessAlive, maxAgeMs)`

Nothing else changes. In particular the fail-fast arithmetic at lines 342-345
(`remainingMs = options.deadlineEpochMs - now()`; `<= 0` → `SECURE_STORE_LOCK_BUSY`) is untouched —
c5 depends on it.

#### E4 — `src/lib/secure-store/index.ts`

**E4a.** Replace the module docblock (lines 1-12):

```ts
/**
 * Hardened filesystem primitives for owner-only, atomically-replaced,
 * lock-guarded private documents.
 *
 * This is the canonical home for the private-file/private-directory mode
 * constants, the safe-path machinery, the bounded private readers (sync and
 * async), the atomic writers and the `link()`-based exclusive lock.
 *
 * What stays outside it is a decision, not an omission. `plan.ts` and
 * `lidarr/plan-engine.ts` source only the mode and path-length constants: their
 * bounded readers must not reject on `mode & 0o077` before the size check, their
 * callers classify on raw `errno`, and their directory hardeners chmod where
 * this module deliberately refuses to repair silently. `filesystem.ts`'s `0o600`
 * is a transient staging floor that is later relaxed, not a private-document
 * mode, and must never import `PRIVATE_FILE_MODE`. Each refusal is backed by a
 * named test in `docs/plans/issue-288-secure-store-migration/design.md`.
 *
 * Import from this barrel; the submodules have no supported deep-import path.
 */
```

**E4b.** Paths re-exports (lines 25-38):

```ts
export {
  assertOpenedFileIdentity,
  assertOpenedFileIdentitySync,
  assertSafeParentUnchanged,
  assertSafeParentUnchangedSync,
  prepareSafeParent,
  prepareSafeParentSync,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  readBoundedPrivateFile,
  readBoundedPrivateFileSync,
  resolveSecurePath,
  sameIdentity,
  SECURE_STORE_MAX_PATH_LENGTH,
} from "./paths.js";
export type { BoundedPrivateRead, FileIdentity, SafeParent } from "./paths.js";
```

**E4c.** Atomic re-exports (lines 40-45):

```ts
export {
  createPrivateFileAtomically,
  removeOrphanedTemporaryFiles,
  replacePrivateFileAtomically,
  syncDirectory,
} from "./atomic.js";
export type { AtomicReplaceInput, AtomicWriteInput, OrphanedTemporarySweepInput } from "./atomic.js";
```

**E4d.** Lock re-exports (lines 47-52):

```ts
export {
  acquireExclusiveLock,
  isProcessAliveByDefault,
  SECURE_STORE_LOCK_MAX_AGE_MS,
  SECURE_STORE_UUID_PATTERN,
} from "./lock.js";
export type { SecureStoreLock, SecureStoreLockOptions, SecureStoreLockRecord } from "./lock.js";
```

#### E5 — `src/lib/adapters/plex/enrollment.ts:32`

```ts
import { removeOrphanedTemporaryFiles } from "../../secure-store/index.js";
```

This is the only deep import of a `secure-store` submodule in the repo.
`credential-store.ts:41` already imports the barrel from the same directory, so `check:architecture`
is proven unaffected.

#### E6 — `src/lib/secure-store/secure-store.test.ts` (exactly four new tests)

Imports: add `unlinkSync` to the `node:fs` named imports (lines 2-9); replace the barrel import
(lines 16-22) with:

```ts
import {
  acquireExclusiveLock,
  readBoundedPrivateFile,
  readBoundedPrivateFileSync,
  replacePrivateFileAtomically,
  SECURE_STORE_LOCK_MAX_AGE_MS,
  SecureStoreError,
  syncDirectory,
} from "./index.js";
```

The existing helpers `captureAsync`, `readRecord`, `writeLockRecord`, `delay` and the
`beforeEach`/`afterEach` temp-dir lifecycle are reused unchanged. `writeLockRecord` uses
`writeFileSync` with the default `"w"` flag, which **truncates the existing inode** rather than
creating a new one — test 3 relies on that to isolate the `binding` axis from the `{dev,ino}` axis.

Append these four `describe` blocks at the end of the file, and **no others**:

```ts
describe("readBoundedPrivateFile", () => {
  it("returns undefined for a missing file and refuses an over-permissive or oversized one", async () => {
    expect(await readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT)).toBeUndefined();

    writeFileSync(storePath, '{"ok":true}', { mode: 0o600 });
    chmodSync(storePath, 0o600);
    expect((await readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT))?.text).toBe('{"ok":true}');

    chmodSync(storePath, 0o640);
    const permissions = await captureAsync(async () => readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT));
    expect(permissions.code).toBe("SECURE_STORE_PERMISSIONS");
    // No silent repair: the mode is exactly as the operator left it.
    expect(lstatSync(storePath).mode & 0o777).toBe(0o640);

    chmodSync(storePath, 0o600);
    const tooLarge = await captureAsync(async () => readBoundedPrivateFile(storePath, 4, SUBJECT));
    expect(tooLarge.code).toBe("SECURE_STORE_TOO_LARGE");
  });
});

describe("acquireExclusiveLock staleness policy", () => {
  it("steals an aged foreign-host lock by default and never with maxAgeMs null", async () => {
    const nowEpochMs = Date.parse("2026-07-25T12:00:00.000Z");
    const aged: SecureStoreLockRecord = {
      host: "some-other-host",
      pid: 4_242,
      createdAt: new Date(nowEpochMs - 7_200_000).toISOString(),
      ownershipToken: randomUUID(),
    };
    writeLockRecord(lockPath, aged);

    const busy = await captureAsync(async () =>
      acquireExclusiveLock(lockPath, {
        subject: SUBJECT,
        deadlineEpochMs: nowEpochMs,
        now: () => nowEpochMs,
        isProcessAlive: () => true,
        maxAgeMs: null,
      }),
    );
    expect(busy.code).toBe("SECURE_STORE_LOCK_BUSY");
    expect(readRecord(lockPath).ownershipToken).toBe(aged.ownershipToken);

    const stolen = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: nowEpochMs,
      now: () => nowEpochMs,
      isProcessAlive: () => true,
    });
    expect(readRecord(lockPath).ownershipToken).toBe(stolen.ownershipToken);
    await stolen.release();
  });
});

describe("SecureStoreLock.assertOwned", () => {
  it("proves full-record ownership, rejects a foreign binding, and latches after release", async () => {
    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
      binding: "origin-a",
    });
    expect(lock.binding).toBe("origin-a");
    await expect(lock.assertOwned()).resolves.toBeUndefined();

    // Same inode, same token: the binding axis alone must fail the assertion.
    const held = readRecord(lockPath);
    writeLockRecord(lockPath, { ...held, binding: "origin-b" });
    const foreignBinding = await captureAsync(async () => lock.assertOwned());
    expect(foreignBinding.code).toBe("SECURE_STORE_LOCK_BUSY");
    writeLockRecord(lockPath, held);
    await expect(lock.assertOwned()).resolves.toBeUndefined();

    // A new inode carrying the same token is a displacement, not our lock.
    unlinkSync(lockPath);
    writeLockRecord(lockPath, { ...held, pid: 99 });
    const displaced = await captureAsync(async () => lock.assertOwned());
    expect(displaced.code).toBe("SECURE_STORE_LOCK_BUSY");

    // release() must not unlink a lock it no longer owns, and is idempotent.
    await lock.release();
    await lock.release();
    expect(readRecord(lockPath).pid).toBe(99);
    const afterRelease = await captureAsync(async () => lock.assertOwned());
    expect(afterRelease.code).toBe("SECURE_STORE_LOCK_BUSY");

    // On acquisition, a record carrying another binding is unparseable.
    const otherPath = join(tempDir, "other.lock");
    writeLockRecord(otherPath, {
      host: hostname(),
      pid: 4_243,
      createdAt: new Date().toISOString(),
      ownershipToken: randomUUID(),
      binding: "origin-b",
    });
    const corrupt = await captureAsync(async () =>
      acquireExclusiveLock(otherPath, {
        subject: SUBJECT,
        deadlineEpochMs: Date.now(),
        binding: "origin-a",
      }),
    );
    expect(corrupt.code).toBe("SECURE_STORE_CORRUPT");
  });
});

describe("syncDirectory", () => {
  it.skipIf(process.platform === "win32")("fsyncs a real directory and refuses a regular-file path", async () => {
    await expect(syncDirectory(tempDir)).resolves.toBeUndefined();

    writeFileSync(storePath, "not a directory", { mode: 0o600 });
    const notADirectory = await captureAsync(async () => syncDirectory(storePath));
    expect(notADirectory.code).toBe("SECURE_STORE_UNSAFE_PATH");
  });
});
```

Why the staleness test terminates without a real clock: the default arm steals, sets
`retryImmediately`, and re-creates the file on the next pass, never reaching the deadline
arithmetic; the `null` arm is not stale, so `remainingMs === 0` throws `SECURE_STORE_LOCK_BUSY` on
the first pass with no sleep. `O_DIRECTORY` on a regular file returns `ENOTDIR`, which
`rethrowAsSecureStoreError` (`errors.ts:196-198`) maps to `SECURE_STORE_UNSAFE_PATH`. Vitest 4.0.17
is installed, so `it.skipIf` is available.

**No other tests may be added.** The design's "Explicitly not added" clause forbids tests asserting
that a site imports a constant and per-site regression tests.

### Gates

```bash
cd $W && npm run format:check && npm run lint:md
cd $W && npm run typecheck -w packages/rfmedia-cli
cd $W && npm run build -w packages/rfmedia-cli
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/adapters/plex/credential-store.test.ts src/lib/adapters/plex/enrollment.test.ts \
  src/lib/adapters/plex/enrollment-refresh.test.ts src/lib/adapters/plex/credential-cell.test.ts
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/lidarr/profile-preset-persistence.test.ts src/lib/plan.test.ts \
  src/lib/lidarr/plan-engine.test.ts src/lib/filesystem.test.ts
cd $W && npm run test:run
```

Structural gates:

```bash
cd $P && test "$(grep -c 'SECURE_STORE_UUID_PATTERN' src/lib/secure-store/lock.ts)" = 3 \
  && test "$(grep -c 'MAX_PATH_LENGTH' src/lib/secure-store/paths.ts)" = 2 \
  && test -z "$(grep -n '[^_]MAX_PATH_LENGTH' src/lib/secure-store/paths.ts | grep -v SECURE_STORE_)" \
  && echo RENAMES_OK
cd $P && test -z "$(grep -rn 'secure-store/[a-z-]*\.js' src --include='*.ts' \
  | grep -v '^src/lib/secure-store/' | grep -v 'secure-store/index.js')" && echo NO_DEEP_IMPORTS
cd $W && test -z "$(git status --porcelain -- \
  packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap \
  packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts \
  packages/rfmedia-cli/src/lib/plan.ts packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts \
  packages/rfmedia-cli/src/lib/filesystem.ts)" && echo UNTOUCHED_OK
cd $P && test "$(grep -c 'message' src/lib/lidarr/profile-preset-persistence.test.ts)" = 0 \
  && test "$(grep -c 'code:' src/lib/lidarr/profile-preset-persistence.test.ts)" = 10 \
  && echo ABORT_CRITERION_OK
```

Expected: all pass; `test:run` reports 169 files / **4256** tests (4252 + c1's 4 new).

### Abort criteria

- Any pre-existing `secure-store.test.ts` or `credential-store.test.ts` test needs an edit → stop and
  re-derive; the additivity claim has failed and the design's byte-identity guarantee is broken.
- `UNTOUCHED_OK` fails → an edit escaped `src/lib/secure-store/` + `enrollment.ts`. Revert and redo.

Nothing here is droppable: c5 requires c1. If c1 cannot be made green, the whole PR stops.

---

## Commit 2 — `chore(rfmedia): source Lidarr plan-engine private-file modes from secure-store`

### Scope

Constants-only. Two hunks in one file (`src/lib/lidarr/plan-engine.ts`, 4818 lines). No test changes,
no behaviour change: four module-private constants become four imported bindings at identical values
with identical identifiers at every use site.

**Do not start until c1 has landed** — `SECURE_STORE_MAX_PATH_LENGTH` and `SECURE_STORE_UUID_PATTERN`
do not exist on the barrel before it.

**Name-collision hazard.** `plan-engine.ts` declares its own `FileIdentity` (`:3825`), `SafeParent`
(`:3830`), `sameIdentity` (`:3835`), `prepareSafeParent` (`:3880`), `assertSafeParentUnchanged`
(`:3911`) and `assertOpenedFileIdentity` (`:3940`). `import * as …` or any broadening of the
named-import list beyond the four names below is a TS2440/TS2451 redeclaration error.

### Edits

Apply A then B back to back and treat them as one atomic change; TS cannot be kept green between
them.

**EA — insert after line 104** (`import { getDefaultPlanDir } from "../plan.js";`):

```ts
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  SECURE_STORE_MAX_PATH_LENGTH as MAX_PATH_LENGTH,
  SECURE_STORE_UUID_PATTERN as UUID_PATTERN,
} from "../secure-store/index.js";
```

Aliasing back to the original local names keeps all eight use sites (`:3846` plus the seven
`UUID_PATTERN` sites at `:2096`, `:3160`, `:4216`, `:4428`, `:4682`, `:4740`, `:4751`) textually
unchanged. The single-line form is 133 chars > `printWidth: 100`, so the multi-line form above is
what Prettier produces — match it exactly, trailing comma included. Do not move the import below
`:129`'s `CIRCULARITY GUARD` comment block.

**EB — delete four of the six lines at `:189-194`** (`:195-200` after EA). Before:

```ts
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PATH_LENGTH = 4_096;
const CLAIM_MAX_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/u;
```

After (a non-contiguous deletion; the two survivors become adjacent):

```ts
const CLAIM_MAX_BYTES = 4_096;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/u;
```

Do not add a blank line, a comment, or reorder the survivors. `:194` is `CHECKSUM_PATTERN`, **not** a
`MAX_PATH_LENGTH` reference.

**Explicit do-not-touch** (each re-verified; nothing in EA/EB goes near them):

1. `readBoundedFile` (`:3948-3984`) stays local — `readBoundedPrivateFileSync` gates on
   `mode & 0o077` at `paths.ts:330` **before** the size check at `:333`, and three plan-engine tests
   seed fixtures with a bare `writeFile` (`plan-engine.test.ts:1750`, `:1691`, `:2076`).
2. `prepareSafeParent` (`:3880-3909`) stays local — it rethrows non-`ENOENT` errno raw and callers
   classify on it, most sharply `plan-engine.ts:4436` (`if (hasCode(error, "ENOENT")) return [];`).
3. The claim lock stays local — `acquireLidarrPlanClaim` (`:4736-4818`), `defaultIsProcessAlive`
   (`:4652-4659`), `syncSafeParentDirectory` (`:3919-3938`). `plan-engine.test.ts:2159-2188` inverts
   under the shared age rule. Deferred to **#304**.

### Gates

```bash
cd $W && git diff --stat -- packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts   # ~6 insertions / 4 deletions, this file only
cd $W && test -z "$(git status --porcelain -- packages/rfmedia-cli | grep -v 'src/lib/lidarr/plan-engine.ts')" && echo SCOPE_OK
cd $P && test "$(grep -c '0o600\|0o700' src/lib/lidarr/plan-engine.ts)" = 0 && echo NO_LITERALS
cd $P && grep -n 'const CLAIM_MAX_BYTES\|const CHECKSUM_PATTERN' src/lib/lidarr/plan-engine.ts   # both present, adjacent
cd $P && test -z "$(grep -nE 'const (MAX_PATH_LENGTH|UUID_PATTERN|PRIVATE_FILE_MODE|PRIVATE_DIRECTORY_MODE) =' src/lib/lidarr/plan-engine.ts)" && echo NO_LOCAL_DECLS
cd $W && git diff --exit-code -- \
  packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts \
  packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts \
  packages/rfmedia-cli/src/lib/plan.test.ts \
  packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap
cd $P && sha256sum src/lib/__snapshots__/plan.test.ts.snap   # eca986cc3e71f812f376868ec2ad569dc8f0ce4694bdb92ab63f9d4028191612
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts   # 75 passed
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/secure-store/secure-store.test.ts src/lib/lidarr/profile-preset-persistence.test.ts src/lib/plan.test.ts
cd $W && npm run typecheck --workspace packages/rfmedia-cli && npm run build -w packages/rfmedia-cli
cd $W && npm run test:run && npm run format:check
```

### Abort criteria

`plan-engine.test.ts` needs any edit → this commit is wrong; the constants are not value-identical.
Revert and stop. c2 is independently revertible and dropping it does not affect c3–c7.

---

## Commit 3 — `chore(rfmedia): source plan artifact private-file modes from secure-store`

### Scope

Constants-only in `src/lib/plan.ts`. Zero behaviour change. **The writer is deliberately NOT
delegated:** both shared atomic writers call `prepareSafeParent` internally (`atomic.ts:143` and
`atomic.ts:186` — the design cites `:184`, a 2-line drift, harmless), whose walk rejects a
group-writable leaf, and `plan.test.ts:397` creates its parent with `mkdir(realDir, {recursive:true})`
and **no mode** (`0o775` under `umask 002`). `ensurePrivateArtifactDirectory`'s unconditional
`chmod(PRIVATE_DIRECTORY_MODE)` at `plan.ts:1089` is what keeps `plan.test.ts:312`/`:805`
umask-insensitive, so it stays.

Requires c1 (`SECURE_STORE_MAX_PATH_LENGTH`). `PRIVATE_DIRECTORY_MODE`/`PRIVATE_FILE_MODE` are
already exported (`paths.ts:29`/`:32`, barrel `index.ts:32-33`).

### Edits

Three edits, one atomic change (no ordering typechecks in between: TS2440 either way). Apply
**bottom-up** so cited line numbers stay valid: E3, then E2, then E1.

**E3 — delete `plan.ts:66-68`:**

```ts
const MAX_PATH_LENGTH = 4096;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
```

`SMART_FILTER_MAX_DEPTH` at `:69` and everything below are unchanged. Do not touch `MAX_PLANS`
(`:64`, exported), `SMART_FILTER_MAX_NODES`, `MAX_FINGERPRINT_SOURCES`, `MAX_SOURCE_ENTRIES`,
`PLAN_AGE_WARNING_MS`, `STALENESS_PATHS_CAP`, `MANAGED_PLAN_FILE_PATTERN`, `CHECKSUM_PATTERN`.

**E2 — `plan.ts:1021`**, inside `validateArtifactPath`:

```ts
    inputPath.length > SECURE_STORE_MAX_PATH_LENGTH ||
```

Use the prefixed name directly — **no import-site alias here** (unlike c2). Values are identical
(`4096` vs `4_096`). The `inputPath.split(/[\\/]/u).includes("..")` guard at `:1023` stays;
`plan.test.ts:417-425` pins it.

**E1 — insert after `plan.ts:35`** (between the `./errors.js` import and the `../types/plan.js`
import):

```ts
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE, SECURE_STORE_MAX_PATH_LENGTH } from "./secure-store/index.js";
```

The multi-line form is mandatory: the single-line form is 114 chars > `printWidth: 100`. Do not
deep-import `./secure-store/paths.js`.

**Textually unchanged** (verify by diff): `:1071`, `:1089`, `:1171`, `:1178`, `:1528`, `:1530`, and
the three JSDoc prose lines `:1134`, `:1135`, `:1515` that keep their literal `0o700`/`0o600` text.
`plan.ts:1178`'s chmod-by-path defect is deferred to **#306** — do not fix it here.

Expected shape: 3 hunks, 1 file, `+6 / −4`. Net `+2` below old line 68.

### Gates

```bash
cd $W && git diff --stat -- packages/rfmedia-cli/src/lib/plan.ts   # 1 file, 6 insertions(+), 4 deletions(-)
cd $W && test -z "$(git status --porcelain -- packages/rfmedia-cli | grep -v 'src/lib/plan.ts')" && echo SCOPE_OK
cd $W && git diff --exit-code -- \
  packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap \
  packages/rfmedia-cli/src/lib/plan.test.ts \
  packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts
cd $P && sha256sum -c <<< 'eca986cc3e71f812f376868ec2ad569dc8f0ce4694bdb92ab63f9d4028191612  src/lib/__snapshots__/plan.test.ts.snap'
cd $P && test "$(grep -c '0o600\|0o700' src/lib/plan.ts)" = 3 && grep -n '0o600\|0o700' src/lib/plan.ts   # exactly the 3 JSDoc prose lines
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts
cd $P && umask 002 && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts   # proves the writer was NOT delegated
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/lidarr/profile-preset-persistence.test.ts src/actions/copy-plan.test.ts \
  src/actions/copy-plan.integration.spec.ts src/lib/error-formatters.test.ts src/lib/secure-store/secure-store.test.ts
cd $W && npm run typecheck --workspace packages/rfmedia-cli && npm run build -w packages/rfmedia-cli
cd $W && npm run format:check && npm run test:run
```

The `umask 002` run is the load-bearing gate: it is the only thing that proves the writer stayed
local. If it fails, the walk was delegated by accident.

### Abort criteria

`plan.test.ts.snap` changes, or `plan.test.ts` needs an edit → revert. c3 is independently
revertible.

---

## Commit 4 — `refactor(rfmedia): name the transient staging modes in media publication paths`

### Scope

Three inline `0o600` literals become three **differently named** module-local constants. No shared
module, no import of `PRIVATE_FILE_MODE`, no behaviour change. Each constant's JSDoc states why it
must not be merged with secure-store's `PRIVATE_FILE_MODE` — that comment is the load-bearing part of
the commit.

Independent of c1–c3. Current target lines (verified at HEAD):

```text
src/lib/filesystem.ts:939:    const stagedHandle = await open(stagedPath, "wx+", 0o600);
src/lib/conversion-metadata.ts:706:    handle = await open(inputPath, "wx+", 0o600);
src/lib/tag-writer/mp3-publisher.ts:384:    stageHandle = await open(stagePath, "wx+", 0o600);
```

Neither `STAGE_PRIVATE_MODE` nor `UNLINKED_DESCRIPTOR_MODE` exists anywhere in `src` today.
`tsconfig.json` does not set `noUnusedLocals`, but apply each file's two edits back to back anyway.

### Edits

**F1 — `src/lib/filesystem.ts`.** After `:45` (`const READ_ONLY_NOFOLLOW_FLAGS = …;`, the end of the
module-constant block at `:42-45`), append:

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

Then at the staging open (now `:949`):

```ts
const stagedHandle = await open(stagedPath, "wx+", STAGE_PRIVATE_MODE);
```

Change nothing else: not the `0o022` parent gate at `:913`, not `resolvePublishMode` (`:849-873`),
not the `chmod(publishMode)`, and do **not** add a post-open `chmod` — that defect is **#307**.

**F2 — `src/lib/tag-writer/mp3-publisher.ts`.** After `:46` (`const LINUX_CHILD_STAGE_FD = 4;`, end
of the terse block at `:35-46`, before the JSDoc'd `MAX_SYNCHRONOUS_MP3_RATING_FILE_BYTES` at
`:48-52`), append:

```ts
/**
 * Mode the rewritten stage is CREATED with, so a partially written MP3 is
 * unobservable to other users during the open-to-publish window. The stage
 * does NOT keep this mode: `preserveLinuxMp3Metadata` restores the source's
 * mode, ownership and xattrs via `cp --preserve=mode,ownership,xattr`, and
 * the pre-rename guard rejects any stage whose `mode & 0o7777` no longer
 * equals the source's. Deliberately NOT secure-store's PRIVATE_FILE_MODE,
 * which names a permanent property of a credential document; this stage
 * intentionally discards the mode it is created with.
 */
const STAGE_PRIVATE_MODE = 0o600;
```

Then at the staging open (now `:396`):

```ts
stageHandle = await open(stagePath, "wx+", STAGE_PRIVATE_MODE);
```

The name is deliberately identical to `filesystem.ts`'s because both name a staging floor, but they
stay module-local: the two stages have opposite post-stage mode contracts.

**F3 — `src/lib/conversion-metadata.ts`.** After `:40` (the close of `METADATA_CHILD_EXEC_ARGS` at
`:36-40`), append:

```ts
/**
 * Mode the ffmpeg metadata input descriptor is CREATED with. The file is
 * `unlink`ed immediately after its content is synced, so this mode's only
 * job is to narrow the open-to-unlink window; the payload is thereafter
 * reachable only through the retained descriptor and is never published
 * under a pathname. Deliberately NOT secure-store's PRIVATE_FILE_MODE,
 * which names a permanent property of an on-disk credential document —
 * this descriptor has no on-disk lifetime to protect.
 */
const UNLINKED_DESCRIPTOR_MODE = 0o600;
```

Then at the open (now `:717`), inside `createUnlinkedDescriptorInput`:

```ts
handle = await open(inputPath, "wx+", UNLINKED_DESCRIPTOR_MODE);
```

Do not touch the `0o022` parent gate at `:690`.

Expected shape: 3 files, 6 hunks, 0 new imports, 0 test edits.

### Gates

```bash
cd $P && grep -n '0o600\|0o700' src/lib/filesystem.ts src/lib/tag-writer/mp3-publisher.ts src/lib/conversion-metadata.ts
#   expect exactly 3 hits, all 'const ... = 0o600;' declarations, zero at a call site
cd $P && grep -c 'PRIVATE_FILE_MODE' src/lib/filesystem.ts src/lib/tag-writer/mp3-publisher.ts src/lib/conversion-metadata.ts
#   expect 1:1:1 — the word appears ONLY inside each new JSDoc
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/filesystem.test.ts        # 56 passed
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/tag-writer.test.ts        # 62 passed
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/conversion-metadata.test.ts   # 66 passed
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/convert.test.ts src/lib/tiered-verification.test.ts src/actions/reconcile.test.ts \
  src/lib/sync-helper.test.ts src/actions/plex-sync.test.ts
cd $W && git diff --stat -- \
  packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts \
  packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap   # expect EMPTY output
cd $W && npm run typecheck --workspace packages/rfmedia-cli && npm run build -w packages/rfmedia-cli
cd $W && npm run format:check && npm run test:run
```

Note: the design's gate table names `src/lib/tag-writer/*.test.ts`, a glob that matches **zero**
files — `src/lib/tag-writer/` contains only `mp3-publisher.ts`. The real suite is the sibling
`src/lib/tag-writer.test.ts`. Also, `filesystem.test.ts` reports **56** tests, not the design's "52
`it` blocks"; the gap is `it.each` expansion, not drift.

After the edits land, run `graphify update .` from the repo root per `CLAUDE.md`.

### Abort criteria

Any of the three suites needs an edit → the substitution was not value-identical. Revert. c4 is
independently revertible and blocks nothing except c6's `filesystem.ts:<n>` anchor.

---

## Commit 5 — `refactor(rfmedia): migrate Lidarr preset persistence and its origin lock onto secure-store`

### Scope

**Single file:** `src/lib/lidarr/profile-preset-persistence.ts` (1003 lines → ~810).
`src/lib/lidarr/profile-preset-persistence.test.ts` and `src/actions/lidarr/profile-presets.ts` are
**read-only inputs**. If any step requires editing the protected test, STOP — see Abort criteria.

Requires c1's full contract: `SECURE_STORE_MAX_PATH_LENGTH`, `SECURE_STORE_UUID_PATTERN`,
`SecureStoreLockOptions.{maxAgeMs,binding}`, `SecureStoreLock.{binding,assertOwned}` with an
idempotent `release()`, `isStale`'s `maxAgeMs === null` skip, and an async `readExistingLock` that
re-asserts `binding`. Verify each with `grep` in `src/lib/secure-store/` before editing.

### Edits

Apply **bottom-up** (highest line number first) so every cited line stays valid. E1…E18 are listed in
that order.

**E1 — `:950-1003` `createLidarrPresetApplyJournal`.** Two surgical replacements.

E1a, current `:970` (`let identity = await createAtomicFile(path, text, initial.id);`):

```ts
let identity: FileIdentity;
try {
  identity = await createPrivateFileAtomically({
    path,
    text,
    subject: JOURNAL_SUBJECT,
    temporaryId: initial.id,
  });
} catch (error) {
  throw translateJournalIo(error, path, "Unable to create preset apply journal");
}
```

E1b, current `:990` (`identity = await replaceAtomicFile(path, nextText, identity, initial.id);`):

```ts
try {
  identity = await replacePrivateFileAtomically({
    path,
    text: nextText,
    subject: JOURNAL_SUBJECT,
    temporaryId: initial.id,
    expectedIdentity: identity,
  });
} catch (error) {
  throw translateJournalIo(error, path, "Unable to update preset apply journal");
}
```

`serializeAndValidateJournal` (`:988`) and `assertTransition` (`:989`) stay **outside** the inner
`try`. The outer `try { … } finally { writing = false; }` is unchanged, as is
`await lock.assertOwned()` at **`:987`** (the design says `:988`; the real line is `:987`). Do not
touch `:954-957`, `:968` or `:969`.

**E2** — delete `:904-947` `replaceAtomicFile`.
**E3** — delete `:858-902` `createAtomicFile`.

**E4 — `:745-856` replace the body of `acquireLidarrPresetApplyLock`.** Keep the JSDoc at `:744` and
the exported signature at `:745-748` **byte-identical** (this is what keeps
`src/actions/lidarr/profile-presets.test.ts:458`'s single-argument
`toHaveBeenCalledWith("https://lidarr.example.test")` green). Replace `:749-856`:

```ts
  const origin = canonicalizeOrigin(canonicalOrigin);
  const digest = originDigest(origin);
  const storageDirectory = resolveStoragePath(
    dependencies.storageDirectory ?? join(getDefaultPlanDir(), "lidarr-preset-applies"),
  );
  const lockPath = join(storageDirectory, "locks", `${digest}.lock`);
  const host = dependencies.hostname?.() ?? nodeHostname();
  const pid = dependencies.pid ?? process.pid;
  if (!validString(host) || !Number.isSafeInteger(pid) || pid <= 0) {
    throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset lock owner metadata is invalid");
  }
  // Preserves the ownership-token half of the pre-migration owner-metadata check:
  // an injected UUID seam that yields a non-UUIDv4 is owner-metadata corruption,
  // not a lock failure. Thrown from inside `acquireExclusiveLock`, it reaches the
  // translator below as a LidarrPresetPersistenceError and is rethrown unchanged.
  const randomUUID = (): string => {
    const value = (dependencies.randomUUID ?? nodeRandomUUID)();
    if (!SECURE_STORE_UUID_PATTERN.test(value)) {
      throw fail("LIDARR_PRESET_JOURNAL_INVALID", "Preset lock owner metadata is invalid");
    }
    return value;
  };
  const nowSource = dependencies.now;
  const nowMs = nowSource === undefined ? Date.now : (): number => nowSource().getTime();

  let held: SecureStoreLock;
  try {
    held = await acquireExclusiveLock(lockPath, {
      subject: LOCK_SUBJECT,
      // Fail fast: zero wait. A contended acquire reaches the deadline check with
      // `remainingMs === 0` and throws SECURE_STORE_LOCK_BUSY on the first pass,
      // reproducing the pre-migration semantics exactly. The sole production
      // caller acquires this lock before its AbortController and its Ctrl-C
      // cleanup handler exist, so a waiting acquisition would be uninterruptible.
      deadlineEpochMs: nowMs(),
      // No age-based steal. A preset apply drives per-entry network mutations with
      // assertOwned() between each and routinely exceeds SECURE_STORE_LOCK_MAX_AGE_MS;
      // the default would let a second process steal a LIVE owner's lock cross-host.
      maxAgeMs: null,
      // Replaces the bespoke `originDigest` record key and its cross-check.
      binding: digest,
      now: nowMs,
      hostname: () => host,
      pid,
      // Deliberately this module's own probe, not `isProcessAliveByDefault`: an
      // unknown errno means ALIVE here and DEAD there. Migrating a lock must not
      // silently migrate its liveness policy.
      isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive,
      randomUUID,
    });
  } catch (error) {
    throw translateLockFailure(error, lockPath, "Unable to acquire preset apply lock");
  }

  const state: OwnedLockState = { canonicalOrigin: origin, storageDirectory };
  const lock: LidarrPresetApplyLock = {
    path: held.path,
    originDigest: digest,
    assertOwned: async (): Promise<void> => {
      try {
        await held.assertOwned();
      } catch (error) {
        throw fail(
          "LIDARR_PRESET_LOCK_LOST",
          "Preset apply lock is no longer owned",
          held.path,
          error,
        );
      }
    },
    release: async (): Promise<void> => {
      try {
        await held.release();
      } catch (error) {
        // A record we cannot parse is not ours: the pre-migration `readLock`
        // swallowed the same case to `undefined`, so release resolved without
        // unlinking. `release()` runs inside a `finally` in the sole production
        // caller, so a throw here would mask the real failure.
        if (error instanceof SecureStoreError && error.code === "SECURE_STORE_CORRUPT") return;
        throw translateLockFailure(error, held.path, "Unable to release preset apply lock");
      }
    },
  };
  ownedLocks.set(lock, state);
  return Object.freeze(lock);
}
```

Load-bearing points, each tied to a protected test line:

- `deadlineEpochMs: nowMs()` → `:105-107` and `:142-144`. Frozen clock at `:91` ⇒ `remainingMs === 0`
  exactly; in production `Date.now()` has advanced ⇒ `< 0`. Either way, `LOCK_BUSY` with no sleep.
- `maxAgeMs: null` protects a live >120 s apply. Pinned by c1's new test, not by this suite.
- `binding: digest` replaces the `originDigest` record key and the `:683-698` cross-check. `:109`
  reads `originDigest` off the **lock object**; `:184-186` re-serializes parsed JSON key-agnostically.
- `hostname: () => host` (not `dependencies.hostname`) so the **validated** host is recorded and the
  injected seam is called exactly once.
- `originDigest: digest` on the wrapper → `:109` and `src/actions/lidarr/profile-presets.ts:602`
  (the design/brief cite `:616`; the real line is `:602`).
- **The `ownedLocks` WeakMap survives because the returned object is still OUR wrapper**, not the
  `SecureStoreLock`. `held` is captured in the two closures and never escapes; `Object.freeze`
  returns the same reference, so `ownedLocks.get(lock)` at `:954` still hits.
- `assertOwned()` has its **own** catch-all → `LIDARR_PRESET_LOCK_LOST` (`:188`). Routing it through
  `translateLockFailure` (which maps `LOCK_BUSY` → `ALREADY_RUNNING`) is the single mistake that
  turns `:188` red.
- `release()` never unlinks a displaced lock: c1's `unlinkLockIfOwned` fails on the `{dev,ino}` axis
  → `:190`. Double `release()` is a no-op via c1's latch → `:110-111`.

**E5** — delete `:730-740` `unlinkLockIfOwned`.
**E6** — delete `:714-728` `lockIsOwned`.
**E7** — delete `:700-712` `readLock`.
**E8** — delete `:683-698` `parseLockRecord`. Keep `:742`'s `ownedLocks` WeakMap exactly as is.

**E9 — `:598`:** `!UUID_PATTERN.test(journal.id) ||` → `!SECURE_STORE_UUID_PATTERN.test(journal.id) ||`.
This is the only surviving use once E8 lands. The two regexes are byte-identical, no `g` flag.

**E10** — delete `:242-272` `readBoundedFile`.
**E11** — delete `:227-240` `syncDirectory` and `removeIfPresent`.
**E12** — delete `:215-225` `assertOpenedFileIdentity`, `:203-213` `assertSafeParentUnchanged`,
`:173-201` `prepareSafeParent`, `:146-171` `assertSafeDirectory` (the whole walk, `:146-273`).

**E13 — `:135`:** `inputPath.length > MAX_PATH_LENGTH ||` →
`inputPath.length > SECURE_STORE_MAX_PATH_LENGTH ||`. The rest of `resolveStoragePath` is untouched.

**E14** — delete `sameIdentity` (`:114-116`); **keep** `hasCode` (`:110-112`) — still consumed by
`defaultIsProcessAlive` at `:307`.

**E15 — `:84-108`.** Delete `interface FileIdentity` (`:84-87`), `interface SafeParent` (`:89-92`),
`interface LockRecord` (`:94-100`). Replace `OwnedLockState` (`:102-108`) with:

```ts
interface OwnedLockState {
  readonly canonicalOrigin: string;
  readonly storageDirectory: string;
}
```

**E16 — `:20-32` constants.** Delete `:20` `PRIVATE_DIRECTORY_MODE`, `:21` `PRIVATE_FILE_MODE`,
`:22` `MAX_PATH_LENGTH`, `:23` `LOCK_MAX_BYTES`, `:29` `UUID_PATTERN`. **Do not import
`PRIVATE_FILE_MODE`/`PRIVATE_DIRECTORY_MODE`** — after full delegation this module has zero
references to either (all six use sites are deleted), so importing them would be dead code and would
break the design's amended check 2a. Keep `:24` `LIDARR_PRESET_JOURNAL_MAX_BYTES`, `:25-28` the
journal bounds, `:30` `DIGEST_PATTERN`, `:31` `TERMINAL_CONTROL_PATTERN`, `:32`
`SENSITIVE_KEY_PATTERN`. Add:

```ts
const LOCK_SUBJECT = "Lidarr preset apply lock";
const JOURNAL_SUBJECT = "Lidarr preset apply journal";
```

**E17 — add the two translators immediately after `fail()` (after current `:130`):**

```ts
/**
 * Maps a shared-store failure raised by the origin lock back onto this module's
 * code taxonomy.
 *
 * `rethrowAsSecureStoreError` maps only ELOOP/ENOTDIR and EACCES/EPERM and
 * rethrows every other errno RAW, and `src/commands/lidarr.ts:258-281` reads
 * `.code` structurally off any thrown object and forwards it into the machine
 * envelope. The explicit non-SecureStoreError arm below is what stops an
 * ENOSPC/EIO/EROFS replacing `LIDARR_PRESET_IO` in user-visible output.
 */
function translateLockFailure(error: unknown, lockPath: string, message: string): LidarrPresetPersistenceError {
  if (error instanceof LidarrPresetPersistenceError) return error;
  if (error instanceof SecureStoreError) {
    switch (error.code) {
      case "SECURE_STORE_LOCK_BUSY":
      case "SECURE_STORE_CORRUPT":
        return fail("LIDARR_PRESET_ALREADY_RUNNING", "Another preset apply owns this Lidarr origin", lockPath, error);
      case "SECURE_STORE_UNSAFE_PATH":
      case "SECURE_STORE_PERMISSIONS":
        return fail("LIDARR_PRESET_UNSAFE_PATH", message, lockPath, error);
      default:
        return fail("LIDARR_PRESET_IO", message, lockPath, error);
    }
  }
  return fail("LIDARR_PRESET_IO", message, lockPath, error);
}

/** Maps a shared-store failure raised by the journal writers. */
function translateJournalIo(error: unknown, path: string, message: string): LidarrPresetPersistenceError {
  if (error instanceof LidarrPresetPersistenceError) return error;
  if (error instanceof SecureStoreError) {
    switch (error.code) {
      case "SECURE_STORE_UNSAFE_PATH":
      case "SECURE_STORE_PERMISSIONS":
        return fail("LIDARR_PRESET_UNSAFE_PATH", message, path, error);
      case "SECURE_STORE_TOO_LARGE":
        return fail("LIDARR_PRESET_JOURNAL_TOO_LARGE", message, path, error);
      case "SECURE_STORE_VERSION_CONFLICT":
        return fail("LIDARR_PRESET_JOURNAL_EXISTS", message, path, error);
      case "SECURE_STORE_CORRUPT":
        return fail("LIDARR_PRESET_JOURNAL_INVALID", message, path, error);
      default:
        return fail("LIDARR_PRESET_IO", message, path, error);
    }
  }
  return fail("LIDARR_PRESET_IO", message, path, error);
}
```

`noFallthroughCasesInSwitch` is on; grouped `case` labels with no statements between them are legal.
No `any`, no non-null assertion.

**E18 — `:3-18` imports.** Replace `:3-9` with:

```ts
import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { hostname as nodeHostname } from "node:os";
import { join, resolve } from "node:path";
```

(`node:fs`, `node:fs/promises`, `Stats`, `FileHandle`, and `dirname`/`parse`/`relative`/`sep` all
lose their last consumer.) After `import { getDefaultPlanDir } from "../plan.js";` (`:18`), add:

```ts
import {
  acquireExclusiveLock,
  createPrivateFileAtomically,
  replacePrivateFileAtomically,
  SECURE_STORE_MAX_PATH_LENGTH,
  SECURE_STORE_UUID_PATTERN,
  SecureStoreError,
} from "../secure-store/index.js";
import type { FileIdentity, SecureStoreLock } from "../secure-store/index.js";
```

`verbatimModuleSyntax: true` ⇒ the type import must be a separate `import type`. Barrel import only.
`readBoundedPrivateFile` is deliberately **not** imported: the lock read now happens inside
`readExistingLock` and the journal is never read back.

### Error-translation reference

Acquisition (`translateLockFailure`):

| From                                                    | To                              | Pinned by                                                                                    |
| ------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `LidarrPresetPersistenceError`                          | rethrown                        | `canonicalizeOrigin` (`:276`, `:282`, `:293`), the validated-UUID seam, `resolveStoragePath` |
| `SECURE_STORE_LOCK_BUSY`                                | `LIDARR_PRESET_ALREADY_RUNNING` | tests `:107`, `:167`; instance check `:144`                                                  |
| `SECURE_STORE_CORRUPT`                                  | `LIDARR_PRESET_ALREADY_RUNNING` | matches today's swallow-to-`undefined` (`:708-711`) ⇒ not-stale ⇒ `:841-847`                 |
| `SECURE_STORE_UNSAFE_PATH` / `SECURE_STORE_PERMISSIONS` | `LIDARR_PRESET_UNSAFE_PATH`     | test `:180`                                                                                  |
| anything else (raw errno)                               | `LIDARR_PRESET_IO`              | the explicit non-`SecureStoreError` arm                                                      |

`assertOwned()` has its **own** arm: **any** rejection → `LIDARR_PRESET_LOCK_LOST` (test `:188`;
`:151` must still resolve).

`release()`: `SECURE_STORE_CORRUPT` is **swallowed** (parity with `:700-711` → `:735` → `false`);
everything else goes through `translateLockFailure` with a release-specific message.

Journal I/O (`translateJournalIo`): `UNSAFE_PATH`/`PERMISSIONS` → `LIDARR_PRESET_UNSAFE_PATH`
(test `:330`), `VERSION_CONFLICT` → `LIDARR_PRESET_JOURNAL_EXISTS` (`atomic.ts:151`), `TOO_LARGE` →
`LIDARR_PRESET_JOURNAL_TOO_LARGE`, `CORRUPT` → `LIDARR_PRESET_JOURNAL_INVALID`, else
`LIDARR_PRESET_IO`.

### Accepted behaviour deltas

Design-sanctioned: 6 (`originDigest` → `binding` on disk), 7 (`CORRUPT` ⇒ `ALREADY_RUNNING`), 8 (new
`0o077` read gate on the lock file), 9 (`maxAgeMs: null`), 11 (stage cleanup `catch` → `finally`), 12
(raw errnos ⇒ `LIDARR_PRESET_IO`). Plus `EACCES`/`EPERM` on the lock path moves from
`LIDARR_PRESET_IO` to `LIDARR_PRESET_UNSAFE_PATH`.

Four **additional** deltas the design does not enumerate, all untested, all error-path-only, all
accepted (see "Corrections applied" C10–C12):

1. An oversized (>4 KiB) lock file moves from `LIDARR_PRESET_JOURNAL_TOO_LARGE` to
   `LIDARR_PRESET_IO`.
2. Owner-metadata validation now runs **before** the safe-parent walk, so a call that is
   simultaneously unsafe-path and invalid-metadata reports `JOURNAL_INVALID` rather than
   `UNSAFE_PATH`.
3. The exact-key guard is gone: `profile-preset-persistence.ts:686`'s
   `exactKeys(value, ["host","pid","createdAt","ownershipToken","originDigest"])` rejected any
   extra-keyed record; `lock.ts`'s `parseLockRecord` ignores extras. A same-host / dead-pid record
   carrying an extra key is now **stolen** where it was previously left alone.
4. A caller injecting `dependencies.randomUUID` now also pins the **staging** file name:
   `lock.ts:301-307` forwards `randomUUID` into `createPrivateFileAtomically`, and
   `atomic.ts:119-121` uses it for the stage suffix. Today `profile-preset-persistence.ts:772`
   always uses `nodeRandomUUID()` for the stage. A resulting `EEXIST` from
   `atomic.ts:88-92`'s `O_EXCL` open is not mapped by `errors.ts:194-202` and would land in
   `translateLockFailure`'s `default` arm as `LIDARR_PRESET_IO`. Unreachable in the protected suite —
   every acquisition there is sequential, and `atomic.ts:161-167`'s `finally` drops the stage on
   every path.

Not changed: the exported signature, the returned lock's public shape
(`{ path, originDigest, assertOwned, release }`), every `LidarrPresetPersistenceErrorCode`, every
journal validator, `resolveStoragePath`, `canonicalizeOrigin`, `originDigest`,
`defaultIsProcessAlive`, `LIDARR_PRESET_JOURNAL_MAX_BYTES`, and the contention message.

### Gates

```bash
cd $W && git diff --exit-code -- \
  packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts \
  packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap \
  packages/rfmedia-cli/src/actions/lidarr/profile-presets.test.ts
cd $P && test "$(grep -c 'message' src/lib/lidarr/profile-preset-persistence.test.ts)" = 0 \
  && test "$(grep -c 'code:' src/lib/lidarr/profile-preset-persistence.test.ts)" = 10 \
  && echo ABORT_CRITERION_OK
cd $P && test "$(grep -c '0o600\|0o700' src/lib/lidarr/profile-preset-persistence.ts)" = 0 && echo NO_MODES
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/profile-preset-persistence.test.ts
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run src/actions/lidarr/profile-presets.test.ts
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts
cd $P && umask 022 && env -u FORCE_COLOR npx vitest run \
  src/lib/plan.test.ts src/lib/lidarr/plan-engine.test.ts src/commands/lidarr.test.ts
cd $W && npm run typecheck --workspace packages/rfmedia-cli && npm run build -w packages/rfmedia-cli
cd $W && npm run test:run && npm run format:check && npm run lint:md
```

**Every command above is absolute-path-prefixed for a reason.** The main checkout at
`/home/yandy/Projects/github.com/yandy-r/rfmedia-apps` sits at the same HEAD with its own
`node_modules`, so a relative-path gate would run the **pre-migration** module and pass vacuously.

### Abort criteria

**Drop this commit** (do not fix, do not negotiate) if any of these hold:

- `src/lib/lidarr/profile-preset-persistence.test.ts` requires an edit of any kind.
- `grep -c 'message'` is not 0, or `grep -c 'code:'` is not 10, in that file.
- `src/actions/lidarr/profile-presets.test.ts` requires an edit.

**If c5 is dropped, c6 and c7 must be re-authored before landing.** Concretely:

- c6 §8 loses its "What #288 shipped" paragraph and its "exactly two lock implementations" sentence,
  and the `CORRECTIONS_OK` gate's `grep -q 'exactly two lock implementations'` clause must go.
- c6 must add a sixth follow-up issue for the preset-lock migration itself, and §9 gains its row.
- c7's exit criterion drops the delegation clause, and the `OK-exit-criterion-amended` gate string
  changes with it.

`git revert` of c5 restores the file wholesale with no dependency on c2–c4, but reverting c1
requires reverting c5 first.

---

## Commit 6 — `docs(internal): record the secure-store migration and correct the duplicate-site inventory`

### Scope

Docs-only, one file: `docs/internal/plex-jwt-deferrals.md` (**repo root**;
`packages/rfmedia-cli/docs/internal/` does not exist). Baseline **208 lines**; `prettier --check`
clean; `lint:md` 0 errors. All four design-cited anchors are exact: header `:8`, Q4 row `:79`, §8
item 1 `:152-157`, §9 `#288` row `:185`.

**PRE-STEP 0 is now a verification step, not a filing step.** The five follow-up issues the design
marks `Follow-up issue? **Yes**` **already exist**:

| Design row                                       | Issue    | Title                                                                                  | Labels                                           |
| ------------------------------------------------ | -------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| plan-engine claim lock (`:4652-4818`)            | **#304** | Migrate the Lidarr plan claim lock onto `src/lib/secure-store`                         | `rfmedia-cli`, `architecture`, `priority:medium` |
| plan / plan-engine walks + writers               | **#305** | Migrate `plan.ts` and `plan-engine.ts` path walks and atomic writers onto secure-store | `rfmedia-cli`, `architecture`, `priority:low`    |
| `plan.ts:1178` chmod-by-path                     | **#306** | `plan.ts` hardens the published artifact by path after rename                          | `rfmedia-cli`, `priority:low`                    |
| `filesystem.ts:939` missing post-open chmod      | **#307** | `verify --fix` publishes a read-only file under a restrictive umask                    | `bug`, `rfmedia-cli`, `priority:low`             |
| `profile-preset-persistence.ts:766` journal code | **#308** | Lock owner metadata failure is reported with a journal error code                      | `rfmedia-cli`, `priority:low`                    |

Confirm with `gh issue view <n> --json number,title,state` before editing. **#303 is a merged PR, not
an issue** — do not link it. If any of #304–#308 is missing, file it from the matching
`.github/ISSUE_TEMPLATE/` YAML form via `--body-file` (`gh issue create --template` is unreliable for
YAML forms here) using only labels that already exist in `gh label list`; there is no `security`
label.

### Edits

**Apply strictly bottom-up: A → B → C → D.** Edit D inserts a line at `:5` and would invalidate every
later anchor.

**Edit A — §9 follow-up table (`:179-186`).**

A.1 — insert between the blank `:180` and the table header `:181` (the trailing blank line is
**mandatory**; without it prettier stops recognizing the following block as a table and mangles the
header):

```markdown
The first four were filed while closing #251. The rest were filed while closing #288, whose verification widened the
duplicate-site inventory and surfaced two defects that must not ship inside a chore commit (§8 item 1).
```

A.2 — replace the `#288` row at `:185` with:

```text
| [#288](https://github.com/yandy-r/rfmedia-apps/issues/288) | chore | Migrate the duplicate private-file-mode primitives onto `src/lib/secure-store`. **Resolved** — see §8 item 1 for what shipped and what deferred. |
```

A.3 — append after `:186`:

```text
| [#304](https://github.com/yandy-r/rfmedia-apps/issues/304) | chore | Migrate the `lidarr/plan-engine.ts` claim lock onto `secure-store` — deferred from #288. |
| [#305](https://github.com/yandy-r/rfmedia-apps/issues/305) | chore | Migrate the `plan.ts` / `lidarr/plan-engine.ts` path walks and atomic writers — deferred from #288; depends on #304. |
| [#306](https://github.com/yandy-r/rfmedia-apps/issues/306) | security | `plan.ts` chmods the published artifact **by path** after the rename — `chmod(2)` follows symlinks. Found by #288, deliberately not bundled into a chore commit. |
| [#307](https://github.com/yandy-r/rfmedia-apps/issues/307) | bug | `filesystem.ts` never chmods the stage after opening it, so a `0277` umask publishes a `0o400` destination on the non-converting `verify --fix` path. Found by #288. |
| [#308](https://github.com/yandy-r/rfmedia-apps/issues/308) | chore | `profile-preset-persistence.ts` reports `LIDARR_PRESET_JOURNAL_INVALID` for bad **lock** owner metadata. Pre-existing; renaming it is a user-visible code change. |
```

Prettier re-pads all nine rows (the `#307` row widens the Scope column). Expected mechanical churn.

**Edit B — §8 item 1 (`:152-157`).** Delete all six lines and replace with (3-space continuation
indent throughout; `_transient stage-privacy floor_` must use `_`, not `*` — prettier rewrites `*`):

```markdown
1. **Duplicated private-file primitives — corrected here, and resolved by [#288](https://github.com/yandy-r/rfmedia-apps/issues/288).** Per §15 Q4,
   `src/lib/secure-store/` shipped as new code **modelled on** `lidarr/profile-preset-persistence.ts` rather than an
   extraction from it, and that module was untouched by #251. Two claims recorded here were wrong and are corrected.

   **Correction 1 — six, not four.** Six expressions in production carried a `0o600`/`0o700` private mode, not four:
   named `PRIVATE_DIRECTORY_MODE` / `PRIVATE_FILE_MODE` pairs in `profile-preset-persistence.ts`, `plan.ts` and
   `lidarr/plan-engine.ts`, plus three inline `open(path, "wx+", 0o600)` literals in `filesystem.ts`,
   `tag-writer/mp3-publisher.ts` and `conversion-metadata.ts`. The last two appear in neither the original inventory
   nor [#288](https://github.com/yandy-r/rfmedia-apps/issues/288)'s own text.

   **Correction 2 — `filesystem.ts` is not an "owner-only file/directory mode".** Its `0o600` is a _transient
   stage-privacy floor_: the stage is created private so a half-built artifact is unobservable, then **relaxed** to
   the computed publish mode by `stagedHandle.chmod(publishMode)` at `filesystem.ts:<N>` — the only `chmod` in the
   file. Conversions publish at ~`0o644` and `filesystem.test.ts` pins `0o640`/`0o604`, so importing
   `PRIVATE_FILE_MODE` there would have encoded a false invariant and invited a later "consistency" pass to break
   three tests. All three inline literals took a named local constant instead (`STAGE_PRIVATE_MODE` in
   `filesystem.ts` and `tag-writer/mp3-publisher.ts`, `UNLINKED_DESCRIPTOR_MODE` in `conversion-metadata.ts`).

   **What #288 shipped.** `profile-preset-persistence.ts` delete-and-delegates its safe-parent walk, bounded reader,
   both atomic writers and its origin lock onto `secure-store`, shedding ~250 lines with its test file unmodified.
   `plan.ts` and `lidarr/plan-engine.ts` take the constants only.

   **What still duplicates: exactly two lock implementations, deliberately.** `secure-store`'s
   `acquireExclusiveLock` — now shared by the Plex credential store **and** the Lidarr preset apply lock — and
   `lidarr/plan-engine.ts`'s bespoke claim lock, which is **not** migrated. The claim lock is deferred because
   `plan-engine.test.ts` requires a corrupt partial claim to yield `LidarrPlanAlreadyRunningError` **and** be left
   byte-identical where `secure-store` throws `SECURE_STORE_CORRUPT`; because its staleness policy inverts under the
   shared age rule; and because `claim.assertOwned` is threaded through 68 references across 15 files under
   `src/actions/lidarr/`. The `plan.ts` / `lidarr/plan-engine.ts` path walks and atomic writers are deferred on their
   own evidence: the shared reader's `mode & 0o077` gate fires **before** its size check and would reclassify three
   `plan-engine.test.ts` fixtures, three plan-engine callers classify on the raw errno the local walk rethrows, and a
   `plan.test.ts` parent directory created with no mode is group-writable under `umask 002`. Both deferrals and the
   two defects found on the way are tracked in §9.
```

The trailing blank line before item `2.` is required (prettier makes a multi-paragraph list item
loose and inserts it anyway).

**B.1 (mandatory) — re-derive the `filesystem.ts` anchor.** `:1022` is the **pristine** value; c4
inserts ~10 lines above it. Before writing Edit B, run:

```bash
cd $W && grep -n 'chmod(publishMode)' packages/rfmedia-cli/src/lib/filesystem.ts
```

Assert exactly one hit and substitute its line number for `<N>`. Zero or more than one hits ⇒ c4 did
not land as designed; stop.

**B.2 — facts asserted, all re-verified:** `grep -rn assertOwned src/actions/lidarr/ | wc -l` → 68;
`grep -rln … | wc -l` → 15; `wc -l src/lib/lidarr/profile-preset-persistence.ts` → 1003;
`grep -n chmod src/lib/filesystem.ts` → exactly one hit.

**Edit C — §4 Q4 row (`:79`).** Replace the single line with:

```text
| Q4 — refactor `lidarr/profile-preset-persistence.ts`? | **NO** for #251, **YES** under [#288](https://github.com/yandy-r/rfmedia-apps/issues/288). `src/lib/secure-store` shipped consumed **only** by the Plex credential store; `profile-preset-persistence.ts` was **untouched** in that PR and now delegates to `secure-store`. | Minimal blast radius wins inside a credential PR: that module is 1003 lines of already-hardened, shipped, security-critical code. The duplication was temporary and tracked by a follow-up issue. The bet held: because `secure-store` was authored as a general-purpose module, the later migration was a delete-and-delegate rather than a rewrite, and `profile-preset-persistence.test.ts` passed unmodified. |
```

Prettier re-pads all six lines of the §4 table.

**Edit D — header block.**

D.1 — replace `:8` with:

```text
**Follow-up issues:** [#286](https://github.com/yandy-r/rfmedia-apps/issues/286), [#287](https://github.com/yandy-r/rfmedia-apps/issues/287), [#288](https://github.com/yandy-r/rfmedia-apps/issues/288) (resolved — see §8 item 1), [#289](https://github.com/yandy-r/rfmedia-apps/issues/289), and the five filed while closing #288 (§9)
```

D.2 — insert as the new `:5`, immediately after `**Date:** 2026-07-28`:

```text
**Amended:** 2026-07-30 — §4 Q4, §8 item 1 and §9 updated while closing [#288](https://github.com/yandy-r/rfmedia-apps/issues/288); anchors added by that amendment are stated against the `chore/288-secure-store` tree
```

This is one addition beyond the design's literal enumeration and is a truthfulness repair, not a
redesign: `**Date:** 2026-07-28` would otherwise silently cover 2026-07-30 content, and `:13` states
that all line anchors are "stated against base commit `85909525`", which the new `filesystem.ts:<N>`
anchor is not.

**Final normalization:** `cd $W && npx prettier --write docs/internal/plex-jwt-deferrals.md`.

**Do NOT touch:** any other file (`ROADMAP.md` belongs to c7); §2, §3, §5, §6, §7, §10; §8 items 2-5
and the `Deliberately **not** filed` paragraph at `:188-190`; the frozen design of record.

### Gates

```bash
cd $W && git diff --name-only | sort | tr '\n' ' ' | grep -qx 'docs/internal/plex-jwt-deferrals.md ' && echo SCOPE_OK
cd $W && test "$(wc -l < docs/internal/plex-jwt-deferrals.md)" -ge 240 && echo LENGTH_PLAUSIBLE
cd $W && test "$(grep -c 'chmod(publishMode)' packages/rfmedia-cli/src/lib/filesystem.ts)" = 1 \
  && grep -qF "filesystem.ts:$(grep -n 'chmod(publishMode)' packages/rfmedia-cli/src/lib/filesystem.ts | cut -d: -f1)" \
       docs/internal/plex-jwt-deferrals.md && echo ANCHOR_OK
cd $W && ! grep -q 'four places that independently express' docs/internal/plex-jwt-deferrals.md \
  && grep -q 'six, not four' docs/internal/plex-jwt-deferrals.md \
  && grep -q 'exactly two lock implementations' docs/internal/plex-jwt-deferrals.md && echo CORRECTIONS_OK
cd $W && test "$(grep -c '^| \[#' docs/internal/plex-jwt-deferrals.md)" = 9 && echo ROWS_OK
cd $W && for n in 304 305 306 307 308; do \
  grep -q "issues/$n" docs/internal/plex-jwt-deferrals.md || { echo "MISSING $n"; break; }; done; echo LINKS_CHECKED
cd $W && npm run lint:md && npm run format:check
cd $P && test "$(grep -c 'message' src/lib/lidarr/profile-preset-persistence.test.ts)" = 0 \
  && test "$(grep -c 'code:' src/lib/lidarr/profile-preset-persistence.test.ts)" = 10 && echo ABORT_CRITERION_OK
cd $W && git diff --quiet HEAD -- \
  packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts \
  packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap && echo PROTECTED_FILES_UNTOUCHED
cd $W && npm run test:run && npm run typecheck --workspace packages/rfmedia-cli
```

The line-count gate is a **lower bound**, not an equality: the exact post-prettier length depends on
table re-padding and on the final wording. `lint:md` + `format:check` + `ROWS_OK` are the real
structural proofs.

### Abort criteria

`ANCHOR_OK` fails ⇒ c4 did not land as designed; fix c4 first. Otherwise nothing here is droppable
independently of c5 — see c5's abort clause.

---

## Commit 7 — `docs(roadmap): close the secure-store private-file migration (#288)`

### Scope

Docs-only: `ROADMAP.md` (260 lines) **and** `docs/roadmap-archive.md` (234 lines).

**The design's premise for this commit has changed and its own stated condition now resolves the
other way.** design.md:816-818 says "Per `ROADMAP.md:257-259` nothing moves to
`docs/roadmap-archive.md`, because the post-JWT-hygiene sprint only closes once issue #289 closes
too." **#289 closed on 2026-07-30T18:37:38Z** via merged PR #303
(`gh issue view 289 --json state` → `CLOSED`). With #288 closing on merge, the
`### Parallel — rfmedia post-JWT hygiene` sprint closes in full, and `ROADMAP.md:258-259` then
directs the narrative to the archive. Applying the design's condition to current facts is not a
redesign.

**No bespoke "follow-ups (file as issues)" section.** The five follow-ups are filed (#304–#308), so
they go into the existing rfmedia-cli backlog tables under their own priority labels, which is the
repo's own taxonomy-driven placement and removes the scope creep entirely.

### Edits

**Apply strictly bottom-up: G1 → G7.** Run `npx prettier --write ROADMAP.md docs/roadmap-archive.md`
once, after all of them. There are **seven** ROADMAP edits plus one archive edit.

**G1 — low-priority rfmedia table.** Append after the `#287` row (currently `:237`, the last row
before `</details>` at `:239`):

```text
| [#305](https://github.com/yandy-r/rfmedia-apps/issues/305) | Migrate plan / plan-engine walks and atomic writers      |
| [#306](https://github.com/yandy-r/rfmedia-apps/issues/306) | `plan.ts` hardens the published artifact by path         |
| [#307](https://github.com/yandy-r/rfmedia-apps/issues/307) | `verify --fix` publishes read-only under a tight umask   |
| [#308](https://github.com/yandy-r/rfmedia-apps/issues/308) | Preset lock failure reports a journal error code         |
```

Then update the `<summary>` line at `:210` to include `#305–#308` in its range list.

**G2 — low-priority heading (`:208`).** `### Low priority — docs, polish & future ideas (23)` →
`(27)`.

**G3 — medium-priority table (`:164-165`).** Delete both rows:

```text
| [#288](https://github.com/yandy-r/rfmedia-apps/issues/288) | Migrate duplicate private-file-mode primitives onto `secure-store` |
| [#289](https://github.com/yandy-r/rfmedia-apps/issues/289) | `validatePlexConfigOptions` drops three declared fields            |
```

and append one row in their place:

```text
| [#304](https://github.com/yandy-r/rfmedia-apps/issues/304) | Migrate the Lidarr plan claim lock onto `secure-store`   |
```

`#288` closes with this PR; `#289` is already closed, and `ROADMAP.md:258` ("When closing work,
update … the relevant backlog table") makes removing a closed row part of the same edit rather than
scope creep. Row count: 11 − 2 + 1 = **10**.

**G4 — medium-priority heading (`:151`).** `### Medium priority — copy, verify & metadata (11)` →
`(10)`.

**G5 — delete the closed sprint (`:48-60`).** Remove the whole block: the
`### Parallel — rfmedia post-JWT hygiene` heading (`:48`), its intro (`:50-51`), its two-row table
(`:53-56`), the exit criterion (`:58-59`), and the trailing blank (`:60`). `### Sprint 2 — Lidarr
policy follow-through` (`:61`) becomes the first `###` under `## Next Up`.

**G6 — Current focus narrative (`:37-39`).** Before:

```text
[`docs/internal/plex-jwt-deferrals.md`](docs/internal/plex-jwt-deferrals.md). Near-term focus is
rfmedia post-JWT hygiene (#288, #289) and filing the #209 policy follow-ups before larger Lidarr
Phase E work.
```

After:

```text
[`docs/internal/plex-jwt-deferrals.md`](docs/internal/plex-jwt-deferrals.md). The rfmedia post-JWT
hygiene sprint has closed (#288, #289); near-term focus is filing the #209 policy follow-ups and the
`secure-store` migration follow-ups (#304-#308) before larger Lidarr Phase E work.
```

**G7 — issue-count line (`:10`).** This is an **explicit edit**, not a do-not-touch. `ROADMAP.md:257`
makes regenerating it part of closing work, and the value is wrong in two independent ways today: the
line reads `79 (rfapps 36 · rfmedia 43)` while the live authoritative count is `84 (rfapps 36 ·
rfmedia 48)`. **Recompute at apply time**, counting #288 as closed:

```bash
gh issue list --state open --limit 300 --json number,labels | python3 -c "
import json,sys
d=json.load(sys.stdin)
n=lambda i:[l['name'] for l in i['labels']]
a=sum('rfapps-cli' in n(i) for i in d)
m=sum('rfapps-cli' not in n(i) and 'rfmedia-cli' in n(i) for i in d)
open288 = any(i['number']==288 for i in d)
print(f'**Open issues:** {len(d)-open288} (rfapps {a} · rfmedia {m-open288})')
"
```

Measured today this prints `**Open issues:** 83 (rfapps 36 · rfmedia 47)`. Write whatever it prints
at apply time.

**G8 — `docs/roadmap-archive.md`.** Two additions, matching precedent commit `df32f59a` exactly.

G8a — append a row to the `## What shipped` table, after the
`| Lidarr Layer 3 ratings sync | … |` row (`:31`):

```text
| rfmedia post-JWT hygiene             | [#288](https://github.com/yandy-r/rfmedia-apps/issues/288), [#289](https://github.com/yandy-r/rfmedia-apps/issues/289) | [#303](https://github.com/yandy-r/rfmedia-apps/pull/303), <this PR> |
```

Substitute the real PR number once it exists; if the PR is not yet open, write `#303` alone and add
the second link in the merge commit.

G8b — append item **16** to the `## Former "Next Up" sprints (all complete)` list (currently ends at
item 15, `:229`):

```text
16. rfmedia post-JWT hygiene — #288, #289
```

**Do NOT touch:** `:8` `**Last updated:** 2026-07-30` (already correct; change only if the commit is
authored on a later day, then set it to that day); `:27-32`'s shipped-epics sentence; anything under
`## Cross-cutting themes` or `## Maintenance`.

**Known staleness left alone, deliberately:** open issue **#302**
(`[chore] validateCopyConfig silently drops conflictStrategy`, `rfmedia-cli`, `priority:medium`) is
absent from every ROADMAP table. It is unrelated to #288 and post-dates the design. It is counted by
G7's recompute but not listed. File a separate `docs(roadmap):` hygiene commit outside this PR.

### Gates

```bash
cd $W && npx prettier --config .prettierrc --check ROADMAP.md docs/roadmap-archive.md
cd $W && npm run format:check && npm run lint:md
cd $W && test "$(grep -c '/issues/288' ROADMAP.md)" = 0 && echo OK_no_288_links
cd $W && test "$(grep -c '/issues/289' ROADMAP.md)" = 0 && echo OK_no_289_links
cd $W && ! grep -q '### Parallel — rfmedia post-JWT hygiene' ROADMAP.md && echo OK_sprint_retired
cd $W && grep -qxF '### Medium priority — copy, verify & metadata (10)' ROADMAP.md \
  && test "$(awk '/^### Medium priority — copy, verify & metadata \(10\)$/{f=1;next} f&&/^### /{exit} f&&/^\| \[#/{c++} END{print c+0}' ROADMAP.md)" = 10 \
  && echo OK_medium_count
cd $W && grep -qxF '### Low priority — docs, polish & future ideas (27)' ROADMAP.md \
  && test "$(awk '/^### Low priority — docs, polish & future ideas \(27\)$/{f=1;next} f&&/^## /{exit} f&&/^\| \[#/{c++} END{print c+0}' ROADMAP.md)" = 27 \
  && echo OK_low_count
cd $W && for n in 304 305 306 307 308; do grep -q "issues/$n" ROADMAP.md || echo "MISSING $n"; done; echo OK_followups_linked
cd $W && grep -q '16\. rfmedia post-JWT hygiene' docs/roadmap-archive.md && echo OK_archived
cd $W && test "$(git diff --name-only HEAD | sort | tr '\n' ' ' | xargs)" = 'ROADMAP.md docs/roadmap-archive.md' && echo OK_scope
cd $W && test -z "$(git diff --name-only origin/master...HEAD -- \
  packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts \
  packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap)" && echo OK_protected_untouched
cd $P && test "$(grep -c 'message' src/lib/lidarr/profile-preset-persistence.test.ts)" = 0 \
  && test "$(grep -c 'code:' src/lib/lidarr/profile-preset-persistence.test.ts)" = 10 && echo OK_abort_criterion
cd $W && npm run test:run
```

Verify the recomputed count matches what G7 wrote:

```bash
cd $W && grep -n '^\*\*Open issues:\*\*' ROADMAP.md   # compare against the G7 script's output
```

### Abort criteria

None that drops c7 alone. If c5 was dropped, re-author G5/G6 per c5's abort clause before landing.

---

## Corrections applied from validation

| #   | Validator defect                                                                                                                                                                                                                                                            | Verdict                                                                                                                     | How the plan handles it                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | c5's 11 gates are relative-path; the agent shell resets cwd to the main checkout, which is at the same HEAD with its own `node_modules`, so every c5 gate passes vacuously against the pre-migration file (two validators, independently)                                   | **CONFIRMED**                                                                                                               | Every gate in this plan, in every commit, is absolute-path prefixed. Stated once and prominently in "How to run the gates", and re-stated inside c5's gate block with the reason.                                                                                                                                                                                                                                                                                                                |
| C2  | c7 assumes #289 is OPEN; it is CLOSED                                                                                                                                                                                                                                       | **CONFIRMED** — `gh issue view 289` → `CLOSED`, `closedAt 2026-07-30T18:37:38Z`, via merged PR #303                         | c7 rewritten: the whole `### Parallel — rfmedia post-JWT hygiene` block is retired (G5), the exit criterion is not "amended" but deleted with it, the narrative stops naming #289 as remaining work (G6), the `#289` backlog row goes (G3), and `docs/roadmap-archive.md` gains the sprint (G8) per `ROADMAP.md:258-259`. The design's own stated condition ("only closes once #289 closes too") now resolves the other way.                                                                     |
| C3  | c6 files five issues while c7 says "not yet filed", contradicting each other inside one PR (two validators)                                                                                                                                                                 | **MOOT — resolved by fact**                                                                                                 | The five issues **already exist**: #304, #305, #306, #307, #308 (verified via `gh issue list`). c6's PRE-STEP 0 becomes a verification step. c7 drops the bespoke "file as issues" section entirely and files the five into the existing medium/low rfmedia backlog tables by their own priority labels. Both docs now link the same real numbers. Note: the c6 spec guessed #303–#307; **#303 is a merged PR**, not an issue.                                                                   |
| C4  | c7's "leave `ROADMAP.md:10` alone" rests on a wrong measurement (validators disagreed: 80 vs 79 vs 83)                                                                                                                                                                      | **CONFIRMED that the instruction is wrong; both validators' numbers are stale**                                             | Measured now: **84 open (rfapps 36 · rfmedia 48)**; #288 is OPEN and `rfmedia-cli`-labelled, so post-close is **83 (36 · 47)**. Both validators measured before #304–#308 were filed. G7 makes `:10` an explicit edit and **recomputes** it at apply time with a script rather than hardcoding, so further issue churn cannot invalidate it.                                                                                                                                                     |
| C5  | c7 scope creep: a new `###` ROADMAP section the design does not sanction, forward-referenced by the exit criterion                                                                                                                                                          | **ACCEPTED**                                                                                                                | The section is gone. The five follow-ups are ordinary linked rows in the two existing rfmedia backlog tables (G1, G3), placed by their own `priority:` labels. The exit criterion is deleted with the sprint, so nothing forward-references anything.                                                                                                                                                                                                                                            |
| C6  | c7 says "Edits 1–6" and "after all six" but defines seven; Edit 7 (Current focus `:37-39`) is one of the design's four coupled places and no gate catches its omission                                                                                                      | **CONFIRMED**                                                                                                               | c7 now enumerates G1–G8 explicitly, states "seven ROADMAP edits plus one archive edit", and the narrative edit is G6. Gate `OK_no_288_links` / `OK_no_289_links` catch an omitted narrative edit, because both issue numbers appear there.                                                                                                                                                                                                                                                       |
| C7  | c5 revert unit: reverting c5 alone does not leave c6/c7 standing, contradicting the design's rollback contract                                                                                                                                                              | **CONFIRMED** — c6's `CORRECTIONS_OK` greps `exactly two lock implementations`; c7's exit criterion asserted the delegation | Recorded in the commit graph ("revertible alone: **no**") and spelled out as an explicit re-authoring list in c5's Abort criteria.                                                                                                                                                                                                                                                                                                                                                               |
| C8  | c1 exports `readBoundedPrivateFile` from the barrel but no later commit consumes it; c5 explicitly does not import it                                                                                                                                                       | **PARTIALLY REJECTED**                                                                                                      | The function is not dead — `readExistingLock` (`lock.ts:166`) awaits it, and that is the event-loop-blocking fix. Only the _barrel re-export_ was unjustified. `readBoundedPrivateFileSync` is barrel-exported and consumed by `credential-store.ts:277` and `:386`, so the async twin is exported for parity. The justification is now written into its JSDoc (E1e) instead of leaning on a site-4 consumer that does not exist. Dropping the export would break c1's own no-deep-imports gate. |
| C9  | c1's new `release()`-path fsync adds a throw site inside a `finally`; the blocker text names only the Lidarr caller and misses the Plex one                                                                                                                                 | **CONFIRMED** — `credential-store.ts:469-471` is `finally { await lock.release(); }`                                        | E3h makes the release-path fsync best-effort: `await syncDirectory(parent.path).catch(() => undefined)`. Durability of an already-completed unlink is a hint, and the caller has lost the lock either way. This does not weaken c1's new test 4, which calls `syncDirectory` directly.                                                                                                                                                                                                           |
| C10 | c5 forwards the validated `randomUUID` closure, which `lock.ts:301-307` also uses as the **staging** file name via `atomic.ts:119-121`; a stage `EEXIST` is unmapped by `errors.ts:194-202` and would become `LIDARR_PRESET_IO` where today contention is `ALREADY_RUNNING` | **CONFIRMED by code**                                                                                                       | Accepted and documented as delta 4 in c5's "Accepted behaviour deltas". Not worked around: `acquireExclusiveLock` exposes one `randomUUID` option and the seam is required to preserve the `JOURNAL_INVALID` token validation. Unreachable in the protected suite (all acquisitions sequential; `atomic.ts:161-167`'s `finally` drops the stage on every path).                                                                                                                                  |
| C11 | c5 silently drops `exactKeys` (`ppp:686`), so an extra-keyed same-host/dead-pid record is now stolen instead of ignored                                                                                                                                                     | **CONFIRMED by code**                                                                                                       | Accepted and documented as delta 3. Not re-added: an exact-key check would reject the pre-#288 `originDigest` key and break the migration's own compatibility story, and the shared record is deliberately open-ended now that `binding` is optional.                                                                                                                                                                                                                                            |
| C12 | c5: oversized lock file reclassifies `JOURNAL_TOO_LARGE` → `IO`; owner-metadata validation moves ahead of the walk                                                                                                                                                          | **CONFIRMED (from c5's own blockers)**                                                                                      | Both documented as deltas 1 and 2. Untested, error-path-only, reachable only via an operator-planted >4 KiB lock file or a simultaneously-unsafe-and-invalid call.                                                                                                                                                                                                                                                                                                                               |
| C13 | c2/c3 `git status --porcelain` scope gates are false: `?? docs/plans/issue-288-secure-store-migration/` is always present                                                                                                                                                   | **CONFIRMED**                                                                                                               | Fixed two ways: **c0** commits the design + this plan first, so the tree is genuinely clean; and both gates are additionally pathspec-scoped (`git status --porcelain -- packages/rfmedia-cli \| grep -v <file>`) so they stay honest regardless.                                                                                                                                                                                                                                                |
| C14 | c6's `LINES_OK` gate hardcodes `wc -l` = 245; the spec's own edits sum to 244, and it assumes 3-digit issue numbers                                                                                                                                                         | **CONFIRMED**                                                                                                               | Replaced with `-ge 240` plus the structural gates (`ROWS_OK`, `CORRECTIONS_OK`, `LINKS_CHECKED`, `lint:md`, `format:check`), which prove the same thing without pinning a number that legitimate wording changes move.                                                                                                                                                                                                                                                                           |
| C15 | Design citation drift: `atomic.ts:184`→`:186`; `lock.ts:264-350`→`:264-354`; `paths.ts:150/:161`→`:154/:164`; `mp3-publisher.ts:453`→`:454`; `profile-presets.ts:616`→`:602`; `ppp:988`→`:987`; `filesystem.test.ts` "52 it blocks"→56 tests                                | **CONFIRMED, all informational**                                                                                            | Each is corrected inline at the point of use in this plan. None changes any edit.                                                                                                                                                                                                                                                                                                                                                                                                                |
| C16 | c2: the import list must be narrowed to exactly four names or `plan-engine.ts` will not compile — a hazard the design does not call out                                                                                                                                     | **CONFIRMED**                                                                                                               | Promoted from a blocker note to a bold in-scope warning in c2's Scope section, listing all six colliding declarations by line.                                                                                                                                                                                                                                                                                                                                                                   |
| C17 | c4: the design's gate glob `src/lib/tag-writer/*.test.ts` matches zero files                                                                                                                                                                                                | **CONFIRMED**                                                                                                               | c4's gates use `src/lib/tag-writer.test.ts` (62 tests) plus the four other importing suites.                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## Invariants that must hold at every commit

These are checked after **every** commit, c0 through c7 — not just at the end.

1. **`packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts` is byte-unmodified.**
   Measurable form: `grep -c 'message'` = **0** and `grep -c 'code:'` = **10**. If either moves, the
   commit that moved it is wrong. This is the design's abort criterion.

2. **`packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap` is byte-identical.**
   `sha256sum` = `eca986cc3e71f812f376868ec2ad569dc8f0ce4694bdb92ab63f9d4028191612`.

3. **No new tests beyond those named in the design's Test strategy**, all in
   `src/lib/secure-store/secure-store.test.ts`. c1 adds the four planned blocks, taking the
   full-suite total 4252 → **4256**, and c2–c7 hold it there. The post-review legacy-record fix later
   adds design item 3b, for a branch total of **4257**; that is the only sanctioned addition beyond
   c1. Tests asserting that a site imports a constant, and per-site regression tests, are explicitly
   forbidden.

4. **No `any`.** No `as any`, no unchecked casts, no non-null assertions introduced. Type-only
   exports use `export type` (`verbatimModuleSyntax`).

5. **ESM imports carry `.js` extensions**, and `secure-store` is imported **only** through
   `./secure-store/index.js`. Gate:
   `grep -rn 'secure-store/[a-z-]*\.js' src --include='*.ts' | grep -v '^src/lib/secure-store/' | grep -v 'secure-store/index.js'`
   must be empty from c1 onward.

6. **No new CLI surface.** No flag, no command, no option, no exit code. `shell-completions/templates.spec.ts`
   and the `--output json|csv` envelopes are untouched.

7. **`npm run typecheck`, `npm run build`, `npm run format:check`, `npm run lint:md` and
   `npm run test:run` all pass** from the worktree root at every commit boundary.

8. **The Plex credential store's on-disk bytes are unchanged.** `credential-store.test.ts`,
   `enrollment.test.ts`, `enrollment-refresh.test.ts` and `credential-cell.test.ts` pass unmodified
   at every commit.

9. **File-size soft cap.** No file in this PR crosses ~500 lines that was not already past it;
   `profile-preset-persistence.ts` moves the right way (1003 → ~810).
