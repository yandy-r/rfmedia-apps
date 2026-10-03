# Practices Research — Lidarr Policy Plan

## Executive Summary

Issue #311 should be a thin composition of the shipped policy evaluator, a small pure projector,
and the two existing Lidarr plan producers. The repository already owns policy decisions, strict v3
plan construction, fresh-state reads, private atomic writes, checksum sealing, apply authorization,
human plan rendering, failure envelopes, and completion parity. Reimplementing any of those would
create competing sources of truth.

The maintainable design adds only the missing translation: account for every frozen
`PolicyProposal`, convert supported handoffs into producer-specific cohorts, and represent expected
unsupported/conflicting cases as data. Use closed discriminated unions and compile-time-total maps;
do not add a plugin system, generic workflow engine, plan v4, new operation kinds, or an apply rung.

## Existing Reusable Code

| Existing code                                 | Reuse                                                                                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions/lidarr/policy-evaluate.ts`           | Run evaluation once and retain its deep-frozen report unchanged. Do not move planning into this read-oriented action.                                                                                                                         |
| `types/lidarr-policy.ts`                      | Reuse `PolicyProposal`, rule/producer vocabularies, stable decision keys, descriptors, bounds, and option constants. Preserve its no-value-import discipline.                                                                                 |
| `lib/bridge/rating-sync.ts`                   | Copy the pattern, not the ratings-specific implementation: pure projection, explicit refusals, fail-fast invariants, deterministic ordering, frozen output, and cross-cohort conflict handling.                                               |
| `actions/lidarr/sync-ratings.ts`              | Reuse orchestration conventions: dependency injection, no wrapper scheduler slot, cohort-sized `maxBatch`, producer-order sealing, cancellation checks, and `onPlanSealed` reporting. Omit force-enable, thresholds, confirmation, and apply. |
| `actions/lidarr/plan-artist-profiles.ts`      | Seal profile cohorts from fresh Lidarr state. Pass numeric profile ID as a string to avoid ambiguous display-name resolution.                                                                                                                 |
| `actions/lidarr/plan.ts`                      | Seal monitoring cohorts from fresh Lidarr state.                                                                                                                                                                                              |
| `lib/lidarr/plan-engine.ts` and v3 types      | Reuse exact-key validation, canonical sorting, risk/cascade review, checksum generation, private atomic no-overwrite writes, and size caps unchanged.                                                                                         |
| `commands/lidarr-policy.ts`                   | Reuse nested-command registration, in-action validation, lazy action loading, credential redaction, root output ownership, and stdout/stderr separation.                                                                                      |
| policy, sync-ratings, and mutation presenters | Reuse policy explanation/decision-key helpers and `renderMutationPlan`; follow the sync-ratings composition pattern for new summary/refusal/next-step prose.                                                                                  |
| shell templates and `templates.spec.ts`       | Extend Bash, Zsh, and Fish together; bind parity to shared option/mode constants and retain executable Bash nested-routing coverage.                                                                                                          |
| architecture checker                          | Existing rules already reject generated Lidarr imports/re-exports, handwritten API paths, extra fetch owners, and direct mutation ownership. No new allowlist entry is justified.                                                             |

## Modularity Design

Keep four responsibilities explicit:

1. `lib/bridge/policy-plan.ts`: pure, synchronous proposal validation, total projection, conflict
   detection, sorting, deduplication, and freezing. It imports type contracts and closed registries,
   performs no I/O, and never parses or executes `handoff.argv`.
2. `actions/lidarr/policy-plan.ts`: evaluate, project, optionally seal, and return results. It calls
   existing producer actions through an injectable dependency object and acquires no scheduler slot
   of its own.
3. `commands/lidarr-policy.ts`: add the `plan` leaf, validate flags before lazy import, select output
   format, invoke presentation, and own exit codes/failure reporting.
4. Presentation: keep plan-specific cohort/refusal/next-step rendering outside the already-large
   command. Delegate artifact details to `renderMutationPlan` and explanations to the policy
   presenter rather than copying either renderer.

Prefer a small zero-value-import `types/lidarr-policy-plan.ts` if the result contract is substantial;
`types/lidarr-policy.ts` is already large and should remain the evaluation contract. Either location
must use producer-discriminated cohorts:

```ts
type PolicyPlanCohort =
  | { producer: "artist-profile-assignment"; profileId: number; artistIds: readonly number[] }
  | { producer: "artist-monitoring"; monitored: boolean; artistIds: readonly number[] };
```

Avoid the nullable-field shape used by `SyncRatingsCohort`; the generic policy path benefits from
impossible states being unrepresentable. Define a total projector table over the full handoff
vocabulary, including `discovery` as an explicit refusal, and a total sealer table over
`PolicyProducerId`, both with `satisfies Record<...>`. Use an exhaustive switch where TypeScript
needs discriminant correlation; do not hide casts behind a generic registry.

## Build vs Reuse

- **Build:** one pure projector, policy-plan result/refusal/cohort types, one thin action, one command
  leaf, and minimal plan-specific presentation/completion wiring.
- **Reuse unchanged:** evaluation engine/rules/gatherers, identity authority, producer actions, v3
  plan schema, plan writer, apply/history/resume/claims, scheduler, generated client, configuration,
  policy explanation, and mutation-plan rendering.
- **Do not build:** producer plugins, dynamic dispatch, shell execution, an aggregate multi-plan
  artifact, transactional rollback, shared live-state cache, new database tables, apply mode, or
  policy provenance fields inside strict v3 artifacts.

Keeping `sync-ratings` independent is intentional. It owns specialized threshold overrides,
force-enable semantics, decision kill switches, and apply confirmation; extracting a premature
common framework would couple unlike command contracts. Share only a tiny helper later if identical
code exists after implementation.

## Critical Tests Only

1. Pure projector: one profile plus one monitoring proposal yields deterministically ordered,
   correctly typed cohorts; discovery is an explicit refusal; cross-producer conflict withholds the
   artist; malformed producer/subject/target data throws before any consumable projection.
2. Action: recommend mode calls no producer; plan mode calls both producers sequentially with sorted
   IDs, numeric profile binding, desired boolean, and cohort-sized `maxBatch`; preflight failure calls
   neither producer; second-producer failure reports the first sealed artifact through the callback.
3. Command: default mode is review-only, explicit plan mode forwards correctly, invalid rule/mode/cap
   fails before lazy loading, secrets are redacted, and one human plus one machine-output case proves
   the stdout/stderr boundary.
4. Completion: one parity matrix covers policy children, plan options, and mode values across all
   three shells; one live Bash case proves nested routing.
5. Run existing evaluate, producer, plan-engine, architecture, and full package gates. Do not add
   snapshots, golden transcripts, fake Plex/Lidarr end-to-end tests, checksum tests, apply tests, or
   per-shell duplicate cases for already-owned behavior.

## Risks and Recommendations

- Silent filtering is the main safety risk. Assert total accounting:
  `projected proposal keys + refused proposal keys === unique input proposal keys`.
- Do not gate all healthy cohorts on `report.status`; an unrelated skipped rule can degrade the whole
  report. Inspect each selected rule/proposal while preserving the degraded report for review.
- Validate the entire projection before the first write. Runtime producer failure can still leave a
  deterministic artifact prefix; report it immediately and never delete valid evidence as rollback.
- Bind `maxBatch` to the actual cohort but retain the existing 1,000 hard ceiling. Do not split an
  oversized logical cohort to disguise blast radius.
- Producers must re-read live Lidarr state. Evaluation `before` values are evidence, not mutation
  authority.
- Completion and architecture tests are contracts, not optional polish. Update all shells together
  and keep the architecture allowlists unchanged.

## Open Questions

- Should explicit plan mode refuse the entire run when any expected refusal exists, or seal supported
  cohorts while returning a partial/refused status? Choose one format-independent exit contract.
- Should plan-specific types live in the already-large policy type file or a focused zero-import
  sibling? Prefer the sibling unless repository planning fixes the result surface to only a few types.
- Does CSV need new cohort/refusal/artifact row kinds, or can it intentionally remain the embedded
  evaluation projection? Decide before declaring a stable machine schema.
