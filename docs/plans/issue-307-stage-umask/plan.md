# Issue 307 — Implementation Plan

Status: ready to implement.
Supersedes: `docs/plans/issue-307-stage-umask/design.md` wherever the two disagree.
Branch: `fix/307-stage-umask`.
Worktree: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307`.
Package under change: `packages/rfmedia-cli`.

Every path below is absolute. Every anchor is a quoted source line, not a bare line
number, because line numbers shift as earlier tasks land.

## As shipped — where execution diverged from this plan

Recorded after the fact so the committed artifacts do not contradict the merged tree. Three
divergences, all deliberate; the design's Non-Goals and the source change itself are unaffected.

1. **Task 3's `publicationEvents` assertion.** This plan prescribes
   `expect(publicationEvents).toEqual(["sync-complete"])`. The shipped test keeps
   `["chmod:640", "sync-complete"]` — the array now records the publication chmod as well as its
   sync, so the original assertion's text survives verbatim rather than being narrowed. The new
   `chmodEvents` assertion carries the regression signal either way, and both forms are red before
   the fix.
2. **Task 8's gate.** The gate reads `grep -n '307' ROADMAP.md` and expects **no** output. That was
   written for a silent row deletion. The closeout that shipped is a full Sprint 2 archive with
   attribution, so four deliberate shipped-history mentions of `#307` remain — the follow-up count
   at `ROADMAP.md:11`, the sprint-closing narrative at `:51` and `:68`, and the completed
   cross-cutting cell at `:306`, which item 8 of this same task explicitly instructs. The gate's
   real assertion is the regenerated issue counts. Corrected expectation: **no remaining
   _pending-work_ reference to #307** — no Sprint 2 row, no low-priority backlog row, and not in
   the `<summary>` expand list.
3. **`docs/roadmap-archive.md` is edited after all**, contrary to design Non-Goal 6. Closing #307
   closed the last Sprint 2 row, which fires `ROADMAP.md`'s own maintenance rule ("move narrative
   to the archive only when a full sprint closes"). The design wrote that Non-Goal while #308 was
   still open; #333 merging mid-flight (see S1) inverted it.

Two further count corrections applied during execution: the rfmedia low-priority heading was
reconciled to its actual row count (24, not a bare decrement — 3 of the 4 backlog headings already
matched their row counts exactly, so row count is the convention), and the rfapps low-priority and
rfmedia medium headings were incremented for the #335 and #334 rows.

## Supersessions — corrected facts

Each item states the corrected fact. All are marked **corrected from design**.

### S1. PR #333 has merged; the worktree is one commit stale (corrected from design)

The design and the adversarial validation report both assumed PR #333 was **open**.
It merged as `019ce004` (`fix(rfmedia): classify invalid preset lock metadata (#333)`),
issue #308 is **CLOSED**, and `origin/master` is one commit ahead of this worktree's
`HEAD` (`103c4881`).

Consequences, all binding:

- The design's entire ROADMAP edit table is obsolete. So are the line numbers in the
  validation report, which were measured against `103c4881`.
- `019ce004` already rewrote ROADMAP lines 10-11, 45-51, 63-64, 70-76, 264, 267,
  294-296 and the whole cross-cutting table. The rebase is mandatory **before** any
  ROADMAP edit; see Task 0.
- `019ce004` touched no source file this PR touches (it changed
  `lidarr/profile-preset-persistence.ts` and its test), so the `filesystem.ts` and
  `filesystem.test.ts` anchors are unaffected by the rebase.
- The validation report's "BLOCKER: PR #333 is OPEN" is **resolved by merge**, not by
  ordering. The merge-order question is settled: #333 landed first.

### S2. Sprint 2 becomes empty; the archive rule now fires (corrected from design)

The design asserted the ROADMAP archive "stays untouched because Sprint 2 still holds
issue #308". After `019ce004`, **#307 is the only remaining Sprint 2 row**. Closing it
empties the sprint, and the repo's own Maintenance rule then applies:

> move narrative to [`docs/roadmap-archive.md`](docs/roadmap-archive.md) only when a
> full sprint closes

This is now a live requirement, not a conditional caveat. See Task 8.

### S3. Validated ROADMAP line numbers (corrected from design)

Measured against `019ce004` — the tree this branch must be rebased onto. Use these,
not the design's.

| Line at `019ce004` | Content                                                         |
| ------------------ | --------------------------------------------------------------- |
| 8                  | `**Last updated:** 2026-08-08`                                  |
| 10                 | `**Open issues:** 80 (rfapps 38 · rfmedia 42) — …`              |
| 50                 | `**Sprint 2** work (#307). Remaining rfapps medium UX …`        |
| 61                 | `### Sprint 2 — secure-store completion`                        |
| 63-64              | `… the remaining work covers one restrictive-umask mode edge:`  |
| 70-72              | Sprint 2 table header plus the single `#307` Order-1 row        |
| 74-75              | `**Exit criteria:** …; #307 is closed or explicitly deferred.`  |
| 263                | `### Low priority — docs, polish & future ideas (27)`           |
| 266                | `<summary>Click to expand (…, #286–#287, #307, #323)</summary>` |
| 293                | Low-priority backlog table row for `#307`                       |
| 309                | Cross-cutting `Secure artifact I/O` row                         |

`grep -n '307' ROADMAP.md` at `019ce004` returns exactly `50, 72, 75, 266, 293, 309`.

### S4. Validated issue counts (corrected from design)

The design said "regenerate from live state, do not decrement". Followed literally that
yields the wrong number, because live state still counts #307.

Measured now: **80 total (rfapps 38 · rfmedia 42)** — already reflecting #333/#308.

Arithmetic for the closeout line:

- Close #307 (`rfmedia-cli`): 79 (rfapps 38 · rfmedia 41).
- File follow-up FU-1 (`rfmedia-cli`, Task 10): +1 rfmedia.
- File follow-up FU-2 (`rfapps-cli`, Task 10): +1 rfapps.
- **Expected final: 81 (rfapps 39 · rfmedia 42).**

Ordering is load-bearing: **file the follow-ups first, then regenerate**, then write the
line. Do not hand-compute — run the regeneration command in Task 8 and use its output.

### S5. `type:bug` is not a valid label (corrected from design)

The design specifies `type:bug` at two places. That label does not exist. The full
label set is: `bug`, `documentation`, `duplicate`, `enhancement`, `help wanted`,
`good first issue`, `invalid`, `question`, `wontfix`, `plex`, `priority:high`,
`rfmedia-cli`, `performance`, `future`, `testing`, `architecture`, `rfapps-cli`, `ai`,
`priority:low`, `priority:medium`, `phase:1`…`phase:5`, `source:parallel-plan`,
`type:task`. Use `bug`. Issue #307 itself carries `bug, rfmedia-cli, priority:low`.

Additionally: **do not label the PR.** PRs in this repo carry zero labels — both #331
and #333 have none. Label the follow-up issues instead.

### S6. `packages/rfmedia-cli/CHANGELOG.md` needs an entry (corrected from design — omission)

The design never mentions the changelog. `019ce004` added a `### Fixed` bullet under
`## [Unreleased]`, and that is the standing convention for a user-visible `fix(rfmedia)`
change. This plan adds Task 5 for it.

### S7. Low-priority heading count is 24, not 26 (corrected from design)

The design said "decrement by one" and "do not attempt to reconcile the pre-existing
gap … preserving whatever rule produced it is the least-surprise choice".

There is no such rule. The gap is a plain omission introduced by `8fde3f47`, which
deleted two rows without touching the heading. Evidence:

- At `8fde3f47^`: heading `(28)`, rows 28.
- At `8fde3f47`: heading `(28)`, rows 26.
- At `019ce004` (#333): heading `(27)`, rows 25 — #333 decremented by one and carried
  the gap forward.
- Sibling section `### Low priority — UX, extensibility & scale (31)` sits above
  exactly **31** rows. The convention is table-row count.

Removing the `#307` row leaves **24** rows. Write `(24)`. Decrementing to `(26)`
propagates a known defect a third time.

### S8. Other design corrections carried forward from validation

- **Files section off-by-one.** "one `await stagedHandle.chmod(STAGE_PRIVATE_MODE);` at
  line 951" names the insertion _position_. The bare statement lands at 952; with the
  prescribed comment block it lands at ~957. The Decision section's prose wording is the
  correct one. Anchor on text, not the number.
- **Test-1 ordering trap over-stated.** The design calls three ordering traps
  "confirmed". Only two are: `mkdtemp` must precede the umask change (under `0277` it
  yields a `0o500` directory and stage creation fails `EACCES`), and the restore must be
  in `finally`. The destination fixture may be created after the umask change —
  `writeFile` is permission-checked against the parent, and `chmod(2)` is not
  umask-masked. Keep the ordering anyway for clarity; drop the claim that it is required.
- **Risk-4 leak scope mis-stated.** The design says the `finally` bounds risk because
  "five later mode assertions and ten path-based materializers would cascade". The new
  test is the **last** member of its describe, so those all run before it. The real
  exposure is the three describes _after_ it — `copyOrLink`, `sanitizeForFilesystem`,
  `copyOrLinkWithHash` — whose `mkdtemp` would yield `0o500` and then `EACCES`. The
  conclusion is unchanged: the `finally` is not optional.
- **`templates.spec.ts:2354` mis-cited.** That test is
  `"keeps quick, deep, and tracking-database verify flags in parity"` and loops over
  `["quick", "deep", "tracking-database"]`. It never mentions `--fix`. The conclusion
  (no completion change) is unaffected: `--fix` is independently present in `bash.ts`,
  `zsh.ts:387`, and `fish.ts:400`.
- **`verify-auto-fix.doc.md` has two "permission" hits, not three** (`:123`, `:203`).
  Line 144 is `"mode": "album",` inside a JSON sample. The conclusion is _strengthened_:
  no user-facing doc states resulting permission bits, so "user-facing docs: none needed"
  stands.
- **Non-Goal 5 scoping is incomplete.** The design tells the PR body to scope to "a
  pre-existing, writable album directory", naming only the `0277`/`ensureDir`/`EACCES`
  failure. Under `umask 002` a `0o775` album directory trips the group/world-writable
  guard in `filesystem.ts` and `verify --fix` throws
  `Destination parent is group- or world-writable and cannot safely publish a validated stage: …`
  before any staging. Correct scoping: **"a pre-existing album directory that is not
  group- or world-writable."**
- **`check:architecture` is subsumed.** `pretypecheck` already runs
  `codegen:lidarr:check && check:architecture && test:architecture`. Keeping the separate
  line is harmless but it is not an independent gate.
- **`bash.ts` `verify_opts` is declared at :46**; `--fix` merely sits on :49.
- **`secure-store.test.ts`'s umask test closes at :380**, not :379. The cited `:353`
  and `:371` are exact.

### S9. What the design got right and this plan keeps unchanged

The core mechanism, placement, fatality decision, sibling sweep, non-goals 1-4, the
"no extra sync" reasoning, and all three test edits are confirmed by direct execution.
Do not relitigate them.

## Sequencing decision — tests before source, one commit

**The test edits land BEFORE the source edit in working-tree order, and all of them
ship in a SINGLE commit.**

Why. There is no ordering that yields a green intermediate state:

- Source-first: the existing assertion in the test that starts
  `it("keeps the stage private through validation and applies a requested publication mode"`
  goes **red immediately**. Measured: the unmodified proxy records
  `["chmod:600","sync-complete","sync-complete","chmod:640","sync-complete"]` against an
  expected `["chmod:640","sync-complete"]`.
- Tests-first: the new umask test and the reworked assertion are both red by
  construction — that is the point.

Tests-first is chosen because it produces the _evidence_ the PR needs: a measured RED
with exactly two named failures, then a measured GREEN at 57/57. Source-first produces a
red whose cause is a test the fix invalidated, which proves nothing.

Because the PR squash-merges, the intermediate red is a **verification state, not a
commit**. Stage everything and commit once at Task 11. Do not create a red commit.

## Tasks

### Task 0 — Rebase onto `019ce004`

**File:** none (git operation).

**Anchor:** local `HEAD` is `103c4881`; `origin/master` is `019ce004`;
`git rev-list --count HEAD..origin/master` returns `1`.

**Change:** fetch and rebase this branch onto `origin/master`. `019ce004` touches
`ROADMAP.md`, `packages/rfmedia-cli/CHANGELOG.md`, `docs/internal/plex-jwt-deferrals.md`,
two `docs/plans/issue-308-*` files, two `docs/prps/reviews/*` files, and
`lidarr/profile-preset-persistence.{ts,test.ts}`. This branch has no committed changes
to any of those, so the rebase is expected to be conflict-free.

Do **not** author ROADMAP edits before this task. Every line number in S3 is measured
post-rebase.

**Gate:**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && git rev-list --count HEAD..origin/master
```

Expected: `0`.

### Task 1 — Extend the `STAGE_PRIVATE_MODE` docstring

**File:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307/packages/rfmedia-cli/src/lib/filesystem.ts`

**Anchor:** the docstring block ending in

```text
 * PRIVATE_FILE_MODE, which names a permanent property of a credential
 * document.
 */
const STAGE_PRIVATE_MODE = 0o600;
```

**Change:** append one sentence to the docstring recording that the floor is _enforced_
by an `fchmod` on the stage handle rather than established by the `open` mode argument.
Leave the "transient window, not a published mode" sentence and the "Deliberately NOT
secure-store's PRIVATE_FILE_MODE" sentence untouched — both are quoted as binding policy
by `secure-store/index.ts`.

**Gate:**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && grep -c 'PRIVATE_FILE_MODE' packages/rfmedia-cli/src/lib/filesystem.ts
```

Expected: `1` (the docstring mention only — no import was added).

### Task 2 — Add the new real-umask test

**File:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307/packages/rfmedia-cli/src/lib/filesystem.test.ts`

**Anchor:** the last member of `describe("replaceFileWithValidatedStage")`, which begins

```ts
  it("detects a changed destination parent before commit", async () => {
```

and ends with `await expectNoStagedArtifacts(originalParent);`, its `finally`, and `});`
immediately before the describe's own closing `});`. Insert the new `it` **after** that
closing `});` of the parent-change test and **before** the describe's `});`.

**Change:** add
`it("holds and publishes the staging floor under a restrictive umask", …)` shaped as:

1. `mkdtemp` **before** any umask change (mandatory — under `0277` `mkdtemp` yields a
   `0o500` directory and stage creation fails `EACCES`).
2. `writeFile(destination, "original")` then `chmod(destination, 0o644)`. Both `chmod`
   and `stat` are already imported at the top of the file; **no new import is needed.**
3. `const previousUmask = process.umask(0o277);` then `try { … } finally { process.umask(previousUmask); }`
   — the restore in `finally` is mandatory, because the three describes that follow this
   one (`copyOrLink`, `sanitizeForFilesystem`, `copyOrLinkWithHash`) would otherwise
   `mkdtemp` a `0o500` directory and cascade `EACCES`.
4. Call `replaceFileWithValidatedStage(destination, { materialize, validate })` with
   **no mode key** — the exact shape `verify-album.ts` and `verify-filter.ts` pass.
5. `materialize` and `validate` **record** the observed stage mode into locals; they must
   not `expect` inline. Inline assertion throws first, the helper rejects, `rename` never
   runs, and the published-mode assertion — the one matching the issue title — is never
   reached. Measured: the inline form leaves the destination at its original `0o644` and
   `rename` is called 0 times, so it would also report a misleading mode.
6. `materialize` must write through the handle
   (`await stagedHandle.writeFile("replacement", "utf-8")`), copying the handle-based form
   already used in the `it.each` "captures identity and publication mode together"
   test. A path-based write against a `0o400` stage fails `EACCES` — the right failure
   for the wrong reason.
7. Assert after the call, in this order: `publishedMode` is `0o600` (the user-visible
   symptom), then `materializeStageMode` is `0o600` (this is what pins that the chmod
   runs _before_ `options.materialize`), then `validateStageMode` is `0o600`, then
   `expectNoStagedArtifacts`.

**Gate:** deferred to Task 4's combined RED gate — this test cannot pass until Task 6.

### Task 3 — Rework the publication-mode proxy and its assertion

**File:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307/packages/rfmedia-cli/src/lib/filesystem.test.ts`

**Anchor:** inside
`it("keeps the stage private through validation and applies a requested publication mode"`,
the proxy branch currently reading

```ts
if (property === "chmod") {
  return async (mode: number) => {
    await target.chmod(mode);
    modeApplied = true;
    publicationEvents.push(`chmod:${mode.toString(8)}`);
  };
}
```

and the assertion inside `renameMock.mockImplementationOnce` currently reading

```ts
expect(publicationEvents).toEqual(["chmod:640", "sync-complete"]);
```

**Change:** introduce a `chmodEvents: string[]` local. In the `chmod` branch, push every
chmod into `chmodEvents` unconditionally and **re-gate** the latch on the publication
mode (`if (mode === 0o640) …`) so the `sync` branch records `sync-complete` only for the
publication sync. Replace the single assertion with:

```ts
expect(chmodEvents).toEqual(["chmod:600", "chmod:640"]);
expect(publicationEvents).toEqual(["sync-complete"]);
```

This edit is **forced** — the source fix breaks the assertion as written regardless.
Written this way it also carries regression signal: pre-fix `chmodEvents` is
`["chmod:640"]` (red), post-fix `["chmod:600","chmod:640"]` (green). Measured both ways.

It is additionally the pin against a path-based `chmod`: the proxy observes handle
methods only, so the TOCTOU-safe descriptor form is locked in at zero cost.

Do **not** repair the red by loosening this to a subset or substring match.

### Task 4 — Re-gate the concurrent-swap latch, then prove RED

**File:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307/packages/rfmedia-cli/src/lib/filesystem.test.ts`

**Anchor:** inside
`it("does not overwrite a destination replaced while publication mode is syncing"`, the
chmod branch reading

```ts
if (property === "chmod") {
  return async (mode: number) => {
    await target.chmod(mode);
    modeApplied = true;
  };
}
```

**Change:** `modeApplied = true;` → `if (mode === 0o640) modeApplied = true;`

State plainly in review: **this is green before and after the fix.** It is included only
because the change would otherwise silently disarm the test. Measured: with the ungated
latch, post-fix the destructive swap fires on the post-materialize sync instead of the
post-publication sync, the publication chmod `0o640` is never reached
(`chmods === ['600']`), and the rejection comes from the earlier destination-snapshot
guard. Both guards throw the byte-identical `Destination changed before commit: …`
string the test matches, so nothing goes red — a silent coverage loss, which is worse.
With the re-gate, `chmods === ['600','640']` and the original coverage survives.

**Gate (combined RED proof for Tasks 2-4):**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli src/lib/filesystem.test.ts
```

Expected: `Tests 2 failed | 55 passed (57)`. The two failures must be exactly
`holds and publishes the staging floor under a restrictive umask` (published mode `0o400`
where `0o600` was expected) and
`keeps the stage private through validation and applies a requested publication mode`
(`chmodEvents` is `["chmod:640"]`). Any other failure count or identity means a test edit
is wrong — stop and fix it before Task 6.

### Task 5 — Add the CHANGELOG entry

**File:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307/packages/rfmedia-cli/CHANGELOG.md`

**Anchor:** under `## [Unreleased]`, the `### Fixed` heading whose current first bullet is

```text
- Invalid Lidarr preset lock-owner metadata machine output now emits
  `LIDARR_PRESET_LOCK_METADATA_INVALID` instead of `LIDARR_PRESET_JOURNAL_INVALID`.
```

**Change:** insert a new bullet as the first entry under `### Fixed`, stating that
`verify --fix` no longer publishes a read-only repaired file under a restrictive umask,
because the replacement stage's `0o600` floor is now enforced with an `fchmod` on the
held descriptor instead of relying on the umask-masked `open` mode argument.

This task is **corrected from design** — the design omits the changelog entirely; see S6.

**Gate:**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && grep -n 'umask' packages/rfmedia-cli/CHANGELOG.md
```

Expected: at least one hit, inside the `### Fixed` block under `## [Unreleased]`.

### Task 6 — The source fix

**File:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307/packages/rfmedia-cli/src/lib/filesystem.ts`

**Anchor:**

```ts
    const stagedHandle = await open(stagedPath, "wx+", STAGE_PRIVATE_MODE);
    staged = true;
    try {
      const stagedStat = await stagedHandle.stat();
```

**Change:** insert the comment block and one statement as the **first statement inside
the inner `try`** — after `staged = true;` and before
`const stagedStat = await stagedHandle.stat();`:

```ts
    try {
      // MANDATORY: open(2) masks its mode argument with the process umask, so a
      // restrictive umask (0277) would otherwise leave this stage at 0400 — and
      // on the no-publish-mode path that is exactly what `rename` publishes.
      // fchmod on the held descriptor is not umask-masked and cannot be
      // redirected by a pathname swap; never weaken this to a path chmod.
      await stagedHandle.chmod(STAGE_PRIVATE_MODE);
      const stagedStat = await stagedHandle.stat();
```

No `try`/`catch`, no error-code allowlist, no import from `secure-store`, and **no
following `sync()`**.

Placement is load-bearing and only this one is correct. `staged = true;` sits _outside_
the inner `try`; the outer `finally` unlinks only when `staged && !committed`, and the
inner `finally` owns `stagedHandle.close()`:

| Placement                         | On a chmod throw                                                    |
| --------------------------------- | ------------------------------------------------------------------- |
| Before `staged = true;`           | `staged === false` → stage file leaks **and** fd leaks              |
| After `staged = true;`, pre-`try` | Stage is unlinked, but the inner `try` was never entered → fd leaks |
| First statement inside `try`      | Inner `finally` closes, outer `finally` unlinks — no leak           |

Placing it ahead of the `stagedStat` capture also establishes the floor before any other
syscall observes the stage, and before `options.materialize` runs — which is what makes
the converting path's `/proc/self/fd/N` re-open work (`EACCES` at `0o400`, OK at
`0o600`, directly measured).

Note the design's Files section says "line 951". That is the insertion _position_; the
bare statement lands at 952 and at ~957 with the comment block (S8). Anchor on the quoted
text.

**Gate (GREEN proof):**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli src/lib/filesystem.test.ts
```

Expected: `Tests 57 passed (57)`. Baseline at `103c4881` was 56/56, re-measured in this
worktree.

### Task 7 — Contract suites and the umask sweep

**File:** none (verification only).

**Change:** none.

**Gate A — umask 077 leg of the target suite:**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && unset FORCE_COLOR; umask 077; npx vitest run --root packages/rfmedia-cli src/lib/filesystem.test.ts
```

Expected: `Tests 57 passed (57)`.

**Gate B — contract suites that must not move:**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli src/lib/convert.test.ts src/actions/verify-album.test.ts src/actions/verify-filter.test.ts
```

Expected: all pass, unchanged from HEAD.

**Gate C — completions no-diff tripwire:**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli src/lib/shell-completions/templates.spec.ts && git diff --stat -- packages/rfmedia-cli/src/lib/shell-completions/
```

Expected: spec passes, `git diff --stat` prints nothing. No completion change is
required: the fix adds, removes, and renames zero commands, subcommands, flags, or flag
values, `--fix` already exists in all three generators, and `rg filesystem` over
`src/lib/shell-completions/` returns zero hits.

**Do NOT add a `umask 002` leg.** Measured at HEAD: `umask 002` already fails
`filesystem.test.ts` 1/56 at `detects a changed destination parent before commit`,
because that test's own `mkdir` yields `0o775` and trips the group/world-writable guard.
Pre-existing and unrelated; a red cell in the PR's Testing table on a permissions change
gets the PR bounced.

**Do NOT launch vitest itself under `umask 0277`.** Vite cannot write its `.vite-temp`
bundle and the run dies at config load with `EACCES`. The `0277` coverage lives _inside_
the Task 2 test, which is exactly why it sets the mask itself. This means the issue's own
reproduction step (`umask 0277 && npx vitest run …`) is unrunnable as written — say so in
the PR body so a reviewer does not conclude the fix is unverifiable.

### Task 8 — ROADMAP.md closeout

**File:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307/ROADMAP.md`

**Prerequisite:** Task 0 (rebase) and Task 10 (follow-ups filed) must both be done first.
The count regeneration must run _after_ the follow-ups exist.

Full edit list, using the S3 validated line numbers. Every anchor is quoted text.

Presented as a list rather than a table because several anchors are themselves markdown
table rows and would break table parsing.

1. **Line 10** — anchor: the line beginning `**Open issues:** 80 (rfapps 38 · rfmedia 42)`.
   Replace the counts with the regenerated values. Expected `81 (rfapps 39 · rfmedia 42)`
   per S4. Keep the `#63 follow-ups (#328, #329, #330)` clause; it is still accurate.

2. **Line 50** — anchor: the line beginning
   `**Sprint 2** work (#307). Remaining rfapps medium UX`. Rewrite so Sprint 2 reads as
   complete and near-term focus moves to the parallel tracks. Remove `#307` as pending
   work.

3. **Lines 61-75** — anchor: the heading `### Sprint 2 — secure-store completion` through
   the `**Exit criteria:**` paragraph ending
   `#307 is closed or explicitly deferred.` The section now holds zero open rows. Per S2,
   move its narrative to `docs/roadmap-archive.md` and delete the whole section: the
   heading, the `Depends on shipped #288, #304, …` intro, the `#323` aside, the Order
   table, and the Exit criteria.

4. **Line 72** — the Sprint 2 Order-1 table row linking issue 307 with the cell text
   `verify --fix` under restrictive umasks. Deleted with the section above. It is the
   only row, so **no renumbering is needed**. _Corrected from design_, which said to
   renumber #308 from Order 2 to Order 1 — that row no longer exists after `019ce004`.

5. **Line 263** — anchor: `### Low priority — docs, polish & future ideas (27)`.
   Change the count to `(24)`. _Corrected from design_ (S7): the convention is
   table-row count; 25 rows minus the removed row is 24. Do **not** write `(26)`.

6. **Line 266** — anchor: the line beginning `<summary>Click to expand (#38, #50,`.
   Drop `#307` so the tail reads `#286–#287, #323`. Add the new follow-up issue numbers
   if either lands in a low-priority table.

7. **Line 293** — the low-priority backlog table row linking issue 307 with the summary
   cell `Fix verify --fix staging modes under restrictive umasks`. Delete the row.

8. **Line 309** — the cross-cutting `Secure artifact I/O` row. Rewrite the rfmedia cell
   from `#288, #304, #305, #306, and #308 shipped; …307… remains` to
   `#288, #304, #305, #306, #307, and #308 shipped`, and narrow the Notes cell
   accordingly — the theme is complete unless FU-1 is tracked here.

9. **Line 213** — anchor:
   `### Medium priority — copy, verify, policy & metadata (8)`. If FU-1 is filed as
   `priority:medium`, add its row to the table beneath and bump the heading to `(9)`.
   Precedent: `817d5d90` added a `#323` row and bumped its heading. _Corrected from
   design_, whose edit table has no row at all for the mandated follow-ups.

10. **Line 8** — anchor: `**Last updated:** 2026-08-08`. Already today's date. Bump only
    if the closeout commit lands on a later day.

**Gate:**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && grep -n '307' ROADMAP.md; gh issue list --state open --limit 200 --json number,labels --jq '[.[]|{a:([.labels[].name]|index("rfapps-cli")),m:([.labels[].name]|index("rfmedia-cli"))}]|{total:length,rfapps:map(select(.a))|length,rfmedia:map(select(.m))|length}'
```

Expected: `grep` prints **nothing** (every `#307` reference removed), and the regenerated
counts match the number written into the `**Open issues:**` line.

### Task 9 — `graphify update`

**File:** `graphify-out/` (generated).

**Change:** refresh the knowledge graph after the source change, per the project rule.

**Gate:**

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307 && graphify update .
```

Expected: completes without error. If `graphify` is not on `PATH`, skip and note it.

### Task 10 — File the two follow-up issues (ORCHESTRATOR ONLY)

**Agents must not run `gh issue create`.** The orchestrator files these. They must exist
before Task 8's count regeneration.

Use the YAML forms under `.github/ISSUE_TEMPLATE/`. Labels use `bug`, never `type:bug`
(S5).

#### FU-1 — `verify --fix` publishes `0o600` rather than a destination-derived mode

Labels: `bug`, `priority:medium`, `rfmedia-cli`. Template: `bug.yml`.

Body sketch: The `#307` fix makes the published mode of a repaired media file
_deterministic_ at `0o600`, but `0o600` is almost certainly the wrong published mode. The
non-converting `verify --fix` repair path calls `replaceFileWithValidatedStage` with only
`{ signal, materialize, validate }` from `verify-album.ts` and `verify-filter.ts`, so
`resolvePublishMode` returns `undefined`, the publication-mode block is skipped, and
`rename(2)` publishes the staging floor verbatim. A `0o644` track is therefore narrowed
to `0o600` under the ordinary `umask 022` as well, so a media server running under a
different `PUID` cannot read a track `verify` just reported as fixed. It is also
internally incoherent: `verify --fix --convert` passes `preserveDestinationMode: true`
plus `missingDestinationMode` for audio tracks, while `cover.jpg` and other non-audio
siblings in the same album take the `0o600` branch because `shouldConvert` returns
`false`. And it is a regression — before the tiered-verification refactor (#249) the same
repair used a path-based `copyOrLink` → `fse.copy` and inherited the source's mode.
Proposed fix: adopt `preserveDestinationMode: true` plus a `missingDestinationMode`
mirroring `convert.ts`. Note that the existing `filesystem.test.ts` assertion pinning
`0o600` must move with it — that assertion correctly pins the _helper's_ default when no
caller supplies a mode, and the helper should not invent a publication policy. This was
deliberately excluded from #307 because #307's own Expected Behavior rules `0o600` in
verbatim, and because it changes the published mode for every `verify --fix` user under
every umask, including `022`, where nothing is broken today.

#### FU-2 — `backup-docker.ts` publishes a umask-narrowed artifact via `link()`

Labels: `bug`, `priority:low`, `rfapps-cli`. Template: `bug.yml`.

Body sketch: `packages/rfapps-cli/src/lib/backup-docker.ts` creates its staging file with
`open(attemptPath, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)` and never chmods it
— `rg chmod` over the file returns zero hits. That same inode then becomes the shipped
artifact via `link(attemptPath, input.destinationPath)`, followed by
`unlink(attemptPath)`. Because `link()` creates a second name for the _same_ inode, the
published backup `.tar.gz` carries the umask-masked creation mode verbatim: `0o400` under
`umask 0277`. This is the identical defect class as #307 in `rfmedia-cli`'s
`filesystem.ts`, and the same one-line `fchmod`-on-the-held-descriptor fix applies. The
destination is `join(state.bundle.bundlePath, mount.artifactPath)` and does not pass
through `createBackupArtifact`/`finalizeBackupArtifact` in `backup-storage-write.ts`
(which already do the correct `open(..., PRIVATE_FILE_MODE)` plus `handle.chmod(...)`) —
indeed it cannot, because `link()` would throw `EEXIST`. It was left out of #307 because
it is a different package with a different intent: a read-only immutable archive is
arguably correct, no comment records the intent either way, and the call needs a
maintainer decision rather than a mechanical port.

### Task 11 — Commit and open the PR (ORCHESTRATOR ONLY)

Single commit containing the source fix, all three test edits, the CHANGELOG entry, the
ROADMAP closeout, and this plan directory.

Title: `fix(rfmedia): chmod the verify --fix staging handle`

`fix` because this is a user-visible behaviour change; scope `rfmedia` not `rfmedia-cli`
per the dominant convention (last 40 subjects: `(rfmedia)` 26, `(rfmedia-cli)` 0). The
title is the squash-merge subject and is gated by `.github/workflows/pr-title.yml`, whose
pattern is `^(feat|fix|docs|…)(\([^)]+\))?!?: .+` — the scope group is unconstrained.
Verified: this title passes both the Conventional-Commit and placeholder-reject greps.

**Do not label the PR** (S5). If the design and plan documents are committed separately
they must use `docs(internal): …`.

## Final gate sequence

Run in this order from the worktree root, all with `FORCE_COLOR` unset and `umask 022`.

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-fix-307

# 1. Typecheck. `pretypecheck` also runs codegen:lidarr:check, check:architecture,
#    and test:architecture (66 node tests, ~17s), so it subsumes the next command.
unset FORCE_COLOR; umask 022; npm run typecheck -w packages/rfmedia-cli

# 2. Architecture check, run explicitly for a named PR Testing row.
unset FORCE_COLOR; umask 022; npm run check:architecture -w packages/rfmedia-cli

# 3. Full monorepo suite. scripts/test-run.sh already cds to the repo root,
#    sets umask 022, and unsets FORCE_COLOR.
unset FORCE_COLOR; umask 022; npm run test:run

# 4. Markdown formatting and lint, both root-only scripts.
npm run format:md
npm run lint:md

# 5. Whitespace tripwire.
git diff --check
```

Expected results:

| Command                                              | Expected                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run typecheck -w packages/rfmedia-cli`          | Clean exit, no diagnostics.                                                                           |
| `npm run check:architecture -w packages/rfmedia-cli` | `OK: Plex/Lidarr dependency direction and authenticated fetch ownership across 340 production files.` |
| `npm run test:run`                                   | All workspaces green; `filesystem.test.ts` at 57 tests.                                               |
| `npm run format:md`                                  | Rewrites `ROADMAP.md` table padding; no other churn.                                                  |
| `npm run lint:md`                                    | 709+ files, `0 errors`.                                                                               |
| `git diff --check`                                   | No output.                                                                                            |

`check:architecture` is unaffected by this change: `lib/filesystem.ts` is inside the
scanned set, but every rule keys off a module specifier, a `fetch(` call site, a
Lidarr/Plex symbol, or the MusicBrainz manifest. A `chmod` method call on an
already-held `FileHandle` introduces none of those.

## Draft PR body

Fills every required section of `.github/pull_request_template.md` verbatim and in order.

---

## Summary

`rfmedia verify --fix` published a **read-only** repaired media file under a restrictive
umask. The replacement stage is created once with
`open(stagedPath, "wx+", STAGE_PRIVATE_MODE)`, and `open(2)` masks its `mode` argument
with the process umask — so under `umask 0277` the stage is created `0o400`, not `0o600`.
On the non-converting repair path both callers pass only
`{ signal, materialize, validate }`, so no publication mode is resolved, the mode block
is skipped, and `rename(2)` relinks the stage inode without touching its mode. A
destination that was `0o644` is republished at `0o400`, and a media server running under
a different `PUID` can no longer read the track `verify` just reported as fixed.

This adds one `fchmod` on the held stage descriptor as the first statement inside the
staging `try`. `fchmod(2)` is not umask-masked, so the documented `0o600` floor becomes
enforced rather than merely requested. The same one-line pattern already exists in
`secure-store/atomic.ts`, whose comment names this exact failure:

```text
// MANDATORY: the `mode` argument is ignored for an existing file and a
// restrictive umask (0277) would otherwise yield 0400.
```

Scope note: this makes the _staging floor_ umask-proof. `verify --fix` against a **new**
album directory still fails under `umask 0277` — `ensureDir` creates the intermediate
`Artist/` directory `0o500` and the nested `mkdir` throws `EACCES` before any staging.
That is fail-closed, pre-existing, and about directories rather than file modes. The
claim here is scoped to a pre-existing album directory that is **not** group- or
world-writable.

Also: the converting path with a _missing_ destination still publishes `0o400` under
`umask 0277`, because `convert.ts` computes `0o666 & ~process.umask()`, which is exactly
`0o400` at that mask. That is the caller's deliberate, umask-aware default — the mode an
ordinary `cp` or `touch` would produce — and it is not the staging floor. It is named
here because it will look like an unfixed umask bug to anyone re-running the issue's
reproduction with `--convert`.

## Changes

- `packages/rfmedia-cli/src/lib/filesystem.ts` — enforce the staging floor with
  `await stagedHandle.chmod(STAGE_PRIVATE_MODE);` as the first statement inside the
  staging `try`, plus a comment recording why the placement and the descriptor form are
  load-bearing. One sentence appended to the `STAGE_PRIVATE_MODE` docstring. No new
  import, no new export.
- `packages/rfmedia-cli/src/lib/filesystem.test.ts` — new
  `"holds and publishes the staging floor under a restrictive umask"` test exercising the
  real `process.umask(0o277)` with the exact option shape `verify --fix` uses; reworked
  publication-mode proxy recording every chmod into `chmodEvents`; one-token re-gate of
  the concurrent-swap latch.
- `packages/rfmedia-cli/CHANGELOG.md` — `### Fixed` entry under `## [Unreleased]`.
- `ROADMAP.md` — #307 closeout, count regeneration, and Sprint 2 archival.

Placement is not incidental. `staged = true;` sits outside the inner `try`; the outer
`finally` unlinks only when `staged && !committed` and the inner `finally` owns
`close()`. Chmodding before `staged = true;` leaks the stage file and the fd; chmodding
between `staged = true;` and the `try` leaks the fd. Only the first statement inside the
`try` gets both. Placing it ahead of the `stat` capture also establishes the floor before
`materialize` runs — which is what keeps the converting path's `/proc/self/fd/N`
handoff to ffmpeg working, since a `/proc/self/fd/N` re-open for write is
permission-checked against the inode mode (`EACCES` at `0o400`, OK at `0o600`). That is a
verified _mechanism_; a real ffmpeg conversion under `umask 0277` was not run end to end.

The chmod is deliberately not wrapped in `try`/`catch`. `convert.ts` guarantees a
publication mode, so an `fchmod` on this same handle already runs unconditionally and
fatally on every converted file — "fchmod must succeed on this filesystem" is already a
hard precondition of this helper on its most-exercised path. A tolerant branch would also
mask `EIO`/`EPERM` from a genuinely failing filesystem, against repo policy.

Note: the issue's reproduction step `umask 0277 && npx vitest run …` is **unrunnable as
written** — Vite cannot write its `.vite-temp` bundle under that mask and the run dies at
config load with `EACCES`. The `0277` coverage therefore lives _inside_ the new test,
which sets and restores the mask itself in a `finally`.

## Testing

<!-- Fill each Result cell with the real observed output before submitting. -->

| Command                                                                                                                                                               | Result |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli src/lib/filesystem.test.ts` (before source fix — RED proof)                                 |        |
| `unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli src/lib/filesystem.test.ts`                                                                 |        |
| `unset FORCE_COLOR; umask 077; npx vitest run --root packages/rfmedia-cli src/lib/filesystem.test.ts`                                                                 |        |
| `unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli src/lib/convert.test.ts src/actions/verify-album.test.ts src/actions/verify-filter.test.ts` |        |
| `unset FORCE_COLOR; umask 022; npx vitest run --root packages/rfmedia-cli src/lib/shell-completions/templates.spec.ts`                                                |        |
| `git diff --stat -- packages/rfmedia-cli/src/lib/shell-completions/`                                                                                                  |        |
| `unset FORCE_COLOR; umask 022; npm run typecheck -w packages/rfmedia-cli`                                                                                             |        |
| `unset FORCE_COLOR; umask 022; npm run check:architecture -w packages/rfmedia-cli`                                                                                    |        |
| `unset FORCE_COLOR; umask 022; npm run test:run`                                                                                                                      |        |
| `npm run lint:md`                                                                                                                                                     |        |
| `git diff --check`                                                                                                                                                    |        |

No `umask 002` leg is included. Measured at the pre-fix baseline, `umask 002` already
fails `filesystem.test.ts` 1/56 at `detects a changed destination parent before commit`,
because that test's own `mkdir` yields a `0o775` directory that trips the
group/world-writable parent guard. Pre-existing and unrelated to this change.

## Related Issues

Closes #307.

## Breaking Changes

None. The published mode of a repaired media file was already `0o600` under every umask
this fix does not change (`000`, `002`, `022`, `027`, `077`), where the chmod is a no-op.
The chmod is monotone — it can only restore owner bits the umask cleared and can never
set a group or other bit — so the documented "unobservable to other users" property is
preserved verbatim.

## Risk and Rollback

Risk level: **Low**, with one genuinely new failure mode.

1. **New: fatal `fchmod` on FAT-family destinations.** On a vfat/exFAT mount with e.g.
   `fmask=0133`, `fat_setattr` → `fat_sanitize_mode` returns `EPERM` for any mode whose
   r/x bits differ from the inode's, so `fchmod(0o600)` is a hard error rather than a
   no-op. This turns a currently-working _non-converting_ `verify --fix` into a hard
   failure on such mounts. `--convert` users already depend on a fatal `fchmod` on this
   same handle, so that class is unchanged; the non-converting path is newly exposed.
   Not tested — no FAT mount available. Cleanup is still correct: the throw propagates
   through the inner `finally` (close) and outer `finally` (unlink), leaving the
   destination untouched. Follow-up shape if anyone reports it: tolerate
   `EPERM`/`ENOTSUP` by re-stat'ing and throwing only when the resulting mode is actually
   _wider_ than the floor.
2. **The published mode of a repaired media file stays `0o600`** — deterministic now
   rather than umask-dependent, but still narrower than the destination it replaced.
   Tracked as a separate follow-up rather than silently ratified here, because #307's own
   Expected Behavior rules `0o600` in verbatim and changing it would alter behaviour for
   every `verify --fix` user under every umask.
3. **Pre-existing hazard newly exposed:** a non-`ENOENT` throw from the staged-file
   unlink in the outer `finally` replaces the in-flight exception and would mask a chmod
   error. `unlink` needs only `+wx` on the parent, independent of the stage's own mode, so
   this is unlikely — but a chmod-throwing filesystem is exactly where it would matter.
4. One extra `fchmod` syscall per staged replacement — negligible against the four
   `stat`s, two `sync`s, two `realpath`s and several `lstat`s already on the path.

Rollback: revert the single commit. The source change is one statement in one function
with no new imports, no new exports, no schema change, and no persisted state, so a
revert restores prior behaviour exactly. The ROADMAP and CHANGELOG edits are independent
of the code and can be reverted separately.

## Checklist

- [x] I ran targeted tests/typecheck and listed exact commands. — see `## Testing`.
- [x] I updated docs or explained why docs are not needed. — no user-facing doc states
      the resulting permission bits of a repaired file; the two "permission" hits in
      `verify-auto-fix.doc.md` are about failure diagnosis. The rationale belongs at the
      chmod call site, mirroring `secure-store/atomic.ts`. `CHANGELOG.md` is updated.
- [x] I reviewed scope for regressions and side effects. — sibling-site sweep of every
      mode-passing creation site in `packages/*/src` is recorded in the design; #307 is a
      one-site fix within `rfmedia-cli`. The one other same-class site
      (`rfapps-cli/src/lib/backup-docker.ts`) has its own follow-up issue.
- [ ] If Docker/Compose behavior changed, I validated with `docker compose config --quiet`.
      — **not applicable**; no Docker or Compose surface is touched.

---

## Files changed by this plan

- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`
- `packages/rfmedia-cli/CHANGELOG.md`
- `ROADMAP.md`
- `docs/roadmap-archive.md` (Sprint 2 narrative, per S2)
- `docs/plans/issue-307-stage-umask/design.md`, `.../plan.md`

Nothing else. No caller, no `convert.ts`, no `secure-store`, no completion template, no
command module, no config file, no public error type. No `parallel-plan.md` is warranted:
this is one task with zero parallelism, and the nearest precedent (`baeee7f7`, a
comparable `priority:low` corrective fix) shipped source plus test with no plan directory
at all.
