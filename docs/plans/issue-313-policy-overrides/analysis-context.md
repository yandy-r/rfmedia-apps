# Context Analysis: issue-313-policy-overrides

## Executive Summary

Issue #313 adds a durable, reviewable, configuration-backed veto for one existing Lidarr policy
proposal. The implementation must keep the shipped three-segment decision key stable, bind the
operator's review to a deterministic scope-and-evidence SHA-256 fingerprint, and classify each
configured record as `suppressed`, `stale`, or `not-evaluated`. One pure post-cap engine pass must
remove both active and stale matches from the authoritative actionable proposal collection before
policy-plan or ratings-sync can produce, seal, prompt, or apply anything; unrelated proposals remain
eligible and no capped candidate is backfilled.

The binding design is deliberately narrow: `.rfmedia.yaml` is the only durable store,
`action: suppress` is the only action, proposal keys are the only valid targets, and no provider,
database, generated client, scheduler, CLI option, completion template, sealed-plan schema, or apply
contract changes. The policy evaluation report and engine move to v2 because proposal/count meaning
changes, while the outer policy-plan v1, ratings-sync v1, and strict Lidarr plan v3 contracts remain
unchanged.

## Architecture Context

- **System Structure**: Commander loads one validated config snapshot in the root `preAction` hook;
  the Lidarr policy action gathers evidence; a synchronous bridge engine runs rules and caps; shared
  presenters and pure plan/sync projectors consume the frozen evaluation report.
- **Authoritative Safety Boundary**: `PolicyEvaluationReport.proposals` is the sole actionable
  collection used by `projectPolicyPlan()` and `buildRatingSyncPlan()`. Override matching belongs in
  the engine, not in presenters, rules, projectors, or mutation actions.
- **Insertion Point**: Run reconciliation after `applyEngineBounds()` and universal-refusal
  attribution have produced final capped proposal/skip candidates, but before `ranRuleResult()`,
  summary/status calculation, and report freezing. This preserves ranking, prevents cap refill, and
  allows per-rule proposal counts to be rebuilt from the filtered cohort.
- **Configuration Boundary**: Extend `loadConfig()` with explicit fail-on-invalid behavior and
  select it only for the exact command paths `lidarr policy evaluate`, `lidarr policy plan`, and
  `lidarr sync-ratings`. The first existing highest-precedence file is authoritative; read,
  template, parse, or validation failures must escape before evidence gathering or plugin/action
  initialization instead of falling through to a lower-priority or empty config.
- **Data Model Boundary**: Rule factories continue returning frozen `PolicyProposal` values. Once
  report scope is known, the new pure module creates frozen report-grade proposal copies carrying
  `evidenceFingerprint`, classifies configured records, returns a filtered proposal array plus
  override results, and performs no I/O.
- **Presentation Boundary**: JSON/YAML serialize the report v2 directly. The shared policy presenter
  owns the always-visible human override section, explicit CSV override rows, full explain evidence,
  and key discovery for withheld decisions. Policy-plan and sync-ratings human surfaces must expose
  the same shared override state even for otherwise `NO CHANGES` runs.
- **Mutation Boundary**: Active and stale records affect only a new evaluation and same-run
  projection. They cannot manufacture proposals, alter desired state, convert skips, grant apply
  authority, edit config, or revoke an already sealed artifact.

### Required Data Flow

```text
.rfmedia.yaml policy.overrides
  -> exact-command strict config load
  -> one immutable loaded config snapshot
  -> existing Plex/Lidarr evidence gather
  -> existing rules, universal refusals, and per-rule caps
  -> scope-bound proposal fingerprinting and override classification
       -> unmatched proposal: remains actionable
       -> exact key + hash: suppressed and withheld
       -> same key + changed hash: stale/evidence-changed and withheld
       -> same subject now skipped: stale/outcome-changed; real skip remains
       -> completed rule no longer emits subject: stale/decision-absent
       -> disabled, deselected, or blocked rule: not-evaluated
  -> recount and freeze policy report v2
  -> presenter + unchanged report.proposals consumers
  -> existing review/seal/apply ladder
```

## Acceptance and Contract Decisions

- Config shape is a read-only `policy.overrides` mapping keyed by a valid three-segment proposal
  decision key. Each entry has exactly `action`, `evidenceFingerprint`, and `reason`.
- V1 accepts only `action: suppress`; four-segment skip keys, force/allow behavior, custom target
  state, producer changes, and skip-to-proposal conversion are prohibited.
- Require `sha256:` plus exactly 64 lowercase hexadecimal characters and a trimmed, non-empty,
  bounded, terminal-safe reason. Validate a maximum of 500 override entries.
- The overrides container must be a plain or null-prototype map with own enumerable keys. Reject
  arrays, class instances, inherited fields, prototype-like keys, unknown fields, hostile coercion,
  controls, bidi characters, and unsafe/oversized values. Runtime indexing uses `Map`.
- Dynamic validation failures use JSON-quoted bracket paths, for example
  `policy.overrides["stale-monitoring-cleanup:artist:233"].evidenceFingerprint`.
- The stable decision key remains non-rotating. Fingerprints are lowercase SHA-256 over a versioned,
  explicit tuple containing credential-free canonical Plex/Lidarr origins, resolved Plex library,
  key/rule/code, subject kind and ids/MBID, identity category/reason, sorted before/after scalars,
  checks in evaluation order, observations sorted by signal, and handoff producer.
- Exclude timestamps, display names, summary/detail prose, operator reason, report order,
  credentials, and `handoff.argv`. Preserve meaningful array order, use code-unit sorting, encode
  UTF-8, and reject non-finite or otherwise non-JSON evidence rather than hashing ambiguously.
- Both `suppressed` and every `stale` match are absent from final `report.proposals`. A current skip
  used for `outcome-changed` remains an evaluator skip; an override result never masquerades as one.
- `summary.proposed` and every `rules[*].proposedCount` are actionable-only. Add summary counts for
  suppressed, stale, and not-evaluated override results; freeze all new objects and arrays.
- Keep the current report status union for compatibility, but render stale-only runs as review
  required. `shouldFailPolicyEvaluation(report, "proposals")` must fail after rendering for stale
  records and must not fail for active suppression alone.
- Bump only `POLICY_EVALUATION_SCHEMA` to `rfmedia.lidarr-consumption-policy.v2` and
  `POLICY_ENGINE_VERSION` to `2`.

## Critical Files Reference

- `packages/rfmedia-cli/src/types/config.ts:469`: Extend the raw, default-free policy config
  contract with the suppression mapping and entry type.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts:35`: Bump only the embedded evaluation schema and
  engine version while retaining the zero-value-import architecture contract.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts:270`: Preserve the stable proposal key and base
  proposal emitted by rule factories; add report-grade fingerprint/result types alongside it.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts:409`: Extend report/summary with evaluated
  proposals and override results; keep proposals actionable-only.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts:450`: Extend the post-render fail gate for stale
  review work without changing active-suppression behavior.
- `packages/rfmedia-cli/src/lib/config.ts:3108`: Add feature-specific closed validation without
  injecting defaults or broadening unrelated config behavior.
- `packages/rfmedia-cli/src/lib/config.ts:4641`: Add strict/fail-on-invalid loading and isolate cache
  semantics so a strict call cannot reuse a permissive fallback result.
- `packages/rfmedia-cli/src/cli.ts:125`: Select strict loading by exact Commander ancestry before
  config handoff and plugin/action initialization; do not match leaf `plan` alone.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts`: Reuse the shipped proposal/skip key
  grammar and immutable construction patterns; do not change rule identity semantics.
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`: New pure module for explicit tuple
  projection, SHA-256, deterministic classification/filtering, and frozen override results.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts:867`: Integrate classification after caps,
  then recount rule/summary values and freeze report v2 exactly once.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts:414`: Pass the validated overrides and
  resolved report scope through the existing action-to-engine input; add no parallel config reader.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts:493`: Extend one shared CSV projection
  with fingerprint columns and explicit override rows.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts:1428`: Include retained override
  decisions in explain-key lookup and render full expected/current hashes plus recovery guidance.
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts:317`: Keep projection driven solely by
  `report.proposals`; add focused regression coverage, not matching logic.
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts:529`: Keep ratings cohort projection driven
  solely by `report.proposals`; add focused regression coverage, not matching logic.
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts`: Prove a withheld-only plan run reaches
  the existing `no-changes` path before any producer.
- `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`: Prove a withheld-only apply run calls no
  producer, confirmation, or apply dependency.
- `packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts`: Surface the embedded
  evaluation's override state in human sync output without duplicating the classifier.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Audit Bash/Zsh/Fish parity;
  all completion template source files must remain byte-for-byte unchanged.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: Primary user-facing source of
  truth for config, fingerprints, status lifecycle, recovery, and safety.
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`: Document downstream withholding and
  the unchanged recommend/plan/apply ladder.
- `packages/rfmedia-cli/README.md`: Add concise discoverability, config fields, and exact strict-load
  command scope.
- `ROADMAP.md`: Record issue #313 only with live issue totals and the final pull-request reference.

## Patterns to Follow

- **Functional Core, Imperative Shell**: Keep network/database gathering and producer/apply work in
  actions; keep fingerprinting, classification, recounting, and projection synchronous and pure in
  `lib/bridge`.
- **One Authoritative Filter**: Reconcile once in the engine and let every consumer trust the same
  filtered `report.proposals`; never create presenter-only or consumer-specific suppression logic.
- **Frozen Typed Values**: Follow `policy-rule-support.ts` and projector constructors by returning
  new frozen objects/arrays. Do not mutate rule-produced proposals to add report scope.
- **Closed Registries and Exhaustiveness**: Use literal unions, readonly records, `satisfies`, and
  exhaustive switches; do not build an action-handler registry for one action.
- **Default-Free Config Validation**: Retain only supplied fields and resolve defaults at the engine
  boundary. Preserve `ConfigError.configPath` and exact `propertyPath` contracts.
- **Safe Dynamic Input**: Use own-key checks, plain/null prototypes, `describeType()` rather than
  coercion, terminal-safe bounded text, deterministic code-unit ordering, and `Map` for
  operator-controlled keys.
- **Shared Presentation Projection**: Extend the existing presenter once for human, explain, and
  CSV output. Keep machine stdout prose-free and human bytes on stderr; let the existing formatter
  formula-guard override reasons in CSV copies.
- **Review/Seal/Apply Separation**: Evaluation remains observational, policy-plan remains review or
  sealing only, and sync-ratings retains its checksum-pinned guarded apply path.
- **Nested Versioning**: Version the changed policy report, not unchanged outer envelopes or sealed
  artifacts.

## Cross-Cutting Concerns

- **Fail-Closed Safety**: Config fallback is currently intentional for ordinary commands but unsafe
  for durable vetoes. Strict behavior and cache isolation must be implemented and tested together.
- **Count Consistency**: Filtering after per-rule rows or summary values are frozen produces a
  contradictory machine contract. Rebuild rule counts, summary, status, and fail-gate inputs from
  the filtered proposal array.
- **Staleness Visibility**: Stale proposals remain withheld, retain current evidence when present,
  show both fingerprints, and require explicit replace-or-remove recovery. They must not look clean
  merely because the actionable collection is empty.
- **Scope and Credential Safety**: Bind credential-free origins/library because provider ids are
  instance-local, but never hash tokens, credential-bearing URLs, argv, or free-form display prose.
- **Output Safety**: Operator reasons are untrusted display data. Use existing terminal-safe and CSV
  formula-safe paths and never copy the reason into artifact arguments or fingerprint material.
- **Existing Observational DB Write**: Live evaluation already refreshes
  `bridge_identity_snapshots`; this issue adds no DB work. Strict invalid config must fail before
  even that pre-existing reconcile path begins.
- **Compatibility**: No CLI option means no command registry or Bash/Zsh/Fish template edits. Outer
  schemas and strict-v3 artifact/apply validators remain unchanged.
- **Artifact Boundary**: A new override does not revoke an old sealed artifact; docs must make this
  explicit beside the workflow rather than implying retroactive protection.

## Critical Test Contract

- Pin one golden fingerprint and prove changes to ordering, timestamps, display/prose, reason, and
  argv are stable while changes to scope, ids/MBID, identity, decision code, state, checks,
  observations, or producer rotate it. Reject non-canonical evidence.
- Table-drive no record, exact suppression, evidence change, proposal-to-skip, completed-rule
  absence, and rule-not-evaluated states. Assert deterministic ordering, frozen output, preservation
  of real skips, exact single-proposal filtering, and no cap refill.
- At the engine boundary, prove `report.proposals`, per-rule counts, summary counts, report status,
  stale fail-gate behavior, schema constants, and deep-freezing agree after classification.
- In config tests, cover valid retention; bracketed exact paths; invalid key/skip key/action/hash;
  blank, unsafe, or oversized reasons; unknown/inherited/prototype fields; hostile values;
  null-prototype maps; and the 500-entry ceiling.
- With real temporary config files, prove invalid authoritative read/template/YAML/JSON/validation
  fails strict loading without lower-precedence fallback, permissive unrelated commands remain
  unchanged, and strict/permissive cache entries cannot contaminate each other.
- Test the exact command-ancestry predicate for all three sensitive leaves plus unrelated
  `lidarr plan` and other commands.
- Cover default human visibility, full explain fingerprints/recovery, override-key lookup, fixed CSV
  columns/row order and reason guarding, v2 JSON/YAML envelopes, stdout/stderr purity, and stale exit
  only after output.
- Add one focused projector boundary each for policy-plan and ratings-sync, plus one withheld-only
  orchestration test per mutation lane asserting zero producer/prompt/apply calls. Do not duplicate
  every classifier state at action level.
- Run typecheck and architecture gates, including zero-value-import and direct Plex/Lidarr mutation
  ownership checks. Run the existing completion parity test and verify no Bash/Zsh/Fish template
  diff.

## Parallelization Opportunities

- Config/report type contracts and pure classifier fixture design can begin independently when
  their file ownership is disjoint, but the classifier implementation must wait for the report
  types it consumes.
- Strict loader/config validation (`types/config.ts`, `lib/config.ts`, `cli.ts` and focused tests)
  can proceed independently of fingerprint/classification once the config shape is fixed.
- Engine integration must follow the report types and classifier. It owns recount/status semantics
  and should not share `policy-engine.ts` with another concurrent task.
- Presenter work can start after the final report shape stabilizes. It can run in parallel with
  downstream projector/action boundary tests because those touch disjoint files.
- Documentation can proceed in parallel after output terms and field names are stable. ROADMAP work
  waits for live issue totals and the final PR number.
- Completion/architecture/full-suite auditing is sequential after source integration; completion
  templates are audit-only and must not be assigned as modification work.

### Shared-File Coordination

- `types/lidarr-policy.ts` is a dependency for the classifier, engine, presenter, and fixtures;
  assign one owner and land it first.
- `lib/config.ts` should have one owner for both validation and strict-loader behavior to avoid
  conflicting edits and incomplete cache semantics.
- `lib/bridge/policy-engine.ts` should have one owner for classifier integration, recounting, status,
  and engine tests.
- `commands/lidarr-policy-presenter.ts` should have one owner for human/explain/CSV behavior; other
  surfaces should delegate to it rather than edit overlapping logic concurrently.

## Implementation Constraints

- Use the repository-pinned Node.js 22 toolchain and built-in `node:crypto`; add no dependency or
  generic canonical-JSON abstraction.
- Preserve stable proposal and skip key factories and all existing rule semantics, thresholds,
  ranking, caps, recency limitations, and album-artist play joins.
- Keep `types/lidarr-policy.ts` free of value imports so option registries do not pull the evaluator
  graph into CLI startup.
- Do not add a database/store, config writer, management command, provider request, client method,
  generated code, mutation allowlist entry, scheduler work, or artifact/history/claim change.
- Do not change completion templates, outer plan/sync schemas, sealed plan v3, or apply verification.
- Do not suppress a skip, synthesize a proposal, refill a cap, or globally block unrelated
  proposals because one override is stale.
- Do not truncate the copy-grade fingerprint in config, JSON, YAML, CSV, or explain output.
- Do not call `process.exit()` from engine or presenter code; render first, then set the command exit
  code through the existing fail-gate contract.
- Keep project tasks small (one to three files), with focused contract tests rather than filler
  coverage or duplicate serializer/sanitizer tests.

## Key Recommendations

1. Land closed config/report v2 contracts first, with one clear owner for each shared type file.
2. Implement strict config validation/loading and the pure fingerprint/classifier as separate
   workstreams; test malformed authoritative input and golden evidence vectors before integration.
3. Integrate exactly once after caps, then rebuild rule rows/counts/status and freeze the report.
4. Add presenter and consumer-boundary coverage only after report shape stabilizes; rely on existing
   downstream iteration over `report.proposals` instead of adding new matching code.
5. Update the primary feature guide, ratings-sync guide, README, and final ROADMAP entry using the
   exact public terms `suppressed`, `stale`, `not evaluated`, and `actionable proposals`.
6. Finish with focused tests, full package/architecture checks, unchanged tri-shell completion
   parity, formatting/markdown lint, and explicit review of the no-client/no-store/no-artifact scope.
