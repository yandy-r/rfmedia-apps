# External API Research: Lidarr Cascade and Budget Analysis

_Research date: 2026-07-27. Sources are official Lidarr, Prowlarr, Servarr, or
project-maintainer sources._

## Executive Summary

Issue #219 should distinguish two different horizons:

1. **Immediate apply impact**: requests, searches, grabs, and downloads directly caused by applying
   the reviewed mutation.
2. **Future exposure**: changes to the set of monitored albums, accepted releases, profiles, or
   tags that can affect later RSS processing or a separately requested search.

That distinction matters because the current `rfmedia` plan producers intentionally do not request
search-on-add. Artist-add plans seal `searchForMissingAlbums: false` and
`monitorNewItems: "none"`, while monitoring, profile, tag, album-policy, and delete operations do
not call Lidarr's command/search API. Their immediate indexer-query, grab, and download estimate is
therefore zero. A monitoring or profile change can increase future acquisition exposure, but
official Lidarr behavior does not support presenting it as an immediate query count.

Exact future query or download counts cannot be derived from a Lidarr mutation alone:

- a missing-album search iterates eligible missing albums, but each album search fans out across the
  enabled automatic-search indexers;
- Prowlarr can issue multiple upstream pages for one search and records the actual queries after the
  fact;
- zero or more releases can match, and profile, cutoff, delay, queue, and availability rules decide
  whether anything is grabbed;
- release sizes are not known until search results exist.

The safest design is therefore deterministic and conservative:

- persist exact immediate estimates in the sealed plan;
- report future exposure as counts of newly monitored/eligible albums plus an explicitly labelled
  nominal fan-out, not as a guaranteed query count;
- treat operator-configured budgets as the policy authority;
- optionally use Prowlarr statistics and status as advisory headroom evidence, never as required
  planning authority;
- represent unknown values explicitly rather than converting them to zero.

Prowlarr does support per-indexer query and grab limits over an hour or a day. It enforces them from
its own history and can return HTTP 429 with `Retry-After` on its Newznab proxy. However, its public
OpenAPI does not expose a stable typed "remaining quota" resource. The indexer resource carries
provider-specific settings as generic fields, so exact configured remaining quota should not be a
hard dependency unless the integration deliberately accepts a version-sensitive contract.

## Primary APIs

### Lidarr v1 API

- **Documentation**:
  [interactive API documentation](https://lidarr.audio/docs/api/) and
  [official OpenAPI document](https://raw.githubusercontent.com/Lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json).
- **Base URL**: instance-local, normally `http://localhost:8686`; honor configured HTTPS and URL
  base.
- **Authentication**: the OpenAPI declares either `X-Api-Key` header authentication or an
  `apikey` query parameter. Prefer the header so credentials do not enter URLs, proxy logs, or
  history.
- **Rate limits**: the official OpenAPI specifies no Lidarr HTTP API rate limit and no response
  headers for client quota. Do not invent one. Local CLI concurrency and retry policy remain the
  client's responsibility.

Relevant endpoints:

| Endpoint                                           | Use in cascade analysis                                                          | Important facts                                                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/artist`                               | Current artist monitoring/profile/tag state                                      | Optional `mbId`; returns all artists otherwise.                                                                                                        |
| `GET /api/v1/album`                                | Count albums affected by an artist or album mutation                             | Supports `artistId`, `albumIds`, and `includeAllArtistAlbums`; `AlbumResource` includes `monitored`, `anyReleaseOk`, `lastSearchTime`, and statistics. |
| `GET /api/v1/wanted/missing`                       | Existing missing monitored-album baseline                                        | Paged; defaults to monitored albums and exposes `totalRecords`. It is a current backlog, not the number a proposed mutation will download.             |
| `GET /api/v1/queue`                                | Existing acquisition pressure                                                    | Paged and filterable by artist/protocol; `totalRecords` is useful advisory evidence, not future capacity.                                              |
| `GET /api/v1/command` / `GET /api/v1/command/{id}` | Observe command backlog/status                                                   | Read-only inspection is appropriate. Planning must not `POST` a command to measure impact.                                                             |
| `POST /api/v1/command`                             | Explicit searches such as `AlbumSearch`, `ArtistSearch`, or `MissingAlbumSearch` | Mutating/side-effecting and outside read-only plan generation.                                                                                         |

Official Lidarr implementation evidence sharpens the model:

- [`ArtistScannedHandler`](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/NzbDrone.Core/Music/Handlers/ArtistScannedHandler.cs)
  queues `MissingAlbumSearchCommand` only when `SearchForMissingAlbums` is true.
- [`AlbumSearchService`](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/NzbDrone.Core/IndexerSearch/AlbumSearchService.cs)
  resolves monitored albums without files, excludes queued albums, then searches each remaining
  album individually.
- [`ArtistSearchService`](https://github.com/Lidarr/Lidarr/blob/d4c72f8ee93113ce82321b78c3365dbaf435f1b8/src/NzbDrone.Core/IndexerSearch/ArtistSearchService.cs)
  runs an artist search and passes decisions into the download-decision processor.

These sources justify an exact immediate-zero estimate for current no-search plans. They do not
justify a fixed "`albums × indexers` equals actual HTTP calls" promise.

### Prowlarr v1 API

- **Documentation**:
  [interactive API documentation](https://prowlarr.com/docs/api/) and
  [official OpenAPI document](https://raw.githubusercontent.com/Prowlarr/Prowlarr/develop/src/Prowlarr.Api.V1/openapi.json).
- **Base URL**: instance-local; honor configured HTTPS and URL base.
- **Authentication**: same OpenAPI alternatives as Lidarr. Prefer `X-Api-Key`.
- **Prowlarr API rate limits**: no local HTTP API limit is specified in the OpenAPI.
- **Upstream indexer limits**: query and grab limits are optional per indexer, with hour/day units.
  Prowlarr counts query plus RSS history for the query limit and grab history for the grab limit.
  See the official
  [`IndexerBaseSettings`](https://github.com/Prowlarr/Prowlarr/blob/dd09f6477feccbcc7e73acecd218b51731c50da5/src/NzbDrone.Core/Indexers/IndexerBaseSettings.cs)
  and
  [`IndexerLimitService`](https://github.com/Prowlarr/Prowlarr/blob/dd09f6477feccbcc7e73acecd218b51731c50da5/src/NzbDrone.Core/Indexers/IndexerLimitService.cs).

Relevant endpoints:

| Endpoint                      | Use                                                                                                                                       | Contract limits                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/v1/indexerstats`    | Historical `numberOfQueries`, `numberOfRssQueries`, `numberOfGrabs`, failures, and response times per indexer for a requested date window | Observed past activity only; no remaining-quota field.                              |
| `GET /api/v1/indexerstatus`   | Detect disabled indexers and recent/initial failures                                                                                      | Health signal, not capacity.                                                        |
| `GET /api/v1/indexer`         | Enabled/search support, protocol, priority, capabilities, tags, and generic provider fields                                               | Query/grab limit settings are not stable typed top-level properties in the OpenAPI. |
| `GET /api/v1/history`         | Paged query/grab history for custom observation                                                                                           | More expensive and unnecessary when aggregate stats suffice.                        |
| `GET /api/v1/history/indexer` | Bounded history for one indexer/event type                                                                                                | Useful for diagnostics, not needed for deterministic plan creation.                 |

The official
[`ReleaseSearchService`](https://github.com/Prowlarr/Prowlarr/blob/dd09f6477feccbcc7e73acecd218b51731c50da5/src/NzbDrone.Core/IndexerSearch/ReleaseSearchService.cs)
fans a music search out to eligible enabled indexers and records every actual upstream query page.
It skips an indexer already at its configured query limit. The Newznab controller returns 429 and
`Retry-After` when a user-configured query/grab limit is reached.

The [Prowlarr quick-start guide](https://wiki.servarr.com/en/prowlarr/quick-start-guide) also
documents query/grab limit configuration and explains that application sync profiles separately
control RSS, automatic search, and interactive search. A count of every enabled Prowlarr indexer is
therefore an overestimate unless the analysis filters to music-capable indexers actually synced
for automatic Lidarr searches.

## Libraries and SDKs

Neither official API publishes a first-party TypeScript SDK. Both publish OpenAPI 3 documents.

The repository already pins `@hey-api/openapi-ts@0.93.0` and commits a generated Lidarr client
behind its handwritten facade. Reuse that boundary for additional Lidarr reads. Do not introduce
TsArr or direct generated-type imports into action/command layers.

For optional Prowlarr observation, the choices are:

1. a very small private transport for the three read-only endpoints above; or
2. a separately generated, committed Prowlarr client if scope expands.

The first option is proportionate for issue #219. A new general-purpose SDK would add codegen,
schema-drift, authentication, error-taxonomy, and architecture-contract work without improving the
core deterministic estimate.

## Integration Patterns

### 1. Deterministic two-horizon analysis

Analyze the sealed change entries after no-op filtering:

```ts
interface CascadeEstimate {
  immediate: {
    metadataWrites: number;
    explicitSearches: number; // exact for the reviewed operation
    indexerQueries: number | "unknown";
    acquisitions: number | "unknown";
    downloadBytes: number | "unknown";
  };
  future: {
    newlyMonitoredAlbums: number;
    newlyEligibleAlbums: number;
    nominalIndexerFanout: number | "unknown";
    confidence: "exact" | "bounded" | "heuristic" | "unknown";
  };
}
```

For every currently supported plan kind, `explicitSearches`, immediate indexer queries,
acquisitions, and download bytes are exactly `0`. Future exposure should be computed from the
before/after state available during planning:

- monitoring false-to-true: count affected monitored albums;
- profile or `anyReleaseOk` change: count albums whose future acceptance policy changes;
- artist add: immediate search is zero; pre-add album cardinality is unavailable from stable local
  Lidarr state, so future album exposure is `unknown` unless planning already has trusted album
  evidence;
- tag changes: describe tag-scoped policy exposure, but do not assume a search;
- unmonitor/delete/local-file delete: no new acquisition load; report reduced exposure and
  destructive/file effects separately.

### 2. Operator budgets are authoritative

Use explicit CLI/config values such as maximum immediate searches, nominal queries, acquisitions,
and download bytes. Seal both configured budgets and computed estimates into the artifact/checksum
so apply cannot silently reinterpret them.

If a future operation ever enables search-on-add, a useful conservative nominal lower model is:

```text
search units = monitored missing albums selected for search
nominal queries = search units × eligible automatic-search indexers
acquisitions range = 0..search units
download bytes = unknown until release selection
```

Label nominal queries as a lower/heuristic value because pagination, retries, provider translation,
and artist/discography searches can change the actual request count.

### 3. Optional Prowlarr advisory snapshot

When separately configured with Prowlarr URL/key, planning may read:

```ts
const headers = { "X-Api-Key": apiKey, Accept: "application/json" };
const stats = await fetch(
  `${origin}/api/v1/indexerstats?startDate=${encodeURIComponent(windowStart)}&endDate=${encodeURIComponent(windowEnd)}`,
  { headers, signal },
);
const status = await fetch(`${origin}/api/v1/indexerstatus`, { headers, signal });
```

Persist only sanitized counts, indexer IDs/names, observation window, and timestamp. Never persist
the API key, request headers, raw provider fields, or raw response. Prowlarr unavailability should
yield `observedHeadroom: "unknown"` and a warning, not prevent a deterministic Lidarr plan.

### 4. Fail closed on known immediate budget breaches

- Known immediate estimate over an explicit budget: reject plan creation.
- Unknown immediate impact for an operation that can trigger search/download: reject unless the
  design provides an explicit override.
- Future-exposure threshold exceeded: warn and recommend smaller batches/delay/reduced monitoring;
  do not claim a live quota was exceeded.
- Prowlarr 429: honor `Retry-After` in any future execution path; planning must not retry aggressively.

## Constraints and Gotchas

- **Monitoring is not a search.** Do not multiply every newly monitored album by the indexer count
  and describe the result as immediate traffic.
- **RSS is shared work.** Prowlarr tracks RSS queries separately, and its configured query limit
  counts both search and RSS activity. Adding monitored albums changes matching exposure, not
  necessarily the number of each periodic RSS request.
- **Stats are retrospective.** `/indexerstats` cannot guarantee remaining provider quota and may
  include Sonarr/Radarr traffic using the same Prowlarr indexer.
- **Limits are optional.** No configured Prowlarr query/grab limit means "not configured", not
  unlimited upstream provider allowance.
- **Dynamic provider fields are version-sensitive.** Do not find query limits by localized labels.
- **One search can mean multiple HTTP requests.** Indexer pagination and retries invalidate an
  exact one-request-per-indexer assumption.
- **Downloads are availability-dependent.** Queue count, wanted count, or quality maximums do not
  prove future bytes.
- **Tags can alter routing.** Prowlarr/Lidarr tags and sync profiles may restrict eligible
  indexers; external tag-driven automation may add effects invisible to Lidarr's API.
- **Secret separation is mandatory.** Lidarr and Prowlarr API keys are independent and must remain
  optional runtime secrets.
- **URL-base and TLS support matter.** Build endpoints from canonical configured origins rather
  than assuming root-relative localhost URLs.
- **Planning must stay read-only.** Never POST a search command, test an indexer, or grab a release
  merely to improve an estimate.

## Open Questions

1. Are issue #219 budgets intended to cover only immediate apply-caused work, or also a
   configurable future-exposure horizon?
2. Should Prowlarr observation be in scope now, or should v1 remain fully local and use only
   operator-configured budgets?
3. Which units are required: explicit searches, nominal upstream queries, acquisitions, download
   bytes, or all four? Download bytes cannot be exact before release selection.
4. Should future exposure be sealed into existing `rfmedia.lidarr-plan.v2` artifacts, or should a
   new schema version be introduced to preserve exact-key/checksum compatibility?
5. What threshold behavior is desired for future-only exposure: warning, plan rejection, or an
   explicit override?
6. How should tag-scoped external automation be represented when its rules are not observable
   through Lidarr?
7. If Prowlarr stats are used, what observation window and stale-data limit should be part of the
   contract?
8. Should recommendations be deterministic tiers (reduce scope, split batches, delay apply) rather
   than timing promises based on unknown external quotas?
