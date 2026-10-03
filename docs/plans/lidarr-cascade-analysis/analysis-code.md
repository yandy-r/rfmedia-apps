# Code Analysis: Lidarr Cascade Analysis

## Executive Summary

Issue #219 belongs inside the existing Lidarr plan-artifact pipeline, not in the client, scheduler,
or apply execution paths. The implementation should add a pure
`packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts` domain module, introduce strict v3 plan
families alongside immutable v1/v2 contracts, and have every producer resolve a bounded config
snapshot and pass it to a v3 builder before checksum sealing.

The main implementation risk is version and family coverage. The code currently has four separate
sealing paths: the ordinary artist v2 builder, the legacy album-monitoring v1 builder, the
artist-add v2 builder, the album-edit/delete v2 builder, and the track-filter v2 builder. Shared
read/write/apply/presentation unions then widen these families manually. V3 work must update all
of those seams without relaxing a legacy exact-key validator or changing legacy canonical bytes.

A second hard issue is specific to track filtering: the current v2 track-filter entry does not
seal whether its album is monitored. The v3 rule cannot deterministically distinguish an exact
reacquisition candidate of one from zero, or recompute that result during validation, unless v3
seals this minimal fact (or the metric is made unknown). Do not derive the result from live state
that is absent from the artifact.

## Existing Code Structure

### Persisted contracts

- `packages/rfmedia-cli/src/types/lidarr-plan.ts` owns every persisted plan and apply result type.
  It defines exact v1/v2 version constants, readonly operation/entry/selection/summary families,
  and the public generation/apply result shapes.
- V2 is not one uniform type. Ordinary artist plans use `LidarrMutationPlanV2`; artist-add uses
  `LidarrArtistAddPlanV2`; album edit/delete use `LidarrAlbumMutationPlanV2`; and track filtering
  uses `LidarrTrackFileFilterPlanV2`.
- Later families deliberately use parallel `Extended` unions rather than widening the original
  artist unions. This preserves compile-time exhaustiveness and legacy parsing behavior.
- Entries generally have no per-entry operation discriminator. Shared consumers dispatch by
  `plan.operation.kind` first, then use sanctioned structural guards such as `"albumId" in entry`.

### Artifact engine

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` is the shared artifact boundary.
  `LidarrStoredMutationPlan` is the authoritative union accepted by checksum, storage, history, and
  apply.
- Builders normalize origin, operation, selection, and entries; sort and deduplicate identifiers;
  compute operation-owned `review`, `summary`, `risk`, and idempotency values; seal the checksum;
  validate the completed value; and freeze the returned plan.
- `canonicalizePlan()` and `canonicalizePlanV2()` construct checksum material field by field in a
  fixed order. `computeLidarrPlanChecksum()` dispatches by version.
- `assertLidarrMutationPlan()` dispatches strict parsing by the exact version discriminator.
  `validateLidarrMutationPlanV2()` enforces the top-level allowlist, operation/selection
  correlation, sorted unique entries, review counts, summary, risk, and idempotency keys.
- `writeLidarrPlanArtifact()` validates and verifies the checksum before a private, atomic,
  no-overwrite write. `readLidarrPlanArtifact()` bounds input, parses, validates, and then verifies
  the checksum.

### Operation behavior

- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts` owns ordinary artist
  operation behavior. Definitions expose `canonicalize`, `risk`, `buildEntry`, `hasChange`,
  `summarize`, idempotency, drift classification, verification, and execution.
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts` provides the parallel registry and
  builder for album edit/delete plans.
- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts` owns track-filter
  canonicalization, risk, summary, idempotency, and its single-entry builder.
- `packages/rfmedia-cli/src/lib/lidarr/plan-validation.ts` provides the fail-closed primitives used
  for untrusted plan data: exact keys, record/string/integer validation, sensitive-key scanning,
  cycle checks, and `LidarrPlanValidationError`.

### Producers

The current writers are:

- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`: artist monitoring via
  `buildLidarrMutationPlanV2()`.
- `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`: album monitoring via the legacy
  `buildLidarrMutationPlan()` v1 builder.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`: profile assignment via the
  ordinary artist v2 builder.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`: tag mutation via the ordinary
  artist v2 builder.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`: artist deletion via the ordinary
  artist v2 builder.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: expected-absent foreign-ID adds via
  `buildLidarrArtistAddPlanV2()`.
- `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.ts` and
  `plan-album-delete.ts`: album-family plans via `buildLidarrAlbumMutationPlanV2()`.
- `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.ts`: one-album file deletion via
  `buildLidarrTrackFilterPlanV2()`.

Each producer owns live reads and selection. The builder owns canonical plan facts. Preview-capable
actions build the plan before branching between an in-memory preview and
`writeLidarrPlanArtifact()`, so attaching analysis in the builder automatically keeps preview and
artifact output identical.

### Apply and presentation

- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` reads the artifact before target-origin,
  authorization, history, claim, drift, scheduling, mutation, reconciliation, and optional Plex
  scan work. Its local plan unions and kind guards explicitly enumerate current families.
- `LidarrPlanApplyResult` currently returns plan identity, risk, summary, entry outcomes, and
  optional execution/scan metadata. It does not carry the source plan or any analysis evidence.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` is the shared human and CSV
  projection boundary. Human plan/apply review uses `console.error`; JSON/YAML and CSV are emitted
  by the shared formatter in `packages/rfmedia-cli/src/commands/lidarr.ts`.
- JSON/YAML plan output already contains the complete plan through
  `{ command: "lidarr-plan", result }`. CSV uses one aggregate row from
  `projectMutationPlanCsv()`. Apply needs an explicit plan-time analysis projection added to its
  result because the complete plan is not returned.

## Implementation Patterns with Examples

### Preserve legacy versions by addition

Follow the existing parallel-family approach:

```ts
export const LIDARR_PLAN_VERSION_V3 = "rfmedia.lidarr-plan.v3";

type LidarrPlanV3From<TPlan extends { readonly version: string }> = TPlan extends unknown
  ? Omit<TPlan, "version" | "payloadChecksum"> & {
      readonly version: typeof LIDARR_PLAN_VERSION_V3;
      readonly cascadeAnalysis: LidarrCascadeAnalysis;
      readonly payloadChecksum: string;
    }
  : never;
```

Use a distributive mapping so operation, entry, selection, and summary remain correlated. Include
the current album-monitoring shape even though its producer still uses a v1 builder; do not assume
all new writers originate from a v2 base.

Do not add an optional analysis field to v1/v2, change their top-level allowlists, or route them
through a modified canonicalizer. Add `canonicalizePlanV3()`, v3 checksum dispatch, and
`assertLidarrMutationPlanV3()` alongside the legacy functions.

### Build canonical facts before analysis

The ordinary builders already establish the correct ordering:

```text
normalize operation and selection
  -> build sorted entries
  -> derive changed count, summary, and risk
  -> construct plan without checksum
  -> checksum
  -> strict validation
  -> freeze
```

V3 should insert `analyzeLidarrCascade(canonicalFacts, resolvedPolicy)` between canonical fact
construction and checksum computation. The analyzer should consume plan types or a narrow
credential-free fact union, not a client, URL, API key, scheduler context, or loaded-config global.
Avoid a cycle where `cascade-analysis.ts` imports `LidarrStoredMutationPlan` from `plan-engine.ts`
while `plan-engine.ts` imports the analyzer; depend on plan contract types instead.

### Reuse operation-owned change semantics

The estimator must analyze changed scope, not merely `entries.length`:

- Monitoring: compare `before.monitored` with `after.monitored`.
- Profile and tag plans: use the same semantics as their definition's `hasChange()`.
- Artist add: every expected-absent entry is changed.
- Artist and album delete: every selected deletion entry is changed.
- Album edit: compare `before.anyReleaseOk` with `after.anyReleaseOk`.
- Track filter: the reviewed delete candidates are the changed work.

`review.changed` is already semantically validated for v2, but directional cascade calculations
still require entry facts. Derive from entries and validate against the plan rather than trusting a
free-standing aggregate.

### Canonicalize explicitly

Mirror `canonicalizePlanV2()`: emit all v3 fields and every nested analysis object in a fixed order,
copy arrays, and place `cascadeAnalysis` immediately before `payloadChecksum`. Do not spread an
untrusted analysis record into checksum material.

Warning and recommendation codes should be declared as bounded literal unions. Generate them in a
fixed production-code order and deduplicate before freezing. Presenter prose should be mapped from
codes; arbitrary prose should not become persisted checksum material.

### Validate shape and semantics separately

The v3 validator needs both:

1. exact structural validation for every nested metric, assessment, assumption, warning, and
   recommendation field; and
2. semantic recomputation from canonical operation/entry/summary facts plus the sealed numeric
   policy snapshot.

Compare the canonical recomputed analysis with the supplied analysis. This is required to reject
an internally false artifact even when its editor also recomputed SHA-256. Do not weaken or reuse
the v2 top-level validator in a mode that accepts extra keys; factor version-neutral helpers only
when the legacy validator's exact behavior remains provably unchanged.

### Use checked arithmetic

All config inputs must be positive safe integers no greater than `1_000_000`. Counts and modelled
products still need checked addition and multiplication:

```ts
const result = left * right;
if (!Number.isSafeInteger(result)) {
  throw new LidarrPlanValidationError("cascade analysis arithmetic overflow");
}
```

Never clamp, emit `Infinity`, or turn overflow into `unknown`. Preserve zero as exact evidence and
use `null` only when the required evidence or explicit assumption is absent.

### Resolve policy once

`getLoadedLidarrConfig()` in `packages/rfmedia-cli/src/lib/loaded-config.ts` is the existing source
of validated Lidarr config. Each producer should resolve the optional cascade config once and pass
the frozen, explicit-null policy to its v3 builder. Do not read current config during apply and do
not add URL/API-key-style CLI overrides for budgets.

## Integration Points

### Create

- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`
  - Config-to-policy resolution with explicit `null` omissions.
  - Checked add/multiply helpers.
  - Exhaustive operation-kind estimation.
  - Budget assessment, stable warning, and recommendation derivation.
  - Canonical semantic recomputation used by v3 validation.
- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.test.ts`
  - Table-driven operation matrix and arithmetic/budget boundaries.

### Modify

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
  - Add cascade contracts, `LIDARR_PLAN_VERSION_V3`, correlated v3 family types, stored/generation
    unions, and an explicit apply presentation state for recorded versus legacy not-recorded
    evidence.
  - Keep every v1/v2 interface byte-contract unchanged.
- `packages/rfmedia-cli/src/types/config.ts`
  - Add readonly `LidarrCascadeAnalysisConfigOptions` and optional
    `LidarrConfigOptions.cascadeAnalysis`.
- `packages/rfmedia-cli/src/lib/config.ts`
  - Add exact allowlists for `cascadeAnalysis`, `budgets`, and `assumptions`.
  - Validate non-array objects and all four fields with exact property paths and inclusive maximum
    `1_000_000`.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
  - Widen `LidarrStoredMutationPlan`.
  - Add v3 builder entry points or a common v3 sealing helper used by every family.
  - Add v3 canonicalization, checksum dispatch, exact parsing, and semantic validation.
  - Update artifact write serialization dispatch; its current v1-versus-else branch would
    otherwise serialize v3 through the v2 canonicalizer.
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts` and
  `plan-track-filter-operations.ts`
  - Add v3 sealing paths while preserving v2 builders for fixtures and compatibility.
- All nine producer actions listed above
  - Resolve policy and call v3 builders.
  - Preserve existing preview/no-change/write behavior.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
  - Widen local plan/entry guards as needed.
  - Copy sealed v3 analysis into every dry-run and real apply result.
  - Synthesize only a presentation-level `not-recorded` state for v1/v2.
  - Do not invoke the analyzer or loaded config.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
  - Render a compact analysis block before entry rows.
  - Label apply evidence as plan-time.
  - Add bounded aggregate CSV fields and stable code arrays to both projection functions.
- Focused tests in `plan-engine.test.ts`, `config.test.ts`, producer tests,
  `actions/lidarr/apply.test.ts`, and `commands/lidarr.test.ts`.
- Operator docs and examples identified in `shared.md`.

No source change is expected in the generated client, Lidarr transport, scheduler, deferred queue,
database schema, Bash/Zsh/Fish templates, or command definitions.

## Code Conventions

- TypeScript is ESM/NodeNext; local imports use `.js` suffixes.
- Persisted contracts use readonly fields, literal discriminants, and correlated unions rather
  than broad optional properties.
- Builders return frozen canonical objects. Clone nested arrays/objects when producing checksum
  material.
- Prefer exhaustive `switch` statements over string maps for operation semantics; use a `never`
  check so a future operation cannot silently omit analysis.
- Sort identifiers numerically and stable codes by declared semantic order, not locale-dependent
  text order.
- Validation errors should use `LidarrPlanValidationError` or the shared
  `validationError()` helper. Config errors must retain `ConfigError` and exact property paths.
- Human output remains on stderr. JSON/YAML/CSV stdout must remain one parseable document.
- State words must be explicit without color: `WITHIN`, `EXCEEDED`, `UNKNOWN`,
  `NOT CONFIGURED`, and `NOT RECORDED`.
- Use stable codes in persisted and CSV output; derive human explanations in the presenter.

## Dependencies and Services

- No new npm dependency is required. SHA-256, safe integer checks, discriminated unions, existing
  formatters, and Vitest cover the implementation.
- No new Lidarr endpoint is required. Existing producer reads already provide the facts from which
  plans are built.
- Do not add Prowlarr, indexer, or download-client clients, credentials, probes, provider names, or
  telemetry. Configured values are per-plan allowances, not observed quota.
- Preserve the private generated-client boundary and
  `packages/rfmedia-cli/src/lib/lidarr/transport.ts` as the sole handwritten fetch owner.
- No SQLite migration is required. Plan analysis belongs in the JSON artifact; history remains
  keyed by plan ID/checksum and entry outcomes.
- Scheduler `operationBudget` is an execution-lane admission concept and must remain independent
  from the new advisory `indexerQueries` and `acquisitionCandidates` allowances.

## Gotchas and Warnings

- **Track-filter monitored evidence is missing:** `executeLidarrTrackFilterPlan()` reads
  `album.monitored`, but `LidarrTrackFileFilterPlanEntryV2.before` stores only delete candidates.
  To meet exact v3 estimation and semantic-recomputation requirements, add monitored state to the
  v3-only canonical facts. Do not modify v2 or consult live state during apply.
- **Album monitoring is still v1:** `plan-albums.ts` calls `buildLidarrMutationPlan()`, unlike
  artist monitoring. A migration that only wraps v2 families will silently leave one of the nine
  writers on v1.
- **Artifact serialization has an unsafe default branch:** the write path currently selects v1
  canonicalization or falls through to v2. Add an explicit v3 branch before any v3 plan can be
  written.
- **Version alone does not identify a v2 family:** artist-add, album mutation, and track filter all
  share the v2 discriminator. V3 still needs operation-kind correlation and family-specific entry
  validation.
- **Legacy exact-key behavior is intentional:** adding optional analysis to v2 would cause
  old/new parsers to disagree and would alter checksum meaning. Preserve frozen fixtures and
  golden checksums.
- **Some actions pre-filter no-ops while others retain them:** album monitoring/edit builders
  receive only changed entries; ordinary artist builders may contain both changed and unchanged
  entries. The estimator must use actual before/after semantics, not assume one producer style.
- **Artist-add supports legacy and extended shapes:** extended plans may be monitored even though
  `searchForMissingAlbums` remains false. Do not infer cascade behavior from the presenter's
  hard-coded legacy phrase or free-form risk text; use canonical operation fields.
- **Config precedent is mixed:** resilience and scheduler validators intentionally drop unknown
  keys, while other sections use `rejectUnknownConfigKeys()`. Issue #219 explicitly requires exact
  nested keys, so cascade validation must use the strict pattern rather than copying scheduler
  permissiveness.
- **Apply has specialized lanes:** artist-add and track-filter return through dedicated apply
  helpers, while other plans share the main path. Add analysis projection to every return path,
  not only the final common return.
- **Advisory means no control-flow effect:** exceeded/unknown findings must not affect approval,
  destructive authorization, origin validation, entry selection, drift checks, lane budgets,
  claims, history, retry/resume, scan behavior, result status, or exit code.
- **Machine output must stay bounded:** do not repeat aggregate analysis on every CSV entry or emit
  arbitrary warning prose. JSON/YAML can retain the structured analysis; CSV should flatten the
  aggregate and code arrays.
- **No completion change is expected:** there is no command or flag. Run the existing Bash/Zsh/Fish
  parity test and record that the command surface is unchanged.

## Task-Specific Guidance

1. Start with the config and persisted contracts. Lock down the exact v3 and analysis shapes before
   changing builders so family correlation and presentation fields remain type-driven.
2. Resolve the track-filter evidence gap explicitly in the v3 contract. A specialized v3
   track-filter entry or v3-only analysis input fact is required; the latter must itself be sealed
   and semantically validated. Treating an unmonitored album as a candidate, or using current
   apply-time state, violates the agreed rule.
3. Implement the analyzer as one pure exhaustive operation switch. Use exact zero for every
   current operation's immediate indexer queries. Use explicit assumptions only for monitored
   artist monitoring/add projections; preserve unknown for profile, tag, and album-edit exposure.
4. Add a shared v3 sealing helper only after canonical operation/selection/entries/review/summary
   and risk exist. Let the existing family builders retain their sort, dedupe, idempotency, and
   summary ownership.
5. Update checksum, validator, reader, and writer dispatch together. Prove semantic tampering is
   rejected after recomputing the checksum, not only when the checksum is stale.
6. Migrate all nine producers in one coverage matrix. Assert the legacy album-monitoring producer
   now emits v3 as well as the four v2-derived families.
7. Carry the sealed analysis through all apply exits, including artist-add and track-filter
   helpers. Legacy v1/v2 returns should expose `not-recorded` only in the output contract; do not
   attach synthetic analysis to the artifact.
8. Add the analysis block to the shared presenter before entry rows and extend both CSV
   projections. Verify human, JSON, YAML, and CSV values agree and stdout remains clean.
9. Concentrate behavior coverage in:
   - a table-driven estimator matrix;
   - v3 canonical/checksum/tamper plus frozen v1/v2 compatibility tests;
   - a compact parameterized config matrix;
   - one all-producer version/analysis coverage guard;
   - presenter/apply parity and advisory-non-enforcement assertions.
10. Run the package typecheck/build/tests, architecture and generated-client contract tests, and
    shell-completion parity. The implementation should produce no generated-client or completion
    diff.

Relevant internal documentation:

- `docs/plans/lidarr-cascade-analysis/shared.md`
- `docs/plans/lidarr-cascade-analysis/feature-spec.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
