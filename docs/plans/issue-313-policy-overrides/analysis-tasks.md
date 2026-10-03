# Task Structure Analysis: issue-313-policy-overrides

## Executive Summary

Implement issue #313 in four dependency-resolved batches inside the existing dedicated worktree
(`--no-worktree`). Start with the shared config/report contracts, then run strict-loading and pure
override-classifier work in parallel; after engine integration, fan out presentation, downstream
boundary tests, and documentation before one repository-wide validation and ROADMAP closeout. File
ownership below is intentionally non-overlapping so parallel implementors never edit the same file.

## Recommended Phase Structure

### Phase 1: Contracts and Input Safety

**Purpose**: Establish the closed suppression-only config contract, policy report v2, and fatal
loading behavior required before any override-sensitive command gathers evidence.

**Suggested Tasks**:

1. **Task 1.1 — Contracts (sequential, depends on none)**: Own
   `packages/rfmedia-cli/src/types/config.ts` and
   `packages/rfmedia-cli/src/types/lidarr-policy.ts`. Add the suppression entry, fingerprint,
   report-grade proposal, override-result/status, summary-count, and v2 schema/engine contracts.
   Preserve zero value imports and leave policy-plan v1, sync-ratings v1, and Lidarr plan v3
   unchanged.
2. **Task 1.2 — Config validation and strict loader (parallel after 1.1)**: Own
   `packages/rfmedia-cli/src/lib/config.ts` and
   `packages/rfmedia-cli/src/lib/config.test.ts`. Validate the bounded dynamic map with exact
   bracketed paths and hostile-object safety; add explicit fail-on-invalid loading where the first
   existing file is authoritative, while missing files and unrelated permissive callers retain
   current behavior.
3. **Task 1.3 — Strict command selection (sequential after 1.2)**: Own
   `packages/rfmedia-cli/src/cli.ts` and `packages/rfmedia-cli/src/cli.test.ts`. Select strict mode
   only for exact Commander ancestry `lidarr policy evaluate`, `lidarr policy plan`, and
   `lidarr sync-ratings`; prove unrelated `lidarr plan` and other commands remain permissive.
4. **Task 1.4 — Pure fingerprint and classifier (parallel after 1.1)**: Create and own
   `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts` and
   `packages/rfmedia-cli/src/lib/bridge/policy-overrides.test.ts`. Implement the explicit
   scope-bound SHA-256 tuple, deterministic indexed classification, post-cap no-refill semantics,
   frozen results, and the `suppressed`, `stale`, and `not-evaluated` states without clients,
   writers, stores, or a generic canonical-JSON abstraction.

**Parallelization**: Tasks 1.2 and 1.4 run concurrently after Task 1.1. Task 1.3 follows 1.2 because
it consumes the new loader option. No task edits another task's files.

### Phase 2: Engine and Presentation Integration

**Purpose**: Make one engine-owned actionable proposal collection authoritative, then expose the
same full override evidence across evaluate, policy-plan, and ratings-sync output.

**Suggested Tasks**:

1. **Task 2.1 — Engine integration and recount (sequential after 1.4)**: Own
   `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts` and
   `packages/rfmedia-cli/src/lib/bridge/policy-engine.test.ts`. Classify after existing caps and
   refusal attribution but before rule/report counts, status, sorting, and freezing. Prove exact
   suppression, stale quarantine, outcome/absence classification, actionable-only counts,
   deterministic ordering, deep freezing, no cap refill, and stale-only fail-gate behavior.
2. **Task 2.2 — Policy evaluate/plan presentation (parallel after 2.1)**: Own
   `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` and
   `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`. Add always-visible human override
   state, full copy-grade fingerprints for explain/machine output, fixed CSV override rows and
   counts, suppressed/stale key lookup, formula-safe reasons, and post-render exit assertions.
3. **Task 2.3 — Ratings-sync presentation (parallel after 2.1)**: Own
   `packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts` and
   `packages/rfmedia-cli/src/commands/lidarr-sync-ratings.test.ts`. Surface embedded override state
   in human and explain flows so withheld-only runs cannot look like unexplained no-change results;
   preserve the outer ratings-sync v1 schema and stdout/stderr boundary.

**Dependencies**: Task 2.1 requires the report contracts and pure classifier. Tasks 2.2 and 2.3
require the final v2 report shape but can then run concurrently because they own separate files.

**Parallelization**: Two presentation tasks run in parallel after the engine contract stabilizes.

### Phase 3: Consumer Boundaries and User Documentation

**Purpose**: Prove unchanged projectors/actions cannot consume disputed decisions and document the
review, recovery, and non-authorization contract without adding a CLI surface.

**Suggested Tasks**:

1. **Task 3.1 — Pure projector boundary tests (parallel after 2.1)**: Own only
   `packages/rfmedia-cli/src/lib/bridge/policy-plan.test.ts` and
   `packages/rfmedia-cli/src/lib/bridge/rating-sync.test.ts`. Add one focused v2 regression per
   projector proving active/stale decisions are absent from cohorts and unrelated actionable
   proposals still project. Do not edit either projector unless a genuine broken invariant is
   demonstrated.
2. **Task 3.2 — Producer/apply boundary tests (parallel after 2.1)**: Own only
   `packages/rfmedia-cli/src/actions/lidarr/policy-plan.test.ts` and
   `packages/rfmedia-cli/src/actions/lidarr/sync-ratings.test.ts`. Prove fully withheld inputs call
   no producer, artifact writer, confirmation, or apply dependency in plan/apply modes. Reuse
   existing no-change control flow instead of duplicating generic producer/apply coverage.
3. **Task 3.3 — Operator documentation (parallel after 2.2 and 2.3)**: Own
   `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`,
   `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`, and
   `packages/rfmedia-cli/README.md`. Document the quoted YAML map, full-fingerprint copy/edit/rerun
   workflow, active/stale/not-evaluated lifecycle, strict loading for the three exact commands,
   post-cap non-refill, stale recovery, downstream withholding, and the fact that prior sealed
   artifacts are unaffected.

**Dependencies**: Tasks 3.1 and 3.2 can begin once the engine report is final. Task 3.3 waits for
both presentation contracts so terminology, fields, and examples match shipped output.

**Parallelization**: Projector tests and action tests run concurrently with presentation work; docs
begin once human/machine wording stabilizes.

### Phase 4: Audit, Validation, and Delivery State

**Purpose**: Validate the integrated contract, prove no forbidden surface changed, and update the
living delivery record from authoritative current data.

**Suggested Tasks**:

1. **Task 4.1 — Integrated validation (sequential after 1.3, 2.2, 2.3, 3.1, 3.2, 3.3)**: Modify no
   files except mechanical formatter output in files already owned by the responsible task. Run the
   focused config/CLI/classifier/engine/presenter/projector/action/completion tests, then package
   typecheck, architecture and codegen gates, full relevant package/root tests, formatting,
   Markdown lint, and `git diff --check`. Audit that Bash/Zsh/Fish templates, option registries,
   sealed-plan/apply/database/client/generated-code sources, and `rfmedia.example.yaml` have no
   feature diff.
2. **Task 4.2 — ROADMAP and PR closeout (sequential after 4.1)**: Own only `ROADMAP.md`. Recheck live
   issue totals and the final PR number, remove #313 from open Sprint/Phase-D/medium-backlog rows,
   record evidence-bound suppression delivery without implying force or retroactive artifact
   revocation, update the date/counts, and use `.github/pull_request_template.md` for exact test
   evidence. Do not edit the PR template, docs mirror, historical #209 design, or
   `docs/roadmap-archive.md`.

**Dependencies**: Validation must see the integrated implementation and docs. ROADMAP closeout waits
for green validation and authoritative live issue/PR evidence so it cannot publish stale totals.

## Task Granularity Recommendations

### Appropriate Task Sizes

- Keep type contracts together: splitting `types/config.ts` from `types/lidarr-policy.ts` would make
  two workers negotiate the same public v2 boundary repeatedly.
- Keep fingerprinting and classification in one module/test pair; they share one closed evidence
  vocabulary and have no independent consumer.
- Keep config validation with loader behavior because strict-mode correctness depends on the exact
  parse/validation error contract.
- Keep each presentation surface with its command test, while leaving pure projector and action
  boundary tests in separate tasks.
- Treat documentation as one three-file task so terminology and examples remain consistent.

### Tasks to Split

- Do not combine config validation, CLI ancestry, and classifier work into one task: they have
  different risks, dependencies, and natural file ownership.
- Do not combine the large policy presenter with the ratings-sync presenter; both can proceed in
  parallel once the shared report shape is fixed.
- Do not place ROADMAP edits in the documentation task; live totals and PR references are a final
  delivery-state concern.

### Tasks to Combine

- Combine golden fingerprint and classifier state tests with the new pure module rather than
  creating separate test-only tasks.
- Combine policy-plan and ratings-sync pure boundary regressions because both are small tests of the
  same central actionable-collection invariant.
- Combine final completion, architecture, formatting, and no-forbidden-diff checks into one audit
  task; they produce evidence rather than feature code.

## Dependency Analysis

### Independent Tasks (Can Run in Parallel)

- After Task 1.1: config validation/loader (1.2) and pure classifier (1.4).
- After Task 2.1: policy presentation (2.2), ratings-sync presentation (2.3), pure projector tests
  (3.1), and producer/apply boundary tests (3.2).
- After Tasks 2.2 and 2.3: operator docs (3.3) can run while boundary-test tasks finish.

### Sequential Dependencies

- Task 1.1 must precede 1.2 and 1.4 because both consume the closed config/report types.
- Task 1.2 must precede 1.3 because CLI selection consumes the strict loader option.
- Task 1.4 must precede 2.1 because the engine delegates fingerprinting/classification to it.
- Task 2.1 must precede every presenter and consumer regression because it establishes the final
  actionable-only report.
- Tasks 2.2 and 2.3 must precede 3.3 so docs reflect actual human and machine output.
- All implementation/docs tasks must precede 4.1; green validation must precede live ROADMAP
  closeout in 4.2.

### Potential Bottlenecks

- `types/lidarr-policy.ts` is the main bottleneck: its v2 shape invalidates fixtures across engine,
  command, projector, and action tests. Finish Task 1.1 first and do not let later workers edit it.
- `policy-engine.ts` is the second bottleneck: counts, status, cap timing, and the sole actionable
  collection converge there. Complete Task 2.1 before presentation fan-out.
- `lidarr-policy-presenter.ts` is shared by evaluate and policy-plan CSV and delegated by ratings
  sync. Task 2.2 owns it exclusively; Task 2.3 may import its exported helper but must not edit it.
- `ROADMAP.md` depends on live external state; touching it before final closeout risks stale totals
  and merge references.

## File-to-Task Mapping

### Files to Create

| File                                                           | Suggested Task                         | Phase | Dependencies |
| -------------------------------------------------------------- | -------------------------------------- | ----- | ------------ |
| `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`      | Pure fingerprint/classifier            | 1     | 1.1          |
| `packages/rfmedia-cli/src/lib/bridge/policy-overrides.test.ts` | Golden and table-driven pure contracts | 1     | 1.1          |

### Files to Modify

| File(s)                                                                                                                   | Suggested Task                    | Phase | Dependencies |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----- | ------------ |
| `packages/rfmedia-cli/src/types/{config,lidarr-policy}.ts`                                                                | Closed input/report v2 contracts  | 1     | none         |
| `packages/rfmedia-cli/src/lib/config.ts`, `src/lib/config.test.ts`                                                        | Validation and strict loading     | 1     | 1.1          |
| `packages/rfmedia-cli/src/cli.ts`, `src/cli.test.ts`                                                                      | Exact sensitive-command selection | 1     | 1.2          |
| `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`, `policy-engine.test.ts`                                           | Central classification/recount    | 2     | 1.4          |
| `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`, `lidarr-policy.test.ts`                                   | Evaluate/plan output and explain  | 2     | 2.1          |
| `packages/rfmedia-cli/src/commands/lidarr-sync-ratings-presenter.ts`, `lidarr-sync-ratings.test.ts`                       | Sync human/explain visibility     | 2     | 2.1          |
| `packages/rfmedia-cli/src/lib/bridge/{policy-plan,rating-sync}.test.ts`                                                   | Pure consumer exclusion           | 3     | 2.1          |
| `packages/rfmedia-cli/src/actions/lidarr/{policy-plan,sync-ratings}.test.ts`                                              | Zero producer/apply calls         | 3     | 2.1          |
| `packages/rfmedia-cli/docs/features/{lidarr-consumption-policy,lidarr-ratings-sync}.md`, `packages/rfmedia-cli/README.md` | User workflow and safety docs     | 3     | 2.2, 2.3     |
| `ROADMAP.md`                                                                                                              | Live delivery state               | 4     | 4.1          |

## Optimization Opportunities

### Maximize Parallelism

- Freeze the two public type files first, then give every later worker exclusive ownership rather
  than allowing opportunistic fixture edits across tasks.
- Use the engine report as the only integration contract; do not create matching tasks in policy
  plan or ratings sync.
- Run four Phase-2/3 workstreams concurrently after engine integration: policy presentation, sync
  presentation, pure consumer tests, and action boundary tests.
- Keep `--no-worktree`: all workers use the already-created issue worktree and coordinate through
  dependency batches, not additional worktrees.

### Minimize Risk

- Test strict highest-precedence failure before any gather/producer/prompt/apply call; permissive
  fallback would silently erase a veto.
- Hash only the feature spec's explicit scope-bound tuple. Exclude timestamps, display prose,
  rationale, ordering, credentials, and `handoff.argv`; reject non-finite/non-JSON evidence.
- Apply classification after caps and never refill suppressed slots.
- Preserve the real skip on `outcome-changed`; never synthesize a proposal from a skip.
- Keep reasons terminal-safe and CSV-formula-safe, and keep full fingerprints in copy-grade output.
- Treat old sealed artifacts as independent authorization objects; no apply-validator change is in
  scope.

## Implementation Strategy Recommendations

- Use bottom-up implementation: types, pure classifier, engine, presenters/consumers, docs, then
  integrated validation.
- Keep tests contract-focused: malformed/hostile input, golden hash boundaries, every classifier
  state, count/fail-gate consistency, and the two mutation boundaries. Avoid filler snapshots of
  Node crypto, colors, serializers, unchanged rules, or generic plan/apply behavior.
- Resolve the final feature spec over older research variants: use one `policy-overrides.ts` module,
  only `suppressed|stale|not-evaluated`, a 500-entry bound, post-cap classification, and
  command-scoped strict loading.
- Do not modify rule files, providers, adapters, clients, generated code, databases, schedulers,
  plan schemas/producers, apply/history/claim code, shell completion templates, generated config
  defaults, or `rfmedia.example.yaml`.
- Record exact focused/full validation commands and no-change completion audit results in the PR
  body using the repository template; never edit the template itself.
