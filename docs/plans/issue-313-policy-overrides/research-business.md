# Issue 313 Business Logic Research

## Executive Summary

Issue [#313](https://github.com/yandy-r/rfmedia-apps/issues/313) should add a durable,
reviewable veto for one policy **proposal** without weakening the rule that produced it or granting
mutation authority. The narrow contract is a config-backed override whose only initial verdict is
`suppress`, pinned to both the existing non-rotating decision key and a rotating evidence digest;
an exact match suppresses the proposal, while changed or missing evidence makes the override stale
and unable to authorize or silently hide anything.

This interpretation follows issue #209 design sections 2.5 and 15: `verdict: suppress` was the
explicitly deferred surface, while rule-semantic changes, recency, and new entity kinds remain out
of scope. It also preserves issue #311's review/seal/apply separation and the specialized
`sync-ratings` safety ladder.

## User Stories

- As a library operator, I can record why one proposal is disputed without weakening a threshold
  for every artist.
- As a reviewer, I can see the configured veto, the exact evidence it was approved against, and
  whether it is still effective.
- As an automation user, I can distinguish actionable proposals, actively suppressed proposals,
  ordinary rule skips, and stale overrides in human and machine output.
- As an operator using `policy plan` or `sync-ratings`, I can trust that an active suppression is
  never projected and that stale suppression state cannot be silently carried into a mutation.

## Business Rules

### Durable override contract

Use `.rfmedia.yaml` as the initial durable store. It is already the reviewable, strictly validated
policy source and avoids a database schema, hidden local-state precedence, or a second management
workflow. The minimal conceptual shape is:

```yaml
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      verdict: suppress
      evidenceHash: "sha256:<64 lowercase hex characters>"
      reason: "Compilation-only listening makes the Plex play rollup misleading"
```

Rules for this state are:

1. The map key must be an existing three-segment **proposal** key:
   `<ruleId>:artist:<lidarrId>` or `<ruleId>:plex:<plexId>`. Four-segment skip keys are rejected.
2. `suppress` is the only v1 verdict. “Override” names the durable record; it does not mean force a
   skip into a proposal, replace `before`/`after`, choose a custom producer, or bypass a rule gate.
3. `evidenceHash` is required. A key alone is intentionally insufficient because keys do not rotate
   when thresholds or observations change.
4. `reason` is required, non-empty operator rationale. Unknown fields and verdicts fail config
   validation with the exact dotted property path, matching current policy validation.
5. Override application is a pure post-evaluation classification. The underlying evaluator still
   emits its original proposal or skip; the override layer neither changes inputs nor manufactures
   a decision.

### Key stability and evidence identity

- The existing key remains canonical. Artist proposals use `ruleId + Lidarr artist id`; Plex-only
  discovery proposals use `ruleId + Plex rating key`. Input ordering, unrelated additions, report
  timestamps, threshold edits, and cohort reshuffling must not change it.
- A Lidarr/Plex database rebuild that changes provider ids creates a new decision key. The old entry
  becomes stale/orphaned; it must not migrate by display name.
- Reuse of the same numeric provider id for a different artist is detected by the evidence digest,
  not treated as the old dispute.
- The versioned digest covers the material proposal evidence: rule and decision code; subject name
  and identifiers; identity category/reason; `before` and `after`; ordered threshold checks;
  observations including value, join grade, and sample size; and handoff producer. It excludes
  evaluation time, origins, report order/status, prose summary, and cohort-wide `handoff.argv`.
  Canonical object-key ordering makes it stable across serialization and library traversal order.

### Override classification

Every configured override is reported exactly once:

| Current state                              | Classification            | Proposal behavior                                                                                                |
| ------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Same proposal key and same evidence hash   | `suppressed`              | Removed from actionable `proposals`; preserved as a distinct suppressed row with original evidence and rationale |
| Same proposal key, different evidence hash | `stale: evidence-changed` | Current proposal remains actionable; stale record is reported with expected and current hashes                   |
| Same base key now resolves to a skip       | `stale: outcome-changed`  | Skip remains visible; override does not hide or reverse it                                                       |
| No current proposal/skip for the base key  | `stale: decision-absent`  | Nothing is fabricated; the orphaned config entry remains visible for cleanup                                     |

Suppressed rows are not `PolicySkip` rows and do not acquire a skip code: a rule produced a valid
proposal and the operator vetoed it afterward. Existing skips remain “data, never omissions.”
Summary and per-rule accounting must expose separate `suppressed` and `staleOverrides` counts;
`proposed` counts only actionable proposals. Existing `clean | proposals | degraded` evaluation
meaning can remain intact: an all-suppressed run is clean of actionable proposals, while stale
state is disclosed through its explicit count/rows rather than masquerading as a provider failure.
`--fail-on proposals` therefore trips only for remaining proposals (and existing degraded reports),
not for a valid suppression.

### Edge cases

- A threshold or CLI override changes a check bound and therefore the evidence hash even when the
  subject still qualifies; the decision key stays stable and the suppression becomes stale.
- A play/rating value, join grade, sample size, identity basis, current Lidarr state, or desired
  target change also makes the suppression stale.
- Pure ordering changes, timestamps, origin formatting, summary wording, and producer cohort argv
  batching do not make it stale.
- A suppressed discovery seed is valid even though it has no Lidarr id and no mutation producer.
- Rule disable/deselection, cap trimming, identity loss, convergence, or subject deletion can make
  the proposal absent or turn it into a skip; the override remains visible as stale.
- An active suppression cannot conceal `identity-not-authoritative`, `rating-protected`, or any
  other refusal, because skip keys are not valid override targets.
- Malformed override config follows the existing loader behavior: validation fails with an exact
  path and the run falls back to empty config after a warning. Documentation must call out this
  repo-wide behavior because it means no suppression is active for that run.

## Workflows

### Primary dispute workflow

1. Run `rfmedia lidarr policy evaluate --explain <proposal-key>` and review the proposal plus its
   emitted evidence hash.
2. Add the key, `verdict: suppress`, evidence hash, and rationale to `policy.overrides`.
3. Re-run evaluate. The proposal moves from actionable proposals to the distinct suppressed list;
   the original evidence remains explainable by the same key.
4. Later evaluations either keep the suppression active on an exact match or report it stale.
5. To resolve stale state, the operator re-reviews the current row and updates the hash, or removes
   the obsolete override. There is no automatic refresh.

### `policy plan` interaction

- Recommend mode includes active/stale override rows in its embedded evaluation. Active
  suppressions never enter producer cohorts.
- If every proposal is actively suppressed, the result is `no-changes` and writes no artifact.
- Plan mode must globally refuse before any producer runs when a stale override belongs to the
  selected rule scope. This matches policy-plan's existing all-or-nothing preflight and prevents a
  stale veto from becoming an artifact accidentally.
- Unselected-rule overrides do not block a narrowed plan invocation.
- Sealed v3 artifacts remain unchanged and contain no policy or override provenance; retain the
  policy-plan report beside an artifact when that audit trail matters.

### `sync-ratings` interaction

- It consumes the same evaluation, so active suppressions are absent from quality-profile and
  monitoring cohorts under `recommend`, `plan`, and `apply`.
- A stale override in a selected decision creates an explicit decision-scoped refusal: that
  decision seals/applies nothing. An independent healthy selected decision may continue, matching
  the command's existing per-decision refusal model.
- CLI threshold overrides participate in the evidence hash, so a suppression reviewed under config
  thresholds does not silently carry into a materially different one-off sync run.
- Overrides never constitute confirmation or approval; `sync-ratings --mode apply` retains its
  existing confirmation, checksum pins, and apply lifecycle for unsuppressed cohorts.

### Error recovery

- Invalid config: fix the exact reported `policy.overrides.<key>...` path, then rerun; do not assume
  the malformed veto was honored.
- Stale evidence: inspect expected/current hashes and the current decision evidence, then update or
  delete the record deliberately.
- Missing decision: verify rule selection, provider identity, and convergence before removing an
  orphaned entry; never remap by artist name alone.

## Domain Model

### Entities

- **Policy decision key**: stable locator for one rule/subject; non-rotating and not proof of current
  evidence.
- **Proposal evidence hash**: rotating, versioned digest of the material evidence and intended
  action reviewed by the operator.
- **Policy override**: durable `{ key, verdict: suppress, evidenceHash, reason }` intent.
- **Override result**: evaluation-time reconciliation of one configured override as active
  suppression or one of the stale reasons.
- **Actionable proposal**: a proposal not covered by an active suppression.

### State transitions

```text
proposal + no override
  -> actionable proposal

proposal + matching suppress override
  -> suppressed
  -> actionable + stale(evidence-changed) when material evidence changes

suppressed
  -> stale(outcome-changed) when the rule now skips the subject
  -> stale(decision-absent) when the subject/rule emits no decision
  -> actionable when the override is removed

stale
  -> suppressed only after explicit re-review and evidenceHash update
  -> no override result after config removal
```

No transition writes Plex, writes Lidarr, seals a plan, applies a plan, or edits the config itself.

## Existing Codebase Integration

- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: owns stable proposal/skip keys, report schema,
  decision rows, counts, and the zero-value-import command contract.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts`: the sole proposal factories and key
  builders; proposal hashes must derive from their frozen outputs rather than re-evaluating rules.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: pure registry engine and the appropriate
  post-evaluation classification/accounting boundary.
- `packages/rfmedia-cli/src/types/config.ts` and `packages/rfmedia-cli/src/lib/config.ts`: current
  exact-key, no-default policy schema and validator; `policy` currently accepts only
  `plexLibrary` and `rules`.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: single human/CSV presentation
  boundary; machine JSON/YAML receive the full versioned report. Adding durable rows is a report
  contract change and should use a new policy evaluation schema version rather than silently
  redefining `rfmedia.lidarr-consumption-policy.v1`.
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts`: total proposal accounting and global
  plan-mode preflight; active suppression reduces input, stale selected-scope overrides add a
  preflight refusal.
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`: project the same frozen report with
  per-decision refusal isolation and retain the independent mutation ladder.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: already documents key formats,
  evidence limits, plan separation, sync-ratings reuse, and the present lack of overrides.
- Critical tests already live in `policy-rule-support.test.ts`, `policy-engine.test.ts`,
  `policy-rules.test.ts`, `lidarr-policy.test.ts`, `policy-plan.test.ts`,
  `sync-ratings.test.ts`, and `config.test.ts`.

## Success Criteria

1. A valid config entry suppresses exactly one matching proposal, preserves its evidence in a
   distinct row, and leaves all unrelated decisions unchanged.
2. Decision keys remain unchanged across threshold/evidence/order changes; evidence hashes remain
   order-stable but change for every material evidence/action change.
3. Same-key evidence drift, outcome changes, and absent decisions are reported as distinct stale
   states; no stale override suppresses a current proposal automatically.
4. Human, JSON, YAML, and CSV output distinguish actionable proposals, evaluator skips, active
   suppressions, and stale overrides with exact counts and deterministic order.
5. Evaluate remains provider-write-free. Merely adding, reading, or matching an override never
   writes Plex/Lidarr, creates a plan, or updates tracking state beyond pre-existing reconciliation.
6. Active suppressions never enter policy-plan or sync-ratings cohorts. Policy-plan plan mode blocks
   all selected-scope sealing on stale overrides; sync-ratings refuses the affected decision.
7. Config tests cover malformed keys, four-segment skip keys, unsupported verdicts, missing/invalid
   hashes, empty rationale, unknown fields, and exact error paths.
8. Tests cover active/stale/orphan transitions, provider-id reuse, CLI threshold drift, rule
   disable/deselection, cap/convergence changes, deterministic accounting, `--explain`, and both
   mutation handoff paths.
9. No forced proposals, custom desired states, rule changes, recency signals, album/track entity
   kinds, database/store schema, scheduled evaluation, MCP surface, or plan-artifact schema changes
   are added.

## Open Questions

- None required to define v1 behavior. A future management command could generate/remove config
  entries, but manual reviewable config is sufficient for issue #313 and should not expand this
  issue's scope.

## Relevant Docs

- [Issue #313](https://github.com/yandy-r/rfmedia-apps/issues/313)
- [Issue #209](https://github.com/yandy-r/rfmedia-apps/issues/209)
- [Issue #311](https://github.com/yandy-r/rfmedia-apps/issues/311)
- `packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md` (sections 2.5 and 15)
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`
