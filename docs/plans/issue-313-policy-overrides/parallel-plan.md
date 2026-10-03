# Policy Decision Overrides and Disputes Implementation Plan

Add a configuration-backed, evidence-bound `suppress` record to the existing Lidarr policy
evaluation without adding mutation authority or a new CLI surface. The implementation extends the
policy report to v2, validates override records fail-closed for three exact command paths, and runs a
pure classification pass after existing proposal caps but before report counts and freezing. The
authoritative `report.proposals` array remains the only input to unchanged policy-plan and
ratings-sync projectors, while shared presenters expose suppressed, stale, and not-evaluated review
evidence across human and machine output.

## Critically Relevant Files and Documentation

- docs/plans/issue-313-policy-overrides/feature-spec.md: Binding scope and behavioral contract.
- docs/plans/issue-313-policy-overrides/shared.md: Verified architecture, patterns, and required docs.
- packages/rfmedia-cli/src/types/config.ts: Default-free policy configuration types.
- packages/rfmedia-cli/src/types/lidarr-policy.ts: Zero-value-import policy report contract.
- packages/rfmedia-cli/src/lib/config.ts: Closed validation and config search/fallback behavior.
- packages/rfmedia-cli/src/cli.ts: Root pre-action load and exact command ancestry.
- packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts: Stable key and frozen decision patterns.
- packages/rfmedia-cli/src/lib/bridge/policy-engine.ts: Caps, counts, status, and frozen report owner.
- packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts: Shared human, explain, and CSV output.
- packages/rfmedia-cli/src/lib/bridge/policy-plan.ts: Actionable proposal-to-plan projection.
- packages/rfmedia-cli/src/lib/bridge/rating-sync.ts: Actionable proposal-to-ratings cohorts.
- packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md: Primary user-facing policy contract.
- packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md: Recommend/plan/apply safety contract.
- .github/pull_request_template.md: Required delivery and verification evidence structure.

## Implementation Plan

### Phase 1: Contracts and Input Safety

#### Task 1.1: Define Closed Config and Policy v2 Contracts Depends on [none]

**READ THESE BEFORE TASK**

- docs/plans/issue-313-policy-overrides/feature-spec.md
- packages/rfmedia-cli/src/types/config.ts
- packages/rfmedia-cli/src/types/lidarr-policy.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/types/config.ts
- packages/rfmedia-cli/src/types/lidarr-policy.ts

Add a raw `policy.overrides` record whose entries contain exactly `action: suppress`, a copy-grade
`sha256:` fingerprint, and an operator reason. Add closed report types for fingerprinted evaluated
proposals and override results with `suppressed`, `stale`, and `not-evaluated` states plus the three
stale reasons. Extend summary/report types and the stale-aware post-render fail gate; bump only the
policy evaluation schema and engine version to v2. Preserve the base rule-produced proposal,
zero-value-import rule, and all outer plan/sync and sealed-plan schema versions.

#### Task 1.2: Validate Overrides and Add Strict Config Loading Depends on [1.1]

**READ THESE BEFORE TASK**

- docs/plans/issue-313-policy-overrides/research-patterns.md
- packages/rfmedia-cli/src/lib/config.ts
- packages/rfmedia-cli/src/lib/config.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/lib/config.ts
- packages/rfmedia-cli/src/lib/config.test.ts

Validate a maximum of 500 own enumerable entries on a plain or null-prototype mapping. Accept only
three-segment proposal keys, one action, lowercase 64-hex SHA-256 values, and reasons that are
already trimmed, non-empty, at most 512 UTF-8 bytes, and free of C0/C1 plus `U+061C`,
`U+200E-U+200F`, `U+202A-U+202E`, and `U+2066-U+2069` bidi controls. Reject unknown/inherited/
prototype-like keys, hostile objects, skip keys, and unsafe values with exact JSON-quoted bracket
paths. Add an explicit loader option that makes the first existing candidate authoritative and
rethrows read, template, parse, or validation failures, while missing files/no files and normal
callers retain existing behavior. Isolate strict and permissive cache semantics and cover the
malformed/highest-precedence and hostile-input contracts without changing unrelated validators.

#### Task 1.3: Select Strict Loading for Exact Commands Depends on [1.2]

**READ THESE BEFORE TASK**

- docs/plans/issue-313-policy-overrides/research-integration.md
- packages/rfmedia-cli/src/cli.ts
- packages/rfmedia-cli/src/cli.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/cli.ts
- packages/rfmedia-cli/src/cli.test.ts

Add an exported predicate matching only `lidarr policy evaluate`, `lidarr policy plan`, and
`lidarr sync-ratings` from Commander parent ancestry. Pass the strict option into the single root
pre-action config load so invalid authoritative config fails before plugin initialization, action
imports, evidence gather, or mutation-bound work. Prove `lidarr plan`, other Lidarr leaves, and
unrelated commands keep permissive loading; preserve credential-free offline reconcile behavior.

#### Task 1.4: Implement Pure Evidence Fingerprinting and Classification Depends on [1.1]

**READ THESE BEFORE TASK**

- docs/plans/issue-313-policy-overrides/feature-spec.md
- packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts
- packages/rfmedia-cli/src/lib/bridge/policy-engine.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts
- packages/rfmedia-cli/src/lib/bridge/policy-overrides.test.ts

Build an explicit versioned tuple and SHA-256 over credential-free origins/library, stable decision
and subject/identity data, sorted state/observations, ordered checks, and producer. Exclude time,
names/prose, reason, credentials, argv, and report order; reject non-finite/non-JSON evidence. Stamp
new frozen report-grade proposal copies, classify configured records deterministically, correlate
current skips by rule/subject anchor for `outcome-changed`, and return actionable proposals plus all
frozen override results. Pin one golden hash and table-drive stability/rotation, exact suppression,
evidence change, outcome change, decision absence, not-evaluated, ordering, filtering, and freezing.

### Phase 2: Authoritative Engine and Output Integration

#### Task 2.1: Integrate Post-Cap Classification and Recount Depends on [1.4]

**READ THESE BEFORE TASK**

- docs/plans/issue-313-policy-overrides/research-architecture.md
- packages/rfmedia-cli/src/lib/bridge/policy-engine.ts
- packages/rfmedia-cli/src/lib/bridge/policy-engine.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/lib/bridge/policy-engine.ts
- packages/rfmedia-cli/src/lib/bridge/policy-engine.test.ts

Invoke the classifier after each rule cohort has been capped and refusals attributed, but before
per-rule results, aggregate summary/status, sorting, and final freezing. Rebuild every ran rule's
proposal count from the actionable cohort, retain genuine skips, add override counts/results, and
make report proposals fingerprinted and actionable-only without cap refill. Cover exact/stale
withholding, unrelated proposal survival, per-rule/summary agreement, schema constants,
deterministic deep freezing, degraded precedence, clean active suppression, and stale-only
`--fail-on proposals` behavior.

#### Task 2.2: Expose Overrides in Policy Human, Explain, and CSV Output Depends on [2.1]

**READ THESE BEFORE TASK**

- docs/plans/issue-313-policy-overrides/research-patterns.md
- packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts
- packages/rfmedia-cli/src/commands/lidarr-policy.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts
- packages/rfmedia-cli/src/commands/lidarr-policy.test.ts

Add full proposal fingerprints and explicit override rows/counts to the fixed shared CSV projection.
Render an always-visible Overrides section with review-required guidance, include withheld override
keys in decision-key validation, and show expected/current full hashes plus recovery in explain
output. JSON/YAML continue serializing report v2 directly. Prove human stderr visibility,
prose-free machine stdout, row ordering/columns, feature-specific CSV reason guarding, suppressed
and stale explain lookup, one complete policy-v2 JSON and YAML result contract, and stale exit
only after output.

#### Task 2.3: Surface Overrides in Ratings-Sync Human Output Depends on [2.2]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts
- packages/rfmedia-cli/src/commands/lidarr-sync-ratings.test.ts
- packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts
- packages/rfmedia-cli/src/commands/lidarr-sync-ratings.test.ts

Delegate to the shared override renderer from the sync human surface so withheld-only results do not
look like unexplained no changes. Preserve the outer ratings-sync v1 envelope, existing explain
delegation, and stdout/stderr rules. Cover active/stale/not-evaluated visibility and unchanged
machine schema without duplicating classifier tests. Assert the outer ratings-sync schema remains
v1 while its embedded policy evaluation is v2.

### Phase 3: Downstream Safety and Documentation

#### Task 3.1: Prove Pure Projectors Consume Only Actionable Proposals Depends on [2.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/bridge/policy-plan.ts
- packages/rfmedia-cli/src/lib/bridge/rating-sync.ts
- docs/plans/issue-313-policy-overrides/feature-spec.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/lib/bridge/policy-plan.test.ts
- packages/rfmedia-cli/src/lib/bridge/rating-sync.test.ts

Add one focused policy-plan and one ratings-sync fixture proving suppressed/stale decisions retained
in the embedded evaluation never enter cohorts, while unrelated actionable proposals still project.
Do not add override matching to either projector and do not edit production projector code unless a
test exposes a real violation of the existing `report.proposals` invariant.

#### Task 3.2: Prove Withheld Decisions Cannot Reach Producers or Apply Depends on [2.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts
- packages/rfmedia-cli/src/actions/lidarr/sync-ratings.ts
- packages/rfmedia-cli/src/actions/lidarr/policy-plan.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/lidarr/policy-plan.test.ts
- packages/rfmedia-cli/src/actions/lidarr/sync-ratings.test.ts

Use existing injected dependency harnesses for one withheld-only plan-mode case and one apply-mode
case. Assert no plan producer, artifact writer, confirmation prompt, or apply dependency is called;
reuse the current no-change control flow and avoid duplicating generic sealing/apply coverage.

#### Task 3.3: Document the Dispute Workflow and Safety Boundary Depends on [2.2, 2.3]

**READ THESE BEFORE TASK**

- docs/plans/issue-313-policy-overrides/research-docs.md
- packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md
- packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md
- packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md
- packages/rfmedia-cli/README.md

Document the quoted YAML mapping and evaluate/copy/reason/rerun/review loop. Define suppressed,
stale reason variants, not-evaluated, actionable-only counts, post-cap non-refill, strict loading for
the three exact commands, full copy-grade fingerprint output, stale recovery, and downstream
withholding. State explicitly that overrides cannot force decisions or revoke prior sealed artifacts.
Leave CLI option tables, completion docs/templates, and `rfmedia.example.yaml` unchanged.

### Phase 4: Integrated Audit and Delivery State

#### Task 4.1: Run Critical, Package, and Repository Validation Depends on [1.3, 2.2, 2.3, 3.1, 3.2, 3.3]

**READ THESE BEFORE TASK**

- package.json
- packages/rfmedia-cli/package.json
- packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts
- packages/rfmedia-cli/src/lib/shell-completions/bash.ts
- packages/rfmedia-cli/src/lib/shell-completions/zsh.ts
- packages/rfmedia-cli/src/lib/shell-completions/fish.ts
- packages/rfmedia-cli/src/types/lidarr-policy-plan.ts
- packages/rfmedia-cli/src/types/lidarr-sync-ratings.ts

**Instructions**

Run these commands under the pinned Node 22 toolchain, preserving the focused-first order:

```bash
mise exec -- npm run build:common
mise exec -- npm run test:run -w packages/rfmedia-cli -- \
  src/lib/config.test.ts src/cli.test.ts \
  src/lib/bridge/policy-overrides.test.ts src/lib/bridge/policy-engine.test.ts \
  src/commands/lidarr-policy.test.ts src/commands/lidarr-sync-ratings.test.ts \
  src/lib/bridge/policy-plan.test.ts src/lib/bridge/rating-sync.test.ts \
  src/actions/lidarr/policy-plan.test.ts src/actions/lidarr/sync-ratings.test.ts \
  src/lib/shell-completions/templates.spec.ts
mise exec -- npm run typecheck -w packages/rfmedia-cli
mise exec -- npm run check:architecture -w packages/rfmedia-cli
mise exec -- npm run test:architecture -w packages/rfmedia-cli
mise exec -- npm run test:codegen:lidarr -w packages/rfmedia-cli
mise exec -- npm run test:run -w packages/rfmedia-cli
mise exec -- npm run build:rfmedia
mise exec -- npm run test:run
mise exec -- npm run lint
mise exec -- npm run format:check
mise exec -- npx markdownlint-cli2
git diff --check
graphify update .
```

Audit that the three listed completion templates, policy-plan/sync schema constants, option
registries, clients, adapters, generated code, databases, schedulers, artifact/apply/history/claim
sources, and `rfmedia.example.yaml` have no feature diff. Inspect and retain only generated
`graphify-out/` updates attributable to the implementation; never hand-edit graph output. Record
exact passing commands for the pull request; make no other semantic edits in this task.

#### Task 4.2: Commit, Push, and Open the Pull Request Depends on [4.1]

**READ THESE BEFORE TASK**

- .github/pull_request_template.md
- docs/plans/issue-313-policy-overrides/feature-spec.md
- docs/plans/issue-313-policy-overrides/parallel-plan.md

**Instructions**

Verify the diff and branch scope, create an intentional conventional commit without bypassing hooks,
push `feat/issue-313-policy-overrides` to `origin`, and open a pull request against `master` using
every required template section. Include `Closes #313`, exact passing validation commands/outcomes,
the completion/template no-change audit, compatibility/breaking-change status, and a concrete risk
and rollback statement. Record the authoritative PR number and current head SHA for ROADMAP and CI
tracking; do not edit the PR template.

#### Task 4.3: Update Live ROADMAP Delivery State Depends on [4.2]

**READ THESE BEFORE TASK**

- ROADMAP.md
- .github/pull_request_template.md
- docs/plans/issue-313-policy-overrides/feature-spec.md

**Instructions**

Files to Modify

- ROADMAP.md

Requery live issue totals and obtain the final pull-request number before editing. Remove #313 from
open planning/backlog rows where present, record evidence-bound suppression and stale review
delivery without implying force or retroactive artifact revocation, and update only currently true
dates/counts/references. Preserve unrelated roadmap content, validate Markdown formatting, commit
the scoped update without bypassing hooks, and push it to the active pull-request branch.

#### Task 4.4: Review, Green CI, Squash Merge, and Cleanup Depends on [4.3]

**READ THESE BEFORE TASK**

- .github/pull_request_template.md
- docs/plans/issue-313-policy-overrides/feature-spec.md
- docs/plans/issue-313-policy-overrides/parallel-plan.md

**Instructions**

Run the repository code-review workflow against the active pull request, fix every validated
actionable finding with focused regression coverage, resolve review threads, and rerun proportional
local validation. Monitor the active head SHA through all required GitHub checks; inspect and fix
failures rather than bypassing hooks or protections. When review and CI are green, squash-merge the
pull request, verify GitHub reports the PR merged and issue #313 closed, confirm the remote feature
branch is gone, then remove only the dedicated issue worktree and obsolete local feature branch.
Preserve the primary checkout and every unrelated worktree and report authoritative merge/closure/
cleanup evidence.

## Advice

- Classification must run after existing caps and must never refill a suppressed slot; otherwise
  the feature changes rule-ranking semantics.
- Strict loading and cache isolation are one safety contract: a strict call must not reuse a
  permissive fallback result that silently erased an override.
- A current skip supports stale `outcome-changed` evidence but remains the real evaluator skip;
  never hide it or synthesize a proposal.
- Keep `types/lidarr-policy.ts` free of value imports and version only the changed nested evaluation
  contract, not outer reports or sealed artifacts.
- Reasons are untrusted display text and never fingerprint/argv/authorization material; use existing
  terminal and CSV safety paths.
- A new override affects only a new evaluation and same-run projection. Already sealed artifacts
  retain their independent checksum-pinned authorization contract.
- The feature adds no CLI option. Any Bash/Zsh/Fish template diff is a regression, and completion
  parity is an audit task rather than implementation work.
