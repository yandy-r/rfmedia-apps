# Integration Research: issue-314-plex-recency-signals

GitHub issue #314 requires a typed Plex recency signal, a time-aware
`stale-monitoring-cleanup` criterion with configuration and explain evidence, documentation, and
fail-closed handling of missing or partial wire data. `lastViewedAt` is the required signal;
`skipCount` is explicitly optional. The smallest complete integration extends the existing live
track drain and its existing normalized-name join. It does not need another Plex request, another
database, a timeline implementation, or a new CLI option.

## API Endpoints and Wire Contract

The private Plex query family already consumes track metadata from three paths:

- `GET /library/sections/{libraryId}/all` with `type=10` is the policy-relevant paginated library
  drain (`packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts:528-577`).
- `GET /library/metadata/{albumId}/children` returns album tracks
  (`packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts:579-607`).
- `GET /library/metadata/{trackId}` performs the uncached exact track lookup
  (`packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts:609-620`).

All three paths terminate at `isPlexWireTrack` and `mapPlexTrack`. The current consumed DTO carries
`viewCount` but no recency fields (`packages/rfmedia-cli/src/lib/adapters/plex/types.ts:279-291`),
the common track guard validates each present numeric field
(`packages/rfmedia-cli/src/lib/adapters/plex/types.ts:482-503`), and the mapper currently converts a
missing `viewCount` to `playCount: 0` (`packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts:134-149`).

Required wire/domain work:

- Add optional `lastViewedAt` to private `PlexWireTrack`, validate its present value in
  `hasCommonTrackFields`, and project it onto provider-neutral `MediaTrack`
  (`packages/rfmedia-cli/src/types/media-server.ts:39-67`). Preserve absence; never map missing
  recency to zero, because epoch zero would become false evidence of extreme staleness.
- If `skipCount` is included, treat it the same way: optional on wire and domain, bounded as a
  non-negative counter, and never defaulted into evidence. It is not required for the issue's
  time-aware stale criterion.
- A present malformed field must make the metadata response invalid, following the existing
  `toPage` behavior (`packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts:320-346`). An
  omitted field must remain representable so the policy join can refuse only the affected artist
  instead of pretending it has a timestamp.

The committed repository does not define the unit or omitted-value semantics of Plex's
`lastViewedAt`/`skipCount`; it only names the fields in issue #314. Existing Plex timestamps such as
`addedAt` and `updatedAt` are opaque numbers (`packages/rfmedia-cli/src/lib/adapters/plex/types.ts:344-365`).
The design must therefore state and test the chosen unit at the adapter boundary before performing
day arithmetic. No external API behavior beyond the consumed field names is established by the
repository.

Filter integration is optional, not an acceptance requirement. Making recency filterable would
also require coordinated edits to `MediaFilterField`
(`packages/rfmedia-cli/src/types/media-filters.ts:14-28`), `getMediaFieldValue`
(`packages/rfmedia-cli/src/lib/media-filter-evaluator.ts:65-130`), Plex numeric translation
(`packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts:230-277`), and
`PLEX_FEATURES.filterPushdown.fields`
(`packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts:130-160`). Until Plex query-key semantics are
verified, recency should remain policy-only rather than being advertised as pushdown-capable.

## Database Schema

No database migration is required for the issue #314 policy path.

- Policy evaluation reads live `MediaTrack[]`; its only existing persistence side effect is the
  reconciliation-owned artist identity snapshot noted in
  `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts:11-32`.
- `bridge_identity_snapshots` stores artist identity documents, not consumption evidence
  (`packages/rfmedia-cli/src/lib/schema.sql:370-385`). It must not be widened with track recency.
- Plex adapter caching is an adapter-local in-memory TTL `Map`, not SQLite
  (`packages/rfmedia-cli/src/lib/adapters/plex/cache.ts:107-157`). Cached mapped pages naturally
  carry the new optional domain field without a schema change.

There is a separate legacy saved-query schema: `plex_query_results` persists `view_count` but no
recency (`packages/rfmedia-cli/src/lib/schema.sql:208-245`), and `plex-query.ts` deliberately projects
the generic domain into that compatibility row (`packages/rfmedia-cli/src/actions/plex-query.ts:400-409`).
Issue #314 does not require saved-query replay of recency, so changing schema version 11, `DbPlexQueryResult`,
or `PlexQueryResultItem` would be scope expansion. If a future recency filter must be preserved for
offline saved-query analysis, that is a separate persistence contract and migration.

Likewise, related issue #210's temporal history/ROI storage is not part of this change. Issue #314
supplies reusable live signal plumbing; it does not implement an event log or timeline database.

## External Services

Plex is the only new external-data concern. The existing policy gatherer already performs a bounded
full-library track drain through `adapter.query.tracks`
(`packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts:424-475`). It fails closed rather than
truncating above 200,000 tracks and converts adapter/transport failures into an unavailable slot
(`packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts:183-257`). Recency must ride that same
response; a second Plex drain would duplicate cost and permit play and recency snapshots from
different instants.

No new Lidarr endpoint is required. Lidarr continues to provide artists, monitoring state, and
`statistics.trackFileCount`; the resulting mutation remains the existing `artist-monitoring`
handoff. No Last.fm, ListenBrainz, scheduled evaluation, or timeline provider is required. The repo
documents account scoping only for `viewCount`
(`packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md:1101-1111`); implementation must
not claim unverified account semantics for `lastViewedAt` beyond reporting that it came from the
response visible to the resolved Plex credential.

## Internal Services

The existing integration path is:

`PlexWireTrack -> isPlexWireTrack -> mapPlexTrack -> MediaTrack -> gatherPlexTrackPlays ->
buildTrackJoinSummary -> PolicyPlayIndex -> evaluateStaleMonitoringCleanup -> evaluation/plan output`.

The relevant boundaries are:

- `PolicySignalBundle.plexTrackPlays` already carries the full drained `MediaTrack[]`
  (`packages/rfmedia-cli/src/types/lidarr-policy.ts:540-566`). Reuse this slot and broaden its
  documentation to consumption data; do not add a `plexTrackRecency` slot/gatherer that drains the
  same catalog again.
- `buildTrackJoinSummary` already walks the tracks once and applies sentinel, unjoined, and
  ambiguous-name poisonings (`packages/rfmedia-cli/src/lib/bridge/policy-signals.ts:300-392`). Extend
  that one pass with per-bucket recency evidence. Artist recency is the maximum trustworthy track
  timestamp, because the policy asks for the most recent consumption.
- The current join is weak by construction: `MediaTrack` has an album-artist string and no artist id
  (`packages/rfmedia-cli/src/lib/bridge/policy-signals.ts:9-24`). Recency must inherit the same
  `normalized-name` grade and all three existing poisonings. It must not create an apparently exact
  join.
- Missing recency on any joined row makes that artist's aggregate partial. For the destructive
  direction (proposing unmonitor), partial or absent recency must yield an unavailable observation
  and a `signal-unavailable` refusal, never an ancient timestamp and never "not viewed."
- `PolicyEvaluationInput` currently lacks the run timestamp even though
  `PolicyEvaluationRunInput.evaluatedAt` exists (`packages/rfmedia-cli/src/lib/bridge/policy-engine.ts:189-205`).
  Thread that exact timestamp into the pure evaluator
  (`packages/rfmedia-cli/src/lib/bridge/policy-engine.ts:875-890`); do not call `Date.now()` inside a
  rule. The threshold should compare a derived age/cutoff against that single captured evaluation
  time.
- The stale evaluator already emits ordered checks, observations, summaries, and the existing
  `artist-monitoring` handoff (`packages/rfmedia-cli/src/lib/bridge/policy-rule-stale-monitoring.ts:98-357`).
  Add recency there as another fail-closed gate; no new plan operation or plan-artifact schema is
  needed.

Human `--explain` is already generic over observation and threshold-check records
(`packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts:1444-1519`), while JSON/YAML serialize
the report and CSV stores checks/observations as JSON
(`packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts:75-113`). A numeric recency
observation plus a derived age check therefore flows through existing output machinery. The summary
should also render a human-readable timestamp/age so operators do not have to decode an epoch.

Adding a new observation-gap literal requires updating the fingerprint module's closed registry
(`packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts:58-121`). Proposal fingerprints include all
checks and observations (`packages/rfmedia-cli/src/lib/bridge/policy-overrides.ts:221-298`), so
existing `stale-monitoring-cleanup` suppressions will correctly report `evidence-changed` until the
operator reviews the new recency-backed evidence. This should be called out in release/docs text.

## Configuration

The time-aware criterion must be a strict key under
`policy.rules.stale-monitoring-cleanup`. That involves the type in
`packages/rfmedia-cli/src/types/config.ts:440-452`, the exact-key set and validator in
`packages/rfmedia-cli/src/lib/config.ts:2630-2647` and `:2933-3000`, the resolved-policy type in
`packages/rfmedia-cli/src/types/lidarr-policy.ts:370-385`, defaults/resolution in
`packages/rfmedia-cli/src/lib/bridge/policy-engine.ts:129-147` and `:378-410`, and the dotted path
table in `packages/rfmedia-cli/src/lib/bridge/policy-rule-shared.ts:29-45`.

The safest compatibility contract is an optional day-based threshold (exact spelling is a design
decision) whose unset resolved value is `null`: existing operators keep the absolute-play behavior,
while setting the key makes recency an additional required conjunct. A configured value must be a
bounded positive integer, echoed in `report.policy`, and emitted as a `PolicyThresholdCheck` with
its exact dotted config path. This satisfies "policy can express" recency without silently changing
already-enabled rules.

No new command-line flag is required by issue #314. `policy evaluate`, `policy plan`, and
`sync-ratings` all consume the shared `policy:` configuration/evaluation path, so the configured
criterion reaches all three without widening their option surfaces. If implementation stays
config-only, Bash/Zsh/Fish templates require an explicit no-change audit, not edits. If a recency
flag is added, it must be registered in all three command surfaces as appropriate and kept in parity
with `LIDARR_POLICY_EVALUATE_OPTION_LONGS`, `LIDARR_POLICY_PLAN_OPTION_LONGS`, sync-ratings option
contracts, and `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` plus
`templates.spec.ts`.

Documentation must replace the absolute "there is no recency dimension" claims in
`packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md:328-339`,
`packages/rfmedia-cli/docs/features/lidarr-ratings-sync.md:311-320`, and the corresponding README
sections. It should distinguish the unset legacy absolute-play mode from configured recency mode,
state the weak join and missing/partial refusal behavior, and retain the token-account warning.

## Integration Risks

| Risk                                                             | Required mitigation                                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing timestamps become epoch zero and qualify as stale        | Preserve absence through wire and domain mapping; refuse at the per-artist aggregate.                                                                                 |
| One missing row is hidden by `max()` over the remaining rows     | Track timestamp coverage separately; partial joined coverage is unavailable, not a usable maximum.                                                                    |
| Duplicate Plex reads produce inconsistent play/recency snapshots | Extend the existing `plexTrackPlays` drain and one-pass join; do not add another gatherer.                                                                            |
| Weak album-artist name join is presented as exact evidence       | Reuse the existing poisoned normalized-name buckets and report join grade `normalized-name`.                                                                          |
| Wall-clock calls make decisions nondeterministic                 | Thread the action's single `evaluatedAt` into `PolicyEvaluationInput` and use it for cutoff arithmetic.                                                               |
| Malformed present values leak into age arithmetic                | Guard present values at `isPlexWireTrack`; a malformed response makes the slot unavailable.                                                                           |
| Existing policy suppressions silently continue over new evidence | Let fingerprint checks/observations rotate the fingerprint and document `evidence-changed` review.                                                                    |
| Optional filter work advertises unsupported Plex query keys      | Keep recency policy-only unless pushdown semantics are verified; update all four filter layers together if later added.                                               |
| Scope expands into timeline or query-history storage             | Keep #210 history and saved-query schema out; issue #314 is live signal plumbing plus policy consumption.                                                             |
| Machine/report contract drifts unnoticed                         | Decide explicitly whether the additive resolved-policy/observation fields require a policy engine/schema version bump; do not change the Lidarr plan artifact schema. |

Critical coverage should stay narrow: guard acceptance/rejection for present, omitted, and malformed
wire fields; mapper preservation of presence/absence; one pure join case proving max timestamp and
partial-data refusal; and stale-rule cases proving configured old, recent, missing, and ambiguous
evidence. No database, timeline, filter-pushdown, or new shell-completion tests are justified unless
those optional surfaces are actually changed.
