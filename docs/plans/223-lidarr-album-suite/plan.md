# Issue #223 — Lidarr Album Suite: Parallel Implementation Plan

Merged from two independent drafts (risk-min + max-parallel), adversarially verified against
`docs/plans/223-lidarr-album-suite/design.md` (ground truth, incl. §12 decisions) and against the
worktree code. Worktree: `.claude/worktrees/issue-223-lidarr-albums`, branch
`feat/lidarr-album-suite-223`. All source paths below are relative to `packages/rfmedia-cli/`
unless noted.

## Overview

Delivers the remaining #223 scope: the `lidarr albums` read leaf, the `plan album-delete` +
two-key apply authorization lane (first file-destructive operation, parallel album-typed v2
definition), the severable `plan album-edit` (anyReleaseOk) lane, and the behavior-preserving
extraction of album scan/selection primitives from shipped PR #259 code.

Structure: Draft A's risk ordering (additive projections proven first; the
plan-album-operations + plan-engine task runs SOLO in its batch; completions/docs strictly after
the registered command surface) combined with Draft B's parallelism (four independent
foundations in batch 1; presenter and read action pulled forward; producers ∥ apply; factory
files split) and Draft B's coverage fixes (the shared client mock and resilience.test.ts are
mandatory when `LidarrClientApi` widens — verified: `MockedCapability<LidarrClientApi>` maps
every interface key).

## Batches

| Batch | Tasks          | Parallel | Contents                                                                            |
| ----- | -------------- | -------- | ----------------------------------------------------------------------------------- |
| 1     | T1, T2, T3, T4 | 4-wide   | Domain/wire types; plan-artifact types; scan/selection extraction; arch-gate rule   |
| 2     | T5, T6, T7     | 3-wide   | Client mutations (+mock/resilience/pins); `executeLidarrAlbums`; presenter branches |
| 3     | T8             | solo     | plan-album-operations + plan-engine dispatch (riskiest — isolated)                  |
| 4     | T9, T10        | 2-wide   | Producers + barrel; apply lane                                                      |
| 5     | T11, T12       | 2-wide   | `createLidarrAlbumsCommand`; `lidarr-album-mutations.ts` factories                  |
| 6     | T13            | solo     | Root wiring in `lidarr.ts` + `lidarr.test.ts` pins + apply auth flags               |
| 7     | T14, T15       | 2-wide   | Completions lockstep; docs/CHANGELOG/ROADMAP/archive                                |
| 8     | T16            | solo     | Full gate suite certification                                                       |

Intra-batch rules: file sets are strictly disjoint and there are no intra-batch dependencies.
Because `npm run typecheck` compiles the whole package, a task's typecheck may transiently fail
on a sibling's half-written file mid-batch — run scoped vitest first, typecheck last, and treat
the batch-final gate as authoritative. After EVERY batch the orchestrator runs:
`npm run typecheck --workspace packages/rfmedia-cli && npm run test:run --workspace packages/rfmedia-cli`
— the tree must be green before the next batch starts.

## Frozen files (no task may edit; re-verified in T3/T8/T16)

- `src/actions/lidarr/plan-albums.test.ts` (§9 test 9 — extraction regression net)
- `src/lib/lidarr/plan-engine.test.ts` + all v1/v2 artifact fixtures (§9 test 1)
- `src/lib/lidarr/plan-operation-definitions.ts` (artist lane untouched)

## Tasks

### T1 — Album domain types + tolerant wire projections (batch 1)

- **Files (modify)**: `src/types/lidarr.ts`, `src/lib/lidarr/types.ts`
- **Spec**: `LidarrAlbum` (:201-216) += optional `anyReleaseOk?: boolean`, `releaseDate?: string`,
  `foreignAlbumId?: string`; new `LidarrAlbumDeleteInput { deleteFiles; addImportListExclusion }`.
  Widen `LidarrAlbumWire`/`isLidarrAlbum`/`copyAlbum`/`projectLidarrAlbum` (:407-463, :595-617,
  :925-936) tolerantly: conditional spread so wire albums WITHOUT the fields project
  byte-identically; strings sanitized/truncated via existing helpers; guard never rejects albums
  it accepts today.
- **Tests**: none new (§9 lists none); existing suite is the regression net.
- **Verify**: scoped `types.test.ts` run + workspace typecheck.

### T2 — Plan artifact v2 type extensions (batch 1)

- **Files (modify)**: `src/types/lidarr-plan.ts`
- **Spec**: design §5 verbatim — `LidarrAlbumEditOperationV2`/`LidarrAlbumDeleteOperationV2`;
  entry interfaces (id `album:${albumId}`; delete before `{monitored, trackFileCount, sizeOnDisk}`,
  after `{deleted: true}`; edit before/after `{anyReleaseOk}`); NO kind field on entries;
  selection arms `album-ids`/`album-filters`; summary + observed-state variants;
  `LidarrPlanApplyFailure.operation` widened; additive `failure?` on
  `LidarrAlbumPlanApplyEntryResult` (:414-423); history record UNCHANGED; staleness codes reuse
  `album-missing`/`album-state-drift`. §12.3: prefer `LidarrMutationOperationV2Extended` union
  (artist switches at plan-operation-definitions.ts:873-884 stay untouched); document the choice
  in a doc comment — T7/T8/T10/T13 consume these exact exports.
- **Tests**: none owned (exercised by T8/T10).

### T3 — Extraction: album-selection.ts + album-scan.ts (batch 1)

- **Files (create)**: `src/lib/lidarr/album-selection.ts` (+`.test.ts`),
  `src/actions/lidarr/album-scan.ts`; **(modify)**: `src/actions/lidarr/plan-albums.ts`
- **Spec**: pure module (filter AND-across/OR-within via `matchesAlbumTypeSelectors`; hasFiles =
  `(statistics?.trackFileCount ?? 0) > 0`; deterministic artistId→albumId sort; limit/offset
  window; moved `countBySelector`/`dedupeAlbums`). I/O scan extracted verbatim-in-behavior from
  plan-albums.ts:87-255, parameterized `{taskIdPrefix, operationLabel}` so
  `lidarr-plan-album-monitoring*` task ids and all messages stay byte-identical. plan-albums.ts
  refactored to consume both; exported API/messages/shapes unchanged.
- **Tests**: §9 test 9 (plan-albums.test.ts UNCHANGED, `git diff --exit-code`) +
  design-mandated album-selection unit tests.

### T4 — Architecture-gate ownership rule + self-test (batch 1)

- **Files (modify)**: `scripts/check-direct-plex-imports.mjs` (+`.test.mjs`)
- **Spec**: new rule id (e.g. `lidarr-album-mutation-owner`) mirroring
  `LIDARR_PROFILE_TAG_MUTATION_METHODS` (:41): `deleteAlbum`/`setAlbumAnyReleaseOk` call sites
  restricted to `src/lib/lidarr/plan-album-operations.ts` + `src/lib/lidarr/resilience.ts`.
  PURE allowlist — must pass with zero call sites (T8's owner file lands in batch 3). Self-test
  (§9 test 13 half): unauthorized property-access call flagged; owner fixtures pass; zero call
  sites pass; AND the verified pre-existing collision — `src/actions/clean.ts:571` has an
  unrelated local `const deleteAlbum = async …` with bare calls; the checker-based identifier
  path resolves it to an arrow initializer (no violation) — pin this with a fixture.
- **Verify**: `check:architecture` + `test:architecture`.

### T5 — Client mutations + resilience + shared mock + contract pins (batch 2, deps T1)

- **Files (modify)**: `src/lib/lidarr/client.ts` (+`.test.ts`), `src/lib/lidarr/resilience.ts`
  (+`.test.ts`), `src/lib/lidarr/generated-contract.test.ts`,
  `src/actions/test-helpers/lidarr-client-mocks.ts`
- **Spec**: `deleteAlbum(albumId, LidarrAlbumDeleteInput, signal?)` via `deleteApiV1AlbumById`
  through `#executeVoid` + `parseAs:"stream"`; query params deleteFiles/addImportListExclusion;
  `validatePositiveId`; 404 PROPAGATES (no swallowing — §10). `setAlbumAnyReleaseOk` = confined
  GET→mutate-one-field→PUT with path id `String(albumId)` (types.gen.ts:1785-1792 quirk); raw
  DTO never escapes; all unprojected wire fields forwarded verbatim. NO `getAlbum` facade; NO
  FETCH_OWNERS change. Resilience: hand-wire both into `wrapped` (:604); NOT in
  `LIDARR_IN_PLACE_RETRY_ALLOWLIST` (defer-only). Mock: add both methods to
  `createLidarrClientMock` (MockedCapability requires every key — omitting breaks typecheck
  repo-wide). resilience.test.ts: allowlist-absence assertion mirroring :324.
- **Tests**: §9 tests 6, 7, 8.

### T6 — executeLidarrAlbums read action (batch 2, deps T1+T3)

- **Files (create)**: `src/actions/lidarr/albums.ts` (+`.test.ts`)
- **Spec**: TIER `"local-only"`; options/result per §5; exactly-one scope guard; scan via T3
  (`--all` → `scanSelectedArtists(client, undefined)`; scope guard at client.ts:566-576 never
  weakened); filter → total → deterministic sort → page → rows with artistName; no cache /
  --allow-stale; fail-closed on any failed batch task. Own task ids `lidarr-albums*`. Barrel
  export deferred to T9.
- **Tests**: §9 test 11.

### T7 — Presenter album branches + authorization helpers (batch 2, deps T2)

- **Files (modify)**: `src/commands/lidarr-mutation-presenter.ts`
- **Spec**: `describePlanOperation`/`describeSelection` album cases; delete render = red bold
  DESTRUCTIVE banner, mode lines, risk cascade incl. import-list re-add warning (§12.4 —
  cascade line only), 20-row sample (Album ID, Album, Artist, Files, Size, Monitored),
  authorization hint naming `--allow-album-deletion`/`--allow-file-deletion`; edit render =
  Before/After anyReleaseOk. Exported helpers `requiresAlbumDeletionAuthorization` /
  `requiresFileDeletionAuthorization` (style of `requiresTagReplacementAuthorization` :394) —
  names consumed verbatim by T13. Confirm label "destructive album-deletion (N albums, M files,
  X GB)". Do not restructure `renderMutationApply`'s `"albumId" in entry` branch. No test file
  (§9 preamble).

### T8 — plan-album-operations + plan-engine dispatch (batch 3, SOLO, deps T2+T5)

- **Files (create)**: `src/lib/lidarr/plan-album-operations.ts` (+`.test.ts`);
  **(modify)**: `src/lib/lidarr/plan-engine.ts`
- **Spec**: album-typed sibling definition interface (`classify/verify/loadCurrentStates` over
  `LidarrAlbum | undefined` via `listAlbums({albumIds})`); frozen `ALBUM_EDIT_DEFINITION`
  (undefined/omitted anyReleaseOk → drifted fail-closed) and `ALBUM_DELETE_DEFINITION`
  (missing → satisfied; monitored/foreignAlbumId drift → drifted; verify = absence); deferred
  constants `lidarr.album-edit`/`lidarr.album-delete`; payload revalidation via
  `requireExactKeys`/`assertNoSensitiveKeys` imported from `src/lib/lidarr/plan-validation.ts`
  (NOT the engine — Draft B misattribution corrected); exact-allowlist validators; separate
  `buildLidarrAlbumMutationPlanV2` (albumId sort/dedupe; caps; sealed via exported engine
  checksum/createdBy helpers; version `rfmedia.lidarr-plan.v2`); risk summaries (delete
  high/destructive; edit medium). plan-engine: ADDITIVE cases in `requireOperationV2` (:1358),
  `requireEntryV2` (:1484+), summary/canonicalizer, `expectedV2IdempotencyKey`/`expectedV2Risk`
  (:1458-1468); executor registry append (:562-574); `requireEntryIdentity` untouched.
  ESM-cycle guard: all cross-module references function-scoped.
- **Tests**: §9 tests 1 (frozen files byte-identical, `git diff --exit-code`) and 2
  (round-trip + tamper rejection).

### T9 — Producers + barrel (batch 4, deps T3+T6+T8)

- **Files (create)**: `src/actions/lidarr/plan-album-delete.ts` (+`.test.ts`),
  `src/actions/lidarr/plan-album-edit.ts` (+`.test.ts`); **(modify)**: `src/actions/lidarr/index.ts`
- **Spec**: delete — exactly one mode, NO --all; selector mode REQUIRES artistIds
  ("album deletion requires an explicit --album-ids or --artist-ids scope"); monitored excluded
  by default (`excludedMonitored`), `includeMonitored` opt-in; destruction mode sealed
  (deleteFiles/addImportListExclusion, defaults false); honest summary; caps (1000 entries /
  maxBatch default 25 cap 1000, §12.2) with narrow-hints; dry-run writes nothing; >200 IDs =
  sequential fail-fast chunks (§12.6). Edit — triad validation; changes-only; fail-closed on
  omitted anyReleaseOk; own task-id prefixes. Barrel exports all three actions + types (owned
  here so batch-5 factories import a complete `index.js`).
- **Tests**: §9 test 10.

### T10 — Apply lane (batch 4, deps T5+T8)

- **Files (create)**: `src/actions/lidarr/apply-album-mutation-execution.ts`; **(modify)**:
  `apply.ts`, `apply.test.ts`, `apply-entry-execution.ts`, `apply-deferred-replay.ts`,
  `apply-deferred-replay-outcomes.ts`
- **Spec**: options += `allowAlbumDeletion?`/`allowFileDeletion?`; fail-closed two-key gates
  beside the tag gate (:686-696; --yes never substitutes; dry-run exempt); definition union
  (:86-88) += album member; **kind-first routing everywhere** (album v2 entries also satisfy
  `"albumId" in entry` — the misroute trap); preflight via loadCurrentStates (delete missing →
  satisfied; drift → stale with existing codes); per-entry lifecycle: fresh re-read → dispatch
  (runSingle) → isNotFound==satisfied (delete) / retryable → deferred (never hot-retry) →
  bounded verification (ATTEMPTS=3/DELAY=100ms; absence for delete, value for edit) → failed
  (stage "verification") / uncertain; history-write failure → uncertain + stopAdmissions.
  Replay: album-delete not-found → success.
- **Tests**: §9 tests 3 (action half), 4, 5.

### T11 — Read-leaf factory (batch 5, deps T6+T9)

- **Files (modify)**: `src/commands/lidarr-albums.ts`
- **Spec**: `createLidarrAlbumsCommand(deps)` per §3.1 — exact scope/filter/paging/connection
  flags, exactly-one-scope error message, lazy import from `../actions/lidarr/index.js`,
  `LIDARR_ALBUMS_CSV_COLUMNS` multi-row CSV, `staleHint:false`, sensitiveValues fix on the Deps
  type (:36-40). NOT registered here.

### T12 — Mutation-leaf factories (batch 5, deps T7+T9)

- **Files (create)**: `src/commands/lidarr-album-mutations.ts`
- **Spec**: `createLidarrPlanAlbumEditCommand` (triad + `--any-release-ok`/`--no-any-release-ok`
  pair with explicit-presence detection; "Pass --any-release-ok or --no-any-release-ok") and
  `createLidarrPlanAlbumDeleteCommand` (NO --all option exists; `--include-monitored`,
  `--delete-files`, `--add-import-list-exclusion`; presenter destructive render). Shared Deps
  interface; no imports from `./lidarr.js`; no `-v`.

### T13 — Root wiring + pins (batch 6, SOLO, deps T10+T11+T12)

- **Files (modify)**: `src/commands/lidarr.ts`, `src/commands/lidarr.test.ts`
- **Spec**: register albums after `list` (:1238-1245; order status, list, albums, wanted,
  health, search, lookup, plan, apply); plan factories after artist-tags (:1115; album-edit then
  album-delete LAST); apply Safety flags `--allow-album-deletion`/`--allow-file-deletion` +
  command-layer pre-checks via T7 helpers (pattern :1164-1174) + pass-through at BOTH
  executeLidarrApply call sites; `LidarrSuccessCommand` += "lidarr-albums". Tests: hierarchy
  pins (:588-608), parse-time conflict/required-flag matrix for all three leaves, apply option
  pin, command-layer authorization matrix (§9 tests 12 + 3 command half).

### T14 — Completions lockstep (batch 7, deps T13)

- **Files (modify)**: `src/lib/shell-completions/{bash,zsh,fish}.ts`, `templates.spec.ts`
- **Spec**: design §8 exactly — 9-element lidarr tree, 6-element plan tree, exact option arrays
  for albums/album-edit/album-delete, apply += 2 flags, bash word-detection for "albums" with
  lidarr-scoped guards, fish `-r`/`-r -F`/`-xa` matrix, allow-stale parity untouched
  (§9 test 13 completion half).

### T15 — Docs + ROADMAP (batch 7, deps T13)

- **Files**: create `packages/rfmedia-cli/docs/features/lidarr-albums.md`; modify
  `packages/rfmedia-cli/README.md`, `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`,
  `packages/rfmedia-cli/CHANGELOG.md`, repo-root `ROADMAP.md`, `docs/roadmap-archive.md`
- **Spec**: design §8 docs bullets; §3 examples verbatim; authorization table; already-deleted==
  satisfied note; #200 scope-boundary note; ROADMAP ship date 2026-07-24 with greppable
  `[#TBD]` PR placeholders (orchestrator substitutes at PR time); markdownlint/prettier clean.

### T16 — Final validation (batch 8, deps T14+T15)

Full gate suite; fix only mechanical formatting fallout, report real defects to owning tasks:

```
npm run typecheck --workspace packages/rfmedia-cli   # chains codegen:lidarr:check + check:architecture + test:architecture
npm run test:run --workspace packages/rfmedia-cli    # certifies §9 tests 1-13
npm run format:check                                  # repo root; npm run format if needed, then re-gate
npm run lint:md
git diff --check
git diff --exit-code -- packages/rfmedia-cli/src/actions/lidarr/plan-albums.test.ts \
  packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts \
  packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts
grep -n 'TBD' ROADMAP.md docs/roadmap-archive.md      # PR-number placeholders present
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps && graphify update .
```

Report per-gate pass/fail verbatim — feeds the PR `## Testing` section. No push CI on master;
PR CI is the only automated gate before squash-merge.

## Validation gates (every batch + final)

1. `npm run typecheck --workspace packages/rfmedia-cli`
2. `npm run test:run --workspace packages/rfmedia-cli`
3. `npm run format:check` (final; per-task prettier on touched files encouraged)
4. Frozen files never edited (git diff --exit-code, enforced in T3/T8/T16)

## Cross-cutting risks

1. **Pinned-fixture byte compatibility** (§9 test 1): T8/T10 strictly additive; frozen files re-checked by git diff.
2. **Kind-first routing**: every dispatch point switches on `plan.operation.kind` FIRST; `"albumId" in entry` shape-narrowing misroutes album v2 entries into the v1 lane.
3. **plan-engine ↔ plan-album-operations ESM cycle**: single owner (T8); function-scoped cross-references only.
4. **§12.3 union choice** made in T2, documented in-file; T7/T8/T10/T13 follow it, never re-decide.
5. **LidarrClientApi tri-implementation** (class / decorator / MockedCapability mock): all three updated atomically in T5.
6. **Four-file completion lockstep** (T14) mirrors T13's registered surface exactly; command files are ground truth.
7. **Arch-gate order-safety**: pure allowlist passes with zero call sites (batch 1) and with resilience call sites (batch 2) before the T8 owner exists; clean.ts's unrelated local `deleteAlbum` pinned as a non-violation.
8. **Destructive-lane defense in depth** spans producer (T9), sealed types/builder (T2/T8), apply two-key + verification (T10), command gates (T13) — no layer may assume another compensates.
9. **Intra-batch typecheck instability**: scoped tests first, typecheck last, batch-final gate authoritative.
10. **[#TBD] PR-number placeholders** in ROADMAP/archive must be substituted at PR creation.
