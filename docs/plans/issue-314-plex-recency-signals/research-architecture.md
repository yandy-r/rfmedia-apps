# Architecture Research: issue-314-plex-recency-signals

## System Overview

Issue #314 extends an existing read-only pipeline; it does not need a second Plex query or a new
identity bridge. The current path is:

`Plex metadata JSON` -> private `PlexWireTrack` guard -> `mapPlexTrack` -> provider-neutral
`MediaTrack` -> bounded full-library policy track drain -> normalized-artist join -> pure
`stale-monitoring-cleanup` evaluator -> report checks/observations -> human or machine presenter.

The coordinating boundaries are already well placed:

- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts` owns `PlexWireTrack` and
  `isPlexWireTrack`. Present optional numeric fields are rejected unless finite; absent fields are
  accepted.
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts` is the only Plex-to-domain projection.
  It currently converts absent `viewCount` to `MediaTrack.playCount = 0`; recency must not copy
  that fallback because an absent timestamp is not evidence of old consumption.
- `packages/rfmedia-cli/src/types/media-server.ts` owns `MediaTrack`. Plex timestamp conventions
  are already represented as numeric epoch seconds on provider-neutral playlist metadata
  (`createdAt`/`updatedAt`), so an optional numeric `lastViewedAt` is consistent with the domain.
- `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts` already drains complete `MediaTrack`
  pages through the adapter under a 200,000-track hard bound and converts every transport,
  validation, abort, or truncation failure into an unavailable slot. No additional gatherer is
  required.
- `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts` owns the weak normalized-name join and
  all ambiguity/sentinel poisoning. It is the correct place to aggregate both total plays and the
  latest trustworthy view timestamp in one pass.
- `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts` is the safety-critical pure
  evaluator. It already refuses absent identity, ratings, track coverage, and Lidarr statistics;
  recency becomes another fail-closed gate here.
- `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts` already injects one testable clock
  (`dependencies.now().toISOString()`) into `runLidarrPolicyEvaluation`. The engine must project
  that single timestamp into evaluator input instead of calling `Date.now()` in a rule.

This matches the binding boundaries in
`packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md` sections 2.4, 9.2, and 15:
\#209 intentionally shipped absolute `viewCount` only, named recency as a coordinated wire/guard/
mapper/domain change, and separated it into this child issue. Live GitHub state confirms #209 is
complete, #314 is open, and #210 remains a separate open read-only temporal-analytics feature.

## Relevant Components

- Wire and domain projection:
  - `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`: add optional `lastViewedAt` and, only if
    included in this delivery, optional `skipCount` to `PlexWireTrack`; extend
    `hasCommonTrackFields` so malformed present values reject the whole response.
  - `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`: copy valid optional values without a
    `?? 0` default.
  - `packages/rfmedia-cli/src/types/media-server.ts`: expose the same optional fields on
    `MediaTrack`. Optionality is load-bearing: `undefined` means unavailable evidence, not zero,
    never viewed, or viewed at the Unix epoch.
  - `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`: already validates each page with
    `isPlexWireMetadataResponse(..., isPlexWireTrack)` before mapping, so the new guard
    automatically protects policy drains, playlists, and ordinary queries.

- Policy contracts and gathering:
  - `packages/rfmedia-cli/src/types/lidarr-policy.ts`: the existing `plexTrackPlays` slot can keep
    carrying `readonly MediaTrack[]`; changing the public signal id would unnecessarily ripple
    through `POLICY_SIGNALS`, descriptor registration, status maps, reports, and fingerprints.
    Extend the joined/indexed contracts instead, ideally with a consumption bucket containing
    plays, sample size, latest-view timestamp, and recency completeness.
  - `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts` and
    `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`: reuse `gatherPlexTrackPlays` and
    the existing `requires union enriches` gather plan. The stale rule already requires this slot,
    so recency adds no extra provider round trip.
  - `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`: extend `TrackJoinSummary` and the
    existing normalized-name buckets. Do not build a parallel recency index by walking and
    normalizing every track again. Preserve poisoning for ambiguous normalized names and the
    `Unknown Artist` sentinel.
  - `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: `buildIndexes` should project the one
    combined join summary into play and recency observations and coverage. Pass the authoritative
    evaluation time into `PolicyEvaluationInput` for deterministic cutoff evaluation.

- Time-aware rule and configuration:
  - `packages/rfmedia-cli/src/types/config.ts` and `packages/rfmedia-cli/src/lib/config.ts`: add one
    bounded, positive integer recency threshold to the exact
    `policy.rules.stale-monitoring-cleanup` key set and validator. An opt-in field such as
    `minDaysSinceLastViewed` preserves current configurations.
  - `packages/rfmedia-cli/src/types/lidarr-policy.ts` and
    `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`: echo the resolved threshold (nullable
    when legacy absolute-play behavior is selected) in `PolicyResolvedStaleMonitoring`.
  - `packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts`: when the recency
    threshold is configured, use recency as the eligibility criterion rather than requiring the
    legacy `maxPlays` ceiling too. Requiring both with the current `maxPlays: 0` default would make
    every historically viewed artist ineligible and would not deliver a useful time-aware rule.
    Keep play count as evidence and deterministic ranking data. With no recency threshold,
    preserve the existing absolute-play behavior for backward compatibility.
  - `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts`: add the new dotted config path and
    define any recency-specific ranking tie-break without changing stable proposal keys.

- Explainability and evidence:
  - `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` already renders every
    `PolicyThresholdCheck` plus its exact config path and every proposal observation. Add the
    recency threshold to the policy footer and format `lastViewedAt` as an ISO timestamp in
    `--explain`; machine output should retain the canonical numeric epoch value.
  - `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts` fingerprints proposal checks and
    observations. Do not put a moving cutoff timestamp or an ever-increasing raw age into
    fingerprint material, or a #313 suppression will become stale on every later run with
    unchanged Plex evidence. Fingerprint the stable raw `lastViewedAt` plus the configured day
    threshold; a satisfied proposal check may report a stable, threshold-clamped "at least N
    days" value while the non-fingerprinted summary/presenter shows the exact age at
    `evaluatedAt`.

## Data Flow

1. Plex returns a track record. `isPlexWireTrack` accepts absent recency fields but rejects a
   present non-finite/non-numeric `lastViewedAt` or `skipCount`; page validation therefore fails
   before mapping on malformed input.
2. `mapPlexTrack` copies `lastViewedAt`/`skipCount` only when present. It never turns absence into
   zero. The resulting `MediaTrack` stays provider-neutral and remains the sole payload of the
   existing `plexTrackPlays` policy signal.
3. `gatherPlexTrackPlays` drains all pages. Any malformed page, transport error, pagination stall,
   abort, or hard-bound overflow makes the whole signal unavailable; no partial track set reaches
   the policy engine.
4. `buildTrackJoinSummary` walks the available tracks once. For every unpoisoned normalized artist
   bucket it continues summing `playCount` and also records the maximum `lastViewedAt`, the number
   of recency-bearing rows, and whether recency evidence is incomplete. A robust completeness rule
   is: a track claiming prior consumption (`playCount > 0`) without `lastViewedAt` poisons recency
   for that artist; zero-play tracks with no timestamp contribute no recency claim.
5. A lookup returns either an observed latest timestamp with `join: "normalized-name"` and sample
   size, or a precise gap such as ambiguous join, sentinel artist, no historical recency, or
   partial recency coverage. A gap is never converted to an old date.
6. The engine derives one reference time from `PolicyEvaluationRunInput.evaluatedAt`. In recency
   mode, the stale evaluator proposes only when an authoritative monitored artist passes the
   existing rating/acquisition gates, has complete historical recency evidence, and its latest
   view is at least the configured number of days old. A newly added and never-viewed artist has
   no historical timestamp and is refused, which is the safety distinction #314 is intended to
   add.
7. The proposal carries stable raw recency evidence, the configured threshold and config path,
   plus a human summary derived from the same reference time. Existing proposal-to-plan and apply
   boundaries are unchanged: evaluation remains read-only and the handoff is still
   `artist-monitoring`.

`skipCount` should remain a pass-through optional domain field unless the issue design defines a
separate rule semantic. Summing missing values as zero or treating skips as equivalent to a view
would manufacture evidence. If used later, it should join in the same bucket with its own
completeness counter and explicit threshold.

## Integration Points

- Missing and partial data: malformed present wire values fail the page guard; absent wire values
  remain `undefined`; unavailable/partial artist aggregates become rule refusals. Known recent
  consumption may safely block a destructive proposal, but unknown recency must never support
  one. Coverage should add counters for tracks/artists with usable versus incomplete recency so
  human and machine reports explain why a run produced fewer proposals.
- Existing account safety: retain the library-wide `totalPlaysObserved === 0` rule skip. Plex
  `viewCount` and `lastViewedAt` are account-scoped signals; recency does not solve evaluation
  under the wrong token account.
- Report compatibility: adding resolved policy fields, observations, and coverage fields changes
  the machine envelope. `POLICY_EVALUATION_SCHEMA`/`POLICY_ENGINE_VERSION` in
  `packages/rfmedia-cli/src/types/lidarr-policy.ts` must be reviewed and bumped if the repository
  treats these additive fields as a schema revision. Stable decision keys must remain
  `stale-monitoring-cleanup:artist:<lidarrId>`.
- Override compatibility: recency changes proposal evidence and therefore correctly changes
  evidence fingerprints once; the fingerprint schema in
  `packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts` should only bump if its canonical
  projection changes. Clock passage alone must not rotate fingerprints.
- Optional filter/pushdown: policy gathering is unfiltered, so issue #314 does not require a
  `MediaFilterField`. Deferring it avoids unrelated edits to
  `packages/rfmedia-cli/src/types/media-filters.ts`,
  `packages/rfmedia-cli/src/lib/media-filter-evaluator.ts`,
  `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`, and
  `PLEX_FEATURES.filterPushdown.fields` in
  `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`. If recency is made filterable, all four
  must change together: a domain field, residual evaluator, Plex query translation to
  `lastViewedAt`, and advertised capability. Partial pushdown still requires residual evaluation
  to preserve nested-filter semantics.
- Public query projection: `packages/rfmedia-cli/src/actions/plex-query.ts` currently projects
  `MediaTrack` back to the legacy public `PlexTrack`/database shape. Policy works without changing
  that projection. Exposing recency in `rfmedia plex query`, SQLite, or MCP would be a separate
  public/storage contract expansion and should not be implied by merely adding the adapter-domain
  signal.
- Critical tests only: extend
  `packages/rfmedia-cli/src/lib/adapters/plex/types.test.ts` (valid absent/present and malformed
  present fields), `packages/rfmedia-cli/src/lib/adapters/plex/mappers.test.ts` (preserve absence,
  map timestamp), `packages/rfmedia-cli/src/lib/bridge/policy-signals.test.ts` (latest join plus
  ambiguous/partial poisoning), `packages/rfmedia-cli/src/lib/bridge/policy-rules.test.ts`
  (old/recent/missing/partial behavior at a fixed clock), and the existing engine/command tests
  only where needed to prove resolved config, machine schema, explain output, and stable override
  fingerprints. No new test suite is necessary.
- Shell completions: a config-only threshold adds no CLI option, so Bash/Zsh/Fish templates should
  remain unchanged after an explicit parity audit. If a new evaluate/plan CLI override is added,
  update `POLICY_EVALUATE_LONG_OPTIONS` and all three templates/tests in lockstep.
- Documentation: replace the absolute-only caveat in
  `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md` and
  `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`; retain the account-scoping warning
  and document fail-closed no/partial-recency behavior.

## Key Dependencies

- #209 is the implemented parent contract: read-only evaluation, exact identity for proposals,
  normalized-name track joins, bounded full-library gathering, explicit refusals, and inert
  artist-monitoring handoff all remain authoritative.
- #313 is now part of the architecture: policy override evidence is content-addressed after cohort
  caps. Recency design must preserve stable decision keys and must not let the wall clock alone
  invalidate an operator suppression.
- #210 owns longitudinal event/state history, trend intelligence, discovery ROI, and forecasting.
  #314 may provide shared `MediaTrack.lastViewedAt`/`skipCount` plumbing for #210, but must not add
  timeline persistence, scheduled evaluation, history tables, or recommendation analytics.
- `packages/rfmedia-cli/src/lib/bridge/artist-name.ts` remains the sole normalization policy;
  recency must share the current play bucket and its ambiguity poisoning rather than inventing a
  second artist join.
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts` plus
  `packages/rfmedia-cli/src/lib/pagination.ts` remain the validation and complete-drain boundary.
  No evaluator may consume a truncated library.
- The action-injected clock in `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts` is the
  only permitted time source. Fixed-clock evaluation keeps rule tests deterministic and guarantees
  human, JSON/YAML/CSV, plan, and override classification all describe the same instant.
