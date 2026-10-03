# Architecture Research: Lidarr Cascade Analysis

## System Overview

Lidarr mutation planning is a read-only producer pipeline: actions collect fresh Lidarr state,
operation-specific builders normalize it into immutable entries and summaries, and
`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` validates, canonicalizes, checksums, and
atomically stores the artifact. Apply reads that artifact through the same engine, performs
fresh-state/resource/history checks, and dispatches by `plan.operation.kind`. Command modules own
human and machine presentation; actions and builders do not render.

Issue #219 should add a pure `O(entries)` analysis step between canonical fact construction and
checksum sealing. New writers emit `rfmedia.lidarr-plan.v3` with required `cascadeAnalysis`;
readers continue accepting unchanged v1/v2 artifacts and report their analysis as `not-recorded`.
The estimator consumes only canonical operation, entry, review, and summary facts plus a bounded
resolved config snapshot. It must not call Lidarr, Prowlarr, an indexer, or a download client.

The current family split is important:

- `buildLidarrMutationPlanV2()` in
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` owns artist monitoring, profile assignment,
  tag mutation, and artist delete. It sorts/deduplicates by `artistId` and delegates behavior to
  `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`.
- `buildLidarrArtistAddPlanV2()` in the same engine owns expected-absent MusicBrainz targets,
  including legacy and extended monitored shapes, non-empty bounded entries, and foreign-ID
  selection.
- `buildLidarrAlbumMutationPlanV2()` in
  `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts` owns album edit and album delete,
  sorting/deduplicating by `albumId`.
- `buildLidarrTrackFilterPlanV2()` in
  `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts` owns one album and its exact
  track-file deletion candidates.
- `buildLidarrMutationPlan()` in
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` still produces v1 album-monitoring plans
  from `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`; this producer must also move to v3
  even though it is not a v2 builder. The v1 builder remains intact for compatibility tests.

## Relevant Components

- `packages/rfmedia-cli/src/types/lidarr-plan.ts` defines the current correlated plan families.
  Add the v3 discriminator, cascade contracts, and a distributive `LidarrPlanV3From<T>` so
  operation, selection, entries, and summary stay correlated for ordinary artist, artist-add,
  album mutation, album monitoring, and track-filter plans.
- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts` should own bounded policy resolution,
  checked arithmetic, the exhaustive operation switch, metrics, budget assessments, stable
  warnings/recommendations, and semantic recomputation. It is the only new domain module needed.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` is the shared v3 artifact boundary. Its
  `canonicalizeSelection`, `canonicalizeOperationV2`, `canonicalizeEntryV2`, and
  `canonicalizeSummary` already normalize every v2 shape, while `canonicalizePlanV2`,
  `computeLidarrPlanChecksum`, `assertLidarrMutationPlan`, `writeLidarrPlanArtifact`, and
  `readLidarrPlanArtifact` form the version dispatch. Add a separate v3 canonicalizer/validator;
  do not change the v1/v2 byte representation.
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts` retain operation-specific
  entry/summary validation. Their builders should call the shared v3 sealing path after producing
  canonical facts rather than duplicate analysis logic.
- Producers are `packages/rfmedia-cli/src/actions/lidarr/plan.ts`,
  `plan-albums.ts`, `plan-artist-profiles.ts`, `plan-artist-tags.ts`,
  `plan-artist-delete.ts`, `plan-artist-add.ts`, `plan-album-edit.ts`,
  `plan-album-delete.ts`, and `plan-track-filter.ts`. Together they cover artist monitoring,
  album monitoring, profile assignment, tag mutation, artist delete, artist add, album edit,
  album delete, and track-file filter.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` is the admission/orchestration boundary.
  `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`,
  `apply-album-mutation-execution.ts`, `apply-track-filter-execution.ts`, and
  `apply-entry-execution.ts` are mutation lanes. Cascade findings must not change their dispatch,
  confirmation, drift, claim, history, retry, resume, or destructive-authorization behavior.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` is the shared plan/apply human
  and CSV surface; `packages/rfmedia-cli/src/commands/lidarr.ts` routes JSON/YAML through the
  generic formatter. The presenter should render the same sealed structure for preview and apply,
  and synthesize only `NOT RECORDED (legacy plan)` for v1/v2.
- `packages/rfmedia-cli/src/types/config.ts` and
  `packages/rfmedia-cli/src/lib/config.ts` own `lidarr` config typing and validation.
  `rfmedia.example.yaml` is the public example boundary.

## Data Flow

1. Config loading validates `lidarr.cascadeAnalysis` as an exact nested object. Budgets and
   assumptions are optional positive safe integers capped at `1_000_000`; omitted values become
   explicit `null` in the resolved plan-time policy.
2. A producer performs its existing Lidarr reads and selection. No new read is added.
3. The family builder canonicalizes origin, selection, operation, entries, review, summary, and
   risk using its existing operation definitions and sort/dedupe rules.
4. `analyzeLidarrCascade()` receives those canonical facts and resolved policy. Changed entries
   alone contribute newly caused work. Every current operation yields exact zero immediate
   indexer queries; conditional candidates follow the feature-spec operation matrix.
5. Known candidates multiplied by `indexerQueriesPerCandidate` produce modelled conditional
   queries through checked safe-integer arithmetic. Missing evidence/assumptions stays `unknown`;
   missing allowance stays `not-configured`.
6. Deterministic budget assessments derive warnings and bounded, deduplicated recommendations.
   The complete analysis is inserted before checksum computation.
7. The v3 canonicalizer serializes fixed key order including `cascadeAnalysis`; SHA-256 seals it.
   The v3 validator recomputes analysis from sealed facts, assumptions, and limits and rejects
   semantic mismatches even if a checksum was recomputed.
8. Preview and artifact output expose the same plan object. Apply reads and validates the artifact,
   then presentation reads `cascadeAnalysis` without consulting current config or recomputing
   capacity. Mutation proceeds through the unchanged operation-kind lane.

## Integration Points

The primary integration seam is a shared v3 sealing helper in
`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: accept already canonical family facts,
compute analysis once, canonicalize v3, seal, validate, and freeze. Keeping the estimator below
actions prevents preview/artifact divergence and keeping policy resolution above the pure
estimator makes it independently testable.

`LidarrStoredMutationPlan` must widen to v1, all existing v2 families, and all correlated v3
families. Version dispatch selects legacy versus v3 canonicalization; operation-kind dispatch
continues selecting family behavior. Helpers in apply and presenter currently repeat narrower
local unions, so those aliases must consume the widened shared union to avoid omitting artist-add,
album, or track-filter v3 variants.

Apply results need a presentation-level analysis status or access to the reviewed plan's sealed
analysis. `readLidarrPlanArtifact()` is already called before confirmation in
`packages/rfmedia-cli/src/commands/lidarr.ts`, while `executeLidarrApply()` reads again for
authoritative admission. Pass or return the validated sealed analysis; never resolve
`lidarr.cascadeAnalysis` during apply.

Human output should place plan-time analysis before entry rows, with explicit horizon, certainty,
unit, budget status, stable warning code, and recommendation code. JSON/YAML can preserve the
structured plan field. CSV needs a bounded projection in
`projectMutationPlanCsv()`/`projectMutationApplyCsv()` rather than free-form prose. Human output
remains on stderr and machine documents remain clean stdout.

The config validator should add exact key allowlists for `cascadeAnalysis`, `budgets`, and
`assumptions`; existing `lidarr` parsing currently accepts known fields individually, so the new
subtree must itself reject unknown keys. Policy is resolved once for every producer, including
dry-run/preview-only paths, before builder invocation.

## Key Dependencies

- Existing TypeScript discriminated unions and exhaustive switches; no runtime dependency is
  required.
- Node `crypto` and the established canonical JSON/checksum machinery in
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`.
- Existing strict primitives in
  `packages/rfmedia-cli/src/lib/lidarr/plan-validation.ts` and config error helpers in
  `packages/rfmedia-cli/src/lib/config.ts`.
- Existing operation-owned `hasChange` and summary evidence in
  `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`,
  `plan-album-operations.ts`, and `plan-track-filter-operations.ts`.
- Existing scheduler/client reads remain producer dependencies only; the analyzer stays
  credential-free and synchronous.

Implementation can parallelize after contracts stabilize: the pure estimator/config validation,
the four builder-family migrations, and presenter work touch separable modules. Producer changes
can split into ordinary artist, artist-add, album monitoring/mutations, and track-filter groups.
Apply-union/presentation plumbing can proceed alongside producer conversion once v3 types and
engine APIs are fixed. Legacy fixture tests and operation-matrix tests can be authored in parallel,
but final integration must land the shared types/engine first and migrate all producers together
so no new plan writer remains on v1/v2.
