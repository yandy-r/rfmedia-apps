# Practices Research: Policy Decision Overrides

## Executive Summary

The smallest safe implementation is a suppression-only `policy.overrides` map plus one pure
post-cap classification pass in the policy engine. Keep the existing stable decision key, compute a
separate versioned SHA-256 fingerprint from an explicit semantic tuple, and remove both matching
and stale disputed proposals from the single actionable `report.proposals` collection. That makes
evaluate, policy-plan, and sync-ratings agree without three filters or any new mutation authority.

Two boundaries matter more than additional abstraction: invalid override configuration must fail
closed for policy/plan/sync commands instead of falling through to empty config, and the new report
shape must distinguish evaluator skips from operator suppressions. No database, management command,
canonical-JSON dependency, rule plugin, action strategy, or plan-artifact schema is needed.

## Existing Reusable Code

| Module/Utility            | Location                                                                                                                            | Purpose                                                                   | How to Reuse for This Feature                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Stable key builders       | `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts` (`policyArtistKey`, `policyPlexKey`)                                   | Own the shipped non-rotating proposal identity                            | Leave their output unchanged; overrides use these exact keys rather than adding a second identity system                           |
| Proposal factories        | `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts` (`createPolicyProposal`, `createPolicySeedProposal`)                   | Sole construction and deep-freezing boundary for proposals                | Attach the computed fingerprint here once; do not recalculate evidence in individual rules                                         |
| Pure engine assembly      | `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts` (`runLidarrPolicyEvaluation`)                                                | Applies caps, orders decisions, builds counts, and freezes the report     | Run one override classification after caps/refusal attribution and before final counts/status                                      |
| Config primitives         | `packages/rfmedia-cli/src/lib/config.ts` (`rejectUnknownConfigKeys`, `requirePolicyConfigObject`, `validateString`, `describeType`) | Exact-key validation with dotted `ConfigError.propertyPath` contracts     | Extend the inline policy validator; do not extract or duplicate the general config framework in this feature                       |
| Loaded policy seam        | `packages/rfmedia-cli/src/lib/loaded-config.ts` (`getLoadedPolicyConfig`)                                                           | Supplies the same raw policy config to evaluate and sync flows            | Add `overrides` to `PolicyConfigOptions`; every existing consumer receives it without a store or new loader module                 |
| Evaluation CSV projection | `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` (`projectPolicyEvaluationCsv`)                                       | Shared evaluation rows embedded in policy-plan and reused by sync-ratings | Add explicit override rows and columns once; keep using the repository formatter's CSV formula guard for operator-authored reasons |
| Explain delegation        | `policyDecisionKeys` and `renderPolicyExplain` in `lidarr-policy-presenter.ts`                                                      | Gives evaluate and sync-ratings the same decision lookup/explanation      | Include suppressed/stale keys and render disposition here, preserving sync-ratings delegation                                      |
| Plan projection           | `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts` (`projectPolicyPlan`)                                                          | Projects only `report.proposals`                                          | No override matcher belongs here; central filtering is sufficient                                                                  |
| Ratings projection        | `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts` (`buildRatingSyncPlan`)                                                        | Projects selected rules from only `report.proposals`                      | No second matcher belongs here; add only focused regression coverage                                                               |
| Built-in hashing          | Node `node:crypto`                                                                                                                  | SHA-256 already used throughout plan and queue code                       | Use `createHash("sha256")`; add no package                                                                                         |

The private `canonicalJsonStringify` in `lib/lidarr/deferred-queue.ts` should not be exported for this
feature. It is coupled to arbitrary deferred payloads, while policy evidence has a small fixed
schema. Reusing it would create a cross-domain dependency and make accidental future fields part of
the fingerprint.

## Modularity Design

### Recommended Module Boundaries

Before, the engine has one flow:

```text
rules -> caps/refusal attribution -> proposals/skips -> counts/report -> presenters/plan/sync
```

After, add one feature-specific pure module and one engine step:

```text
rules -> caps/refusal attribution -> policy-overrides.ts -> actionable proposals + override results
                                               -> counts/report -> presenters/plan/sync
```

- Create `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`. Keep the explicit fingerprint
  projection and pure classification together: they are two small operations over the same feature
  vocabulary, and splitting them into separate services/interfaces adds navigation without an
  independent consumer.
- Add focused tests in `policy-overrides.test.ts`. Test the hash contract and classification as pure
  functions; leave provider fixtures out.
- Keep config types in `types/config.ts` and report/disposition types in `types/lidarr-policy.ts`.
  This preserves the current distinction between operator input and resolved report output.
- Keep matching out of rules, presenters, `policy-plan.ts`, and `rating-sync.ts`. Those layers should
  consume the one authoritative actionable collection.

The classification pass should receive the already capped proposals/skips and validated overrides,
then return frozen `{ proposals, results }`. It should use `Map` for lookup, not assignment into a
plain `{}` with operator-controlled keys. A configured proposal key can match a skip safely with
the generated-key prefix relation between the override key and `skip.key`; it must never turn that
skip into a proposal.

### Shared vs. Feature-Specific Code

| Component                           | Shared or Feature-Specific            | Rationale                                                                          |
| ----------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| Key builders and proposal factories | Shared existing policy code           | They already define proposal identity and construction                             |
| Fingerprint material and hash       | Feature-specific policy override code | Its version and field set are a public review contract, not a general JSON utility |
| Override classifier                 | Feature-specific policy override code | One engine consumer today; a generic disposition framework would be premature      |
| Config primitive validation         | Shared existing config code           | Exact errors and type descriptions must stay consistent                            |
| Override entry validation           | Feature-specific inline config code   | Dynamic decision-key grammar, hash, and rationale bounds do not generalize yet     |
| Override human/CSV rendering        | Shared policy presenter function      | Evaluate, policy-plan, and sync-ratings all embed the same evaluation state        |
| Suppression in plan/sync            | Shared through `report.proposals`     | Re-filtering in consumers creates bypass and disagreement risks                    |

## KISS Assessment

| Area                    | Current Proposal                                                             | Simpler Alternative                                                                                                              | Trade-off                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Durable state           | Config or local store                                                        | Use `.rfmedia.yaml` only                                                                                                         | Manual edits are acceptable for v1; avoids migrations, precedence, permissions, and write commands                         |
| Override actions        | Ambiguous suppress/override surface                                          | Literal `action: "suppress"` only                                                                                                | No forced verdicts; future actions require an explicit contract change                                                     |
| Fingerprinting          | Generic recursive canonical JSON/JCS                                         | Hash an explicit nested tuple with sorted entries only for `before`, `after`, and `observations`                                 | Less reusable, but the evidence contract is reviewable and cannot absorb fields accidentally                               |
| Module layout           | Separate fingerprint service, classifier service, repositories, strategies   | One pure `policy-overrides.ts` module                                                                                            | Re-split only if another consumer needs fingerprinting independently                                                       |
| Status taxonomy         | `suppressed`, `stale`, `unmatched`, `not-evaluated` plus multiple gates      | Use `suppressed`, `stale`, and `not-evaluated`; put `evidence-changed`, `outcome-changed`, or `decision-absent` in `staleReason` | Avoids treating absence as a fourth top-level lifecycle while still preventing false staleness for narrowed/disabled rules |
| Stale consumer behavior | Let stale proposals through, then add plan-global and sync-decision refusals | Withhold stale proposals centrally and make stale trip `--fail-on proposals`                                                     | More conservative, much less code, and cannot silently mutate disputed evidence                                            |
| Skip fingerprints       | Fingerprint proposals and every skip                                         | Fingerprint proposals only                                                                                                       | A skip is never a valid override target; current skip prefix is sufficient to report outcome change                        |
| Override limits         | New arbitrary 500-entry subsystem limit                                      | Rely on the existing global config-size bound; add a count ceiling only if an acceptance/performance measurement requires it     | Avoids a policy number with no operational basis                                                                           |
| CLI management          | Add accept/remove/list commands                                              | Document copy/edit/re-run workflow                                                                                               | Manual reviewable config fully satisfies the issue                                                                         |

Stale fail-closed behavior resolves the other artifacts' disagreement with less machinery. A changed
fingerprint remains visible as stale, is not considered an active suppression, but also cannot
reach an existing producer until the operator updates or removes the record. This is safer than
silently reactivating the proposal and simpler than teaching plan and sync two different refusal
policies.

## Abstraction vs. Repetition

### Extract (Worth Abstracting)

- Central override classification: evaluate, policy-plan, and sync-ratings are already three
  consumers of `report.proposals`; one engine-owned filter prevents three implementations.
- Shared override rendering inside `lidarr-policy-presenter.ts`: export one small renderer so the
  policy-plan and sync-ratings presenters expose the same status and rationale.
- A small local `sortedEntries` helper inside `policy-overrides.ts`: it is used for the three record
  fields in the evidence tuple and makes property insertion order irrelevant.

### Repeat (Acceptable Duplication)

- Keep plan checksum canonicalizers and deferred-queue canonical JSON private. Their semantics are
  different from policy evidence, so unifying them would produce a misleading abstraction.
- One assertion in each of `policy-plan.test.ts` and `rating-sync.test.ts` that override-withheld
  proposals do not enter cohorts is useful boundary duplication; do not build a shared fixture DSL
  solely for those two tests.
- Leave the inline policy validator in `config.ts`. The original #209 design explicitly deferred
  extracting config primitives because that refactor touches many unrelated call sites.

## Interface Design

### Public API Surfaces

Keep the surface data-oriented and closed:

```ts
interface PolicyOverrideConfigOptions {
  readonly action: "suppress";
  readonly evidenceFingerprint: `sha256:${string}`;
  readonly reason: string;
}

type PolicyOverrideStatus = "suppressed" | "stale" | "not-evaluated";
type PolicyOverrideStaleReason = "evidence-changed" | "outcome-changed" | "decision-absent";

interface PolicyOverrideResult {
  readonly key: PolicyDecisionKey;
  readonly status: PolicyOverrideStatus;
  readonly staleReason: PolicyOverrideStaleReason | null;
  readonly action: "suppress";
  readonly reason: string;
  readonly expectedEvidenceFingerprint: string;
  readonly currentEvidenceFingerprint: string | null;
  readonly decision: PolicyProposal | PolicySkip | null;
}

function fingerprintPolicyProposal(proposal: PolicyProposalEvidence): string;

function classifyPolicyOverrides(input: {
  readonly proposals: readonly PolicyProposal[];
  readonly skips: readonly PolicySkip[];
  readonly rules: readonly PolicyRuleResult[];
  readonly overrides: Readonly<Record<string, PolicyOverrideConfigOptions>> | undefined;
}): {
  readonly proposals: readonly PolicyProposal[];
  readonly results: readonly PolicyOverrideResult[];
};
```

`PolicyEvaluationReport` should add `overrides`, proposal fingerprints, and summary counts for
`suppressed`, `staleOverrides`, and `notEvaluatedOverrides`. `proposed` and per-rule
`proposedCount` must mean actionable proposals after classification. Because this changes a machine
report and the meaning of its counts, bump the evaluation schema/engine version rather than adding
fields under the v1 label. Policy-plan and sync-ratings outer schemas need not change solely because
their nested evaluation moved to v2.

The fingerprint input should be an explicit tuple containing:

```text
schema, key, ruleId, code,
[subject kind, plexId, artistId|null, artistMbid],
[identity category, reason],
sorted before entries, sorted after entries,
checks in evaluation order as scalar tuples,
observations sorted by signal as explicit observed/unavailable tuples,
handoff producer
```

Exclude `evaluatedAt`, origins, subject display name, summary/detail prose, report ordering, and
`handoff.argv`. This keeps display edits and cohort batching from rotating a review pin while
ratings, plays, thresholds, identity, current/desired state, and producer changes do rotate it.

### Extension Points

The only extension point v1 needs is the literal `action` union in config/result types. Do not add
an action-handler registry for one action. A future second or third safe action can widen the union
and introduce discriminated payloads; until then, a closed literal makes unsupported behavior a
compile-time and validation error.

## Testability Patterns

### Recommended Patterns

- Pure tuple projection: pin one exact fingerprint fixture, then prove property-order independence
  and rotation for material evidence without mocking crypto.
- Table-driven classifier tests: no override, exact match, evidence change, outcome-to-skip,
  decision absence, and rule not evaluated. Assert deterministic key order and frozen results.
- Engine integration: prove active and stale rows are absent from `report.proposals`, present in
  `report.overrides`, counts agree, cap survivors are not refilled, and `shouldFailPolicyEvaluation`
  trips on stale but not active suppression.
- Validator contracts in `lib/config.test.ts`: valid retention; malformed proposal key (including a
  four-segment skip key), unknown field/action, invalid hash, blank/unsafe rationale, and exact
  dotted paths.
- Strict-loading regression: an invalid highest-priority override config must abort policy
  evaluate/plan/sync rather than fall through to a lower-priority or empty config.
- One projection test per downstream consumer: an override-only evaluation yields no policy-plan or
  sync-ratings cohort. Existing no-change action tests should continue proving zero producer/apply
  calls; do not duplicate those action tests unless the control flow changes.
- Presenter contract: human output shows overrides without `--verbose`; CSV has explicit override
  rows and relies on the shared formula guard; `--explain` accepts a suppressed/stale key. JSON/YAML
  need only a schema fixture because the common serializers already preserve nested data.
- Architecture and completion audit: policy types retain zero value imports, the direct-import
  ownership gate stays green, and Bash/Zsh/Fish parity passes with no template changes.

### Anti-patterns to Avoid

- Snapshotting every hash permutation: test material/non-material boundaries, not Node crypto.
- Mocking plan/apply clients in every classifier case: the pure engine/projection seams already
  establish non-mutation.
- Reconstructing proposal evidence from provider inputs: hash the frozen proposal emitted by the
  sole factories so tests and runtime use identical facts.
- Mutating report arrays after construction: return new frozen arrays and recount once.
- Treating suppressed proposals as `PolicySkip`: operator judgment is not evaluator truth.

## Build vs. Depend

| Need                    | Build Custom                    | Use Library                       | Recommendation | Rationale                                                    |
| ----------------------- | ------------------------------- | --------------------------------- | -------------- | ------------------------------------------------------------ |
| YAML config             | Existing validator work only    | Existing `js-yaml`                | Reuse existing | No parser or store dependency is needed                      |
| SHA-256                 | One `createHash` call           | Node built-in `node:crypto`       | Use built-in   | Supported runtime already provides it                        |
| Canonical evidence      | Small explicit tuple projection | JCS/stable-stringify package      | Build local    | Fixed schema is clearer and avoids dependency/semantic drift |
| Durable override store  | `.rfmedia.yaml` field           | SQLite/JSON store library         | Reuse config   | Avoids writes, migrations, precedence, and recovery logic    |
| Matching/classification | Two maps and one pass           | Rules/workflow engine             | Build local    | The state machine is small and closed                        |
| CSV safety              | Existing machine formatter      | New escaping/sanitization package | Reuse existing | Formula guarding and escaping are already centralized        |

## Completion Audit

- Acceptance 1: a validated `.rfmedia.yaml` entry targets one existing proposal key and one evidence
  fingerprint; v1 exposes only durable suppression.
- Acceptance 2: report v2, human output, CSV, JSON/YAML, and `--explain` distinguish evaluator skips,
  active suppressions, stale overrides, and not-evaluated config.
- Acceptance 3: both active and stale disputes are removed before the existing plan/sync projectors;
  evaluate remains pure and no new client/store writer exists.
- Acceptance 4: docs show copy-fingerprint/edit/re-run/review-stale workflow; focused tests pin key
  stability, evidence rotation, classification, and downstream exclusion.
- Configuration safety: add a strict/fail-on-invalid option to `loadConfig` and select it in the CLI
  pre-action hook for `lidarr policy` and `lidarr sync-ratings`. The current loader logs a
  `ConfigError` and falls through to empty config, which could silently discard a suppression and
  must not govern an override-sensitive mutation flow.
- Contract audit: bump only the policy evaluation contract; do not change sealed Lidarr plan v3,
  database schemas, rule semantics, provider interfaces, or tracking state.
- Completion audit: no CLI option is added, so Bash/Zsh/Fish templates must remain unchanged; run
  the parity suite and state that audit explicitly.
- Documentation: update
  `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`,
  `packages/rfmedia-cli/README.md`, and the existing example policy block if one is already
  maintained. Do not add a config writer or uncommented generated default.

## Open Questions

None block a suppression-only v1. The implementation should record these choices explicitly:

1. Stale proposals are withheld centrally and fail `--fail-on proposals`; they do not silently
   reactivate and do not need separate plan/sync refusal algorithms.
2. Overrides for rules skipped as `not-selected` or `disabled` are `not-evaluated`, not falsely
   stale. A selected rule that ran but emitted no subject decision is `stale: decision-absent`.
3. Reason and key length/control-character bounds should follow the smallest terminal-safe local
   validator; do not create a repository-wide text-sanitization refactor in this issue.
