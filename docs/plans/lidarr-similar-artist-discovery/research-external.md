# External API Research: Lidarr Similar-Artist Discovery

Research date: 2026-07-25.

This document uses official Last.fm, Node.js, and Lidarr sources for technical claims. Last.fm does
not publish update dates on its live API pages, so those sources are recorded as undated and
accessed on the research date.

## Executive Summary

Last.fm's `artist.getSimilar` method is a good fit for the read-only half of
`rfmedia lidarr discover --artist "Name"`. It accepts an artist name or MusicBrainz artist ID,
supports server-side autocorrection, returns ranked candidates with a `match` value from 0 to 1,
and requires only an application API key. It does not require a Last.fm user session, API
signature, or shared secret. A single direct request is sufficient for the normal workflow;
`artist.search` is not a prerequisite and should be reserved for an explicit ambiguity-resolution
or interactive-selection flow.

The provider and mutation boundaries should remain separate:

1. Last.fm discovery runs in the repository's `discovery` execution lane and succeeds without a
   Lidarr connection.
2. Default output is read-only and preserves Last.fm attribution, result URLs, source method, seed
   name, corrected seed name when returned, rank, score, and MBID when present.
3. An explicit add operation resolves a selected candidate through Lidarr's
   `GET /api/v1/artist/lookup` first, then submits the Lidarr-produced artist resource to
   `POST /api/v1/artist` with an explicit root folder, quality profile, metadata profile, monitoring
   policy, and search policy. It must not construct a Lidarr add payload directly from Last.fm data.

Native Node.js `fetch`, `URL`, `URLSearchParams`, and `AbortSignal` are preferable to a Last.fm SDK.
The package requires Node.js 22 or newer, where `fetch` is stable, while Last.fm explicitly labels
all tools in its SDK directory unofficial and unsupported. Its listed JavaScript wrapper is
browser-oriented, has no release packages, and was last committed in 2019.

The main non-code constraint is Last.fm's API Terms of Service. The published licence is
non-commercial, requires Last.fm credit and links, limits retained Last.fm data to 100 MB, requires
caching in accordance with response headers, excludes artwork/images from permitted use, and
requires prior contact for commercial or research/academic use. Last.fm publishes no fixed numeric
request quota. Its documentation instead warns against continuously making several calls per
second, reserves discretionary limits, and exposes API error `29` for rate-limit exhaustion.

**Confidence**: High. Endpoint, authentication, response-conversion, attribution, licence, and
Lidarr add contracts are documented in current primary sources. The recommendation to prefer
native `fetch` is also High confidence because it follows the repository's declared Node.js
runtime and Last.fm's explicit lack of a supported SDK. MBID completeness is Medium confidence:
Last.fm says it returns MBIDs "where applicable" but does not publish a completeness guarantee.

> **Freshness note (2026-07-25):** The Last.fm API documentation and Terms of Service are live but
> undated and describe a long-lived API. They can change without a version bump. Recheck the Terms
> of Service, method pages, and live response fixtures immediately before release.

## Primary APIs

### Last.fm service facts

| Item                        | Current official contract                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Provider                    | Last.fm Limited                                                                                                                        |
| API root                    | `https://ws.audioscrobbler.com/2.0/`                                                                                                   |
| Protocol                    | REST-style query parameters; XML by default, JSON with `format=json`                                                                   |
| Character encoding          | UTF-8; use RFC 3986-compliant URL encoding                                                                                             |
| Required request identity   | An identifiable `User-Agent` on every request                                                                                          |
| Application credential      | Last.fm API key in `api_key`                                                                                                           |
| User authentication         | Not required for `artist.getSimilar`, `artist.search`, `artist.getInfo`, or `artist.getCorrection`                                     |
| Price/licence               | Non-commercial licence granted without charge; commercial and research/academic use require prior contact                              |
| Published numeric rate      | None                                                                                                                                   |
| Published usage constraints | Avoid excessive traffic or continuously making several calls per second; comply with discretionary limits; retained data cap is 100 MB |

Primary sources:

- [Last.fm API introduction](https://www.last.fm/api/intro) — undated, accessed 2026-07-25.
- [Last.fm REST request and JSON conversion rules](https://www.last.fm/api/rest) — undated,
  accessed 2026-07-25.
- [Last.fm API Terms of Service](https://www.last.fm/api/tos) — undated, accessed 2026-07-25.
- [Last.fm API account registration](https://www.last.fm/api/account/create) — undated,
  accessed 2026-07-25; requires a Last.fm login.

Although the prose examples on the official pages still display an `http://` API root, the live
service is available over HTTPS. The implementation should hard-code the HTTPS origin and should
not allow configuration to downgrade it.

**Confidence**: High for the documented contract and observed HTTPS service. No fixed numeric
rate-limit claim can be made from official sources.

### Endpoint matrix

| Method                 | Purpose                                     | Required inputs                      | Optional inputs                                       | Response role                             |
| ---------------------- | ------------------------------------------- | ------------------------------------ | ----------------------------------------------------- | ----------------------------------------- |
| `artist.getSimilar`    | Return similar artists ranked by Last.fm    | `api_key`; one of `artist` or `mbid` | `limit`, `autocorrect=0\|1`, `format=json`            | Primary discovery call                    |
| `artist.search`        | Search artists by name, sorted by relevance | `api_key`, `artist`                  | `limit`, `page`, `format=json`                        | Optional explicit seed resolution         |
| `artist.getInfo`       | Return one artist's canonical metadata      | `api_key`; one of `artist` or `mbid` | `autocorrect=0\|1`, `lang`, `username`, `format=json` | Optional seed canonicalization/enrichment |
| `artist.getCorrection` | Return a correction for an artist name      | `api_key`, `artist`                  | `format=json`                                         | Optional explicit correction UI           |

Sources:

- [`artist.getSimilar`](https://www.last.fm/api/show/artist.getSimilar) — undated, accessed
  2026-07-25.
- [`artist.search`](https://www.last.fm/api/show/artist.search) — undated, accessed 2026-07-25.
- [`artist.getInfo`](https://www.last.fm/api/show/artist.getInfo) — undated, accessed 2026-07-25.
- [`artist.getCorrection`](https://www.last.fm/api/show/artist.getCorrection) — undated, accessed
  2026-07-25.

#### `artist.getSimilar`

The normal request is:

```text
GET https://ws.audioscrobbler.com/2.0/
  ?method=artist.getsimilar
  &artist=Cher
  &autocorrect=1
  &limit=25
  &api_key=...
  &format=json
```

The documented artist record contains:

- `name`: Last.fm artist name.
- `mbid`: MusicBrainz artist identifier when Last.fm can supply one.
- `match`: similarity value from `0` to `1`.
- `url`: Last.fm catalogue URL for attribution and drill-through.
- `image`: repeated image elements in the XML model.
- `streamable`: legacy streamability field.

`artist.getSimilar` documents `limit`, but not a default, maximum, offset, or page parameter. The
command should make one bounded request and apply any score threshold locally. It must label
`match` as a Last.fm similarity score, not as a probability or confidence percentage.

`autocorrect=1` lets Last.fm transform a misspelled seed and return the corrected name in the
response. Preserve both the operator's requested seed and the provider-resolved seed. Silent
replacement makes audit output and later add decisions difficult to explain.

**Confidence**: High for parameters and score semantics. Medium for MBID availability because the
official API shows MBIDs but guarantees them only "where applicable" in an
[official Last.fm MBID announcement](https://blog.last.fm/2011/11/24/the-brainz-are-back-in-town)
dated 2011-11-24.

#### `artist.search`

`artist.search` accepts only a name for the search key and supports `limit` plus `page`. Results are
sorted by Last.fm relevance and may contain `name`, `mbid`, `url`, images, and streamability data.
The method does not document disambiguation fields or an exact-match guarantee.

It should not run before every discovery request:

- `artist.getSimilar` already accepts the seed name and supports `autocorrect`.
- Search adds latency and consumes an additional request from an unspecified quota.
- Automatically taking result zero converts a relevance ranking into an undocumented identity
  decision.

Use it only when the product explicitly exposes multiple seed candidates and asks the operator to
select one, or when a strict resolution mode is requested. If used, persist the selected provider
name and MBID into the subsequent `artist.getSimilar` request rather than re-running a name-only
guess.

**Confidence**: High. This follows the two official method contracts without assuming undocumented
ranking guarantees.

#### `artist.getInfo` and `artist.getCorrection`

`artist.getInfo` is useful when the command needs a separate canonical seed object before
discovery. It accepts the same name-or-MBID pattern and `autocorrect` switch as
`artist.getSimilar`. It is not necessary merely to fetch recommendations.

`artist.getCorrection` is narrower: it maps a supplied name to a corrected canonical artist record
with name, MBID, and URL. It costs another request and does not replace interactive disambiguation.
Prefer the built-in `artist.getSimilar&autocorrect=1` behavior for the default command, then expose
the correction in output. Add a separate correction request only if the UI needs correction
preview before discovery.

**Confidence**: High.

### Authentication and credential handling

All four read methods require an API key but state that they do not require authentication. In
Last.fm terminology this means:

- Send the application `api_key`.
- Do not send `sk`, `api_sig`, or the shared API secret.
- Do not implement Last.fm web/mobile user authorization for issue #203.

Last.fm requires the API key as a request parameter, so it will exist in the constructed URL even
over HTTPS. The adapter must never log the full URL, include it in error messages, store it in cache
keys, or emit it in debug output. Configuration should accept a templated/environment-provided
`LASTFM_API_KEY`; the key should not be a required Lidarr configuration field because read-only
discovery is independent of Lidarr.

**Confidence**: High. The method pages explicitly separate `api_key` from user authentication, and
the repository already has secret-template and URL-redaction patterns.

### JSON response and error formats

Last.fm returns XML by default. With `format=json`, repeated XML children become JSON arrays,
element children become object members, XML attributes become string member values, and values
remain strings unless the adapter parses them. Therefore:

- Parse `match` with finite-number and `0..1` validation.
- Treat an empty or malformed `mbid` as absent.
- Accept zero, one, or many artist elements defensively even if ordinary JSON responses use an
  array.
- Reject a malformed success envelope instead of returning partial untyped data.

REST failures include an API error code and message. The relevant documented codes are:

| Code                    | Meaning                                                  | Recommended treatment                                               |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `2`, `3`, `5`, `6`, `7` | Invalid service, method, format, parameters, or resource | Permanent request/input failure                                     |
| `4`, `9`, `10`, `13`    | Permission, session, API-key, or signature failure       | Permanent configuration/auth failure                                |
| `8`                     | Generic operation failure                                | Fail; retry only if a shared policy explicitly classifies it        |
| `11`, `16`              | Service offline or temporary processing failure          | Retryable within the discovery lane                                 |
| `26`                    | Suspended API key                                        | Permanent configuration failure                                     |
| `29`                    | Rate limit exceeded                                      | Retryable only with bounded backoff; honor `Retry-After` if present |

Do not rely on HTTP status alone. Parse an `{ error, message }` payload on every response and also
handle non-success HTTP status, invalid JSON, transport timeout, DNS/TLS failure, and cancellation.

**Confidence**: High for codes and response conversion. Medium for retry treatment because Last.fm
documents meanings but does not prescribe client retry algorithms or a `Retry-After` contract.

### Rate limits, caching, and pricing

Last.fm does not publish a numeric requests-per-second quota. The official introduction asks
clients to be reasonable and warns that an account can be suspended for continuously making
several calls per second or excessive calls. The Terms of Service says limits are set at Last.fm's
discretion and must not be circumvented.

Consequences for this command:

- One seed should normally produce exactly one Last.fm request.
- Reuse the repository's bounded `discovery` lane, timeout, cancellation, retry, and circuit-breaker
  machinery.
- Keep retries limited to temporary failures and rate limiting; never retry bad keys or bad input.
- Respect cache headers. If a persistent provider cache is introduced, include provider, method,
  normalized seed or MBID, autocorrect mode, and limit in the key.
- Do not promise a request rate or availability SLA in documentation.

The published licence is granted without charge for non-commercial use. It is not a conventional
free pricing tier: commercial use requires a separate agreement, and research/academic use
requires contacting Last.fm before use. Downstream commercial users of the open-source CLI must
make their own agreement rather than relying on the project's API key or licence position.

**Confidence**: High.

## Libraries and SDKs

### Recommended: native Node.js transport

Use the Node.js platform APIs already available to the package:

- `fetch` for HTTPS.
- `URL` and `URLSearchParams` for RFC 3986-compatible encoding.
- `AbortSignal` for scheduler cancellation and timeouts.
- Small local TypeScript interfaces plus explicit runtime validation for Last.fm's JSON.

The package declares `node >=22.0.0`. Node.js documents global `fetch` as stable and browser
compatible in the
[Node.js 22.15.0 globals documentation](https://nodejs.org/download/release/v22.15.0/docs/api/globals.html)
([released 2025-04-23](https://nodejs.org/en/blog/release/v22.15.0)). A one-endpoint read adapter
does not justify another HTTP stack or a Last.fm-specific dependency.

**Confidence**: High.

### Last.fm-listed JavaScript wrapper

Last.fm's [API Tools page](https://www.last.fm/api/downloads) explicitly labels every listed tool
unofficial and unsupported. Its JavaScript entry points to
[`fxb/javascript-last.fm-api`](https://github.com/fxb/javascript-last.fm-api), a browser-oriented
wrapper that:

- depends on callback-style APIs and optional `localStorage` caching;
- has no published GitHub releases or packages;
- exposes write/authentication features not needed here;
- was last committed on
  [2019-12-09](https://github.com/fxb/javascript-last.fm-api/commit/803cc958f248312beffe12f548163a07d53b4d5b).

It should not be added to a Node.js 22 ESM CLI.

**Confidence**: High. Last.fm itself disclaims support, and the linked primary repository provides
the maintenance evidence.

### Other npm wrappers

Community Node.js wrappers such as
[`feross/last-fm`](https://github.com/feross/last-fm) cover `artist.getSimilar`, but they are not
official Last.fm SDKs and add their own naming, callback, parsing, and maintenance contracts. They
provide little value for a single GET endpoint and would still require local validation, redaction,
retry, attribution, and scheduler integration.

No Last.fm SDK should be introduced for issue #203. Revisit only if later federated-provider work
needs a broad Last.fm surface and a maintained library demonstrably reduces total code and risk.

**Confidence**: Medium. This is an engineering recommendation based on current scope rather than a
provider mandate.

### Existing Lidarr SDK

The repository's generated private Lidarr client already contains:

- `getApiV1ArtistLookup` for `GET /api/v1/artist/lookup?term=...`;
- `getApiV1Artist` for local `GET /api/v1/artist?mbId=...`;
- `postApiV1Artist` for `POST /api/v1/artist`;
- `ArtistResourceWritable` and `AddArtistOptions`.

These derive from Lidarr's
[official OpenAPI document](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/openapi.json).
Extend the stable `LidarrClientApi` facade for add behavior; do not import the generated module from
the action or add another Lidarr library.

**Confidence**: High. This was verified against the pinned generated code and official upstream
OpenAPI source on 2026-07-25.

## Integration Patterns

### Pattern 1: direct, read-only discovery

Recommended flow:

1. Validate and trim `--artist`; preserve its display spelling.
2. Call `artist.getSimilar` once with `autocorrect=1`, an explicit bounded `limit`, JSON format, and
   an identifiable `User-Agent`.
3. Validate the complete envelope.
4. Preserve provider order as rank; normalize the score to a number only after validation.
5. Deduplicate by non-empty MBID first, otherwise by a conservative normalized name key. Keep the
   first, highest-ranked occurrence.
6. Return results without contacting Lidarr.

The result contract should make provenance first class:

```typescript
interface SimilarArtistCandidate {
  readonly rank: number;
  readonly name: string;
  readonly mbid?: string;
  readonly similarity: number;
  readonly provider: "lastfm";
  readonly providerMethod: "artist.getSimilar";
  readonly providerUrl: string;
}
```

The enclosing result should include requested seed, resolved seed, whether autocorrection occurred,
request limit, returned count, source label, and execution metadata. Human output should show
`Source: Last.fm` and the Last.fm link; machine output should retain the source fields on every
candidate or in a non-lossy shared source object.

This is both useful provenance and a Terms of Service requirement: Last.fm requires credit and
links when its data is displayed. The current terms specifically describe a "powered by
AudioScrobbler" button for public pages. A terminal cannot reproduce that web placement exactly,
so text credit plus the returned catalogue link is a minimum implementation, not a confirmed legal
substitute; confirm CLI attribution with Last.fm before release.

**Confidence**: High.

### Pattern 2: optional seed resolution

Do not add `artist.search` to the default request path. If ambiguity handling is required, make it
an explicit state transition:

```text
name input
  -> artist.search
  -> user selects one candidate
  -> artist.getSimilar with selected MBID when available
```

Never silently choose the first search result. If the selected search result has no usable MBID,
call `artist.getSimilar` with its exact returned name and retain that name as the provider-resolved
seed.

For non-interactive automation, the safer default is direct autocorrected discovery plus transparent
reporting. A strict mode can fail if Last.fm changes the seed name, forcing the caller to provide an
MBID or approve a candidate.

**Confidence**: High for the API sequence; Medium for whether issue #203 needs a strict or
interactive mode, which is a product decision.

### Pattern 3: resolve a discovery candidate into Lidarr

The Last.fm result is a recommendation, not a valid Lidarr add resource. Resolve only selected
candidates:

1. If `mbid` is a valid UUID, call Lidarr artist lookup with `term=mbid:<MBID>`.
2. Require a result whose `foreignArtistId`/`mbId` equals that MBID.
3. If MBID is absent, call Lidarr lookup with the candidate name and accept only one normalized
   exact-name match. Report zero or multiple exact matches as unresolved/ambiguous.
4. Check `GET /api/v1/artist?mbId=<MBID>` or the lookup projection to detect an artist already in
   the local library.
5. Use the Lidarr-returned artist resource as the base for any add payload.

The repository already documents and implements `mbid:<UUID>` as an exact Lidarr lookup term in
[Lidarr Search and Lookup](../../../packages/rfmedia-cli/docs/features/lidarr-search-lookup.md).
MBID-first resolution is materially safer than cross-provider fuzzy name matching.

If Last.fm omits an MBID, do not invent one or send the Last.fm name straight to `POST /artist`.
Report the candidate as discoverable but not safely addable if Lidarr cannot resolve it uniquely.

**Confidence**: High for MBID-first and Lidarr lookup behavior; Medium for the exact fallback-name
normalization policy, which must be specified and tested locally.

### Pattern 4: explicit add-to-Lidarr phase

Lidarr's official
[`ArtistController`](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/Artist/ArtistController.cs)
validates artist name, foreign artist ID, profiles, and either a path or root folder. Its
`POST /api/v1/artist` operation consumes an `ArtistResource`; the generated resource additionally
supports `AddArtistOptions`.

An add therefore needs an explicit policy envelope:

- selected candidate identity;
- `rootFolderPath` or a fully validated `path`;
- `qualityProfileId`;
- `metadataProfileId`;
- `monitored` and `monitorNewItems`;
- album monitoring mode;
- whether Lidarr should immediately search for missing albums;
- tags, if supported by the command.

Recommended safety behavior:

- Bare `discover` is always read-only.
- `--add` is the only mutation opt-in for this issue, and it applies only to explicitly selected
  candidates, never every returned recommendation by default.
- Render the resolved Lidarr artist and effective monitoring/search policy before mutation.
- Machine formats never prompt; require all consent and policy flags up front.
- Recheck local existence immediately before POST.
- Treat "already present" as a distinct idempotent outcome.
- Report per-candidate outcomes if multiple explicit selections are supported.
- Never automatically search for all missing albums unless the operator explicitly requests that
  potentially expensive follow-on action.

Discovery and add should not be wrapped in one scheduler task. The Last.fm GET belongs to
`discovery`; Lidarr lookup/add is metadata-dependent and should use the existing Lidarr health,
resilience, and credential boundaries. Preserve the discovery result even if the optional Lidarr
phase fails.

**Confidence**: High for the API and lane boundary. Medium for exact CLI consent syntax pending the
issue's product specification and the safety-control follow-up in issue #205.

### Pattern 5: source attribution and data minimization

Minimum useful human attribution:

```text
Source: Last.fm (artist.getSimilar)
Seed: Guns and Roses -> Guns N' Roses
```

Each candidate should retain the provider `url` returned by Last.fm. For CSV, include `Source` and
`Source URL`; for JSON/YAML include a stable provider ID, method, and URL.

For web or HTML output, follow Last.fm's required powered-by asset/link and Brand Guidelines rather
than inventing a new mark. For terminal-only output, confirm an acceptable text equivalent with
Last.fm because the published Terms describe web-page button placement, not CLI presentation.

Do not ingest or display Last.fm image URLs in this command. Although the method response contains
image elements, clause 5.1.8 of the current API Terms excludes audio, audiovisual, images, and
artwork from the agreement. Names, scores, MBIDs, and catalogue links are sufficient for a terminal
discovery workflow.

Avoid retaining full upstream envelopes. Store only normalized fields needed for cache/retry or
output, follow response cache headers, and include provider/version metadata so cached data never
masquerades as live Lidarr state.

**Confidence**: High for attribution and image exclusion. Medium for any future persistent-cache
retention duration because Last.fm delegates it to response headers rather than publishing a fixed
TTL.

## Constraints and Gotchas

### Identity and matching

- A Last.fm name is not a durable cross-provider identifier. Prefer a valid MBID.
- Last.fm returns MBIDs only where applicable; missing or empty values must remain absent.
- A similarity score measures Last.fm similarity, not identity. Never use it to validate that a
  Lidarr lookup result is the same artist.
- `artist.search` relevance order is not an exact-match or identity guarantee.
- Autocorrection can materially change the seed. Surface it and preserve both names.
- Same-name artists can remain ambiguous even after name normalization. Fail closed before add.

**Confidence**: High except MBID completeness, which is Medium.

### Pagination and result limits

- `artist.getSimilar` has `limit` but no documented pagination.
- Last.fm does not document a default or maximum for that method.
- `artist.search` has `page` and `limit`, but using it for every discovery would multiply calls.
- Choose and document a conservative application maximum; reject excessive values locally rather
  than probing provider limits.

**Confidence**: High for the absence of documented controls. Low for any numeric cap until a live
key is used to characterize current behavior or Last.fm publishes one.

### Availability and retries

- Error `11` and `16` explicitly describe temporary service failure.
- Error `29` identifies provider throttling, but no retry delay is documented.
- Timeout and cancellation must terminate `fetch`; queued work should not begin after abort.
- Bounded retry must not turn one CLI command into sustained several-calls-per-second traffic.
- Do not retry API-key, permission, malformed-request, or suspended-key errors.

**Confidence**: High for error meanings; Medium for the retry policy.

### Terms and distribution

- Last.fm credit and links are mandatory when using returned data.
- The published attribution clause specifies a powered-by button and catalogue links for public
  pages; the acceptable terminal equivalent is not documented.
- The normal licence is non-commercial and without charge.
- Commercial and research/academic use require prior contact with Last.fm.
- Retained Last.fm data may not exceed the 100 MB reasonable-usage cap.
- Caching must follow web-service response headers.
- Data may not be sublicensed, and artwork/images are excluded.
- Last.fm may suspend access, change available data, or terminate the agreement.

This document is technical research, not legal advice. The project should require each installation
to provide its own API key and should not ship a shared project key.

**Confidence**: High. All points are explicit in the current official Terms of Service.

### Repository-specific integration constraints

- `packages/rfmedia-cli` is Node.js 22 ESM; native `fetch` is available.
- Existing Lidarr search/lookup is read-only and metadata-dependent; it intentionally does not call
  Last.fm.
- `packages/rfmedia-cli/src/lib/lidarr/tiers.ts` already defines external APIs such as Last.fm as
  `discovery`.
- The default discovery scheduler policy currently allows concurrency `4`, operation budget `100`,
  and two retries. A single-call command fits, but implementation should not infer that Last.fm
  permits four calls per second.
- The generated Lidarr client is private behind the stable facade.
- A Last.fm adapter should not inherit Lidarr base URL, API key, circuit namespace, cache key, or
  health gate.
- Optional add must cross into the metadata-dependent Lidarr boundary only after explicit consent.

**Confidence**: High. These claims come from the current worktree.

### Source freshness

| Source                                                          | Publication/update signal                                 | Freshness assessment                                       |
| --------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Last.fm API introduction, REST guide, methods, API Tools, Terms | No page date; accessed 2026-07-25; footer current to 2026 | Live primary source, but undated                           |
| Last.fm MBID announcement                                       | 2011-11-24                                                | Old; use only for the limited "where applicable" statement |
| Node.js 22.15.0 globals                                         | Node.js 22.15.0, released 2025-04-23                      | Current for the repository's declared major runtime        |
| Lidarr `develop` OpenAPI/controllers                            | Live `develop` branch, accessed 2026-07-25                | Current upstream primary source; mutable branch            |
| Repository generated client and lane policy                     | Worktree inspected 2026-07-25                             | Current for issue #203                                     |

## Code Examples

### Minimal native Last.fm adapter

This example illustrates transport, redaction, envelope validation, and numeric conversion. The
production implementation should use the repository's typed error, timeout, retry, circuit, and
scheduler abstractions.

```typescript
const LASTFM_ORIGIN = "https://ws.audioscrobbler.com/2.0/";

interface LastFmApiError {
  readonly error: number;
  readonly message: string;
}

interface LastFmSimilarArtist {
  readonly name: string;
  readonly mbid?: string;
  readonly match: number;
  readonly url: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseArtist(value: unknown): LastFmSimilarArtist {
  const item = record(value);
  const name = nonEmptyString(item?.["name"]);
  const url = nonEmptyString(item?.["url"]);
  const mbid = nonEmptyString(item?.["mbid"]);
  const match = Number(item?.["match"]);

  if (!name || !url || !Number.isFinite(match) || match < 0 || match > 1) {
    throw new Error("Last.fm returned an invalid similar-artist record");
  }

  return {
    name,
    url,
    match,
    ...(mbid ? { mbid } : {}),
  };
}

export async function getSimilarArtists(options: {
  readonly artist: string;
  readonly apiKey: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}): Promise<readonly LastFmSimilarArtist[]> {
  const url = new URL(LASTFM_ORIGIN);
  url.search = new URLSearchParams({
    method: "artist.getsimilar",
    artist: options.artist,
    autocorrect: "1",
    limit: String(options.limit),
    api_key: options.apiKey,
    format: "json",
  }).toString();

  // Never attach `url.href` to logs/errors: it contains api_key.
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "rfmedia/<version> (https://github.com/yandy-r/rfmedia-apps)",
    },
    signal: options.signal,
  });

  const payload: unknown = await response.json();
  const envelope = record(payload);
  if (typeof envelope?.["error"] === "number") {
    const failure: LastFmApiError = {
      error: envelope["error"],
      message: nonEmptyString(envelope["message"]) ?? "Last.fm request failed",
    };
    throw new Error(`Last.fm API error ${failure.error}: ${failure.message}`);
  }

  if (!response.ok) {
    throw new Error(`Last.fm request failed with HTTP ${response.status}`);
  }

  const similar = record(envelope?.["similarartists"]);
  const raw = similar?.["artist"];
  const artists = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return artists.map(parseArtist);
}
```

The production error must carry a safe provider operation and status/code, not the credential-bearing
URL. It should also validate integer API error codes and limit response size before parsing.

### Candidate-to-Lidarr resolution sketch

```typescript
async function resolveCandidate(
  lidarr: LidarrClientApi,
  candidate: SimilarArtistCandidate,
): Promise<LidarrSearchCandidateInput> {
  const term = candidate.mbid ? `mbid:${candidate.mbid}` : candidate.name;
  const matches = await lidarr.lookupArtists({ mode: "artist", term });

  if (candidate.mbid) {
    const exact = matches.filter((item) => item.foreignId.toLowerCase() === candidate.mbid!.toLowerCase());
    if (exact.length !== 1) throw new Error("Lidarr did not resolve the Last.fm MBID uniquely");
    return exact[0]!;
  }

  const exactByName = matches.filter((item) => normalizeArtistName(item.name) === normalizeArtistName(candidate.name));
  if (exactByName.length !== 1) {
    throw new Error("Lidarr did not resolve the Last.fm artist name uniquely");
  }
  return exactByName[0]!;
}
```

`normalizeArtistName` must be a documented conservative equality normalization, not fuzzy matching.
The actual facade projection may need an additive method that retains the complete
`ArtistResourceWritable` required for add; do not widen the public read projection accidentally.

### Lidarr add payload sketch

```typescript
const body: ArtistResourceWritable = {
  ...lidarrLookupResource,
  rootFolderPath: policy.rootFolderPath,
  qualityProfileId: policy.qualityProfileId,
  metadataProfileId: policy.metadataProfileId,
  monitored: policy.monitored,
  monitorNewItems: policy.monitorNewItems,
  tags: policy.tags,
  addOptions: {
    monitor: policy.albumMonitor,
    monitored: policy.monitored,
    searchForMissingAlbums: policy.searchForMissingAlbums,
  },
};

await lidarr.addArtist(body);
```

The `lidarrLookupResource` must come from Lidarr lookup, not from the Last.fm candidate. Validate all
policy IDs and paths before POST, then recheck local presence by MBID immediately before mutation.

## Open Questions

1. Where should `LASTFM_API_KEY` live in the public configuration schema, and should a
   `--lastfm-api-key` override be omitted to reduce shell-history exposure?
2. Will every installation use its own Last.fm API key, and what user-facing notice records the
   non-commercial licence and commercial/research contact requirement?
3. What local maximum should `--limit` enforce? Last.fm publishes no `artist.getSimilar` maximum.
4. Should the default use `autocorrect=1`, or should a strict mode reject any corrected seed until
   the operator approves it?
5. Is interactive `artist.search` seed selection part of issue #203, or should ambiguity
   resolution be deferred?
6. What exact equality normalization is allowed for name-only Lidarr fallback, and should
   name-only candidates simply be ineligible for non-interactive add?
7. Does `--add` accept one rank/MBID, a comma-separated explicit selection, or a reviewed artifact?
   It should not mean "add every result."
8. Which root folder, quality profile, metadata profile, monitoring mode, and tag defaults are safe,
   and may config defaults satisfy explicit add policy?
9. Should `--add` be implemented now as a direct explicit step, or should mutation wait for the
   preview/quarantine contract in issue #205?
10. Should discovery cache Last.fm responses? If so, what response cache headers are observed with a
    real key, what maximum body size is accepted, and how is the 100 MB cap enforced?
11. What identifiable `User-Agent` version/contact format will be stable for packaged builds?
12. Should source attribution be repeated per row in CSV or represented once in JSON/YAML plus a
    per-candidate URL, and will Last.fm approve a terminal text equivalent to its powered-by button?
13. How should API error `8` be classified after live fixtures: retryable operation failure or
    terminal provider error?
14. Are Last.fm catalogue URLs safe to emit exactly as returned, or should the adapter require
    HTTPS and reject/downgrade legacy `http://` values?
15. Does the add facade return "already present" idempotently, or should the action own the
    preflight/revalidation sequence?
