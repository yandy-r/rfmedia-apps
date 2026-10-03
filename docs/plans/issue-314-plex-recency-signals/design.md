# Issue #314 Plex Recency Consumption Signals Design

## Decision Summary

Issue #314 will add one required signal, `MediaTrack.lastViewedAt`, as an optional positive integer
containing Plex epoch seconds. The field travels through the private Plex wire contract, guard, and
mapper into the provider-neutral domain, then through the existing full-track policy signal and
single normalized-name join. `stale-monitoring-cleanup` gains an opt-in positive integer
`minDaysSinceLastViewed`; when configured, an artist must satisfy both the existing lifetime-play
ceiling and the new age threshold. Missing or incomplete recency produces a visible refusal, never
an ancient timestamp.

This is a coordinated live-signal change only. It introduces no second Plex drain, database
migration, timeline history, new plan operation, filter field, pushdown capability, CLI flag, or
shell-completion edit. GitHub reports no sub-issues under #314, and no child issue is required to
satisfy its acceptance criteria.

## Scope Boundaries

### Included

- Optional `lastViewedAt` on `PlexWireTrack` and `MediaTrack`.
- Present-value validation and mapper preservation of absence.
- One-pass aggregation of the latest trustworthy artist timestamp alongside play totals.
- Named missing and partial recency observation gaps.
- A bounded `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed` config key.
- A deterministic recency gate, explain check, observation, summary, and resolved-policy echo.
- A policy report schema/engine version review and explicit version bump for the additive public
  machine contract.
- Focused tests, policy documentation, README/config example, and `ROADMAP.md`.

### Deferred

- `skipCount`: the issue makes it optional, and no accepted rule defines how a skip should affect
  an artist-level destructive decision.
- Never-viewed aging: no `lastViewedAt` exists for a never-viewed track. An item acquisition time
  would need a separate coordinated contract before those artists can be aged safely.
- Issue #210 timeline persistence or analytics.
- Saved-query persistence, MCP projection, filter DSL, and Plex pushdown.
- New CLI options; policy configuration already reaches `policy evaluate`, `policy plan`, and
  `sync-ratings` through their shared evaluator.

## Contract Design

### Plex wire and media domain

`PlexWireTrack.lastViewedAt?: number` is accepted only when it is a positive safe integer. Omission
is valid because Plex does not attach a last-viewed timestamp to every track. `mapPlexTrack` copies
the field without a default, and `MediaTrack.lastViewedAt?: number` documents the value as whole
epoch seconds visible to the resolved Plex credential.

A malformed present value invalidates the page at the existing adapter guard. A missing value is
not malformed; it remains unavailable evidence for the policy layer. In particular, neither the
guard nor mapper translates missing data to `0`.

### Existing signal and join reuse

`PolicySignalBundle.plexTrackPlays` already contains the complete bounded `MediaTrack[]`, so its
identifier and gatherer remain unchanged. `buildTrackJoinSummary` continues to normalize each track
artist once and adds these fields to every unpoisoned bucket:

- maximum observed `lastViewedAt`;
- count of tracks carrying a timestamp; and
- count of tracks whose `playCount > 0` but whose `lastViewedAt` is missing.

Zero-play tracks may legitimately omit `lastViewedAt` and do not make an otherwise observed bucket
partial. A played track with no timestamp contradicts the required evidence and makes that artist's
recency unavailable. The all-missing case has no historical recency observation. Ambiguous-name
and `Unknown Artist` poisonings keep their existing precedence.

The lookup returns a `PolicyObservation<number>` with the raw latest epoch seconds and
`join: "normalized-name"`, or one of the named gaps `no-recency-coverage` and
`partial-recency-coverage` in addition to the existing join gaps.

### Policy configuration

The new configuration is:

```yaml
policy:
  rules:
    stale-monitoring-cleanup:
      minDaysSinceLastViewed: 90
```

The value is optional and must be a whole number from 1 through 36,500. Its resolved value is
`number | null`; `null` preserves the existing absolute-play-only rule. Defaults remain centralized
in `resolvePolicyConfig`, and the exact explain path is
`policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed`.

When configured, recency is an additional conjunct after the existing monitoring, identity,
rating, acquisition, coverage, and `maxPlays` gates. Keeping `maxPlays` active is conservative and
backward-compatible: the rule means low lifetime consumption **and** no recent consumption. An
operator who wants previously viewed artists admitted must set `maxPlays` above zero explicitly;
the documentation will call this out.

### Deterministic temporal evaluation

`executeLidarrPolicyEvaluate` already captures an injected `now()` and passes its ISO value as
`evaluatedAt`. The engine passes that same instant into `PolicyEvaluationInput`. The pure stale
evaluator checks:

```text
evaluatedAtEpochSeconds - latestLastViewedAt >= minDaysSinceLastViewed * 86,400
```

No rule reads `Date.now()`. The exact boundary is inclusive. A timestamp in the future is recent
and therefore cannot support a proposal.

### Explain output and stable override evidence

The proposal observation stores the stable raw epoch timestamp. The threshold check uses a new
semantic comparator, `older-than-days`, with:

- `observed`: the stable ISO rendering of `lastViewedAt`;
- `bound`: the configured integer day threshold;
- `satisfied`: the result at the captured evaluation instant; and
- `configPath`: the exact dotted config key.

This representation is intentionally stable. The precise computed age may appear in the proposal
summary because summaries are not fingerprint material, but the check must not store a moving
cutoff or ever-increasing age. `policy-overrides.ts` extends its closed comparator and observation
gap registries; unchanged raw evidence and configuration therefore produce the same fingerprint
on later days. A changed timestamp or threshold produces `evidence-changed`, as intended.

`POLICY_EVALUATION_SCHEMA` and `POLICY_ENGINE_VERSION` advance from v2/2 to v3/3 because the report's
resolved-policy and proposal-check vocabulary changes. `POLICY_EVIDENCE_FINGERPRINT_SCHEMA` stays
at v1 because its canonical projection is unchanged; it merely accepts the new comparator and gap
literals. Existing non-recency proposal fingerprints remain stable.

## Fail-Closed Matrix

| Condition                                                                          | Result                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `lastViewedAt` omitted on every joined track                                       | `signal-unavailable` refusal with `no-recency-coverage`       |
| A played joined track omits `lastViewedAt`                                         | `signal-unavailable` refusal with `partial-recency-coverage`  |
| Present wire value is nonnumeric, nonfinite, noninteger, zero, negative, or unsafe | Entire Plex page is invalid; the gathered slot is unavailable |
| Normalized artist is ambiguous or sentinel                                         | Existing ambiguous/sentinel refusal; no timestamp lookup      |
| Latest view is newer than the configured age                                       | Visible unsatisfied recency check; no proposal                |
| Latest view is exactly the configured age                                          | Recency check passes                                          |
| Latest view is older and every prior gate passes                                   | Existing `artist-monitoring` unmonitor proposal               |
| Recency config is absent                                                           | Existing absolute-play-only behavior is unchanged             |

## Data Flow

```text
Plex track JSON
  -> isPlexWireTrack
  -> mapPlexTrack
  -> MediaTrack.lastViewedAt?
  -> existing bounded plexTrackPlays drain
  -> buildTrackJoinSummary (plays + newest complete recency)
  -> lookupArtistLastViewedAt
  -> evaluateStaleMonitoringCleanup at captured evaluatedAt
  -> stable observation/check + human/machine explain output
  -> existing artist-monitoring plan handoff
```

## Critical Test Design

- Wire/mapper boundary: one valid timestamp, one omitted timestamp, and a compact malformed-value
  table proving guard rejection and no epoch-zero fallback.
- Query integration: one existing page test proves guard plus mapper behavior; do not create a new
  suite.
- Join: newest timestamp wins; zero-play omissions are tolerated; a played omission yields partial
  coverage; all missing yields no coverage; existing ambiguity poisoning still wins.
- Rule: pinned evaluation time with exact-boundary, recent, old, missing, and partial cases while
  retaining rating, acquisition, and play gates.
- Config: accepted bound plus wrong type, fractional, underflow, overflow, and exact property paths.
- Explain/fingerprint: recency observation and config path render; time passage alone preserves the
  fingerprint; timestamp or threshold change rotates it.

No database, timeline, filter-pushdown, or new completion tests are justified because those
surfaces do not change. Existing Bash, Zsh, and Fish templates must still be audited and their
parity test run.

## Documentation Changes

- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`: replace the absolute-only
  caveat with legacy versus recency-enabled behavior, weak-join limits, and missing/partial
  refusals.
- `packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md`: explain that shared policy config
  applies the recency gate and that `--max-plays` remains a separate conjunct.
- `packages/rfmedia-cli/README.md` and `rfmedia.example.yaml`: document the new key, bounds, default,
  and interaction with `maxPlays`.
- `ROADMAP.md`: mark #314 shipped and remove language treating the signal as missing while leaving
  #210's longitudinal scope open.

## Acceptance Mapping

| Acceptance criterion                                         | Design satisfaction                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Domain exposes recency with typed guards and mapper coverage | Coordinated wire/guard/mapper/domain contract plus focused boundary tests            |
| Policy expresses time-aware stale config and explain output  | Optional day threshold, captured clock, stable observation/check, generic presenters |
| Docs update absolute-versus-recency caveat                   | Policy, ratings-sync, README/example, and ROADMAP updates                            |
| Missing/partial fields fail closed                           | Invalid-page rejection plus named no/partial recency refusals                        |
