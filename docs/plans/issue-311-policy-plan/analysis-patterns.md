# Pattern & Code Analysis: issue-311-policy-plan

## Executive Summary

The repository already implements every layer needed by `rfmedia lidarr policy plan` except the
generic proposal-to-producer projection. The closest end-to-end precedent is `lidarr sync-ratings`:
it consumes the frozen policy report, projects it in a pure bridge module, orchestrates existing
plan producers without nesting a scheduler slot, and composes existing policy/mutation presenters.
Issue #311 should copy those boundaries while deliberately omitting ratings-specific thresholds,
force-enable behavior, confirmation, and apply.

The feature spec fixes two stronger requirements than `sync-ratings`: projection is total across the
selected report, and any refusal blocks all sealing. Implement those as a complete pure preflight,
then call the unchanged profile and monitoring producers sequentially. No generated-client, plan
engine, operation definition, apply, configuration, or database code needs to change.

## Implementation Patterns

### Pure projector

Use `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts` as the structural template for the new
`packages/rfmedia-cli/src/lib/bridge/policy-plan.ts`:

- Define a named projection error carrying the offending decision key, following
  `SyncRatingsProjectionError`.
- Read `PolicyEvaluationReport` only; do not call the policy engine/rules or perform I/O.
- Validate indexed `before`/`after` values with bracket access and `typeof` narrowing.
- Treat expected safety gates as frozen refusal data, but throw for impossible engine contracts.
- Detect same-artist conflicts before finalizing cohorts, sort/deduplicate IDs, and freeze every
  returned collection.
- Preserve deterministic producer order with `POLICY_PRODUCER_IDS` from
  `packages/rfmedia-cli/src/types/lidarr-policy.ts`.

`PolicyHandoff.producer` is `PolicyProducerId | "discovery"`; therefore routing must be exhaustive
over all three current values. A `satisfies Record<PolicyHandoff["producer"], Projector>` map makes a
future handoff fail compilation until handled. Producer-specific cohort types should be a
discriminated union rather than a shared object with nullable target fields. Use an exhaustive
switch at call sites where TypeScript cannot preserve key/value correlation through a generic map.

Unlike `buildRatingSyncPlan`, `projectPolicyPlan` must walk every selected proposal, assert unique
decision keys, cross-check `proposal.ruleId` against `POLICY_RULE_DESCRIPTORS`, and produce exactly
one cohort membership or refusal per key. The full projection completes before the action tests the
global refusal gate.

### Thin action orchestration

Model `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts` on
`packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`:

- Declare an injectable dependency object for evaluation, projection, and both producers; use a
  frozen real default and a `satisfies`-checked mock harness in tests.
- Acquire no scheduler slot. `executeLidarrPolicyEvaluate`, `executeLidarrArtistProfilePlan`, and
  `executeLidarrPlan` already acquire `local-only`; wrapping them can deadlock at concurrency one.
- Forward the exact rule selection, proposal cap, raw Plex/Lidarr overrides, and cancellation signal
  to evaluation. Do not force-enable rules.
- Return immediately in `recommend` mode and whenever plan-mode preflight has a refusal.
- Order cohorts with `POLICY_PRODUCER_IDS`, validate `1..LIDARR_PLAN_MAX_BATCH`, and bind
  `maxBatch` to each cohort's actual size.
- Call producers sequentially. Invoke `onPlanSealed` immediately after each successful producer so
  an artifact remains visible if the next producer fails.

Reuse `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts` with
`qualityProfile: String(qualityProfileId)` and `packages/rfmedia-cli/src/actions/lidarr/plan.ts` with
the narrowed boolean. Both re-read current Lidarr state and return the exact `{ planPath, plan }`
shape consumed by the mutation presenter.

### Command and presenter

Extend the existing parent in `packages/rfmedia-cli/src/commands/lidarr-policy.ts` by adding a
`createPlanCommand` beside `createEvaluateCommand`, preserving child order `evaluate`, then `plan`.
Follow its conventions:

- Commander `argParser` may accumulate repeatable comma-separated `--rule` values but must not throw;
  validate mode, selection, and caps inside `.action()` before `loadActions()`.
- Keep actions lazily imported through the narrowed action-barrel interface.
- Inherit root `--output`/`--json`; never redeclare them.
- Send credentials to `reportLidarrFailure(..., sensitiveValues)` and let the command own
  `process.exitCode` after rendering.
- Human output goes only to stderr; JSON/YAML/CSV go only through lazy `formatOutput` on stdout.

`packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` already owns policy evaluation, CSV
projection, decision-key enumeration, and `--explain`. Add plan-specific render/projection entry
points there as the spec requires, but compose rather than duplicate:

- Delegate causal detail to `renderPolicyExplain`/`policyDecisionKeys`.
- Render each sealed artifact through `renderMutationPlan` from
  `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`, ideally from `onPlanSealed`
  before a later producer can fail.
- Follow `packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts` for the 20-row cap,
  refusal tables, explicit write-scope text, exhaustive mode switch, and pinned next commands.
- Do not include `--yes` in suggested apply commands; this command creates evidence but grants no
  apply consent.

## Existing Code Structure

| Layer                   | Existing source                                                                                                      | Issue #311 use                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Policy contract         | `packages/rfmedia-cli/src/types/lidarr-policy.ts`                                                                    | Reuse rules, descriptors, handoffs, decisions, bounds, and producer order.                          |
| New result contract     | `packages/rfmedia-cli/src/types/lidarr-policy-plan.ts`                                                               | Add zero-value-import modes, discriminated cohorts, refusals, statuses, outcomes, and option-longs. |
| Proposal creation       | `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts`                                                         | Trust its branded identity and frozen handoff construction; do not alter it.                        |
| Projection precedent    | `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts`                                                                 | Mirror pure validation/refusal/conflict/freeze patterns, not ratings semantics.                     |
| Evaluation              | `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`                                                         | Reuse unchanged as the one evidence pass.                                                           |
| Orchestration precedent | `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`                                                            | Mirror DI, mode gate, ordering, cap binding, and sealed callback.                                   |
| Producers               | `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`; `packages/rfmedia-cli/src/actions/lidarr/plan.ts` | Reuse unchanged for fresh-state strict v3 artifacts.                                                |
| Action barrel           | `packages/rfmedia-cli/src/actions/lidarr/index.ts`                                                                   | Export the new action/options/dependencies for lazy loading.                                        |
| Command/presenter       | `packages/rfmedia-cli/src/commands/lidarr-policy.ts`; `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` | Add the leaf and presentation without importing the Lidarr parent.                                  |
| Type barrel             | `packages/rfmedia-cli/src/types/index.ts`                                                                            | Export the new public contract without leaking generated types.                                     |

## Code Conventions

- Source modules use `.js` import specifiers, `readonly` contracts, `Object.freeze`, named errors,
  and JSDoc for public seams and non-obvious invariants.
- Type modules statically imported by commands allow no value imports from actions/libs and should
  use type-only imports for `PolicyEvaluationReport` and v3 plan result shapes.
- Closed vocabularies are `as const` tuples with derived union types and narrowing guards; total
  associations use `satisfies Readonly<Record<...>>`.
- Actions perform I/O and return data; commands render and set exit codes; presenters never write to
  stdout; pure bridge modules import no clients, adapters, database, scheduler, or clock.
- Stable machine schemas need explicit version constants and deterministic ordering. Human row
  truncation must not truncate machine accounting, decision keys, artifact paths, IDs, or checksums.
- Error validation belongs inside command action handlers so failures use the normal redacted machine
  envelope rather than Commander's process-exiting parser path.

## Integration Points

- Extend `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts` using its existing harness for
  child/option surfaces, validation-before-load, redaction, and output separation.
- Add pure cases in `packages/rfmedia-cli/src/lib/bridge/policy-plan.test.ts`, following literal
  frozen fixtures in `rating-sync.test.ts`: supported cohorts, discovery refusal, conflict refusal,
  total accounting, and malformed invariant failure.
- Add action cases in `packages/rfmedia-cli/src/actions/lidarr/policy-plan.test.ts`, following the
  `satisfies LidarrSyncRatingsDependencies` harness: zero-write default, global refusal gate, exact
  producer arguments/order, and partial second-producer failure.
- Update `packages/rfmedia-cli/src/lib/shell-completions/bash.ts` with a second policy operation,
  plan-only option list, mode values, and nested routing.
- Update the policy case in `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts` and add a distinct
  plan-active predicate/options in `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`.
- Extend `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: update
  `lidarrCommandTree.policy`, bind long options to a shared plan option constant, compare mode values
  across all shells, and execute the Bash `policy plan` route.
- Run the existing architecture gate in `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`;
  its current rules should pass without allowlist edits because the new files call actions, not the
  generated SDK, fetch, handwritten API paths, or mutation facade methods.

## Gotchas and Warnings

- `discovery` is in `PolicyHandoff.producer` but not `POLICY_PRODUCER_IDS`; never cast it into a
  mutation producer or reinterpret it as `artist-add`.
- `report.rules` is an array, not a rule-keyed record. `before`/`after` are scalar index-signature
  records, so dot access or unchecked casts can conceal malformed proposals.
- A degraded aggregate report can contain a healthy narrowed rule. Use per-rule results, while still
  returning the complete evaluation evidence.
- Any refusal blocks all plan-mode producers under the finalized spec; do not copy sync-ratings'
  behavior of sealing a healthy sibling beside a refused cohort.
- Producer defaults cap at 25 while evaluation allows 100 proposals per rule. Omitting cohort-sized
  `maxBatch` causes valid large reviews to fail only at sealing time.
- Multiple artifacts are not transactional. Preflight prevents known partial writes, but a later
  I/O/live-state failure must return typed partial metadata and must not delete the earlier artifact.
- Do not wrap the composed actions in `runSingle`, execute `handoff.argv`, copy evaluation `before`
  state into artifacts, add policy fields to strict v3 plans, or add an apply shortcut.
- Bash, Zsh, and Fish are independent static implementations; updating Commander help alone does
  not update completion behavior.
