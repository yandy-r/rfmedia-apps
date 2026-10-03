# Business Research — Lidarr Cascade Analysis and Downstream Budgets

## Executive Summary

Issue #219 should make every Lidarr mutation plan explain its likely downstream effect before the
operator approves it. The value is not another generic risk label: it is a reviewable answer to
three separate questions:

1. What does this plan directly change in Lidarr?
2. What downstream work can that change trigger now or later?
3. How does the estimated work compare with the operator's configured safety budgets?

The business contract must distinguish immediate, plan-caused work from conditional future
exposure. The current artist-add policy explicitly disables missing-album search, and the existing
monitoring, profile, tag, edit, and delete operations do not enqueue searches. Such plans must
report zero immediate indexer queries rather than multiplying artist or album counts into a
misleading non-zero estimate. Monitoring and profile changes can still alter future RSS, upgrade,
or acquisition behavior; that exposure should be reported as conditional or unknown unless the
plan contains enough evidence to estimate it.

Budget analysis is advisory in issue #219. Exceeding a configured budget must produce a prominent,
stable warning and actionable recommendations, but it must not silently truncate the reviewed
cohort, modify execution policy, or create a new apply blocker. If hard enforcement is desired, it
requires a separately designed authorization and override contract.

The analysis belongs in the checksum-sealed plan artifact and all plan presentations, including
machine output and preview-only/dry-run summaries. It should be deterministic from the reviewed
operation, exact plan entries, declared assumptions, and the plan-time budget snapshot. Unknown
inputs remain unknown; the CLI must never imply that a configured allowance is current Prowlarr
usage or that an album search guarantees a download.

## User Stories

- As a cautious operator, I can see whether a Lidarr plan triggers immediate metadata lookups,
  indexer queries, acquisition attempts, queue work, file deletion, or only local database changes.
- As an operator sharing indexers across Lidarr, Sonarr, and Radarr, I can compare a plan's
  estimated query demand with a configured allowance before consuming shared capacity.
- As an operator managing download capacity, I can see the number of potential acquisition
  candidates separately from indexer queries so searches are not misrepresented as downloads.
- As an operator reviewing a safe artist-add plan, I can see that missing-album search is disabled
  and immediate indexer-query demand is zero, while any future monitoring exposure is labeled
  conditional.
- As an operator reviewing a local-only tag, profile, monitoring, or deletion plan, I can see which
  downstream effects are impossible, which are exact local impacts, and which future effects cannot
  be quantified.
- As an operator with no cascade-budget configuration, I still receive impact estimates and an
  explicit `unconfigured` budget state rather than an invented default allowance.
- As an operator whose plan is large or budget-heavy, I receive specific recommendations such as
  reduce scope, lower `--max-batch`, split the plan, delay execution, or keep search disabled.
- As a reviewer, I can inspect the estimation method, assumptions, confidence, budget snapshot, and
  warning reasons in the saved plan rather than relying only on colored terminal prose.
- As an automation author, I can consume stable JSON/YAML fields and warning codes without parsing
  human sentences.
- As an operator running `lidarr apply --dry-run`, I can revalidate the same sealed plan and see
  its cascade analysis without causing mutation, history writes, indexer queries, or downloads.
- As an operator resuming a partial apply, I can see that budget estimates describe the original
  reviewed scope and are not incorrectly presented as remaining live Prowlarr capacity.

## Business Rules

### Analysis scope and truthfulness

1. Every newly generated Lidarr mutation plan must contain one cascade-analysis section, including
   plans whose estimated downstream work is zero.
2. Analysis is computed after the exact selection, desired operation, no-op classification, and
   operation-specific evidence are known. It must use the changed cohort, not merely the requested
   or matched count, when estimating work caused by apply.
3. Each estimate must identify its time horizon:
   - `immediate`: work directly caused by applying this plan;
   - `conditional`: work possible only after a later event such as RSS processing, a future
     explicit search, or a newly discovered release;
   - `none`: the operation cannot cause that effect within the reviewed contract.

4. Each estimate must identify its evidence quality:
   - `exact`: derived from sealed plan entries or explicit operation policy;
   - `estimated`: arithmetic using disclosed assumptions;
   - `unknown`: the plan lacks enough evidence for a defensible number.

5. Zero and unknown are different business facts. Zero means the operation contract rules out the
   work; unknown means the work may occur but cannot be quantified. Unknown must never be converted
   to zero for budget comparison.
6. Query estimates and acquisition estimates are distinct:
   - an indexer query is a search request or query unit;
   - an acquisition candidate is an album or release that may be searched for;
   - a successful grab or download is not predictable from the current plan.

7. The CLI must not label acquisition candidates as downloads, estimate bytes without a documented
   size model, or claim elapsed time without a configured and disclosed rate assumption.
8. The analysis must state whether the operation contacts Lidarr's upstream metadata provider,
   triggers an explicit search, changes future monitoring policy, preserves existing download-queue
   items, or deletes managed files.
9. Existing queue items remain outside the plan's control unless an operation explicitly manages
   them. Unmonitoring or deleting library records must not imply that queued downloads are
   cancelled.
10. Analysis must be deterministic for identical canonical plan inputs and configuration. Current
    wall-clock usage, health probes, or unsealed external responses must not silently change a
    plan's checksum material.
11. API keys, Prowlarr credentials, provider URLs containing secrets, and raw downstream responses
    must never be stored in the plan or analysis.

### Operation semantics

| Plan operation              | Immediate query/acquisition semantics                                      | Other cascade facts                                                                 |
| --------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `artist-add`                | Zero indexer queries while `searchForMissingAlbums` is sealed `false`      | Metadata lookup/add work may occur; monitored artists have conditional future load  |
| `artist-monitoring`         | No explicit search                                                         | Changes future RSS/upgrade exposure; existing files and queue items remain          |
| `album-monitoring`          | No explicit search                                                         | Changes future acquisition exposure for the changed albums                          |
| `artist-profile-assignment` | No explicit search                                                         | Quality/metadata policy can change future eligible releases or album types          |
| `artist-tag-mutation`       | Zero unless external tag-scoped automation is separately known and modeled | Existing files remain; tag-scoped automation is conditional and normally unknown    |
| `artist-delete`             | No explicit search                                                         | Exact album/file impact comes from plan evidence; queue cancellation is not implied |
| `album-edit`                | No explicit search                                                         | Release-policy eligibility can change future selection behavior                     |
| `album-delete`              | No explicit search                                                         | Exact track-file and byte impact is already sealed when file deletion is enabled    |
| `track-file-filter`         | Zero                                                                       | Exact managed-file deletion candidates and bytes are already sealed                 |

1. An artist-add plan must derive its immediate search estimate from the sealed
   `searchForMissingAlbums` policy. The current accepted value is always `false`, so the correct
   immediate indexer-query and acquisition-search estimates are zero.
2. `monitored: true` on artist add does not itself prove an immediate missing-album search. It
   creates conditional future RSS/upgrade exposure and must be labeled accordingly.
3. Profile assignment must not manufacture an album count from a generic average when the plan
   already has no album inventory or profile capability evidence. It may report a qualitative
   conditional effect or `unknown` numeric exposure.
4. Artist and album monitoring may use the exact number of changed targets as the count of newly
   exposed or newly removed monitored entities, but may not equate that count with indexer queries.
5. Delete and track-file-filter plans should reuse their exact sealed file counts and bytes as
   cascade facts. Those are direct impacts, not downstream acquisition estimates.
6. No-op entries contribute zero newly caused work. They remain reviewable and auditable but do not
   consume the changed-scope estimate.
7. If a future plan operation explicitly enables search, estimation must use the exact number of
   search targets when available. A fallback multiplier such as average albums per artist is
   acceptable only when configured or explicitly versioned and disclosed in the plan.

### Configured budgets

1. Cascade budgets are a distinct product concept from
   `lidarr.scheduler.lanes.<lane>.operationBudget`. Scheduler budgets cap how many CLI operations
   enter a scheduler batch; they do not represent Prowlarr's rolling allowance, provider quota,
   acquisition candidates, downloads, or bytes.
2. Budget configuration must use explicit units. At minimum, the product needs separate optional
   allowances for:
   - indexer query units per reviewed plan or declared time window;
   - acquisition candidates per reviewed plan.

3. A missing budget is `unconfigured`, not unlimited and not zero.
4. An estimate with unknown quantity produces budget state `unknown`, even when a numeric budget is
   configured.
5. A configured allowance is operator policy. Unless the CLI actually queries and seals
   authoritative live usage, it must not be called "remaining Prowlarr budget" or a "rolling
   24-hour balance."
6. Budget comparison uses the same unit and horizon as the estimate. Comparing per-plan demand with
   a daily provider quota requires an explicit current-usage input; otherwise only total demand
   versus configured per-plan allowance is valid.
7. The research recommendation to warn when a plan consumes more than 50% of remaining query
   budget is useful only when "remaining" is authoritative. For static per-plan allowances, a
   reasonable default warning policy is:
   - `within`: estimate is at or below 50% of the configured allowance;
   - `elevated`: estimate is above 50% and at or below 100%;
   - `exceeded`: estimate is above 100%;
   - `unknown`: quantity cannot be compared;
   - `unconfigured`: no allowance exists.

8. Exact boundary behavior must be stable: 50% is `within`; 100% is `elevated`; only greater than
   100% is `exceeded`.
9. Budgets must be positive bounded integers. Ratios should be derived, not configured as floating
   point values.
10. The plan must seal the budget value and comparison result used during review. Later config
    edits must not reinterpret or corrupt the saved review record.
11. Budget comparison must never change plan selection, discard entries, lower a reviewed operation
    cap, or alter apply ordering. A recommendation may tell the operator how to generate a smaller
    replacement plan.
12. If live Prowlarr usage is added later, the plan must separately record provider capacity,
    observed usage, observation timestamp, and provenance. Failure to read Prowlarr must degrade to
    an explicit unavailable state rather than blocking safe local-only planning.

### Warnings and recommendations

1. Warnings require stable machine codes, severity, the affected metric, estimated quantity,
   configured allowance when present, and a concise explanation.
2. At minimum, the analysis should support:
   - elevated budget consumption;
   - configured budget exceeded;
   - quantity unknown;
   - budget unconfigured;
   - conditional future exposure;
   - unusually broad changed scope.

3. Human output must place exceeded-budget warnings adjacent to the cascade summary, not bury them
   among verbose per-entry rows.
4. Warnings are additive to the existing operation risk summary. They do not replace `risk.level`,
   `risk.destructive`, or the operation-owned cascade facts already used by review and approval.
5. Recommendations must be derived from facts and expressed as operator choices:
   - reduce exact IDs or tighten filters;
   - lower `--max-batch` and create several independently reviewed plans;
   - keep missing-album search disabled;
   - delay an explicitly search-triggering operation until provider capacity is available;
   - use `apply --dry-run` to revalidate live Lidarr state;
   - regenerate the plan if inputs, budget policy, or desired scope changed.

6. The CLI must not recommend `--resume` for a plan that has never been applied, or imply that
   resume recalculates the original budget estimate.
7. A budget warning must not promise that batching reduces total queries. Batching reduces peak
   load and improves control; total estimated demand remains unless scope or operation policy
   changes.
8. Recommendations must not suggest a force/override flag that does not exist.
9. Machine output must expose warnings and recommendations as data, while human output may render
   concise sentences from those stable values.

### Plan, apply, and compatibility rules

1. Cascade analysis must be checksum material in newly produced plans so the reviewed estimates,
   assumptions, and budget warnings cannot be edited independently of the plan.
2. Exact-key parsing and canonicalization must validate all new fields, bounds, enum values, and
   internal arithmetic relationships. Malformed or self-contradictory analysis fails closed.
3. Existing valid v1 and v2 artifacts must remain readable and applicable. The design must use a
   compatible versioned plan shape or explicitly support analysis-absent legacy artifacts.
4. Legacy plans without analysis should be labeled `not-recorded`; apply must not synthesize plan
   time estimates and present them as reviewed facts.
5. Planning remains read-only. Computing cascade analysis must not call mutation endpoints, enqueue
   Lidarr commands, consume indexer queries, or trigger acquisitions.
6. Preview-only plan modes must calculate and render the same analysis as an artifact-writing plan,
   but must not write an artifact.
7. `lidarr apply --dry-run` must render or return the sealed analysis and perform the existing
   artifact, origin, resource, history, and fresh-state validation without history or mutation.
8. Real apply keeps the current explicit approval, destructive authorization, checksum, origin,
   exclusive-claim, drift, durable-history, and resume boundaries. Advisory budget state alone does
   not bypass or add to those authorizations.
9. JSON and YAML should expose the structured analysis unchanged. CSV requires a documented flat
   projection for the aggregate metrics and highest warning state; no data should be inferred by
   parsing the human risk strings.
10. Analysis must be rendered consistently for every plan producer, including the parallel
    artist-add, album-mutation, and track-file-filter plan families, rather than only the original
    artist-monitoring command.

## Estimation Semantics

### Recommended metric model

| Metric                     | Meaning                                                        | Typical evidence                         |
| -------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| Changed targets            | Entries whose desired state differs from reviewed before state | Exact plan review                        |
| Metadata lookups           | Upstream metadata-dependent calls directly caused by apply     | Operation policy; exact or estimated     |
| Indexer queries            | Search requests directly caused by apply                       | Explicit search targets; exact/estimated |
| Acquisition candidates     | Albums/releases eligible to be searched                        | Album inventory or disclosed multiplier  |
| Newly monitored entities   | Artists/albums entering monitored state                        | Exact before/after entries               |
| Removed monitored entities | Artists/albums leaving monitored state                         | Exact before/after entries               |
| Managed files affected     | Files retained or deleted by reviewed mutation                 | Exact deletion/filter evidence           |
| Bytes affected             | On-disk bytes directly deleted                                 | Exact deletion/filter evidence           |

Every numeric estimate should carry:

- `quantity`: a non-negative safe integer when known;
- `certainty`: `exact`, `estimated`, or `unknown`;
- `horizon`: `immediate`, `conditional`, or `none`;
- `basis`: a stable method code plus disclosed inputs;
- `budget`: optional configured allowance and comparison state.

### Arithmetic

1. Exact arithmetic should be preferred:

   ```text
   changed = review.changed
   newlyMonitored = count(before.monitored = false and after.monitored = true)
   unmonitored = count(before.monitored = true and after.monitored = false)
   ```

2. A search-triggering album plan can estimate one query unit per exact search target only if that
   is the documented operation behavior.
3. A search-triggering artist plan may use:

   ```text
   acquisitionCandidates = changedArtists * configuredAverageAlbumsPerArtist
   indexerQueries = acquisitionCandidates * configuredQueriesPerCandidate
   ```

   only when both multipliers are versioned, bounded, disclosed assumptions. The research example
   of 20 albums per artist is illustrative evidence, not an authoritative universal default.

4. Percent consumption is:

   ```text
   floor-or-rounding-policy(estimate / allowance * 100)
   ```

   The implementation must choose and document one stable integer rounding rule. Warning
   classification should compare integer quantities directly to avoid rounding changing a
   boundary.

5. Overflow, non-finite arithmetic, or a result above the artifact's accepted numeric bound must
   fail planning rather than clamp or wrap the estimate.

## Workflows

### Generate and review a plan

1. Parse the command, selection, desired operation, `maxBatch`, output options, and Lidarr
   connection overrides.
2. Resolve a fresh Lidarr snapshot and freeze the exact bounded cohort using the existing
   operation-specific planner.
3. Compute changed/no-op entries and exact operation summary.
4. Classify immediate and conditional cascade effects from the sealed operation policy.
5. Compute defensible exact estimates, then estimated values only where configured assumptions
   exist; retain unknowns otherwise.
6. Compare known quantities with the plan-time budget configuration.
7. Generate stable warnings and recommendations.
8. Render the review and cascade summary. In preview-only mode, stop without writing.
9. Seal the structured analysis into the plan checksum and atomically write the artifact.

### Validate with apply dry-run

1. Read and strictly validate the artifact, checksum, operation, cascade analysis, and optional
   legacy status.
2. Verify target origin, referenced resources, prior history/resume state, and fresh target state
   through the existing apply preflight.
3. Return per-entry `would-apply`, `satisfied`, `blocked-stale`, or other existing outcomes.
4. Return the sealed plan-time cascade analysis unchanged and label it as plan-time analysis.
5. Perform no Lidarr mutation, history write, deferred replay, indexer query, or acquisition.

### Apply or recover

1. Apply retains current approval and operation-specific destructive authorization.
2. An advisory exceeded-budget warning remains visible but does not mutate the reviewed plan or
   create a hidden force requirement.
3. Execution and durable history continue per entry under the exclusive claim.
4. A partial or interrupted run preserves its normal `partial`, `failed`, `deferred`, `uncertain`,
   and `not-attempted` evidence.
5. `--resume` skips durable successes and continues incomplete work under existing rules.
6. The original estimate remains a scope-level review record. The result may show completed versus
   remaining changed entries, but must not claim that the original provider budget remains
   available.
7. If the operator changes scope, assumptions, or budget policy after a failure, they should
   generate a new plan rather than editing or reinterpreting the sealed artifact.

## Error and Degradation Rules

- Invalid cascade configuration fails config loading with the exact property path, consistent with
  existing strict Lidarr scheduler configuration.
- Arithmetic or internal consistency failures fail planning before an artifact is written.
- Unknown estimation inputs yield structured unknown metrics and recommendations; they are not
  exceptional failures.
- Missing budget configuration yields `unconfigured`, not a warning that the operation is unsafe.
- Failure of an optional future Prowlarr usage lookup yields `unavailable` provenance and falls back
  to configured static policy. It must not prevent zero-query local-only plans.
- An artifact whose analysis was edited, contains unknown keys, violates bounds, or disagrees with
  canonical operation facts fails checksum or validation before apply.
- A legacy artifact without analysis remains usable under its original safety contract and is
  clearly reported as having no recorded analysis.
- Apply-time Lidarr drift, missing resources, interruption, remote failure, history failure, and
  resume continue to use their current outcomes. Cascade warnings must not collapse those
  operational states into generic warning text.

## Domain Model

| Entity                 | Business meaning                                       | Key state                                                             |
| ---------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| Mutation plan          | Sealed operator-reviewed desired state                 | Version, origin, operation, entries, review, risk, analysis, checksum |
| Cascade analysis       | Plan-time model of direct and downstream effects       | Metrics, assumptions, warnings, recommendations, analysis version     |
| Cascade metric         | One countable class of downstream work or impact       | Kind, quantity, certainty, horizon, basis                             |
| Estimate basis         | Reproducible explanation of how a quantity was derived | Method code, exact counts, configured multipliers                     |
| Budget policy          | Operator-configured advisory allowance                 | Metric, quantity, unit, optional declared horizon                     |
| Budget snapshot        | Exact policy used to review this plan                  | Allowance, comparison state, ratio/consumption                        |
| Warning                | Stable review concern derived from analysis            | Code, severity, metric, message                                       |
| Recommendation         | Non-mutating next action offered to the operator       | Code, rationale, applicable command/workflow                          |
| Legacy-analysis status | Evidence that an older plan predates this feature      | `not-recorded`                                                        |
| Apply result           | Live validation and execution outcome                  | Existing status, entry outcomes, plan-time analysis reference         |

Analysis state transitions are:

```text
selection resolved
  -> exact operation facts
  -> exact | estimated | unknown metric
  -> within | elevated | exceeded | unknown | unconfigured budget state
  -> warning/recommendation set
  -> checksum-sealed plan-time analysis
  -> rendered during review
  -> re-rendered unchanged during apply dry-run/real apply/resume
```

Plan/apply entry state transitions remain unchanged:

```text
selected -> unchanged
selected -> ready -> would-apply
selected -> ready -> succeeded | failed | deferred | uncertain
selected -> satisfied | blocked-stale | not-attempted
durable terminal history -> skipped-resume
```

Cascade-analysis warnings are review metadata and do not introduce an entry execution state.

## Existing Codebase Integration

- `packages/rfmedia-cli/src/types/lidarr-plan.ts` owns every versioned plan family, the existing
  `LidarrPlanRiskSummary`, review summaries, operation summaries, apply outcomes, and the strict
  artifact bounds. The new analysis should be structured alongside, not encoded as additional
  prose in `risk.cascade`.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` owns canonicalization, checksums, exact-key
  validation, artifact storage, history, claims, and compatibility. It must either validate an
  analysis-bearing compatible plan shape or route a new version without breaking v1/v2 artifacts.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts` already states operation-owned
  cascade facts. These facts are the source for categorical effects; the new analysis adds
  quantities, certainty, horizons, budgets, warnings, and recommendations.
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts` and
  `plan-track-filter-operations.ts` own parallel album and file-filter plan families. Any
  "all Lidarr plans" contract must include these families.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts` is only the exact-ID artist-monitoring planner.
  Other producers include artist profile/tag/delete/add, album monitoring/edit/delete, and track
  filtering actions. Integration only in `plan.ts` would leave much of the product inconsistent.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`,
  `commands/lidarr-albums.ts`, and `commands/lidarr-track-filter.ts` render different plan families.
  Human and machine projections need one shared analysis vocabulary.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` already enforces artifact validation, expected
  plan ID/checksum, origin, explicit approval, destructive authorizations, live preflight, claim
  ownership, durable history, dry-run, partial outcomes, and resume. Cascade budgets should not
  duplicate or weaken these controls.
- `packages/rfmedia-cli/src/types/config.ts`, `lib/config.ts`, and `rfmedia.example.yaml` contain
  strict Lidarr configuration. The existing scheduler `operationBudget` must remain semantically
  separate from new downstream-impact budgets.
- The artist-add operation currently seals `searchForMissingAlbums: false` and
  `monitorNewItems: "none"`. That is authoritative evidence of zero immediate missing-album search
  demand and must outweigh the research document's hypothetical search-enabled example.
- Current default plan bounds are 25 targets, a hard `maxBatch` of 1,000, at most 1,000 entries,
  and at most 25 artist-add entries. Recommendations should use those existing caps rather than
  inventing unimplemented execution throttles.

## Measurable Success Criteria

1. Every newly generated supported Lidarr plan family contains validated structured cascade
   analysis or the design explicitly documents a narrower issue scope.
2. A current safe artist-add plan reports exactly zero immediate missing-album searches and indexer
   queries, while monitored adds disclose conditional future exposure.
3. Local-only tag operations and no-op entries report zero immediate indexer/acquisition work.
4. Monitoring and profile changes never equate target counts with guaranteed queries or downloads.
5. File-deleting artist, album, and track-filter plans reuse exact file counts/bytes and do not
   relabel those values as download estimates.
6. Known estimates compare deterministically with configured allowances at 50% and 100% boundaries;
   unknown and unconfigured cases are distinguishable.
7. Exceeded budgets produce a stable warning and at least one actionable recommendation, without
   truncating scope or blocking apply.
8. Preview-only planning and `apply --dry-run` perform zero mutation, history, indexer, and download
   side effects while exposing the same sealed analysis.
9. JSON/YAML contain structured metrics, budget states, warnings, and recommendations; CSV exposes
   a documented aggregate projection.
10. Existing v1/v2 plans without analysis still validate and apply under their prior contract, with
    analysis clearly marked `not-recorded`.
11. Editing analysis or assumptions in a new artifact invalidates its checksum or exact validation.
12. Scheduler `operationBudget` is never shown as Prowlarr/indexer budget.
13. Sensitive configuration and API credentials do not appear in plan artifacts, diagnostics,
    history, or machine output.
14. Focused tests cover the critical semantic matrix: zero versus unknown, exact versus estimated,
    changed versus no-op counts, budget boundaries, checksum validation, legacy compatibility, and
    one shared presenter path. Broad per-operation duplication is unnecessary where a table-driven
    contract proves identical behavior.

## Open Questions

1. Does issue #219 cover every current Lidarr plan family, or only artist monitoring/add plans?
   The issue's affected paths predate the current parallel album and track-filter planners.
2. What exact configuration vocabulary should be public: `lidarr.cascadeAnalysis`,
   `lidarr.budgets`, or another nested section?
3. Are allowances per plan, per apply invocation, or tied to a declared rolling time window?
4. Is the first release intentionally static/config-only, or must it integrate with Prowlarr to
   observe current provider usage? The latter materially expands credentials, facade, failure, and
   freshness scope.
5. Which metrics receive budgets in the first release: indexer queries only, queries plus
   acquisition candidates, or also metadata lookups/files/bytes?
6. Should an elevated threshold default to 50% of the configured allowance, be configurable, or be
   omitted until authoritative remaining-usage data exists?
7. Is budget exceedance strictly advisory, as the issue wording suggests, or should a future hard
   gate require an explicit override? A hard gate needs a separate sealed authorization model.
8. What stable numeric bound should cascade quantities use when they can exceed the current
   1,000-entry plan cap through multipliers?
9. Which rounding policy should human percent consumption use?
10. May average albums per artist and queries per acquisition candidate have built-in defaults, or
    must operators configure them? Truthful first-release behavior favors unknown over an
    undocumented universal average.
11. Should apply dry-run merely display the sealed plan-time budget snapshot, or optionally compare
    against fresh live capacity as a separate unsealed observation?
12. Does changing cascade-budget configuration make an old plan stale, or is regeneration only a
    recommendation? Preserving checksum review semantics favors keeping the sealed snapshot valid.
13. Should legacy plans display no analysis at all or a structured `not-recorded` placeholder in
    machine output?
14. Which existing plan versioning strategy best preserves exact-key validation while allowing the
    new checksum field across artist, artist-add, album, and track-filter plan families?

## Source Evidence

- GitHub issue #219 requires query/acquisition estimates, budget warnings, recommendations, plan
  artifacts, and dry-run summaries.
- `research/rfmedia-lidarr-integration/persona-findings/systems-thinker.md` documents the shared
  Prowlarr/indexer blast radius, non-linear artist-to-album expansion, queue persistence after
  unmonitoring, and the need for progressive disclosure.
- `research/rfmedia-lidarr-integration/synthesis/innovation.md` proposes serializable plan-time
  cascade analysis and warns above 50% of remaining Prowlarr budget, while clearly using a
  hypothetical search-enabled artist-add example.
- `research/rfmedia-lidarr-integration/report.md` distinguishes local-only profile/tag/monitoring
  operations from artist adds with search enabled and recommends safe defaults.
- Current plan/apply types, operation definitions, presenters, configuration, and apply
  orchestration provide the authoritative shipped behavior where the older research is
  hypothetical.
