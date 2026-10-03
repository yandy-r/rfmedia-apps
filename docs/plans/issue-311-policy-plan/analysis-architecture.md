# Architecture Analysis: issue-311-policy-plan

## Executive Summary

Issue #311 is an additive orchestration feature, not a new mutation system. The correct structure is
`command -> orchestration action -> existing evaluator -> pure projector -> existing plan
producers`. `rfmedia lidarr policy plan` defaults to `recommend`, which performs the same live
evidence read as `policy evaluate` but writes no artifact. Explicit `--mode plan` may call the two
existing strict-v3 producers only after a complete projection proves that every selected proposal
is supported, non-conflicting, and accounted for.

The architecture must preserve two distinct fail-closed boundaries. A refusal or malformed
proposal discovered during projection blocks all producer calls, guaranteeing zero artifact writes
for an incomplete selection. Once that global preflight passes, producers run sequentially; if the
second producer fails, the result is `partial` and retains the first immutable artifact rather than
attempting unsafe rollback. Apply remains an independent, ID/checksum-pinned operator command.

## Architecture Context

The existing policy engine already exposes the necessary seam. `PolicyProposal` carries a stable
key, exact subject identity, scalar `before`/`after` maps, evidence, and a `PolicyHandoff` whose
producer is `artist-profile-assignment`, `artist-monitoring`, or inert `discovery`. The closed
`POLICY_RULE_DESCRIPTORS` registry binds rating upgrades to profile assignment, stale monitoring to
artist monitoring, and discovery seeds to no mutation producer.

```text
createLidarrPolicyCommand
  -> plan leaf validates options before lazy import
  -> executeLidarrPolicyPlan
     -> executeLidarrPolicyEvaluate       one live evidence pass
     -> projectPolicyPlan                 pure, exhaustive, deep-frozen
        -> recommend                      return review/no-change/refused
        -> plan + any refusal/error       return refused/failure; zero producers
        -> plan + clean projection
           -> executeLidarrArtistProfilePlan
           -> executeLidarrPlan
              -> buildLidarrMutationPlanV3
              -> writeLidarrPlanArtifact

separate: rfmedia lidarr apply <path>
          --expected-plan-id <id> --expected-plan-checksum <checksum>
```

The projector must never execute or parse `handoff.argv`; it is inert display data containing
library-controlled strings. Routing uses the typed producer discriminator, while authoritative
arguments come from `subject.artistId` and narrowed producer-specific `after` values.

Profile proposals require a positive numeric `after["qualityProfileId"]` and call
`executeLidarrArtistProfilePlan` with `qualityProfile: String(id)`. Numeric lookup resolves before
names and avoids ambiguous display-name authority. Monitoring proposals require boolean
`after["monitored"]` and call `executeLidarrPlan`. Both cohorts pass sorted exact artist IDs and set
`maxBatch` to the cohort size, avoiding the producers' default cap of 25 when policy permits 100
proposals per rule.

The orchestration action acquires no scheduler slot. Evaluation and each producer already schedule
their own `local-only` work; wrapping them in another lane task can deadlock when concurrency is
one. Producer re-reads are intentional: the evaluation report supplies intent, while fresh Lidarr
state supplies artifact authority.

## Critical Files Reference

| File                                                                | Architectural role and required integration                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/lidarr-policy.ts`                   | Existing proposal, handoff, rule registry, report, and evaluate option contracts; do not overload with the new result surface.            |
| `packages/rfmedia-cli/src/types/lidarr-policy-plan.ts`              | New zero-value-import mode/status/cohort/refusal/outcome contract and plan option constants.                                              |
| `packages/rfmedia-cli/src/types/index.ts`                           | Add type/constant barrel exports without importing runtime action/lib graphs.                                                             |
| `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts`                | New pure total projector and `PolicyPlanProjectionError`; sole owner of producer-specific narrowing, conflicts, ordering, and accounting. |
| `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`        | Reused unchanged; remains the only evidence-gathering edge and must remain plan-writer-free.                                              |
| `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts`            | New impure composer; owns mode gate, dependency injection, sequential producer dispatch, cancellation checkpoints, and partial outcomes.  |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`   | Existing profile producer; fresh artists/profiles, numeric reference resolution, v3 build/write.                                          |
| `packages/rfmedia-cli/src/actions/lidarr/plan.ts`                   | Existing monitoring producer; fresh exact-ID artists, v3 build/write.                                                                     |
| `packages/rfmedia-cli/src/actions/lidarr/index.ts`                  | Lazy command-facing export for the new action and dependencies.                                                                           |
| `packages/rfmedia-cli/src/commands/lidarr-policy.ts`                | Add `plan` after `evaluate`; reuse non-throwing rule parsing and in-handler validation; extend the narrowed lazy action interface.        |
| `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`      | Own all human output and CSV projection; render full review/refusal/artifact accounting without contaminating stdout.                     |
| `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` | Handwritten nested command routing; add plan options and `recommend plan` values in lockstep.                                             |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`  | Exact Commander/completion parity and executable Bash routing contract.                                                                   |

`types/lidarr-plan.ts`, `lib/lidarr/plan-engine.ts`, operation definitions, apply, history, claims,
OpenAPI/generated code, config, and database schema are explicit non-touch areas.

## Cross-Cutting Concerns

- **Total accounting:** each unique selected proposal key appears exactly once in a cohort or
  refusal. Duplicate keys, producer/descriptor mismatch, missing artist IDs, and wrong `after`
  scalar types are invariant errors. Discovery and incompatible same-artist intents are explicit
  refusals. No `filter`-and-forget path is acceptable.
- **Global preflight:** recommend mode may return refusals as review data. Plan mode checks the
  complete projection before producer dispatch; any refusal or invariant error yields zero writes.
- **Partial durability:** after clean preflight, producers run in `POLICY_PRODUCER_IDS` order. A
  second-producer failure returns completed outcome metadata and `partial`; it does not delete the
  first file. An `onPlanSealed` seam can expose each completed artifact immediately.
- **Artifact integrity:** existing producers canonicalize v3 facts, derive cascade analysis, compute
  SHA-256, validate exact keys, and use the private atomic no-overwrite writer. Policy provenance
  stays in the wrapper report because the strict v3 schema cannot accept extra keys.
- **Output contract:** human bytes go to stderr; JSON/YAML/CSV emit one prose-free versioned report
  on stdout. Never truncate proposal keys, paths, plan IDs, checksums, refusal codes, or remedies.
  The command catch path must redact Plex and Lidarr credentials.
- **Determinism:** freeze results; order cohorts and artifacts by `POLICY_PRODUCER_IDS`, then desired
  scalar; sort unique artist IDs and decision keys. Stable order makes review, tests, and partial
  failures predictable.
- **Performance:** evaluate once. Accept producer-owned fresh rereads even though two cohorts mean
  two artist-list reads and one profile-list read. The proposal set is bounded; no new cache or
  concurrency mechanism is justified.
- **Compatibility:** preserve `policy evaluate` behavior and exit semantics. The policy child tree
  becomes `["evaluate", "plan"]`; the top-level Lidarr order is unchanged. `sync-ratings` remains
  separate because it owns rating-specific tri-state and apply behavior.

## Parallelization Opportunities

Work can proceed in three dependency-aware streams with disjoint ownership:

1. **Contracts/projector:** create `lidarr-policy-plan.ts`, `policy-plan.ts`, and focused pure tests.
   This is the critical path because action, presenter, and command compile against these unions.
2. **Completion parity:** prepare Bash/Zsh/Fish routing and template-spec changes once option names
   and mode constants are fixed. The three templates should be owned together to avoid drift.
3. **Documentation:** update the feature guide, README, and ROADMAP against the accepted CLI/result
   contract without touching source modules.

After stream 1 lands, split action orchestration from command/presenter work: the action owner uses
dependency injection and producer calls; the command owner handles lazy loading, validation,
rendering, and command tests. Do not parallelize edits within `lidarr-policy.ts` or
`lidarr-policy-presenter.ts`, and do not split shell files from their parity test across owners.

Validation is a final convergence step: focused projector/action/command/completion tests first,
then package typecheck/build/test, architecture guards, formatting, and markdown checks.

## Implementation Constraints

1. The new contract file must use zero value imports; command startup must not pull in the evaluator,
   adapters, Lidarr client, database, or plan engine.
2. Commander validation must occur inside `.action()` before `loadActions()`. Do not use throwing
   `.choices()`/argument parsers that bypass the standard failure envelope.
3. `--mode` is exactly `recommend|plan`, default `recommend`. Do not add apply, yes, dry-run,
   threshold overrides, proposal selection, output directory, or a single plan-file option.
4. Plan mode must finish projection and reject any refusal before the first producer call. Test
   this with discovery, conflicts, and malformed producer data.
5. Bind profile intent by positive numeric ID, monitoring by boolean, and artist identity by positive
   Lidarr ID. Names, argv text, and evaluation `before` state are never authority.
6. Set producer `maxBatch` to exact cohort cardinality and enforce existing 1..1,000 bounds before
   dispatch. Never produce an empty artifact.
7. Do not create a wrapper scheduler task, directly resolve a Lidarr client, import generated code,
   construct editor bodies, call mutation methods, or invoke apply.
8. Preserve the verbatim deep-frozen evaluation report in the versioned policy-plan result. Keep
   decision-key-to-artifact correlation outside the v3 artifact.
9. A producer failure after earlier success must return/report a typed partial outcome; rollback
   deletion is prohibited.
10. Add only critical projection, refusal, zero-write, routing, partial-result, and completion tests.
    Existing plan-engine/apply suites already own checksum, storage, drift, claims, and mutation
    behavior.
