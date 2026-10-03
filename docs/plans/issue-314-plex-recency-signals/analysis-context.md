# Context Analysis: issue-314-plex-recency-signals

## Executive Summary

Issue #314 is a coordinated live-signal extension to the existing Plex-to-Lidarr policy path. Add
one optional positive-safe-integer epoch-seconds field, `MediaTrack.lastViewedAt`, through the
private Plex wire guard and mapper, aggregate the newest trustworthy timestamp in the existing
one-pass normalized-name join, and make `stale-monitoring-cleanup` optionally require that timestamp
to be at least `minDaysSinceLastViewed` days old.

The approved design is binding where research considered alternatives:

- Recency is an **additional conjunct**. When configured, an artist must satisfy the existing
  lifetime `maxPlays` ceiling and the recency threshold. Operators who want previously played
  artists considered must raise `maxPlays` above zero.
- A zero-play track may legitimately omit `lastViewedAt`; it does not make recency partial. A track
  with `playCount > 0` and no timestamp makes that artist's recency unavailable.
- `skipCount`, never-viewed aging, timeline persistence, database storage, filter/pushdown, MCP,
  saved-query projection, CLI flags, and new plan operations are deferred.
- The policy evaluation schema and engine advance from v2/2 to v3/3. The evidence fingerprint
  schema remains v1 because its canonical tuple stays structurally unchanged.

The implementation must preserve every parent-policy safety invariant: one bounded complete track
drain, one weak join pass, ambiguous/sentinel poisoning, missing evidence as visible refusals, a
single injected evaluation clock, read-only evaluation, stable decision keys, and the existing
`artist-monitoring` handoff. No child issue is required for #314's accepted scope.

## Architecture Context

The end-to-end path remains:

```text
Plex track JSON
  -> isPlexWireTrack
  -> mapPlexTrack
  -> MediaTrack.lastViewedAt?
  -> existing bounded plexTrackPlays drain
  -> buildTrackJoinSummary (plays + newest complete recency)
  -> lookupArtistLastViewedAt
  -> evaluateStaleMonitoringCleanup at captured evaluatedAt
  -> stable observation/check and generic presenters
  -> existing artist-monitoring plan handoff
```

Architecture decisions:

1. `PlexWireTrack.lastViewedAt?: number` and `MediaTrack.lastViewedAt?: number` represent whole Plex
   epoch seconds visible to the resolved credential. A present value must be a positive safe
   integer. Omission is valid and must remain `undefined`; it is never mapped to epoch zero.
2. The existing `PolicySignalBundle.plexTrackPlays` slot and `gatherPlexTrackPlays` stay unchanged.
   They already carry complete `MediaTrack[]` pages through one bounded live snapshot. Renaming or
   duplicating the signal would widen public registries and risk inconsistent snapshots.
3. Extend `buildTrackJoinSummary` rather than creating a second join. Each unpoisoned normalized
   artist bucket tracks total plays, track sample size, maximum `lastViewedAt`, timestamp-bearing
   rows, and played rows missing timestamps.
4. Add `lookupArtistLastViewedAt`, returning the raw latest timestamp with
   `join: "normalized-name"`, or a named gap: `no-recency-coverage`,
   `partial-recency-coverage`, or an existing ambiguity/sentinel/no-track gap.
5. Add optional `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed`, valid from 1 through
   36,500 inclusive. Resolve it to `number | null`; `null` preserves legacy absolute-play behavior.
6. Thread `PolicyEvaluationRunInput.evaluatedAt` into `PolicyEvaluationInput`. The pure evaluator
   applies the inclusive check
   `evaluatedAtSeconds - latestLastViewedAt >= minDaysSinceLastViewed * 86,400`; future timestamps
   fail the recency gate.
7. Represent the temporal threshold with comparator `older-than-days`, stable raw timestamp
   evidence, the configured integer day bound, and the exact dotted config path. Computed age may
   appear in the non-fingerprinted summary but must not enter fingerprint material.
8. Advance `POLICY_EVALUATION_SCHEMA` and `POLICY_ENGINE_VERSION` to v3/3 because resolved-policy,
   observation-gap, and comparator vocabularies change. Keep `POLICY_EVIDENCE_FINGERPRINT_SCHEMA`
   at v1; extend its closed allowlists only.

## Critical Files Reference

| File                                                                                    | Responsibility and required change                                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`                                   | Add private optional wire field and a positive-safe-integer present-value guard.                                       |
| `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`                                 | Copy `lastViewedAt` without a default; Plex DTOs must not escape.                                                      |
| `packages/rfmedia-cli/src/types/media-server.ts`                                        | Add provider-neutral optional epoch-seconds field to immutable `MediaTrack`.                                           |
| `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`                           | Existing page guard/mapper integration; no new endpoint or filter.                                                     |
| `packages/rfmedia-cli/src/types/config.ts`                                              | Add optional `minDaysSinceLastViewed` to stale-policy configuration.                                                   |
| `packages/rfmedia-cli/src/lib/config.ts`                                                | Add exact key and 1..36,500 integer validation with exact property paths.                                              |
| `packages/rfmedia-cli/src/types/lidarr-policy.ts`                                       | Add resolved config field, temporal comparator, recency gaps/index contract, evaluation time, and v3 report constants. |
| `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts`                              | No algorithmic change; retain complete bounded `plexTrackPlays` drain and unavailable-slot conversion.                 |
| `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`                            | Continue capturing one injected clock and pass the same `evaluatedAt` through the engine.                              |
| `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`                                 | Extend the single join summary and add fail-closed latest-view lookup.                                                 |
| `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`                                  | Resolve nullable threshold, pass evaluation time, build shared play/recency indexes, and emit v3 report.               |
| `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts`                             | Add exact config path and retain deterministic ranking/helper conventions.                                             |
| `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts`                   | Add recency after existing identity/monitoring/rating/acquisition/coverage gates and before proposal construction.     |
| `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`                               | Admit new comparator/gaps while keeping stable canonical fingerprint projection and schema v1.                         |
| `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`                          | Add footer threshold and readable ISO/age explain rendering through generic checks/observations.                       |
| `packages/rfmedia-cli/src/lib/adapters/plex/{types,mappers,query-library}.test.ts`      | Prove valid/omitted/malformed wire behavior and adapter-boundary mapping.                                              |
| `packages/rfmedia-cli/src/lib/{config.test.ts,bridge/policy-signals.test.ts}`           | Prove bounds/property paths and newest/none/partial/poisoned join semantics.                                           |
| `packages/rfmedia-cli/src/lib/bridge/{policy-rules,policy-overrides}.test.ts`           | Prove pinned-clock rule matrix and stable-vs-rotating fingerprint cases.                                               |
| `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`                               | Prove human explain, machine report vocabulary, comparator, and exact config path.                                     |
| `packages/rfmedia-cli/docs/features/{lidarr-consumption-policy,lidarr-ratings-sync}.md` | Replace absolute-only caveats with legacy/conjunctive recency behavior and refusals.                                   |
| `packages/rfmedia-cli/README.md` and `rfmedia.example.yaml`                             | Make key, bounds, default, `maxPlays` interaction, and account scope discoverable.                                     |
| `ROADMAP.md` and `docs/roadmap-archive.md`                                              | Record authoritative #314 completion without rewriting historical #209 behavior or closing #210 scope.                 |

## Patterns to Follow

- Private adapter boundary: follow `PlexWireTrack` -> `hasCommonTrackFields` ->
  `isPlexWireTrack` -> `mapPlexTrack` -> `MediaTrack`. Higher action/policy layers must not import
  private `lib/adapters/plex/*` modules; the façade architecture check treats type-only imports as
  violations too.
- Preserve optional evidence: use an optional field assignment, not `?? 0`. Counts may have zero
  defaults; timestamps may not.
- Complete data before policy: keep page validation, pagination progress checks, 200,000-track hard
  bound, cancellation, and unavailable-slot conversion in the existing gatherer path.
- One normalized-name pass: extend `TrackJoinSummary`, then derive both play and recency indexes
  from it. Reuse `normalizeBridgeArtistName`, ambiguous ownership poisoning, and the
  `Unknown Artist` sentinel.
- Gaps are typed data: extend `PolicyObservationGap` and return unavailable observations. The
  evaluator emits a visible `signal-unavailable` refusal; it never drops a subject or invents a
  timestamp.
- Pure deterministic rules: inject evaluation time through typed input. No `Date.now()`, client,
  adapter, or I/O handle belongs in policy rule code.
- Exact configuration: follow `validatePolicyStaleMonitoringConfig`, centralized defaults in
  `resolvePolicyConfig`, and `POLICY_CONFIG_PATH`. Unknown keys and invalid values must report the
  precise dotted property path.
- Generic explain machinery: enrich `PolicyThresholdCheck` and `PolicyObservation`; do not build a
  separate recency-only output path. Preserve JSON/YAML/CSV projection through existing report
  serialization.
- Immutable/exhaustive contracts: use `readonly`, frozen outputs, `as const`, exhaustive switches,
  and total `Record` maps with `satisfies`. Keep `types/lidarr-policy.ts` free of value imports.
- Stable review evidence: decision keys remain `stale-monitoring-cleanup:artist:<lidarrId>`.
  Fingerprint raw `lastViewedAt` and configured days, never the moving cutoff or computed age.
- Focused tests: extend current suites at each changed boundary. Do not create duplicate test files
  or coverage for explicitly unchanged database, timeline, filter, MCP, or completion surfaces.

## Cross-Cutting Concerns

- Safety precedence: keep monitoring convergence, authoritative identity, trustworthy weak join,
  rating veto, acquisition coverage, play ceiling, and proposal cap behavior. Recency adds evidence;
  it does not bypass any prior refusal.
- Missing/partial semantics:
  - all joined tracks lack timestamps -> `no-recency-coverage`;
  - any played joined track lacks a timestamp -> `partial-recency-coverage`;
  - zero-play omission -> tolerated but supplies no recency evidence;
  - malformed present timestamp -> whole Plex page invalid and signal unavailable;
  - ambiguity/sentinel poisoning -> existing higher-precedence refusal.
- Time arithmetic: use integer epoch seconds and 86,400-second days at the captured evaluation
  instant. Test exact inclusive boundary, one second recent, one second old, and future values.
- Account scope: `viewCount` and `lastViewedAt` are only the values visible to the resolved Plex
  credential. Retain the `totalPlaysObserved === 0` whole-rule safety gate and do not claim stronger
  account semantics than the wire response proves.
- Overrides: adding recency evidence correctly makes previously reviewed stale-rule suppressions
  report `evidence-changed` once. Later clock passage alone must not rotate them. Timestamp or
  threshold changes must rotate them.
- Machine compatibility: v3/3 is an intentional public evaluation-envelope change. The Lidarr plan
  artifact schema and fingerprint schema do not change.
- Shared policy consumers: config-only semantics automatically reach `policy evaluate`, `policy
plan`, and `sync-ratings`; documentation and tests must describe their common behavior.
- Documentation consistency: update repeated absolute-only statements together, document the
  continued `maxPlays` conjunct, explain never-viewed refusal, and leave #210's longitudinal
  analytics open.
- Completion parity: no CLI token changes, so Bash/Zsh/Fish templates should not be edited. Still
  audit all three and run their parity test, recording the no-change result.
- Repository contracts: use Node 22 through `mise exec -- ...`, ESM `.js` import specifiers,
  architecture/codegen checks, the real `lefthook` pre-push path, registered CI, and
  `graphify update .` after code changes.

## Parallelization Opportunities

The work can use dependency-aware parallel batches with strict file ownership:

1. Foundation batch:
   - Contract owner: `types/media-server.ts`, `types/config.ts`, and `types/lidarr-policy.ts`.
   - This batch fixes names and shapes first; downstream owners should not invent alternatives.
2. After foundation, parallel implementation:
   - Adapter owner: private wire guard, mapper, query-boundary assertions, and their three focused
     test files.
   - Configuration owner: exact-key validator/default resolution plus `config.test.ts`.
   - Join owner: combined track summary, latest-view lookup, and `policy-signals.test.ts`.
3. Policy integration batch after join/config:
   - Engine/rule owner: clock threading, conjunctive gate, v3 report, and pinned rule tests.
   - Evidence/output owner: override allowlists/goldens, presenter formatting, and command tests.
     These can proceed in parallel after the comparator, gap, and observation contracts are fixed.
4. Documentation/closeout batch after behavior stabilizes:
   - Update the two feature docs, package README, example YAML, ROADMAP, and archive.
   - Independently audit Bash/Zsh/Fish completion parity and assemble exact verification evidence.
5. Verification can fan out by independent gate: focused Vitest suites, typecheck/build,
   architecture/codegen, formatting/Markdown lint, and documentation/completion parity, followed by
   the serial real pre-push hook and CI lifecycle.

Avoid concurrent edits to `types/lidarr-policy.ts`, `policy-engine.ts`, or shared test fixtures.
Agents share one filesystem and must not revert, overwrite, or reformat unrelated work.

## Implementation Constraints

- Implement the exact approved names: `lastViewedAt`, `minDaysSinceLastViewed`,
  `older-than-days`, `no-recency-coverage`, and `partial-recency-coverage`.
- Wire timestamps are optional positive safe integers. Reject numeric strings, `null`, nonfinite,
  fractional, zero, negative, and unsafe integers when present.
- Configuration is optional, integer-only, and bounded to 1..36,500. Unset resolves to `null` and
  preserves legacy absolute-play-only behavior.
- Configured recency is conjunctive with `maxPlays`; do not substitute recency for lifetime plays
  despite earlier research considering that alternative.
- Do not add a second Plex request, second normalization pass, `plexTrackRecency` signal, database
  migration, cache schema, saved-query field, timeline table, filter field/pushdown, MCP field,
  `skipCount`, `addedAt`, CLI option, or completion token.
- Do not weaken the complete-drain or wrong-account safety gates. Partial libraries and partial
  recency cannot support an unmonitor proposal.
- Do not fingerprint computed age, evaluation time, or a moving cutoff. Keep fingerprint schema v1
  and existing non-recency proposal hashes stable.
- Do not create a new plan operation. Evaluation remains read-only; the existing plan/apply
  separation and `artist-monitoring` producer remain authoritative.
- Add only critical tests mapped to acceptance evidence. Run generated Lidarr/codegen-related
  checks serially and use the Node 22 runtime contract.
- No child issue is needed for accepted scope. Deferred work remains #210 or a separately accepted
  future issue rather than expanding #314.

## Key Recommendations

1. Freeze the contract vocabulary and v3/v1 schema decisions before parallel coding.
2. Implement wire/domain/config types first, then adapter, join, and config validation in parallel.
3. Extend the existing track bucket with recency completeness; never derive a maximum without
   recording played-row omissions.
4. Thread the already captured `evaluatedAt` into pure input and use a stable temporal check shape
   so time passage alone cannot invalidate overrides.
5. Preserve the approved conjunctive semantics and document the operational consequence of the
   default `maxPlays: 0` prominently.
6. Treat no-recency and partial-recency cases as visible subject refusals and malformed pages as
   unavailable whole signals.
7. Keep optional surfaces out. The complete live policy slice is sufficient for #314 and reusable
   by #210 later without importing timeline behavior now.
8. Validate only the changed contracts with focused tests, then run the full Node 22 architecture,
   completion-parity, hook, and CI gates before merge and closeout.
