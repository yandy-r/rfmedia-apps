# Plan: Lidarr Import Validation and Track Filtering

## Summary

Add a read-only `rfmedia lidarr validate-import` report that exposes Lidarr's own manual-import
matching evidence, then add a destructive `rfmedia lidarr plan track-filter` lane that seals exact
album/track/trackfile deletion intent for the existing `lidarr apply` workflow. The implementation
keeps all generated SDK access behind `LidarrClientApi`, retains uncertain files, deletes only
through Lidarr's bulk trackfile endpoint, updates all three completion templates, and closes the
remaining Layer 1 roadmap item.

## User Story

As a Lidarr operator, I want to validate album matches before import and review an exact retention
plan after acquisition, so that I can avoid importing the wrong release and remove only tracks I
intentionally excluded.

## Problem → Solution

Manual UI inspection and unsealed filesystem cleanup → deterministic pre-import diagnostics plus an
origin-bound, integrity-checked Lidarr plan/apply mutation with fail-closed retention.

## Metadata

- **Complexity**: XL
- **Source PRD**: `docs/prps/specs/lidarr-import-validation-track-filtering.spec.md`
- **PRD Phase**: APPROVED
- **Estimated Files**: 31

---

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-216/` (branch:
  `feat/216-lidarr-import-validation`)

## UX Design

### Before

```text
local album folder ──> Lidarr UI/manual inspection ──> import
acquired album ──────> ad hoc filesystem deletion
```

### After

```text
local folder
    │
    └─> rfmedia lidarr validate-import <folder>
            └─> ready / ambiguous / rejected / unmatched report (read-only)

exact Lidarr album
    │
    └─> rfmedia lidarr plan track-filter --album-id N
            --keep-track-ids ... and/or --min-stars ...
            └─> report + sealed plan (no mutation)
                    └─> rfmedia lidarr apply --plan ... --allow-file-delete
                            └─> Lidarr bulk trackfile delete + fresh verification
```

### Interaction Changes

| Touchpoint                 | Before                           | After                                                | Notes                                     |
| -------------------------- | -------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| `lidarr validate-import`   | No CLI support                   | Reports Lidarr manual-import evidence                | Diagnostic unless `--fail-on` is set      |
| `lidarr plan track-filter` | No safe filtering workflow       | Previews and optionally writes one sealed album plan | Requires at least one retention criterion |
| `lidarr apply`             | Artist/album mutation plans only | Also applies exact trackfile-filter plans            | Requires existing `--allow-file-delete`   |
| JSON/CSV output            | No import/filter schemas         | Stable machine-readable report rows                  | stdout remains data-only                  |
| Shell completion           | No discovery                     | Bash, Zsh, and Fish expose the full new surface      | Covered by parity tests                   |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                                                        | Lines                                                     | Why                                                                   |
| -------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| P0 (critical)  | `docs/prps/specs/lidarr-import-validation-track-filtering.spec.md`          | all                                                       | Approved behavior and safety contract                                 |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/lidarr/client.ts`                             | 1-7, 163-260, 752-794, 1228-1385                          | Generated-client boundary, public facade, strict calls                |
| P0 (critical)  | `packages/rfmedia-cli/src/types/lidarr-plan.ts`                             | 1-140, 310-469, 524-745                                   | Versioned plan, entry, result, and history unions                     |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts`              | 90-152, 600-1015                                          | Parallel operation-definition and sealed-builder pattern              |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`                        | 760-1080, 1300-1710, 1810-2005, 2400-2460                 | Canonicalization, parsing, validation, and routing switches           |
| P0 (critical)  | `packages/rfmedia-cli/src/actions/lidarr/apply-album-mutation-execution.ts` | 1-220, 300-620                                            | Admission, history, dispatch, and reconciliation invariants           |
| P0 (critical)  | `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`          | all                                                       | Kind-first apply dispatch and cancellation boundary                   |
| P0 (critical)  | `packages/rfmedia-cli/src/actions/lidarr/apply.ts`                          | all                                                       | Plan-level ownership, origin binding, resume, and stop-admission flow |
| P1 (important) | `packages/rfmedia-cli/src/lib/lidarr/types.ts`                              | 1-120, 1305-1652                                          | Strict frozen wire-to-domain projectors                               |
| P1 (important) | `packages/rfmedia-cli/src/types/lidarr.ts`                                  | all                                                       | Public command-facing Lidarr domain model                             |
| P1 (important) | `packages/rfmedia-cli/src/commands/lidarr-audit.ts`                         | 1-180, 520-760                                            | Lazy leaf command, stable report schemas, `--fail-on`                 |
| P1 (important) | `packages/rfmedia-cli/src/commands/lidarr-album-mutations.ts`               | all                                                       | Injected command-factory dependencies and plan writing                |
| P1 (important) | `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`            | all                                                       | Human/machine plan/apply rendering and authorization checks           |
| P1 (important) | `packages/rfmedia-cli/src/commands/lidarr.ts`                               | 38-191, 436-925, 1141-1457                                | Command registration, parsers, apply options, failure contract        |
| P1 (important) | `packages/rfmedia-cli/src/lib/ratings.ts`                                   | 1-92, 476-530                                             | Normalized local rating read and unreadable/unrated contract          |
| P1 (important) | `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`                  | 1658-1680, 2546-2625                                      | Committed generated signatures; never import outside the facade       |
| P1 (important) | `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`                | manual-import, track, and trackfile resource declarations | Exact optional wire fields to project                                 |
| P2 (reference) | `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`      | all                                                       | Shared typed client test seam                                         |
| P2 (reference) | `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts`          | all                                                       | Stable fixture conventions                                            |
| P2 (reference) | `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`          | all                                                       | Cross-shell completion parity assertions                              |
| P2 (reference) | `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`                   | all                                                       | Existing user-facing safety language                                  |

## External Documentation

| Topic               | Source                                             | Key Takeaway                                                                             |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Lidarr API contract | `packages/rfmedia-cli/openapi/lidarr-openapi.json` | The committed snapshot is authoritative for supported endpoint/query/body shapes         |
| Manual import probe | Generated `getApiV1Manualimport` types             | The GET response carries matcher resources, audio tags, and rejections without importing |
| Trackfile deletion  | Generated `deleteApiV1TrackfileBulk` types         | Body accepts exact `trackFileIds`; the endpoint has no trash/recovery option             |
| Local ratings       | Existing `readRating()` implementation             | Ratings normalize to `0.0-1.0`; `null` covers unrated and read failures                  |

No live external research is needed because the repository pins and contract-tests the generated
OpenAPI snapshot used by this implementation.

---

## Patterns to Mirror

### Generated Client Boundary

```ts
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/client.ts:3-7
 * Generated code owns endpoint paths, methods, query serialization, and wire
 * response types. The handwritten facade owns operation context, strict domain
 * projection, and the public error boundary.
```

### Facade Execution

```ts
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/client.ts:752-764
return this.#execute(
  "lidarr search",
  query.signal,
  () => getApiV1Search({ client: this.#generatedClient, query: { term: query.term } }),
  projectLidarrSearchCandidates,
);
```

### Action Scheduling

```ts
// SOURCE: packages/rfmedia-cli/src/actions/lidarr/health.ts:63-67
const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
  id: "lidarr-health",
  operation: "lidarr health",
  idempotent: true,
```

### Machine Output and Exit Gate

```ts
// SOURCE: packages/rfmedia-cli/src/commands/lidarr-audit.ts:8-16
 * Machine formats emit the `{command, result}` envelope on stdout
 * through `formatOutput`; human output goes to stderr only.
 * Audit is diagnostic by default; `--fail-on` is the explicit CI assertion.
```

### Sealed Plan Builder

```ts
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts:1004-1013
review: { requested: entries.length, changed, unchanged: entries.length - changed },
summary: definition.summarize(entries),
risk: definition.risk(),
payloadChecksum: computeLidarrPlanChecksum(planWithoutSeal),
```

### Apply History Failure

```ts
// SOURCE: packages/rfmedia-cli/src/actions/lidarr/apply-album-mutation-execution.ts:191-199
if (evidence.remoteSucceeded !== true) throw error;
return {
  result: albumEntryResult(context.entry, "uncertain", "history-write-failed",
    "Remote mutation succeeded but durable history failed; resume is required"),
```

### Test Structure

```ts
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.test.ts
describe("buildLidarrAlbumMutationPlanV2", () => {
  it("builds, canonicalizes, and seals an exact plan", () => {
```

---

## Files to Change

| File                                                                             | Action | Justification                                                                         |
| -------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/lidarr.ts`                                       | UPDATE | Add strict public manual-import, track, and trackfile domain contracts                |
| `packages/rfmedia-cli/src/lib/lidarr/types.ts`                                   | UPDATE | Project partial generated resources into frozen domain values                         |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts`                                  | UPDATE | Add probe/read/bulk-delete facade methods                                             |
| `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`                             | UPDATE | Prove query/body wiring and strict projection/error behavior                          |
| `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`           | UPDATE | Keep shared mock implementation in interface parity                                   |
| `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts`               | UPDATE | Add focused manual-import, track, and trackfile fixtures                              |
| `packages/rfmedia-cli/src/types/lidarr-import-validation.ts`                     | CREATE | Define stable finding, summary, threshold, and report contracts                       |
| `packages/rfmedia-cli/src/actions/lidarr/validate-import.ts`                     | CREATE | Classify manual-import evidence deterministically                                     |
| `packages/rfmedia-cli/src/actions/lidarr/validate-import.test.ts`                | CREATE | Cover ready/ambiguous/rejected/unmatched and threshold behavior                       |
| `packages/rfmedia-cli/src/commands/lidarr-import-validation.ts`                  | CREATE | Register/render the lazy validation leaf command                                      |
| `packages/rfmedia-cli/src/commands/lidarr-import-validation.test.ts`             | CREATE | Prove command contract, stdout cleanliness, CSV, and exit gating                      |
| `packages/rfmedia-cli/src/types/lidarr-plan.ts`                                  | UPDATE | Add exact trackfile-filter operation/selection/entry/result/history unions            |
| `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`            | CREATE | Own canonicalization, strict validation, checksum evidence, and live-state comparison |
| `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.test.ts`       | CREATE | Cover tamper rejection, batch counting, ordering, and stale classification            |
| `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.ts`                   | CREATE | Resolve one album and calculate fail-closed keep/delete decisions                     |
| `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.test.ts`              | CREATE | Cover explicit union, unknown/cross-album IDs, ratings, warnings, and empty keep set  |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`                             | UPDATE | Parse, validate, render, and checksum the new v2 operation family                     |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`                        | UPDATE | Add focused round-trip and structural rejection cases                                 |
| `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.ts`        | CREATE | Execute non-deferable exact bulk delete and fresh verification                        |
| `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`               | UPDATE | Route the new kind before structural album guards                                     |
| `packages/rfmedia-cli/src/actions/lidarr/apply-target-types.ts`                  | UPDATE | Extend typed apply execution result unions                                            |
| `packages/rfmedia-cli/src/actions/lidarr/apply.ts`                               | UPDATE | Integrate plan admission, history, ownership, and cancellation                        |
| `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`                          | UPDATE | Cover authorization-independent execution invariants and failures                     |
| `packages/rfmedia-cli/src/actions/lidarr/index.ts`                               | UPDATE | Export new action types and functions                                                 |
| `packages/rfmedia-cli/src/commands/lidarr-track-filter.ts`                       | CREATE | Register the plan subcommand and sealed-plan preview/write flow                       |
| `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`                 | UPDATE | Render new plan/apply rows and require file-delete authorization                      |
| `packages/rfmedia-cli/src/commands/lidarr.ts`                                    | UPDATE | Register both command factories and reuse shared parsers/options                      |
| `packages/rfmedia-cli/src/commands/lidarr.test.ts`                               | UPDATE | Cover registration, plan writing, apply authorization, and failures                   |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`                         | UPDATE | Add Bash command, option, enum, and file/ID completions                               |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`                          | UPDATE | Add Zsh command, option, enum, and file/ID completions                                |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`                         | UPDATE | Add Fish command, option, enum, and file/ID completions                               |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`               | UPDATE | Enforce exact Bash/Zsh/Fish surface parity                                            |
| `packages/rfmedia-cli/docs/features/lidarr-import-validation-track-filtering.md` | CREATE | Document examples, classifications, safety, and limitations                           |
| `packages/rfmedia-cli/README.md`                                                 | UPDATE | Add command discovery and link the feature guide                                      |
| `ROADMAP.md`                                                                     | UPDATE | Remove completed #216 from active work and mark Layer 1 complete                      |
| `docs/roadmap-archive.md`                                                        | UPDATE | Archive #216 and the completed Layer 1 milestone                                      |

Generated files under `src/lib/lidarr/generated/` are read-only inputs and MUST NOT be edited.

## NOT Building

- A replacement for Lidarr's private album/release matching algorithm.
- A command that submits or approves a manual import.
- Direct filesystem deletion, a trash/recycle integration, or recovery guarantees.
- Rating writes, tag normalization, or remote-path translation.
- Library-wide filtering, multi-album selection, or track discovery without one exact album ID.
- A deferred/replay queue entry for trackfile deletion.
- Layer 2 discovery/add/import automation or unrelated Lidarr endpoint wrappers.
- Regenerated OpenAPI output; the required endpoint contracts already exist in the committed SDK.

---

## Step-by-Step Tasks

### Task 1: Add Strict Lidarr Facade Contracts

- **ACTION**: Extend public types, strict projectors, client interface/implementation, mocks, and
  fixtures for manual-import probing, parent-scoped tracks/trackfiles, and exact bulk deletion.
- **IMPLEMENT**: Add input types with positive-ID and exact-key validation; add minimal immutable
  domain projections for paths, artist/album/release/track identities, MusicBrainz/audio-tag
  evidence, rejections, track-to-trackfile links, and trackfile before-state. Wrap
  `getApiV1Manualimport`, `getApiV1Track`, `getApiV1Trackfile`, and
  `deleteApiV1TrackfileBulk` exclusively in `LidarrClient`.
- **MIRROR**: `Generated Client Boundary` and `Facade Execution`.
- **IMPORTS**: Generated functions/types only in `lib/lidarr/client.ts`; public domain types from
  `types/lidarr.ts`; projectors from `lib/lidarr/types.ts`.
- **GOTCHA**: Do not expose generated resource types or `/api/v1/` strings outside the facade. Treat
  optional/malformed nested resources as absent evidence instead of inventing identities. Require a
  non-empty, sorted, unique positive trackfile ID list before mutation.
- **VALIDATE**:
  `npm run test:run --workspace packages/rfmedia-cli -- src/lib/lidarr/client.test.ts
src/lib/lidarr/types.test.ts`.

### Task 2: Implement Read-Only Import Validation

- **ACTION**: Add the validation report model and action over one manual-import probe.
- **IMPLEMENT**: Accept a non-empty folder, optional positive artist ID, `filterExistingFiles`, and
  `replaceExistingFiles`; perform one probe; sort by normalized file path; preserve selected
  artist/album/release/tracks, parsed MusicBrainz IDs, and rejection messages. Classify:
  `rejected` when any Lidarr rejection exists, `unmatched` when no unique full mapping exists,
  `ambiguous` when multiple/conflicting candidate identities exist, otherwise `ready`. Aggregate
  counts and evaluate optional `--fail-on ready|ambiguous|rejected|unmatched` severity threshold
  after building the report.
- **MIRROR**: `Action Scheduling` and the audit report/threshold pattern.
- **IMPORTS**: `resolveRequiredLidarrClient`, scheduler types, new validation types, logger helpers.
- **GOTCHA**: Never call a manual-import POST. Do not promote partial artist/album/release evidence to
  `ready`. Preserve diagnostics even when the threshold will fail the command.
- **VALIDATE**:
  `npm run test:run --workspace packages/rfmedia-cli -- src/actions/lidarr/validate-import.test.ts`.

### Task 3: Expose the Validation Command and Reports

- **ACTION**: Add an injected lazy leaf command and register it under `rfmedia lidarr`.
- **IMPLEMENT**: Command syntax:
  `lidarr validate-import <folder> [--artist-id N] [--filter-existing-files]
[--replace-existing-files] [--fail-on STATUS]`. Render concise human summary/findings to stderr;
  JSON as `{command:"lidarr-validate-import",result}`; CSV as stable summary and finding rows. Run the
  failure threshold only after output and set `process.exitCode` through the shared failure
  contract.
- **MIRROR**: `Machine Output and Exit Gate` and `commands/lidarr-audit.ts` dependency injection.
- **IMPORTS**: Commander, shared `formatOutput`/machine-format helpers, new report types; dynamic
  import the action inside `.action()`.
- **GOTCHA**: Commander argument parsers must not bypass the shared failure renderer. Sensitive
  connection values never appear in output; machine stdout must contain no tables or diagnostics.
- **VALIDATE**:
  `npm run test:run --workspace packages/rfmedia-cli --
src/commands/lidarr-import-validation.test.ts`.

### Task 4: Build Fail-Closed Track Retention Decisions

- **ACTION**: Add the album-scoped track-filter planning action and deterministic decision model.
- **IMPLEMENT**: Require one positive `albumId` and at least one of explicit `keepTrackIds` or
  `minStars` (`0.5..5.0`, half-star increments). Fetch the exact album, its tracks, and its
  trackfiles once. Reject duplicate/unknown/cross-album explicit IDs. Map each track to exactly one
  trackfile from the parent album. Explicit IDs are always kept; rating mode calls `readRating(path)`
  at most once per mapped file and keeps values `>= minStars / 5`. Missing files, absent/unreadable
  ratings, unmapped/duplicate mappings, and cross-album records are retained with stable warning
  codes. Delete candidates are only certain mapped files below the threshold or certain mapped
  files not in an explicit-only keep set. Reject an empty resulting keep set.
- **MIRROR**: Album selection actions and existing normalized `readRating()` behavior.
- **IMPORTS**: `readRating`, Lidarr domain types/client resolver, scheduler, logger, plan builder.
- **GOTCHA**: Explicit-only mode intentionally removes every certain non-kept track; combined mode
  uses a union. Never use a missing/unreadable rating as zero. Do not scan the folder independently
  or follow trackfiles outside the exact album.
- **VALIDATE**:
  `npm run test:run --workspace packages/rfmedia-cli --
src/actions/lidarr/plan-track-filter.test.ts`.

### Task 5: Extend the Sealed v2 Plan Contract

- **ACTION**: Add a separate trackfile-filter v2 operation lane and integrate it with the shared plan
  parser/checksum engine.
- **IMPLEMENT**: Add operation kind `track-file-filter`, one exact album selection, and one entry
  containing album/artist identity, sorted criteria, retained warning summary, and sorted exact
  deletion candidates. Each candidate seals `trackId`, `trackFileId`, `path`, `size`, and relevant
  mapping/rating evidence. The builder rejects empty criteria, empty candidates, empty keep set,
  malformed or duplicate identities, and candidate count over `maxBatch`; default `maxBatch` is 100
  for this operation even though existing operations retain their defaults. Add exact-key structural
  validators, canonical checksum material, stable summaries/risk, and plan read/write round trips.
- **MIRROR**: `Sealed Plan Builder` and the separate album-family operation module.
- **IMPORTS**: Shared checksum/envelope/origin/validation helpers from `plan-engine.ts` and plan types
  from `types/lidarr-plan.ts`.
- **GOTCHA**: `maxBatch` counts planned trackfile deletions, not the single album plan entry. Preserve
  `rfmedia.lidarr-plan.v2`; reject unknown keys and never silently migrate/tolerate malformed plans.
  Route by operation kind before broad structural `"albumId" in entry` guards.
- **VALIDATE**:
  `npm run test:run --workspace packages/rfmedia-cli --
src/lib/lidarr/plan-track-filter-operations.test.ts src/lib/lidarr/plan-engine.test.ts`.

### Task 6: Apply and Verify Exact Trackfile Deletion

- **ACTION**: Add a non-deferable apply executor and integrate result/history/presenter unions.
- **IMPLEMENT**: On admission, assert plan ownership/origin/integrity as existing apply does, then
  fresh-read all targeted trackfiles and compare album ID, path, and size to sealed evidence. Missing
  or drifted targets are stale unless durable history already proves this entry completed. Dispatch
  one bounded `bulkDeleteTrackFiles(exactIds)` call, then use bounded reconciliation reads to require
  every target absent. Persist verified/failed/uncertain/cancelled history using existing stop-
  admission rules. Classify retryable transport failures for reporting only; never enqueue or
  automatically replay this destructive operation.
- **MIRROR**: Album apply admission/reconciliation and `Apply History Failure`.
- **IMPORTS**: Plan/history types, scheduler/client, cancellation helpers, plan-history persistence,
  shared reconciliation constants.
- **GOTCHA**: Abort before dispatch is cancelled; abort or transport uncertainty after dispatch must
  reconcile and may become uncertain. A partial remaining set fails verification. Never convert a
  retryable failure into a deferred intent.
- **VALIDATE**:
  `npm run test:run --workspace packages/rfmedia-cli -- src/actions/lidarr/apply.test.ts
src/lib/lidarr/plan-track-filter-operations.test.ts`.

### Task 7: Add the Track-Filter Plan Command and Apply Authorization

- **ACTION**: Register `lidarr plan track-filter`, render its review, and authorize apply using the
  existing file-deletion gate.
- **IMPLEMENT**: Syntax:
  `lidarr plan track-filter --album-id N [--keep-track-ids IDS] [--min-stars N]
[--max-batch N] [--out FILE]`. Default to preview; only write a plan when `--out` is supplied,
  using the existing exclusive write and overwrite policy. Present criteria, keep/delete/warning
  counts, exact candidate rows, risk, and the follow-up apply command. Extend
  `requiresFileDeleteAuthorization()` so `lidarr apply` requires `--allow-file-delete`; preserve
  dry-run and interactive confirmation behavior.
- **MIRROR**: `commands/lidarr-album-mutations.ts` and `lidarr-mutation-presenter.ts`.
- **IMPORTS**: Commander, injected parent helpers, new plan action/types, existing presenter helpers.
- **GOTCHA**: Do not require `--allow-album-delete`; this deletes trackfiles, not the album record.
  Show explicitly that Lidarr offers no trash/recovery guarantee. Never mutate from the plan command.
- **VALIDATE**:
  `npm run test:run --workspace packages/rfmedia-cli -- src/commands/lidarr.test.ts
src/commands/lidarr-import-validation.test.ts`.

### Task 8: Maintain Bash, Zsh, and Fish Completion Parity

- **ACTION**: Add every new command, positional, option, enum, and value context to all completion
  templates.
- **IMPLEMENT**: Add `validate-import` to Lidarr subcommands and `track-filter` to plan operations;
  include folder completion, numeric IDs, comma-separated keep IDs, `--min-stars`, `--max-batch`,
  output path, boolean probe controls, and validation status values. Extend the shared parity test
  table/assertions rather than creating redundant shell-specific test suites.
- **MIRROR**: Existing `audit`, `album-delete`, and plan/apply completion dispatch blocks.
- **IMPORTS**: None beyond existing completion template/test helpers.
- **GOTCHA**: Fish predicates and Bash/Zsh command-depth dispatch must distinguish
  `lidarr validate-import` from `lidarr plan track-filter`. Keep descriptions/options identical in
  meaning even where shell syntax differs.
- **VALIDATE**:
  `npm run test:run --workspace packages/rfmedia-cli --
src/lib/shell-completions/templates.spec.ts`.

### Task 9: Document and Close the Layer 1 Roadmap Item

- **ACTION**: Add user documentation, README discovery, and authoritative roadmap/archive updates.
- **IMPLEMENT**: Document pre-import classifications, text/JSON/CSV examples, `--fail-on`, explicit
  vs rating union semantics, fail-closed warning cases, sealed preview/write/apply commands,
  `--max-batch`, `--allow-file-delete`, stale-plan behavior, and the absence of trash/recovery.
  Remove #216 from active sprints/diagrams, archive it with the implementing PR placeholder until the
  actual PR number is known, and state that Lidarr Layer 1 is complete.
- **MIRROR**: `lidarr-audit.md`, `lidarr-plan-apply.md`, and existing roadmap archive rows.
- **IMPORTS**: N/A.
- **GOTCHA**: Do not claim the issue/PR is merged before merge. Replace the placeholder with the real
  PR number before final merge and keep Markdown headings surrounded by blank lines.
- **VALIDATE**: `npm run lint:md && git diff --check`.

### Task 10: Run Contract-Focused Integration Validation

- **ACTION**: Run only the focused feature tests plus the repository suites that enforce changed
  architecture, codegen, CLI, build, and documentation contracts.
- **IMPLEMENT**: Build `@rfmedia/common` first if the fresh worktree cannot resolve it; run focused
  tests while iterating, then the complete rfmedia suite, architecture/codegen contracts,
  TypeScript, build, Markdown lint, diff check, and Graphify update required by repository rules.
- **MIRROR**: Root and workspace scripts in `package.json`.
- **IMPORTS**: N/A.
- **GOTCHA**: Do not diagnose missing workspace dependencies as regressions. Do not add broad
  duplicate tests to reduce uncertainty; add cases only for the listed contract boundaries. A
  Graphify update may modify expected graph artifacts and must be reviewed as generated output.
- **VALIDATE**: Every command in `Validation Commands` below passes.

---

## Testing Strategy

### Unit and Contract Tests

| Test                              | Input                                                    | Expected Output                                 | Edge Case? |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------- | ---------- |
| Manual-import ready               | One full unique Lidarr match                             | `ready` with all identities/evidence            | No         |
| Manual-import rejected            | Rejection plus otherwise complete match                  | `rejected`; evidence preserved                  | Yes        |
| Manual-import partial/conflicting | Missing release/track or conflicting matches             | `unmatched` or `ambiguous`, never ready         | Yes        |
| Validation threshold              | Mixed findings plus each `--fail-on` value               | Report renders, then exit gate follows severity | Yes        |
| Explicit retention                | Album tracks plus explicit keep IDs                      | Exact certain non-kept candidates               | No         |
| Combined retention                | Explicit ID below threshold and rated ID above threshold | Both kept by union                              | Yes        |
| Rating uncertainty                | Missing/unrated/unreadable/cross-album/unmapped file     | Retained with stable warning                    | Yes        |
| Invalid selection                 | Empty, duplicate, unknown, or cross-album IDs            | Validation error before plan write              | Yes        |
| Empty keep set                    | Criteria would keep nothing                              | Validation error; no plan                       | Yes        |
| Batch boundary                    | 100 and 101 deletion candidates by default               | 100 seals; 101 rejects                          | Yes        |
| Sealed round trip                 | Canonical trackfile-filter plan                          | Same checksum and strict parsed shape           | No         |
| Tampered plan                     | Changed candidate path/size/ID/checksum/unknown key      | Integrity or structural rejection               | Yes        |
| Stale admission                   | Fresh path/size/album differs                            | No dispatch; stale result                       | Yes        |
| Verified apply                    | Exact bulk delete then targeted reads empty              | Verified durable history                        | No         |
| Partial apply                     | One target remains after reconciliation                  | Failed/inconclusive; no false success           | Yes        |
| Retryable failure                 | Bulk endpoint fails transiently                          | Reported, never deferred                        | Yes        |
| Cancellation                      | Abort before and after dispatch                          | Cancelled before; reconcile/uncertain after     | Yes        |
| Apply authorization               | Track-filter plan without/with `--allow-file-delete`     | Reject / proceed                                | Yes        |
| Completion parity                 | New surface in Bash/Zsh/Fish                             | Equivalent discovery and value completion       | No         |

### Edge Cases Checklist

- [ ] Empty folder/path input
- [ ] Empty manual-import response
- [ ] Partial/malformed optional Lidarr resources
- [ ] Maximum configured trackfile batch
- [ ] Duplicate and cross-album IDs
- [ ] Album track without a file and trackfile without an unambiguous track
- [ ] Missing/unreadable/unrated local file
- [ ] Combined explicit and rating criteria
- [ ] Remote/path state drift between plan and apply
- [ ] Network failure before and after destructive dispatch
- [ ] Cancellation before and after dispatch
- [ ] Durable-history write failure after remote success
- [ ] JSON/CSV stdout cleanliness

---

## Validation Commands

### Focused Tests

```bash
npm run test:run --workspace packages/rfmedia-cli -- \
  src/lib/lidarr/client.test.ts \
  src/actions/lidarr/validate-import.test.ts \
  src/commands/lidarr-import-validation.test.ts \
  src/actions/lidarr/plan-track-filter.test.ts \
  src/lib/lidarr/plan-track-filter-operations.test.ts \
  src/lib/lidarr/plan-engine.test.ts \
  src/actions/lidarr/apply.test.ts \
  src/commands/lidarr.test.ts \
  src/lib/shell-completions/templates.spec.ts
```

EXPECT: All focused matching, retention, plan/apply, command, and completion tests pass.

### Static and Architecture Analysis

```bash
npm run build:common
npm run typecheck --workspace packages/rfmedia-cli
npm run test:architecture --workspace packages/rfmedia-cli
npm run codegen:lidarr:check --workspace packages/rfmedia-cli
npm run test:codegen:lidarr --workspace packages/rfmedia-cli
```

EXPECT: Zero type errors; generated-client privacy and committed OpenAPI/codegen contracts pass.

### Full rfmedia Regression Suite

```bash
npm run test:rfmedia
npm run build:rfmedia
```

EXPECT: No rfmedia regressions and the production CLI build succeeds.

### Documentation and Repository Validation

```bash
npm run lint:md
git diff --check
graphify update .
git status --short
```

EXPECT: Markdown and whitespace checks pass; Graphify reflects the implementation; only intended
source, test, documentation, plan/spec, and graph updates remain.

### Manual Validation

- [ ] Run validation fixtures through text, JSON, and CSV presenters and confirm deterministic order.
- [ ] Preview a track-filter plan and confirm no mutating client call occurs.
- [ ] Read the sealed JSON and confirm exact album, track, trackfile, path, size, criteria, batch, and
      checksum evidence.
- [ ] Confirm apply refuses the plan without `--allow-file-delete`.
- [ ] Confirm the documented apply path uses Lidarr only and makes no trash/recovery claim.
- [ ] Generate Bash, Zsh, and Fish completions and inspect both new command depths.

---

## Acceptance Criteria

- [ ] A local folder can be probed once through Lidarr's read-only manual-import GET and reported as
      deterministic ready/ambiguous/rejected/unmatched findings.
- [ ] Optional artist and existing/replacement probe controls are validated and forwarded without
      submitting an import.
- [ ] Text, JSON, and CSV output are stable, and `--fail-on` remains opt-in and post-render.
- [ ] One exact album can be filtered by explicit track IDs, local minimum stars, or their union.
- [ ] Explicit IDs always win; missing/unrated/unreadable/unmapped/cross-album files are retained
      with warnings.
- [ ] Empty/duplicate/unknown/cross-album selection and empty resulting keep sets fail before write.
- [ ] A canonical v2 plan seals exact deletion candidates and counts `maxBatch` by trackfile,
      defaulting to 100 for this operation.
- [ ] Apply requires `--allow-file-delete`, rejects origin/integrity/staleness drift, never defers,
      uses only Lidarr bulk deletion, and verifies every exact target absent.
- [ ] Generated SDK imports remain private to the handwritten facade.
- [ ] Bash, Zsh, and Fish expose equivalent new commands/options/values and parity tests pass.
- [ ] Focused tests, rfmedia tests/build, architecture/codegen checks, Markdown lint, and diff checks
      pass.
- [ ] Feature documentation, README, ROADMAP, and roadmap archive accurately reflect delivery and
      limitations.

## Completion Checklist

- [ ] Code follows the facade, scheduler, plan-builder, and apply-history patterns.
- [ ] Error handling uses the existing Lidarr and CLI failure taxonomies.
- [ ] Logging and human/machine output follow codebase conventions.
- [ ] Tests protect only the critical matching, retention, mutation, command, and completion
      contracts.
- [ ] No hardcoded endpoint paths, credentials, local roots, or generated-type leaks.
- [ ] No mutation occurs in validation or planning.
- [ ] No direct filesystem deletion or recovery claim exists.
- [ ] Documentation and roadmap/archive are updated with the actual PR number before merge.
- [ ] Graphify is updated after code changes.
- [ ] No unnecessary scope additions.
- [ ] Self-contained — no questions are needed during implementation.

## Risks

| Risk                                                  | Likelihood | Impact | Mitigation                                                                           |
| ----------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------ |
| Partial manual-import payloads vary by Lidarr version | Medium     | High   | Bounded projection and fail-closed classification                                    |
| Lidarr trackfile paths are unavailable locally        | High       | Medium | Explicit mode still works; rating mode retains and warns                             |
| One track maps to zero or multiple trackfiles         | Medium     | High   | Retain uncertain records and exclude them from candidates                            |
| Bulk delete physically removes files                  | High       | High   | Preview default, exact sealed scope, max batch, explicit authorization, verification |
| State changes after plan creation                     | Medium     | High   | Fresh exact before-state comparison and stale rejection                              |
| Dispatch succeeds but verification/history fails      | Low        | High   | Reconcile, report uncertain, stop new admissions, require resume                     |
| Plan-engine unions become structurally ambiguous      | Medium     | High   | Kind-first routing and a separate typed operation module                             |
| Completion drift across three shells                  | Medium     | Medium | One parity-focused contract test                                                     |

## Notes

- Revised defaults approved on 2026-07-25: manual-import GET probe; explicit track IDs plus optional
  local rating union; uncertain files retained; Lidarr-only exact bulk deletion.
- No child issue is required. Although the change is XL, validation and filtering share the same
  generated-client boundary, output contract, plan schema, apply safety invariants, documentation,
  and release evidence; splitting them would create an unsafe partial workflow.
- The required single `prp-researcher` did not return a report, and one permitted retry also stalled.
  This plan records that research gap and uses verified repository source, generated contracts,
  Graphify queries from the primary checkout, and the approved spec instead.
- The worktree intentionally has no independent dependency install yet. Build `rf-common` or use the
  existing workspace dependency state before diagnosing module-resolution failures.
