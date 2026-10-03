# Pattern Research: Lidarr Cascade Analysis

## Architectural Patterns

- `packages/rfmedia-cli/src/types/lidarr-plan.ts` owns the persisted contract and exact version
  discriminators. Preserve the existing v1/v2 types and introduce correlated v3 plan types rather
  than adding `cascadeAnalysis` to legacy shapes. `LidarrStoredMutationPlan` in
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` is the shared read/write/apply union.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` is the artifact boundary: builders normalize
  inputs, derive entries/review/summary/risk, checksum a fixed-order canonical projection, validate
  the result, freeze it, and only then permit atomic storage. Add v3 canonicalization and version
  dispatch without changing `canonicalizePlan` or `canonicalizePlanV2`; this protects legacy
  checksum bytes.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts` centralizes artist operation
  behavior (`canonicalize`, `risk`, `hasChange`, `summarize`, drift classification, execution).
  Album and track-filter families use parallel registries/helpers in
  `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`. Cascade analysis should
  consume their canonical plan facts through an exhaustive operation-kind switch, not duplicate
  remote reads or execution behavior.
- Keep analysis in a small pure Lidarr module beside the plan engine, with credential-free plan
  facts plus resolved numeric policy as its only inputs. The plan builders should call it after
  entries, review, summary, and risk exist but before checksum sealing. Apply must read the sealed
  result and must not call the analyzer.
- Planner actions under `packages/rfmedia-cli/src/actions/lidarr/plan*.ts` follow a consistent
  boundary: select/read Lidarr state, build a canonical plan, return the complete plan for preview,
  or write the same object with `writeLidarrPlanArtifact`. Wire policy into every current family:
  artist/album monitoring, profiles, tags, artist add/delete, album edit/delete, and track filter.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` is the shared presentation
  boundary. Human diagnostics go to stderr; machine JSON/YAML/CSV is emitted through
  `formatOutput` from `packages/rfmedia-cli/src/commands/lidarr.ts`. Preview, written-plan, and
  apply dry-run should all project the same sealed analysis.

## Code Conventions

- Model persisted data with readonly interfaces, string-literal discriminants, stable code unions,
  and `Object.freeze` where builders return canonical values. Avoid free-form persisted warning or
  recommendation prose; map stable codes to prose in the presenter.
- Canonicalizers in `plan-engine.ts` construct objects field by field in a fixed order and copy
  arrays. Follow this for v3 and for every nested analysis object; never rely on input object
  insertion order or spread arbitrary records into checksum material.
- Operation dispatch is exhaustive on `operation.kind`. Existing code uses parallel widened unions
  for later plan families to avoid silently changing older exhaustive switches. A v3 helper should
  deliberately cover every family and allow TypeScript's `never` check to expose future omissions.
- Sort and deduplicate selection/reference collections before sealing. Keep warnings and
  recommendations in explicit deterministic order, preferably defined by production-code
  allowlists rather than locale/text sorting.
- Treat counts as safe integers. Reuse checked-add/checked-multiply helpers for aggregate and
  modeled quantities; never clamp overflow. Preserve `0` as a known value and use `null` only for
  unknown quantities, as specified.
- Add `lidarr.cascadeAnalysis` types in `packages/rfmedia-cli/src/types/config.ts`. The validator in
  `packages/rfmedia-cli/src/lib/config.ts` builds a new typed object, validates nested objects, and
  uses bounded integer helpers with full property paths. Keep these budgets separate from
  `lidarr.scheduler.lanes.*.operationBudget`.
- No CLI command or option is added. Bash, Zsh, and Fish are maintained independently in
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`; their parity contract lives in
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`. Confirm the Lidarr command
  and option candidates remain unchanged.

## Error Handling

- Untrusted plan data is fail-closed. Shared primitives in
  `packages/rfmedia-cli/src/lib/lidarr/plan-validation.ts` reject non-records, unknown/missing
  keys, unsafe strings, non-safe integers, sensitive keys, forbidden prototype keys, and cycles
  with `LidarrPlanValidationError`.
- The v3 semantic validator should do more than shape checking: require exact nested keys and code
  allowlists, recompute metrics/assessments/warning order/recommendations from sealed facts and
  assumptions, and reject any inconsistency even when a checksum was recomputed.
- Invalid configuration should throw `ConfigError` from `packages/rfmedia-cli/src/lib/config.ts`
  with the config file and precise property path. Reject non-object `budgets`/`assumptions`,
  non-integers, zero/negative values, unsafe integers, and values above `1_000_000`.
- Arithmetic overflow is a planning validation failure before artifact write. Missing budgets are
  valid (`not-configured`); missing assumptions produce explicit `unknown`, not an exception.
- Preserve storage errors and checksum behavior in `plan-engine.ts`: validation happens before
  write; reads are bounded and validated before checksum verification; malformed, unsafe-path,
  oversized, and checksum-mismatch failures retain their typed error codes.
- Findings remain advisory. Do not route exceeded or incomplete assessments through authorization,
  scope truncation, scheduler admission, confirmation, drift, or execution error paths.

## Testing Approach

- Put the estimator's dense table-driven unit suite beside its implementation. One operation-family
  matrix should cover changed versus no-op scope, exact-zero immediate work, known modeled values,
  missing assumptions, absent/equal/exceeded budgets, deterministic ordering, and checked
  arithmetic overflow. This is the main behavior suite; avoid repeating the full matrix in every
  action test.
- Extend `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` for v3 canonical checksum
  determinism, strict unknown-key rejection, semantic tamper rejection after checksum recompute,
  and unchanged v1/v2 checksum/read/apply fixtures.
- Extend `packages/rfmedia-cli/src/lib/config.test.ts` with a compact valid/omitted case and a
  parameterized invalid-value matrix for all four numeric fields, including `0`, fractional,
  unsafe, and greater-than-maximum inputs.
- Add one representative planner integration assertion plus a small parameterized family coverage
  test proving every current plan builder emits v3 analysis. Existing family action tests
  (`packages/rfmedia-cli/src/actions/lidarr/plan*.test.ts`) should only gain assertions where a
  family's canonical facts drive a distinct analysis rule.
- Extend presenter/command tests (`packages/rfmedia-cli/src/commands/lidarr.test.ts` and relevant
  album command tests) for human labels, warning visibility without color, clean machine output,
  CSV projection, preview/apply-dry-run parity, and legacy `not-recorded`.
- Run `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` as a parity guard; no new
  completion snapshots are justified because the feature has no commands or flags.

## Patterns to Follow

- Add v3 alongside v1/v2; never mutate the legacy canonical projections or reinterpret legacy
  artifacts.
- Analyze only canonical, changed-scope plan facts and sealed bounded policy; do no network I/O and
  accept no credentials.
- Build entries and summaries first, analyze once, canonicalize the full v3 payload, validate
  semantics, checksum, freeze, and then preview or atomically write that exact object.
- Derive human prose from stable codes and keep structured analysis intact for JSON/YAML/CSV.
- Keep budget status advisory and deterministic: equality is `within`, omission is
  `not-configured`, insufficient evidence is `unknown`, and only a strictly greater known
  projection is `exceeded`.
- Prefer one exhaustive estimator matrix, one v3 artifact-contract suite, targeted config and
  presenter tests, and a family-coverage guard over broad duplicated tests.
