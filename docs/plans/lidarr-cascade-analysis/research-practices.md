# Engineering Practices Analysis: Lidarr Cascade Budgets

## Executive Summary

Issue #219 should be implemented as a small, deterministic analysis layer over the
already reviewed plan state. The estimator should not call Lidarr, Prowlarr, an
indexer, or a download client, and it should not change apply behavior. Its output
is advisory evidence sealed into newly generated plans so users can see likely
downstream pressure before apply.

The smallest coherent design is:

1. Add a pure `analyzeLidarrCascade()` function in
   `src/lib/lidarr/cascade-analysis.ts`.
2. Add a strict, operation-neutral `cascadeAnalysis` contract to v2 plan
   artifacts in `src/types/lidarr-plan.ts`.
3. Invoke the analyzer from each distinct v2 plan builder before checksum
   sealing.
4. Add optional budgets under `lidarr.cascadeBudgets` and validate them in
   `src/lib/config.ts`.
5. Present the sealed estimates, exceeded budgets, and recommendations through
   `renderMutationPlan()` in
   `src/commands/lidarr-mutation-presenter.ts`.

Do not create a second planning engine, a live cross-stack client, a plugin
system, or an apply-time enforcement policy.

## Existing Reusable Code

### Strict plan envelope and checksum

`buildLidarrMutationPlanV2()` in
`src/lib/lidarr/plan-engine.ts` already centralizes sorting, duplicate
rejection, `maxBatch`, entry construction, `summary`, `risk`, checksum sealing,
and final assertion. `buildLidarrArtistAddPlanV2()` is the separate foreign-ID
builder. Album and track-filter families have their own builders but share
`canonicalizePlanV2()` and strict artifact parsing.

The new analysis must be present before `computeLidarrPlanChecksum()` runs.
`canonicalizePlanV2()` must serialize it in a fixed field order, and the strict
validators must use `requireRecord()`, `requireExactKeys()`,
`requireString()`, and bounded integer validation from
`src/lib/lidarr/plan-validation.ts`. This preserves the repository's
fail-closed artifact contract.

Backward compatibility matters because existing v2 artifacts use the same
`rfmedia.lidarr-plan.v2` discriminator. Model `cascadeAnalysis` as optional for
parsing old plans but always emit it from new builders. Canonicalization must
omit the field when absent so old checksums remain stable. Do not bump the
version merely to add advisory evidence.

### Canonical before/after state

The estimator should consume canonical plan entries, not raw action options.
`canonicalizeEntryV2()` already normalizes every supported entry family, and
`canonicalizeSummary()` normalizes aggregate evidence. This gives the analyzer
stable inputs and prevents each planner from inventing its own estimate.

Use only facts the artifact proves:

- Count only entries whose before/after state changes.
- Artist and album transitions to monitored may be reported as potential
  downstream search scope.
- Artist-add explicitly seals `searchForMissingAlbums: false` in
  `canonicalizeEntryV2()` and `buildLidarrArtistAddPlanV2()`; it must therefore
  estimate zero immediate acquisitions. It may report bounded metadata work,
  but must not claim an indexer search is scheduled.
- Profile, tag, delete, album-edit, and track-file-filter operations must not be
  assigned fabricated acquisition effects.
- When the artifact lacks album/backlog cardinality, report the acquisition
  scope as unknown rather than converting one artist into an arbitrary number
  of downloads.

A useful compact contract is an immutable analysis containing:

- projected indexer queries;
- projected acquisitions when known, otherwise an explicit unknown marker;
- the configured query and acquisition budgets used;
- stable exceeded-budget codes;
- stable recommendation codes such as batching, delay, or reduced scope.

Human prose should be derived by the presenter. Do not seal colorized or
localized sentences as the machine contract.

### Operation definitions

`src/lib/lidarr/plan-operation-definitions.ts` is the authority for artist
operation canonicalization, change detection, summaries, risk, resources, and
execution. Album and track-filter definitions follow the same boundary in
their dedicated modules.

For this issue, keep those execution interfaces unchanged. A single exhaustive
switch in `cascade-analysis.ts` over the plan operation discriminant is simpler
than adding an estimator method to every operation definition and executor.
The analyzer should read the canonical entry shapes produced by those
definitions. If later issues add several search-producing operations, the
estimation hook can then move into operation definitions with demonstrated
reuse.

### Configuration

`LidarrConfigOptions` in `src/types/config.ts` currently groups connection,
resilience, scheduler, and preset settings. Add one optional
`cascadeBudgets` object with clearly named non-negative safe-integer limits,
for example `maxIndexerQueries` and `maxAcquisitions`.

`validateLidarrConfigOptions()` in `src/lib/config.ts` must:

- reject non-object budget sections;
- reject unknown keys in that section;
- reject negative, fractional, unsafe, or excessively large values;
- preserve omission as “no configured warning threshold”;
- allow zero so users can require no projected downstream activity.

Keep estimation coefficients as code constants, not configuration. User-tunable
weights would make artifacts incomparable and expand validation without a
proven use case. Seal the resolved budgets in the analysis so later config
changes cannot rewrite what the reviewer approved.

### Planner and presenter integration

`executeLidarrPlan()` in `src/actions/lidarr/plan.ts` already delegates artifact
construction to `buildLidarrMutationPlanV2()`. Other ordinary artist planners
use the same engine, so they should receive analysis without per-action logic.

`executeLidarrArtistAddPlan()` in
`src/actions/lidarr/plan-artist-add.ts` is a separate critical path: it validates
recommendations, reads shared resources and exact installed identity, then
calls `buildLidarrArtistAddPlanV2()`. Pass resolved budgets to the builder, but
do not estimate from recommendation rank, similarity, or provider popularity;
those values do not prove indexer or download impact.

`renderMutationPlan()` already prints review, risk, operation summary, and
artifact identity. Add one compact cascade block after risk:

- projected query/acquisition counts;
- “unknown” where the plan lacks cardinality;
- a conspicuous warning only for exceeded configured budgets;
- terse batching/delay/reduced-scope recommendations.

The artifact remains the machine-output source of truth. Avoid duplicating
aggregate cascade fields on every CSV entry.

## Shell Completion Audit

The recommended interface is configuration-only and introduces no command,
subcommand, flag, or enumerated CLI value. Therefore Bash, Zsh, and Fish
templates in `src/lib/shell-completions/` require no content change.

Run the existing parity coverage in
`src/lib/shell-completions/templates.spec.ts`, especially the tests that lock
Lidarr plan operations, exact leaf options, cross-operation option isolation,
and value completion. If implementation adds CLI budget overrides despite this
recommendation, all three templates and the exact option maps in that test must
be updated together.

## Minimal Critical Test Set

Prefer extending existing suites over creating broad new matrices.

1. **Pure estimator tests** in `cascade-analysis.test.ts`:
   one table covers no-op entries, newly monitored artist/album scope,
   artist-add with search disabled, operations with no acquisition effect,
   unknown acquisition cardinality, exact-budget equality, and one-unit budget
   exceedance. Assert stable codes and deterministic ordering.
2. **Strict artifact tests** in `plan-engine.test.ts`:
   a newly built plan includes checksum-covered canonical analysis; a legacy v2
   fixture without analysis retains its checksum; malformed analysis, unknown
   keys, invalid counts, and inconsistent exceeded codes are rejected. Use one
   parameterized invalid-field table rather than a test per scalar.
3. **Distinct builder-path integration**:
   extend existing plan-engine/album tests to prove the ordinary artist,
   artist-add, album, and track-filter builders all seal analysis. These are
   separate construction paths; testing only `executeLidarrPlan()` is
   insufficient.
4. **Configuration validation** in `src/lib/config.test.ts`:
   one valid zero/positive budget case and one parameterized invalid-shape
   table.
5. **Presentation**:
   one focused command/presenter test proves an exceeded budget is visible and
   recommendations are printed, while machine JSON retains the structured
   analysis.
6. **Completion regression**:
   run `templates.spec.ts`; add no new completion assertions because the CLI
   surface is unchanged.

Do not duplicate the full operation matrix at the action, engine, presenter,
and command layers. The pure estimator owns arithmetic; engine tests own
artifact strictness; one presentation test owns the user-visible warning.

## Modularity Design

### Build Versus Depend

Build this as a local pure TypeScript module. The logic is bounded integer
arithmetic, exhaustive discriminated-union handling, and stable code
generation. A statistics, rules-engine, or monitoring dependency would add
supply-chain and serialization risk without improving the available evidence.

Likewise, do not add Prowlarr or download-client API dependencies. Live queue or
indexer data would make plan generation availability-dependent and would still
not prove future acquisitions. Cross-stack telemetry can be a later,
separately designed feature.

## Maintainability Guardrails

- Keep one analyzer and one result contract; no per-command estimators.
- Keep warnings advisory; budget exceedance must not silently become an apply
  authorization gate.
- Use exhaustive operation switches so new plan kinds fail compilation until
  their cascade semantics are considered.
- Bound all counts, arrays, and recommendation codes in strict parsing.
- Preserve old v2 checksum compatibility by omitting absent analysis.
- Derive display text from stable codes in the presenter.
- Document estimates as conservative projections, not guarantees.

This shape delivers cascade visibility with minimal coupling while preserving
the repository's strongest existing properties: strict immutable artifacts,
centralized plan semantics, checksum-stable replay, and shell-completion parity.
