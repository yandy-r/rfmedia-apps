# Task Analysis: issue-314-plex-recency-signals

## Executive Summary

Implement issue #314 as one vertical, read-only signal extension: validate and map
`lastViewedAt`, aggregate it in the existing track drain/join, resolve an optional
configuration threshold, evaluate it at the already captured clock, and expose stable
evidence. The safest shared-worktree plan has two independent foundation tasks, then
disjoint adapter/signal tasks, then one central engine owner plus independent fingerprint
work. Rule and presenter integration follow in order. Documentation can split into two
non-overlapping tasks after behavior is locked.

Do not create work for `skipCount`, `addedAt`, a second Plex request, filter pushdown,
timeline persistence, a CLI flag, or completion-template edits. Audit those boundaries
during closeout.

## Recommended Phase Structure

### Phase 0: Baseline and contract lock

- Record a clean focused-test baseline and confirm Node 22 through `mise`.
- Treat `requirements.md` and `design.md` as binding, especially positive-safe-integer
  wire validation, inclusive day boundary, no-recency/partial-recency refusal, v3 report
  versioning, and v1 fingerprint stability.
- Assign every file below to one task owner before parallel work begins.

### Phase 1: Independent foundations

Run these tasks in parallel because their files do not overlap:

- **T1 — Wire/domain contract:** add optional epoch-seconds recency to the private Plex
  track type, guard, and provider-neutral `MediaTrack`; prove valid, omitted, and malformed
  cases without epoch-zero fallback.
- **T2 — Configuration contract:** add the exact stale-rule key and 1-36,500 bounds to the
  public type and validator; prove accepted bounds, wrong type, fraction, underflow,
  overflow, and exact error path.

Phase gate: the focused wire and config suites pass.

### Phase 2: Adapter and join plumbing

After T1, run these tasks in parallel:

- **T3 — Mapper/query boundary:** preserve present `lastViewedAt`, preserve omission, and
  extend one existing page test to prove guard-plus-mapper integration. The query source
  itself should remain unchanged.
- **T4 — Policy signal contract and join:** extend policy vocabulary, report/engine version,
  resolved stale config, evaluator clock input, play-index bucket shape, and one-pass join.
  Add `lookupArtistLastViewedAt` with newest-value aggregation, zero-play omission tolerance,
  played-track partial poisoning, all-missing refusal, and existing ambiguity precedence.

Phase gate: adapter boundary and signal-join suites pass; TypeScript errors should be
limited to the not-yet-updated engine/rule consumers.

### Phase 3: Engine resolution and fingerprint vocabulary

Run these tasks in parallel after T2 and T4:

- **T5 — Engine integration:** add the exact config path, resolve absent config to `null`,
  echo configured values in the v3 report, and pass the run's `evaluatedAt` into the pure
  evaluator input. Do not read a wall clock or change gather behavior.
- **T6 — Stable evidence fingerprints:** admit the two new observation gaps and
  `older-than-days` comparator in the closed fingerprint registries. Prove time passage
  alone does not rotate evidence, while raw timestamp or threshold changes do; keep the
  fingerprint schema at v1.

Phase gate: config-resolution, report-envelope, and fingerprint suites pass.

### Phase 4: Decision and presentation integration

- **T7 — Stale-rule recency gate:** after T5, add the recency conjunct after existing
  safety gates, using the captured evaluation instant and inclusive epoch arithmetic.
  Missing/partial evidence refuses with `signal-unavailable`; recent/future values do not
  propose; exact-boundary and older values may proceed only if every earlier gate passes.
- **T8 — Human/machine presentation:** after T7, expose the configured threshold in the
  footer and pin proposal/skip explanation output, exact config path, raw ISO observation,
  comparator, and v3 fixture values. The generic JSON/YAML report should need no bespoke
  serialization path.

Phase gate: stale-rule, presenter/command, engine, and override suites pass together.

### Phase 5: Documentation and completion parity

After semantics and output are stable, run two documentation tasks in parallel:

- **T9 — User behavior:** update consumption policy, ratings sync, and the package README
  together so legacy absolute-play behavior, opt-in recency, `maxPlays` conjunction,
  missing/partial refusal, bounds, and explain output remain consistent.
- **T10 — Example and roadmap:** add a discoverable config example and update live/archive
  roadmap records without closing issue #210's timeline scope.

Phase gate: Markdown lint passes and every documented key/path matches the implementation.

### Phase 6: Completion audit

- Run focused suites, package typecheck/build/coverage, the real pre-push hook, and
  registered CI for the active head SHA.
- Run the existing Bash/Zsh/Fish parity test and record that no completion delta exists.
- Run `graphify update .`, review the final diff for scope leakage, and confirm no changes
  to database, timeline, filter, CLI option, plan operation, or gather-request surfaces.
- Before merge, verify review threads and CI. After squash merge, verify issue closure,
  ROADMAP/archive parity, remote state, and remove only the dedicated worktree/branch.

## Task Granularity Recommendations

| Task | Responsibility                  | Owned files                                                                                                    | Focused proof                                                                        |
| ---- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| T1   | Wire/domain field and guard     | `lib/adapters/plex/types.ts`; `types/media-server.ts`; `lib/adapters/plex/types.test.ts`                       | Positive safe integer accepted; omitted accepted; malformed table rejected           |
| T2   | Config type and exact validator | `types/config.ts`; `lib/config.ts`; `lib/config.test.ts`                                                       | 1/36,500 accepted; invalid equivalence classes and dotted path rejected              |
| T3   | Mapping and adapter boundary    | `lib/adapters/plex/mappers.ts`; `lib/adapters/plex/mappers.test.ts`; `lib/adapters/plex/query-library.test.ts` | Presence/absence mapping and malformed-page fail-closed behavior                     |
| T4   | Policy types, join, lookup      | `types/lidarr-policy.ts`; `lib/bridge/policy-signals.ts`; `lib/bridge/policy-signals.test.ts`                  | Newest timestamp, zero-play omission, partial/all-missing gaps, poisoning precedence |
| T5   | Resolved config, clock, report  | `lib/bridge/policy-rule-shared.ts`; `lib/bridge/policy-engine.ts`; `lib/bridge/policy-engine.test.ts`          | `null` default, configured echo, exact path, v3 envelope, captured time threading    |
| T6   | Fingerprint registry/stability  | `lib/bridge/policy-overrides.ts`; `lib/bridge/policy-overrides.test.ts`                                        | New vocabulary accepted; time stable; timestamp/threshold rotate; v1 schema retained |
| T7   | Stale evaluator                 | `lib/bridge/policy-rule-stale-monitoring.ts`; `lib/bridge/policy-rules.test.ts`                                | Pinned-time matrix plus unchanged monitoring/rating/acquisition/play gates           |
| T8   | Presenter and command contract  | `commands/lidarr-policy-presenter.ts`; `commands/lidarr-policy.test.ts`                                        | Threshold footer, causal explain, raw evidence/config path, v3 fixtures              |
| T9   | Primary user docs               | `docs/features/lidarr-consumption-policy.md`; `docs/features/lidarr-ratings-sync.md`; `README.md`              | Cross-document semantic/config parity                                                |
| T10  | Example and delivery status     | `rfmedia.example.yaml`; `ROADMAP.md`; `docs/roadmap-archive.md`                                                | Discoverable valid YAML and authoritative completion record                          |

Paths in the table are relative to `packages/rfmedia-cli/src/` for source/test files,
relative to `packages/rfmedia-cli/` for its docs/README, and repository-relative for the
final three T10 files.

Each implementation task should extend an existing suite rather than create a new test
file. Validate at task boundaries with the smallest owned suite, then validate the whole
phase because T4's central type changes intentionally precede dependent consumers.

## Dependency Analysis

```text
T1 wire/domain ──┬──> T3 mapper/query
                 └──> T4 policy types/join ──┬──> T5 engine/config ──> T7 rule ──> T8 presenter
T2 config ────────────────────────────────────┘       │
                                                      └──> T6 fingerprints
T7 + T8 ──> T9 user docs
T5 + T7 ──> T10 example/roadmap
T9 + T10 ──> completion audit
```

- T1 and T2 are the only unconditional first-wave parallel tasks.
- T3 and T4 may run in parallel after T1; they own disjoint files.
- T5 and T6 may run in parallel once T4 lands. T5 also requires T2.
- T7 must follow T5 because it consumes resolved config and captured time. T8 follows T7
  so output fixtures reflect final evidence ordering and refusal semantics.
- T9 and T10 may run in parallel only after the behavior contract is stable.
- Do not let two agents edit `types/lidarr-policy.ts`, `policy-engine.ts`, or shared command
  fixtures concurrently; those are the highest-conflict files.

## File-to-Task Mapping

The T1-T10 ownership table is exhaustive for expected edits. The following files are
**audit-only** and should not be changed unless the implementation disproves the design:

- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: already captures one
  injected `now()` and passes `evaluatedAt` to the engine.
- `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts`: already performs the one
  bounded `plexTrackPlays` drain.
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`: existing guard/mapper page
  boundary should carry the additive field automatically.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and
  `templates.spec.ts`: no CLI tokens change.
- Database, timeline, filter DSL/pushdown, Lidarr operation, and plan-producer files: no
  accepted scope requires edits.

If an audit-only file needs modification, stop that task and re-evaluate scope/dependencies
before expanding ownership.

## Optimization Opportunities

- Preserve the existing complete track snapshot; derive plays and recency in the same loop
  and expose projections/lookups from one frozen summary.
- Reuse current normalized-name ownership and poison sets. Do not build a second name index
  or introduce heuristic identity matching.
- Reuse `validateBoundedInteger`, `PolicyObservation`, generic threshold rendering, and the
  canonical fingerprint projection; the change needs vocabulary extensions, not parallel
  abstractions.
- Keep raw epoch seconds in evidence and convert only for human display. This avoids moving
  cutoff/age values in fingerprints.
- Use the existing large suites surgically: add compact table-driven malformed/config cases
  and one adapter-page case rather than duplicating integration setup.
- Run independent focused tests concurrently, but run package typecheck/build and generated
  client gates serially under Node 22.

## Implementation Strategy Recommendations

1. Land T1/T2 foundations, then T3/T4 plumbing, before touching evaluator behavior. This
   keeps malformed wire data outside policy code and makes missing evidence explicit.
2. Give one owner T4's central policy contract and join. Give another owner T5's engine
   resolution. Do not split individual central files across workers in the shared worktree.
3. Implement the evaluator as a final conjunct without reordering existing monitoring,
   identity, rating, acquisition, coverage, or play gates. Preserve legacy behavior exactly
   when `minDaysSinceLastViewed` resolves to `null`.
4. Pin rule tests to one ISO evaluation instant. Cover exact boundary, just recent, old,
   future, no coverage, partial coverage, and legacy config absence; retain one regression
   case for each earlier safety gate.
5. Prove the fingerprint contract separately from presentation: raw timestamp and threshold
   are material, captured time and computed age are not.
6. Run the focused set with `mise exec -- npm run test:run -w packages/rfmedia-cli -- <files>`,
   then package typecheck/build, coverage, architecture/codegen gates, shell-template parity,
   Markdown lint, and the real pre-push hook.
7. Finish only after registered CI is green for the final head, review feedback is resolved,
   the squash merge and issue closure are authoritative, and dedicated branch/worktree
   cleanup preserves the primary checkout and unrelated worktrees.
