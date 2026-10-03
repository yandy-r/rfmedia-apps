# Business Research — Lidarr Policy Plan

## Executive Summary

Issue [#311](https://github.com/yandy-r/rfmedia-apps/issues/311) closes the risky manual-transcription
gap between `rfmedia lidarr policy evaluate` and the existing Lidarr plan producers. The new
`rfmedia lidarr policy plan` leaf should run the shipped evaluation, account for every selected
`PolicyProposal`, and project supported proposals through the producer named by
`proposal.handoff.producer`. Its default outcome remains a reviewable report with no artifact write;
an explicit higher safety rung may create sealed Lidarr plan artifacts, but must never apply them.

The feature is orchestration, not a second policy engine or a new mutation contract. It must preserve
the exact evaluation report as decision evidence, use fresh-state reads in the existing producers to
seal intent, expose every unsupported or withheld proposal as a refusal, and leave
`rfmedia lidarr policy evaluate` strictly write-free. Current mutation-bound proposals map to two
shipped producers: `rating-quality-upgrade` to `artist-profile-assignment` and
`stale-monitoring-cleanup` to `artist-monitoring`. `discovery-seed` is intentionally inert and has no
Lidarr plan producer; selecting a report containing such a proposal is therefore the primary
fail-closed case rather than permission to drop it.

## Scope Boundary

| Classification            | Business capability                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required by #311          | `lidarr policy plan` leaf; evaluate-to-projection workflow; review-only default; explicit sealed-artifact mode; total proposal accounting; typed producer reuse; stable human and machine results; Bash/Zsh/Fish parity; feature docs and ROADMAP updates              |
| Reused unchanged          | Policy rules, proposal keys and threshold evidence, Plex/Lidarr identity authority, producer implementations, v3 plan schema, private atomic plan writer, apply validation/history/resume, scheduler lanes, shared failure envelope                                    |
| Explicitly not #311       | Applying or auto-applying plans, direct Lidarr mutation, Plex rating writes, a new `operation.kind`, policy fields in the sealed plan envelope, discovery execution, a producer/plugin framework, policy overrides/disputes, recency signals, or a new database schema |
| Existing specialized lane | `lidarr sync-ratings` remains the recommend/plan/apply workflow for its two named ratings decisions; #311 provides the general policy-parent handoff without redefining those decisions                                                                                |

## User Stories

- As a library operator, I can evaluate configured consumption policies and see exactly which
  proposals are projectable before any plan file is created.
- As a cautious operator, invoking `lidarr policy plan` with no explicit sealing choice cannot write
  a plan artifact or mutate Plex or Lidarr.
- As an operator ready to proceed, I can explicitly seal the supported proposals into one or more
  existing v3 Lidarr plan artifacts without manually copying IDs and target values between commands.
- As a reviewer, I can relate every projected change or refusal back to its stable policy decision
  key, rule, before/after evidence, checks, and summary.
- As an operator, I receive each artifact path, plan ID, checksum, operation, counts, and a
  checksum-pinned next apply command; plan creation itself never grants apply authorization.
- As an operator with a discovery proposal or malformed producer handoff, I receive a loud refusal
  identifying the proposal rather than a smaller artifact that silently omits it.
- As an operator whose Lidarr state changed after evaluation, I get the existing producer's fresh
  current-state classification, not a plan that treats cached policy evidence as mutation authority.
- As automation, I receive a stable result union that distinguishes reviewed, sealed, refused,
  no-change, partial, and failed outcomes without parsing human prose.
- As automation in JSON/YAML/CSV mode, I get the complete bounded proposal/refusal evidence on stdout
  and no prompt or progress text mixed into the payload.
- As a maintainer, I can add a future policy rule only by declaring a supported producer projection
  or an explicit refusal; a new rule cannot disappear from plan output by default.
- As a shell user, I see the same `policy plan` operation, flags, and enumerated values in Bash, Zsh,
  and Fish.

## Domain Concepts and State Transitions

| Concept             | Business meaning                                                 | Invariants                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Evaluation report   | Frozen evidence from the shipped policy engine                   | It remains the sole source of policy decisions and is returned verbatim by the planning workflow                                                |
| Proposal            | One explainable desired Lidarr outcome                           | Stable decision key; authoritative identity for mutation-bound proposals; exact before/after/check evidence; one inert handoff                  |
| Handoff producer    | Closed route to an already-shipped producer                      | It is a discriminant, not arbitrary executable shell text; current mutation producers are profile assignment and artist monitoring              |
| Projection          | Pure conversion from proposal evidence to producer-ready cohorts | Every selected proposal receives a supported, refused, or no-change fate; malformed data throws/fails closed                                    |
| Cohort              | Compatible proposals that one producer can seal together         | Homogeneous producer and desired state; unique sorted artist IDs; bounded by existing plan limits                                               |
| Refusal             | A visible reason a proposal or cohort cannot be sealed           | Refusals are result data, never omissions; they carry stable scope and actionable detail where possible                                         |
| Review result       | Default command outcome before artifact creation                 | Contains evaluation, projected cohorts, refusals, footprint/counts, and no generated artifacts                                                  |
| Sealed outcome      | One producer result after an explicit seal request               | Existing v3 artifact, private/atomic/no-overwrite write, fresh Lidarr state, plan ID and SHA-256 payload checksum                               |
| Apply authorization | Separate permission to mutate Lidarr                             | Never granted by this command; remains owned by `lidarr apply`, its confirmation, allow flags, origin/drift checks, claims, history, and resume |

The intended state machine is:

```text
configured policy
  -> evaluate live evidence
  -> frozen PolicyEvaluationReport
  -> validate and project every selected proposal
       -> supported cohort
       -> explicit refusal
       -> no changes
  -> review result (default, no artifact write)
  -> explicit seal request
  -> fresh-state producer read
  -> sealed artifact outcome(s)
  -> separate operator-run lidarr apply with expected plan id/checksum
```

There is no transition from `policy plan` directly to `applied`. A sealed result is durable reviewed
intent, not proof that Lidarr changed.

## Business Rules

### Command and Safety Ladder

1. The entry point is exactly `rfmedia lidarr policy plan`, registered beside `policy evaluate` on
   the existing `policy` parent.
2. The default invocation is review-only. It may perform the same reads as evaluation and pure
   projection, but calls no producer and writes no artifact.
3. Artifact creation requires one explicit option/value. The exact flag spelling is an open product
   decision, but omission must always mean review-only and the command must have no apply rung.
4. Reuse the evaluation selection and connection semantics where applicable: Plex library, repeatable
   or comma-separated rule selection, per-rule proposal cap, Plex connection overrides, and Lidarr
   connection overrides.
5. `policy plan` should not silently force-enable policy rules. It converts proposals emitted by the
   configured/selected evaluation; the specialized `sync-ratings` force-enable behavior belongs to
   that command's decision workflow.
6. Unknown rules, empty `--rule` input, invalid caps, invalid mode values, or missing credentials fail
   inside the shared command failure envelope before producer I/O.
7. Root output flags remain root-owned. Human output uses stderr; machine success output uses stdout.
8. The leaf schedules no wrapper lane around composed actions. Evaluation and each producer already
   acquire the appropriate `local-only` work; nesting the same lane can deadlock at concurrency one.

### Evaluation Integrity

1. Call the existing `executeLidarrPolicyEvaluate`; do not duplicate rule evaluation, threshold
   resolution, signal gathering, or identity logic.
2. Preserve the returned `PolicyEvaluationReport` in the result, including degraded status, skipped
   rules, proposal/skip arrays, coverage, effective policy, origins, and evaluation timestamp.
3. `policy evaluate` itself remains unchanged and imports no plan writer or plan producer. The
   pre-existing observational reconciliation snapshot replace is not permission to add artifact
   writes to that action.
4. Policy provenance remains outside the strict plan artifact. The report/result relates proposal
   keys to generated plans; the exact-key v3 artifact schema is not widened with `policy`, `ruleId`,
   rationale, or evaluation fields.
5. A degraded unrelated rule must not automatically erase a healthy selected producer cohort.
   Projection should inspect the selected rule's own result and the specific proposal invariants,
   while still exposing the report's degraded status to the operator.

### Total Proposal Projection

1. Projection is total over `report.proposals` in the selected evaluation scope. Every proposal is
   represented in a cohort, a refusal, or a documented no-change result.
2. Dispatch uses the closed `handoff.producer` value and typed calls to the matching action. Never
   spawn or evaluate `handoff.argv` as shell text. The argv remains review evidence and a compatibility
   check against the typed projection.
3. Cross-check the proposal's `ruleId`, descriptor producer, handoff producer, subject shape, and
   producer-required `after` scalar. A disagreement is an invariant failure, not a warning.
4. `artist-profile-assignment` requires a numeric `subject.artistId`, numeric
   `after["qualityProfileId"]`, and one consistent target profile across its cohort. Bind the shipped
   profile producer by resolved numeric ID, not display name.
5. `artist-monitoring` requires a numeric `subject.artistId`, boolean `after["monitored"]`, and one
   consistent desired monitoring state across its cohort.
6. Artist IDs are deduplicated and ordered deterministically. The cohort's `maxBatch` is bound to its
   actual size so the producer's default 25 does not reject an evaluation whose configured cap permits
   up to 100 proposals.
7. The existing hard ceiling of 1,000 remains authoritative. This feature must not raise plan caps or
   split an oversized logical cohort into artifacts that disguise total blast radius.
8. A `discovery` handoff is unsupported for Lidarr mutation planning. The proposal has no Lidarr
   artist ID and intentionally owns no plan producer; it must be reported as an unsupported projection
   rather than executed, converted to artist-add, or silently filtered.
9. Unknown future producer IDs, absent artist IDs, missing/wrong desired-state values, divergent
   targets, duplicate decision contradictions, or descriptor/handoff mismatches fail closed with the
   offending stable proposal key.
10. If one artist is proposed into independently applied artifacts whose combined meaning is unsafe
    or order-dependent, withhold it from every conflicting cohort and emit one artist-scoped refusal.
    The shipped `sync-ratings` `cross-decision-conflict` behavior is the current precedent.

### Review-Only Outcome

1. Review mode reports evaluation evidence, projected cohorts, refusals, distinct affected artists,
   and the proportion of authoritative links affected.
2. A healthy selected rule with zero proposals is a successful no-change outcome, not a failure and
   not a zero-entry artifact.
3. A rule skipped by evaluation remains a visible rule/decision refusal with the engine's skip reason
   and detail; it does not become a clean cohort.
4. Human output may cap rows for readability, but machine output and the evaluation report retain the
   complete bounded cohort.
5. Review mode must make the next action explicit: either fix a refusal/narrow `--rule`, or rerun with
   the explicit seal choice. It must not print a command that applies a nonexistent artifact.

### Sealed Artifact Outcome

1. Validate the complete projection before calling the first producer. This prevents a known
   unsupported proposal late in the report from leaving a misleading prefix of artifacts.
2. Group compatible proposals by shipped producer and desired state. Current rules should produce at
   most one profile-assignment artifact and one artist-monitoring artifact, in the stable
   `POLICY_PRODUCER_IDS` declaration order.
3. Each producer re-reads live Lidarr state and builds the existing strict v3 artifact. Evaluation
   `before` evidence is explanatory; it never authorizes a mutation or replaces the producer's fresh
   canonical state.
4. Reuse producer defaults for private paths when no output location is requested. Existing writers
   secure the plan directory, use exclusive/atomic no-overwrite writes, and create mode-`0600` files.
5. Each successful outcome reports path, plan ID, payload checksum, operation kind, matched/changed/
   unchanged counts, and enough review detail to identify the cohort.
6. The suggested next command is separate `lidarr apply` and pins both
   `--expected-plan-id` and `--expected-plan-checksum`. It must not include `--yes` as implied consent.
7. The command never calls `executeLidarrApply`, acquires an apply claim, appends apply history, or
   mutates Lidarr/Plex under any flag combination.
8. Producer calls are sequential because they perform fresh reads and writes. If a later producer
   fails after an earlier artifact was sealed, the result/failure path must preserve and disclose the
   earlier artifact path, ID, and checksum. Files are immutable reviewed evidence and should not be
   silently deleted to imitate transactional rollback.

### Refusals, Failures, and Exit Semantics

1. Expected business refusals are data, with stable codes, scope, proposal key where applicable,
   detail, and remedy when one exists.
2. Engine/projection invariant violations are hard failures. A malformed proposal must never be
   downgraded to a refusal that lets the rest seal as if the engine were trustworthy.
3. Cancellation is checked between evaluation, projection, and producer calls. Cancellation after
   one artifact was sealed is partial completion and must identify that artifact.
4. Failure to resolve a live artist/profile, an over-cap cohort, unsafe output path, existing target
   file, write failure, or producer validation failure uses the existing Lidarr failure envelope and
   redacts connection credentials.
5. Review with no supported changes can exit successfully while reporting refusals. Whether explicit
   seal mode should exit nonzero for any refusal or only for an unsealed selected proposal requires a
   single documented rule; it must not vary by output format.
6. CSV needs declared columns and explicit row kinds for summary, cohort, refusal, proposal/change,
   and artifact rows. JSON/YAML should expose the stable result union directly.

### Compatibility and Documentation

1. Bash, Zsh, and Fish must all advertise both `evaluate` and `plan` under `lidarr policy`, the same
   plan options, and identical enumerated values. Completion generation must remain side-effect free.
2. Completion parity tests should bind the generated templates to shared command/type constants and
   execute the Bash routing path for the new nested leaf.
3. Update the consumption-policy feature doc from the current three-command manual-transcription
   workflow to the new review/seal handoff while retaining the statement that `policy evaluate` writes
   nothing.
4. Cross-link the existing plan/apply documentation for artifact validation, checksum semantics,
   dry-run apply, authorization, history, resume, and drift handling rather than restating those
   contracts incompletely.
5. Update active ROADMAP entries and archive wording that currently say the manual three-command hop
   remains required.

## Workflows

| Workflow                                                      | Expected business outcome                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Default invocation, configured supported proposals            | Full evaluation plus projectable cohorts; no plan file and no mutation                                                               |
| Explicit seal, profile proposals only                         | One fresh-state `artist-profile-assignment` v3 artifact; result includes path, ID, checksum, and pinned apply command                |
| Explicit seal, monitoring proposals only                      | One fresh-state `artist-monitoring` v3 artifact; result includes path, ID, checksum, and pinned apply command                        |
| Explicit seal, both compatible producers                      | Two artifacts in stable producer order; neither is applied                                                                           |
| No proposals                                                  | Successful no-change review; explicit seal creates zero artifacts                                                                    |
| Selected rule disabled                                        | Rule-level refusal/skip remains visible; no artifact for that rule                                                                   |
| Discovery proposal present                                    | Unsupported-projection refusal in review; explicit sealing must not silently omit or convert it                                      |
| Proposal missing artist ID or producer-required `after` field | Hard projection failure naming the decision key; no producer call after preflight detects it                                         |
| Same artist in unsafe cross-producer decisions                | Artist withheld from all conflicting cohorts with one explicit conflict refusal                                                      |
| State converged between evaluation and producer read          | Producer seals/reports fresh no-op state according to existing plan semantics; stale evaluation evidence is not forced into a change |
| First producer seals, second producer fails unexpectedly      | Partial outcome discloses the surviving first artifact and the failure; no apply occurs                                              |
| User runs `policy evaluate` after feature ships               | Exact read-only behavior remains: no plan file, no apply, same report contract                                                       |

## Existing Codebase Integration

- `src/types/lidarr-policy.ts` is the public decision contract. `PolicyProposal` already carries the
  stable key, typed subject, before/after maps, checks, observations, summary, and `PolicyHandoff`.
  `POLICY_PRODUCER_IDS` is the current closed mutation-producer vocabulary.
- `src/lib/bridge/policy-rule-support.ts` is the sole proposal/handoff constructor. It prevents an
  evaluation handoff from naming `apply` or structurally naming `--plan-file`; discovery seeds are
  structurally non-mutation-bound and carry no `artistId`.
- `src/actions/lidarr/policy-evaluate.ts` is the read-only orchestration edge to reuse unchanged. It
  owns live signal gathering and returns the frozen report plus execution metadata.
- `src/commands/lidarr-policy.ts` already establishes the two-level command tree, lazy action loading,
  option validation inside `.action()`, output separation, credential redaction, and the future plan
  seam. Add the leaf here without importing the Lidarr parent or eagerly loading actions.
- `src/lib/bridge/rating-sync.ts` is the closest projection precedent: it reads a frozen evaluation
  report, validates producer-required fields, builds deterministic cohorts, emits refusals as data,
  and throws on engine invariant violations.
- `src/actions/lidarr/sync-ratings.ts` is the closest orchestration precedent: it binds cohort size to
  `maxBatch`, calls the two existing producers in declaration order, reports sealed artifacts
  immediately, and pins ID/checksum when it later applies. #311 should reuse its plan-stage concepts
  but intentionally omit its apply stage and specialized decision/threshold surface.
- `src/actions/lidarr/plan-artist-profiles.ts` and `src/actions/lidarr/plan.ts` are the current producer
  owners. They resolve fresh state and write strict artifacts; #311 should call them, not copy their
  selection or plan-building logic.
- `src/lib/lidarr/plan-engine.ts`, `src/lib/plan.ts`, and `src/types/lidarr-plan.ts` own artifact schema,
  canonicalization, checksum, bounds, secure writes, and apply compatibility. No contract change is
  required for #311.
- `src/lib/shell-completions/{bash,zsh,fish}.ts` and `templates.spec.ts` treat the nested policy command
  tree and option/value lists as cross-shell contracts. The current tree contains only `evaluate`.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md` currently documents the manual
  `evaluate` to typed producer to `apply` sequence and the prohibition on policy provenance inside
  artifacts; this is the primary feature-doc update.
- `ROADMAP.md` already lists #311 as the one-step evaluate-to-sealed-artifact follow-up, while
  `docs/roadmap-archive.md` still describes manual transcription and the #221-specific lane.

## Gotchas and Edge Cases

- The phrase “each proposal” includes `discovery-seed`; it cannot be treated as shorthand for only
  the two mutation-bound proposals. Its `producer: "discovery"` and missing `artistId` are deliberate
  safety properties.
- `PolicyRuleDescriptor.producer` uses `null` for discovery, while a seed proposal handoff uses
  `"discovery"`. Projection must understand this intentional distinction and still refuse mutation
  planning.
- `handoff.argv` is an inert argument vector that may contain values literally equal to `apply` or
  `--plan-file`. Do not scan all tokens naïvely or execute the vector; option-value positions matter.
- `PolicyProposal.before` and `after` are index-signature maps. Required values must be read with
  bracket access and narrowed at runtime.
- Evaluation caps are per rule and can reach 100, while producers default `maxBatch` to 25. Forwarding
  no bound causes valid high-volume reviews to fail only after expensive library reads.
- All rules are disabled by default in policy configuration. A zero-config `policy plan` can
  legitimately teach the rules and produce no proposal; it should not borrow `sync-ratings`' implicit
  force-enable behavior without an explicit product decision.
- `report.status === "degraded"` may be caused by an unrelated selected rule. Per-rule gating avoids
  falsely blocking healthy cohorts, but the incomplete report must remain prominent.
- The stale-monitoring rule uses absolute lifetime plays, not recency; policy planning does not make
  the underlying evidence stronger. Compilation plays and normalized-name joins retain their current
  limitations.
- The plan artifact checksum detects corruption and binds canonical intent; it is not a signature and
  does not itself authorize apply.
- Multiple artifact writes cannot be truly atomic with the current reusable producers. Preflight can
  prevent known projection failures before writes, but an I/O or live-state failure on artifact two
  can still leave artifact one. The result contract must make that recoverable state explicit.
- Default producer filenames are unique plan-ID/timestamp paths under the private plan directory. A
  single `--plan-file` value is ambiguous when two producer artifacts are possible.
- A proposal's evaluation `before` values can be stale moments later. Fresh producer state and apply
  preflight are features, not disagreements to normalize away.

## Success Criteria

1. `rfmedia lidarr policy plan` runs the shipped evaluator and default review mode performs zero plan
   writes and zero Plex/Lidarr mutations.
2. The result embeds the evaluator's frozen report and accounts for every selected proposal with a
   projected change, refusal, or no-change status.
3. Explicit seal mode maps quality-profile proposals to the existing artist-profile producer and
   monitoring proposals to the existing artist-monitoring producer, producing valid v3 artifacts.
4. Generated outcomes expose the exact artifact path, plan ID, payload checksum, operation kind, and
   checksum-pinned next apply command; no artifact is applied by this command.
5. Producers re-read fresh Lidarr state, use deterministic unique artist cohorts, and receive a
   `maxBatch` equal to the cohort size within existing caps.
6. Critical projection tests prove refusal/failure for discovery handoffs, unknown producers,
   descriptor/handoff mismatch, missing artist IDs, missing/wrong desired-state values, divergent
   cohort targets, unsafe cross-producer conflicts, and oversize cohorts. No silent-drop path exists.
7. Critical orchestration tests prove default no-write behavior, explicit producer routing, stable
   producer order, zero-proposal behavior, no apply calls, and partial-outcome disclosure when a later
   producer fails.
8. Existing policy-evaluate tests continue to prove that action imports no plan writer/producer and
   writes no artifact.
9. Existing plan-engine/producer/apply contract tests pass unchanged; no new plan schema version or
   operation kind is introduced.
10. Bash, Zsh, and Fish expose the same nested leaf, options, and values, with parity/routing tests and
    no adapter/client/scheduler construction during completion generation.
11. Consumption-policy docs, plan/apply cross-links, README/quick-reference surfaces where applicable,
    and ROADMAP wording describe the new workflow without claiming that planning authorizes mutation.
12. Typecheck, architecture checks, focused policy-plan tests, existing policy and producer tests,
    shell-completion parity tests, and markdown validation pass.

## Open Questions

1. What is the explicit seal control? Recommendation: reuse a value-taking safety rung with a
   review-only default and a `plan` value, but do not expose an `apply` value on this leaf. The naming
   must avoid making `policy plan` look writeful by default.
2. Does any unsupported/refused selected proposal block all artifact creation, or may supported
   cohorts seal when the refusal is explicit? Recommendation: validate globally and block explicit
   sealing until every selected proposal is projectable; users can narrow with `--rule`. This is the
   strongest reading of “convert each” and “fail closed.”
3. How should output-path overrides work for up to two artifacts? Recommendation: use existing private
   default paths in v1. If an override is required, define a directory/prefix contract rather than a
   single file path whose producer ownership is ambiguous.
4. Should `policy plan` expose the specialized threshold override flags from `sync-ratings`?
   Recommendation: no. Reuse policy config and the existing generic `--max-proposals`; otherwise the
   general command starts duplicating rule-specific semantics.
5. Should explicit seal mode exit nonzero when review contains only expected refusals/no projectable
   changes? Define this once in the result/exit contract. Recommendation: no-change is success;
   unprojectable selected proposals block sealing and fail.
6. Should a cross-producer proposal for the same artist always be refused, or only combinations known
   to conflict? Recommendation: preserve the conservative #221 behavior for v1 and require an explicit
   compatibility rule before relaxing it.
7. Where should decision-to-artifact correlation live? Recommendation: in the policy-plan result as a
   map/list of proposal keys per outcome, never as new fields in the sealed v3 artifact.

## Relevant Files

- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: Proposal, producer, rule, report, cap, and
  read-only evaluation contracts.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts`: Sole proposal/handoff constructors and
  inert discovery boundary.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: Existing evaluation workflow to compose
  without adding writes.
- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`: Existing policy parent, evaluate leaf, lazy
  loading, option validation, and output boundary.
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts`: Closest fail-closed proposal projection and
  refusal model.
- `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`: Closest producer orchestration, cohort
  ordering, plan sealing, and checksum pinning precedent.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`: Shipped
  `artist-profile-assignment` producer.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`: Shipped `artist-monitoring` producer.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Strict plan build/read/write/checksum boundary.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Existing v3 artifact shapes and batch caps.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Nested policy routing and candidates.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Nested policy routing and candidates.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Nested policy predicates and candidates.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Cross-shell parity and routing
  contract tests.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: Current policy semantics and
  manual handoff documentation.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Sealed artifact and separate apply
  lifecycle.
- `ROADMAP.md`: Active #311 entry and delivery status.
- `docs/roadmap-archive.md`: Historical #209/#221 workflow wording affected by the new handoff.

## Relevant Docs

- [Issue #311](https://github.com/yandy-r/rfmedia-apps/issues/311): requested command, rationale,
  scope, constraints, and acceptance criteria.
- [Issue #209](https://github.com/yandy-r/rfmedia-apps/issues/209): original consumption-policy scope
  and explicit mutation deferral.
- [Issue #221](https://github.com/yandy-r/rfmedia-apps/issues/221): ratings-specific recommend/plan/
  apply precedent.
- `packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md`: design sections 2.1 and 15 define
  the deferred mechanical producer mapping and write-free boundary.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: authoritative operator semantics,
  evidence limitations, and current handoff contract.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: plan sealing, checksum, review, apply,
  drift, authorization, and recovery contract.
