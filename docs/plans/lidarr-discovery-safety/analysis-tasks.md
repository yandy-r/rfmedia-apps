# Task Analysis: lidarr-discovery-safety

## Executive Summary

Issue #205 is best implemented as three serially converging slices: a pure discovery-policy
foundation, bounded breadth-first action traversal, and a widened multi-entry `artist-add`
plan/apply lane. The policy and command contracts can be developed beside the plan foundation, but
the current artist-add implementation contains deliberate one-entry assumptions in
`packages/rfmedia-cli/src/types/lidarr-plan.ts`,
`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`,
`packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`, and
`packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`; those files form the main serial
critical path.

Keep all implementation, review, and CI work in one dedicated issue-205 worktree. Assign one owner
at a time to recurring aggregation points (`discover.ts`, `discover.test.ts`,
`lidarr-discover.ts`, `lidarr.test.ts`, plan types/engine, and completion templates). The existing
Last.fm transport, scheduler retry policy, generated Lidarr client, per-entry possible-dispatch
executor, and generic `apply.ts` router should remain unchanged unless a focused compile failure
proves a contract seam must widen.

The critical path is:

```text
policy/types -> bounded traversal -> multi-rank handoff -> command/output
plan types/validator -> multi-entry producer -> multi-entry apply
command/output + apply -> completions/docs -> validation -> PR/review/CI
```

## Recommended Phase Structure

### Phase 0 — Baseline and Contract Freeze

- **T00 — Issue/worktree baseline (no owned files):** In the single dedicated worktree, record the
  branch and head SHA, confirm issue #205 is still open, inspect current PR/issue templates, and run
  the focused discovery, plan, apply, command, and completion tests before editing. Confirm
  `packages/rfmedia-cli/src/lib/lidarr/generated/` is clean and will remain untouched.
- **T01 — Public discovery contracts and pure policy:** Own
  `packages/rfmedia-cli/src/types/discovery.ts`, new
  `packages/rfmedia-cli/src/lib/discovery/policy.ts`, and new
  `packages/rfmedia-cli/src/lib/discovery/policy.test.ts`. Add exported immutable defaults and hard
  bounds, resolved policy, traversal/provenance/exposure records, stable reason/status unions,
  MBID-first identity, raw-threshold admission, bounded scoring, deterministic final ordering, and
  rank approval. Keep normalization and every policy decision side-effect free. Tests should cover
  threshold/caps, MBID/name cycles, duplicate exposure updates, clamp behavior, tie breakers,
  MBID-less quarantine, duplicate/invalid approvals, and immutable raw similarity.

T01 follows T00 and freezes the vocabulary used by every later task.

### Phase 1 — Parallel Discovery and Plan Foundations

- **T02 — Bounded breadth-first action traversal:** Own
  `packages/rfmedia-cli/src/actions/lidarr/discover.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`. Replace the single request with
  deterministic waves submitted through the existing discovery scheduler. Insert the initial seed
  before dispatch, admit identities before enqueue, enforce depth, per-seed, request/visited, and
  visible budgets before creating work, propagate one caller signal to every task, accumulate
  first-path/exposure evidence, and rank only after traversal completes. Preserve a one-request,
  one-hop, zero-Lidarr default. Treat failed/skipped `runBatch` results explicitly because
  `runBatch` returns structured outcomes rather than throwing like `runSingle`.
- **T03 — Backward-compatible multi-entry plan contract:** Own
  `packages/rfmedia-cli/src/types/lidarr-plan.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, and
  `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`. Widen the artist-add
  tuple to a runtime-validated non-empty readonly array, make review/summary/maxBatch counts
  bounded values, and add a multi-MBID selection representation while continuing to accept the
  shipped single `foreign-artist-id` selection and one-entry artifacts. Build entries in approved
  rank order, reject duplicate MBIDs/entry IDs, keep per-entry provenance and idempotency keys, and
  seal the whole ordered payload. Test single-entry compatibility, multi-entry round trip,
  checksum/tamper rejection, ordering, duplicate rejection, and `maxBatch === entries.length <= 25`.

T02 and T03 have disjoint ownership and may run in parallel after T01.

### Phase 2 — Multi-Entry Planning and Apply

- **T04 — Atomic multi-candidate plan producer:** Own
  `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`. Accept the ordered approved
  recommendations, validate every canonical lowercase MBID before Lidarr resolution, resolve root
  folder and both profiles once, and perform exact fresh lookup/presence classification for every
  candidate. Do not write until all selections are valid and unambiguous. Report already-present
  candidates independently, create one entry per addable candidate, set `maxBatch` to the addable
  count within resolved `maxAdd`, write at most one plan, and write none when all are already
  present or any selected candidate fails.
- **T05 — Multi-entry artist-add apply orchestration:** Own
  `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`. Remove all `entries[0]` whole-plan
  assumptions, preflight resources once and targets per pending entry, preserve entry-order
  admission, existing history/resume semantics, and per-entry results, and call the existing
  `executeLidarrApplyEntry()` once per admitted entry. Stop later admission immediately after an
  uncertain result or possible-dispatch evidence that cannot be reconciled; mark remaining entries
  `not-attempted`. Prove mixed already-present/addable plans, dry-run, partial resume,
  lost-response reconciliation, stop-after-uncertainty, and single-entry compatibility.

T04 depends on T03. T05 depends on T03 and should start after T04 fixes the producer/result shape.
The per-entry implementation in
`packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts` already owns
possible-dispatch persistence and exact-MBID reconciliation; do not duplicate or parallelize that
logic in T05.

### Phase 3 — Handoff, Grammar, and Output

- **T06 — Multi-rank discovery handoff:** Re-own, serially after T02/T04/T05,
  `packages/rfmedia-cli/src/actions/lidarr/discover.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`. Validate selected visible ranks as
  one atomic set, cap them by resolved `maxAdd`, require eligibility for every rank, and invoke the
  producer once in visible-rank order. Return approved/already-present/planned/failed counts and
  per-candidate handoff evidence while preserving the complete attributed preview on planning
  failure. Prove no plan call without explicit ranks and no Lidarr POST from discovery.
- **T07 — CLI grammar, text/machine output, and apply presentation:** Own
  `packages/rfmedia-cli/src/commands/lidarr-discover.ts`,
  `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`, and
  `packages/rfmedia-cli/src/commands/lidarr.test.ts`. Add strict parsers/default forwarding for
  `--min-similarity`, `--max-per-seed`, `--deep`, `--no-cascade`, `--diversity-boost`,
  `--popularity-dampening`, `--max-add`, and comma-separated `--add` ranks. Reject deep/cascade
  conflicts, duplicates, malformed bounds, oversized selections, and incomplete resource options
  before lazy action import. Extend text, JSON, YAML, and fixed-column CSV with resolved policy,
  traversal, exposure, raw/adjusted score, status/reason, provenance, and handoff counts. Preserve
  stdout/stderr separation, mandatory CSV summary rows, Last.fm attribution, redaction, and
  multi-entry apply/result rendering.

T06 depends on T02, T04, and T05. T07 depends on the final T06 result union. Keep command grammar
and its tests in one task so option relations and output schemas cannot drift.

### Phase 4 — Completion and Documentation Parity

- **T08 — Static shell templates:** Own
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`. Add the final ordered discovery flags,
  argument-taking semantics, bounded value hints, and `--plan-file` file completion identically in
  all shells. Completion generation must remain config/network/Lidarr/Last.fm free.
- **T09 — Completion parity gate:** Own
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`. Pin the exact ordered option
  list and value/file semantics across Bash, Zsh, and Fish, including the absence of direct
  mutation or approval flags.
- **T10 — Canonical safety and apply docs:** Own
  `packages/rfmedia-cli/docs/features/lidarr-discovery.md`,
  `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`, and
  `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`. Document defaults/bounds,
  depth-two BFS, invocation budgets, MBID-first cycles, graph-exposure scoring, invocation-only
  quarantine, multi-rank sealed planning, separate apply approval, and uncertainty recovery.
- **T11 — Public command and release docs:** Own
  `packages/rfmedia-cli/README.md` and `packages/rfmedia-cli/CHANGELOG.md`. Add concise preview,
  deep-discovery, multi-rank-plan, and later-apply examples; explicitly leave #204, #206, and #219
  out of scope.

T08 waits for T07's final grammar; T09 follows T08. T10 and T11 may run in parallel after T07.

### Phase 5 — Validation and Delivery

- **T12 — Integrated local validation (no owned files):** Run focused policy/action/plan/apply/
  command/completion tests first, then package and repository gates. Build `@rfmedia/common` first
  in a fresh worktree if package resolution requires it. Required evidence includes
  `npm run codegen:lidarr:check --workspace packages/rfmedia-cli`,
  `npm run test:codegen:lidarr --workspace packages/rfmedia-cli`, architecture tests,
  `npm run test:run --workspace packages/rfmedia-cli`,
  `npm run test:coverage --workspace packages/rfmedia-cli`,
  `npm run typecheck --workspace packages/rfmedia-cli`, `npm run build:all`, `npm run lint`,
  formatter/markdown checks, `git diff --check`, and generated Bash/Zsh/Fish parity. Run
  `graphify update .` only after implementation code is final.
- **T13 — Pull request and review loop (no owned files):** Use
  `.github/pull_request_template.md` unchanged as the body baseline, include `Closes #205` and
  exact verification outcomes, push without bypassing hooks, inspect every review thread and
  top-level comment, apply only issue-scoped fixes through the owning task, rerun affected and full
  gates, and require the active head SHA to have green authoritative CI.
- **T14 — Post-merge roadmap closeout:** Own `ROADMAP.md` and
  `docs/roadmap-archive.md`. Only after authoritative merge verification, refresh live issue state,
  remove/archive #205 with the actual merged PR number and date, and keep #204, #206, and #219
  open. Re-run markdown checks, commit/push the closeout through the repository's accepted
  lifecycle if it is not already part of the merge, then verify issue closure and clean the one
  dedicated worktree.

T12 follows T09–T11. T13 follows T12. T14 requires real merge/issue facts and therefore must not be
filled with placeholders during implementation.

## Task Granularity Recommendations

- Keep pure policy source and tests with the public type change; the types are otherwise difficult
  to validate without immediately implementing policy behavior.
- Keep each action with its focused test. `discover.ts`/`discover.test.ts` intentionally have two
  serial passes (T02 then T06); never assign those passes concurrently.
- Keep `lidarr-plan.ts` and `plan-engine.ts` under one owner because the exact-key parser, builder,
  checksum, history selection, and type guards must agree at every compile point.
- Keep the three completion templates together, then run their single parity spec as a separate
  gate after the option order freezes.
- Use representative boundary cases rather than duplicating the existing Last.fm transport,
  scheduler retry, generic plan checksum, confirmation, and single-entry reconciliation matrices.
- Avoid edits to `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/apply.ts`, generated Lidarr sources, or the client facade
  unless compilation demonstrates a genuinely changed contract.
- Do not split one worktree into per-task worktrees. Parallel work is safe only for disjoint files
  within the same issue worktree, with serial integration at the mapped convergence files.

## Dependency Analysis

```text
T00 -> T01 -> T02 --------------------┐
          \-> T03 -> T04 ------------├-> T06 -> T07 -> T08 -> T09 --┐
                    \-> T05 ----------┘              \-> T10 ---------├-> T12 -> T13 -> T14
                                                     \-> T11 ---------┘
```

Additional hard dependencies:

- T02 requires T01's identity, policy, decision, ranking, and result contracts.
- T03 requires T01's provenance and approval vocabulary but is otherwise independent of T02.
- T04 requires the widened builder/validator from T03; T05 requires the widened plan/history shape.
- T06 cannot safely integrate until traversal, producer, and apply agree on ordering and counts.
- T07 owns the final public grammar and therefore gates completion and documentation parity.
- T09 waits for all three templates; T12 waits for code, tests, completions, and docs to converge.
- T14 waits for authoritative PR merge and issue state. It is not an implementation-phase roadmap
  guess.

## File-to-Task Mapping

| Task | Exclusive file ownership                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01  | `packages/rfmedia-cli/src/types/discovery.ts`; new `packages/rfmedia-cli/src/lib/discovery/policy.ts`; new `packages/rfmedia-cli/src/lib/discovery/policy.test.ts`                  |
| T02  | `packages/rfmedia-cli/src/actions/lidarr/discover.ts`; `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`                                                                   |
| T03  | `packages/rfmedia-cli/src/types/lidarr-plan.ts`; `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`; `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`     |
| T04  | `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`; `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`                                                     |
| T05  | `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`; `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`                                                              |
| T06  | `packages/rfmedia-cli/src/actions/lidarr/discover.ts`; `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts` (second serial pass)                                              |
| T07  | `packages/rfmedia-cli/src/commands/lidarr-discover.ts`; `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`; `packages/rfmedia-cli/src/commands/lidarr.test.ts`        |
| T08  | `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`; `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`; `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`         |
| T09  | `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`                                                                                                                  |
| T10  | `packages/rfmedia-cli/docs/features/lidarr-discovery.md`; `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`; `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md` |
| T11  | `packages/rfmedia-cli/README.md`; `packages/rfmedia-cli/CHANGELOG.md`                                                                                                               |
| T12  | Validation only; no persistent file ownership                                                                                                                                       |
| T13  | PR/review/CI only; no persistent file ownership                                                                                                                                     |
| T14  | `ROADMAP.md`; `docs/roadmap-archive.md`                                                                                                                                             |

## Optimization Opportunities

- Reuse the existing discovery scheduler lane and `runBatch()` per breadth-first wave; no new queue,
  provider retry loop, or concurrency primitive is needed.
- Resolve policy once and expose the same frozen value to traversal, output, tests, docs, and
  completion hints.
- Accumulate candidates by identity in one invocation map. Store first-seen path/sequence and
  increment exposure on duplicate paths, then perform one final stable sort rather than repeatedly
  re-ranking waves.
- Resolve root folder, quality profile, and metadata profile once per producer invocation; perform
  only identity lookup/presence reads per selected candidate.
- Reuse `executeLidarrApplyEntry()` for each artist-add entry. It already supplies the non-idempotent
  possible-dispatch boundary and exact-MBID reconciliation needed by #205.
- Preserve the current parent `apply.ts` kind-first delegation. Multi-entry behavior belongs inside
  `apply-artist-add.ts`, minimizing regression risk to unrelated plan families.
- Generate each shell script and compare the already-centralized discover block instead of adding
  separate integration suites.

## Implementation Strategy Recommendations

1. Freeze all constants, reason codes, score fields, status unions, and output counts in T01 before
   writing traversal or CLI parsing.
2. Implement one-hop through the same bounded BFS engine used by deep mode; make depth one the
   resolved default rather than maintaining two algorithms.
3. Enforce every cap before scheduling/enqueueing or writing. Threshold raw similarity before
   score adjustment so weights cannot promote rejected candidates.
4. Preserve single-entry plan artifacts with an explicit legacy selection branch while emitting a
   canonical non-empty multi-entry representation for new plans. Do not weaken exact-key parsing
   with optional catch-all fields.
5. Make multi-selection planning transactional at the artifact boundary: validate all ranks and
   all fresh Lidarr resolutions first, then write one sealed file once.
6. Iterate apply entries in sealed visible-rank order. After uncertain dispatch, do not preflight,
   claim, or dispatch later entries; emit explicit `not-attempted` results.
7. Keep preview failures and handoff failures distinct. A planning failure must retain the complete
   attributed discovery document and must never create a second partial artifact.
8. Land tests in dependency order, run focused files after each convergence task, and defer the
   full repository matrix until command/completion/docs parity is complete.
9. Treat active head SHA, resolved review threads, green CI, merged PR state, issue closure, and
   final worktree cleanup as completion evidence; local success alone is not issue closeout.
