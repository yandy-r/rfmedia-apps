# Pattern Research: issue-313-policy-overrides

## Overview

The repository already has the right seams for policy overrides: a pure synchronous policy engine,
deep-frozen decision/report values, one shared presenter, and pure plan/sync projectors that consume
only `report.proposals`. The feature should extend those seams rather than add filtering to rules or
mutation actions. The main exception is configuration loading: the current loader deliberately
warns and falls through after parse/validation failures, so the three override-sensitive command
paths need an explicit strict mode selected by exact Commander ancestry.

## Relevant Files

- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: zero-value-import policy contract, schema
  constants, report types, option registries, and the post-render exit gate.
- `packages/rfmedia-cli/src/types/config.ts`: raw, default-free policy configuration contracts.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts`: stable key builders and the sole
  deep-freezing proposal/seed/skip constructors.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: pure rule execution, post-rule caps,
  ordering, counts, status, and final report freezing.
- `packages/rfmedia-cli/src/lib/config.ts`: exact-key validators, `ConfigError` path contracts,
  terminal-safe bounded-string precedent, and permissive `loadConfig()` search behavior.
- `packages/rfmedia-cli/src/cli.ts`: the single pre-action config load and the existing
  action-command ancestry pattern.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: shared human/explain/CSV
  presentation for evaluate, policy-plan, and sync-ratings.
- `packages/rfmedia-cli/src/lib/formatters/index.ts`: recursive CSV formula neutralization applied
  only to CSV copies.
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts`: total proposal-to-producer projection.
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts`: selected-rule projection and frozen cohorts.
- `packages/rfmedia-cli/src/actions/lidarr/{policy-evaluate,policy-plan,sync-ratings}.ts`: injected
  orchestration seams and the existing read/review/seal/apply boundaries.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Bash/Zsh/Fish option and value
  parity bound to the exported option registries.

## Architectural Patterns

**Zero-value-import public type modules**: `types/lidarr-policy.ts`,
`types/lidarr-policy-plan.ts`, and `types/lidarr-sync-ratings.ts` may export runtime constants, but
every import they make is `import type`. This prevents a command importing option registries from
pulling the evaluator, adapters, Lidarr client, or database into CLI cold start.

- Put config/result interfaces and template-literal fingerprint types in `types/**`.
- Put `node:crypto`, canonical tuple construction, and override matching in `lib/bridge/**`.
- Do not import the new bridge module from a type file or presenter.
- The architecture script protects client/mutation ownership, but the zero-value-import rule is
  primarily an explicit module contract; keep the header comment and audit imports directly.

**Single post-processing boundary**: `runLidarrPolicyEvaluation()` gathers rule outcomes, applies
`applyEngineBounds()`, attaches universal refusals, sorts decisions, builds counts, then freezes the
report. Override classification belongs after the existing cap cut and before `ranRuleResult()`,
`buildSummary()`, status selection, and final freezing. This preserves the no-refill rule and lets
per-rule `proposedCount` be rebuilt from the actionable proposal set.

**Frozen data, not mutable services**: `policy-rule-support.ts` freezes subjects, state maps,
checks, observations, handoffs, and decision objects at their sole constructors. The engine and both
projectors freeze arrays and envelopes before returning. A report-grade proposal with a fingerprint
should therefore be a new frozen shallow object that retains the already-frozen nested evidence;
override result objects and returned arrays should also be frozen.

**Closed registries and exhaustive projection**: policy rule/producer ids are `as const` registries,
descriptor maps use `satisfies`, and producer switches use `never` exhaustiveness. Keep v1 override
action/status unions closed; do not add an action-handler registry for one `suppress` action.

**Central actionable collection**: both `projectPolicyPlan()` and `buildRatingSyncPlan()` iterate
`report.proposals` directly. `projectPolicyPlan()` additionally asserts total key accounting.
Filtering once in the engine is therefore sufficient and prevents presenter/plan/sync disagreement;
neither projector should import or re-run override matching.

**Pure core plus injected impure edge**: pure bridge tests use literal reports and no mocks.
Orchestration actions expose dependency objects whose defaults are frozen and whose tests build
`vi.fn()` harnesses with `satisfies ...Dependencies`. Keep fingerprinting/classification free of
clients, adapters, databases, clocks, writers, and prompts; mock only I/O seams at action tests.

## Code Conventions

- Use named domain helpers and interfaces, not a generic canonical-JSON or disposition framework.
- Preserve stable proposal keys from `policyArtistKey()` / `policyPlexKey()`; four-segment skip keys
  are a separate contract and must not be accepted as override keys.
- Resolve defaults only in the engine. Config validators return only supplied fields and preserve
  falsy values through `...(value === undefined ? {} : { value })`.
- Use `Readonly<Record<...>>`, readonly arrays, discriminated unions, `Object.freeze`, `Map`, and
  `Set` consistently with adjacent policy code.
- The existing `PolicyEvaluationRunInput.overrides` means per-invocation CLI threshold overrides.
  Avoid shadowing/confusing it with durable policy overrides; use a name such as
  `configuredOverrides` inside the classifier.
- Sort with deterministic code-unit comparison, never locale-sensitive display ordering, for
  fingerprint material and configured override keys. Preserve semantically ordered arrays such as
  threshold checks.
- Dynamic config paths containing colons should use bracket notation with a JSON-quoted key, for
  example `policy.overrides["stale-monitoring-cleanup:artist:233"].reason`.
- Human output remains on stderr through presenter helpers; JSON/YAML/CSV remain one prose-free
  stdout document emitted by the command layer.

## Error Handling

**Exact validation failures**: `rejectUnknownConfigKeys()`, `describeType()`, and `ConfigError`
establish the local contract: reject unknown keys, avoid coercing hostile values, and preserve both
`configPath` and exact `propertyPath`. Reuse those primitives for entry fields and add a specialized
dynamic-map validator rather than broadening all config-object behavior.

**Own-key/plain-object checks are new and feature-specific**: current policy helpers use `in` and
accept any non-null non-array object. Overrides require `Object.keys`/`Object.hasOwn`, an
ordinary-or-null prototype, rejection of `__proto__`, `prototype`, and `constructor`, and a `Map`
for runtime lookup. Do not assign operator keys into `{}`.

**Terminal-safe bounded strings**: `config.ts` already has the
`LIDARR_PRESET_UNSAFE_TEXT` C0/C1/bidi pattern and `requireLidarrPresetString()` byte-bound pattern.
Follow that local shape for reasons, but keep the new validator policy-specific to avoid changing
preset behavior. Use `describeType()` for malformed non-strings rather than `String(value)`.

**Strict loader is an intentional opt-in**: `loadConfig()` currently catches YAML/JSON parse errors
and `ConfigError`, logs a warning, and continues to a lower-priority file or `{}`. Add an option that
rethrows the first existing file's parse/template/validation/read failure for override-sensitive
commands. Ensure the cache cannot return a result created under different strictness.

**Select strictness by exact command ancestry**: `cli.ts` already inspects `actionCommand.name()`
and `actionCommand.parent?.name()` for offline reconcile. Extend that pattern to only:

- `lidarr -> policy -> evaluate`
- `lidarr -> policy -> plan`
- `lidarr -> sync-ratings`

Do not key solely on leaf name (`plan` is used elsewhere) or top-level name (`lidarr` would make
unrelated commands strict).

**Fail after rendering**: `shouldFailPolicyEvaluation()` lives in the zero-import type module so
commands can render first and then set `process.exitCode = 1`. Extend that predicate for stale
overrides; do not call `process.exit()` or move exit ownership into the presenter/engine.

## Presenter and CSV Patterns

- Add fixed fingerprint/override columns to `LIDARR_POLICY_EVALUATE_CSV_COLUMNS` and explicit
  `override` rows in `projectPolicyEvaluationCsv()`. `projectPolicyPlanCsv()` already embeds those
  evaluation rows, so one change covers policy-plan CSV too.
- Extend `policyDecisionKeys()` and `renderPolicyExplain()` to consult retained override decisions;
  otherwise a suppressed key disappears from `report.proposals` and becomes unexplainable.
- JSON/YAML should serialize the versioned report directly; do not write parallel projections for
  fields those serializers already preserve.
- Formula guarding is already centralized in `formatOutput()`: it recursively prefixes strings
  beginning with tab/CR/LF/`=`/`+`/`-`/`@` only on a CSV copy and does not mutate JSON/YAML input.
  Keep operator reasons as ordinary row cells so they pass through this guard.
- Keep full fingerprints in machine and explain output. Any shortened human-table token is display
  only and must not be reused as config input.

## Testing Approach

**Pure core — new `lib/bridge/policy-overrides.test.ts`**:

- Pin one golden SHA-256 value; prove non-material order/timestamp/display/prose changes are stable
  and every scope/identity/check/observation/state/producer change rotates it.
- Table-drive no record, exact suppression, evidence change, proposal-to-skip, completed-rule
  absence, and not-evaluated rules. Assert deterministic order and frozen outputs.
- Prove one matched proposal is removed, unrelated proposals remain, and no capped candidate is
  refilled. Reject non-finite/non-JSON evidence without mocking `node:crypto`.

**Engine integration — `lib/bridge/policy-engine.test.ts`**:

- Assert actionable proposals, per-rule counts, summary counts, status/fail gate, and override rows
  agree after the post-cap pass.
- Extend the existing deep-freeze test to fingerprints, override arrays/results, and retained
  decisions. Keep repeated-run byte identity.

**Configuration/strict loading — `lib/config.test.ts`**:

- Extend the existing policy-validation table for valid retention, exact bracketed paths,
  unsupported action, malformed hash/key/skip key, blank/unsafe/oversize reason, unknown fields,
  inherited/prototype-like keys, null-prototype maps, hostile coercion, and entry ceiling.
- Add real temporary-file loader tests proving invalid highest-priority YAML and invalid override
  validation reject in strict mode instead of falling through, while permissive unrelated-command
  behavior remains unchanged. Cover cache isolation between modes.
- Test the small exact-ancestry selector used by `cli.ts`; this is the contract that keeps all three
  sensitive paths strict without affecting other Lidarr commands.

**Presenter/command — `commands/lidarr-policy.test.ts`**:

- Cover always-visible human override state, full explain fingerprints, suppressed/stale key
  lookup, fixed CSV row order/columns, v2 JSON/YAML envelope, stdout/stderr purity, and stale exit
  after output. Do not snapshot colors or duplicate generic serializer coverage.
- The generic formula defense is already pinned in `lib/formatters/formatters.test.ts`; add only a
  feature-specific assertion that override reasons are emitted as scalar CSV cells through
  `formatOutput`, not a second sanitizer implementation.

**Consumer boundaries**:

- Add one focused case each to `lib/bridge/policy-plan.test.ts` and
  `lib/bridge/rating-sync.test.ts` proving projectors consume only the already-filtered actionable
  proposals while retaining the nested override report unchanged.
- Reuse the `satisfies ...Dependencies` harnesses in
  `actions/lidarr/policy-plan.test.ts` and `actions/lidarr/sync-ratings.test.ts` for one withheld-only
  case asserting zero producer/prompt/apply calls. Avoid mocking every classifier state here; those
  belong in the pure test.

**Architecture/completion audit**:

- Run typecheck and architecture checks to retain zero-I/O/mutation ownership boundaries; the new
  bridge module must not join a mutation-owner allowlist.
- No CLI option is added. Leave the Bash, Zsh, and Fish templates byte-for-byte unchanged and run
  `src/lib/shell-completions/templates.spec.ts`, which already binds all three shells to
  `LIDARR_POLICY_EVALUATE_OPTION_LONGS`, `LIDARR_POLICY_PLAN_OPTION_LONGS`, and
  `LIDARR_SYNC_RATINGS_OPTION_LONGS` and asserts generation performs no adapter/client/config/fetch
  side effects.

## Patterns to Follow

1. Extend the closed config/report types without value imports.
2. Validate durable records strictly and retain raw, default-free config.
3. Compute scope-bound fingerprints and dispositions in one pure bridge module.
4. Run classification once after caps, then recount and freeze once.
5. Let presenters and both downstream projectors consume the authoritative report; do not filter
   again.
6. Prove behavior at the pure core, engine, config loader, presenter, and one test per mutation
   boundary; rely on existing shared serializer and completion parity tests for unchanged behavior.

## Gotchas and Edge Cases

- Classifying after `ranRuleResult()` without rebuilding rule rows leaves `proposedCount` stale.
- Classifying before caps changes ranking semantics; refilling after suppression exposes a proposal
  that the evaluator intentionally excluded.
- A strict call that reuses a permissive cache entry can silently lose an override just as surely
  as explicit fallback.
- A selected rule that did not run is `not-evaluated`; only a selected, completed rule with no
  matching subject is `stale: decision-absent`.
- A current skip may establish `outcome-changed`, but it remains the real skip; never synthesize a
  proposal or recode operator judgment as evaluator truth.
- Existing sealed artifacts are not derived from the current `report.proposals` and are therefore
  outside this same-run filtering contract.
