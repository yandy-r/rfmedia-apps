# Feature Spec: Lidarr Cascade Analysis and Indexer Budgets

## Executive Summary

Issue #219 adds deterministic cascade analysis to every Lidarr mutation-plan family so an operator
can review immediate work, conditional future acquisition exposure, and configured per-plan budget
consumption before apply. Newly produced plans use `rfmedia.lidarr-plan.v3`; the structured
analysis, modeling assumptions, budget snapshot, warnings, and recommendations are strict
checksum material, while existing v1/v2 plans remain readable and applicable as legacy artifacts
with analysis status `not-recorded`. The implementation is a pure TypeScript estimator over
canonical plan facts and bounded static configuration: it adds no Prowlarr/download-client calls,
credentials, dependencies, commands, or flags. Budget findings are advisory and never alter scope,
ordering, confirmation, destructive authorization, drift checks, or resume behavior.

## External Dependencies

### APIs and Services

#### Lidarr v1 API

- **Documentation**: <https://lidarr.audio/docs/api/>
- **OpenAPI**:
  <https://raw.githubusercontent.com/Lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json>
- **Authentication**: existing `X-Api-Key` header boundary; no new credential use
- **Relevant existing reads**:
  - `GET /api/v1/artist`: artist state used by current planners
  - `GET /api/v1/album`: album state used by current planners
  - `GET /api/v1/wanted/missing`: useful future telemetry, out of scope for v1 analysis
  - `GET /api/v1/queue`: useful future telemetry, out of scope for v1 analysis
- **Rate limits**: no Lidarr HTTP API quota is declared by the official OpenAPI
- **Issue #219 behavior**: the estimator performs no API calls; it consumes already canonicalized
  plan facts

#### Prowlarr v1 API

- **Documentation**: <https://prowlarr.com/docs/api/>
- **OpenAPI**:
  <https://raw.githubusercontent.com/Prowlarr/Prowlarr/develop/src/Prowlarr.Api.V1/openapi.json>
- **Potential future reads**: `/api/v1/indexerstats`, `/api/v1/indexerstatus`, and
  `/api/v1/indexer`
- **Constraint**: those resources provide retrospective activity and status, not a stable typed
  remaining-quota contract
- **Issue #219 behavior**: no Prowlarr client, credential, request, or persisted provider response

### Libraries and SDKs

No new library is required. The implementation uses the repository's TypeScript discriminated
unions, plan validation helpers, SHA-256 canonicalization, config validator, presenter, and Vitest
suite. Generated Lidarr modules remain private behind the existing handwritten facade.

### External Documentation

- [Lidarr API docs](https://lidarr.audio/docs/api/): authoritative local API contract
- [Prowlarr API docs](https://prowlarr.com/docs/api/): future telemetry reference only
- [WCAG use of color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html): warnings
  must remain understandable without color

## Business Requirements

### User Stories

- As a cautious operator, I can distinguish immediate indexer/search work from conditional future
  acquisition exposure before applying a Lidarr plan.
- As an operator sharing indexers across the arr stack, I can compare modelled plan demand with
  configured per-plan allowances without mistaking them for live provider quota.
- As an automation author, I receive stable structured metrics, assessments, warning codes, and
  recommendation codes in machine output.
- As an operator applying an older plan, I can see that cascade analysis was not recorded without
  losing v1/v2 compatibility.
- As an operator revising an over-budget plan, I receive accurate suggestions to reduce scope,
  split independently reviewed batches, or delay apply without an invented force flag.

### Business Rules

1. **Two horizons**: every effect is `immediate`, `conditional`, or `none`.
   - Validation: current operations report exact zero immediate explicit searches and indexer
     queries because none enqueue search; artist-add seals `searchForMissingAlbums: false`.
   - Conditional exposure must never be described as a guaranteed grab, download, byte count, or
     elapsed time.
2. **Zero is not unknown**: zero means the reviewed operation rules the work out; unknown means
   evidence or assumptions are insufficient.
3. **Changed scope only**: no-op entries contribute zero newly caused work.
4. **Static policy**: configured budgets and modeling assumptions are resolved at plan time and
   sealed; apply never reinterprets them using current config.
5. **Explicit units**: query allowance and acquisition-candidate allowance are separate per-plan
   concepts and are not scheduler `operationBudget`.
6. **Advisory findings**: an exceeded or incomplete assessment creates warnings and
   recommendations but does not block, truncate, reorder, or authorize apply.
7. **Legacy compatibility**: v1/v2 validation and checksums remain byte-for-byte unchanged;
   legacy apply reports `not-recorded`.
8. **Read-only planning**: analysis must not enqueue a Lidarr command, test an indexer, grab a
   release, or contact a download client.
9. **Credential exclusion**: analysis accepts only credential-free canonical plan facts and
   bounded numeric policy.
10. **Determinism**: identical canonical plan facts and resolved policy produce identical analysis,
    warning order, recommendation order, and checksum.

### Edge Cases

| Scenario                                       | Expected behavior                                            | Notes                            |
| ---------------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| No changed entries                             | Immediate and newly caused conditional counts are exact zero | Plan remains auditable           |
| Missing budget                                 | Assessment is `not-configured`                               | Never "unlimited"                |
| Missing required model assumption              | Related conditional metric is `unknown`                      | Never coerced to zero            |
| Estimate equals allowance                      | Assessment is `within`                                       | Only greater-than exceeds        |
| Safe-integer overflow                          | Planning fails before artifact write                         | Never clamp                      |
| Profile/tag/album-policy effect lacks evidence | Conditional acquisition/query quantity is `unknown`          | Qualitative basis remains        |
| Legacy v1/v2 plan                              | Apply works and reports `not-recorded`                       | No synthetic plan-time analysis  |
| Analysis tampered and checksum recomputed      | Semantic validation rejects inconsistency                    | Checksums alone are insufficient |
| Machine output                                 | One clean JSON/YAML/CSV document                             | No human diagnostics on stdout   |

### Success Criteria

- [ ] Every newly produced Lidarr plan family emits strict v3 cascade analysis.
- [ ] Every current operation reports exact zero immediate explicit searches/indexer queries.
- [ ] Known conditional exposure is exact or modelled from sealed, disclosed assumptions; unknown
      remains explicit.
- [ ] Query and acquisition allowances produce deterministic `not-configured`, `within`,
      `exceeded`, or `unknown` assessments.
- [ ] Exceeded/incomplete assessments produce stable warnings and bounded recommendations.
- [ ] v1/v2 plans retain their original checksum and apply contracts.
- [ ] Preview, sealed-plan output, and apply dry-run expose the same plan-time analysis.
- [ ] No new network request, dependency, credential, command, or flag is introduced.

## Technical Specifications

### Architecture Overview

```text
validated lidarr.cascadeAnalysis config
                 |
                 v
       resolved bounded policy
                 |
existing planner builds canonical operation, entries, review, summary, risk
                 |
                 v
       analyzeLidarrCascade()        (pure, exhaustive, no I/O)
                 |
                 v
v3 canonicalizer + semantic validator + checksum
                 |
        +--------+--------+
        |                 |
 preview result      atomic artifact write
        |                 |
        +--------+--------+
                 v
shared human/JSON/YAML/CSV presenter
                 |
                 v
apply/apply --dry-run displays sealed analysis without recomputation
```

### Data Models

#### Configuration

```ts
interface LidarrCascadeAnalysisConfigOptions {
  readonly budgets?: {
    readonly indexerQueries?: number;
    readonly acquisitionCandidates?: number;
  };
  readonly assumptions?: {
    readonly albumsPerArtist?: number;
    readonly indexerQueriesPerCandidate?: number;
  };
}
```

- Budgets and assumptions are positive safe integers bounded at `1_000_000`.
- Omitted budgets mean `not-configured`.
- Omitted assumptions make dependent conditional quantities `unknown`.
- The example config documents `albumsPerArtist: 20` and
  `indexerQueriesPerCandidate: 1` as operator-chosen examples, not universal truths.

#### Cascade analysis

```ts
interface LidarrCascadeMetric {
  readonly value: number | null;
  readonly certainty: "exact" | "modelled" | "unknown";
  readonly horizon: "immediate" | "conditional" | "none";
  readonly unit: "artists" | "albums" | "indexer-queries" | "acquisition-candidates" | "files" | "bytes";
  readonly basis: LidarrCascadeBasisCode;
}

interface LidarrCascadeBudgetAssessment {
  readonly status: "not-configured" | "within" | "exceeded" | "unknown";
  readonly limit: number | null;
  readonly projected: number | null;
  readonly provenance: "configured-per-plan";
}

interface LidarrCascadeAnalysis {
  readonly modelVersion: "rfmedia.lidarr-cascade.v1";
  readonly assumptions: {
    readonly albumsPerArtist: number | null;
    readonly indexerQueriesPerCandidate: number | null;
  };
  readonly metrics: {
    readonly immediateIndexerQueries: LidarrCascadeMetric;
    readonly acquisitionCandidates: LidarrCascadeMetric;
    readonly conditionalIndexerQueries: LidarrCascadeMetric;
    readonly newlyMonitored: LidarrCascadeMetric;
    readonly filesAffected: LidarrCascadeMetric;
    readonly bytesAffected: LidarrCascadeMetric;
  };
  readonly budgets: {
    readonly indexerQueries: LidarrCascadeBudgetAssessment;
    readonly acquisitionCandidates: LidarrCascadeBudgetAssessment;
  };
  readonly warnings: readonly LidarrCascadeWarning[];
  readonly recommendations: readonly LidarrCascadeRecommendationCode[];
}
```

Stable basis, warning, and recommendation codes are enums owned by production code. Human prose is
derived by the presenter and is not stored as arbitrary remote/config text.

#### Plan version

```ts
const LIDARR_PLAN_VERSION_V3 = "rfmedia.lidarr-plan.v3";

type LidarrPlanV3From<TPlan extends { readonly version: string }> = TPlan extends unknown
  ? Omit<TPlan, "version" | "payloadChecksum"> & {
      readonly version: typeof LIDARR_PLAN_VERSION_V3;
      readonly cascadeAnalysis: LidarrCascadeAnalysis;
      readonly payloadChecksum: string;
    }
  : never;
```

All v2 plan families receive correlated v3 counterparts. `LidarrStoredMutationPlan` accepts v1,
v2, and v3; only new writers emit v3.

### Estimation Rules

| Operation                        | Immediate indexer queries | Conditional acquisition candidates                                                                    |
| -------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Artist add, unmonitored          | Exact 0                   | Exact 0                                                                                               |
| Artist add, monitored            | Exact 0                   | Modelled: changed artists × configured albums/artist; otherwise unknown                               |
| Artist monitoring to monitored   | Exact 0                   | Modelled: changed artists × configured albums/artist; otherwise unknown                               |
| Artist monitoring to unmonitored | Exact 0                   | Exact 0 newly exposed                                                                                 |
| Album monitoring to monitored    | Exact 0                   | Exact changed false-to-true albums                                                                    |
| Album monitoring to unmonitored  | Exact 0                   | Exact 0 newly exposed                                                                                 |
| Profile/tag/album-edit           | Exact 0                   | Unknown without release/automation evidence                                                           |
| Artist/album delete              | Exact 0                   | Exact 0 newly exposed; reuse file evidence                                                            |
| Track-file filter                | Exact 0                   | Exact one possible reacquisition candidate when files are removed from a monitored album; otherwise 0 |

When acquisition candidates are known and `indexerQueriesPerCandidate` is configured, conditional
indexer queries are modelled as checked multiplication. Otherwise they are unknown. Budgets compare
against conditional modelled query demand and acquisition candidates, never against the exact-zero
immediate query metric. This makes the indexer allowance useful while clearly labeling the
projection as conditional and modelled.

### Validation and Canonicalization

- v3 top-level keys are exact and include required `cascadeAnalysis`.
- Every nested object has exact keys, bounded arrays, enum allowlists, and safe integers.
- `null` is permitted only for unknown quantities or unconfigured limits.
- Metric certainty/horizon/value combinations are validated.
- Budget status must agree with the metric and allowance.
- Warning and recommendation sets must exactly match deterministic derivation.
- The validator recomputes analysis from canonical plan facts plus sealed assumptions/limits and
  rejects semantic mismatches even when a malicious editor recomputed SHA-256.
- v1/v2 parsing and canonical serialization remain unchanged.

### System Integration

#### Files to Create

- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`: policy resolution, pure estimator,
  checked arithmetic, assessment/warning/recommendation derivation, semantic recomputation
- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.test.ts`: one critical operation/boundary
  matrix

#### Files to Modify

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: cascade contracts and correlated v3 families
- `packages/rfmedia-cli/src/types/config.ts`: `lidarr.cascadeAnalysis`
- `packages/rfmedia-cli/src/lib/config.ts`: strict bounded config validation
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: v3 builders, canonicalization, checksum
  dispatch, parser, semantic validation, legacy union
- Plan-producing actions in `packages/rfmedia-cli/src/actions/lidarr/`: resolve policy and use v3
  builders across ordinary artist, artist-add, album mutation, and track-filter paths
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: shared human and CSV projection
- `packages/rfmedia-cli/README.md`, `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`,
  `rfmedia.example.yaml`: public semantics/config/limitations
- `ROADMAP.md`: move #219 to shipped history and update live issue totals after authoritative audit

#### Configuration Example

```yaml
lidarr:
  cascadeAnalysis:
    budgets:
      indexerQueries: 250
      acquisitionCandidates: 50
    assumptions:
      albumsPerArtist: 20
      indexerQueriesPerCandidate: 1
```

## UX Considerations

### User Workflows

#### Preview and seal

1. Generate a preview or plan using the existing plan command.
2. Review operation risk, immediate effects, conditional exposure, budget assessments, warnings,
   and recommendations before entry rows.
3. Tighten IDs/filters or reduce `--max-batch` when desired.
4. Seal the plan; its analysis and policy snapshot become checksum material.

#### Apply check and apply

1. Run `rfmedia lidarr apply <plan> --dry-run`.
2. Display `Plan-time cascade analysis`; do not recalculate current capacity.
3. Run normal fresh-state, origin, resource, history, and claim checks.
4. Apply under the existing confirmation/destructive authorization contract.

#### Error recovery

- Invalid config or unsafe arithmetic: fail before artifact write with the exact property/field.
- Unknown evidence: preserve the plan and render `UNKNOWN` with a safe scope-reduction suggestion.
- Legacy artifact: render `NOT RECORDED`; continue normal compatibility behavior.
- Over-budget advisory: revise scope or proceed under existing authorization; no hidden override.

### UI Patterns

| Component      | Pattern                                 | Notes                               |
| -------------- | --------------------------------------- | ----------------------------------- |
| Cascade block  | Labeled lines before entry table        | Immediate first, conditional second |
| Budget state   | Explicit uppercase word plus quantities | Color is optional reinforcement     |
| Warning        | Stable `[WARNING code]`                 | Adjacent to affected metric         |
| Recommendation | Bounded deduplicated list               | No invented commands/flags          |
| Legacy state   | `NOT RECORDED (legacy plan)`            | Never synthesize old plan evidence  |

### Accessibility Requirements

- Use explicit `WITHIN`, `EXCEEDED`, `UNKNOWN`, `NOT CONFIGURED`, and `NOT RECORDED` words.
- Preserve meaning under `NO_COLOR`, redirected output, logs, and screen readers.
- Avoid emoji, tree glyphs, animated meters, or color-only distinctions.
- Keep human diagnostics on stderr and machine documents on stdout.

### Performance UX

Analysis is `O(entries)` with constant-size output and no additional I/O. Existing preview row caps
remain unchanged. No progress indicator is needed because estimation is synchronous arithmetic.

## Recommendations

### Implementation Approach

1. Define v3/config contracts and the pure estimator.
2. Add strict v3 sealing and representative legacy compatibility tests.
3. Convert all producer families together.
4. Add shared presentation, docs, example config, and ROADMAP completion.
5. Run focused tests first, then the complete package/repository gates.

### Technology Decisions

| Decision               | Recommendation             | Rationale                                             |
| ---------------------- | -------------------------- | ----------------------------------------------------- |
| Artifact compatibility | New v3 discriminator       | Strict v2 must keep one exact meaning                 |
| Budget source          | Static config only         | Deterministic, credential-free, reviewable            |
| Enforcement            | Advisory                   | Issue requests warnings, not an override contract     |
| Estimator shape        | One exhaustive pure switch | Smallest safe cross-family design                     |
| Modeling assumptions   | Optional, explicit, sealed | Avoid universal claims from illustrative research     |
| Network/dependencies   | None                       | Existing plan facts and TypeScript primitives suffice |
| CLI/completions        | No new flags               | Policy is durable config; templates remain unchanged  |

### Quick Wins

- Exact zero immediate searches and queries for all current operations
- Exact monitoring/file/byte facts already available in plan entries
- Stable unknown/not-configured/not-recorded states
- Shared structured warning and recommendation output

### Future Enhancements

- Timestamped live Prowlarr observation with a separate trust/staleness model
- Search-producing operations and provider-aware fan-out
- Enforceable cross-stack circuit breakers with audited overrides
- Download/grab/byte estimates after release evidence exists

## Risk Assessment

### Technical Risks

| Risk                             | Likelihood | Impact | Mitigation                                            |
| -------------------------------- | ---------- | ------ | ----------------------------------------------------- |
| v3 union/canonicalization errors | Medium     | High   | Correlated types, exact validators, round-trip tests  |
| Legacy checksum regression       | Low        | High   | Representative frozen v1/v2 fixtures                  |
| Fabricated precision             | Medium     | High   | Horizon/certainty/basis plus explicit unknown         |
| Unsafe arithmetic                | Low        | High   | Bounded integers and checked multiplication           |
| Partial producer migration       | Medium     | Medium | Convert/test every distinct builder path together     |
| Machine/human divergence         | Medium     | Medium | Shared structured plan source and focused parity test |

### Integration Challenges

- The plan engine has parallel v2 families; v3 must preserve operation/entry/summary correlation.
- Apply and resume accept broad stored-plan unions; they must display v3 analysis without
  recomputation and preserve legacy paths.
- Some preview leaves have separate result shapes; they must calculate the same analysis whether
  or not an artifact is written.

### Security Considerations

#### Critical — Hard Stops

| Finding                                     | Risk                                     | Required mitigation                                   |
| ------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Unsealed or semantically unchecked analysis | Review/apply mismatch                    | Strict canonical checksum material plus recomputation |
| Credential/provider data in artifacts       | Secret disclosure and new trust boundary | Numeric static policy only; no new clients            |

#### Warnings — Must Address

| Finding                           | Risk                                 | Mitigation                                       | Alternative                  |
| --------------------------------- | ------------------------------------ | ------------------------------------------------ | ---------------------------- |
| Unsafe arithmetic                 | False verdict/resource abuse         | Safe-integer bounds and overflow checks          | None                         |
| Terminal/machine output injection | Concealed warnings/broken automation | Stable enums, bounded prose, formatter isolation | Omit free text from CSV      |
| Budget wording implies live quota | False confidence                     | Say configured per-plan allowance                | Future timestamped telemetry |

#### Advisories — Best Practices

- Keep SHA-256 described as integrity, not author authentication.
- Store aggregate facts only; avoid indexer names, internal topology, and raw responses.
- Add no new dependency for deterministic arithmetic.

## Task Breakdown Preview

### Phase 1: Contracts and estimator

- Add config/plan contracts.
- Implement the pure exhaustive analyzer and one table-driven critical suite.
- Parallelization: contract drafting and operation-semantics test case inventory can proceed
  independently, then converge before implementation.

### Phase 2: Artifact engine

- Add v3 builders/canonicalization/validation/checksum dispatch.
- Preserve and prove v1/v2 compatibility.
- Depends on Phase 1.

### Phase 3: Producers and presentation

- Convert distinct plan producer families to v3.
- Add shared human/machine projections.
- Parallelization: non-overlapping producer modules and presenter work can proceed after the v3
  engine contract stabilizes.

### Phase 4: Documentation and verification

- Update README, feature guide, example config, ROADMAP, and completion audit.
- Run focused, package, architecture, codegen, typecheck/build, and completion parity gates.
- Depends on Phases 1–3.

## Decisions Needed

All decisions required to proceed are resolved for this implementation:

1. New artifacts use v3; v1/v2 remain legacy-compatible.
2. Budgets and assumptions are config-only, static, per-plan, and sealed.
3. Conditional indexer demand uses an explicit configured queries-per-candidate assumption.
4. Findings are advisory and add no apply override.
5. No Prowlarr integration, dependency, credential, CLI flag, or completion entry is added.
6. All current plan families migrate together.

## Research References

- [research-external.md](./research-external.md): official API constraints and two-horizon model
- [research-business.md](./research-business.md): rules, workflows, metrics, and compatibility
- [research-technical.md](./research-technical.md): v3 architecture and estimator design
- [research-ux.md](./research-ux.md): human/machine presentation and accessibility
- [research-security.md](./research-security.md): integrity, credential, and validation gates
- [research-practices.md](./research-practices.md): reuse, KISS, completions, and critical tests
- [research-recommendations.md](./research-recommendations.md): consolidated phasing and decisions
