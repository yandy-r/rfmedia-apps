# Code Analysis: issue-313-policy-overrides

## Executive Summary

The current implementation already centralizes every mutation-bound candidate in the frozen
`PolicyEvaluationReport.proposals` array. Issue #313 should add one pure bridge module that stamps
post-cap proposals with evidence fingerprints, classifies configured suppressions, and returns the
smaller actionable array before the engine rebuilds counts and freezes policy report v2. Strict
startup loading and presentation are separate edge changes; policy-plan and ratings-sync production
code should continue to consume the report unchanged.

## Existing Code Structure

### Related Components

- `packages/rfmedia-cli/src/types/config.ts:469`: `PolicyConfigOptions` is the raw, default-free
  policy configuration contract and currently contains only `plexLibrary` and `rules`.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts:35`: owns the evaluation schema/engine versions,
  zero-value-import report contracts, option registries, and post-render fail gate.
- `packages/rfmedia-cli/src/lib/config.ts:2808`: the policy validator uses closed key sets,
  `ConfigError`, exact property paths, and object reconstruction without injecting defaults.
- `packages/rfmedia-cli/src/lib/config.ts:4641`: `loadConfig()` caches successful secret-resolved
  loads but currently warns and searches lower-precedence files after parse, validation, or read
  failures.
- `packages/rfmedia-cli/src/cli.ts:116`: exports one existing exact-command predicate and performs
  the shared config load in the root `preAction` hook before plugin initialization or leaf actions.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts:67`: `policyArtistKey()` and
  `policyPlexKey()` mint the three-segment proposal keys; skip construction appends a fourth code
  segment.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts:867`: `runLidarrPolicyEvaluation()` owns rule
  dispatch, caps, refusal attribution, ordering, counts, status, and final deep freezing.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts:414`: resolves one loaded policy config
  snapshot and supplies credential-free origins, resolved library scope, rule selection, signals,
  and CLI overrides to the pure engine.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts:493`: owns shared CSV projection,
  human evaluation/policy-plan rendering, decision-key discovery, and explain output.
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts:317`: projects every and only
  `report.proposals`, with total-key accounting across cohorts and refusals.
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts:313`: filters `report.proposals` by the two
  selected rule bindings before forming sealable cohorts.
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts:259`: an empty projection returns
  `no-changes` before producer dispatch.
- `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts:366`: the recommend/plan/apply ladder seals
  only sealable cohorts, consults confirmation only for sealed outcomes, and applies only approved
  sealed artifacts.

### File Organization Pattern

Public immutable shapes and runtime registries live in `src/types/**`; deterministic orchestration
and projection live in `src/lib/bridge/**`; I/O collaborators are injected at `src/actions/**`; and
Commander/output ownership stays in `src/commands/**` plus the root `src/cli.ts`. Tests are colocated
as `*.test.ts`, except the tri-shell parity suite at
`src/lib/shell-completions/templates.spec.ts`.

## Implementation Patterns

### Pattern: Post-Cap Engine Reconciliation

**Description**: `applyEngineBounds()` cuts each rule cohort before aggregate report assembly
(`policy-engine.ts:600-618`). The override classifier must run after the loop has collected bounded
decisions (`policy-engine.ts:897-919`) but before `ranRuleResult()`, `buildSummary()`, status, and
final arrays are frozen; otherwise caps refill or counts disagree.
**Example**: See `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts:893-942`.
**Apply to**: Fingerprinting/classification integration, per-rule recounting, actionable-only summary
counts, and v2 report freezing.

### Pattern: Stable Base Decision, New Report-Grade Copy

**Description**: Rule constructors deep-freeze proposals once at their source
(`policy-rule-support.ts:144-177`). Do not mutate those objects; create a frozen report-grade
proposal that spreads the frozen base and adds `evidenceFingerprint`, then freeze override results
and result arrays.
**Example**: See `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts:88-130` and
`packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts:165-177`.
**Apply to**: New `PolicyEvaluatedProposal`, fingerprint generation, retained override decisions,
and deep-freeze tests.

### Pattern: Closed, Default-Free Config Validation

**Description**: Policy validation uses allowed-key sets, exact `ConfigError.propertyPath`, and
conditional object spreads so omitted fields stay omitted (`config.ts:2808-2833`,
`config.ts:2888-3129`). Override validation needs a specialized plain/null-prototype dynamic-map
validator using own enumerable keys and bracketed JSON-quoted paths rather than broadening every
config-object helper.
**Example**: See `packages/rfmedia-cli/src/lib/config.ts:212-224` and
`packages/rfmedia-cli/src/lib/config.ts:3108-3129`.
**Apply to**: Suppress-only entries, exact hash/key/reason checks, hostile-key rejection, and the
500-entry bound.

### Pattern: Exact Commander Ancestry at Startup

**Description**: `isCredentialFreeOfflineReconcile()` shows the repository's exported predicate
pattern, while the root hook calls `loadConfig()` once before plugins/actions (`cli.ts:116-157`). Add
an exact ancestry predicate for only `lidarr policy evaluate`, `lidarr policy plan`, and
`lidarr sync-ratings`, then pass strictness into that one loader call.
**Example**: See `packages/rfmedia-cli/src/cli.ts:116-146` and its focused tests in
`packages/rfmedia-cli/src/cli.test.ts:82-101`.
**Apply to**: Fail-closed sensitive startup without changing `lidarr plan` or unrelated commands.

### Pattern: One Shared Presentation Projection

**Description**: JSON/YAML already serialize the report directly; the shared presenter explicitly
defines flat CSV columns/rows and every human byte goes through stderr. Extend the evaluation
projection once, include override keys in explain lookup, and call the same override renderer from
evaluation, policy-plan, and sync-ratings human surfaces.
**Example**: See `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts:61-100`,
`packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts:493-526`, and
`packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts:1428-1457`.
**Apply to**: Summary counts, proposal fingerprints, override CSV rows, default-visible statuses,
and full-fingerprint explain output.

### Pattern: Existing Consumer Safety Ladder

**Description**: Both projectors iterate only `report.proposals`
(`policy-plan.ts:317-366`; `rating-sync.ts:313-365`). Withholding in the engine therefore needs no
production change in either projector; focused fixtures should prove the embedded override report
is preserved while zero disputed proposals reach cohorts/producers.
**Example**: See `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts:252-284` and
`packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts:448-478`.
**Apply to**: Policy-plan and ratings-sync boundary tests only, not duplicate classifiers.

## Integration Points

### Files to Create

- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`: explicit versioned evidence tuple,
  SHA-256 fingerprinting, proposal/skip subject-anchor matching, override disposition, filtering,
  deterministic ordering, and frozen results.
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.test.ts`: golden hash vector, material
  rotation/stability, all disposition states, non-refill, deterministic ordering, and immutability.

### Files to Modify

- `packages/rfmedia-cli/src/types/config.ts`: add `PolicyOverrideConfigOptions` and the read-only
  `PolicyConfigOptions.overrides` record.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: bump only evaluation schema/engine to v2; add
  fingerprint, evaluated proposal, override result/status/stale-reason contracts and summary fields;
  extend stale-aware `shouldFailPolicyEvaluation()` without value imports.
- `packages/rfmedia-cli/src/lib/config.ts`: validate the bounded dynamic mapping and add explicit
  fail-on-invalid loading while preserving normal fallback behavior.
- `packages/rfmedia-cli/src/cli.ts`: export/test the exact sensitive-command predicate and select
  strict config loading in `preAction`.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: call reconciliation after caps, rebuild run
  results/counts from actionable proposals, and freeze the report v2 override data.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: add fixed CSV fields/override rows,
  a default-visible human section, retained-decision explain, and full fingerprints.
- `packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts`: render the shared override
  section in the human sync view; keep explain delegation unchanged.
- Focused tests: `src/cli.test.ts`, `src/lib/config.test.ts`,
  `src/lib/bridge/policy-engine.test.ts`, `src/commands/lidarr-policy.test.ts`,
  `src/commands/lidarr-sync-ratings.test.ts`, `src/lib/bridge/policy-plan.test.ts`,
  `src/lib/bridge/rating-sync.test.ts`, `src/actions/lidarr/policy-plan.test.ts`, and
  `src/actions/lidarr/sync-ratings.test.ts`.
- Documentation: `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`,
  `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`, `packages/rfmedia-cli/README.md`, and
  `ROADMAP.md`.

### Files That Must Not Change

- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts`: no CLI option is added.
- Policy-plan v1, ratings-sync v1, and sealed Lidarr plan v3 type/schema constants.
- Rule evaluators, clients, adapters, generated Lidarr code, database/schema/migrations, schedulers,
  plan writers, apply validation, history, claims, and completion source.

## Code Conventions

### Naming

Use domain names such as `configuredOverrides`, `PolicyEvaluatedProposal`,
`PolicyDecisionEvidenceFingerprint`, and `reconcilePolicyOverrides`; avoid confusing durable config
with the existing `PolicyEvaluationRunInput.overrides` CLI-threshold object. Preserve
three-segment keys from `policyArtistKey()`/`policyPlexKey()` and use code-unit sorting for hash
material and configured keys rather than locale display ordering.

### Error Handling

Throw `ConfigError` with the source path and exact bracketed dynamic property path for invalid
entries. Do not coerce hostile values for diagnostics. In strict mode, the first existing file is
authoritative and read/template/parse/validation failures escape; missing candidates still search
and no file still returns `{}`. Canonicalization failures abort evaluation. Commands render before
the existing fail gate sets `process.exitCode`; no `process.exit()` belongs in the engine or
presenter.

### Testing

Reuse frozen literal reports for pure bridge/projector tests and `vi.fn()` dependency objects with
`satisfies ...Dependencies` for action tests. Existing anchors are the engine structural suites in
`policy-engine.test.ts:335-1046`, policy validation in `config.test.ts:1033-1320`, policy-plan's
empty-artifact test at `actions/lidarr/policy-plan.test.ts:400`, ratings-sync mutation gates at
`actions/lidarr/sync-ratings.test.ts:414`, command output/explain/fail ordering at
`commands/lidarr-policy.test.ts:618-680`, and tri-shell policy registry parity at
`lib/shell-completions/templates.spec.ts:1484`.

## Dependencies and Services

### Available Utilities

- `node:crypto.createHash`: built-in SHA-256; no package addition is needed.
- `ConfigError`, `describeType()`, `rejectUnknownConfigKeys()`: local validation/error vocabulary.
- `policyArtistKey()` / `policyPlexKey()`: authoritative proposal-key grammar.
- `formatOutput()`: recursively neutralizes spreadsheet formula cells on a CSV copy, so override
  reasons should remain ordinary scalar cells.
- `getLoadedPolicyConfig()`: preserves one raw policy config snapshot for evaluate and sync-ratings.

### Required Dependencies

- No new runtime dependency, provider call, database access, generated client operation, or CLI
  option is required.
- The new bridge module should import only `node:crypto` and config/policy types; it must not import
  actions, clients, adapters, producers, prompts, apply, schedulers, or persistence modules.

## File Ownership and Dependency Guidance

- Treat `types/lidarr-policy.ts` plus `policy-overrides.ts` as the foundational report contract;
  engine and presenter tasks depend on it and must not edit it concurrently.
- Treat `types/config.ts`, `lib/config.ts`, `lib/config.test.ts`, `cli.ts`, and `cli.test.ts` as one
  input-safety lane or sequence the CLI task after the loader signature stabilizes.
- Treat `policy-engine.ts` and `policy-engine.test.ts` as one owner because recounting and v2 report
  assembly are inseparable.
- Presenter work owns `lidarr-policy-presenter.ts` and its command test; sync human integration can
  then own `lidarr-sync-ratings-presenter.ts` and `lidarr-sync-ratings.test.ts` independently.
- Split policy-plan and ratings-sync boundary tests into distinct tasks to avoid action-test fixture
  churn; neither task should modify projector/action production files unless a verified existing
  empty-cohort path is insufficient.
- Documentation can run in parallel after field names/status wording stabilize, except `ROADMAP.md`
  must wait for live issue totals and the final pull-request number.

## Gotchas and Warnings

- Running classification before caps or refilling afterward changes existing ranking semantics.
- Filtering after `ranRuleResult()`/`buildSummary()` creates contradictory rule, summary, and array
  counts.
- A same-key stale proposal must remain withheld; stale never silently reactivates mutation work.
- `outcome-changed` correlates a three-segment override anchor to a four-segment skip key but must
  retain the real skip and never synthesize a proposal.
- A selected completed rule with no subject decision is stale; a deselected, disabled, blocked, or
  failed rule is `not-evaluated`.
- Fingerprints must exclude timestamps, display prose, operator reason, credentials, and
  `handoff.argv`, while binding credential-free origins/library, stable ids/MBID, state, checks,
  observations, and producer.
- A suppressed proposal leaves `report.proposals`, so explain/key discovery must consult the
  retained override decision or the operator cannot review the record.
- `sync-ratings` force-enables unset selected rules but reads raw enablement first; durable overrides
  must travel in the same loaded config snapshot, not a second read or the resolved policy echo.
- A newly configured override governs only new evaluation/projection and cannot revoke an already
  sealed artifact.
- Completion templates must remain byte-identical; prove parity by running the existing Bash/Zsh/
  Fish registry test.

## Task-Specific Guidance

- **For contract tasks**: Preserve the zero-value-import header and nested version boundaries; use
  closed unions and frozen read-only collections.
- **For classifier tasks**: Build and hash an explicit versioned tuple, reject non-finite/non-JSON
  evidence, preserve ordered checks, sort unordered records/observations deterministically, and
  return actionable proposals plus every configured override result.
- **For config tasks**: Validate own enumerable keys on ordinary/null-prototype maps, reject arrays,
  inherited/prototype-like keys and maps over 500 entries, and retain no implicit defaults.
- **For presentation tasks**: Show override state without `--verbose`; keep full fingerprints in
  machine/explain output, all human output on stderr, and one prose-free document on stdout.
- **For boundary tasks**: Prove a withheld-only policy-plan run calls no producer and a withheld-only
  ratings-sync apply run calls no producer, confirmation, or apply; do not duplicate classifier
  truth tables outside the pure module.
