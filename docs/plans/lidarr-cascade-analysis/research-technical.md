# Technical Research: Lidarr Cascade Analysis and Budget Estimation

## Executive Summary

Issue #219 should add a pure, deterministic cascade estimator to every Lidarr mutation-plan
builder. The result must be sealed into the plan artifact, shown by dry-run and persisted-plan
previews, and preserved unchanged at apply time. It is advisory: exceeding a configured budget
produces structured warnings and recommendations but does not silently truncate a plan or create a
new apply authorization gate.

The current repository has outgrown the issue's original four-file estimate. There are now nine
plan operation kinds, several parallel v2 plan families, strict exact-key parsing, canonical
checksums, shared presentation, and multiple plan actions. A correct implementation therefore
cannot live only in `actions/lidarr/plan.ts`.

The most important compatibility decision is to produce
`rfmedia.lidarr-plan.v3`. Adding a `cascadeAnalysis` key to v2 would make new artifacts fail in old
v2 readers while retaining the same discriminator, violating the repository's strict schema
contract. New readers must continue accepting v1 and every existing v2 artifact byte-for-byte.

## Architecture Design

### Plan families

`src/types/lidarr-plan.ts` currently defines:

- v1 artist/album monitoring plans;
- strict v2 artist monitoring, profile assignment, tag mutation, and artist deletion;
- a parallel v2 foreign-ID artist-add family;
- parallel v2 album-edit and album-delete families; and
- a parallel v2 track-file-filter family.

All are accepted through `LidarrStoredMutationPlan` in
`src/lib/lidarr/plan-engine.ts`. Dispatch is by `plan.operation.kind`, not only by version.

The current operation kinds are:

| Operation                   | Current direct search | Relevant downstream effect                                                                                        |
| --------------------------- | --------------------: | ----------------------------------------------------------------------------------------------------------------- |
| `artist-monitoring`         |                     0 | Monitoring may expose an artist's albums to future acquisition                                                    |
| `album-monitoring`          |                     0 | Newly monitored albums become future acquisition candidates                                                       |
| `artist-profile-assignment` |                     0 | Quality/metadata policy can change future eligibility, but the plan lacks enough evidence to count it             |
| `artist-tag-mutation`       |                     0 | Tag-driven external automation is unknowable to rfmedia                                                           |
| `artist-delete`             |                     0 | Removes acquisition scope; file deletion is already represented separately                                        |
| `artist-add`                |                     0 | Metadata work occurs, but `searchForMissingAlbums` is sealed `false`; monitored adds can increase future exposure |
| `album-edit`                |                     0 | Release-acceptance policy may change future eligibility, but not predictably from the artifact                    |
| `album-delete`              |                     0 | No direct acquisition; import lists may later re-add an album unless exclusion is sealed                          |
| `track-file-filter`         |                     0 | Deleting managed files can make one monitored album incomplete and eligible for later reacquisition               |

No current plan operation explicitly launches an artist or album search. The estimator must not
repeat the research document's hypothetical per-album search count as an immediate effect. It
should report exact immediate indexer queries of zero for the current operation set and separately
model future acquisition exposure.

### Artifact invariants

`plan-engine.ts`:

- validates exact top-level keys;
- reconstructs the expected operation, entries, summary, and risk;
- canonicalizes every field in a stable order;
- computes SHA-256 over the canonical representation without `payloadChecksum`;
- rejects unknown versions, unknown keys, inconsistent summaries, and checksum mismatches; and
- writes private, bounded, no-overwrite artifacts atomically.

Cascade analysis is review evidence and budget policy. It therefore belongs inside the checksum,
not in an unsealed command envelope or recomputed during apply.

### Planning and apply flow

Each plan action resolves the complete target cohort, constructs the plan, optionally writes the
artifact, and returns `{ planPath, plan }`. Dry-run plan actions skip the write but return the same
in-memory plan shape. The command layer then renders human output or exposes the result through the
existing machine formats.

Apply reads and validates the artifact and uses only sealed evidence. It must display the original
cascade analysis; it must not recompute estimates from the current config because that would change
the reviewed policy after plan creation.

## Proposed Data Flow

```text
validated config
  -> resolve bounded cascade policy and assumptions
  -> existing action resolves target cohort
  -> existing plan builder canonicalizes operation/entries/summary/risk
  -> pure cascade analyzer consumes canonical pre-seal plan facts
  -> v3 builder adds cascadeAnalysis
  -> canonical v3 checksum
  -> dry-run return OR atomic artifact write
  -> presenter renders estimates, assessments, warnings, recommendations
  -> apply validates and re-displays the sealed analysis without recomputation
```

The analyzer must be pure: no Prowlarr calls, download-client calls, filesystem access, clock reads,
or configuration reads. The action resolves configuration and passes a complete policy. This keeps
plan-engine tests deterministic and prevents a checksum from depending on mutable external state.

Live Prowlarr quota discovery and runtime cross-stack circuit breaking are explicitly outside #219.
They are larger follow-up capabilities described in the research, not prerequisites for useful
static plan analysis.

## Data Models

Add the following contracts to `src/types/lidarr-plan.ts`:

```ts
export const LIDARR_PLAN_VERSION_V3 = "rfmedia.lidarr-plan.v3";
export const LIDARR_CASCADE_MODEL_VERSION = "rfmedia.lidarr-cascade.v1";

export type LidarrCascadeMetricName = "indexerQueries" | "acquisitionCandidates";

export type LidarrCascadeEstimate =
  | {
      readonly confidence: "exact" | "modelled";
      readonly value: number;
      readonly basis: string;
    }
  | {
      readonly confidence: "unknown";
      readonly value: null;
      readonly basis: string;
    };

export interface LidarrCascadeAssumptions {
  /** Resolved plan-time value; built-in default 20. */
  readonly albumsPerArtist: number;
}

export interface LidarrCascadeEstimates {
  /** Requests directly caused by applying this artifact, not background RSS polling. */
  readonly indexerQueries: LidarrCascadeEstimate;
  /** Albums newly exposed to acquisition or reacquisition by this operation. */
  readonly acquisitionCandidates: LidarrCascadeEstimate;
}

export type LidarrCascadeBudgetAssessment =
  | {
      readonly status: "not-configured";
      readonly limit: null;
      readonly projected: number | null;
    }
  | {
      readonly status: "within" | "exceeded";
      readonly limit: number;
      readonly projected: number;
    }
  | {
      readonly status: "unknown";
      readonly limit: number;
      readonly projected: null;
    };

export interface LidarrCascadeBudgetAssessments {
  readonly indexerQueries: LidarrCascadeBudgetAssessment;
  readonly acquisitionCandidates: LidarrCascadeBudgetAssessment;
}

export type LidarrCascadeRecommendation = "reduce-scope" | "split-into-batches" | "delay-apply";

export type LidarrCascadeWarning =
  | {
      readonly code: "indexer-query-budget-exceeded";
      readonly metric: "indexerQueries";
      readonly projected: number;
      readonly limit: number;
      readonly overBy: number;
    }
  | {
      readonly code: "acquisition-budget-exceeded";
      readonly metric: "acquisitionCandidates";
      readonly projected: number;
      readonly limit: number;
      readonly overBy: number;
    }
  | {
      readonly code: "budget-assessment-incomplete";
      readonly metric: LidarrCascadeMetricName;
      readonly projected: null;
      readonly limit: number;
    };

export interface LidarrCascadeAnalysis {
  readonly modelVersion: typeof LIDARR_CASCADE_MODEL_VERSION;
  readonly assumptions: LidarrCascadeAssumptions;
  readonly estimates: LidarrCascadeEstimates;
  readonly budgets: LidarrCascadeBudgetAssessments;
  readonly warnings: readonly LidarrCascadeWarning[];
  readonly recommendations: readonly LidarrCascadeRecommendation[];
}
```

`basis` is bounded, terminal-safe explanatory text selected by the implementation, never
user-supplied free text. The stable codes are for automation; the presenter owns friendly messages.

Define v3 as a mechanical version of each stored v2 family with one required field:

```ts
type LidarrPlanV3From<TPlan extends { readonly version: string }> = Omit<TPlan, "version" | "payloadChecksum"> & {
  readonly version: typeof LIDARR_PLAN_VERSION_V3;
  readonly cascadeAnalysis: LidarrCascadeAnalysis;
  readonly payloadChecksum: string;
};

export type LidarrMutationPlanV3 = LidarrPlanV3From<LidarrMutationPlanV2>;
export type LidarrArtistAddPlanV3 = LidarrPlanV3From<LidarrArtistAddPlanV2>;
export type LidarrAlbumMutationPlanV3 = LidarrPlanV3From<LidarrAlbumMutationPlanV2>;
export type LidarrTrackFileFilterPlanV3 = LidarrPlanV3From<LidarrTrackFileFilterPlanV2>;
```

The implementation may need a distributive helper (`TPlan extends unknown ? ... : never`) to
preserve operation/entry/summary correlation across unions. Do not widen v2 types in place.

`LidarrStoredMutationPlan` becomes the union of existing v1/v2 types and all v3 families. Newly
produced mutation plans are v3; v1/v2 remain read/apply-only compatibility contracts.

## Configuration and CLI Design

Add a config-only section under `lidarr`:

```ts
export interface LidarrCascadeAnalysisConfigOptions {
  readonly budgets?: {
    readonly indexerQueries?: number;
    readonly acquisitionCandidates?: number;
  };
  readonly assumptions?: {
    readonly albumsPerArtist?: number;
  };
}

export interface LidarrConfigOptions {
  // existing fields...
  readonly cascadeAnalysis?: LidarrCascadeAnalysisConfigOptions;
}
```

Example:

```yaml
lidarr:
  cascadeAnalysis:
    budgets:
      indexerQueries: 250
      acquisitionCandidates: 50
    assumptions:
      albumsPerArtist: 20
```

Validation bounds:

- budgets: positive safe integers, maximum `1_000_000`;
- `albumsPerArtist`: positive safe integer, maximum `10_000`;
- omitted budgets mean `not-configured`, not an arbitrary global quota;
- omitted `albumsPerArtist` resolves to the documented research-derived default `20`.

The initial implementation should not add CLI budget flags. Budgets are durable operator policy,
not one-off mutation intent; config-only policy matches the existing scheduler controls and avoids
duplicating flags across every plan leaf. Machine output automatically gains the checksummed field.
Human output changes in the shared mutation presenter.

Consequently, Bash, Zsh, and Fish completion templates require no new options for #219. Their parity
test should still be run and called out in verification. If implementation later chooses CLI
overrides, all three templates plus `templates.spec.ts` become required and CLI values must override
config before the plan is sealed.

## Estimator Algorithm

### Common rules

1. Analyze only changed entries or destructive delete candidates, never `review.requested`.
2. Use safe-integer checked addition and multiplication. Overflow is a validation failure; never
   clamp or emit `Infinity`.
3. Immediate `indexerQueries` is `exact: 0` for all currently supported operations because none
   dispatches `ArtistSearch`/`AlbumSearch` and artist-add seals search off.
4. `acquisitionCandidates` means albums newly eligible for acquisition/reacquisition. It is not a
   promise of grabs, downloads, bytes, disk use, or wall-clock duration.
5. Unknown effects stay `unknown`; do not replace missing evidence with zero.
6. Sort warnings by metric order (`indexerQueries`, then `acquisitionCandidates`) and deduplicate
   recommendations in fixed order (`reduce-scope`, `split-into-batches`, `delay-apply`).

### Per-operation acquisition estimate

| Operation                          | Calculation                                                                              | Confidence and basis                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `artist-monitoring` to monitored   | changed false-to-true artists × `albumsPerArtist`                                        | `modelled`; artist plans do not seal per-album state                                 |
| `artist-monitoring` to unmonitored | `0`                                                                                      | `exact`; it removes future exposure                                                  |
| `album-monitoring` to monitored    | count changed false-to-true entries                                                      | `exact`; each entry is one album                                                     |
| `album-monitoring` to unmonitored  | `0`                                                                                      | `exact`                                                                              |
| `artist-add`, monitored true       | added artists × `albumsPerArtist`                                                        | `modelled`; catalog size is unavailable until metadata population                    |
| `artist-add`, monitored false      | `0`                                                                                      | `exact`; search is disabled and artist is unmonitored                                |
| `track-file-filter`                | `1` when at least one file is deleted and the reviewed album is monitored, otherwise `0` | `exact` at album granularity                                                         |
| `artist-delete`                    | `0`                                                                                      | `exact`; removes scope                                                               |
| `album-delete`                     | `0`                                                                                      | `exact` for the apply itself; add a basis note that import-list behavior is separate |
| `artist-profile-assignment`        | `null`                                                                                   | `unknown`; plan lacks release/cutoff evidence                                        |
| `artist-tag-mutation`              | `null`                                                                                   | `unknown`; external tag automation is not observable                                 |
| `album-edit`                       | `null`                                                                                   | `unknown`; release candidates and cutoff state are absent                            |

If product requirements prefer budget assessment only for operations that can increase acquisition
scope, profile/tag/album-edit may instead use `not-applicable`. That would require another estimate
variant. `unknown` is safer for the first implementation because a configured budget cannot be
proven satisfied.

### Budget assessment

For each metric:

```text
no configured limit              -> not-configured
estimate.value is null           -> unknown + budget-assessment-incomplete warning
estimate.value <= configured max -> within
estimate.value > configured max  -> exceeded + metric-specific warning
```

Recommendations:

- any exceeded budget: `reduce-scope`, `split-into-batches`, `delay-apply`;
- unknown against a configured budget: `reduce-scope`;
- no warning: no recommendation.

Batching and delay manage load rate, not total work. Human wording must say that explicitly rather
than implying that splitting a plan reduces total query or acquisition demand.

## Artifact Compatibility and Validation

### Version behavior

- v1: continue exact validation, checksum calculation, read, and apply.
- v2: continue exact validation, checksum calculation, read, and apply with no synthetic analysis.
- v3: require `cascadeAnalysis` and validate it before checksum comparison.
- new writers: produce only v3 for every Lidarr mutation-plan family.
- apply output for v1/v2: show `Cascade analysis: unavailable (legacy artifact)` rather than
  recomputing from current configuration.

Do not mutate an old artifact into v3 during read. A migration would create a new checksum and new
review evidence and should be a separate explicit command if ever needed.

### Canonicalization

`canonicalizePlanV3()` should reuse the operation-specific v2 canonicalizers but emit:

1. the v3 version string;
2. all existing fields in their current order;
3. `cascadeAnalysis` immediately before `payloadChecksum`; and
4. checksum only when requested.

Canonical analysis key order must match the interfaces above. Arrays are already produced in stable
order and must be revalidated for duplicates and bounds.

Recommended bounds:

- `basis`: non-empty, terminal-safe, maximum 512 UTF-8 bytes;
- warnings: at most two (one per metric);
- recommendations: at most three;
- estimates and all projected/limit/overBy values: non-negative safe integers;
- `overBy === projected - limit`;
- `exceeded` iff projected is greater than limit;
- `within` iff projected is less than or equal to limit;
- warning and assessment status must agree;
- recommendation set must exactly match the deterministic warning-derived set.

Recompute the expected analysis from the canonical plan facts and the assumptions/budget limits
sealed in `cascadeAnalysis`; reject mismatches. This prevents a checksummed but semantically false
analysis from being accepted merely because its checksum is internally consistent.

## Error Handling

Use `LidarrPlanValidationError` for invalid policy, unsafe arithmetic, malformed analysis, and
analysis/plan inconsistency. Existing artifact read wraps validation with the artifact path, so no
new error hierarchy is required.

Planning must fail before artifact creation when:

- config values are out of bounds;
- arithmetic exceeds `Number.MAX_SAFE_INTEGER`;
- an operation kind has no explicit estimator branch;
- a generated assessment contradicts its estimate or limit; or
- v3 semantic recomputation does not match the stored analysis.

An exceeded budget is not an exception. It is review evidence. An unknown estimate with a configured
budget is also a warning, not a failure. This follows the issue language ("surface warnings") and
avoids adding an undocumented apply bypass.

Errors and basis strings must never include API keys, URLs with credentials, filesystem media paths,
or arbitrary tag/profile names. The estimator needs only operation kind, boolean policy, counts, and
sealed numeric assumptions.

## Presentation Contract

Human plan/dry-run output should add a compact section after the existing risk/summary lines:

```text
Cascade analysis (rfmedia.lidarr-cascade.v1):
  Immediate indexer queries: 0 (exact)
  Acquisition candidates: ~60 albums (modelled: 3 artists × 20 albums/artist)
  Acquisition budget: EXCEEDED (60 projected / 50 configured)
  Warning: projected acquisition candidates exceed budget by 10.
  Recommendations: reduce scope; split into batches; delay apply.
```

For unknown estimates:

```text
  Acquisition candidates: unknown (profile changes lack release/cutoff evidence)
  Acquisition budget: UNKNOWN (cannot prove the plan is within the configured limit of 50)
```

JSON/YAML naturally includes the structured `plan.cascadeAnalysis`. Add flat CSV fields for:

- `result.cascade.modelVersion`;
- estimate value and confidence for both metrics;
- budget limit/status for both metrics;
- JSON-encoded warnings and recommendations.

Apply review/result should show the sealed analysis before confirmation. It must never use a
different current budget to reinterpret the artifact.

## Performance and Security

The estimator is `O(entries)` time and `O(1)` additional space. It must not add API calls. Existing
planning calls already hold the facts needed for exact album counts; artist estimates deliberately
use the sealed assumption instead of fetching every artist's albums. This avoids an N+1 API pattern
and preserves the scheduler's lane budgets.

The stored analysis is constant-size and negligible relative to the 10 MiB artifact limit. No
unbounded per-entry explanation arrays are needed.

Static analysis cannot know:

- live Prowlarr rolling quota usage;
- the number of enabled indexers;
- background RSS query amortization;
- successful grabs or download sizes;
- download-client queue capacity; or
- external tag/import-list automation.

The UI and docs must call the values estimates and must not imply enforcement by Prowlarr or the
download client.

## Files to Create or Modify

### Required production files

- Create `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`
  - policy resolution types/constants;
  - pure exhaustive estimator;
  - deterministic budget assessment and recommendations;
  - semantic assertion/recomputation helper used by v3 validation.
- Modify `packages/rfmedia-cli/src/types/lidarr-plan.ts`
  - analysis contracts, v3 plan families, generation/apply unions.
- Modify `packages/rfmedia-cli/src/types/config.ts`
  - `lidarr.cascadeAnalysis` config contract.
- Modify `packages/rfmedia-cli/src/lib/config.ts`
  - bounded config validation.
- Modify `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
  - v3 builders, canonicalization, exact parser, checksum dispatch, stored union.
- Modify every plan-producing action under `src/actions/lidarr/`
  - resolve config at the action boundary and pass the policy into the appropriate v3 builder;
  - preserve dry-run/write parity.
- Modify `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
  - human plan/apply display and CSV projection.
- Modify `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`,
  `packages/rfmedia-cli/README.md`, and `rfmedia.example.yaml`
  - config schema, semantics, limitations, and examples.
- Modify `ROADMAP.md` with issue #219 completion evidence.

`src/commands/lidarr.ts` needs changes only if the project keeps apply rendering there or chooses CLI
overrides. The current shared presenter is the correct primary integration point.

### Critical tests only

- Create `src/lib/lidarr/cascade-analysis.test.ts` with one table covering every operation kind,
  exact/modelled/unknown estimates, boundary equality, one over-budget case, one unknown-budget
  case, stable ordering, and safe-integer overflow.
- Extend `src/lib/lidarr/plan-engine.test.ts` for:
  - v3 checksum round trip;
  - tampered analysis rejection;
  - v1 and representative legacy/extended v2 fixtures still accepted unchanged.
- Extend `src/lib/config.test.ts` for one valid config and boundary/type rejection.
- Extend the existing command/presenter test for human warning text and JSON/CSV parity.
- Run existing plan-action tests rather than duplicating the estimator matrix in every action test.
  Add a per-action assertion only where necessary to prove each producer emits v3 with analysis.
- Run `src/lib/shell-completions/templates.spec.ts` to prove no completion drift. Do not add completion
  assertions when no CLI option is added.

## Technical Decisions and Rejected Options

### Decision: new v3 artifact

Rejected: add optional `cascadeAnalysis` to v2. New v2 artifacts would be rejected as unknown-key
artifacts by old v2 readers despite claiming the same exact schema version.

Rejected: encode dynamic estimates as strings in `risk.cascade`. The risk list is an exact
operation-owned contract, cannot support stable machine budget assessment, and conflates generic
operation risk with plan-specific quantitative evidence.

Rejected: put analysis only in the command result. It would be absent from persisted review
artifacts and could differ at apply.

### Decision: static configured budgets

Rejected for #219: query Prowlarr or download clients. This introduces new credentials, clients,
error taxonomy, retries, caching, privacy concerns, and time-sensitive evidence. A live quota
snapshot would also be stale by apply time.

### Decision: warning-only

Rejected: refuse to write or apply over-budget plans. The issue requests visibility and
recommendations, not a new authorization mechanism. A later circuit-breaker issue can add explicit
enforcement with a reviewed override contract.

### Decision: one estimator, no per-operation classes

Use one exhaustive `switch` in `cascade-analysis.ts`. The operation-definition registry owns
mutation execution behavior, but injecting configurable plan-wide budget policy into every
definition would spread cross-cutting policy and create unnecessary abstractions.

## Open Questions for Design Approval

1. Should profile assignment, tag mutation, and album-edit be reported as `unknown` or as exact zero
   immediate acquisition candidates? Recommendation: `unknown` when an acquisition budget is
   configured, because future automation/eligibility cannot be proven absent.
2. Should `albumsPerArtist` default to the research example's 20 or require explicit configuration?
   Recommendation: default to 20 and seal it, so the feature produces a usable model while making
   the assumption visible.
3. Should over-budget plans remain advisory? Recommendation: yes for #219; create a child issue for
   enforceable cross-stack circuit breaking if desired.
4. Should live Prowlarr remaining-budget integration be a child issue? Recommendation: yes, because
   it requires a separate service boundary and a timestamped/staleness model.
5. Should all existing plan producers switch to v3 in one PR? Recommendation: yes. Partial adoption
   would make the same CLI inconsistently include cascade evidence by operation kind.

## Recommended Implementation Sequence

1. Add the contracts/config validation and the pure estimator with its focused table test.
2. Add v3 canonicalization, semantic validation, checksum support, and legacy compatibility tests.
3. Convert every plan builder/action to v3, preserving dry-run and persisted-plan parity.
4. Add shared human/machine presentation, documentation, examples, and ROADMAP update.
5. Run focused tests, all rfmedia-cli tests, typecheck/build/lint, architecture/codegen suites, and
   Bash/Zsh/Fish completion parity before PR review.
