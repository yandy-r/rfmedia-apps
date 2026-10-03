# Context Analysis: lidarr-discovery-safety

## Executive Summary

Extend the shipped `rfmedia lidarr discover` flow with a deterministic, bounded policy layer while
preserving its strongest safety boundary: ordinary discovery remains a one-hop, attributed,
read-only Last.fm preview with zero Lidarr calls, prompts, plan writes, or persistent quarantine
state. Deep discovery is explicit breadth-first traversal capped at depth two; candidates are
filtered, deduplicated, ranked, and quarantined before explicit visible-rank selection can promote
them into one sealed `artist-add` plan. Only the existing separately reviewed
`rfmedia lidarr apply` workflow may mutate Lidarr.

The implementation spans more than the discovery action because `--add` must accept multiple ranks.
The current artist-add artifact and apply path assume one entry and `maxBatch: 1`; they must widen
to a non-empty readonly entry array while preserving existing single-entry plans, exact-MBID
revalidation, possible-dispatch recovery, per-entry history, and stop-after-uncertainty behavior.
No database migration, generated Lidarr client change, new provider endpoint, or direct mutation
path is required.

## Architecture Context

The target flow is:

```text
Commander grammar and fail-fast parsing
  -> framework-independent discovery action
  -> discovery scheduler lane
  -> fixed-origin Last.fm transport
  -> pure policy evaluation and bounded BFS admission
  -> attributed quarantine preview
  -> explicit visible-rank selection
  -> fresh exact-MBID Lidarr resolution
  -> one sealed multi-entry artist-add plan
  -> later lidarr apply review, confirmation, revalidation, and dispatch
```

- `packages/rfmedia-cli/src/types/discovery.ts` owns immutable, generated-client-independent
  policy, traversal, decision, handoff, and output contracts. Stable defaults and hard bounds
  belong beside these types and must be reused by the command and action.
- New `packages/rfmedia-cli/src/lib/discovery/policy.ts` owns pure option validation, identity,
  thresholding, admission, exposure scoring, quarantine decisions, and deterministic ranking. It
  must not import Commander, configuration, Fetch, Lidarr, prompts, filesystem code, or global
  state.
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts` owns runtime revalidation, the BFS queue,
  invocation-wide visited/budget state, scheduler/provider calls, attribution, and optional plan
  handoff. Preview logic must not resolve a Lidarr execution context.
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts` owns public options, Commander parsers,
  option relationships, lazy action loading, stable text/JSON/YAML/CSV rendering, and exit status.
  It must render exactly one document; machine formats never prompt.
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts` remains the sole Last.fm Fetch and credential
  owner. Each `getSimilarArtists()` call performs exactly one bounded request; retries,
  concurrency, cancellation, and transient classification remain scheduler-owned.
- The handwritten `packages/rfmedia-cli/src/lib/lidarr/client.ts` facade and
  `packages/rfmedia-cli/src/lib/lidarr/transport.ts` remain the only Lidarr integration boundary.
  Discovery policy must not import `packages/rfmedia-cli/src/lib/lidarr/generated/` or handwrite
  `/api/v1/` routes.
- Candidate approval authorizes plan creation only. Artist creation stays in the existing apply
  path with default-no review, explicit `--yes` for non-interactive mutation, live resource/state
  revalidation, durable possible-dispatch evidence, and exact-MBID reconciliation.

Resolved policy:

- Provider request limit remains `1..100`.
- `minSimilarity`: inclusive finite `0..1`, default `0`.
- `maxPerSeed`: positive safe integer, default `10`, maximum `100`.
- Default depth is `1`; `--deep` fixes depth at `2`; `--no-cascade` forces depth one and conflicts
  with `--deep`.
- Invocation-wide visited-seed/request budget is `25`.
- Invocation-wide visible-candidate budget is `100`.
- `diversityBoost` and `popularityDampening`: finite `0..1`, default `0`.
- `maxAdd`: positive safe integer, default `1`, maximum `25`.
- `--add <ranks>` accepts comma-separated positive visible ranks. Duplicate, missing, ineligible,
  or over-budget selections fail before any plan write.

Traversal is deterministic breadth-first. Register the initial seed before its request and register
each admitted identity before enqueueing it, preventing concurrent parents from scheduling the
same candidate. Identity is `mbid\0<canonical-lowercase-mbid>` when possible, otherwise
`lastfm-name\0<NFC-case-folded-name>`. The fallback is preview-safe only; an MBID is mandatory for
promotion. Duplicate paths increase exposure evidence but do not create another visible row or
request.

Threshold raw similarity before applying `maxPerSeed`, traversal admission, or visible ranking.
Never overwrite Last.fm similarity. Compute a separate bounded score:

```text
novelty = 1 / exposureCount
exposure = (exposureCount - 1) / exposureCount
adjustedScore = clamp(
  similarity
  + diversityBoost * novelty * (1 - similarity)
  - popularityDampening * exposure * similarity,
  0,
  1
)
```

“Popularity” must be reported as `graph-exposure`; the provider supplies no listener, play-count,
tag, or genre data. Order by adjusted score descending, raw similarity descending, depth
ascending, first-seen sequence ascending, then normalized name ascending.

## Critical Files Reference

| Path                                                                          | Implementation responsibility                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/discovery.ts`                                 | Public constants, policy, traversal, candidate lifecycle, provenance, and handoff contracts  |
| `packages/rfmedia-cli/src/types/index.ts`                                     | Re-export new public discovery contracts                                                     |
| `packages/rfmedia-cli/src/lib/discovery/policy.ts`                            | New pure identity, admission, scoring, ranking, and quarantine logic                         |
| `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`                            | Preserve fixed-origin provider projection and secret-safe errors                             |
| `packages/rfmedia-cli/src/actions/lidarr/discover.ts`                         | Bounded BFS, invocation budgets, scheduling, cancellation, result assembly, and rank handoff |
| `packages/rfmedia-cli/src/commands/lidarr-discover.ts`                        | Flags, parsers, grammar, lazy loading, and all output formats                                |
| `packages/rfmedia-cli/src/actions/lidarr/index.ts`                            | Lazy action/type exports                                                                     |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`                  | Multi-rank exact-MBID resolution and atomic one-plan construction                            |
| `packages/rfmedia-cli/src/types/lidarr-plan.ts`                               | Non-empty readonly artist-add entries with single-entry compatibility                        |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`                          | Multi-entry validation, checksum, origin, resource, and `maxBatch` invariants                |
| `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`                 | Ordered multi-entry apply orchestration and uncertainty admission stop                       |
| `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts` | Existing possible-dispatch marker and exact-MBID reconciliation boundary                     |
| `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`              | Review display for all approved entries without weakening confirmation                       |
| `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`                    | Traversal, budgets, cancellation, preview isolation, and handoff tests                       |
| `packages/rfmedia-cli/src/lib/discovery/policy.test.ts`                       | New focused pure-policy contract tests                                                       |
| `packages/rfmedia-cli/src/commands/lidarr.test.ts`                            | Grammar, forwarding, fail-fast, output, and selection tests                                  |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`                      | Bash public option surface                                                                   |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`                       | Zsh public option surface                                                                    |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`                      | Fish public option surface                                                                   |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`            | Ordered cross-shell option/value/file parity                                                 |
| `packages/rfmedia-cli/docs/features/lidarr-discovery.md`                      | Canonical operator policy and output contract                                                |
| `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`                     | Multi-entry plan and separate mutation approval contract                                     |
| `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`                | Invocation budgets layered over scheduler lane budgets                                       |
| `packages/rfmedia-cli/README.md`                                              | Public examples, defaults, and safe workflow                                                 |
| `packages/rfmedia-cli/CHANGELOG.md`                                           | Unreleased feature record                                                                    |
| `ROADMAP.md`                                                                  | Live issue state                                                                             |
| `docs/roadmap-archive.md`                                                     | Post-merge #205/PR/date record                                                               |

## Patterns to Follow

- Use readonly interfaces, literal/discriminated unions, frozen arrays/objects, stable reason codes,
  and omitted optional properties rather than explicit `undefined`.
- Validate twice: Commander parsers/grammar reject malformed flags and relationships before lazy
  action import; action/policy validation rejects invalid plain runtime inputs before config,
  scheduler, provider, Lidarr, or filesystem work.
- Use `InvalidArgumentError` for malformed values,
  `MissingRequiredArgumentError` for invalid relationships, and
  `LidarrValidationError("lidarr discover", ...)` at the runtime policy boundary.
- Keep the command factory in `packages/rfmedia-cli/src/commands/lidarr.ts`, lazy action exports,
  and thin command/action separation. Map Commander negated booleans explicitly.
- Treat `filtered`, `visited`, `quarantined`, and `approved` as invocation-scoped result states with
  stable reasons. Do not expose internal `Set`/`Map` state or imply a durable queue.
- Preserve one JSON/YAML envelope, text policy/traversal/handoff summaries, and a fixed-column CSV
  with its mandatory summary row even when no candidates are visible.
- Preserve Last.fm attribution, scheduler execution metadata, raw similarity, original seed,
  depth, provider rank, first path, exposure count, adjusted score, and mutation eligibility.
- Reuse scheduler classification and retries; schedule each visited seed as its own idempotent
  discovery task. Do not hide a graph walk inside one task or add transport retries.
- Follow existing Vitest ESM seams with `vi.hoisted()` and pre-import `vi.mock()`. Use the real
  scheduler for traversal behavior, a Lidarr mock only for handoff, and temporary directories only
  for actual artifact-write assertions.

## Cross-Cutting Concerns

- **Plan/apply safety:** Process selected candidates in visible-rank order, require canonical MBIDs,
  freshly prove exact unambiguous Lidarr lookups, classify already-present candidates, resolve root
  folder/quality/metadata profiles once, and write at most one plan. Each addable candidate gets
  independent discovery provenance; `maxBatch` equals the approved addable entry count and cannot
  exceed resolved `maxAdd`. Invalid or ambiguous selections produce no partial plan.
- **Compatibility:** Widen artist-add entries to a non-empty readonly array without invalidating
  existing one-entry artifacts. Apply entries through existing per-entry execution/history,
  possible-dispatch, and reconciliation machinery; stop admitting later entries after uncertainty.
- **Budget ownership:** Scheduler `runBatch()` budgets reset per call, so the action must enforce
  invocation-wide visited/request and visible budgets across BFS waves. Check every cap before
  scheduling or writing the next unit of work. Cancellation prevents later-wave admission and must
  reach every already-scheduled provider call.
- **Failure semantics:** Provider failures retain `LastFmProviderError` metadata. Filtering and
  ineligibility are result data. Optional Lidarr planning failure preserves the full attributed
  preview as one `handoff.status: "failed"` document, then sets failure exit status.
- **Security:** Last.fm and Lidarr credentials must never enter policy state, visited keys, output,
  logs, errors, plans, or caches. Preserve fixed origins, redirect rejection, bounded bodies,
  cancellation, timeout behavior, and centralized redaction.
- **Public parity:** Text, JSON, YAML, CSV, Bash, Zsh, Fish, feature docs, README, and changelog must
  describe the same defaults, caps, rank grammar, statuses, scores, and approval boundary.
- **Lifecycle:** Update `ROADMAP.md` from current GitHub state only at delivery closeout; archive
  #205 with the merged PR and date. Keep #204, #206, and #219 open and separate.

## Parallelization Opportunities

1. **Policy/types track:** Define discovery constants and immutable result contracts, then implement
   and unit-test `policy.ts`. This is the foundation for all other tracks.
2. **Plan/apply track:** In parallel after the multi-entry type shape is agreed, widen
   `lidarr-plan.ts`, plan-engine validation, plan construction, apply orchestration, presenter, and
   focused compatibility/uncertainty tests.
3. **CLI/output track:** After discovery result types stabilize, add option grammar, forwarding,
   text/machine projections, command tests, and all three completion templates plus their single
   parity test.
4. **Traversal track:** After policy APIs exist, refactor `discover.ts` to bounded BFS and integrate
   multi-rank handoff; add scheduler/budget/cancellation/no-Lidarr-preview tests.
5. **Documentation track:** Draft operator, plan/apply, execution-lane, README, and changelog
   updates against the resolved design, then finalize exact examples and lifecycle records after
   implementation and CI evidence.

Avoid concurrent edits to `packages/rfmedia-cli/src/types/discovery.ts`,
`packages/rfmedia-cli/src/actions/lidarr/discover.ts`, or
`packages/rfmedia-cli/src/types/lidarr-plan.ts`; they are dependency hubs. The main integration
order is types/policy, multi-entry plan contract, traversal/handoff, CLI/output, then full
documentation and validation.

## Implementation Constraints

- Preserve plain discovery as one-hop and completely Lidarr-independent; `--max-add` without
  `--add` only changes reported policy.
- Resource/profile/plan options remain illegal without `--add`. Candidate selection is explicit;
  it does not prompt and is not mutation approval.
- Enforce `maxPerSeed` after thresholding and before enqueue/visible admission. Enforce all global
  caps before scheduling or writing.
- MBID-less recommendations may be visible but never selected for an artist-add plan.
- One invocation writes no more than one plan. Do not silently create multiple artifacts from one
  `--plan-file`.
- Do not add discovery persistence or reuse `lidarr_metadata_cache`, `lidarr_deferred_intents`, or
  `lidarr_circuit_state`; ranks and quarantine are invocation-local.
- Do not modify the generated Lidarr SDK, its snapshot, or transport architecture. Generated-client
  drift checks still remain required validation gates.
- Do not add Last.fm enrichment calls or claim literal popularity/genre diversity. Use only
  disclosed graph-exposure evidence.
- Do not absorb #204 provider federation/cache, #206 monitoring/search/profile defaults or
  normalization, or #219 downstream indexer/download impact estimation.
- Do not duplicate existing transport, scheduler retry, checksum, apply-confirmation, or
  single-entry reconciliation tests unless the underlying contract changes.

## Key Recommendations

1. Land the public discovery and multi-entry plan type contracts first; they determine safe
   parallel work and prevent presentation/orchestration drift.
2. Keep identity and policy in one pure module so seed exclusion, loop prevention, duplicate-path
   exposure, eligibility, and ranking cannot disagree.
3. Make traversal limits compile-time public constants and return both resolved policy and hard
   bounds in every successful result.
4. Treat the multi-entry plan change as a safety-critical compatibility migration: validate the
   complete selection before writing, reuse resources once, retain per-entry provenance, and stop
   after uncertain dispatch.
5. Add only boundary-focused tests, then run package tests/coverage, typecheck/build, architecture
   checks, Lidarr codegen checks/tests, formatting, markdown lint, completion parity, and repository
   pre-push/CI gates.
6. Verify the final implementation against all ten acceptance criteria in
   `docs/plans/lidarr-discovery-safety/design.md`, with explicit evidence that default preview makes
   zero Lidarr calls and bounded deep traversal cannot exceed any invocation-wide cap.
