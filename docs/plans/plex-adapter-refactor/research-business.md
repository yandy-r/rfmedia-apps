# Business Analysis: Plex Adapter Refactor

## Executive Summary

GitHub issue #119 is a risk-reduction refactor, not a new user-facing Plex feature. Its business
value is that existing Plex users keep the workflows they rely on while Plex-specific volatility
(API shapes, authentication changes, rating semantics, caching, and optional features) is confined
to one adapter. That boundary is also the architecture gate for future media-server integrations,
including OpenSubsonic/Navidrome issue #118 and the adapter-dependent work identified in
`ROADMAP.md`.

The prerequisite from issue #117 is already substantially present on current `origin/master`:

- `MediaServerAdapter` and capability groups exist.
- `PlexAdapter` exists and is constructed through a shared factory.
- Thirteen action modules resolve an adapter rather than directly importing `lib/plex.ts`.
- Required and optional adapter modes preserve the distinction between mandatory Plex operations
  and best-effort post-operation scans.
- A repository check prevents those migrated actions from reintroducing a direct `lib/plex.ts`
  import.

Issue #119 is not complete, however. `PlexAdapter` is currently a 124-line delegation wrapper over
the 2,874-line `lib/plex.ts`. The latter still constructs every Plex URL, sends approximately twenty
direct HTTP requests, adds `X-Plex-Token`, parses Plex `MediaContainer` responses, applies Plex type
codes and rating rules, rate-limits requests, manages cache invalidation, and handles most errors.
The cache is a separate global module that reads loaded Plex config, rather than adapter-owned
behavior. The supposedly generic contract also imports `Plex*` types and `DbPlexQueryResult`, and
its coarse capabilities do not express Sonic Analysis or Plex's 0-10 rating scale. There is no JWT
migration behavior in the current implementation; credentials are treated only as a legacy Plex
token.

The desired outcome is therefore a behavior-preserving completion of the boundary: all Plex API
behavior belongs to `PlexAdapter` or its private Plex adapter support modules; generic consumers see
only server-neutral types and capabilities; Plex authentication and caching are adapter-owned; and
existing YAML, commands, flags, output, errors, exit behavior, and shell completions remain
compatible.

## User Stories

1. As an existing Plex user, I can upgrade without changing my `plex:` configuration, environment
   templates, command names, flags, scripts, or shell-completion habits.
2. As a user running copy, delete, queue, sync, watch, or playlist workflows, I receive the same
   optional scan behavior: media work succeeds even when an optional Plex scan is disabled or
   unavailable, while an explicitly required Plex operation still fails clearly.
3. As a user querying libraries or managing playlists and collections, I receive the same items,
   pagination, filtering, mutation results, and actionable not-found or authentication errors.
4. As a user syncing ratings, I keep the existing 1-5 star CLI experience and file-rating
   normalization even though Plex stores ratings on a 0-10 scale.
5. As a user whose Plex installation adopts JWT-based authentication, I can continue using rfmedia
   through a documented, backward-compatible credential path without Plex authentication details
   leaking into actions or commands.
6. As a user with API caching enabled, I keep the latency benefit and do not see stale library,
   playlist, or collection data after a successful mutation.
7. As a future media-server adapter author, I can implement the generic contract without importing
   Plex response types, Plex rating keys, Plex metadata codes, or Plex authentication concepts.
8. As a maintainer, I can change Plex endpoint, authentication, response, cache, or rate-limit
   behavior in one adapter-owned area and verify it with contract and compatibility tests.

## Business Rules and Edge Cases

### Boundary and capability rules

- **BR-01 — One Plex API boundary:** Only `PlexAdapter` and private modules owned by that adapter
  may construct Plex endpoints, attach Plex credentials, call Plex HTTP endpoints, parse Plex wire
  responses, interpret Plex metadata type codes, or implement Plex retry/rate-limit behavior.
  Actions, commands, generic types, and generic adapter helpers must not perform those tasks.
- **BR-02 — Server-neutral contract:** Public members of `MediaServerAdapter` must accept and return
  server-neutral domain types. Names or fields such as `PlexTrack`, `PlexQueryOptions`,
  `DbPlexQueryResult`, `ratingKey`, `X-Plex-Token`, and Plex numeric metadata type codes must not be
  required to implement another backend. Plex wire/domain translation happens at the adapter edge.
- **BR-03 — Explicit Plex features:** The adapter must advertise Plex-only behavior separately from
  coarse operation groups. At minimum, consumers must be able to determine the rating scale and
  whether Sonic Analysis behavior is supported before attempting a feature. Unsupported features
  must produce deterministic fallback or actionable unsupported behavior; they must not be assumed
  from `type === "plex"`.
- **BR-04 — Capability truthfulness:** A capability reported as available must have a callable,
  tested behavior. A configured adapter may still be unavailable for an optional scan, and a
  server/library-dependent feature must not be advertised as available until the relevant context
  supports it.
- **BR-05 — No abstraction-driven feature loss:** The adapter must continue to cover current track,
  album, and artist queries; library lookup; whole-library, path, and source scans; playlist CRUD;
  collection CRUD and membership; track-file path extraction; machine identifier lookup; and rating
  writes.

### Configuration and CLI compatibility rules

- **BR-06 — Existing config remains valid:** The current `plex:` keys remain accepted with the same
  meaning: `url`, `token`, `scanAfterCopy`, `libraryName`, `scanPerSource`, `libraries`, `pageSize`,
  `defaultFilters`, `allowedLibraryRoots`, `syncDefaults`, `playlistDefaults`, `cache`,
  `syncRatingsOnCopy`, and `syncOnCopyDefaults`. No new required key or migration step may be
  introduced for existing token users.
- **BR-07 — Existing precedence remains stable:** An explicit CLI `--plex-url` or `--plex-token`
  overrides the loaded `plex.url` or `plex.token`; command values override named-filter and config
  defaults where they do today. Refactoring must not silently change this precedence.
- **BR-08 — Existing command surface remains stable:** The `rfmedia plex` namespace and its query,
  copy, playlist, sync, and collection subcommands remain valid. Existing cross-command flags such
  as `--plex-scan`, `--no-plex-scan`, `--plex-library`, and `--plex-per-source` retain their names and
  semantics. “Server-agnostic naming where possible” applies internally and must not rename or
  remove user-facing Plex commands.
- **BR-09 — Output compatibility:** Human output, JSON field names, error text relied on by existing
  tests, and exit-code behavior remain stable unless a JWT-only failure requires a new additive,
  actionable error. Existing automation must not need output parsers rewritten for this refactor.
- **BR-10 — Completion parity:** If no CLI option changes, Bash, Zsh, and Fish templates must remain
  behaviorally unchanged. If an additive authentication option is ultimately required, all three
  templates and template parity tests must be updated together; legacy Plex options must remain.

### Authentication and secret-handling rules

- **BR-11 — Legacy token continuity:** A non-empty existing `plex.token` or `--plex-token` continues
  to authenticate exactly the same user workflows. Missing URL/token in required mode retains the
  current actionable failure; invalid URL retains the current invalid-format failure.
- **BR-12 — Adapter-owned authentication:** Actions and commands provide credentials to the
  adapter factory but do not decide whether a credential is a legacy token, JWT, refreshed token,
  header, or query parameter. Any JWT recognition, exchange, refresh, expiry, or retry is confined
  to the Plex adapter boundary.
- **BR-13 — Safe authentication failure:** A 401 must never be treated as an empty result or cached.
  Required query/CRUD workflows fail clearly; scan/update methods retain their established result
  semantics. If JWT refresh is supported and safely possible, only one bounded recovery attempt may
  occur before returning the final authentication failure; there must be no unbounded retry loop.
- **BR-14 — Secret non-disclosure:** Raw tokens and JWTs must not appear in cache keys, debug output,
  error output, persisted query records, or user-facing URLs. Existing config redaction remains in
  effect. Different credentials for the same server must not allow cached authorization-sensitive
  data to cross user boundaries.

### Caching, requests, and mutation rules

- **BR-15 — Cache remains opt-in and compatible:** `plex.cache.enabled` remains false when absent or
  false. When enabled and `ttlSeconds` is absent, the current 300-second default remains. Expired
  entries are misses; cache keys remain server-scoped and secret-free.
- **BR-16 — Cache ownership:** Plex response caching, the machine-identifier cache, key formation,
  and invalidation are owned by the Plex adapter. Generic consumers neither import Plex cache
  helpers nor know Plex cache categories.
- **BR-17 — Mutation invalidation:** Successful playlist create/add/delete invalidates cached
  playlist listings. Successful collection create/add/delete invalidates cached collection
  listings for the server. Failed or dry-run mutations must not create a false “success” cache
  state. Library and machine-identifier cache behavior remains stable unless a separately specified
  invalidation event exists.
- **BR-18 — Cache does not change observable correctness:** A cache hit returns the same domain
  result as a live response and skips unnecessary request delay. A miss, expiry, or disabled cache
  follows the existing live-request path. Malformed, 401, 404, timeout, or other failed responses
  are never cached.
- **BR-19 — Pagination remains complete:** Track, album, artist, playlist-item, and collection-item
  pagination must neither skip nor duplicate items, including when Plex omits or varies page-count
  metadata. Existing `pageSize`, `limit`, and `offset` behavior remains observable at the command
  layer.
- **BR-20 — Existing load protection remains:** Live Plex requests retain the current bounded
  timeout and inter-request pacing where presently used. Empty add requests remain no-ops.
  Playlist additions retain the current 100-item batching warning/behavior, and collection
  additions retain 50-item batching with the existing HTTP 400 single-item recovery behavior.

### Query, rating, scan, and error rules

- **BR-21 — Query semantics remain Plex-compatible:** Library matching and playlist/collection name
  matching remain case-insensitive. Track, album, and artist filtering, named-filter precedence,
  default filters, client-side filter completion, total size, and `hasMore` semantics remain stable.
- **BR-22 — Rating conversion is explicit:** User-facing filters remain on the 1-5 star scale,
  Plex requests/writes remain on Plex's 0-10 scale, and file sync remains normalized through the
  existing rating conversion behavior. The generic contract must describe scale/capability rather
  than silently assuming Plex's scale.
- **BR-23 — Optional scans stay optional:** When scanning is disabled, optional adapter resolution
  returns no adapter and media work proceeds. When scanning is requested but credentials or URL are
  missing/invalid, the current warning is emitted and scanning is skipped. Required Plex operations
  still fail rather than silently skipping.
- **BR-24 — Scan targeting and recovery remain stable:** A configured library scans that library;
  no configured library scans all libraries. A destination matching a configured library path uses
  a path scan. No match falls back to a full scan. Failure to resolve a mapped library warns and
  falls back to a full scan. Dry runs do not send a scan request.
- **BR-25 — Error contracts are preserved:** Query and CRUD operations throw actionable failures;
  scan and rating-update operations return their existing success/message/status result form.
  401 remains an authentication error, 404 identifies the missing playlist/collection where
  applicable, malformed responses are not accepted as valid empty data, and connection/DNS/timeout
  scan failures remain distinguishable.
- **BR-26 — Destructive scope remains narrow:** Deleting a playlist or collection deletes only the
  container, not its tracks, albums, or artists. Collection/playlist lookup failure must happen
  before mutation. A refactor must not broaden a scan, delete, or rating update target.

## Primary and Error-Recovery Workflows

### Required query or CRUD workflow

1. A `rfmedia plex ...` command parses the same arguments and loads the same config sections.
2. The action asks `resolveRequiredMediaServerAdapter` for an adapter, passing any CLI overrides.
3. The factory applies CLI-over-config precedence, rejects missing credentials or an invalid URL,
   and returns a Plex adapter even when post-copy scanning is disabled.
4. The action passes server-neutral query or mutation data to the relevant capability.
5. The adapter handles authentication, cache lookup, Plex request formation, response parsing,
   pagination/rating translation, and cache invalidation.
6. The action formats the same human or JSON result and preserves its existing persistence/history
   behavior.

Error recovery: a 401 follows the bounded legacy/JWT authentication policy; a 404 names the missing
resource; invalid response data fails rather than masquerading as success; network/timeouts retain
the current operation-specific contract. No error response is cached.

### Optional post-operation scan workflow

1. A copy, delete, queue, sync, watch, or playlist workflow completes or previews its primary media
   operation.
2. The action calls `resolveOptionalScanAdapter` with `--plex-*` overrides and loaded scan defaults.
3. Disabled scanning returns no adapter with no Plex request. Requested scanning with unusable
   connection settings logs the current warning and returns no adapter.
4. In a real successful mutation, the action checks the scan capability and requests a per-source,
   mapped-path, named-library, or full scan according to current options.
5. A mapped path uses the narrow library/path scan. An unmapped path, or a failed mapped-library
   lookup, falls back to the documented full scan.

Error recovery: scan failures return a structured unsuccessful result and do not retroactively mark
the completed media copy/delete as failed unless the invoking action already does so today. Dry-run
workflows report intended behavior without calling Plex.

### Rating synchronization workflow

1. The action enumerates local audio files and all relevant server tracks using adapter pagination.
2. It matches files to media items and normalizes file ratings and server ratings for comparison.
3. Push, pull, or bidirectional conflict rules select the winning value exactly as today.
4. Dry-run reports changes only. A live push converts the normalized/user value to the adapter's
   declared rating scale before the adapter writes it; a pull writes the configured file-tag scale.
5. Per-item failures are recorded without exposing credentials, and the existing aggregate result
   counts remain stable.

Error recovery: expired/invalid authentication follows the bounded adapter policy. An unsupported
rating capability is reported before attempting writes; it must not silently map values using a
Plex assumption.

### Playlist and collection workflow

1. Resolve the target library/container and query items through the adapter.
2. Preserve case-insensitive name lookup and existing available-name hints on failure.
3. Create, add, show/list, or delete through server-neutral capability inputs.
4. The Plex adapter performs machine-identifier URI formation, type-code mapping, batching,
   response parsing, and successful-write cache invalidation.
5. Return the current CLI result shape. Deleting a container leaves its media items intact.

Error recovery: empty additions are no-ops. Collection batch HTTP 400 uses the existing one-by-one
fallback and fails if none succeed. Existing playlist batching warnings remain visible. Partial
mutation outcomes must not be reported as complete success.

### Authentication migration workflow

1. Existing raw `plex.token`/`--plex-token` users continue through the legacy-compatible path.
2. The adapter determines whether a configured credential needs JWT-specific treatment; actions do
   not inspect credential format.
3. The adapter authenticates the request without logging or caching the credential.
4. On an expiry/authentication response, the adapter performs at most one supported recovery action
   and retries only when doing so cannot duplicate a non-idempotent mutation.
5. If recovery is unavailable or fails, the adapter returns the established operation-specific
   authentication error/result and tells the user which credential configuration to correct.

The exact source, refresh mechanism, and config representation for JWTs is an issue decision and is
listed under Open Questions; the business invariant is backward compatibility and containment.

## Domain Model

### Entities and value objects

| Concept                 | Business meaning                                              | Required invariants                                                             |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Media server connection | Selected backend plus endpoint and credential material        | Valid supported backend; valid HTTP(S) endpoint; secrets never exposed          |
| Media server adapter    | Sole behavioral boundary for one backend                      | Truthful capabilities; server-neutral public inputs/outputs                     |
| Capability profile      | Operations and backend-specific features available in context | Separates coarse CRUD/query support from Sonic/rating semantics                 |
| Library                 | Named server section containing media                         | Stable adapter-facing ID, display title, and media kind                         |
| Media item              | Artist, album, or track returned to actions                   | Server-neutral ID; kind-specific metadata; optional file path                   |
| Query                   | Library, media kind, filters, limit, and offset               | Existing filter precedence and pagination semantics                             |
| Playlist                | Ordered audio-item container                                  | Deleting it does not delete media; additions preserve current batching behavior |
| Collection              | Typed artist/album/track container                            | Type is explicit; deleting it does not delete members                           |
| Rating                  | User/media rating with declared scale                         | Conversion is explicit and loss behavior is testable                            |
| Scan request/result     | Whole-library or path refresh attempt                         | Dry-run is non-mutating; result preserves success/message/status semantics      |
| Authentication session  | Adapter-held usable credential state                          | Legacy compatibility; bounded recovery; no disclosure                           |
| Cache entry             | Server-scoped response plus expiry                            | Secret-free key; TTL bounded; invalidated by relevant successful mutation       |

### State transitions

```text
Adapter resolution
unconfigured --required--> configuration error
unconfigured --optional scan disabled/unusable--> unavailable (primary work continues)
configured --validated--> ready
configured --invalid URL--> error (required) / unavailable + warning (optional)

Authentication
ready --request accepted--> authenticated
ready/authenticated --401--> recovery eligible or authentication failed
recovery eligible --one successful refresh/exchange--> authenticated
recovery eligible --unsupported/failed--> authentication failed

Cache
absent/expired/disabled --read--> live request
live request --successful cacheable response--> fresh
fresh --read before expiry--> cache hit
fresh --TTL elapsed--> expired
fresh --successful related mutation--> invalidated
failed response/dry-run mutation --x--> no new fresh entry

Playlist or collection
absent --successful create--> present
present --successful add--> present with members + list cache invalidated
present --successful delete--> absent + list cache invalidated
present --failed mutation--> present or explicitly partial; never reported as complete success

Scan
not requested --> skipped
requested --dry-run--> planned, no server mutation
requested --mapped path--> targeted scan
requested --no match/lookup failure--> full-scan fallback
requested --server failure--> unsuccessful structured result
```

## Existing Codebase Integration

### Already complete on `origin/master`

- `packages/rfmedia-cli/src/types/media-server.ts`
  - Defines `MediaServerAdapter`, `MediaServerCapabilities`, and grouped query, library, scan,
    playlist, collection, and metadata capability interfaces.
  - Establishes result-form semantics for scans and rating updates.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`
  - Defines `PlexAdapter implements MediaServerAdapter` and the current coarse
    `PLEX_CAPABILITIES`.
  - Delegates all currently covered operations with a single resolved `PlexConfig`.
- `packages/rfmedia-cli/src/lib/adapters/index.ts`
  - `createMediaServerAdapter`, `createOptionalMediaServerAdapter`, and
    `requireMediaServerAdapter` centralize current Plex URL/token precedence and required-versus-
    optional behavior.
  - `MediaServerAdapterOverrides` preserves current `plexUrl`, `plexToken`, `plexLibrary`,
    `plexScan`, and `plexPerSource` inputs.
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`
  - `resolveOptionalScanAdapter` and `resolveRequiredMediaServerAdapter` give actions a shared
    resolution path.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
  - Guards thirteen migrated actions: `copy-album`, `copy-filter`, `delete-album`,
    `delete-filter`, `sync`, `watch`, `queue`, `plex-query`, `plex-copy`, `plex-playlist`,
    `playlist`, `plex-collection`, and `plex-sync`.
- `packages/rfmedia-cli/src/actions/*.ts`
  - The guarded actions use adapter resolution/capabilities for server operations. Optional scan
    call sites already check `capabilities.scan`.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts` and action adapter mocks
  - Cover basic delegation, factory precedence/modes, scan gating, invalid configuration, and
    adapter-oriented action tests.
- `packages/rfmedia-cli/docs/features/media-server-adapter.md` and
  `packages/rfmedia-cli/docs/features/plex-configuration.md`
  - Document the incremental adapter boundary and required/optional modes.

### Remaining integration work implied by issue #119

- `packages/rfmedia-cli/src/lib/plex.ts`
  - Still owns all Plex HTTP behavior: endpoint construction, direct `fetch` calls,
    `X-Plex-Token`, 30-second timeouts, 100 ms pacing, Plex response interfaces/parsing, rating and
    metadata-code mapping, pagination, batching, scan fallback, and Plex error handling.
  - `queryPlexTracks`, `queryPlexAlbums`, `queryPlexArtists`, `getPlexLibraries`, scan functions,
    playlist functions, collection functions, `getMachineIdentifier`, and `updateTrackRating` must
    become adapter-owned behavior rather than the implementation behind a thin wrapper.
- `packages/rfmedia-cli/src/lib/plex-cache.ts`
  - `getCachedResponse`, `setCachedResponse`, `invalidateByPrefix`, and `clearPlexCache` are global
    Plex behavior and read `getLoadedConfig()` directly. Cache policy/state must sit behind the
    Plex adapter and continue to preserve current TTL and invalidation behavior.
- `packages/rfmedia-cli/src/types/media-server.ts`
  - Imports `Plex*` and `DbPlexQueryResult` types throughout the generic contract. It needs real
    server-neutral query/item/container types and explicit feature/rating capability metadata.
- `packages/rfmedia-cli/src/types/plex.ts`
  - Correctly contains Plex-specific wire/domain concepts, including `ratingKey`, 0-10 ratings,
    and metadata type codes. These should remain on the Plex side of the translation boundary;
    generic actions must not require them merely to consume an adapter.
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`
  - `extractTrackFilePaths` still imports and invokes `getTrackFilePaths` from `lib/plex.ts` and
    accepts `PlexTrack`. Path extraction should be server-neutral or adapter-owned.
- `packages/rfmedia-cli/src/actions/plex-query.ts`, `plex-sync.ts`, `plex-copy.ts`,
  `plex-playlist.ts`, `plex-collection.ts`, and `playlist.ts`
  - Network calls are adapter-mediated, but orchestration types and variable names still expose
    Plex domain assumptions. Internal generic naming/type use should improve without changing the
    `rfmedia plex` user surface or persisted compatibility formats.
- `packages/rfmedia-cli/src/lib/adapters/index.ts`
  - Still imports `isValidPlexUrl`/`PlexConfig` from `lib/plex.ts` and understands only legacy raw
    token configuration. It needs a clean separation between generic selection and Plex-specific
    config/auth validation while preserving current messages and precedence.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`, `zsh.ts`, and `fish.ts`
  - Preserve the current Plex commands and options. Update all three only if an additive JWT option
    is approved; validate parity through `shell-completions/templates.spec.ts`.
- `packages/rfmedia-cli/src/lib/plex.test.ts`, `plex-cache.test.ts`, adapter tests, action tests, and
  command tests
  - Existing behavior tests are the compatibility baseline. Add adapter-level contract tests for
    HTTP/auth/cache/type translation and retain action/command regression coverage.
- `ROADMAP.md`
  - Currently lists #119 as the first Sprint 3 adapter-boundary item and as unfinished. Completion
    should record the closing PR and update dependent sequencing without claiming issue #118 or the
    Lidarr work has shipped.

## Measurable Success Criteria

1. Every Plex endpoint construction, credential attachment, direct Plex `fetch`, Plex response
   parse, metadata type-code conversion, auth recovery, and Plex cache operation is reachable only
   from `PlexAdapter` or private Plex-adapter modules.
2. `MediaServerAdapter` and its exported capability/domain types compile without imports from
   `types/plex.ts`, `lib/plex.ts`, or Plex-named database result types.
3. The adapter exposes tested, truthful feature metadata covering Sonic Analysis availability and
   rating scale/operations; generic consumers do not infer these from the server type.
4. All thirteen currently guarded actions remain free of direct Plex API imports, and the static
   boundary check is broadened enough to catch new production action leaks rather than relying only
   on a hand-maintained subset and one exact relative import spelling.
5. Existing config fixtures using only `plex.url` and `plex.token` load without warnings or
   migration, and CLI overrides continue to win in adapter factory tests.
6. Existing `rfmedia plex` commands and all existing `--plex-*` flags remain accepted. Representative
   human and JSON command tests prove no incompatible field, message, or exit-code change.
7. Bash, Zsh, and Fish completion template tests pass; if no approved CLI addition is made, their
   existing command/flag coverage is unchanged.
8. Legacy token authentication, JWT success, expired/invalid JWT handling, final 401 behavior,
   secret redaction, and bounded retry are covered by adapter tests. Non-idempotent operations are
   not blindly replayed.
9. Cache tests prove disabled behavior, 300-second default TTL, configured TTL, hit/miss/expiry,
   server and authorization isolation, secret-free keys, no caching of failures, and playlist/
   collection invalidation after successful writes.
10. Query, pagination, scan fallback, rating conversion, playlist batching, collection 400 fallback,
    and required/optional error-contract regression tests pass with the adapter implementation.
11. The complete rfmedia package type-check, lint/format, unit/integration test, direct-import guard,
    and shell-template checks pass, plus repository-required validation for the final PR.
12. `ROADMAP.md` identifies #119 as shipped in the closing PR and leaves future adapters/dependent
    work accurately pending.

## Open Questions

1. What does “Plex JWT authentication migration handling” mean for this issue: accepting an
   already-issued JWT, acquiring one from Plex account credentials, exchanging a legacy token, or
   refreshing an expiring JWT? The issue does not identify an endpoint, credential source, expiry
   contract, or required config keys.
2. If JWT support needs additive configuration, what names and secret sources are approved? Can the
   existing `plex.token` field contain either credential form, avoiding all CLI/config additions?
3. Which requests are safe to retry after auth recovery? Reads are naturally retryable, while
   playlist/collection creation or membership mutation may duplicate effects unless idempotency can
   be proven.
4. Is Sonic Analysis merely capability metadata for future consumers, or must #119 expose a
   concrete Sonic operation? No current action or command in the repository uses Sonic Analysis.
5. Is Sonic support static for Plex, discovered from server version/account/library state, or
   evaluated per library? The answer determines when the flag can truthfully be true.
6. Should generic ratings expose a normalized 0-1 value, an explicit `(value, scale)` pair, or both?
   Compatibility requires Plex's existing 1-5 user input and 0-10 API mapping, but the contract must
   also serve backends with other scales.
7. Should the adapter cache be per adapter/credential instance or shared among adapters for the same
   server? Shared state preserves current process-wide reuse but must prevent authorization data
   crossing credentials.
8. Is `lib/plex.ts` expected to disappear, become private adapter modules, or remain as temporary
   compatibility re-exports? The acceptance boundary should be based on ownership and import rules,
   not only a filename move.
9. Must existing persisted database names such as Plex query tables/types remain untouched in this
   refactor? Strict user compatibility suggests yes, with translation at repository boundaries,
   unless a separately planned backward-compatible database migration is approved.
10. Does “server-agnostic naming where possible” include internal action filenames such as
    `plex-query.ts`, or only their types/variables? User-facing `rfmedia plex` naming must remain, so
    renaming files offers limited user value unless it strengthens the enforced boundary.
11. Should #119 be divided into child issues for type/domain separation, adapter-owned HTTP/auth,
    cache ownership, and consumer migration, or delivered atomically because intermediate states
    would not satisfy the isolation guarantee?
