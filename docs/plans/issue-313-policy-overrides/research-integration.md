# Integration Research: Issue 313 Policy Overrides

## Overview

Issue #313 is an in-process, configuration-backed extension of the existing Lidarr policy report;
it adds no HTTP endpoint, provider call, database table, migration, generated client operation, or
CLI option. The safe integration is strict config selection in the root `preAction` hook followed
by one pure post-cap disposition pass in `runLidarrPolicyEvaluation()`, so presenters,
`policy plan`, and `sync-ratings` all consume the same filtered actionable proposal collection.

The nested policy evaluation contract changes from v1/engine 1 to v2/engine 2. The outer
policy-plan v1, ratings-sync v1, and sealed Lidarr mutation-plan v3 contracts remain unchanged and
embed or consume the new evaluation report without acquiring override-specific mutation logic.

## Relevant Files

- `packages/rfmedia-cli/src/cli.ts`: Root `preAction` config load; must select strict loading from
  the exact final command path before any leaf action or provider gather runs.
- `packages/rfmedia-cli/src/lib/config.ts`: Config search precedence, YAML/JSON parsing, validation,
  cache integration, and the current warn-and-fallback behavior that sensitive paths must override.
- `packages/rfmedia-cli/src/lib/loaded-config.ts`: One process-wide validated config snapshot;
  `getLoadedPolicyConfig()` already feeds evaluate and sync-ratings.
- `packages/rfmedia-cli/src/types/config.ts`: Input contract for `policy.overrides`.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: Stable keys, report-grade proposals, override
  results, summary counts, schema/version constants, and the post-render fail gate.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: Sole disposition integration point after
  existing rule caps/refusal attribution and before final counts/status/freezing.
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`: New pure fingerprint and reconciliation
  module; no client, adapter, database, producer, writer, prompt, or apply imports.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: Resolves report scope, gathers existing
  evidence, and passes the same loaded policy snapshot to the engine.
- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`: Evaluate/plan machine envelopes,
  `--explain` validation, human rendering dispatch, and `--fail-on proposals` after rendering.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: Shared human, explain, and flat CSV
  projection for evaluate, policy-plan, and sync-ratings evaluation rows.
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts`: Purely projects `report.proposals`; central
  withholding means no second override matcher is needed.
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts`: Evaluates once, projects, and only then
  calls existing plan producers; an empty projection returns `no-changes` with zero artifacts.
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts`: Purely projects selected decisions from
  `report.proposals`; it must not reinterpret override state.
- `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`: Reads the raw enabled tri-state and then
  evaluates, projects, seals, prompts, and applies; a fully withheld cohort must stop before every
  producer/prompt/apply dependency.
- `packages/rfmedia-cli/src/commands/lidarr-sync-ratings.ts`: Reuses the embedded evaluation CSV and
  policy explain helpers; JSON/YAML retain the full ratings-sync envelope.
- `packages/rfmedia-cli/src/types/lidarr-policy-plan.ts`: Outer
  `rfmedia.lidarr-policy-plan.v1` wrapper containing the evaluation report.
- `packages/rfmedia-cli/src/types/lidarr-sync-ratings.ts`: Outer
  `rfmedia.lidarr-ratings-sync.v1` wrapper containing the evaluation report.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Fetch, generated-client, editor-body,
  and Lidarr mutation-owner architecture gate.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Bash/Zsh/Fish option and value
  parity audit; templates must remain unchanged because the feature adds no flag.

## API Endpoints

### Existing Related Endpoints

None are added or changed. Plex artist/track reads and Lidarr artist/profile reads remain behind the
existing adapter/client gather path. Override parsing, fingerprinting, matching, presentation, and
projection are synchronous local operations and must perform no `fetch` or generated API call.

### Route Organization

This is a Commander CLI, not an HTTP route surface. Registration is:

```text
program -> lidarr -> policy -> evaluate
program -> lidarr -> policy -> plan
program -> lidarr -> sync-ratings
```

The strict-loader predicate must inspect `actionCommand`, including its parents, and match exactly:

- leaf `evaluate`, parent `policy`, grandparent `lidarr`;
- leaf `plan`, parent `policy`, grandparent `lidarr`;
- leaf `sync-ratings`, parent `lidarr`.

Do not classify by leaf name alone: `lidarr plan` is a separate mutation-plan command. Do not put
strict selection in the leaf `.action()` callbacks: the root hook must reject authoritative config
before lazy action imports, adapter/client construction, plugin initialization, evidence gathering,
plan sealing, prompting, or apply.

## Database

### Relevant Tables

- `bridge_identity_snapshots`: pre-existing reconciliation cache refreshed by live policy
  evaluation through `executeLidarrReconcile()`.
- No override table exists or is required.

### Schema Details

There is no change to `packages/rfmedia-cli/src/lib/schema.sql`, schema version, migrations, DB
helpers, or retention behavior. `.rfmedia.yaml` is the only durable override state, and evaluation
must never write back to it.

The important qualification is that current live evaluation is not literally database-write-free:
`policy-evaluate.ts` documents the pre-existing observational replacement of
`bridge_identity_snapshots`. Issue #313 must add no new database access or write and must fail an
invalid strict config before that existing reconciliation write can occur.

## External Services

- **Plex and Lidarr:** Existing evidence sources only; credentials, origins, pagination, scheduler
  lanes, retries, and cross-origin guards are unchanged.
- **Node `node:crypto`:** Built-in SHA-256 for a small explicit evidence tuple; no package or remote
  service is required.
- **`js-yaml`:** Existing `CORE_SCHEMA` parser remains authoritative. Strict mode changes failure
  propagation, not parsing semantics or file precedence.
- **No new service:** No authentication, webhook, MCP method, daemon, scheduler, or remote override
  store is introduced.

## Internal Services and Data Flow

```text
root preAction
  -> loadConfig(strict only for the three exact leaves)
  -> setLoadedConfig(one validated snapshot)
  -> policy evaluate action (existing Plex/Lidarr gather)
  -> rule evaluators -> existing caps and refusals
  -> policy-overrides (fingerprint + classify + withhold)
  -> recount/freeze PolicyEvaluationReport v2
       -> evaluate human / JSON / YAML / CSV / explain
       -> policy-plan projector -> existing producers -> sealed v3 artifacts
       -> rating-sync projector -> existing producers -> approval -> existing apply
```

The engine pass runs after caps, so suppression never refills a capped cohort. Exact and stale
matching proposals are absent from final `report.proposals`; unrelated proposals remain. A current
skip can support `stale: outcome-changed`, but it cannot be hidden or converted into a proposal.
A skipped/blocked rule produces `not-evaluated`; a selected completed rule with no matching subject
produces `stale: decision-absent`.

`sync-ratings` has a subtle shared-state dependency: it reads raw `policy.rules.*.enabled` before
calling evaluate to decide which unset rules to force-enable. Both reads already use
`getLoadedPolicyConfig()`, so adding `overrides` to that same immutable command snapshot prevents
the action and evaluator from selecting different config files.

## Engine and Schema Contracts

- `PolicyProposal` remains the rule output; the report exposes a fingerprinted proposal subtype so
  frozen rule output is not mutated after construction.
- Fingerprints bind credential-free Plex origin, Lidarr origin, resolved Plex library, key/rule/code,
  subject ids/MBID, identity basis, before/after, ordered checks, observations, and producer.
- Timestamps, names, prose, reason, report order, credentials, and `handoff.argv` do not enter the
  hash. Arrays retain semantic order; record keys use deterministic non-locale ordering.
- Engine assembly currently creates each `PolicyRuleResult` before final proposal freezing. After
  disposition it must rebuild/recount run results so `rule.proposedCount`, `summary.proposed`, and
  `report.proposals.length` agree.
- `summary` adds suppression/stale/not-evaluated counts; `proposed` stays the actionable count.
- `shouldFailPolicyEvaluation()` remains post-render but must also fail `--fail-on proposals` when
  stale override results require review. Active suppression alone does not fail.
- Change `POLICY_EVALUATION_SCHEMA` to `rfmedia.lidarr-consumption-policy.v2` and
  `POLICY_ENGINE_VERSION` to `2`.
- Keep `POLICY_PLAN_SCHEMA` at `rfmedia.lidarr-policy-plan.v1`, `SYNC_RATINGS_SCHEMA` at
  `rfmedia.lidarr-ratings-sync.v1`, and sealed Lidarr plans at v3. Overrides affect new same-run
  evaluation/projection only; they do not revoke or rewrite an already sealed artifact.

## Presenter and Machine Output

- JSON/YAML evaluate output remains `{ command: "lidarr-policy-evaluate", result: report }` and
  naturally carries the complete v2 report.
- Policy-plan and sync-ratings JSON/YAML retain their outer envelopes and embed the complete v2
  evaluation under `result.evaluation`.
- Extend the shared evaluation CSV columns once: summary override counts, proposal evidence
  fingerprint, and explicit `override` rows containing key/action/status/stale reason/reason,
  expected/current fingerprint, and detail. Policy-plan CSV composes these rows; sync-ratings CSV
  already delegates directly to the same projection.
- `policyDecisionKeys()` and `renderPolicyExplain()` must include retained suppressed/stale keys.
  Sync-ratings already delegates to both helpers, so no second explain implementation is needed.
- Human output needs an Overrides section visible without `--verbose`; full hashes are required in
  explain and machine output. Reasons pass through the existing CSV formula-neutralization boundary.
- Machine stdout remains one prose-free document; every human byte remains on stderr.

## Configuration

Extend `PolicyConfigOptions` with the exact `policy.overrides` mapping. Validation must reject
unknown fields/actions, skip-key shapes, malformed hashes, unsafe/blank reasons, prototype-like or
inherited keys, and oversized maps with a `ConfigError` carrying the bracketed dynamic path.

Extend `loadConfig()` with a strict/fail-on-invalid option. On sensitive paths, the first existing
file in current precedence is authoritative: read, template, parse, or validation failure throws;
it never continues to a lower-priority file or `{}`. Missing files still continue normally, and no
file still yields empty config. Existing commands retain the current fallback contract unless the
strict option is explicitly selected.

## Architectural Patterns

- **One authoritative filter:** Reconcile dispositions once in the engine; presenters and consumers
  read the resulting report instead of duplicating matching logic.
- **Pure bridge boundary:** The new module depends on config/report types plus `node:crypto`, with no
  I/O or mutation ownership.
- **Read/evaluate/project/apply separation:** Evaluation may gather and refresh its existing identity
  cache, but override state grants no producer or apply authority.
- **Nested versioning:** Bump the changed evaluation schema while preserving unchanged outer and
  artifact schemas.
- **Fail closed at command startup:** Invalid authoritative config is rejected before any costly or
  stateful work.

## Gotchas and Edge Cases

- A presenter-only filter is unsafe because both projectors consume `report.proposals` directly.
- A stale fingerprint must quarantine its current proposal; otherwise config drift silently
  reactivates a disputed mutation.
- A config entry added after artifact sealing cannot revoke that artifact under the v1 boundary.
- `actionCommand.name() === "plan"` is insufficient because `lidarr plan` is unrelated.
- A current skip key has a fourth code segment; configured override keys accept only the original
  three-segment proposal grammar.
- Origins and provider ids are instance-local. Binding origin/library plus ids/MBID prevents a
  same-looking artist on another instance from inheriting a suppression.
- `sync-ratings` can force-enable unset rules; override matching must use the effective evaluation,
  while decision-state provenance continues to use the raw config tri-state.
- The policy and sync outer reports embed the evaluation verbatim. Hand-editing only top-level
  fixtures after the v2 bump will leave nested fixture contracts stale.
- Completion files are handwritten and statically audited. Because no option is added, changing any
  Bash, Zsh, or Fish template is a regression rather than required work.

## Exact Test and Completion Audit

Critical focused coverage should prove:

1. Config retention, exact paths, hostile objects, malformed YAML/JSON/duplicates, and strict
   highest-precedence failure without fallback.
2. Golden fingerprint stability/rotation, every disposition state, deterministic ordering,
   deep-freezing, post-cap non-refill, and exact count/schema contracts.
3. Policy-plan and rating-sync projectors see no active/stale disputed proposal.
4. A fully disputed `policy plan --mode plan` calls no producer; a fully disputed
   `sync-ratings --mode apply` calls no producer, confirmation, or apply dependency.
5. Human default/explain plus JSON/YAML/CSV carry complete disposition evidence and preserve
   stdout/stderr separation; stale trips the post-render fail gate.
6. The three exact CLI paths select strict loading, while unrelated `lidarr plan` and other commands
   retain current loading behavior.

Run the focused suite:

```bash
npm run test:run -w packages/rfmedia-cli -- \
  src/lib/config.test.ts src/cli.test.ts \
  src/lib/bridge/policy-overrides.test.ts src/lib/bridge/policy-engine.test.ts \
  src/lib/bridge/policy-plan.test.ts src/lib/bridge/rating-sync.test.ts \
  src/actions/lidarr/policy-plan.test.ts src/actions/lidarr/sync-ratings.test.ts \
  src/commands/lidarr-policy.test.ts src/commands/lidarr-sync-ratings.test.ts \
  src/lib/shell-completions/templates.spec.ts
npm run check:architecture -w packages/rfmedia-cli
npm run test:architecture -w packages/rfmedia-cli
npm run typecheck -w packages/rfmedia-cli
```

Completion acceptance is byte-for-byte no-change in
`src/lib/shell-completions/{bash,zsh,fish}.ts`, with parity proven by
`templates.spec.ts` against `LIDARR_POLICY_EVALUATE_OPTION_LONGS`,
`LIDARR_POLICY_PLAN_OPTION_LONGS`, and `LIDARR_SYNC_RATINGS_OPTION_LONGS`.

## Relevant Docs

- `docs/plans/issue-313-policy-overrides/feature-spec.md`: Final behavior and scope source of truth.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: Existing engine, key, explain,
  report, and no-plan-write contracts.
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`: Existing recommend/plan/apply and
  embedded-evaluation contracts.
- `packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md`: Original evaluator safety and
  deferred suppression context.
- `docs/plans/issue-311-policy-plan/shared.md`: Existing policy-plan projection/sealing boundaries.
