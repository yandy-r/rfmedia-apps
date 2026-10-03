# Lidarr Cascade Analysis — Consolidated Recommendations

## Executive Summary

Implement issue #219 as a pure, deterministic analysis layer over the exact Lidarr mutation plan
already assembled for review. Every newly generated Lidarr plan family should include structured
cascade estimates, the static budget policy used for comparison, stable warnings, and
recommendations. The complete analysis must be canonical, strictly validated, and covered by the
plan checksum.

Use a new `rfmedia.lidarr-plan.v3` discriminator. Do not add an optional field to v2: existing
readers intentionally reject unknown keys, so an analysis-bearing artifact labeled v2 would change
the exact v2 schema while being unreadable by old v2 consumers. New readers should retain
byte-for-byte validation and apply compatibility for v1 and v2; legacy plans report analysis as
`not-recorded` and are never retroactively reinterpreted.

The first release should be local and advisory:

- use bounded, static configuration only;
- add no Prowlarr, indexer, download-client, or new Lidarr requests;
- add no dependency, SDK, credential, or API surface;
- add no CLI flags, commands, or completion entries;
- warn without truncating, reordering, blocking, or weakening existing apply authorization; and
- cover the critical contracts with focused, mostly table-driven tests.

All current plan operations cause zero immediate explicit searches and indexer queries. In
particular, artist-add seals `searchForMissingAlbums: false`. Monitoring and policy changes may
alter conditional future acquisition exposure, but they must not be described as immediate
queries, guaranteed grabs, downloads, bytes, or elapsed time.

## Implementation Recommendations

### Phase 1 — Contracts and pure analysis

1. Add v3 plan-family types and a versioned `cascadeAnalysis` contract.
2. Represent each estimate with a metric, value or explicit unknown, confidence, horizon, unit, and
   stable basis code.
3. Keep immediate work separate from conditional future exposure.
4. Add a single exhaustive `analyzeLidarrCascade()` function that consumes canonical plan facts and
   resolved policy; it must perform no I/O and read no ambient configuration.
5. Use safe-integer arithmetic, bounded strings/arrays, deterministic metric ordering, and
   deterministic warning/recommendation derivation.

Recommended first-release metrics:

| Metric                           | Rule                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Immediate indexer queries        | Exact zero for every current operation                                                                            |
| Acquisition candidates           | Exact when sealed album facts prove a count; modelled only from a sealed, disclosed assumption; otherwise unknown |
| Newly/removed monitored entities | Exact from changed before/after entries                                                                           |
| Files and bytes affected         | Reuse existing exact deletion evidence; do not relabel as downloads                                               |

No-op entries contribute zero newly caused work. `0` and `unknown` are distinct and must remain
distinct in artifacts and all output formats.

### Phase 2 — v3 sealing and compatibility

1. Add v3 builders for ordinary artist, artist-add, album mutation, and track-file-filter families.
2. Canonicalize `cascadeAnalysis` before `payloadChecksum`.
3. Require analysis on v3; preserve existing v1/v2 canonicalization and checksums unchanged.
4. Extend exact-key parsing and bounds checks to every nested analysis object.
5. Recompute expected analysis from canonical plan facts plus sealed assumptions and limits during
   v3 validation; reject semantically inconsistent but re-checksummed artifacts.
6. Make all new writers emit v3 in one change. Do not partially adopt v3 by operation family.

Apply, apply dry-run, and resume must display the sealed plan-time analysis unchanged. They must not
compare the artifact with current config or synthesize analysis for a legacy plan.

### Phase 3 — Static configuration and presentation

Add an allowlisted `lidarr.cascadeAnalysis` configuration section with separate optional positive,
bounded safe-integer per-plan allowances for:

- indexer queries; and
- acquisition candidates.

Omission means `not-configured`, never zero, unlimited, or live remaining capacity. Keep this
separate from scheduler `operationBudget`, which limits CLI batching rather than downstream usage.
Seal resolved allowances, units, horizon, and provenance such as `configured-per-plan`.

Budget assessments should be `not-configured`, `within`, `exceeded`, or `unknown`. Equality is
within; only a projected value greater than the allowance is exceeded. An unknown quantity remains
unknown even when a limit exists.

Exceeded and incomplete assessments produce stable, prominent warnings and deterministic
recommendations such as reduce scope, split into independently reviewed plans, or delay apply.
Warnings are advisory: they do not change exit status, artifact creation, selected entries,
execution order, confirmation, destructive authorization, drift checks, or resume behavior.
Batching should be described as reducing peak load and improving control, not total demand.

Use one shared renderer/projector for every plan family. Human output should place cascade analysis
and warnings after existing risk information and before entry tables. JSON/YAML should expose the
complete structured object; CSV should provide a documented aggregate projection without free-form
text. Machine stdout must remain isolated from human diagnostics.

### Phase 4 — Documentation and verification

Document the config schema, per-plan semantics, certainty/horizon vocabulary, limitations, legacy
behavior, and an example in the CLI README, feature guide, and example config. Record completion
evidence in `ROADMAP.md`.

Run focused tests, the complete rfmedia-cli suite, typecheck/build/lint, architecture/codegen
suites, and the existing Bash/Zsh/Fish completion parity test. No completion template changes are
expected because the CLI surface is unchanged.

## Quick Wins and Future Work

### Quick wins for issue #219

- Report exact zero immediate searches/queries for all current operations.
- Surface exact changed/no-op and monitoring transition counts already present in plans.
- Reuse sealed file-count and byte evidence for destructive operations.
- Add stable `not-recorded`, `not-configured`, and `unknown` states.
- Show a compact advisory warning when a known projection exceeds its configured allowance.
- Preserve identical analysis between preview, sealed-plan review, and apply dry-run.

### Explicit future work

- Live, timestamped Prowlarr usage/headroom observation with a separate credential and trust model.
- Search-producing Lidarr operations and indexer-fanout models.
- Enforceable circuit breakers with explicit audited override authorization.
- Time-window budgets, shared-stack accounting, retry/rate-limit handling, and staleness rules.
- Download/grab/byte estimates after release evidence exists.
- Artifact signing for multi-user exchange; SHA-256 remains integrity, not author authentication.

None of these are prerequisites for the static advisory feature.

## Risk Assessment

| Risk                                      | Consequence                                             | Mitigation                                                                |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Optional analysis added to v2             | Same discriminator describes incompatible exact schemas | Emit v3; keep v1/v2 read/apply-only                                       |
| Analysis outside checksum                 | Review can differ from apply evidence                   | Canonicalize and seal the full analysis                                   |
| Fabricated certainty                      | Operators mistake monitoring for searches/downloads     | Separate immediate/conditional horizons and zero/unknown states           |
| Static allowance called remaining quota   | False confidence about shared live capacity             | Say configured per-plan allowance and seal provenance                     |
| Unsafe arithmetic or contradictory fields | False budget verdict or resource abuse                  | Bounds, overflow checks, exact keys, semantic recomputation               |
| Raw remote/config text in output          | Secret leakage or terminal manipulation                 | Stable enums/basis codes; existing terminal/sensitive-key validation      |
| Warning changes execution                 | Hidden policy or weakened authorization                 | Keep warnings advisory and preserve every apply gate                      |
| Partial producer adoption                 | Plan semantics vary by operation                        | Convert every builder/action to v3 together                               |
| Human/machine divergence                  | Automation sees different evidence                      | Shared renderer/projector and structured output                           |
| Excessive test expansion                  | Slow, brittle suite with duplicated assertions          | Test arithmetic once, boundaries once, and each distinct integration path |

## Alternatives Considered

| Alternative                                    | Decision                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Optional sealed field in v2                    | Reject. It violates the meaning of the strict v2 discriminator and old-reader compatibility. |
| Put estimates in `risk.cascade` prose          | Reject. It lacks typed quantities, certainty, budgets, and machine stability.                |
| Compute analysis only while rendering/applying | Reject. It is mutable, unreviewed evidence and can drift with config.                        |
| Query Prowlarr/download clients now            | Defer. It adds credentials, network failure, stale evidence, retries, and privacy risk.      |
| Block over-budget plans                        | Defer. Enforcement needs authoritative usage and an explicit override contract.              |
| Add per-command estimators or rules framework  | Reject. One exhaustive pure switch is simpler and safer.                                     |
| Add CLI budget overrides                       | Reject for v1. Durable config avoids duplicated flags and completion churn.                  |
| Add a statistics/schema dependency             | Reject. Existing TypeScript primitives and validators are sufficient.                        |

## Task Breakdown and Dependencies

1. **Types/config:** define v3, analysis contracts, and strict config options.
2. **Analyzer:** implement pure operation semantics and focused table tests; depends on task 1.
3. **Artifact engine:** add v3 builders, canonicalization, validation, checksums, and legacy tests;
   depends on tasks 1–2.
4. **Plan producers:** pass resolved config to every distinct builder and emit v3; depends on task 3.
5. **Presentation:** shared human and machine projections, including legacy state; depends on task 3.
6. **Docs/example/ROADMAP:** document the final public contract; depends on tasks 1 and 5.
7. **Verification:** run focused and repository-wide gates; depends on all implementation tasks.

Critical tests only:

- one estimator table covering every operation, no-op behavior, exact/modelled/unknown, equality,
  exceedance, stable ordering, and overflow;
- v3 round trip, checksum tampering, semantic inconsistency, and representative unchanged v1/v2;
- one valid config plus a parameterized invalid-config matrix;
- assertions that each distinct producer path emits v3 analysis;
- one human warning and JSON/YAML/CSV parity test, including secret/non-color isolation; and
- the unchanged Bash/Zsh/Fish completion parity suite.

## Decisions and Open Questions

Decisions:

- v3 is mandatory for new artifacts; v1/v2 remain compatible legacy inputs.
- Analysis is deterministic, checksum-sealed, config-only, and advisory.
- There are no new network calls, dependencies, credentials, CLI flags, or completion entries.
- Immediate searches and indexer queries are exact zero for the current operation set.
- Budgets are per-plan configured allowances, not provider quota or remaining capacity.
- Existing mutation risk and authorization remain independent of cascade warnings.
- All plan families adopt the feature together.

Open questions to settle before coding:

1. Should artist-level future acquisition modeling require an explicit `albumsPerArtist` setting,
   or use a documented bounded default? Prefer explicit configuration; otherwise report unknown.
2. Should the first public model expose only `within`/`exceeded`, or also a deterministic advisory
   `elevated` state above 50%? Omit `elevated` unless product requirements explicitly need it.
3. Should unconfigured budgets emit an informational code or only a visible state? Prefer a stable
   informational state with no warning or apply effect.
4. Which aggregate CSV columns are required beyond values, confidence, budget status/limit, and
   highest warning code?
