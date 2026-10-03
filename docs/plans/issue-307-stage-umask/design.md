# Issue 307 — Enforce the Staging Floor with an fchmod on the Stage Handle

Status: design complete, ready for implementation.
Branch: `fix/307-stage-umask`.
Package under change: `packages/rfmedia-cli`.
Depends on: #288 (PR #309), #304 (PR #319), #305/#306 (PR #331) — all shipped.
Baseline: HEAD `103c4881`, clean tree, `src/lib/filesystem.test.ts` 56/56 green.

## Problem

`rfmedia verify --fix` publishes a **read-only** repaired media file under a restrictive umask.

The stage inode is created exactly once, at
`packages/rfmedia-cli/src/lib/filesystem.ts:949`:

```ts
const stagedHandle = await open(stagedPath, "wx+", STAGE_PRIVATE_MODE);
```

`STAGE_PRIVATE_MODE` is `0o600` (`filesystem.ts:55`). `"wx+"` maps to
`O_RDWR | O_CREAT | O_EXCL`, so the file is always newly created and the `mode`
argument is always consulted — and always masked by the process umask. Nothing
chmods the handle afterwards.

Mode arithmetic at creation (`0o600 & ~umask`):

| umask   | `~umask & 0o777` | created mode | symbolic     |
| ------- | ---------------- | ------------ | ------------ |
| `0o022` | `0o755`          | `0o600`      | `-rw-------` |
| `0o002` | `0o775`          | `0o600`      | `-rw-------` |
| `0o077` | `0o700`          | `0o600`      | `-rw-------` |
| `0o277` | `0o500`          | `0o400`      | `-r--------` |
| `0o400` | `0o377`          | `0o200`      | `--w-------` |

`fchmod(2)` is **not** umask-masked, which is why the fix works and why the
existing publication chmod at `filesystem.ts:1032` is unaffected by any umask.

On the **non-converting** `verify --fix` repair path the created mode is also the
**published** mode. Both callers —
`packages/rfmedia-cli/src/actions/verify-album.ts:344` and
`packages/rfmedia-cli/src/actions/verify-filter.ts:477` — pass only
`{ signal, materialize, validate }`. `resolvePublishMode` therefore returns
`undefined` (`filesystem.ts:872-873`), the entire mode block at
`filesystem.ts:1021-1057` is skipped, and `rename(2)` at `filesystem.ts:1060`
relinks the stage inode without touching its mode.

Reachable from a real invocation (pre-existing, writable album directory, one
track absent):

```bash
rfmedia verify /music/Artist /mnt/dest --range=001-001 --fix --quick
```

Under `umask 0277` a destination that was `0o644` is republished at `0o400`. A
media server running under a different `PUID` can no longer read the track that
`verify` just reported as fixed.

The same `0o400` stage additionally breaks the **converting** path's
materialization: `convert.ts:483`/`convert.ts:504` hand ffmpeg the _pathname_
`/proc/self/fd/4`, and a `/proc/self/fd/N` re-open for write is
permission-checked against the inode mode (`EACCES` at `0o400`, OK at `0o600`).
Convert's own relaxation at `filesystem.ts:1032` runs long after materialization
and cannot help. One chmod fixes both. This is a verified _mechanism_; a real
ffmpeg conversion under `umask 0277` was not run end to end, and the PR body must
say so rather than claiming an observed failure.

## Root Cause

`filesystem.ts:47-55` documents an invariant the code only ever _requested_:

> Mode the replacement stage is CREATED with, so a half-built artifact is
> unobservable to other users.

The mode argument to `open(2)` is a request the kernel narrows by the umask; it
is not a guarantee. `secure-store/atomic.ts:153-155` already names this exact
failure and already fixes it the exact way this design proposes:

```ts
// MANDATORY: the `mode` argument is ignored for an existing file and a
// restrictive umask (0277) would otherwise yield 0400.
await handle.chmod(PRIVATE_FILE_MODE);
```

`filesystem.ts` never caught up. `process.umask` appears zero times in the file,
and the single `chmod` it contains (`filesystem.ts:1032`) is a _relaxation_ to a
caller-supplied mode gated on `publishMode !== undefined`, not a umask
correction.

## Goals

1. The stage inode carries exactly `STAGE_PRIVATE_MODE` from creation until the
   publication chmod at `filesystem.ts:1032`, or until the rename at
   `filesystem.ts:1060` when no publication mode was requested — **regardless of
   the ambient umask**.
2. `verify --fix` stops publishing a read-only repaired media file.
3. The converting path's behaviour is provably byte-identical.
4. The failure is pinned by tests that are red before the fix and green after.

## Non-Goals

These are stated so a reviewer request cannot silently widen the change.

1. **No `PRIVATE_FILE_MODE` adoption.** `STAGE_PRIVATE_MODE` stays module-private
   in `filesystem.ts`. This is not a preference: `secure-store/index.ts:12-13`
   states it as binding architecture policy — "`filesystem.ts`'s `0o600` is a
   transient staging floor that is later relaxed, not a private-document mode,
   and **must never import `PRIVATE_FILE_MODE`**." The package contains four
   separate `0o600` constants, each documenting why it is not the others
   (`filesystem.ts:47` relaxed before rename; `tag-writer/mp3-publisher.ts:48`
   discarded via `cp --preserve=mode`; `conversion-metadata.ts:42` unlinked
   immediately; `secure-store/paths.ts:33` the only permanent one).
2. **No change to the converting relaxation.** `convert.ts:710-717` passes
   `preserveDestinationMode: true` plus
   `missingDestinationMode: 0o666 & ~process.umask()`, so `resolvePublishMode`
   always returns a number there, the block at `filesystem.ts:1021` always runs,
   and `stagedHandle.chmod(publishMode)` at `filesystem.ts:1032` unconditionally
   overrides the floor strictly later. A chmod inserted at `filesystem.ts:951`
   cannot disturb it.
3. **`preserveDestinationMode` for the non-converting repair path is OUT.**
   Adjudicated below; it gets a follow-up issue, not this PR.
4. **The converting path with a _missing_ destination still publishes `0o400`
   under `umask 0277`**, because `convert.ts:713` computes
   `0o666 & ~process.umask()`, which is exactly `0o400` at that mask. That is the
   caller's deliberate, umask-aware default — the mode an ordinary `cp` or
   `touch` would have produced — and it is not the staging floor. It is named
   here because it will look like an unfixed umask bug to anyone re-running the
   issue's reproduction with `--convert`.
5. **`verify --fix` on a _new_ album directory still fails under `umask 0277`.**
   `verify-album.ts:310` and `verify-filter.ts:436` call
   `ensureDir(dirname(destinationFile))`; under `0277` the intermediate `Artist/`
   directory is created `0o500` and the nested `mkdir` throws `EACCES` before any
   staging happens. That is fail-closed, pre-existing, and about directories, not
   file modes — so it is not a hole in this fix. It does mean "`verify --fix` is
   umask-clean" would be an overclaim; scope the PR body to a pre-existing,
   writable album directory.
6. **No change to shell-completion templates, user-facing docs, or
   `docs/roadmap-archive.md`.** See the impact section. _(Superseded during
   execution: the archive **was** edited. PR #333 merged mid-flight and closed
   #308, so #307 closed the last Sprint 2 row and `ROADMAP.md`'s own maintenance
   rule — move narrative to the archive when a full sprint closes — fired. The
   completions and user-facing-docs halves stand. See "As shipped" in
   `plan.md`.)_
7. **No sibling-site fixes.** See the sweep.

### Adjudication: why `preserveDestinationMode` is out

The strongest finding of the review is real and I am recording rather than
shipping it: **`0o600` is the wrong _published_ mode for a repaired media file**,
and the chmod makes a questionable mode reliably questionable rather than right.
A `0o644` track is narrowed to `0o600` under the ordinary `umask 022` too, so a
media server under a different `PUID` cannot read it. It is also internally
incoherent — `verify --fix --convert` preserves the destination mode for tracks
(`convert.ts:712`) while `cover.jpg` and other non-audio siblings in the same
album take the `0o600` branch, because `shouldConvert` (`convert.ts:808-814`)
returns `false` for non-audio. And it is a regression: before the tiered
verification refactor (#249) the same repair used a path-based `copyOrLink` →
`fse.copy` and inherited the source's mode.

It stays out of this PR for four reasons:

- Issue #307's own Expected Behavior rules `0o600` **in**, verbatim: "a repaired
  media file published by `verify --fix` lands at **0o600** — the mode
  `filesystem.test.ts:111` pins." Shipping a different published mode under a
  `fix(rfmedia)` squash title would deliver something the issue did not ask for.
- It changes the published mode for every `verify --fix` user under _every_
  umask, including `022`, where nothing is broken today.
- It requires an undocumented product decision (preserve destination? inherit
  source, as pre-#249? `0o666 & ~umask` when missing?). Nothing in the repo
  records the intent: `verify-auto-fix.doc.md` documents the staging order but
  not permission bits, and `audio-conversion.doc.md` documents mode preservation
  only for the conversion path.
- The chmod is **monotone** — it can only restore owner bits the umask cleared
  and can never set a group or other bit — so nothing is made worse by shipping
  it alone. The two changes are complementary: the chmod restores the transient
  floor, a caller-side mode option would relax it at commit. That is exactly the
  design `filesystem.ts:48-53` already describes.

Action: file a follow-up (`type:bug`, `priority:medium`, `rfmedia-cli`) for
`verify-album.ts:344` and `verify-filter.ts:477` to adopt
`preserveDestinationMode: true` + `missingDestinationMode`, mirroring
`convert.ts:712-713`. Note there that `filesystem.test.ts:111` must move with it:
that assertion correctly pins the _helper's_ default when no caller supplies a
mode, and the helper should not invent a publication policy.

## Decision

Insert one statement as the **first statement inside the inner `try`** at
`packages/rfmedia-cli/src/lib/filesystem.ts:951` — after `staged = true;` (line 950) and before `const stagedStat = await stagedHandle.stat();` (line 952):

```ts
    const stagedHandle = await open(stagedPath, "wx+", STAGE_PRIVATE_MODE);
    staged = true;
    try {
      // MANDATORY: open(2) masks its mode argument with the process umask, so a
      // restrictive umask (0277) would otherwise leave this stage at 0400 — and
      // on the no-publish-mode path that is exactly what `rename` publishes.
      // fchmod on the held descriptor is not umask-masked and cannot be
      // redirected by a pathname swap; never weaken this to a path chmod.
      await stagedHandle.chmod(STAGE_PRIVATE_MODE);
      const stagedStat = await stagedHandle.stat();
```

Plus one sentence appended to the `STAGE_PRIVATE_MODE` docstring
(`filesystem.ts:47-55`) recording that the floor is _enforced_ by an fchmod on
the stage handle rather than established by the `open` mode argument. Leave the
"transient window, not a published mode" and "Deliberately NOT secure-store's
`PRIVATE_FILE_MODE`" sentences untouched.

No `try`/`catch`, no error-code allowlist, no `import` from `secure-store`, and
**no following `sync()`**.

### Why this placement, and not the two obvious neighbours

`staged = true` sits at line 950, _outside_ the inner `try`. The outer `finally`
(`filesystem.ts:1065-1069`) unlinks only when `staged && !committed`; the inner
`finally` (`filesystem.ts:1062-1064`) owns `stagedHandle.close()`.

| Placement                    | On a chmod throw                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Between 949 and 950          | `staged === false` → **no unlink** (stage file leaks on disk) **and** no `close()` (fd leaks) |
| Between 950 and the `try`    | File is unlinked, but the inner `try` was never entered → **fd leaks**                        |
| First statement inside `try` | Inner `finally` closes the handle, outer `finally` unlinks the stage — **no leak**            |

Only the third is correct. Placing it ahead of the `stagedStat` capture also
establishes the floor before any other syscall observes the stage, which is
literally the invariant — and it is what makes the converting path's
`/proc/self/fd/N` materialization work, since `materialize` runs at line 954.

### Why it cannot weaken any guard

- It is an `fchmod` on the held descriptor, not a path `chmod`. It cannot follow
  a symlink and cannot be redirected by a pathname swap — the same reason the
  publication chmod at `filesystem.ts:1032` is safe.
- The inode was created microseconds earlier under `O_EXCL` with a
  `randomUUID()` name (`filesystem.ts:941`) in a parent already proven not
  group- or world-writable (`filesystem.ts:923-927`): `nlink === 1`, no second
  name an unprivileged actor can hold.
- It only **adds** owner-write (`0o400` → `0o600`). It never widens a group or
  other bit, so the "unobservable to other users" property at
  `filesystem.ts:47-52` is preserved verbatim. Under `umask 000/002/022/027/077`
  the created mode is already `0o600` and the chmod is a no-op.
- `fchmod` cannot change `dev`/`ino`, so the identity guards at
  `filesystem.ts:958-966`, `:972-980`, `:998-1009` and `:1023-1031` are
  unaffected.

### Why no extra `sync()` after the floor chmod

`fsync(2)` flushes file metadata including the mode, and the existing syncs at
`filesystem.ts:967` and `:981` both run after the floor chmod and before the
rename. The publication chmod needs its own sync at `:1033` only because nothing
else syncs between it and the rename. A third `fsync` per repaired file is
redundant I/O on a media-file path.

### Adjudication: fatal, not tolerated

The chmod is **not** wrapped in `try`/`catch`. Judges split on this; the
conclusion stands but one of the arguments used to defend it does not.

Reject this justification: "on mounts where `fchmod` is a no-op the bits are
synthesized from mount options, so a tolerant branch would be dead code." That is
false for Linux vfat/exFAT, where `fat_setattr` → `fat_sanitize_mode` returns
`EPERM` for any mode whose r/x bits differ from the inode's. With `fmask=0133`
(files `0644`), a chmod to `0600` is a hard error, not a no-op.

Keep it fatal on these grounds instead:

- `convert.ts:710-713` guarantees `resolvePublishMode` returns a number, so
  `stagedHandle.chmod(publishMode)` at `filesystem.ts:1032` **already runs
  unconditionally and fatally on every converted file**. "fchmod on the stage
  handle must succeed on this filesystem" is already a hard precondition of this
  helper on its most-exercised path.
- Repo policy is throw-early, no fallbacks that hide real issues. A tolerant
  branch would mask `EIO`/`EPERM` from a genuinely failing filesystem.
- A stage whose privacy cannot be enforced genuinely violates the documented
  invariant.

Own the residual honestly in the PR: for **non-converting** `verify --fix` users
on a FAT-family mount, this converts a currently-working repair into a hard
failure. That is a new, untested failure class. The follow-up shape if anyone
reports it is to tolerate `EPERM`/`ENOTSUP` by re-stat'ing and throwing only when
the resulting mode is actually _wider_ than the floor.

## Alternatives Considered

| Alternative                                                                         | Rejected because                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import `secure-store`'s `PRIVATE_FILE_MODE`                                         | Forbidden by `secure-store/index.ts:12-13` and by the issue. Numerically identical, semantically opposite lifetimes.                                                                                                                                                                                                                          |
| Extract a shared umask-proof `openPrivateStage()` helper                            | The four `0o600` constants carry four different doctrines; the two staging sites use different flags (`"wx+"` vs `O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW`) and different error translation. Saves one line, buys a cross-module dependency the repo deliberately severed.                                                                      |
| `chmod(STAGE_PRIVATE_MODE & ~process.umask())`                                      | Self-defeating: under `0277` that expression _is_ `0o400`. Also adds a DEP0139 no-arg `process.umask()` read to a hot path.                                                                                                                                                                                                                   |
| Path-based `chmod(stagedPath, ...)`                                                 | `chmod(2)` follows symlinks and Linux has no portable `lchmod`; reopens a TOCTOU the descriptor form structurally cannot have. Pinned against by the reworked `chmodEvents` assertion.                                                                                                                                                        |
| Chmod between lines 949/950 or 950/951                                              | Leaks the stage file and/or the fd. See the placement table.                                                                                                                                                                                                                                                                                  |
| Runtime post-chmod `fstat` + compare                                                | Can only fire on filesystems that silently ignore `chmod`, where the mode is filesystem-controlled anyway — turning a cosmetic mismatch into a failed media repair. Also asymmetric with `filesystem.ts:1036`, which deliberately re-checks `isFile`/`isSymbolicLink`/identity and never the mode. Enforce in the source, assert in the test. |
| Fail closed like `mp3-publisher.ts:440-446` (stat, refuse on mismatch)              | Larger diff, and it turns a benign operator umask into a hard failure. `mp3-publisher` can afford it because `cp --preserve=mode` gives it an authoritative expected mode; this function has none on the no-mode path.                                                                                                                        |
| Add an architecture-guard rule ("mode literal must be followed by a chmod")         | One-site defect at `priority:low`. See the sibling sweep — no second defective site in this package.                                                                                                                                                                                                                                          |
| `child_process` fork harness for the umask test                                     | Needs a tsx loader or a `dist/` build `vitest run` does not produce; no precedent in this package; adds a spawn failure mode that is not the code under test. Vitest already forks one process per test file.                                                                                                                                 |
| Simulate the umask via `openMock` (force the stage open to `0o400`)                 | Passes under a plausible wrong fix — `chmod(0o600 & ~process.umask())` evaluates to `0o600` at the suite's own `umask 022`. The real-umask form catches it. Adjudicated below.                                                                                                                                                                |
| Cache `process.umask()` at module load in `convert.ts:713` (DEP0139)                | Pre-existing, orthogonal, changes `convert.ts` behaviour if a caller mutates the umask mid-run, and would require updating `convert.test.ts:657`.                                                                                                                                                                                             |
| Add the post-rename parent-directory fsync `secure-store` has (`atomic.ts:111-138`) | A real asymmetry, but a durability question, not a permissions one.                                                                                                                                                                                                                                                                           |

## Critical Tests

Three edits to `packages/rfmedia-cli/src/lib/filesystem.test.ts`. No new test
file, no fixtures, no fork harness. Two carry regression signal; the third is
labelled honestly as coverage preservation.

### 1. MINIMUM SUFFICIENT — new `it` under a restrictive umask

**Fails before the fix, passes after.** This is the minimum test that proves the
user-visible defect, and it is the only coverage of the option shape
`verify --fix` actually uses.

Add as the last member of `describe("replaceFileWithValidatedStage")` — after the
`it` starting at `filesystem.test.ts:616`, before the closing `});` at line 648.
Name it `"holds and publishes the staging floor under a restrictive umask"`.

Shape, mirroring the repo's own umask precedent at
`secure-store/secure-store.test.ts:341-379`:

1. `mkdtemp`, then `writeFile(destination, "original")`, then
   `chmod(destination, 0o644)` — **all before any umask change**.
2. `const previousUmask = process.umask(0o277);`
3. Call `replaceFileWithValidatedStage(destination, { materialize, validate })`
   with **no mode key** — the exact `verify --fix` shape.
4. `finally { process.umask(previousUmask); }`
5. Assert **after** the call, in this order:
   `expect(publishedMode).toBe(0o600)` (the user-visible symptom named in the
   issue), then `expect(materializeStageMode).toBe(0o600)`, then
   `expect(validateStageMode).toBe(0o600)`, then `expectNoStagedArtifacts`.

Two design points that are load-bearing, not stylistic:

- **The callbacks RECORD the observed mode into locals; they do not `expect`
  inside the callback.** If `validate` asserts inline, it throws first, the
  helper rejects, `rename` never runs, and the destination-mode assertion — the
  one matching the issue title — is never evaluated in the failing run. Recording
  lets the pre-fix run proceed to publish `0o400` so the _published mode_ is what
  goes red.
- **`materialize` must record the mode too, and must write through
  `stagedHandle`, not by path.** The materialize-time assertion is what pins that
  the chmod runs _before_ `filesystem.ts:954`. Without it, a variant that chmods
  _after_ `materialize` passes every test in the suite while leaving the stage at
  `0o400` for the whole materialize window — which is precisely what breaks
  ffmpeg's `/proc/self/fd/N` re-open on the converting path. A path-based write
  against a `0o400` stage would `EACCES` and fail for the wrong reason; copy the
  handle-based form at `filesystem.test.ts:227-229`.

Three ordering traps, all confirmed: `mkdtemp` under `0277` yields a `0o500`
directory in which the stage `open` fails `EACCES`; the destination fixture must
also predate the umask change; the restore must be in `finally`.

`process.umask` is safe here. Vitest 4.0.17 defaults to `pool: "forks"` with
`isolate: true`, and `packages/rfmedia-cli/vitest.config.ts` overrides none of
it, so the mask cannot reach another test file; tests within a file run
sequentially and this file contains no `.concurrent`. The `finally` bounds the
remaining in-file risk, which is real — five later mode assertions and ten
path-based materializers would cascade into confusing `EACCES` failures.

### Adjudication: real umask over `openMock` simulation

The simulation form (force the staging `open` to `0o400` via the existing proxy)
avoids mutating a process global and is genuinely tempting. It is rejected
because it is **weaker**: a plausible wrong fix, `chmod(0o600 & ~process.umask())`,
passes it — under the suite's own `umask 022` that expression is `0o600`. Only
the real-umask form catches it (`0o600 & ~0o277 = 0o400`). The repo already has
the real-umask idiom at `secure-store.test.ts:353`/`:371`, written for the very
`atomic.ts` fix this issue says to mirror.

### 2. MANDATORY and also a regression assertion — rework `filesystem.test.ts:174`

The fix breaks this test as written, so the edit is forced regardless. Written
correctly it also fails before the fix.

In the proxy at `filesystem.test.ts:147-172`: record **every** chmod into a new
`chmodEvents` array unconditionally, and re-gate the existing latch on the
publication mode.

```ts
if (property === "chmod") {
  return async (mode: number) => {
    await target.chmod(mode);
    chmodEvents.push(`chmod:${mode.toString(8)}`);
    if (mode === 0o640) publicationApplied = true;
  };
}
if (property === "sync") {
  return async () => {
    await target.sync();
    if (publicationApplied) publicationEvents.push("sync-complete");
  };
}
```

Then replace the single assertion at line 174 with:

```ts
expect(chmodEvents).toEqual(["chmod:600", "chmod:640"]);
expect(publicationEvents).toEqual(["sync-complete"]);
```

Before the fix `chmodEvents` is `["chmod:640"]` → red. After, green. Re-gating on
`0o640` restores the original assertion's intent verbatim (the publish chmod is
followed by exactly one sync before rename) instead of absorbing the two extra
syncs at `filesystem.ts:967` and `:981` as noise. Without the re-gate the
recorded stream becomes
`["chmod:600","sync-complete","sync-complete","chmod:640","sync-complete"]`.

This assertion is also the pin against a path-based chmod: the proxy only
observes handle methods, so the TOCTOU-safe form is locked in at zero extra cost.

Do **not** "fix" the red by loosening this to a subset or substring match.

### 3. NOT a regression test — re-gate the concurrent-swap latch

`filesystem.test.ts:419`: change `modeApplied = true;` to
`if (mode === 0o640) modeApplied = true;`.

Stated plainly: **this is green before and after the fix.** It is included solely
because this change would otherwise disarm an existing test. With the ungated
latch, the destructive `unlink` + `link` swap migrates from the post-publish sync
(`filesystem.ts:1033`) to the post-materialize sync (`:967`), so the rejection
comes from the guard at `:1011-1019` instead of the post-mode-application guard
at `:1048-1056`. The test stays green because both throw the byte-identical
`Destination changed before commit: …` string that line 445 matches — a silent
coverage loss, which is worse than a red test. One line, zero risk.

### Deliberately not added

- No convert-path test. `publishMode` is always defined there, so
  `filesystem.ts:1032` runs strictly later and unconditionally; such a test
  cannot fail before the fix.
- No ffmpeg `/proc/self/fd` test. Needs a real ffmpeg fixture, and the invariant
  it depends on is pinned at the helper level by test 1's materialize-time
  assertion.
- No new assertion on `filesystem.test.ts:100`. `0o400 & 0o077` is still `0`, so
  it is blind to the bug and passes either way.
- No test for the FAT/exFAT `EPERM` path. Untestable without a FAT mount; it is
  the one behaviour change shipping without coverage, and the risk section owns
  that.

Expected suite result: `filesystem.test.ts` goes 56 → 57 tests, all green.

## Sibling-Site Sweep

Every mode-passing `open`/`writeFile`/`mkdir` site under `packages/*/src`
(tests excluded), classified. `packages/rf-common/src` contains zero octal mode
literals.

| Site                                                                                                                             | Classification                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rfmedia-cli/src/lib/filesystem.ts:949`                                                                                          | **DEFECTIVE — this PR.** Umask-narrowed creation mode is published verbatim on the no-publish-mode path.                                                                                                                                                                                                                                                                                                  |
| `rfapps-cli/src/lib/backup-docker.ts:835-839`                                                                                    | **DEFECTIVE, same class — follow-up issue, not this PR.** `open(..., 0o600)` with no chmod; that same inode becomes the shipped artifact via `link()` at `:914`, so a backup `.tar.gz` is `0o400` under `umask 0277`. Different package, different intent (a read-only immutable archive is arguably correct), and no comment records the intent. Needs a maintainer decision; out of #307's named scope. |
| `rfmedia-cli/src/lib/secure-store/atomic.ts:148-155`                                                                             | Immune — chmods after create. The reference pattern.                                                                                                                                                                                                                                                                                                                                                      |
| `rfmedia-cli/src/lib/plan.ts:1465-1471`                                                                                          | Immune — chmods after create.                                                                                                                                                                                                                                                                                                                                                                             |
| `rfapps-cli/src/lib/backup-storage-write.ts:251-256`, `:398-401`                                                                 | Immune — handle chmod, plus a finalize chmod at `:311`.                                                                                                                                                                                                                                                                                                                                                   |
| `rfapps-cli/src/lib/plan-storage.ts:1257-1264`, `:1385-1391`                                                                     | Immune — path chmod after close; final mode correct.                                                                                                                                                                                                                                                                                                                                                      |
| `rfapps-cli/src/lib/docker.ts:1415-1424`                                                                                         | Immune — explicit `chmod(composePath, 0o600)` at `:1424`.                                                                                                                                                                                                                                                                                                                                                 |
| `rfmedia-cli/src/lib/tag-writer/mp3-publisher.ts:396`                                                                            | Not defective — creation mode is provably discarded. `preserveLinuxMp3Metadata` (`:173-190`) restores the source's mode via `cp --preserve=mode,ownership,xattr`, and `:440-446` refuses to publish any stage whose `mode & 0o7777` differs from the source's. Fails closed where `filesystem.ts` failed open.                                                                                            |
| `rfmedia-cli/src/lib/conversion-metadata.ts:717`                                                                                 | Not defective — the descriptor is `unlink`ed at `:722` and never published under a pathname. `UNLINKED_DESCRIPTOR_MODE`'s docstring says so.                                                                                                                                                                                                                                                              |
| `rfapps-cli/src/lib/docker.ts:2329-2333`                                                                                         | Not defective — ephemeral `override.json` in a private `mkdtemp` dir (chmod `0o700` at `:2324`), consumed then removed. `0o400` is still owner-readable.                                                                                                                                                                                                                                                  |
| `rfapps-cli/src/lib/state-lock.ts:607-612`, `lifecycle-lock.ts:446-450`                                                          | Harmless — token written through the handle; privacy is asserted on the lock _directory_, never on the token's exact mode.                                                                                                                                                                                                                                                                                |
| `rfmedia-cli/src/lib/secure-store/paths.ts:296-313`; `rfapps-cli` `backup-storage-write.ts:141-149`, `plan-storage.ts:1166-1187` | Immune directories — chmod after `mkdir`.                                                                                                                                                                                                                                                                                                                                                                 |
| `rfapps-cli` `state-lock.ts:214-229`, `:590`; `lifecycle-lock.ts:177`; `db.ts:141`; `state-rebuild-files.ts:134`                 | Narrow but fail-closed. Under `umask 0277` these yield `0o500` directories and the first entry created inside fails `EACCES`. A functional edge, never a privacy leak (umask can only clear bits). Outside `rfmedia-cli` and outside #307.                                                                                                                                                                |

Conclusion: **#307 is a one-site fix within `rfmedia-cli`.** The only other
genuinely same-class site is `rfapps-cli/src/lib/backup-docker.ts:835`, and it
belongs in its own issue.

## Files

- `packages/rfmedia-cli/src/lib/filesystem.ts` — one `await
stagedHandle.chmod(STAGE_PRIVATE_MODE);` at line 951 plus a comment; one
  sentence appended to the `STAGE_PRIVATE_MODE` docstring at lines 47-55.
- `packages/rfmedia-cli/src/lib/filesystem.test.ts` — one new `it`; the reworked
  proxy and assertions in the test at line 139; the one-token latch re-gate at
  line 419.
- `ROADMAP.md` — #307 closeout. See the impact section.
- `docs/plans/issue-307-stage-umask/design.md` — this document.

Nothing else changes. No caller, no `convert.ts`, no `secure-store`, no
completion template, no command module, no config file, no public error type. A
`parallel-plan.md` is not warranted: this is one task with zero parallelism, and
the nearest precedent (`baeee7f7`, a comparable `priority:low` corrective fix)
shipped source plus test with no plan directory at all.

## Verification

All commands are absolute-path, `umask 022`, `FORCE_COLOR` unset.

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307

# Target suite (expect 57/57; baseline at HEAD is 56/56)
unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli src/lib/filesystem.test.ts

# Umask sweep of the same suite. See the note below on 002.
unset FORCE_COLOR; umask 077; npx vitest run --root packages/rfmedia-cli src/lib/filesystem.test.ts

# Contract suites that must not move
unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli \
  src/lib/convert.test.ts src/actions/verify-album.test.ts src/actions/verify-filter.test.ts

# No-diff tripwire for completions
unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli \
  src/lib/shell-completions/templates.spec.ts
git diff --stat -- packages/rfmedia-cli/src/lib/shell-completions/

# Gates
unset FORCE_COLOR; umask 022; npm run typecheck -w packages/rfmedia-cli
unset FORCE_COLOR; umask 022; npm run check:architecture -w packages/rfmedia-cli
unset FORCE_COLOR; umask 022; npm run test:run

# Closeout
npm run format:md
npm run lint:md
git diff --check
graphify update .
```

Do **not** add a `umask 002` leg. Verified at HEAD `103c4881`: `umask 002`
already fails `filesystem.test.ts` 1/56, at `detects a changed destination parent
before commit` (`filesystem.test.ts:616`), because its own `mkdir` at line 622
yields `0o775` and trips the group-writable guard at `filesystem.ts:923`. That is
pre-existing and unrelated to this fix; a red cell in the PR's `## Testing` table
on a permissions change is noise that gets a PR bounced. Measured at HEAD:
`umask 022` → 56/56, `umask 077` → 56/56, `umask 002` → 55/56.

Do **not** launch the vitest process itself under `umask 0277`. Vite cannot write
its `.vite-temp` bundle and the run dies at config load with `EACCES` — that is
infrastructure, not the bug. The `0277` coverage lives _inside_ test 1, which is
exactly why it sets the mask itself. The issue's own reproduction step
(`umask 0277 && npx vitest run …`) is therefore unrunnable as written; say so in
the PR body so a reviewer following it does not conclude the fix is unverifiable.

`check:architecture` is unaffected. Verified green at HEAD ("OK: Plex/Lidarr
dependency direction and authenticated fetch ownership across 340 production
files"); `lib/filesystem.ts` is inside that scanned set, but every rule keys off
a module specifier, a `fetch(` call site, a Lidarr/Plex symbol, or the MusicBrainz
manifest. A `chmod` method call on an already-held `FileHandle` introduces none
of those.

## Documentation, Completions, and ROADMAP Impact

**Shell completions: no change, and `templates.spec.ts` must not change.** The fix
adds, removes, and renames zero commands, subcommands, flags, and flag values.
`verify --fix` already exists in all three templates (`bash.ts:49`'s static
`verify_opts`, with zsh/fish parity asserted at `templates.spec.ts:2354-2365`).
The spec's inputs are exclusively the three generators plus the CLI option/value
registries from `src/types`; `rg filesystem` over `src/lib/shell-completions/`
returns zero hits. The repo's own trigger
(`packages/rfmedia-cli/CLAUDE.md:984`, `:1112`) is conditioned on a
command-surface change. Precedent wording:
`docs/plans/issue-321-claim-release-ownership-followup/design.md:115`. Run the
spec anyway as a no-diff tripwire, as #305 did.

**User-facing docs: none needed.** No doc under `packages/rfmedia-cli/docs/`
states the resulting permission bits of a repaired file — the three "permission"
hits in `verify-auto-fix.doc.md` (`:123`, `:144`, `:203`) are about failure
diagnosis and JSON shape. The rationale belongs in the source comment at the
chmod call site, mirroring `atomic.ts:153-154`. Answer the PR checklist item with
that explanation rather than leaving it blank, and mark the Docker/Compose item
explicitly not-applicable.

**ROADMAP.md.** Adjudicated to the defensible subset plus the mandated count
regeneration; the archive stays untouched because `ROADMAP.md:317-319` moves
narrative only "when a full sprint closes" and Sprint 2 still holds #308
(`docs/plans/issue-305-secure-store-plan-io/design.md:282-284` says the same).

| Line  | Edit                                                                                                                                                                                                                                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10-11 | Regenerate from live state per `ROADMAP.md:317` (`gh issue list --state open --limit 200 --json number,labels`) — do **not** decrement; the line is already stale by one because #63 merged as `103c4881`. Drop the now-obsolete "issue #63 itself closes on merge" clause. |
| 49    | `(#307–#308)` → `(#308)`                                                                                                                                                                                                                                                    |
| 63-64 | "two independent mode/error-taxonomy edges" → the one remaining lock error-taxonomy edge                                                                                                                                                                                    |
| 72    | Delete the Sprint 2 row for #307                                                                                                                                                                                                                                            |
| 73    | Renumber #308 from Order `2` to `1`                                                                                                                                                                                                                                         |
| 76    | `#307–#308` → `#308`                                                                                                                                                                                                                                                        |
| 264   | Decrement the low-priority heading count by one. Do **not** attempt to reconcile the pre-existing gap (the heading reads `(28)`; the table beneath has 26 rows); preserving whatever rule produced it is the least-surprise choice and reconciliation is out of scope.      |
| 267   | `#307–#308` → `#308`                                                                                                                                                                                                                                                        |
| 294   | Delete the backlog row for #307                                                                                                                                                                                                                                             |
| 311   | "#288, #304, #305, #306, and #307 shipped; #308 remains", Notes narrowed to the lock taxonomy edge                                                                                                                                                                          |

Run `npm run format:md` afterwards; the file is Prettier-formatted with padded
table columns. Line 8 (`**Last updated:**`) is already `2026-08-08`; bump only if
the closeout commit lands later.

**Commit and PR.** Title `fix(rfmedia): chmod the verify --fix staging handle` —
`fix` because this is a user-visible behaviour change, scope `rfmedia` not
`rfmedia-cli` per the dominant convention in `git log`. The title is the
squash-merge subject and is gated by `.github/workflows/pr-title.yml:39-46`.
`Closes #307`. Labels `type:bug`, `priority:low`, `rfmedia-cli`. Breaking
changes: none. If this design doc is committed separately it must use
`docs(internal): …` per `.github/copilot-instructions.md:24-25`.

## Risk and Rollback

Risk level: **Low**, with one genuinely new failure mode.

1. **New: fatal `fchmod` on FAT-family destinations.** On a vfat/exFAT mount with
   e.g. `fmask=0133`, `fchmod(0o600)` returns `EPERM`, turning a currently-working
   _non-converting_ `verify --fix` into a hard failure. `--convert` users already
   depend on a fatal fchmod at `filesystem.ts:1032`, so that class is unchanged;
   the non-converting path is newly exposed. Not tested — no FAT mount available.
   Must be named in the PR's Risk section. Cleanup is correct in that case: the
   throw propagates through the inner `finally` (close) and outer `finally`
   (unlink), leaving the destination untouched.
2. **`filesystem.test.ts:174` goes red without edit 2.** Certain, not possible. An
   implementer landing only the source change gets a red suite.
3. **`filesystem.test.ts:400-453` stays green while silently losing coverage
   without edit 3.** Nothing in CI flags it, which is what makes it dangerous.
4. **Umask leakage inside `filesystem.test.ts`** if test 1's restore is skipped.
   Bounded to the one file by vitest's per-file forks; the `finally` is not
   optional.
5. **Pre-existing hazard newly exposed:** a non-`ENOENT` throw from
   `unlinkStagedFile` in the outer `finally` (`filesystem.ts:889-892`) replaces
   the in-flight exception and would mask a chmod error. `unlink` needs only
   `+wx` on the parent, independent of the stage's own mode, so this is unlikely
   — but a chmod-throwing filesystem is exactly where it would matter.
6. **The published mode of a repaired media file stays `0o600`.** Deterministic
   now rather than umask-dependent, but still narrower than the destination it
   replaced. If the follow-up issue is not filed, this PR silently ratifies a mode
   nobody chose. Filing it is part of the change.
7. One extra `fchmod` syscall per staged replacement — negligible against the
   four `stat`s, two `sync`s, two `realpath`s and several `lstat`s already on the
   path.

Rollback: revert the single commit. The source change is one statement in one
function with no new imports, no new exports, no schema change, and no persisted
state, so a revert restores HEAD behaviour exactly. The ROADMAP edits are
independent of the code and can be reverted separately.
