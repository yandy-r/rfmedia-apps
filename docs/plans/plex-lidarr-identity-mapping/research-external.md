# External API Research: Plex-Lidarr Identity Mapping

_Research date: 2026-07-27. Technical claims use current official Plex, Lidarr, and
MusicBrainz sources. The Plex reference was last modified 2026-07-15; the current Lidarr
`develop` OpenAPI snapshot was last generated 2025-10-20. MusicBrainz documentation pages do not
publish a conventional update date, so their current revisions were accessed on the research date._

## Executive Summary

Issue #207 is feasible without adding a runtime dependency, but only if the design distinguishes
four different kinds of identity evidence:

1. a Plex-local identity (`machineIdentifier`, library section, media kind, `ratingKey`);
2. an external identifier reported in Plex's optional `Guid[]`;
3. an entity-typed MusicBrainz identifier (artist, release group, release, recording, or track);
4. a Lidarr-local identity plus its corresponding MusicBrainz field.

An MBID is not self-describing: every MusicBrainz entity uses the same UUID-shaped identifier.
Consequently, the mapping layer must never join UUID strings without an entity type. The
authoritative joins are:

| Bridge level  | MusicBrainz entity | Lidarr field                                     |
| ------------- | ------------------ | ------------------------------------------------ |
| Artist        | artist             | `ArtistResource.foreignArtistId` / legacy `mbId` |
| Album action  | release group      | `AlbumResource.foreignAlbumId`                   |
| Edition       | release            | `AlbumReleaseResource.foreignReleaseId`          |
| Recording     | recording          | `TrackResource.foreignRecordingId`               |
| Release track | track              | `TrackResource.foreignTrackId`                   |

The official Plex API defines `Guid[]` as an optional list of `provider://id` mappings, useful for
exact cross-provider matches. It does **not** document a guarantee that PMS music artist, album, or
track results contain MusicBrainz IDs, nor a guaranteed MusicBrainz provider scheme. Therefore,
actual Plex music MBID availability and shape must be captured in sanitized fixtures from supported
PMS/music-agent combinations before the implementation treats a scheme such as `mbid://...` as a
stable input contract.

The durable cache should be an evidence ledger, not an unqualified key-value assertion. Store the
Plex and Lidarr scopes, entity kind, typed MBID, resolution method (`exact-guid`, `exact-cache`,
`fuzzy-reviewed`, or `manual`), input names, score and runner-up margin, timestamps, and source
fingerprints. Exact MBID mappings can be reused offline. Fuzzy mappings should require a high
threshold, a unique winner, and explicit operator acceptance before becoming durable.

The repository already has the right implementation primitives:

- the private, generated Lidarr client and handwritten facade;
- `better-sqlite3` and an established schema/migration model;
- `fastest-levenshtein` plus existing normalization helpers;
- Node 22 native `fetch`, `URL`, `AbortSignal`, and `crypto`;
- scoped `listAlbums()` and `listTracks()` reads for expansion evidence.

No new dependency is warranted. Direct MusicBrainz requests should be optional, refresh-only
enrichment for entity translation or verification, never required for repeatable offline analysis.
When enabled, they must use a meaningful `User-Agent`, serialize requests to at most one per second,
cache successful results, and handle throttling as `503 Service Unavailable`.

**Confidence**: High. The API shapes and existing dependency assessment are confirmed by current
official specifications and repository code. Confidence is Medium for the end-to-end exact-match
coverage because Plex's official contract makes external IDs optional and does not guarantee
MusicBrainz identifiers for music libraries.

## Primary APIs

### Plex Media Server API

- **Official documentation**:
  [Plex Media Server API](https://developer.plex.tv/pms/) (last modified 2026-07-15).
- **Base URL**: the configured local PMS origin.
- **Authentication**: send the opaque access token as `X-Plex-Token`; send the stable
  `X-Plex-Client-Identifier` and ordinary Plex product/version headers through the existing private
  transport.
- **Response format**: request JSON with `Accept: application/json`.
- **Rate limit**: Plex publishes no numeric local PMS HTTP quota. Preserve the CLI's bounded
  pagination/pacing policy and honor `429`/`Retry-After` if observed; do not present a guessed quota
  as a Plex contract.

Relevant reads:

| Endpoint                                     | Identity use                                                                 | Important contract                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                      | Obtain the server `machineIdentifier` for Plex-local cache scoping           | A `ratingKey` is only meaningful inside its PMS/library lifecycle; do not use it as a global identity.                                 |
| `GET /library/sections`                      | Discover music library section keys                                          | Preserve the library section key with every cached Plex identity.                                                                      |
| `GET /library/sections/{sectionId}/all`      | Enumerate artist (`type=8`), album (`type=9`), or track (`type=10`) metadata | Use `X-Plex-Container-Start` and `X-Plex-Container-Size`; advance from response pagination fields rather than the requested page size. |
| `GET /library/metadata/{ratingKey}`          | Fetch one entity when list projections omit optional identity evidence       | Treat response `Guid[]` as optional and validate every member before use.                                                              |
| `GET /library/metadata/{ratingKey}/children` | Relate artist-to-album or album-to-track Plex-local hierarchy                | Returned `key`/parent fields are navigation evidence, not MusicBrainz identity.                                                        |

The official metadata response contract distinguishes:

- `guid`: the metadata provider's primary Plex-compatible GUID;
- `Guid[]`: optional external mappings, each with an `id` in `provider://id` form;
- `parentGuid` and `grandparentGuid`: Plex-compatible parent identities.

Those fields should be owned by the private Plex adapter. Extend its narrow wire DTOs and map them
to a bridge-specific identity evidence type; do not expose raw Plex DTOs through the generic media
server interface merely to support this feature.

The official page demonstrates external-ID mapping with IMDb/TMDB/TVDB and lists those providers
for its generic metadata-provider contract. It does not name or guarantee a MusicBrainz scheme for
PMS music. The implementation must therefore:

1. preserve every syntactically valid external GUID as bounded evidence;
2. recognize a MusicBrainz scheme only after fixture validation;
3. validate the UUID and expected entity level;
4. fall back to reviewable matching when no exact, typed MBID exists.

**Confidence**: High for authentication, endpoints, pagination, and `Guid[]` optionality because
they are in Plex's current official reference. **Confidence**: Low for the concrete MusicBrainz
scheme and coverage until supported PMS/music-agent fixtures confirm them; the official contract
does not specify either.

### Lidarr v1 API

- **Official documentation**:
  [interactive API documentation](https://lidarr.audio/docs/api/) and the
  [official OpenAPI document at commit `3e285843`](https://raw.githubusercontent.com/Lidarr/Lidarr/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json)
  (generated 2025-10-20; still the current `develop` document on 2026-07-27).
- **Base URL**: the configured Lidarr origin, normally `http://localhost:8686`, including any URL
  base.
- **Authentication**: the OpenAPI permits an `X-Api-Key` header or `apikey` query parameter. Reuse
  the existing header-based private client so secrets do not enter URLs or logs.
- **Rate limit**: the official OpenAPI specifies no local Lidarr API quota or quota headers. Keep
  existing client concurrency, retry, response-size, and circuit-breaker policy.

Relevant resources:

| Endpoint / resource                       | Identity and expansion use                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/artist`                      | Returns installed artists; `?mbId={uuid}` provides an exact artist read. `foreignArtistId` is the canonical bridge field.         |
| `GET /api/v1/artist/lookup?term=...`      | Metadata-dependent candidate resolution. Existing facade supports `lidarr:{artistMbid}` for exact lookup.                         |
| `GET /api/v1/album?artistId={id}`         | Returns an artist's albums, `foreignAlbumId` release-group identity, monitoring state, release date, type, and statistics.        |
| `GET /api/v1/album?foreignAlbumId={uuid}` | Official wire query for release-group identity; a facade method should own it if issue #207 needs an exact direct read.           |
| `GET /api/v1/album/lookup?term=...`       | Metadata-dependent album candidates. Use only for explicit refresh/resolution, not offline cache replay.                          |
| `GET /api/v1/track?albumId={id}`          | Returns album-scoped tracks, including `foreignRecordingId`, `foreignTrackId`, and file presence for local expansion evidence.    |
| `AlbumReleaseResource`                    | `foreignReleaseId` identifies a concrete MusicBrainz release/edition, not the album-level release group used by `foreignAlbumId`. |

The issue-provided February 2026 research said there was no independent track endpoint. The current
official OpenAPI does contain read-only `GET /api/v1/track`, and the repository already exposes it
as a strictly album-scoped `listTracks()` facade method. The design should use the current contract
for expansion counts while preserving Lidarr's album-oriented mutation semantics.

Use only the handwritten Lidarr facade from bridge/action code. Generated operations and DTOs stay
private. If a required exact album-MBID read is missing, add one narrow facade method rather than
importing generated code or manually constructing `/api/v1` paths in the bridge.

**Confidence**: High. Resource fields, authentication, and endpoints are present in the official
OpenAPI and its pinned repository snapshot.

### MusicBrainz Web Service 2

- **Official documentation**:
  [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API),
  [rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting),
  [MBID semantics](https://musicbrainz.org/doc/MusicBrainz_Identifier),
  [artist](https://musicbrainz.org/doc/Artist),
  [release group](https://musicbrainz.org/doc/Release_Group),
  [release](https://musicbrainz.org/doc/Release), and
  [recording](https://musicbrainz.org/doc/Recording) (current pages accessed 2026-07-27).
- **Base URL**: `https://musicbrainz.org/ws/2/`.
- **Authentication**: public GET lookups/searches require no API key. Submission and private user
  data require authentication and are outside issue #207.
- **Identification**: every request must carry a meaningful `User-Agent` with application name,
  version, and contact URL or email.
- **Rate limit**: each client application must not exceed one call per second; the IP limit is also
  currently an average of one request per second unless separately agreed. Throttled requests are
  rejected with `503`, not necessarily `429`.
- **Formats**: request JSON with `Accept: application/json` or `fmt=json`.

Potential read-only enrichment:

| Endpoint                                                             | Use                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /ws/2/artist/{artistMbid}?fmt=json`                             | Verify that an exact candidate is an artist and retrieve bounded disambiguation evidence.                          |
| `GET /ws/2/release-group/{releaseGroupMbid}?inc=releases&fmt=json`   | Verify an album-level release-group identity.                                                                      |
| `GET /ws/2/release/{releaseMbid}?inc=release-groups&fmt=json`        | Translate a concrete edition/release MBID to the release-group identity required by Lidarr album actions.          |
| `GET /ws/2/recording/{recordingMbid}?inc=releases+release-groups...` | Obtain candidate releases for a recording only; it cannot prove one unique album because recordings can be reused. |
| `GET /ws/2/artist?query=...&limit=...&offset=...&fmt=json`           | Optional candidate discovery when both systems lack an MBID; never an automatic final join.                        |
| `GET /ws/2/release-group?query=...&limit=...&offset=...&fmt=json`    | Optional candidate discovery for albums; artist credit/year/type should constrain the query and local scoring.     |

MusicBrainz defines a release group as the logical album concept and a release as a particular
issuing/edition. It defines a recording as audio that may be linked to tracks on any number of
releases. These distinctions are why a track recording MBID cannot be mechanically converted into
one Lidarr album target.

Direct MusicBrainz is not required for the basic artist join when Plex and Lidarr expose the same
typed MBID. Introduce it only if fixture results show that release-to-release-group translation or
review-time verification materially improves coverage. Cache successful responses or derived
relations, add jitter to bulk refresh scheduling, and never poll for metadata changes.

**Confidence**: High for entity semantics, request formats, authentication, and the one-request-per-
second rule because they are documented by MusicBrainz. **Confidence**: Medium for whether direct
MusicBrainz improves issue #207 enough to justify another network boundary; that depends on real
Plex GUID coverage.

## Libraries and SDKs

### Existing dependencies to reuse

| Dependency / facility                        | Use                                                                     | Assessment                                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing generated Lidarr client + facade    | Typed local Lidarr reads                                                | Required reuse. Add only narrow domain projections/facade methods.                                                                         |
| `better-sqlite3`                             | Durable mapping/evidence cache, indexes, transactions, schema migration | Required reuse. It already backs rfmedia state, deferred intents, and Lidarr metadata cache.                                               |
| `fastest-levenshtein`                        | Bounded normalized similarity                                           | Reuse through a bridge-owned scorer or existing pure helpers. Do not call log-heavy `findBestMatch()` across unbounded Cartesian products. |
| Existing `foldArtistName()`/normalizers      | Exact folded-name bucketing before fuzzy comparison                     | Reuse selectively. Preserve original names and normalization version in evidence so algorithm changes are auditable.                       |
| Node 22 native `fetch`, `URL`, `AbortSignal` | Optional MusicBrainz GETs                                               | Sufficient for the small endpoint surface. Reuse existing transport/error conventions.                                                     |
| Node `crypto`                                | Stable evidence hashes/fingerprints                                     | Sufficient; no UUID or hashing package is needed.                                                                                          |
| Existing database connection/migrations      | Atomic schema installation and cache writes                             | Prefer the repository's shared DB lifecycle over a second cache file.                                                                      |

### New dependency evaluation

| Candidate                               | Potential value                           | Decision                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fuse.js` or another fuzzy-search index | Weighted multi-field search and indexing  | Do not add. Candidate sets should first be narrowed by entity kind/artist/year, and existing Levenshtein primitives can score the bounded set.            |
| A MusicBrainz JavaScript SDK            | Models, URL construction, and throttling  | Do not add initially. The optional endpoint surface is tiny, and SDK adoption does not remove the User-Agent, pacing, caching, or validation obligations. |
| A Plex JavaScript SDK                   | Raw PMS DTOs and endpoint wrappers        | Do not add. The private Plex adapter and transport already own the required reads; a second client would create auth, pagination, and error-parity work.  |
| Another SQLite/ORM package              | Schema abstraction                        | Do not add. It would duplicate the established synchronous database boundary and migration conventions.                                                   |
| A general rate-limiter package          | MusicBrainz one-request-per-second pacing | Do not add. A small serialized `nextAllowedAt` queue around one optional source is easier to verify and avoids confusing concurrency with rate.           |

**Recommendation**: add no package. Reassess only if the feature grows into broad MusicBrainz
search/browse support or empirical candidate volumes demonstrate that the existing O(n) exact
bucketing plus bounded fuzzy scoring is inadequate.

**Confidence**: High. This is based on the checked-in dependency graph and the narrow API surface.

## Integration Patterns

### 1. Preserve typed, scoped identity evidence

The cache key must include both local provider scopes. A safe conceptual record is:

```ts
type BridgeEntityKind = "artist" | "release-group" | "release" | "recording" | "track";
type BridgeResolutionMethod = "exact-guid" | "exact-cache" | "fuzzy-reviewed" | "manual";

interface IdentityMappingEvidence {
  readonly plex: {
    readonly machineIdentifier: string;
    readonly librarySectionId: string;
    readonly mediaKind: "artist" | "album" | "track";
    readonly ratingKey: string;
    readonly title: string;
    readonly parentRatingKey?: string;
    readonly sourceFingerprint: string;
  };
  readonly musicBrainz: {
    readonly entityKind: BridgeEntityKind;
    readonly id: string;
    readonly sourceGuid?: string;
  };
  readonly lidarr: {
    readonly origin: string; // canonical, credential-free
    readonly entityKind: "artist" | "album" | "track";
    readonly id: number;
    readonly title: string;
    readonly sourceFingerprint: string;
  };
  readonly resolution: {
    readonly method: BridgeResolutionMethod;
    readonly score?: number;
    readonly runnerUpScore?: number;
    readonly normalizationVersion: number;
    readonly reviewedAt?: string;
  };
  readonly verifiedAt: string;
  readonly schemaVersion: number;
}
```

Recommended uniqueness rules:

- one current mapping per Plex scope/entity and Lidarr origin;
- a typed MBID index (`entity_kind`, `mbid`);
- no secret in any scope, payload, fingerprint, or error;
- a mapping conflict is data to report, not a last-write-wins overwrite.

Store the full bounded evidence necessary to explain an offline result, but not raw API payloads.
Use transactions for batch refresh. Cache replay must be deterministic and must expose mapping age,
method, and confidence.

### 2. Resolve in a fail-closed ladder

Use this order:

1. Parse and validate Plex external identifiers.
2. Match an exact typed MBID to Lidarr's corresponding typed field.
3. Reuse an unexpired or explicitly offline cache record whose source fingerprints still match.
4. Generate bounded fuzzy candidates within the same entity kind and parent context.
5. Require review for a unique high-confidence fuzzy candidate.
6. Leave ambiguous/unmatched entities unresolved with candidate evidence.

An exact MBID must dominate names. A name match must never merge records carrying different valid
MBIDs. Cache evidence may make analysis repeatable, but a later live refresh that exposes an MBID
conflict must invalidate or quarantine the older mapping.

### 3. Keep GUID parsing separate from entity typing

Plex officially specifies only the generic `provider://id` shape. A parser should validate shape
without pretending the scheme implies a supported MusicBrainz entity until empirical fixtures
establish that rule:

```ts
const CANONICAL_MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface PlexExternalId {
  readonly provider: string;
  readonly value: string;
  readonly raw: string;
}

function parsePlexExternalId(raw: string): PlexExternalId | undefined {
  const separator = raw.indexOf("://");
  if (separator <= 0) return undefined;
  const provider = raw.slice(0, separator).toLowerCase();
  const value = raw.slice(separator + 3);
  if (!/^[a-z0-9.:-]{1,128}$/.test(provider) || value.length === 0 || value.length > 512) {
    return undefined;
  }
  return Object.freeze({ provider, value, raw });
}

function canonicalMbid(value: string): string | undefined {
  const normalized = value.toLowerCase();
  return CANONICAL_MBID.test(normalized) ? normalized : undefined;
}
```

The provider-to-entity interpretation should be a small, tested registry populated from sanitized
PMS fixtures. UUID shape alone is insufficient to distinguish an artist, release group, release,
recording, or track.

### 4. Use constrained fuzzy matching with a margin

Fuzzy fallback should first narrow candidates by:

- entity kind;
- parent artist exact MBID, or at least parent folded-name equality for albums/tracks;
- release year tolerance where known;
- album type where known;
- track number/medium and duration tolerance for track evidence.

Then score names and require both a floor and a separation from the runner-up:

```ts
interface Scored<T> {
  readonly candidate: T;
  readonly score: number;
}

function resolveUniqueCandidate<T>(
  sourceName: string,
  candidates: readonly T[],
  targetName: (candidate: T) => string,
  compare: (left: string, right: string) => number,
  minScore = 0.9,
  minMargin = 0.08,
): Scored<T> | undefined {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: compare(sourceName, targetName(candidate)) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (best === undefined || best.score < minScore) return undefined;
  const runnerUp = ranked[1]?.score ?? 0;
  return best.score - runnerUp >= minMargin ? best : undefined;
}
```

The numbers above are starting policy values, not upstream contracts. Calibrate them with fixtures
containing punctuation, accents, articles, aliases, collaborations, same-name artists, deluxe
editions, live/remix variants, and deliberate near-collisions. Persist score, margin, normalization
version, and accepted names. Never automatically persist an unreviewed fuzzy result as exact.

### 5. Translate track signals into explicit album expansion evidence

Keep counts dimensionally explicit:

```ts
interface ExpansionEvidence {
  readonly sourceSignalTrackCount: number;
  readonly distinctSourceAlbumCount: number;
  readonly targetAlbumCount: number;
  readonly targetTrackCount: number | "unknown";
  readonly trackExpansionRatio: number | "unknown";
  readonly targetAlbumIds: readonly number[];
  readonly observedAt: string;
}

function expansionRatio(sourceTracks: number, targetTracks: number | "unknown") {
  return targetTracks === "unknown" || sourceTracks === 0 ? "unknown" : targetTracks / sourceTracks;
}
```

For an album-level action, fetch the exact mapped Lidarr albums and album-scoped tracks through the
existing facade. For an artist-level action, enumerate the artist's albums, apply the intended
album policy, then fetch tracks only when a bounded target-track count is needed. Show a prompt such
as:

> 3 Plex tracks across 2 albums support this suggestion. The Lidarr action affects 5 albums and 61
> known tracks (20.3x track expansion). Continue?

Seal the count inputs, target IDs, observation time, cache/live provenance, and policy into any
review artifact. If target tracks are unknown, say so; do not convert unknown to zero. A change
between plan and apply should trigger existing drift/revalidation rules rather than silently
changing the approved expansion.

### 6. Make optional MusicBrainz enrichment paced and cache-first

```ts
let nextMusicBrainzRequestAt = 0;

async function musicBrainzGet(
  path: string,
  applicationVersion: string,
  contactUrl: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const now = Date.now();
  const waitMs = Math.max(0, nextMusicBrainzRequestAt - now);
  if (waitMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
  nextMusicBrainzRequestAt = Date.now() + 1_000;

  const response = await fetch(new URL(path, "https://musicbrainz.org/ws/2/"), {
    headers: {
      Accept: "application/json",
      "User-Agent": `rfmedia/${applicationVersion} (${contactUrl})`,
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`MusicBrainz request failed with HTTP ${response.status}`);
  }
  return response.json();
}
```

Production code should use the repository's injectable clock/sleeper, timeout, bounded parser,
typed errors, retry classification, and single-fetch-owner rules rather than this minimal sketch.
Do not retry `503` in a tight loop. Offline analysis must not call this function.

## Constraints and Gotchas

### Entity semantics

- An MBID's UUID text does not reveal its MusicBrainz entity type.
- Lidarr's `foreignAlbumId` is a release-group MBID. `foreignReleaseId` is a concrete release MBID.
  They are not interchangeable.
- A recording may occur on many release tracks and releases. One recording MBID does not select one
  album.
- Plex `ratingKey`, `guid`, parent fields, and external `Guid[]` have different roles. Preserve
  provenance instead of flattening them into one string.
- Various-artists compilations, featured artists, aliases, and artist credits can make name and
  parent context disagree legitimately.

### Plex capability variability

- `Guid[]` is optional.
- Official Plex documentation does not guarantee MusicBrainz IDs for music libraries.
- GUID coverage may vary by PMS version, legacy versus modern music agent, unmatched items,
  manually matched metadata, and local metadata preference.
- Bulk list responses may omit optional fields that a single-item metadata read contains. Measure
  before choosing a request strategy.
- Do not make direct Plex imports from bridge actions; extend the private adapter capability and
  wire projection.

### Cache semantics

- Cache scope must include PMS identity and Lidarr origin; never include either credential.
- Offline repeatability requires stored source evidence and algorithm version, not just
  Plex-to-Lidarr integer IDs.
- Staleness and correctness are different. A fresh mapping can be wrong after a rematch; an old
  exact MBID mapping can still be useful. Revalidate source fingerprints and report age/method.
- Manual/fuzzy decisions need an invalidation and remap path.
- Conflicting exact MBIDs must quarantine the mapping; fuzzy scoring must not override them.
- Use SQLite uniqueness constraints and transactions so partial refreshes cannot fabricate a
  complete snapshot.

### Matching safety

- Exact folded-name equality is candidate generation, not proof of identity.
- A high score without a runner-up margin is ambiguous.
- Thresholds must be calibrated by entity kind; artist and album names have different collision
  patterns.
- Preserve punctuation/accent/article variants in evidence even if normalization removes them.
- Do not log a line per comparison across large libraries; report bounded top candidates.

### Expansion and UX

- Ratios must compare like units. Prefer target known tracks divided by source signal tracks; show
  target album count separately.
- Lidarr album statistics and track lists are observations, not future download guarantees.
- An album action may affect releases/editions differently under Lidarr's `anyReleaseOk`, metadata
  profile, and monitoring policies.
- Prompt on the reviewed target set and revalidate it before mutation. A mapping feature should not
  bypass the repository's plan/apply safety boundary.

### Freshness

⚠️ **Freshness Note**: Lidarr's current official OpenAPI was generated 2025-10-20. It remains the
current `develop` document and is pinned in this repository, but runtime instances may be older or
newer. Continue strict projection and optional-field tolerance.

MusicBrainz may change throttling rules to protect service health. Treat one request per second as a
maximum, identify the client, and keep rate behavior configurable below that ceiling.

## Code Examples

### Exact artist join

```ts
interface PlexArtistIdentity {
  readonly ratingKey: string;
  readonly title: string;
  readonly artistMbid?: string;
}

interface LidarrArtistIdentity {
  readonly id: number;
  readonly artistName: string;
  readonly foreignArtistId: string;
}

function joinArtistByMbid(plex: PlexArtistIdentity, lidarrByMbid: ReadonlyMap<string, LidarrArtistIdentity>) {
  if (plex.artistMbid === undefined) return undefined;
  const canonical = canonicalMbid(plex.artistMbid);
  if (canonical === undefined) return undefined;
  const lidarr = lidarrByMbid.get(canonical);
  return lidarr === undefined
    ? undefined
    : Object.freeze({ plex, lidarr, entityKind: "artist" as const, method: "exact-guid" as const });
}
```

### Release-to-release-group translation

```ts
interface MusicBrainzReleaseResponse {
  readonly id: string;
  readonly "release-group"?: { readonly id?: string; readonly title?: string };
}

function projectReleaseGroupId(response: MusicBrainzReleaseResponse): string | undefined {
  const releaseGroupId = response["release-group"]?.id;
  return releaseGroupId === undefined ? undefined : canonicalMbid(releaseGroupId);
}
```

Only use this after the Plex evidence has been entity-typed as a **release** MBID. Persist the
release-to-release-group relation so offline analysis does not repeat the call.

### Reviewable fuzzy result

```ts
interface MappingSuggestion<T> {
  readonly status: "exact" | "review-required" | "unresolved";
  readonly candidate?: T;
  readonly score?: number;
  readonly runnerUpScore?: number;
  readonly reasons: readonly string[];
}

function fuzzySuggestion<T>(
  sourceName: string,
  candidates: readonly T[],
  nameOf: (candidate: T) => string,
  compare: (left: string, right: string) => number,
): MappingSuggestion<T> {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: compare(sourceName, nameOf(candidate)) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best === undefined || best.score < 0.9) {
    return { status: "unresolved", reasons: ["No candidate met the configured threshold"] };
  }
  if (runnerUp !== undefined && best.score - runnerUp.score < 0.08) {
    return {
      status: "unresolved",
      score: best.score,
      runnerUpScore: runnerUp.score,
      reasons: ["The best candidate was not sufficiently separated from the runner-up"],
    };
  }
  return {
    status: "review-required",
    candidate: best.candidate,
    score: best.score,
    runnerUpScore: runnerUp?.score,
    reasons: ["Name similarity is not authoritative identity evidence"],
  };
}
```

## Open Questions

1. Which exact external GUID schemes and entity meanings are returned by supported Plex Music
   agent/PMS versions for artists, albums, and tracks? Capture sanitized JSON fixtures from at least
   a modern matched library, an unmatched item, and any supported legacy-agent library.
2. Does the bulk `/library/sections/{id}/all` response include the same `Guid[]` evidence as
   `/library/metadata/{ratingKey}`, or is a bounded second-stage detail fetch required?
3. When Plex exposes an album MusicBrainz ID, is it a release group or a release for each supported
   agent? Never answer this from UUID shape.
4. Is issue #207 artist-only in its first release, or must it resolve album and track identities
   immediately? Artist-first materially reduces ambiguity and network scope.
5. Should direct MusicBrainz access ship now, or should release/release-group translation remain
   unresolved until empirical Plex fixtures prove it is needed?
6. What cache freshness and invalidation policy applies to exact versus reviewed fuzzy mappings?
   Exact MBIDs and name-based decisions should not share one undifferentiated TTL.
7. What user command explicitly reviews, accepts, rejects, remaps, or purges a fuzzy/manual mapping?
8. What score floor and runner-up margin pass a real collision corpus per entity kind? The example
   `0.90`/`0.08` values require calibration and are not external API contracts.
9. What expansion threshold requires confirmation, and how is non-interactive/JSON mode handled?
   A prompt alone is insufficient for automation; the reviewed plan must carry explicit approval.
10. Does the bridge extend `MediaServerAdapter` with an optional identity capability, or use a
    Plex-private bridge port? The latter avoids weakening provider-neutral entity types with Plex
    wire concepts, while the former may better support future media-server adapters.
11. Should mapping evidence reuse the existing `lidarr_metadata_cache` JSON table or receive a
    dedicated normalized table? A dedicated table is preferable because mapping conflicts,
    provenance, manual review, and bidirectional indexes are different from stale response caching.
12. Which source fingerprints define live drift: Plex GUID set and title/parent hierarchy, Lidarr
    typed MBID/name/parent, or both? Specify this before defining cache reuse.

## Source Register

| Source                                                                                                                                                              | Publication/update date               | Use                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Plex Media Server API](https://developer.plex.tv/pms/)                                                                                                             | Last modified 2026-07-15              | PMS auth, headers, pagination, library endpoints, metadata GUID and optional external `Guid[]` contracts |
| [Lidarr v1 OpenAPI, pinned current commit](https://raw.githubusercontent.com/Lidarr/Lidarr/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json) | Generated 2025-10-20                  | Artist, album, album-release, and track resources; endpoints; auth                                       |
| [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API)                                                                                                      | No page date; accessed 2026-07-27     | Root URL, entity operations, JSON, authentication, paging                                                |
| [MusicBrainz rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)                                                                              | Current revision; accessed 2026-07-27 | One-call-per-second policy, User-Agent, `503` behavior                                                   |
| [MusicBrainz Identifier](https://musicbrainz.org/doc/MusicBrainz_Identifier)                                                                                        | No page date; accessed 2026-07-27     | Entity-typed MBID URI semantics                                                                          |
| [MusicBrainz Artist](https://musicbrainz.org/doc/Artist)                                                                                                            | Current revision; accessed 2026-07-27 | Artist identity and aliases/disambiguation                                                               |
| [MusicBrainz Release Group](https://musicbrainz.org/doc/Release_Group)                                                                                              | Current revision; accessed 2026-07-27 | Logical album concept versus concrete releases                                                           |
| [MusicBrainz Release](https://musicbrainz.org/doc/Release)                                                                                                          | Current revision; accessed 2026-07-27 | Edition/release semantics                                                                                |
| [MusicBrainz Recording](https://musicbrainz.org/doc/Recording)                                                                                                      | Current revision; accessed 2026-07-27 | Recording-to-many-release-track relationship                                                             |
