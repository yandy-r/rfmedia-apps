# External API Research: Plex Adapter Refactor

Research date: 2026-07-19

## Executive Summary

Issue #119 is no longer starting from an unabstracted Plex integration. `origin/master` already has a
`MediaServerAdapter`, a `PlexAdapter`, adapter factories, action-level adapter resolution, adapter
mocks, and a direct-import check. The remaining architectural gap is that the boundary is mostly
nominal:

- `PlexAdapter` delegates every operation to the approximately 2,800-line `lib/plex.ts` module.
- The ostensibly generic `types/media-server.ts` imports `PlexTrack`, `PlexAlbum`,
  `PlexQueryOptions`, `PlexCollection`, and `DbPlexQueryResult`.
- Adapter factories and action helpers still import Plex configuration, URL validation, and path
  extraction from `lib/plex.ts`.
- Plex caching is global, reads `getLoadedConfig().plex` directly, and is not owned by an adapter
  instance.
- Authentication is a static string placed in the URL on most requests; there is no stable client
  identifier, token provider, expiry handling, or JWT refresh boundary.
- Capability flags only say whether broad CRUD groups exist. They do not describe Plex's 0-10
  rating scale, smart-list semantics, path-scoped scans, or server-dependent premium features such
  as Sonic Analysis.

The target should therefore be **ownership inversion**, not another action migration: make the Plex
adapter (and private Plex-only modules beneath it) own HTTP, authentication, endpoint paths, wire
DTOs, pagination, rate pacing, caching, and Plex-to-domain mapping. Keep the existing `plex.*`
configuration keys, `rfmedia plex ...` commands, option names, output schemas, and error behavior.
No shell completion change is required for a purely internal refactor; completion templates only
need changes if a later JWT enrollment/refresh command or new option becomes user-facing.

Plex now publishes an official PMS OpenAPI reference. It recommends JSON responses, the
`X-Plex-Token` header, a stable `X-Plex-Client-Identifier`, source/key discovery, explicit
pagination handling, and a PMS API version header. It also documents short-lived JWT authentication
as the recommended model. Those facts reinforce a single request/auth layer inside the adapter,
but they do **not** require changing the current CLI's manually supplied token workflow during this
refactor. A supplied JWT can already be treated as an opaque token and sent through the same header.
[Plex Media Server API reference](https://developer.plex.tv/pms/)

## Primary APIs

### Plex Media Server HTTP API

The PMS API supports XML and JSON, defaults to XML, and recommends that new applications request
JSON using `Accept: application/json`. Most endpoints require a token in the `X-Plex-Token` header;
Plex says `X-Plex-Client-Identifier` is typically required as well. Although `X-Plex-*` values may
also be query parameters, header-based tokens are safer because URLs are routinely logged by
clients, proxies, and error tooling. [Plex PMS API: content types, headers, and authentication](https://developer.plex.tv/pms/)

The current implementation uses these API families:

| Adapter capability       | Current endpoint and method                                                                                                                        | Important official contract                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server identity          | `GET /`                                                                                                                                            | Returns server information including `machineIdentifier`; source URIs use this identifier.                                                                                                                |
| Libraries                | `GET /library/sections`                                                                                                                            | Returns library section keys and types. The modern client guidance prefers discovering provider feature keys from `GET /media/providers` rather than hard-coding paths.                                   |
| Track/album/artist query | `GET /library/sections/{sectionId}/all` with type/filter parameters                                                                                | Current Plex numeric music types are artist `8`, album `9`, and track `10`. The official guide recommends respecting type-pivot keys returned by the server instead of assuming `/all` forever.           |
| Album tracks             | `GET /library/metadata/{id}/children`                                                                                                              | A returned `key` is the server's navigation contract; keys may be root-relative or absolute and must be resolved correctly.                                                                               |
| Pagination               | `X-Plex-Container-Start` and `X-Plex-Container-Size`                                                                                               | Both values should be sent. The response may return a different page size or no pagination; clients must use response `offset`, `size`, and optional `totalSize` rather than assuming the requested size. |
| Library scan             | `GET /library/sections/{id}/refresh`, optionally with `path`; current code also uses `/library/sections/all/refresh`                               | Scan calls are management operations. Preserve current success-result behavior, but keep endpoint construction and permissions inside Plex code.                                                          |
| Rating update            | `PUT /:/rate?identifier=com.plexapp.plugins.library&key=...&rating=...`                                                                            | Plex's wire rating is 0-10 while the CLI presents stars/normalized formats in different workflows. The conversion belongs at the adapter/domain boundary.                                                 |
| Playlists                | `GET/POST /playlists`; `GET/PUT /playlists/{id}/items`; `DELETE /playlists/{id}`                                                                   | Playlist creation and item updates use Plex source URIs containing the server ID and provider ID. Large comma-separated item URIs can hit ordinary URL-length limits.                                     |
| Collections              | `GET /library/sections/{id}/collections`; `GET/DELETE /library/collections/{id}`; `GET .../children`; `POST /library/collections`; `PUT .../items` | Collection subtypes and Plex numeric metadata types are provider-specific. Source-URI construction and batch fallback remain Plex concerns.                                                               |

The official reference defines server source URIs as
`server://{SERVER_ID}/{PROVIDER_ID}/{PATH}` and explicitly warns that returned keys can be relative,
root-relative, absolute HTTPS URLs, or provider-specific keys. The current adapter's
`server://{machineIdentifier}/com.plexapp.plugins.library/...` construction is therefore a Plex
transport detail and should not appear in the generic contract.
[Plex PMS API: paths, keys, types, sources, and pagination](https://developer.plex.tv/pms/)

PMS API versioning is now explicit. Omitting `X-Plex-Pms-Api-Version` requests historical version
`0.0`; version `1.0.0` begins with PMS 1.41.9, with later documented revisions requiring newer PMS
versions. For this no-regression refactor, keep current endpoints and response tolerance first.
Centralizing the header makes a separately tested version opt-in possible later, rather than
silently dropping compatibility with older servers.
[Plex PMS API version history](https://developer.plex.tv/pms/)

### Authentication and JWT migration

Plex documents two authentication models:

1. **JWT authentication (recommended).** New apps can create a strong PIN while registering an
   Ed25519 public JWK, have the user authenticate in the Plex auth app, and exchange the PIN plus a
   device-signed JWT. Existing apps can register a JWK using a legacy token. JWTs expire after seven
   days and can be refreshed even after expiry through a nonce (valid for five minutes), a
   device-signed JWT, and `POST https://clients.plex.tv/api/v2/auth/token`.
2. **Traditional token authentication (legacy).** An app uses a stable client identifier, creates a
   PIN, directs the user to Plex authentication, and polls/exchanges the PIN for an access token.

The JWT is still supplied as `X-Plex-Token`, so current `plex.token` configuration is format-agnostic:
an already-issued legacy token or JWT can use the same field. Full automatic JWT enrollment and
refresh is a materially larger credential-lifecycle feature because it requires durable private-key
storage, a stable client identifier, interactive PIN authorization, refresh persistence, clock
handling, and token redaction. The refactor should introduce a private `PlexTokenProvider` seam and
ship a `StaticTokenProvider` for current behavior. A rotating JWT provider can then be implemented
without changing endpoint methods.
[Plex PMS API: authenticating with Plex and JWT flow](https://developer.plex.tv/pms/)

Plex documents JWT-specific failures including `498` for expiry, `422` for signature/JWT problems,
`400` for malformed requests, and `429` for nonce rate limiting. These should be modeled as typed
Plex authentication errors rather than converted to a generic 401 message. The current static-token
path must retain today's user-facing 401 wording unless the compatibility contract is deliberately
changed.

Plex's support article says the browser-inspected `X-Plex-Token` is temporary and directs real
third-party apps to the app authentication flow. It also describes token invalidation by changing
the account password and signing out connected devices. This is another reason not to encode token
shape or permanence in the generic adapter contract.
[Finding an authentication token / X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)

### Rate limits, pacing, and pricing

- Plex does not publish a numeric PMS request quota in the official API reference. The existing
  100 ms delay is an rfmedia safety policy, not a Plex-guaranteed rate limit. Preserve it until
  measured behavior justifies a change, but implement it once in the request layer rather than
  after every endpoint call.
- The JWT documentation states that nonce requests are rate-limited and can return `429`, but does
  not publish a numeric window. Respect `Retry-After` if present and use bounded backoff; do not
  guess a quota. [Plex JWT authentication](https://developer.plex.tv/pms/)
- The local PMS HTTP API has no separately documented metered API price. Feature availability can
  still depend on product entitlements. Sonic Analysis is explicitly a Plex Pass feature, requires
  PMS 1.24.0 or newer, has platform constraints, and can be CPU-intensive.
  [Sonic Analysis for Music](https://support.plex.tv/articles/sonic-analysis-music/)

## Libraries and SDKs

### Current repository status

`packages/rfmedia-cli` has no Plex client or JWT dependency. It runs on Node.js 22 or newer and uses
built-in `fetch`, `URL`, `URLSearchParams`, and `AbortSignal.timeout`. This is a good fit for the
small, known endpoint surface and avoids translating existing error/pagination semantics through a
second abstraction.

### Plex client options

No official Plex-maintained JavaScript/TypeScript SDK was identified. Plex publishes the official
OpenAPI reference, while the available npm clients are third-party:

| Package                                                                | Registry status on 2026-07-19                                   | Assessment for this issue                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`plex-api`](https://www.npmjs.com/package/plex-api)                   | `5.3.2`; registry metadata last modified 2022-06-24; Node `>=8` | Mature but old, CommonJS-era, and centered on generic URI calls. It does not buy enough over the existing tested implementation and its authentication documentation predates Plex's current JWT guidance.                                                                         |
| [`@ctrl/plex`](https://www.npmjs.com/package/@ctrl/plex)               | `6.1.1`; modified 2026-07-13; ESM; Node `>20`                   | Current TypeScript client, but adopting it would add an unrelated transport migration and require parity proof for playlist, collection, filter, and error edge cases. Re-evaluate only if its endpoint coverage is demonstrated by a spike.                                       |
| [`@parke.dev/plexjs`](https://www.npmjs.com/package/@parke.dev/plexjs) | `0.45.3`; modified 2026-07-15; generated typed client           | Closest to the published OpenAPI surface, but still third-party and generated. It may be valuable for compile-time API exploration, not as a required dependency in this behavior-preserving refactor. The predecessor `@lukehagar/plexjs` is deprecated in favor of this package. |

Recommendation: retain native `fetch`, but structure the private Plex transport around a small
injectable request function so tests do not mock global fetch throughout the feature. The official
OpenAPI should be used as the endpoint/schema reference, with narrow handwritten wire DTOs for only
the fields rfmedia consumes.

### JWT support

Accepting an externally supplied Plex JWT requires no JWT library; it is an opaque bearer value.
If automatic enrollment/refresh becomes in-scope, [`jose`](https://www.npmjs.com/package/jose) is
the strongest current fit: `6.2.3`, ESM, built-in TypeScript declarations, no runtime dependencies,
and support for JWT, JWK, Ed25519/EdDSA, signing, and thumbprints. Node's `crypto` can generate keys,
but hand-implementing JOSE serialization and validation is unnecessary risk.

## Integration Patterns

### 1. Make the generic contract actually generic

`types/media-server.ts` should define domain-facing `MediaTrack`, `MediaAlbum`, `MediaArtist`,
`MediaPlaylist`, `MediaCollection`, query/result, and scan/update result types without importing
`types/plex.ts` or `types/db.ts`. Plex wire fields (`ratingKey`, `grandparentTitle`, numeric type
codes, `Media[].Part[].file`) are mapped privately by `PlexAdapter`.

Do not pass `DbPlexQueryResult` into an adapter. Database-row-to-domain conversion belongs in the
persistence/action layer. File-path extraction can either consume generic `MediaTrack.filePath` or
remain a pure domain helper; it is not a media-server HTTP capability.

```ts
export interface MediaTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  rating?: number; // canonical normalized value, e.g. 0..1
  filePath?: string;
}

export interface RatingCapability {
  readable: boolean;
  writable: boolean;
  wireScale: { min: number; max: number; step: number };
}
```

Plex-specific command/action option types may keep Plex names where they describe the stable
`rfmedia plex` UX. The isolation requirement is that generic adapter consumers and contracts do not
need Plex wire types.

### 2. Separate structural capabilities from runtime availability

Broad booleans (`playlist: true`) are insufficient for cross-server decisions. Describe semantics
such as smart playlists, smart collections, collection item types, path-scoped scan, and rating
scale. Sonic Analysis needs special care: Plex supports it, but availability depends on Plex Pass,
server version/platform, server settings, library settings, and completed analysis. It should not be
an unconditional `true`.

```ts
readonly capabilities = {
  ratings: { readable: true, writable: true, wireScale: { min: 0, max: 10, step: 1 } },
  playlists: { static: true, smart: true },
  collections: { static: true, smart: true },
  scan: { wholeLibrary: true, pathScoped: true },
  sonicAnalysis: { supportedByAdapter: false, availability: "server-dependent" },
} as const;
```

If rfmedia later exposes sonic operations, resolve runtime availability from server/provider data
and entitlements rather than changing a static constant. The official root response includes
server capability/feature information, and the support requirements remain authoritative.

### 3. Centralize request and authentication behavior

All endpoint methods should call one private request function that:

- resolves an opaque token from `PlexTokenProvider`;
- sends `X-Plex-Token` in a header, never in a logged URL;
- sends stable product/version/client-identifier headers;
- requests JSON and applies the 30-second timeout;
- optionally sends a deliberately selected PMS API version;
- maps 401/403/404/414/429/498 and malformed payloads to typed Plex errors;
- applies the existing request pacing and future `Retry-After` handling;
- redacts tokens and authorization material from logs and thrown errors.

```ts
interface PlexTokenProvider {
  getToken(): Promise<string>;
  handleAuthFailure?(status: number): Promise<"retry" | "fail">;
}

async function plexRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await tokenProvider.getToken();
  return requestJson<T>(new URL(path, baseUrl), {
    ...init,
    headers: {
      Accept: "application/json",
      "X-Plex-Client-Identifier": clientIdentifier,
      "X-Plex-Token": token,
      ...init.headers,
    },
  });
}
```

### 4. Put caches inside the adapter lifecycle

Use per-adapter caches keyed by server URL plus resource discriminator, never by token. Preserve the
existing `plex.cache.enabled` and `ttlSeconds` behavior by passing normalized cache configuration to
the constructor. Cache server identity, libraries, playlists, and collection lists where currently
done; keep mutation invalidation in the same Plex repository that performs the mutation. Avoid
reading global loaded config from cache primitives.

### 5. Preserve endpoint behavior before modernizing discovery

The official API advises consuming `/media/providers`, following returned feature/type keys, and
gating management on the `manage` feature. That is a sound future direction, but changing discovery
and completing the ownership refactor simultaneously expands regression risk. First move the
existing known-good endpoints behind the new private transport with parity tests. Then add a
provider-discovery compatibility layer that can fall back to legacy paths for older PMS versions.

### 6. Use a compatibility façade only where needed

Actions already use the adapter. Move Plex implementation tests to the adapter/private modules and
reduce `lib/plex.ts` to temporary deprecated wrappers only for any proven internal imports that
cannot migrate in the same change. Do not leave the adapter calling those wrappers; dependency flow
must be `actions -> MediaServerAdapter -> PlexAdapter -> private Plex transport/mappers`.

## Constraints and Gotchas

- **Token leakage:** most current URLs include `X-Plex-Token`. Header injection must happen below
  logging and cache-key construction. Never include tokens, device JWTs, private JWKs, PINs, or
  nonce payloads in debug output.
- **Stable client identity:** Plex says `X-Plex-Client-Identifier` is typically required. JWT key
  registration also binds issuer/client identity. Generate once and persist it if enrollment is
  implemented; never create a new identifier on every CLI invocation.
- **JWT is not just token parsing:** transparent use of a supplied JWT is easy; automatic refresh is
  stateful credential management. Do not infer JWT mode by decoding an unverified token and do not
  silently overwrite the existing `plex.token` source.
- **Local-first URLs are legitimate:** users commonly configure HTTP LAN URLs. This is a local CLI,
  so an SSRF validator that rejects private addresses cannot replace today's format validation
  without breaking expected Plex use.
- **API version compatibility:** adding `X-Plex-Pms-Api-Version: 1.2.2` would exclude servers older
  than the documented minimum. Preserve version `0.0` behavior until a minimum PMS policy is agreed.
- **Pagination is response-driven:** requested page size is not proof of returned count. Preserve
  `pageItemCount`, `totalSize`, and zero-progress guards to avoid skipped items or infinite loops.
- **Plex query syntax is specialized:** numeric type IDs, dotted rating fields, and operators encoded
  through query parameter names are Plex-only. Keep filter compilation private and retain the
  existing backup client-side filtering until server-version coverage proves it unnecessary.
- **Ratings have multiple scales:** Plex is 0-10, CLI filters display 1-5 stars, file metadata may be
  normalized, percent, stars, or POPM. Convert once at explicit boundaries and test half-star and
  unrated values.
- **Playlist/collection URIs can be very long:** ordinary server/proxy URL limits can produce 414.
  Current playlist PUT behavior may replace rather than append across batches. Preserve tested
  behavior and surface a clear limitation rather than claiming safe arbitrary-size batching.
- **Cache invalidation is part of mutation correctness:** create/add/delete operations must
  invalidate corresponding list/detail entries. A cache hit should not incur the request pacing
  delay.
- **Sonic Analysis is not universally available:** it requires Plex Pass and environment/server
  conditions; it is also CPU-intensive. Never advertise it as a guaranteed generic capability.
- **Completions:** if config and CLI remain unchanged, generated bash/zsh/fish templates should be
  regression-tested but not rewritten. Any new auth subcommand/flag must be added to all three
  templates and their tests in the same change.

## Open Questions

1. **Is full JWT enrollment/refresh required to close #119, or is a token-provider seam plus opaque
   JWT support sufficient?** Recommendation: make opaque JWTs work through header auth now and split
   interactive enrollment, durable key storage, and refresh into a security-focused child issue.
2. **Where should a stable Plex client identifier live?** It must persist across CLI runs without
   leaking secrets. A non-secret state/config directory is appropriate; it should not be regenerated
   per adapter instance.
3. **What is the canonical domain rating representation?** Recommendation: normalized `0..1` in the
   generic model, with Plex 0-10 and CLI/file scales converted at boundaries. Confirm this against
   persisted query/MCP output compatibility before renaming fields.
4. **How much public TypeScript compatibility is required for exported Plex types?** CLI behavior is
   explicitly stable, but the package may have consumers importing `PlexTrack` and related types.
   Keep aliases/deprecations if those exports are considered public.
5. **Should provider discovery be part of #119?** Recommendation: no. Centralize legacy endpoints
   now, then add `/media/providers` discovery and explicit API-version negotiation as a child issue
   with old-PMS fallback tests.
6. **How should runtime feature availability be represented?** Decide whether `capabilities` is only
   structural and a separate async `features()`/`serverInfo()` reports entitlements and server
   state. Avoid mixing static adapter support with premium/runtime availability.
7. **Can `lib/plex.ts` be deleted in one PR?** Current non-test direct imports are limited to adapter,
   adapter helpers/factory, and config validation, so deletion appears feasible if URL validation
   becomes a neutral utility and implementation tests move with the code. Confirm whether any
   external package export depends on this internal path.
