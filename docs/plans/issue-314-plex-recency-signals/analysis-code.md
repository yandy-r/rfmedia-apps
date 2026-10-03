# Code Analysis: issue-314-plex-recency-signals

## Executive Summary

Issue #314 is an additive extension of the existing Plex track-to-policy pipeline, not a new
pipeline. The implementation should validate and map optional `lastViewedAt` epoch seconds, carry
them through the existing bounded `plexTrackPlays` slot, and extend the existing one-pass weak-name
join with a fail-closed recency observation. The stale rule then applies the optional
`minDaysSinceLastViewed` threshold against the action's captured `evaluatedAt`; when the key is
unset, the existing absolute-play behavior and existing proposal fingerprints must remain
unchanged.

The highest-risk code is the join and decision evidence, not the wire field itself. Recency must
reuse ambiguous-name and sentinel poisoning, distinguish no coverage from partial coverage, avoid
wall-clock reads, and fingerprint only stable raw evidence. No database, timeline, filter, MCP,
plan-operation, CLI-option, or completion implementation belongs in this change.

## Existing Code Structure

- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts` owns the private `PlexWireTrack` DTO and
  `isPlexWireTrack`. Optional consumed fields are validated by `hasCommonTrackFields`; present
  malformed fields invalidate the whole metadata response.
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts` is the sole Plex-to-domain projection.
  `mapPlexTrack` currently defaults `viewCount`, duration, artist, album, and path, while preserving
  genuinely optional metadata such as `year` without a default.
- `packages/rfmedia-cli/src/types/media-server.ts` owns provider-neutral `MediaTrack`. The policy
  layer receives only this domain type; private Plex DTOs do not cross the adapter boundary.
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts` composes endpoint-specific wire
  guards with mappers through `toPage`. A failed guard becomes a typed `MediaServerError` with
  `invalid-response`; the track query, album children, and exact track lookup all use the same
  track guard and mapper.
- `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts` drains the full Plex track library once,
  with a 200,000-item bound, and returns the result in the existing `plexTrackPlays` slot. Failures
  become unavailable signal data rather than thrown policy decisions.
- `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts` owns the weak normalized-name join.
  `buildTrackJoinSummary` walks the track array once, computes play buckets and coverage counters,
  and poisons ambiguous and `Unknown Artist` keys. `lookupArtistPlays` converts buckets and poison
  states into explicit observations or gaps.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts` centralizes defaults in
  `resolvePolicyConfig`, constructs the track summary once in `buildIndexes`, dispatches pure rule
  evaluators, and emits the versioned report. `PolicyEvaluationRunInput` already carries the ISO
  `evaluatedAt`, but the narrower `PolicyEvaluationInput` passed to rules does not.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts` is a pure, synchronous,
  fail-closed evaluator. Its current order is whole-library sanity, identity/monitoring, play
  coverage, rating veto, acquisition coverage, blocking-cause selection, and `maxPlays`, followed
  by the existing `artist-monitoring --unmonitored` handoff.
- `packages/rfmedia-cli/src/types/config.ts` declares the optional public stale-rule shape;
  `packages/rfmedia-cli/src/lib/config.ts` validates exact keys and bounded integers without
  injecting defaults.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts` contains the closed report vocabulary:
  observation gaps, observation values, threshold comparators, resolved rule shape, join indexes,
  evaluator input, report schema, and engine version.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts` centralizes exact dotted config paths;
  `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts` validates closed evidence vocabularies
  and canonically fingerprints checks and observations.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` generically renders observations
  and checks, including each configured check's exact config path. It separately renders resolved
  rule thresholds in the footer.

## Implementation Patterns

- **Private wire validation before mapping:** Add `lastViewedAt?: number` to `PlexWireTrack` and
  validate a present value as a positive safe integer. The current finite-number helper is too
  permissive because it accepts fractions, zero, negatives, and unsafe integers. Omission remains
  valid; a malformed present value rejects the page.
- **Preserve optional domain evidence:** Add `lastViewedAt?: number` to `MediaTrack` and copy it in
  `mapPlexTrack` using optional-property semantics. Do not follow the `viewCount ?? 0` pattern;
  there is no safe epoch-zero fallback.
- **Reuse the existing signal:** Keep the `plexTrackPlays` registry name and gatherer. The slot
  already contains complete `MediaTrack[]`, so recency needs neither another signal nor another
  Plex request.
- **One-pass aggregate with honest completeness:** Extend each unpoisoned track bucket with the
  maximum timestamp, timestamp count, and count of played tracks missing a timestamp. Missing
  timestamps on zero-play tracks do not make an otherwise observed bucket partial. Any played
  track missing the timestamp makes recency unavailable for that artist.
- **Observation lookup mirrors play lookup:** Add a focused recency lookup over the same index. It
  must check sentinel and poisoned keys before bucket coverage, return
  `partial-recency-coverage` before an observed maximum, and return `no-recency-coverage` when no
  timestamp exists. An observed value uses `join: "normalized-name"` and the timestamp-bearing row
  count as `sampleSize`.
- **Defaults only in the resolver:** Add `minDaysSinceLastViewed?: number` to config input, validate
  `1..36_500`, and resolve it to `number | null` in `resolvePolicyConfig`. The validator must not
  invent `null` or any other default.
- **Pure pinned-time evaluation:** Thread the same `evaluatedAt` value from
  `PolicyEvaluationRunInput` into `PolicyEvaluationInput`. The stale evaluator computes the
  inclusive boundary in epoch seconds with `86_400` seconds per day and performs no `Date.now()` or
  I/O. A future timestamp fails the age check.
- **Stable evidence projection:** When recency is configured, store the raw epoch seconds as the
  observation. The `older-than-days` check stores the stable ISO rendering of that timestamp as
  `observed`, the configured integer days as `bound`, and the exact config path. Do not store the
  moving cutoff or computed age in checks or observations; computed age may appear only in summary
  prose, which the fingerprint deliberately excludes.
- **Opt-in evidence only:** When `minDaysSinceLastViewed` is `null`, do not add a recency check or
  observation to a legacy proposal. This is required for existing non-recency fingerprints to stay
  byte-for-byte stable.
- **Closed unions stay synchronized:** Add `older-than-days` to the comparator type and override
  registry, and add both recency gaps to `PolicyObservationGap` and the fingerprint registry. The
  compile-time completeness object in `policy-overrides.ts` is intended to catch drift.

## Integration Points

### Files to modify

- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`: wire field and strict optional positive
  safe-integer guard.
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`: preserve the optional timestamp.
- `packages/rfmedia-cli/src/types/media-server.ts`: provider-neutral domain field and epoch-seconds
  documentation.
- `packages/rfmedia-cli/src/types/config.ts`: optional stale-rule config field.
- `packages/rfmedia-cli/src/lib/config.ts`: exact-key registration, `36_500` ceiling, and bounded
  validation.
- `packages/rfmedia-cli/src/types/lidarr-policy.ts`: v3/3 report version, recency gaps, comparator,
  resolved config, extended index shape, and `evaluatedAt` in evaluator input.
- `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`: one-pass timestamp aggregation and
  recency lookup over existing poisoned buckets.
- `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: `null` default, resolved echo, shared
  timestamp-bearing index, and captured time threading.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts`: canonical
  `staleMinDaysSinceLastViewed` config path.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts`: optional recency conjunct,
  fail-closed gaps, stable observation/check, and updated summary.
- `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts`: comparator and observation-gap closed
  registries only; keep `POLICY_EVIDENCE_FINGERPRINT_SCHEMA` at v1.
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`: include the new resolved threshold
  in the footer. Generic observation/check rendering should be reused rather than special-cased.

### Existing boundaries that require no production change

- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`: the guard-plus-mapper composition
  automatically carries the new field; only its focused integration fixture/test changes.
- `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts`: the existing bounded drain already
  carries the expanded `MediaTrack` domain object.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: it already captures injected
  `now()` once inside the scheduled run. No second clock call or dependency is needed.
- No new source file, database migration, schema table, filter field, pushdown translator, MCP
  schema, timeline record, plan operation, command flag, or shell completion entry should be
  created.

## Code Conventions

- Use `readonly` interfaces, discriminated unions, `Object.freeze` at returned public boundaries,
  and explicit `undefined` omission patterns already used in the config validator and resolver.
- Use `unknown` at the Plex transport boundary and narrow through endpoint-specific guards before
  mapping. Errors at this boundary use typed `MediaServerError` codes, not raw parser exceptions.
- Preserve registry declaration order for policy rules and signals, and use centralized constants
  for public strings such as config paths, comparators, gaps, and report versions.
- Policy rules are pure functions over `PolicyEvaluationInput`; I/O and clocks remain action-layer
  dependencies.
- Refusals are report data. Missing, ambiguous, partial, or malformed evidence must never be
  silently converted to zero or omitted from the decision trail.
- Tests use compact immutable fixtures, `it.each` tables for invalid equivalence classes, exact
  object assertions at mapping/report boundaries, and pinned timestamps for deterministic policy
  decisions.

## Dependencies and Services

- Plex is the only external provider involved. Its track JSON exposes epoch seconds, while the
  adapter keeps Plex-specific wire types private.
- The existing media-server adapter and cache need no API change beyond the additive `MediaTrack`
  property; cached pages naturally contain the mapped value for their existing lifetime.
- Lidarr remains the identity, monitoring, rating-veto, and acquisition source. Recency does not
  change the existing authoritative MBID link or the `artist-monitoring` plan handoff.
- The policy engine depends on the existing normalized-name bridge because `MediaTrack` has no
  artist identifier. Recency inherits this weak join and all its poisoning rules.
- Node 22 is the repository contract. Verification commands should run through `mise exec --`.

## Gotchas and Warnings

- `hasOptionalFiniteNumber` is insufficient for the new wire contract; accepting `0`, a fraction,
  or an unsafe integer would violate the binding design.
- Do not mark a bucket partial merely because a zero-play track lacks `lastViewedAt`. Conversely,
  one played track without recency poisons the artist-level recency observation even when other
  tracks have timestamps.
- Apply existing sentinel and ambiguous-name poisoning before recency coverage logic. Otherwise a
  timestamp could accidentally rehabilitate an already-untrustworthy weak join.
- The legacy whole-library `totalPlaysObserved === 0` gate remains first. Recency does not turn a
  wrong-account zero-play snapshot into safe evidence.
- Never-viewed artists remain unsupported. All-missing recency must refuse; `lastViewedAt` cannot
  substitute for the deferred acquisition timestamp needed to age never-viewed media.
- `minDaysSinceLastViewed` is an additional conjunct, not a replacement for `maxPlays`. Operators
  must raise `maxPlays` explicitly if previously played but old artists should qualify.
- A report version bump affects fixtures beyond the stale-rule unit test. Search for hard-coded
  schema `v2`, engine version `2`, and complete resolved-policy objects in engine, action, command,
  plan, and sync-ratings tests.
- Fingerprints include check order, comparator, bound, observed value, satisfaction, config path,
  and observations. Keep legacy proposals free of recency evidence when config is absent, and keep
  time-dependent values out of fingerprint material.
- Human explain rendering is generic, but raw epoch seconds are not friendly prose. The check's ISO
  `observed` value and a summary age are the intended human-facing forms; do not change the raw
  machine observation solely for presentation.
- Although no completion templates change, Bash, Zsh, and Fish must be audited together and the
  existing parity suite must run. Configuration-only behavior is not a reason to add a CLI flag.

## Task-Specific Guidance

1. Extend the wire/domain boundary and its tests first. In
   `types.test.ts`, cover present and omitted values plus nonnumeric, nonfinite, fractional, zero,
   negative, and unsafe values. In `mappers.test.ts`, assert preservation and true absence. Extend
   the existing `query-library.test.ts` page fixture to prove guard plus mapper integration and
   malformed-page rejection; do not create a new adapter suite.
2. Add the config contract and resolver echo. Extend `config.test.ts` with accepted bounds, wrong
   type, fraction, `0`, and `36_501`, asserting the exact dotted property path. Extend
   `policy-engine.test.ts` for the `null` default, configured value, and report version v3/3.
3. Extend the existing track summary rather than creating a parallel recency index pass. In
   `policy-signals.test.ts`, prove maximum selection, tolerated zero-play omission, played-track
   partial coverage, all-missing coverage, and existing ambiguous/sentinel precedence.
4. Thread `evaluatedAt` into the pure rule input and add the recency conjunct after the current
   prerequisite and play gates. In `policy-rules.test.ts`, use one pinned instant for exact-boundary,
   recent, old, future, no-coverage, and partial-coverage cases while retaining rating,
   acquisition, monitoring, and play-ceiling assertions.
5. Extend evidence vocabulary and presentation. In `policy-overrides.test.ts`, prove that time
   passage alone does not rotate a qualifying proposal fingerprint, while timestamp or threshold
   changes do. In `lidarr-policy.test.ts`, assert the ISO observation, `older-than-days`, exact
   config path, resolved threshold footer, and v3/3 machine report fixtures.
6. Update the two feature guides, README, `rfmedia.example.yaml`, and `ROADMAP.md` together. Replace
   absolute no-recency claims with legacy-versus-enabled behavior, named no/partial refusals, the
   weak-join limitation, bounds/default, and the continuing `maxPlays` conjunct. Leave issue #210's
   longitudinal scope open.
7. Verify focused contracts before the full package gates. Run the touched Vitest files and
   TypeScript checks under Node 22, then run the Bash/Zsh/Fish completion parity suite even though
   templates are unchanged. Final completion evidence should explicitly state that the completion
   surface was audited and required no edits.
