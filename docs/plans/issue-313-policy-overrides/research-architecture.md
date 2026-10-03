# Architecture Research: issue-313-policy-overrides

## System Overview

The relevant system is a layered TypeScript CLI: Commander loads and validates shared configuration,
an impure Lidarr action gathers evidence, the synchronous bridge policy engine produces a frozen
report, and command presenters or downstream projectors consume that report. Policy overrides fit at
two narrow seams: strict configuration selection in the root `preAction` hook, then one pure
post-cap classification pass inside `runLidarrPolicyEvaluation()` before report counts and arrays are
frozen.

The central architectural invariant is that `PolicyEvaluationReport.proposals` is the only actionable
cohort. Both `policy plan` and `sync-ratings` already project that collection, so removing active and
stale override matches there prevents producer, artifact, prompt, and apply work without duplicating
matching logic downstream.

## Relevant Components

- `/packages/rfmedia-cli/src/cli.ts`: Root Commander program and `preAction` hook; loads config once,
  stores it in module state, and is the earliest shared point that can select strict loading for
  `lidarr policy evaluate`, `lidarr policy plan`, and `lidarr sync-ratings`.
- `/packages/rfmedia-cli/src/lib/config.ts`: Ordered YAML/JSON search, secrets expansion,
  `CORE_SCHEMA` parsing, config validation, and cache integration. Current behavior warns and
  continues after parse, validation, and read errors, so it is fail-open for durable suppressions.
- `/packages/rfmedia-cli/src/lib/loaded-config.ts`: Process-wide validated config handoff. The policy
  evaluator and sync-ratings both read the same `loadedConfig.policy` through
  `getLoadedPolicyConfig()`.
- `/packages/rfmedia-cli/src/types/config.ts`: Input contract for `PolicyConfigOptions`; this is where
  the read-only `policy.overrides` map and entry type belong.
- `/packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: Read-oriented orchestration edge. It
  resolves the selected rules and Plex library from loaded policy config, gathers only required or
  enriching signals, and passes config, origins, scope, signals, and CLI overrides to the pure
  engine.
- `/packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: Policy composition root. It resolves
  defaults, gates and runs all registered rules, applies per-rule caps, attributes universal
  refusals, orders decisions, computes counts/status, and freezes the final report. This is the sole
  correct owner of override classification and actionable filtering.
- `/packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts`: Sole proposal/skip construction
  helpers and stable decision-key grammar. Proposal keys have three segments; skip keys append a
  fourth skip-code segment, which is why override validation must accept proposal keys only while
  classification may correlate a later skip by rule and subject anchor.
- `/packages/rfmedia-cli/src/types/lidarr-policy.ts`: Shared evaluation contract and public version
  constants. `PolicyEvaluationReport` v1 currently contains only rules, proposals, skips, summary,
  signals, and coverage; overrides require a v2 contract while preserving the file's zero-value-
  import rule.
- `/packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: Shared human evaluation/explain
  renderer and flat CSV projector. Policy evaluate, policy plan CSV, and sync-ratings CSV all reuse
  this module, making it the primary presentation seam for override rows and full fingerprints.
- `/packages/rfmedia-cli/src/commands/lidarr-policy.ts`: Owns evaluate/plan option validation, machine
  envelopes, human dispatch, and exit codes. Its `policyDecisionKeys()`-based explain validation must
  include configured override keys, including withheld proposals no longer present in
  `report.proposals`.
- `/packages/rfmedia-cli/src/lib/bridge/policy-plan.ts`: Pure projector that iterates only
  `report.proposals`, validates producer/identity/target invariants, and accounts every actionable
  proposal as a cohort change or refusal.
- `/packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts`: Evaluates once, projects once, and only in
  `mode: plan` invokes the unchanged profile/monitoring plan producers. An empty actionable report
  reaches the existing `no-changes` branch before any producer runs.
- `/packages/rfmedia-cli/src/lib/bridge/rating-sync.ts`: Pure rating-sync projector. It filters
  `report.proposals` by the two bound rule ids before creating sealable cohorts, so engine-level
  withholding automatically governs this path.
- `/packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`: Reads raw rule enablement, force-enables
  only unset selected rules, invokes the same evaluator, projects its report, then walks the
  recommend -> plan -> apply ladder. Only sealable cohorts reach plan producers or guarded apply.
- `/packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts`: Human sync view and delegated
  `--explain` support. It does not render the complete embedded evaluation today, so it needs an
  explicit shared override section or equivalent call to avoid hiding withheld-only outcomes.
- `/packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Static ownership guard for network
  and Lidarr mutation calls. The new bridge module should remain pure and require no allowlist
  expansion.

## Data Flow

```text
.rfmedia.yaml / higher-precedence config candidate
  -> cli.ts preAction selects strict load for three sensitive command paths
  -> config.ts parses, validates policy.overrides, and fails on the first existing invalid file
  -> loaded-config.ts stores one validated ConfigFile
  -> policy-evaluate action reads policy config, resolves gather scope, gathers evidence
  -> policy-engine resolves defaults and runs rules
  -> per-rule cohort caps and skip bounds are applied
  -> proposals, skips, rule outcomes, origins, library, and overrides enter one pure classifier
       -> unmatched proposals remain actionable
       -> exact fingerprint matches become suppressed and are withheld
       -> changed evidence/outcome/absence becomes stale and is withheld
       -> disabled, deselected, or blocked rules classify records as not-evaluated
  -> engine rebuilds per-rule proposal counts, summary/status, and freezes report v2
  -> presenters expose proposal, skip, and override evidence
  -> policy-plan and rating-sync project only report.proposals
       -> zero actionable proposals means no producer cohort
       -> otherwise unchanged producers seal strict-v3 artifacts
       -> only sync-ratings mode apply can enter the existing guarded apply action
```

The insertion point in `policy-engine.ts` is after `applyEngineBounds()` has populated the aggregate
proposal/skip arrays and after rule outcomes are known, but before `frozenRules`,
`frozenProposals`, summary/status calculation, and the final report literal. This preserves existing
cap ranking and deliberately does not refill a capped cohort after a suppression. The classifier
also has all data needed to distinguish `outcome-changed`, `decision-absent`, and `not-evaluated`
without asking presenters or consumers to infer engine state.

## Integration Points

- Add strict-load selection at the root hook, not inside individual actions. Determining sensitivity
  from the `actionCommand` ancestry keeps all three paths fail-closed before evidence gathering,
  lazy action imports, plan sealing, prompts, or mutation. Other commands retain existing fallback
  behavior.
- Extend `loadConfig()` with an explicit strict/fail-on-invalid option. In strict mode the first
  existing candidate is authoritative: read, parse, secret/template, or `ConfigError` failure must
  escape instead of continuing. Cache behavior and tests must preserve the selected mode's
  semantics rather than accidentally returning a result created under different assumptions.
- Add `/packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts` as a pure indexed bridge module. It
  should own canonical evidence projection/fingerprinting, key-plus-fingerprint matching, stale
  classification, actionable filtering, deterministic ordering, and frozen result construction;
  it must import no client, adapter, plan writer, scheduler, or database.
- Pass raw validated overrides through the existing `PolicyConfigOptions` already captured by
  `executeLidarrPolicyEvaluate()`. No new CLI option or parallel config reader is needed.
- Evolve only the embedded evaluation contract to policy v2. Keep policy-plan v1, sync-ratings v1,
  and strict Lidarr plan v3 unchanged because their outer lifecycle and artifact shapes do not
  change; they embed or derive from the new evaluation report.
- Update shared presenter key discovery and explain rendering so a suppressed/stale override remains
  addressable after its proposal is removed from the actionable array. JSON/YAML inherit the full
  v2 report automatically; CSV needs fixed summary/fingerprint/override columns and override rows.
- Call the shared override renderer from all human surfaces that currently show only selected
  evaluation sections: full policy evaluation, policy-plan review, and sync-ratings review. This is
  necessary for withheld-only runs, which otherwise look like unexplained `NO CHANGES`.
- Keep the downstream projectors unchanged in responsibility. Focused tests should prove their
  existing iteration over `report.proposals` receives no suppressed/stale records, and action tests
  should prove a withheld-only report never calls plan producers, confirmation, or apply.

## Architectural Patterns

- **Functional core, imperative shell:** Evidence gathering and producer/apply orchestration live in
  actions; rule evaluation, override classification, and proposal projection stay pure and
  synchronous in `lib/bridge`.
- **Single actionable collection:** Downstream mutation authority is derived from
  `PolicyEvaluationReport.proposals`, never presenter state or config re-reading.
- **Typed frozen reports:** Engine and projector outputs are immutable discriminated contracts;
  configuration validation injects no defaults, and defaults are resolved at the engine boundary.
- **Lazy command loading:** Leaf commands validate CLI input before importing action graphs, while
  root config loading necessarily happens earlier in `preAction`.
- **Review/seal/apply separation:** Evaluate is observational, policy plan may seal but never apply,
  and sync-ratings applies only sealed artifacts through the existing approval/checksum boundary.

## Gotchas & Edge Cases

- Current config loading is intentionally fallback-oriented. Merely validating `policy.overrides`
  is insufficient: a malformed highest-precedence file would be ignored and could silently remove
  a suppression before `sync-ratings --mode apply`.
- `report.rules[*].proposedCount`, `report.summary.proposed`, report status, policy-plan totals, and
  rating-sync cohorts all currently assume `report.proposals` is complete. Filtering after those
  values are frozen creates contradictory machine output; recount inside the engine.
- Override classification must run after caps. Filtering before `applyCohortCap()` would allow a
  lower-ranked proposal to backfill the cap and would change existing policy semantics.
- Skip keys are four segments while permitted override keys are three. Stale `outcome-changed`
  matching must compare the override's rule/subject anchor to current skips rather than exact skip
  keys, and it must never synthesize a proposal from a skip.
- Policy-plan's human renderer and sync-ratings' human renderer do not display the full embedded
  evaluation. Machine envelopes preserve it, but human visibility requires explicit integration.
- `sync-ratings` reads raw config before evaluation to preserve `enabled: false` versus unset and
  then force-enables unset selected rules. Override state must remain in the same validated config
  object; do not derive it from the resolved policy echo, whose enabled values are intentionally
  contaminated by per-run overrides.
- `policyDecisionKeys()` currently returns only actionable proposal and skip keys. Without including
  override results, `--explain` rejects the exact key an operator needs to review after suppression.
- Reasons are untrusted display data. Reuse terminal-safe text handling and the CSV formula guard;
  never place rationale in handoff argv, plan artifacts, or fingerprint material.
- Already sealed plan artifacts are independent authorization objects. Changing or adding an
  override affects new evaluations only and must not alter the existing apply validator.
- No CLI flag is added, so Bash, Zsh, and Fish completion templates should remain unchanged; run the
  existing parity tests as an audit rather than editing templates.

## Key Dependencies

- `commander`: command ancestry and the root `preAction` lifecycle.
- `js-yaml` with `CORE_SCHEMA`: existing `.rfmedia.yaml` parser.
- Node.js `node:crypto`: built-in SHA-256; no canonicalization dependency is required when hashing an
  explicit domain tuple.
- Existing Plex/Lidarr reconciliation and gatherers: read-only evidence and credential-free origins.
- Existing policy rule registry, cohort caps, plan producers, strict-v3 artifact writer, and guarded
  apply action: unchanged downstream boundaries.
- `@rfmedia/common` output/CSV facilities: machine serialization and spreadsheet-formula safety.

## Relevant Docs

- `/docs/plans/issue-313-policy-overrides/feature-spec.md`: Accepted override semantics, v2 report
  contract, strict loading, fingerprint tuple, and scope exclusions.
- `/docs/plans/issue-313-policy-overrides/research-technical.md`: Detailed proposed data model,
  classifier behavior, and critical-test recommendations.
- `/docs/plans/issue-313-policy-overrides/research-security.md`: Fail-open config and mutation-boundary
  threat analysis.
- `/packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: Current policy evaluation and
  policy-plan user contract.
- `/packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`: Current recommend/plan/apply ladder and
  embedded evaluation behavior.
- `/docs/plans/issue-311-policy-plan/analysis-architecture.md`: Prior architecture analysis for the
  shipped evaluate-to-plan composition.
