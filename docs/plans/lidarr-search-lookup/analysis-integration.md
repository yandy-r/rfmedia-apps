# Integration Analysis: Lidarr Search and Lookup

## Executive Summary

Issue #222 should extend the existing Lidarr boundary rather than create a parallel client stack.
Three read-only command paths map to three generated operations already present in the pinned SDK:
`lidarr search <term>` uses combined search, while `lidarr lookup artist <term>` and
`lidarr lookup album <term>` use typed lookups. One mode-parameterized action should validate the
query, run one idempotent task in the `metadata-dependent` lane, preserve upstream relevance order,
deduplicate/rank the complete strict projection, cache that complete set, and only then apply local
`offset`/`limit` slicing.

The main integration gap is composition: gated scheduler calls require a preflight, but the current
required-client resolver returns only a resilience-decorated facade whose gated methods also run
`ensureTierHealthy`. Add one execution-context resolver that creates the raw facade, canonical
origin, shared persisted breakers, live resilient facade, scheduler preflight, full-projection
cache writer, and exact-query terminal fallback together. The scheduler must own preflight, live
retries, and terminal-fallback timing; the live wrapper disables its internal gate, retries, and
stale serving while retaining breaker feedback.

## API Endpoints

| CLI mode | Lidarr route                         | Generated call                              | Success wire shape |
| -------- | ------------------------------------ | ------------------------------------------- | ------------------ |
| `search` | `GET /api/v1/search?term=...`        | `getApiV1Search({ query: { term } })`       | `SearchResource[]` |
| `artist` | `GET /api/v1/artist/lookup?term=...` | `getApiV1ArtistLookup({ query: { term } })` | `ArtistResource[]` |
| `album`  | `GET /api/v1/album/lookup?term=...`  | `getApiV1AlbumLookup({ query: { term } })`  | `AlbumResource[]`  |

- All three operations are already generated from `openapi/lidarr-v1.json`; they are unpaginated,
  declare only an optional `term`, and return one array. The CLI must require and validate the term,
  and `--limit`/`--offset` must remain client-side only.
- Add explicit `search`, `lookupArtists`, and `lookupAlbums` methods to `LidarrClientApi` and
  `LidarrClient`. Only `lib/lidarr/client.ts` may import the generated functions, pass the caller
  `AbortSignal`, unwrap generated envelopes, and invoke strict projectors from `types.ts`.
- Combined `SearchResource.id` is response-local and must be ignored as durable identity. Require
  exactly one valid artist/album branch and use `(kind, foreignId)` as identity. Typed lookup
  projections must allow absent positive local Lidarr IDs.
- Extend `scripts/generate-lidarr-client.mjs` `REQUIRED_OPERATIONS`/`REQUIRED_ENDPOINTS` and
  `generated-contract.test.ts` so regeneration fails closed if any operation, path, method, query
  serialization, or response envelope drifts. Generated files remain unedited and private.
- The existing transport remains the sole Fetch owner: canonical same-origin requests,
  header-only `X-Api-Key`, redirect rejection, timeout/abort composition, bounded bodies, fatal
  UTF-8 decoding, and redacted errors all remain unchanged.

## Database

Reuse the schema-v10 `lidarr_metadata_cache` table. It already has unconstrained `TEXT` columns for
`category` and `discriminator` plus `UNIQUE(origin, category, discriminator)`, so supporting search
keys requires TypeScript/cache plumbing only: **no table change, schema-version bump, or migration
is required**.

- Prefer category `lookup` with discriminator
  `v1:<mode>:<sha256(NFC-normalized-term)>`; the canonical credential-free Lidarr origin remains the
  other isolation dimension. Do not include the API key, cleartext term, offset, or limit.
- Extend `LidarrCacheCategory`, and update cache/resilience calls to pass a discriminator instead of
  the current whole-list `""` constant. `metadata-cache.ts` must remain the sole SQL CRUD owner.
- Cache the complete validated, first-win deduplicated, pre-page projection, including valid empty
  arrays. Revalidate cached JSON before serving; corruption, expiry, wrong origin/mode/version, or
  database failure is a miss and must not replace the live result or original typed failure.
- Reuse the resolved 900-second TTL and 86,400-second stale ceiling; zero disables caching.
  Live Lidarr is always attempted first, and cache serving always requires `--allow-stale`.

## External Services

The only live network dependency is the configured local Lidarr instance. Lidarr delegates these
routes to its hosted metadata service, so all three operations belong to the
`metadata-dependent` tier (`requiresHealthGate: true`, `metadataServerRequired: true`). Do not add
direct MusicBrainz, Last.fm, ListenBrainz, another HTTP client, or a new runtime dependency.

Failure handling must preserve the existing typed taxonomy:

- `metadata-provider-unavailable`: created only by health/metadata-circuit evidence; feed the
  metadata breaker, do not retry in place, and allow stale fallback with consent.
- `lidarr-unreachable` and `timeout`: feed the Lidarr breaker; scheduler retry policy may apply;
  stale fallback is eligible after attempts are exhausted.
- `rate-limited`: preserve status and `Retry-After`; scheduler may wait within its cap, but stale
  fallback is forbidden.
- `validation`, `configuration`, `authentication`, `authorization`, `not-found`,
  `invalid-response`, and caller cancellation: fail immediately and never fall back.
- `200 []` and offset beyond total are successful empty results. Malformed, ambiguous, unsafe, or
  over-1,000-record responses fail atomically as `invalid-response`, with no partial output or
  cache write.

## Integration Points

1. **Domain and facade:** add generated-independent query/candidate/result types in
   `src/types/lidarr.ts`; add strict search/lookup projectors in `lib/lidarr/types.ts`; extend the
   facade, typed mocks, resilience method map, retry allowlist, generator gates, and focused tests.
2. **Execution context:** add `resolveRequiredLidarrExecutionContext()` in `lib/lidarr/index.ts`
   returning `{ client, preflight, writeLookupCache, tryServeStale }` built from one raw facade,
   canonical origin, resolved policy, and shared SQLite-backed `lidarr`/`metadata` breakers.
   Preserve `resolveRequiredLidarrClient()` as a compatibility wrapper.
3. **Action:** create `actions/lidarr/search.ts`, export `TIER = "metadata-dependent"`, and call
   `scheduler.runSingle` with the preflight, signal, and a typed terminal fallback. Each live task
   attempt shapes and non-fatally caches the complete projection; the fallback reads once only
   after preflight rejection or retry exhaustion. Pass the scheduler signal to the selected facade
   method.
4. **Pure shaping:** create `lib/lidarr/search.ts` for trim/NFC/control/size validation, exact-ID
   canonicalization, versioned hashed discriminator, stable first-win dedupe, one-based rank, and
   local page metadata. Validate before client or cache I/O.
5. **CLI:** register `search <term>` plus `lookup artist <term>` and `lookup album <term>` under the
   existing exported `lidarrCommand`; lazy-import the shared action, parse `--limit` (1–200),
   `--offset`, `--allow-stale`, URL/key overrides, and use command IDs `lidarr-search`,
   `lidarr-lookup-artist`, and `lidarr-lookup-album`.
6. **Output and failure wiring:** reuse `isMachineFormat`, `formatOutput`,
   `reportLidarrFailure`, and execution summaries. Human tables and warnings go to stderr; machine
   output alone goes to stdout. Use the existing `{ command, result }` envelope and a dedicated flat
   CSV summary-plus-candidate projection so empty results retain paging/provenance.
7. **Registration parity:** export the action from `actions/lidarr/index.ts`; the root CLI already
   registers `lidarrCommand`. Update Bash, Zsh, and Fish static templates plus
   `templates.spec.ts` for both nested paths and every shared option; never perform network-backed
   completion.
