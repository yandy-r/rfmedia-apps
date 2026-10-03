# Lidarr Discovery Safety Implementation Plan

Issue #205 extends the shipped Last.fm discovery command with a pure safety-policy layer, bounded
breadth-first traversal, invocation-scoped candidate quarantine, explicit multi-rank approval, and
one sealed multi-entry artist-add plan. The implementation preserves ordinary discovery as a
one-hop, zero-Lidarr preview and keeps actual artist creation behind the existing independently
reviewed `lidarr apply` gate. Public immutable contracts and backward-compatible plan validation
land first, followed by disjoint traversal/producer/apply tasks, one serial handoff and command
convergence, then completion and documentation parity. ROADMAP closeout is deliberately performed
in the same PR only after its real number exists and live issue state has been refreshed.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-lidarr-discovery-safety/ (branch: feat/lidarr-discovery-safety)

## Critically Relevant Files and Documentation

- `docs/plans/lidarr-discovery-safety/design.md`: Resolved CLI, policy, safety, and acceptance contract
- `docs/plans/lidarr-discovery-safety/shared.md`: Architecture and required-reading index
- `packages/rfmedia-cli/src/types/discovery.ts`: Public discovery constants and immutable contracts
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`: Provider traversal and plan-handoff orchestration
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`: Public grammar and text/machine presentation
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`: Fixed-origin provider and available evidence
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Artist-add plan family and discovery provenance
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Strict artifact construction and validation
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: Exact-MBID plan producer
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`: Whole-plan artist-add apply orchestration
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`: Per-entry uncertain-dispatch boundary
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`: Canonical operator discovery contract
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Separate mutation approval contract
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`: Scheduler retry, budget, and cancellation contract
- `packages/rfmedia-cli/AGENTS.md`: Package architecture, test, documentation, and validation rules

## Implementation Plan

### Phase 1: Public Contracts and Pure Policy

#### Task 1.1: Define Discovery Safety Contracts and Bounds Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `docs/plans/lidarr-discovery-safety/shared.md`
- `packages/rfmedia-cli/src/types/discovery.ts`
- `packages/rfmedia-cli/src/types/index.ts`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/src/types/discovery.ts`
- `packages/rfmedia-cli/src/types/index.ts`

Define exported immutable constants for threshold, per-seed, depth, invocation request/visited,
visible, score-weight, and approved-add defaults and maxima. Widen the generated-independent
discovery contracts with resolved policy, hard bounds, candidate provenance/exposure, raw and
adjusted score, stable lifecycle/reason unions, traversal summary, multi-rank approval, and
aggregate handoff counts. Preserve Last.fm attribution and existing fields where compatibility
permits, omit absent optional values, and re-export all new public contracts through the type
barrel. Do not import Commander, Fetch, Lidarr, generated SDK types, filesystem types, or mutable
collections into public results.

#### Task 1.2: Implement and Prove the Pure Discovery Policy Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/src/types/discovery.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/discovery/policy.ts`
- `packages/rfmedia-cli/src/lib/discovery/policy.test.ts`

Files to Modify

- None

Create one side-effect-free module for semantic policy validation, MBID-first/case-folded-name
identity, seed pre-registration, threshold-before-cap admission, duplicate-path exposure updates,
graph-exposure scoring, deterministic final ordering, quarantine/eligibility decisions, and
atomic visible-rank approval validation. Return frozen values and stable reason codes; never
overwrite raw Last.fm similarity. Add only boundary-focused tests for bounds, cycles, duplicate
exposure, cap order, score clamping/ties, MBID-less quarantine, invalid/duplicate/over-budget
approvals, and the exact formula from the design.

#### Task 1.3: Widen the Sealed Artist-Add Plan Contract Compatibly Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`

Widen artist-add entries from a one-entry tuple to a bounded non-empty readonly array in approved
rank order, extend per-entry discovery provenance, and add a canonical multi-MBID selection shape
while continuing to parse and checksum existing single `foreign-artist-id` artifacts unchanged.
Generalize builders, exact-key validation, canonicalization, review/summary counts, selection
matching, duplicate MBID/entry rejection, `maxBatch`, history, and resume helpers without
weakening other plan families. Prove legacy single-entry compatibility, multi-entry round trip and
checksum stability, tamper/duplicate/order rejection, and `maxBatch === entries.length <= 25`.

### Phase 2: Traversal, Plan Production, and Apply

#### Task 2.1: Orchestrate Bounded Breadth-First Discovery Depends on [1.2]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/src/lib/discovery/policy.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`

Refactor the action around one deterministic breadth-first engine used for both default depth one
and opt-in fixed depth two. Schedule one idempotent provider task per admitted seed through the
existing discovery lane, propagate cancellation, and insert the initial seed plus every admitted
candidate identity into the invocation-wide visited set before it can be scheduled. Enforce every
per-seed/depth/request/visited/visible cap before new work, and accumulate first-path plus
duplicate-exposure evidence before one final policy ranking. Preserve the one-request default,
complete attribution, provider error classification, and zero Lidarr/context/filesystem resolution
without selected ranks. Add focused tests for the default, two bounded waves, cycles, invocation
budgets, structured batch failures, cancellation, deterministic evidence, and preview isolation.

#### Task 2.2: Produce One Atomic Multi-Candidate Artist-Add Plan Depends on [1.3]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`

Accept ordered approved recommendations and validate every rank and canonical MBID before any I/O.
Resolve the three common Lidarr resources once, perform exact fresh lookup and current-presence
classification for every candidate, and write nothing until the complete selection is proven
valid and unambiguous. Return aggregate already-present/planned evidence, create one entry for
each addable candidate with independent provenance, set bounded `maxBatch`, write at most one
plan, and write none when all selected candidates already exist or any candidate fails. Preserve
the conservative add policy owned by issue #202/#203.

#### Task 2.3: Apply Multi-Entry Artist-Add Plans in Safe Order Depends on [1.3]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`

Remove whole-plan `entries[0]` assumptions while leaving the per-entry possible-dispatch executor
load-bearing. Classify and render every plan entry in sealed order, preserve dry-run and partial
resume semantics, reconcile possible dispatch per entry before fresh admission, preflight shared
resources once where safe, and call the existing entry executor once per admitted entry. On
uncertainty or unreconciled possible-dispatch evidence, stop immediately and emit explicit
`not-attempted` results for later entries. Prove two-entry success, mixed satisfied/addable,
dry-run/resume, lost-response reconciliation, stop-after-uncertainty, and legacy one-entry
behavior without duplicating generic confirmation tests.

### Phase 3: Candidate Handoff and Public Command

#### Task 3.1: Integrate Atomic Multi-Rank Discovery Handoff Depends on [2.1, 2.2]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/src/lib/discovery/policy.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`

Validate the final immutable visible-rank selection as one set, enforce `maxAdd`, require mutation
eligibility for every selected candidate, and invoke the plan producer once in visible-rank
order. Return per-candidate approval plus aggregate approved/already-present/planned/failed
evidence. A planning failure must preserve the complete attributed preview in the same result and
must not leave a partial plan. Prove no planning without explicit ranks and no Lidarr POST from
discovery.

#### Task 3.2: Expose Strict Grammar and Stable Output Depends on [2.3, 3.1]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/types/discovery.ts`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

Add the design's ordered flags and strict parsers for bounded decimals, counts, negated cascade,
fixed deep traversal, `maxAdd`, and comma-separated ranks. Reject malformed values, deep/cascade
conflicts, duplicates, ineligible relationships, oversized selections, and incomplete resource
options before dynamic action import. Extend text, JSON, YAML, and fixed-column CSV with resolved
policy, traversal counts, status/reason, provenance, graph-exposure evidence, raw/adjusted score,
and handoff aggregates while retaining one machine document, mandatory attributed CSV summary
rows, redaction, and stdout/stderr behavior. Render all artist-add plan/apply entries without
weakening the separate apply confirmation.

### Phase 4: Completion and Documentation Parity

#### Task 4.1: Update All Static Shell Completion Templates Depends on [3.2]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

Add every final discover option in identical public order with matching argument-taking semantics,
bounded value hints, and retained file completion for `--plan-file`. Keep completion generation
static and free of config, provider, scheduler, Lidarr, or filesystem side effects beyond normal
script output.

#### Task 4.2: Lock Cross-Shell Discover Completion Parity Depends on [4.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Update the existing single parity contract with the exact ordered option list and value/file
semantics for Bash, Zsh, and Fish. Retain forbidden direct-mutation/secret flags and the
side-effect-free generation assertions. Do not create shell-specific duplicate suites.

#### Task 4.3: Document the Canonical Safety and Apply Contracts Depends on [3.2]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`

Document every default, bound, option interaction, depth-two BFS rule, invocation budget,
MBID-first loop identity, graph-exposure score, invocation-only quarantine state, multi-rank
sealed planning flow, separate mutation approval, and stop-after-uncertainty behavior. State
plainly that provider listener/popularity data, durable quarantine, downstream cascade impact, and
safe add defaults remain outside #205.

#### Task 4.4: Update Public Examples and Release Notes Depends on [4.3]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/CHANGELOG.md`
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`

**Instructions**

Files to Create

- None

Files to Modify

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/CHANGELOG.md`

Add concise one-hop preview, bounded deep traversal, multi-rank plan, and separately approved apply
examples. Replace statements that issue #205 behavior is unshipped, preserve Last.fm attribution
and secret guidance, and explicitly keep issues #204, #206, and #219 outside this release.

### Phase 5: Validation and Full Delivery

#### Task 5.1: Run Integrated Local Validation Depends on [4.2, 4.4]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-discovery-safety/design.md`
- `packages/rfmedia-cli/AGENTS.md`
- `package.json`
- `packages/rfmedia-cli/package.json`

**Instructions**

Files to Create

- None

Files to Modify

- None

Run focused policy, discovery action, artist-add plan/apply, command, and completion tests first.
Then run `npm run build:common`, `npm run test:run --workspace packages/rfmedia-cli`,
`npm run test:coverage --workspace packages/rfmedia-cli`,
`npm run typecheck --workspace packages/rfmedia-cli`,
`npm run codegen:lidarr:check --workspace packages/rfmedia-cli`,
`npm run test:codegen:lidarr --workspace packages/rfmedia-cli`,
`npm run check:architecture --workspace packages/rfmedia-cli`,
`npm run test:architecture --workspace packages/rfmedia-cli`, `npm run build:all`,
`npm run lint`, `npm run format:check`, and `git diff --check`. Confirm the generated Lidarr client
is unchanged, exercise the repository pre-push hook without bypassing it when the branch is pushed,
and run `graphify update .` after source changes are final. Treat a missing fresh-worktree
dependency or unbuilt `@rfmedia/common` as environment setup, not a regression; do not weaken
tests or gates to obtain green output.

#### Task 5.2: Create the Draft PR and Close Out the Live Roadmap Depends on [5.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `docs/plans/lidarr-discovery-safety/design.md`

**Instructions**

Files to Create

- None

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

Commit the validated implementation with the repository's conventional commit and hooks, push the
feature branch, and create a draft PR against the verified default branch using the complete PR
template and `Closes #205`. After GitHub assigns the real PR number, refresh the live issue state
and totals, remove #205 from every live ROADMAP location, update Layer 2 counts/text without
changing open issues #204, #206, or #219, and archive #205 with the real PR number and current
delivery date. Format and markdown-lint both files, commit and push the closeout to the same PR,
then verify its active head SHA and exact body/testing evidence.

#### Task 5.3: Review, Fix, Merge, and Clean Up Depends on [5.2]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/lidarr-discovery-safety/design.md`
- `docs/plans/lidarr-discovery-safety/parallel-plan.md`

**Instructions**

Files to Create

- None

Files to Modify

- None

Promote the PR for review and run the repository's proper PR code-review workflow, preserving its
review artifact. Apply every actionable issue-scoped finding through the proper review-fix
workflow, resolve review threads only after fixes are pushed, and rerun affected focused plus full
gates. Monitor CI with the repository helper against the active head SHA until every required
check is green; inspect Actions logs and fix failures without bypassing hooks. Squash merge only
after green CI and resolved review state, then authoritatively verify the PR is merged, issue #205
is closed as completed, the remote branch is deleted, `master` matches the merged remote base, the
dedicated worktree is removed, the obsolete local feature branch is deleted, and unrelated
worktrees and the original checkout remain untouched.

## Acceptance Criteria Traceability

| Acceptance criterion                                                           | Owning tasks            |
| ------------------------------------------------------------------------------ | ----------------------- |
| One-hop zero-Lidarr default preview                                            | 2.1, 3.1, 3.2           |
| Strict public controls, defaults, bounds, and conflicts                        | 1.1, 1.2, 3.2, 4.3      |
| Fixed depth-two traversal and invocation-wide budgets                          | 1.1, 1.2, 2.1           |
| Pre-scheduling cycle and duplicate prevention                                  | 1.2, 2.1                |
| Explainable policy, provenance, raw/adjusted score, and exposure               | 1.1, 1.2, 3.2           |
| Explicit plan selection and separate apply approval                            | 2.2, 2.3, 3.1, 3.2      |
| One multi-entry sealed plan and single-entry compatibility                     | 1.3, 2.2, 2.3           |
| Atomic fail-closed selection and no partial plan                               | 1.2, 1.3, 2.2, 3.1      |
| Text, JSON, YAML, CSV, Bash, Zsh, and Fish parity                              | 3.2, 4.1, 4.2, 4.3, 4.4 |
| Focused/full tests, architecture/codegen, review, green CI, merge, and cleanup | 5.1, 5.2, 5.3           |

## Advice

- Treat the current issue's original 3–5-file estimate as stale; the one-entry plan/apply
  invariant is a real safety contract, not an implementation inconvenience to bypass.
- Keep thresholding on raw similarity. Diversity and popularity weights may only adjust the
  separately named score and must disclose `graph-exposure` evidence.
- Insert identities into the invocation-wide visited set before scheduling, not after provider
  completion, so concurrent parents cannot enqueue the same cycle.
- Validate every selected rank and every exact Lidarr identity before writing the single plan;
  never emit several implicit plan files from one `--plan-file`.
- Preserve legacy single-entry artifact checksum semantics with an explicit accepted legacy
  selection branch rather than reinterpreting its serialized fields.
- Reuse `executeLidarrApplyEntry()` for non-idempotent dispatch. Multi-entry orchestration must
  stop admitting later work as soon as one result reports uncertainty.
- After the implementation batches, run focused tests before the full rfmedia, architecture,
  codegen, completion, formatting, lint, coverage, build, and pre-push gates.
- Create the draft PR from the validated implementation first, then update `ROADMAP.md` and
  `docs/roadmap-archive.md` in that same branch using the real PR number and refreshed live GitHub
  issue inventory. Only then mark ready, review, fix findings, and monitor the active head SHA to
  green.
- No child issue is required for the cohesive #205 contract. Durable quarantine already falls
  outside the accepted design, and provider enrichment/federation, safe add defaults, and
  downstream cascade estimation remain tracked by existing issues #204, #206, and #219.
