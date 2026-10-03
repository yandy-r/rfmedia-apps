# Issue #314 Requirements

GitHub issue #314 adds Plex consumption recency to the provider-neutral media domain and uses it
to make `stale-monitoring-cleanup` time-aware without weakening the existing fail-closed policy
boundaries. The implementation remains read-only through evaluation and continues handing approved
changes to the existing `artist-monitoring` plan producer.

## Required Outcomes

1. `MediaTrack` exposes a typed, optional Plex last-viewed timestamp after private wire validation
   and mapping.
2. A configured stale-policy threshold can require an artist's latest trustworthy view to be at
   least a bounded number of days old.
3. Human explain output and machine reports expose the recency observation, threshold result, and
   exact configuration path.
4. Missing, malformed, ambiguous, or partially observed recency cannot support an unmonitor
   proposal.
5. The absolute-play-only documentation is replaced with an accurate description of legacy and
   recency-enabled behavior.
6. `ROADMAP.md` records issue #314 as delivered when the implementation is merged.

## Constraints

- Reuse the existing bounded `plexTrackPlays` drain; do not add a second Plex request.
- Reuse the current normalized-name join and its ambiguous-name and sentinel poisoning.
- Preserve missing `lastViewedAt` as unavailable; never coerce it to epoch zero.
- Use the action's injected evaluation clock; do not call a wall clock from pure policy code.
- Keep stable decision keys and evidence fingerprints stable when only time advances.
- Do not add a database migration, timeline persistence, new Lidarr operation, CLI option, or
  filter-pushdown capability.
- Add only focused contract, malformed-input, join, rule, configuration, explain, and fingerprint
  tests required to prove the changed behavior.

## Explicitly Optional or Deferred

- `skipCount` is optional in issue #314 and has no accepted policy semantics. It is deferred rather
  than exposed as unused decision evidence.
- Aging never-viewed media requires an acquisition timestamp such as item-level `addedAt`.
  `lastViewedAt` alone cannot distinguish newly added from long-abandoned items, so the rule must
  refuse that case rather than guess.
- Issue #210 owns longitudinal persistence, trend analysis, discovery ROI, and forecasting.
- Recency filter DSL and Plex pushdown support are outside this issue's acceptance criteria.

## Acceptance Evidence

| Issue criterion                                              | Authoritative evidence                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Domain exposes recency with typed guards and mapper coverage | Focused Plex wire, mapper, and query-boundary tests plus TypeScript typecheck                    |
| Policy expresses a time-aware criterion                      | Config validation, resolved-policy, join, stale-rule, and explain-output tests at a pinned clock |
| Documentation updates the caveat                             | Feature docs, README/config example, and ROADMAP diff                                            |
| Missing or partial wire fields fail closed                   | Malformed-page rejection plus absent/partial artist-recency refusal tests                        |
