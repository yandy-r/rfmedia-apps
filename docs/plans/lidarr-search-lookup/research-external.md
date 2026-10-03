# External API Research: Lidarr Search and Lookup

## Executive Summary

Lidarr exposes three metadata-dependent search operations: artist lookup, album lookup, and a
combined artist-or-album search. All three are authenticated `GET` requests with one optional
OpenAPI query parameter, `term`, and all return an unpaginated JSON array. The repository's pinned
OpenAPI snapshot is still byte-identical to Lidarr `develop` as of 2026-07-23, and its generated
private SDK already contains all three functions. The implementation should therefore extend the
stable `LidarrClientApi` facade and strict domain projections; it should not add handwritten paths,
another HTTP library, or upper-layer generated imports.

Search reliability is materially worse than ordinary local Lidarr reads. Lidarr delegates lookup to
its hosted metadata service and converts `SkyHookException` into HTTP 503. The official repository
still warns that metadata recovery affects artist addition and imports, and the confirmed upstream
incident remains open. Its latest maintainer update, dated 2026-01-05, says text search is
functionally broken while MusicBrainz-ID searches work much better. Lookup should consequently be
classified as `metadata-dependent`, health-gated, cacheable by canonical query, and explicit about
fresh, stale, and externally sourced results.

The recommended first release calls Lidarr only, with validated `artist` and `album` lookup
operations, optional local pagination, and stale-cache fallback under explicit consent. A direct
MusicBrainz fallback is feasible but is a separate integration: it has a different response model,
requires an identifiable User-Agent and a global one-request-per-second limiter, and cannot produce
all Lidarr-enriched fields. If added, it should return a deliberately smaller common projection with
source and degradation metadata, never masquerade as a normal Lidarr response.

**Confidence**: High. The endpoint, auth, generated-client, and failure findings come from the
current official OpenAPI document, current Lidarr source, the official incident, and direct
inspection of this repository. The operational status finding is Medium confidence because the
incident's latest detailed update is from 2026-01-05.

> **Freshness note (2026-07-23):** Lidarr's OpenAPI document was last updated 2025-10-20 and is
> unchanged from this repository's pinned snapshot. The metadata incident remains open, but its
> latest detailed maintainer comment is from 2026-01-05; live service quality can change without an
> OpenAPI or source-code change.

## Primary APIs

### Endpoint matrix

| Operation           | Method and path             | Query                                                              | Success response   | Native paging |
| ------------------- | --------------------------- | ------------------------------------------------------------------ | ------------------ | ------------- |
| Artist lookup       | `GET /api/v1/artist/lookup` | `term?: string`                                                    | `ArtistResource[]` | None          |
| Album lookup        | `GET /api/v1/album/lookup`  | `term?: string`                                                    | `AlbumResource[]`  | None          |
| Combined search     | `GET /api/v1/search`        | `term?: string`                                                    | `SearchResource[]` | None          |
| Local artist filter | `GET /api/v1/artist`        | `mbId?: UUID`                                                      | `ArtistResource[]` | None          |
| Local album filter  | `GET /api/v1/album`         | `artistId`, `albumIds`, `foreignAlbumId`, `includeAllArtistAlbums` | `AlbumResource[]`  | None          |

The first three operations perform remote metadata discovery. The last two query Lidarr's local
library and are not substitutes for discovery. In particular, `GET /api/v1/artist?mbId=...` answers
"is this artist already in my Lidarr library?" while
`GET /api/v1/artist/lookup?term=lidarr:<MBID>` can discover an artist absent from the library.

Primary source: [official Lidarr OpenAPI document](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/openapi.json),
updated 2025-10-20 by
[commit `3e285843`](https://github.com/Lidarr/Lidarr/commit/3e2858439ff35b372d0af00bcea1b0a357572d26).

**Confidence**: High. The current OpenAPI byte hash
`4ae9e79e9662898ed4704ce80f091161587a9f0d664f9e518b11a038616e491f` exactly matches
`packages/rfmedia-cli/openapi/lidarr-v1.json`.

### Artist lookup

The [artist lookup controller](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/Artist/ArtistLookupController.cs)
(last changed 2024-12-17) accepts `term`, calls `SearchForNewArtist(term)`, maps every result to an
`ArtistResource`, converts cover URLs to local URLs, and separately exposes `remotePoster` when the
metadata result contains a poster.

Lidarr's current
[`SkyHookProxy.SearchForNewArtist`](https://github.com/Lidarr/Lidarr/blob/develop/src/NzbDrone.Core/MetadataSource/SkyHook/SkyHookProxy.cs)
(last changed 2025-09-02) has two query modes:

- A case-insensitive `lidarr:`, `lidarrid:`, or `mbid:` prefix followed by a valid UUID performs a
  direct MBID lookup. An invalid or whitespace-containing identifier returns an empty array.
- Any other term is lowercased and trimmed, then sent to the hosted metadata service as
  `type=artist&query=<term>`.

For an MBID already present locally, Lidarr returns its local artist model. For an absent MBID,
Lidarr fetches metadata using the first configured metadata profile. Consequently, lookup results
can mix local and remote shapes: a remote result commonly has no positive local Lidarr `id`, path,
profile assignment, monitored state, or local statistics.

**Confidence**: High for control flow and query syntax; Medium for which optional fields are
populated in every deployed Lidarr version because the OpenAPI schema makes most fields optional or
nullable and the result depends on local-library state.

### Album lookup

The [album lookup controller](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/Albums/AlbumLookupController.cs)
(last changed 2024-12-17) also accepts only `term`. It calls
`SearchForNewAlbum(term, null)`, maps results to `AlbumResource`, localizes image URLs, and adds
`remoteCover` when available.

`SearchForNewAlbum` supports the same three MBID prefixes and UUID validation. A valid direct lookup
returns the local album when present, otherwise it retrieves the remote album plus artist metadata.
A plain-text lookup sends `type=album`, the normalized query, an empty `artist`, and
`includeTracks=1` to the hosted metadata service. Although the internal method accepts an artist
argument, the public API controller always passes `null`; an `artist` query parameter is not part of
the supported public contract.

The proxy discards remote album results that cannot be mapped or have no album releases. This means
an empty success response can mean "no match," "invalid MBID syntax," "known entity with no usable
release," or a metadata result filtered during mapping. These cases are not distinguishable from
the successful response alone.

**Confidence**: High. The controller and proxy agree with the OpenAPI contract. The meaning of an
empty array is necessarily ambiguous because Lidarr intentionally collapses several cases.

### Combined search

`GET /api/v1/search` returns `SearchResource[]`, where each item has:

```typescript
interface SearchResource {
  id?: number; // response-local ordinal, not a durable entity ID
  foreignId?: string | null;
  artist?: ArtistResource;
  album?: AlbumResource;
}
```

The [combined search controller](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/Search/SearchController.cs)
(last changed 2024-12-17) assigns `id` sequentially starting at 1 for that response. Consumers must
use `foreignId`/the nested MusicBrainz identifiers as durable identifiers, not this ordinal.

For a plain term, Lidarr asks its hosted service for `type=all`. For an MBID-prefixed term, it tries
artist lookup first; if artist lookup throws or returns no match, it tries album lookup, then returns
at most one result. That fallback hides the artist failure when album lookup succeeds.

The explicit artist and album commands should use their dedicated endpoints. The combined endpoint
is useful only for an intentionally polymorphic `search all` mode, because its union response,
response-local IDs, and MBID artist-then-album fallback complicate deterministic scripting.

**Confidence**: High. This is directly encoded in the combined controller and `SearchForNewEntity`.

## Authentication, Rate Limits, and Cost

The OpenAPI document defines two alternative global API-key schemes:

- `X-Api-Key` request header.
- `apikey` query parameter.

Lidarr's [authentication handler](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Http/Authentication/ApiKeyAuthenticationHandler.cs)
(last changed 2025-10-15) accepts query, header, or bearer forms and returns HTTP 401 when no valid
credential is found. `rfmedia-cli` must continue to use only `X-Api-Key`; query credentials are
incompatible with its existing credential-confinement policy and can leak through URLs, logs, and
shell history.

Lidarr is self-hosted and its local API has no per-call price. Neither the OpenAPI document nor the
lookup controllers publish a local API rate limit, quota, pagination ceiling, or `429` response.
This absence is not a guarantee that reverse proxies or the hosted metadata service will never
throttle. The official metadata incident explicitly reported rate limiting and 503 responses during
recovery.

**Confidence**: High for supported authentication and the lack of a documented local quota; Medium
for effective metadata-service limits because Lidarr does not publish a stable numeric quota.

## Request and Response Shapes

### Recommended command-facing artist projection

Do not reuse the current local-library `LidarrArtist` projection if it requires a positive Lidarr
database ID or local configuration. A lookup result needs a distinct shape whose required identity
is the MusicBrainz/foreign artist ID:

```typescript
interface LidarrArtistLookupResult {
  readonly kind: "artist";
  readonly foreignArtistId: string;
  readonly artistName: string;
  readonly disambiguation?: string;
  readonly artistType?: string;
  readonly overview?: string;
  readonly genres: readonly string[];
  readonly remotePoster?: string;
  readonly localLidarrId?: number;
  readonly source: "lidarr" | "stale-cache" | "musicbrainz";
  readonly rank: number;
}
```

The official `ArtistResource` also contains status, links, members, ratings, images, path, profiles,
tags, and statistics. Those should remain optional or be omitted from the stable search projection
unless a command requirement consumes them. Generated types are compile-time descriptions, not
runtime validation.

### Recommended command-facing album projection

```typescript
interface LidarrAlbumLookupResult {
  readonly kind: "album";
  readonly foreignAlbumId: string;
  readonly title: string;
  readonly artistForeignId?: string;
  readonly artistName?: string;
  readonly disambiguation?: string;
  readonly albumType?: string;
  readonly secondaryTypes: readonly string[];
  readonly releaseDate?: string;
  readonly releaseCount: number;
  readonly remoteCover?: string;
  readonly localLidarrId?: number;
  readonly source: "lidarr" | "stale-cache" | "musicbrainz";
  readonly rank: number;
}
```

`AlbumResource` can additionally contain releases, media, duration, links, genres, ratings, and
local monitoring fields. A resilient search contract should require only stable foreign identity
and display fields. It should validate and copy values into fresh immutable objects so generated
wire DTOs and mutable arrays never escape the facade.

### Error shape

`SkyHookException` is an `NzbDroneClientException` fixed to HTTP 503. Lidarr's
[error pipeline](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Http/ErrorManagement/LidarrErrorPipeline.cs)
(last changed 2021-09-26) serializes client exceptions with a JSON `message` and `description`.
Typical messages distinguish:

- hosted metadata 503: `LidarrAPI Temporarily Unavailable (503)`;
- transport failure: `Unable to communicate with LidarrAPI`;
- malformed upstream payload: `Invalid response received from LidarrAPI`.

The OpenAPI document declares only the 200 response for lookup/search, so the generated SDK has no
typed error model. The current generic status mapper treats a 503 without `Retry-After` as
`lidarr-unreachable`; that is insufficient for a metadata-dependent endpoint because the local
instance can be healthy while its provider is unavailable.

Recommended classification order:

1. Preserve `429` and `503` with a valid `Retry-After` as `rate-limited`.
2. For lookup/search, classify 503 as `metadata-provider-unavailable` when a bounded, internally
   inspected error payload mentions `LidarrAPI`, `metadata`, or `SkyHook`, or when the immediately
   preceding health gate proved the local instance reachable.
3. Otherwise retain `lidarr-unreachable`; do not assume every reverse-proxy 503 is a metadata
   failure.
4. Never surface `description`, raw response bodies, URLs with credentials, or generated
   request/response envelopes.

**Confidence**: High for Lidarr's server-side status and body behavior; Medium for the recommended
client-side disambiguation because reverse proxies can replace a 503 body and provider status can
change between health probe and lookup.

## Pagination and Query Shaping

### Native behavior

Artist lookup, album lookup, and combined search have no `page`, `pageSize`, `limit`, `offset`,
sort, filter, or cursor parameter in either the OpenAPI document or controller signature. A CLI
pagination option cannot reduce Lidarr or metadata-provider work; it can only slice the full
response after download, validation, normalization, and stable ranking.

**Confidence**: High.

### Recommended input contract

- Require a non-empty term after trimming.
- Cap term length before dispatch (for example, 256 Unicode code points) and reject NUL/control
  characters. The exact cap is a project decision because Lidarr publishes none.
- Preserve arbitrary user text except outer whitespace. Lidarr itself lowercases invariantly; the
  CLI should not apply locale-sensitive case conversion or punctuation rewriting.
- Recognize `lidarr:`, `lidarrid:`, and `mbid:` case-insensitively. Canonicalize all valid direct-ID
  queries to `lidarr:<lowercase-uuid>` for request and cache-key stability.
- Reject malformed prefixed UUIDs locally with a validation error. Lidarr otherwise returns an
  indistinguishable empty success, which is poor script behavior.
- Do not expose an upstream `artist` option for album lookup. If an artist filter is required, apply
  it to validated results and label it as client-side filtering.

### Recommended local pagination

Use 1-based `page` and a bounded positive `pageSize`; compute:

```text
start = (page - 1) * pageSize
records = completeResults.slice(start, start + pageSize)
```

Machine-readable output should always include `page`, `pageSize`, `totalRecords`, `totalPages`,
`hasPreviousPage`, and `hasNextPage`. An out-of-range page should return an empty `records` array
with the true totals, not a transport error.

Preserve upstream relevance order by default and assign `rank` before slicing. If a sort option is
added, make it explicit and stable, with a foreign-ID tie-breaker. Do not claim upstream order is
stable across time: metadata indexing changes can reorder equally relevant results.

### Cache key and pagination interaction

Cache the complete validated projection, not individual pages:

```text
origin x lookup-kind x canonical-term x projection-schema-version
```

Then apply current filter, sort, and pagination options at read time. Per-page cache entries would
duplicate data, multiply keys, make total counts inconsistent, and prevent a cached first page from
serving a different page size. API keys must never enter the key or payload.

**Confidence**: High for the no-native-pagination consequence; High for full-result caching as the
simplest consistent design.

## Resilience, Fallback, and Caching Implications

### Current upstream condition

The [Lidarr repository README](https://github.com/Lidarr/Lidarr#readme), last changed 2025-08-22,
still warns that metadata-server recovery and cache rebuilding affect adding artists and library
imports. [Issue #5498](https://github.com/Lidarr/Lidarr/issues/5498), opened 2025-04-09 and last
updated 2026-01-05, is still open and marked `Area: Metadata API`, `Status: Confirmed`, and
`Type: External Bug`. The latest maintainer update says text searches are functionally broken,
artist/release-group ID searches work much better, and images are not fully working.

This makes an empty text result unsafe to reinterpret as a provider outage: Lidarr returns a valid
empty array for legitimate no-match and malformed-ID cases, while the known incident can also
degrade relevance or completeness. Only explicit error/health signals should trigger fallback.
Successful empty results may be cached briefly, but negative-cache TTL should be materially shorter
than positive-result TTL.

**Confidence**: Medium. The official incident is authoritative but its last detailed update is over
six months old.

### Integration with the existing resilience layer

The repository already provides the required primitives:

- `metadata-dependent` tier and a fresh pre-flight health gate;
- separate local-Lidarr and metadata-provider circuits;
- a typed `MetadataProviderUnavailableError`;
- bounded retry with `Retry-After` support;
- explicit `--allow-stale` consent and an ordered `MetadataFallbackSource[]`;
- SQLite cache keys scoped by credential-free canonical origin.

Search methods must be explicitly added to the resilience decorator. New methods default to no
retry and no cache because `LIDARR_IN_PLACE_RETRY_ALLOWLIST`, `LidarrCacheCategory`, and the wrapped
method map are exhaustive/manual. Add the lookup `GET`s to the retry allowlist, but continue to
exclude `metadata-provider-unavailable` from millisecond-scale in-place retry: provider outages tend
to outlast a command. Feed those failures to the metadata circuit.

Add query-aware cache categories such as `artist-lookup` and `album-lookup`; unlike existing
whole-list categories, their discriminator must be the canonical term plus projection schema
version. Combined search should either get its own category or be omitted from v1.

### Recommended fallback order

1. Fresh Lidarr lookup after health gate.
2. Fresh query cache, if the product chooses read-through cache semantics.
3. Explicitly consented stale cache on unreachable, timeout, or metadata-provider-unavailable.
4. Optional direct MusicBrainz source, clearly marked `source: "musicbrainz"` and `degraded: true`.
5. Typed failure containing retry/circuit timing and a recommendation to retry with an MBID.

Do not silently turn a stale or direct-MusicBrainz result into `source: "lidarr"`. Text output should
warn on stderr while JSON carries stable source, fetched-at, age, and degradation fields.

**Confidence**: High for how the current repository must be extended; Medium for the exact product
fallback order because whether fresh cache is consulted before the network is a business/UX choice.

## Direct MusicBrainz Fallback

MusicBrainz's official Web Service 2 can search:

```text
GET https://musicbrainz.org/ws/2/artist?query=<query>&limit=<limit>&offset=<offset>&fmt=json
GET https://musicbrainz.org/ws/2/release-group?query=<query>&limit=<limit>&offset=<offset>&fmt=json
```

It can also look up an exact entity by MBID:

```text
GET https://musicbrainz.org/ws/2/artist/<mbid>?fmt=json
GET https://musicbrainz.org/ws/2/release-group/<mbid>?fmt=json
```

The [official WS2 documentation](https://musicbrainz.org/doc/Development/XML_Web_Service/Version_2)
(retrieved 2026-07-23) says public reads need no API key but require a meaningful User-Agent. Search
supports `limit` and `offset`; browse defaults to 25 and allows up to 100. The
[official rate-limit policy](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) says clients
must average no more than one request per second per source IP and may receive HTTP 503 when
throttled.

This fallback needs:

- a new audited Fetch owner or an approved shared external-HTTP boundary;
- an application-identifying User-Agent with contact information;
- a process-wide and cross-command one-request-per-second limiter;
- its own timeout, redirect, origin, size, retry, and error controls;
- response validation and a smaller common search projection;
- license/attribution review and optional commercial-use review;
- no attempt to synthesize Lidarr-local IDs, paths, profiles, monitoring state, images, or
  statistics.

No additional npm SDK is required. The API is simple enough to use the project's hardened Fetch
patterns, and an SDK would not remove the mandatory global rate limiter or projection work.

**Confidence**: High for MusicBrainz API/auth/rate-limit mechanics; High that it cannot reproduce
Lidarr-local fields.

## Generated-Client and Dependency Constraints

The checked-in generated client already exports:

- `getApiV1ArtistLookup`;
- `getApiV1AlbumLookup`;
- `getApiV1Search`;
- their query data, response, and resource types.

No generator refresh or runtime dependency is required for the feature. However, lookup operations
are not in `scripts/generate-lidarr-client.mjs`'s `REQUIRED_OPERATIONS` and their paths are not in
`REQUIRED_ENDPOINTS`. Add the chosen operations to those fail-closed lists and generated contract
tests so a future upstream snapshot or generator change cannot silently remove them.

All generated modules are private. Only `src/lib/lidarr/client.ts` may import and invoke generated
operations; actions, commands, public types, and helpers must consume narrow facade methods and
domain projections. `src/lib/lidarr/transport.ts` remains the sole authenticated Fetch owner and
must retain origin pinning, header-only API key injection, redirect rejection, cancellation and
timeout composition, 8 MiB success-body cap, 4 KiB error drain, fatal UTF-8 decoding, and secret
redaction.

The generator is exact-pinned `@hey-api/openapi-ts@0.93.0`, uses a committed immutable snapshot,
bundles its private Fetch runtime, disables generated auth, and emits per-instance clients.
Regeneration is offline; only the explicit refresh command contacts upstream.

**Confidence**: High. These constraints are enforced by this repository's manifest, generator,
architecture checks, and generated contract tests.

## Integration Patterns

Recommended data flow:

```text
command options
  -> action (tier, output metadata, pagination)
    -> resilient LidarrClientApi decorator
      -> stable lookup method + strict projection
        -> private generated lookup operation
          -> existing hardened transport
            -> local Lidarr -> hosted metadata provider
```

Concrete method contracts:

```typescript
interface LidarrLookupQuery {
  readonly term: string;
  readonly signal?: AbortSignal;
}

interface LidarrClientApi {
  lookupArtists(query: LidarrLookupQuery): Promise<readonly LidarrArtistLookupResult[]>;
  lookupAlbums(query: LidarrLookupQuery): Promise<readonly LidarrAlbumLookupResult[]>;
}
```

Keep page/sort/output shaping above the client. The client should fetch and project the complete
result array; the action should add ranks, filter/sort if requested, paginate, and attach source and
cache metadata. This keeps the cache reusable across presentation options and keeps the stable
facade faithful to the actual upstream API.

For combined search, either defer it or model it as an explicit discriminated union:

```typescript
type LidarrSearchResult = LidarrArtistLookupResult | LidarrAlbumLookupResult;
```

Never infer the kind from optional display fields; require `kind`.

**Confidence**: High. This follows the enforced dependency direction and the actual unpaginated
endpoint contract.

## Constraints and Limitations

- OpenAPI declares `term` optional and only documents HTTP 200. Runtime validation and failure
  taxonomy must supply the missing contract.
- Lookup has no native pagination, page size, stable ordering guarantee, artist filter for album
  lookup, or documented maximum query length/result count.
- Empty arrays are semantically ambiguous.
- Remote results do not necessarily have positive local Lidarr IDs or local management fields.
- Text search quality and image completeness are currently subject to an open upstream incident.
- A health check can detect a known provider outage but cannot guarantee that the next lookup will
  succeed.
- The hosted metadata service's numeric rate limits are not published as a stable API contract.
- Direct MusicBrainz results are not shape-compatible with Lidarr resources.
- Cached results can become stale as MusicBrainz and Lidarr's metadata index change; stale use must
  remain explicit and observable.
- OpenAPI `info.version` is `1.0.0`, not the running Lidarr release. Use system status for runtime
  version context.

**Confidence**: High except for live provider quality/rate limits, which are Medium.

## Concrete Implementation Recommendations

1. Ship dedicated `lookupArtists` and `lookupAlbums` facade methods using the already generated
   operations. Defer combined search unless a polymorphic command is explicitly required.
2. Create lookup-specific strict projections keyed by foreign/MusicBrainz ID; do not require or
   expose response-local IDs as durable identity.
3. Validate and canonicalize terms before dispatch, especially MBID prefixes.
4. Mark actions `metadata-dependent` and use the existing health gate and metadata circuit.
5. Extend the resilience wrapper's method map, read-retry allowlist, cache categories, and
   query-aware discriminators explicitly.
6. Cache complete validated result arrays; paginate and sort in the action layer.
7. Preserve provider relevance order by default and emit stable rank plus pagination metadata in
   JSON.
8. Classify metadata 503s without conflating arbitrary proxy 503s; use bounded internal error
   inspection and/or successful health-gate context, never raw-body exposure.
9. Add lookup endpoints to generator fail-closed requirements and generated contract tests.
10. Treat direct MusicBrainz fallback as a follow-up integration unless the initial feature
    explicitly accepts its new Fetch owner, limiter, projection, source semantics, and tests.

**Confidence**: High for recommendations 1-9; Medium for deferring MusicBrainz because product
requirements may prioritize live fallback over implementation scope.

## Open Questions

1. Is "pagination" intended only for deterministic CLI slicing, or must it reduce provider work?
   Lidarr cannot satisfy the latter without a different upstream source.
2. Should a successful empty lookup be negative-cached, and for how long?
3. Should fresh cache be consulted before every network lookup, or only stale cache after failure?
4. Is direct MusicBrainz fallback in scope for issue #222, or is the existing
   `MetadataFallbackSource` seam plus stale SQLite cache sufficient for v1?
5. If MusicBrainz is enabled, what minimum common fields and explicit degradation marker are
   acceptable?
6. Should malformed `lidarr:`/`lidarrid:`/`mbid:` terms be local validation errors or empty results
   for strict compatibility with Lidarr?
7. Does the command need combined `search all`, or only explicit artist and album lookup?
8. What maximum term length, local page size, positive TTL, negative TTL, and stale ceiling should
   be product defaults?
9. Should cached results be invalidated by Lidarr version, projection schema version, or both?
10. How should an out-of-range page affect process exit status in scriptable modes?

## Sources

All external sources are primary/official.

- [Lidarr OpenAPI document](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/openapi.json)
  — updated 2025-10-20.
- [OpenAPI update commit `3e285843`](https://github.com/Lidarr/Lidarr/commit/3e2858439ff35b372d0af00bcea1b0a357572d26)
  — 2025-10-20.
- [Artist lookup controller](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/Artist/ArtistLookupController.cs)
  — last changed 2024-12-17.
- [Album lookup controller](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/Albums/AlbumLookupController.cs)
  — last changed 2024-12-17.
- [Combined search controller](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/Search/SearchController.cs)
  — last changed 2024-12-17.
- [SkyHook metadata proxy](https://github.com/Lidarr/Lidarr/blob/develop/src/NzbDrone.Core/MetadataSource/SkyHook/SkyHookProxy.cs)
  — last changed 2025-09-02.
- [SkyHook exception](https://github.com/Lidarr/Lidarr/blob/develop/src/NzbDrone.Core/MetadataSource/SkyHook/SkyHookException.cs)
  — last changed 2023-01-27.
- [Lidarr error pipeline](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Http/ErrorManagement/LidarrErrorPipeline.cs)
  — last changed 2021-09-26.
- [Lidarr API-key authentication handler](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Http/Authentication/ApiKeyAuthenticationHandler.cs)
  — last changed 2025-10-15.
- [Lidarr README metadata warning](https://github.com/Lidarr/Lidarr#readme) — README last changed
  2025-08-22; retrieved 2026-07-23.
- [Lidarr metadata incident #5498](https://github.com/Lidarr/Lidarr/issues/5498) — opened
  2025-04-09, last updated 2026-01-05, still open on 2026-07-23.
- [MusicBrainz Web Service 2](https://musicbrainz.org/doc/Development/XML_Web_Service/Version_2)
  — retrieved 2026-07-23.
- [MusicBrainz search API](https://musicbrainz.org/doc/MusicBrainz_API/Search) — retrieved
  2026-07-23.
- [MusicBrainz rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) —
  retrieved 2026-07-23.
