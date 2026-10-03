# Lidarr Policy Plan Implementation Plan

Implement issue #311 as a thin evaluate-to-plan composition without changing the policy engine,
Lidarr client, strict v3 artifact, or apply contracts. A new pure projector will account for every
proposal before a new orchestration action either returns the default zero-write review or seals
through the existing profile and monitoring producers. Command, presenter, tri-shell completion,
documentation, and ROADMAP surfaces then converge on the same `recommend|plan` contract.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-311/ (branch: feat/issue-311-policy-plan)

## Critically Relevant Files and Documentation

- `docs/plans/issue-311-policy-plan/feature-spec.md`: Fixed v1 behavior and non-goals.
- `docs/plans/issue-311-policy-plan/shared.md`: Condensed architecture and implementation patterns.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: Proposal, handoff, rule, and producer contracts.
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts`: Pure projection/refusal precedent.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: Unchanged evidence-gathering action.
- `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`: Orchestration and partial-output precedent.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`: Fresh-state profile producer.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`: Fresh-state monitoring producer.
- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`: Existing nested parent/evaluate leaf.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: Existing policy output owner.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Completion parity contract.
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: Primary operator guide.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Separate apply/checksum contract.
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`: Closest user-flow precedent.
- `ROADMAP.md`: Live backlog and Sprint 2 policy-follow-through source.

## Implementation Plan

### Phase 1: Independent Foundations and Compatibility Surfaces

#### Task 1.1: Define the Policy-Plan Contract Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-311-policy-plan/feature-spec.md`
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`
- `packages/rfmedia-cli/src/types/lidarr-sync-ratings.ts`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/types/lidarr-policy-plan.ts`

Files to Modify

- `packages/rfmedia-cli/src/types/index.ts`

Create a zero-value-import contract with schema, `recommend|plan` mode constants/guard, option-long
constants, discriminated producer cohorts, proposal changes, stable refusal codes, artifact
outcomes, total counts, and result statuses for reviewed, no-change, refused, sealed, partial, and
failed runs. Preserve the complete evaluation report and proposal-to-artifact correlation outside
the v3 artifact. Model completed outcomes in partial results and keep arrays deeply readonly.

#### Task 1.2: Extend Bash, Zsh, and Fish Templates Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-311-policy-plan/feature-spec.md`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

Add the `policy plan` child, nested active-routing/predicate logic, exact leaf options, policy-rule
values, and `recommend plan` mode values to all three static templates. Keep completion offline and
side-effect free. Do not add apply, yes, dry-run, plan-file, threshold overrides, or dynamic proposal
key completion.

#### Task 1.3: Draft the Operator Workflow Documentation Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-311-policy-plan/feature-spec.md`
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`
- `packages/rfmedia-cli/README.md`

Replace manual proposal transcription with the default review, explicit seal, and separately pinned
apply flow. Document supported producers, discovery/global-refusal behavior, no-change and partial
outcomes, unchanged evaluate guarantees, independent artifacts, exact options, machine output, and
the absence of apply/output-path shortcuts. Preserve historical #209 design provenance.

#### Task 1.4: Draft Completion and Roadmap Discoverability Updates Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-311-policy-plan/analysis-docs.md`
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
- `docs/README.md`
- `ROADMAP.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
- `docs/README.md`
- `ROADMAP.md`

Document nested `policy plan` completion and `recommend|plan` values, add the consumption-policy
guide to the docs index, and update ROADMAP Sprint 2/current focus/open tables using a live GitHub
issue audit. Mark #311 as the filed implementation of the prior follow-up without rewriting unrelated
entries or claiming apply automation. Task 5.2 owns final PR-number wording after publication.

### Phase 2: Total Proposal Projection

#### Task 2.1: Implement and Prove the Pure Projector Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/lidarr-policy-plan.ts`
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`
- `packages/rfmedia-cli/src/lib/bridge/rating-sync.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.test.ts`

Implement a synchronous, I/O-free projector with a named invariant error. Validate unique keys,
descriptor/handoff agreement, authoritative positive artist IDs, numeric profile targets, boolean
monitoring targets, cohort bounds, and total input accounting. Represent discovery and conservative
same-artist cross-intent conflicts as explicit refusals, group by producer/desired scalar, sort by
`POLICY_PRODUCER_IDS` then target and artist ID, deduplicate safely, and freeze the result. Add only
critical supported/refusal/conflict/malformed/order/accounting tests.

### Phase 3: Orchestration and CLI Integration

#### Task 3.1: Compose Evaluation and Existing Producers Depends on [2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts`
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`
- `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts`
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/index.ts`

Run policy evaluation exactly once, project the full report, and return before producer dispatch in
recommend mode. In plan mode, any refusal blocks every producer; otherwise seal sequentially in
producer declaration order with numeric profile binding, boolean monitoring intent, sorted exact IDs,
and cohort-sized `maxBatch`. Acquire no wrapper scheduler slot and never call apply. Preserve each
successful outcome immediately. Return `failed` when the first producer fails and `partial` when a
later producer fails, using a stable non-secret failure descriptor while retaining completed outcome
metadata. Forward rule/cap/library/Plex/Lidarr overrides and cancellation exactly where the composed
actions support them. Test the zero-write default, global gate, no-change path, exact producer
calls/order, first-failure result, and later partial preservation.

#### Task 3.2: Add the Command, Presenter, and Command Contract Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`

Register `plan` after `evaluate`, update the parent description, and reuse non-throwing rule/cap,
library, connection, explain, and verbose conventions. Add `--mode recommend|plan` with recommend as
the default, validate all input before lazy loading, redact Plex/Lidarr credentials, and keep root
machine options inherited. Render total cohorts/refusals/artifacts and complete partial state; emit
human output on stderr and one JSON/YAML/CSV result on stdout. Suggested apply commands must pin plan
ID/checksum and never include `--yes`. Add focused child/option/mode/lazy/redaction/stream/exit tests.
Pin the exit matrix: recommend-mode `reviewed`, recommend-mode refusals, `no-changes`, and `sealed`
exit 0; plan-mode `refused`, `partial`, and `failed` exit 1 after rendering. Projection invariant
errors use the existing redacted failure envelope and exit 1. Typed producer failures render the
versioned policy-plan result, with credential redaction applied before any machine or human output.

#### Task 3.3: Lock Commander and Tri-Shell Parity Depends on [1.1, 1.2, 3.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/lidarr-policy-plan.ts`
- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Extend the shared command tree and option-surface assertions for `policy plan`, compare mode/rule
values across Bash, Zsh, and Fish, and add one executable Bash nested-routing case. Use parameterized
parity coverage rather than duplicating equivalent tests per shell.

### Phase 4: Documentation Convergence and Verification

#### Task 4.1: Reconcile Final Documentation and Live ROADMAP State Depends on [1.3, 1.4, 3.2, 3.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
- `packages/rfmedia-cli/README.md`
- `docs/README.md`
- `ROADMAP.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
- `packages/rfmedia-cli/README.md`

Reconcile drafted prose with the implemented option names, status/result schema, completion output,
and exact verification behavior. Confirm all stale “future leaf” and manual-transcription claims in
user-facing docs are gone while `policy evaluate` remains explicitly write-free. Audit ROADMAP live
counts and issue placement again as a read-only check. If external state changed since Task 1.4,
return the discrepancy to Task 1.4's owner rather than editing outside this task's declared files.

#### Task 4.2: Run the Integrated Contract and Repository Gates Depends on [2.1, 3.1, 3.2, 3.3, 4.1]

**READ THESE BEFORE TASK**

- `package.json`
- `packages/rfmedia-cli/package.json`
- `scripts/test-run.sh`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`

**Instructions**

Files to Modify

- None; this is a read-only validation gate.

Run focused projector, action, command, and completion tests first. Then run rfmedia package tests,
typecheck, build, architecture and Lidarr-codegen contracts, repository formatting/whitespace and
markdown gates, followed by the root suites required by CI. Audit the diff for forbidden config,
database, generated-client, plan-schema, operation-definition, apply, and unrelated ROADMAP changes.
Route failures back to the task owning the implicated files and repeat until all gates pass.

Run at least these exact commands:

- `npm run test:run -w packages/rfmedia-cli -- src/lib/bridge/policy-plan.test.ts src/actions/lidarr/policy-plan.test.ts src/commands/lidarr-policy.test.ts src/lib/shell-completions/templates.spec.ts`
- `npm run test:run -w packages/rfmedia-cli`
- `npm run typecheck -w packages/rfmedia-cli`
- `npm run build:rfmedia`
- `npm run test:architecture -w packages/rfmedia-cli`
- `npm run test:codegen:lidarr -w packages/rfmedia-cli`
- `npm run test:run`
- `npm run typecheck`
- `npm run build:all`
- `npm run format:check`
- `npm run lint:md`
- `git diff --check`

### Phase 5: Review, Publication, CI, Merge, and Cleanup

#### Task 5.1: Review the Complete Change and Fix Findings Depends on [4.2]

**READ THESE BEFORE TASK**

- `docs/plans/issue-311-policy-plan/feature-spec.md`
- `.github/pull_request_template.md`
- `docs/prps/reviews/`
- `packages/rfmedia-cli/CLAUDE.md`

**Instructions**

Files to Create

- `docs/prps/reviews/issue-311-policy-plan-review.md`

Files to Modify

- None initially; any finding fix returns to the task that owns the implicated file.

Run the repository code-review workflow over the full branch diff with correctness, security, type,
architecture, performance, test-scope, completion, and docs/ROADMAP perspectives. Write the required
machine-parseable artifact even when there are no findings. Apply every valid critical/high/medium
finding through scoped review-fix tasks, mark finding statuses, format the artifact, and rerun the
focused plus affected full gates until the review has no open blocking finding.

#### Task 5.2: Commit, Push, and Open the Template-Compliant PR Depends on [5.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `.github/workflows/rfmedia-cli.yml`
- `ROADMAP.md`
- `docs/prps/reviews/issue-311-policy-plan-review.md`

**Instructions**

Files to Modify

- `ROADMAP.md`

Re-audit live issue counts, open issues, and the remote default branch. Format and stage the complete
scope, create conventional commits without bypassing hooks, push `feat/issue-311-policy-plan` to the
GitHub remote, and create the PR against `master` from the repository template with exact commands
and outcomes, `Closes #311`, breaking-change statement, risks/rollback, and review/design artifact
references. Once the PR number is known, finalize ROADMAP's shipped reference if the repository's
current convention includes PR numbers, commit/push that update, and verify the PR head SHA.

#### Task 5.3: Resolve PR Feedback and Monitor the Active Head to Green Depends on [5.2]

**READ THESE BEFORE TASK**

- `docs/prps/reviews/issue-311-policy-plan-review.md`
- `.github/workflows/rfmedia-cli.yml`

**Instructions**

Files to Modify

- None unless a review or CI finding identifies a scoped source, test, documentation, or plan file.

Inspect every GitHub review thread, file-level comment, requested change, and top-level actionable
comment. Apply valid findings with scoped fix ownership, resolve threads, rerun affected local gates,
commit, and push through hooks. Monitor CI with the repository helper and authoritative
`gh pr checks` plus authoritative `statusCheckRollup` data for the active head SHA, refreshing after
every push, until every required check is green and no unresolved review thread remains. Do not
merge an older green SHA.

#### Task 5.4: Squash Merge and Verify Complete Cleanup Depends on [5.3]

**READ THESE BEFORE TASK**

- `docs/plans/issue-311-policy-plan/parallel-plan.md`
- `docs/prps/reviews/issue-311-policy-plan-review.md`

**Instructions**

Files to Modify

- None; this is an external-state closeout task.

Squash merge the green PR with remote branch deletion. Verify authoritatively that the PR is merged,
issue #311 is closed, the merge commit is on `origin/master`, required checks belong to the merged
head, and review threads are resolved. Then remove the dedicated worktree, delete/prune the obsolete
local and remote feature branch, preserve the untouched primary checkout and unrelated worktrees,
and verify final branch/worktree/ref state. Only this evidence completes the objective.

## Advice

- Validate the entire proposal set before the first producer call; a valid-looking partial selection
  is the highest-risk failure mode in this feature.
- Use proposal `subject` and narrowed `after` data as projector inputs, but let existing producers
  independently re-read the authoritative `before` state.
- Do not parse or execute `handoff.argv`; it is inert review data containing library-controlled text.
- Avoid a wrapper scheduler slot because nested `local-only` work can deadlock at concurrency one.
- Keep `sync-ratings` separate: its force-enable, thresholds, confirmation, and apply semantics are
  not a generic policy-plan framework.
- Update all completion templates together and prove parity through shared parameterized tests.
- Multiple artifacts are not transactional; preserve completed evidence and never rollback-delete a
  successfully sealed plan after a later failure.
