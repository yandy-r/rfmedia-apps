# Plex Adapter Refactor: Practices Research

## Executive Summary

The best implementation of issue #119 is a boundary completion, not a framework build. The
repository already has the right high-level shape: capability groups in
`src/types/media-server.ts`, required/optional construction modes in
`src/lib/adapters/index.ts`, action-facing resolution in
`src/lib/adapters/action-helpers.ts`, and action tests that can replace Plex functions with an
adapter. The problem is that the current abstractions still carry Plex types and the `PlexAdapter`
only forwards calls into `src/lib/plex.ts`.

Reuse the existing action and command workflows. Change what crosses their server boundary, then
move Plex protocol mechanics behind that boundary. Avoid renaming commands, rewriting query/copy
orchestration, migrating SQLite, introducing an adapter plugin framework, or adopting a Plex SDK.
Those changes create more states to validate without making issue #119 more complete.

The smallest durable design has five responsibilities:

1. A plain, provider-neutral `MediaServerAdapter` contract with grouped query, library, scan,
   playlist, collection, and metadata methods.
2. One `PlexAdapter` facade that is the only Plex implementation visible to the factory.
3. Small private Plex helpers for HTTP/authentication, raw payload mapping, and cache state where
   isolation materially improves testing.
4. Existing actions that orchestrate generic media entities and retain Plex-branded compatibility
   only at the command, MCP, config, and saved-query edges.
5. Pure tests at each seam plus one import-boundary check that makes bypassing the adapter fail CI.

Do not generalize for hypothetical server behaviors beyond what current Plex operations and issue
Issue #118's known direction requires. In particular, keep separate `tracks()`, `albums()`, and
`artists()` methods instead of a complex conditional generic query API; keep a simple factory
switch/registration record instead of dynamic plugins; keep a `Map` cache instead of a cache
dependency; and treat JWT as a private auth strategy seam until a concrete issuance/refresh
contract exists.

## Existing Reusable Code table

| Existing path / symbol                                                                                                                               | Reuse                                                 | Concrete before/after guidance                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/media-server.ts` — `MediaServerAdapter` and six capability interfaces                                                | Keep the grouped capability shape                     | Before: methods accept and return `Plex*` and `DbPlexQueryResult` types. After: the same groups accept generic `MediaTrack`, `MediaAlbum`, `MediaArtist`, `MediaPlaylist`, and `MediaCollection` values. Do not replace the groups with a service locator or dozens of one-method interfaces.               |
| `packages/rfmedia-cli/src/lib/adapters/index.ts` — `createMediaServerAdapter()`, `createOptionalMediaServerAdapter()`, `requireMediaServerAdapter()` | Keep the public factory modes and override precedence | Before: the generic factory imports `PlexConfig`, `isValidPlexUrl()`, and loaded Plex config directly. After: a small Plex resolver returns a private connection object, while the public functions and optional/required semantics stay unchanged.                                                         |
| `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts` — `resolveOptionalScanAdapter()` and `resolveRequiredMediaServerAdapter()`                 | Keep as the action import point                       | Before: it imports Plex config, DB rows, Plex tracks, and `getTrackFilePaths()`. After: resolution delegates to the factory and file-path validation delegates to a provider-neutral local helper. Avoid adding command-specific methods here.                                                              |
| `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts` — `PlexAdapter`                                                                              | Keep the class and capability-group object style      | Before: every method is a one-line call into `lib/plex.ts`. After: it owns Plex composition, mapping, native rating conversion, machine-ID handling, and cache invalidation through private helpers. Keep one class, not a class hierarchy per capability.                                                  |
| `packages/rfmedia-cli/src/lib/ratings.ts` — `starsToNormalized()`, `normalizedToStars()`                                                             | Reuse for the generic 0-1 boundary                    | Command inputs in 0-5 stars should enter the generic model through `starsToNormalized()`. Text output should use `normalizedToStars()`. Move or confine `normalizedToPlex()` and `plexToNormalized()` to the Plex implementation so actions cannot call them.                                               |
| `packages/rfmedia-cli/src/lib/plex-pagination.ts` — `advancePaginationOffset()`                                                                      | Reuse the algorithm under a provider-neutral name     | Its forward-progress guard is correct and used by query, playlist, collection, and sync actions. Rename/move to `lib/pagination.ts`, replace `pageItemCount` with generic `returned`, and preserve all existing stalled-page cases. Do not invent cursors until a real adapter needs them.                  |
| `packages/rfmedia-cli/src/lib/plex-filter-evaluator.ts` — recursive rule evaluation and complexity guards                                            | Reuse the AST traversal and client-side evaluation    | The boolean recursion, `MAX_FILTER_DEPTH`, missing-field behavior, and short-circuiting are reusable. Split Plex query-option encoding/pushdown into the adapter; rename the entity access/evaluation layer only after it consumes generic entities and normalized ratings.                                 |
| `packages/rfmedia-cli/src/types/plex-filters.ts` — `PlexSmartFilter`, rules, groups, guards                                                          | Reuse structurally with compatibility aliases         | The fields are media-domain fields. Introduce generic names such as `MediaFilter`, but keep `PlexSmartFilter` aliases and the `plexFilters` config key for compatibility. Avoid a new expression language.                                                                                                  |
| `packages/rfmedia-cli/src/lib/plex-cache.ts` — TTL `Map`, prefix invalidation, disabled behavior                                                     | Reuse the mechanism, not the global ownership         | Before: module-global state reads `getLoadedConfig()` on every operation. After: construct an adapter-private cache with captured `enabled`/`ttlSeconds` and an injectable clock. Keep `Map`; do not add Redis, LRU, or a generic cache package.                                                            |
| `packages/rfmedia-cli/src/lib/plex.ts` — endpoint logic and response parsing                                                                         | Reuse behavior and tests during a mechanical move     | Preserve endpoint paths, pagination headers, timeouts, pacing, scan semantics, collection fallbacks, and write invalidation. Move by endpoint family behind `PlexAdapter`; do not rewrite all behavior and types simultaneously. Delete the bypass module only after parity tests pass.                     |
| `packages/rfmedia-cli/src/lib/plex.ts` — `getTrackFilePaths()`                                                                                       | Reuse as a local generic helper                       | Before: it is presented as Plex/API behavior. After: `lib/media-file-paths.ts` accepts `readonly { filePath: string }[]`, uses the existing `pathExists()` behavior, and stays outside the adapter. Add a small legacy DB-row projection rather than accepting `DbPlexQueryResult` in the adapter contract. |
| `packages/rfmedia-cli/src/lib/loaded-config.ts` — `getLoadedConfig()` / `getLoadedPlexConfig()`                                                      | Keep the loaded-config state and config precedence    | Provider-specific config resolution may call these functions inside the Plex registration/resolver. Do not duplicate config loading inside `PlexAdapter` or pass the whole `ConfigFile` into it.                                                                                                            |
| `packages/rfmedia-cli/src/lib/config.ts` — `ConfigError`, `validatePlexConfigOptions()` and primitive validators                                     | Reuse validation and formatter integration            | Preserve all existing `plex.*` keys and validation. If an additive auth object is eventually required, validate it with the existing helpers and `ConfigError`; do not introduce a second schema system for one object.                                                                                     |
| `packages/rfmedia-cli/src/lib/errors.ts` and `lib/error-formatters.ts` — structured errors and `registerRfmediaErrorFormatters()`                    | Extend the established error pattern                  | Add one `MediaServerError` with a small code union and one formatter registration. Do not create a subclass per HTTP status or let actions parse message strings.                                                                                                                                           |
| `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts`                                                                        | Keep a shared adapter test builder                    | Before: its options and return values are Plex types and it includes machine identifier/file-path leaks. After: use generic fixtures, feature defaults, and capability overrides. Let tests request only the methods they assert instead of exposing an ever-growing mock facade.                           |
| `packages/rfmedia-cli/src/actions/test-helpers/media-server-fixtures.ts`                                                                             | Keep deterministic entity/page fixtures               | Rename values to generic media fixtures, use normalized ratings, and add Plex compatibility projections only in presenter/persistence tests. One canonical fixture prevents every action test from inventing a slightly different track.                                                                    |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`                                                                                         | Expand the existing dependency guard                  | Before: it scans thirteen named actions for one exact `../lib/plex.js` string. After: scan action/command/MCP/generic modules for imports of Plex implementation modules with a narrow compatibility allowlist. Keep it a simple Node script; no architecture-lint dependency is needed.                    |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`                                                                                   | Reuse as compatibility evidence                       | No CLI option changes are recommended, so do not mechanically edit Bash/Zsh/Fish templates. Run this test and command parsing tests to prove the refactor did not alter completions.                                                                                                                        |
| `packages/rfmedia-cli/src/lib/db.ts` — Plex query persistence functions                                                                              | Keep schema and function behavior                     | Map generic entities to existing `PlexQueryResultItem` only at `plex-query.ts`/compatibility persistence. Avoid a schema migration or generic repository until a second provider has concrete persistence requirements.                                                                                     |

## Modularity Design

### Recommended boundaries

Use boundaries that correspond to a reason to change, not one file per noun:

```text
types/media-server.ts
  Stable domain entities + adapter capability signatures

actions/*.ts
  Workflow orchestration, local files, DB calls, progress, user intent

lib/adapters/index.ts + action-helpers.ts
  Adapter selection, required/optional modes, compatibility override resolution

lib/adapters/plex-adapter.ts
  Plex implementation facade and capability composition

lib/adapters/plex/{client,auth,cache,mappers,types}.ts
  Private protocol details with focused test seams

commands/plex.ts + mcp/schema.ts + legacy DB mapping
  Intentionally Plex-branded compatibility surfaces
```

The adapter facade may call private functions, but no action may import a private Plex module. The
client must not know about Commander, loaded config, logging presentation, SQLite, local file
existence, or action result types. Mappers must be pure. The cache must not call the network. Auth
must only modify request headers or perform its one documented refresh decision.

Do not split every existing exported function in `lib/plex.ts` into its own file. Start with one
private `client.ts` containing the request primitive and endpoint methods. Extract `mappers.ts`
because pure mapping is a valuable test seam, `cache.ts` because it has state/time, `auth.ts`
because credentials change independently, and `types.ts` because raw Plex payloads must not leak.
Further endpoint-family files are justified only if `client.ts` remains too large after common
request logic and mapping are removed.

### Shared vs feature-specific table

| Concern        | Shared/provider-neutral                                   | Plex-specific                                                             |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| Media identity | `MediaTrack.id`, `MediaAlbum.id`, `MediaArtist.id`        | `ratingKey` parsing and URI use                                           |
| Ratings        | Normalized 0-1 value/null; star conversion for CLI        | Native 0-10 conversion and `:/rate` request                               |
| Queries        | Media kind, filters, page limit/offset/result metadata    | Type codes 8/9/10, filter query keys, `X-Plex-Container-*`                |
| Filters        | AST, validation, recursive client-side evaluation         | Which rules can be pushed down and their Plex parameter encoding          |
| Pagination     | Forward-progress calculation from offset/returned/hasMore | Reading Plex container size/total fields                                  |
| File paths     | Local existence and allowed-root validation               | Extracting `Media[0].Part[0].file` from raw payload                       |
| Libraries      | ID, title, kind, name lookup semantics                    | Plex section endpoints and section type strings                           |
| Playlists      | CRUD and track IDs                                        | Plex playlist endpoints, machine/server URI format if needed              |
| Collections    | CRUD, media kind, item IDs                                | Machine identifier lookup, `server://` URI, collection endpoint fallbacks |
| Scans          | Trigger/all/path/source result contract                   | Plex refresh endpoints and library path mapping rules                     |
| Authentication | Typed auth/config failures at the adapter boundary        | `X-Plex-Token`, future bearer/JWT headers and refresh                     |
| Caching        | No shared cache abstraction is necessary yet              | Plex cache categories, keys, TTL, and invalidation                        |
| Errors         | `MediaServerError` code/status/operation shape            | Plex-specific user suggestions and raw status mapping                     |
| Configuration  | Factory mode and override precedence                      | `plex.*`, `plexFilters`, `--plex-*` compatibility inputs                  |
| Output         | Common action data may be generic                         | Existing `ratingKey`, `userRating`, Plex MCP/tool names                   |
| Persistence    | No new shared repository in #119                          | Existing `plex_queries` / `plex_query_results` projections                |

## KISS Assessment table

| Area                 | Simplest sufficient choice                                              | Avoid                                                                        | Reason                                                                                                 |
| -------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Adapter shape        | Retain the six current capability groups                                | A generic command bus, service locator, or one class per capability          | Current actions already understand the grouped shape; only its types are wrong.                        |
| Query API            | Keep `tracks()`, `albums()`, `artists()`, `albumTracks()`               | Conditional generic return types or an untyped `query(kind)` result          | Explicit methods are easy to mock and preserve type narrowing without advanced generics.               |
| Entities             | Three discriminated interfaces plus a union                             | One mega-interface with every field optional or a deep inheritance tree      | Track/album/artist have real field differences; a shallow union makes them explicit.                   |
| Provider selection   | A typed switch or static registration record in `adapters/index.ts`     | Runtime plugin discovery or dependency-injection container                   | Only Plex exists today; #118 can add one static registration without framework cost.                   |
| HTTP                 | One native-fetch request helper plus endpoint methods                   | A new Plex SDK or generic REST framework                                     | Existing behavior uses Node 22 `fetch`; centralization, not dependency adoption, is the missing piece. |
| Authentication       | A small private strategy function/object                                | Full OAuth framework, token store, or guessed JWT refresh service            | Current token auth is simple; only the seam and redaction are required now.                            |
| Cache                | Per-adapter `Map` with TTL and explicit invalidation                    | LRU library, persistent cache, cache event bus                               | The cache is small, per invocation, and only covers a few categories.                                  |
| Error model          | One error class and compact code union                                  | One subclass per status/endpoint or raw `Response` propagation               | Actions need stable categories, not a second exception hierarchy.                                      |
| Capabilities         | Plain readonly booleans/descriptors                                     | Dynamic negotiation protocol or serialized capability schema                 | Current capability set is known at construction. Sonic can be `server-dependent` without probing.      |
| Ratings              | Normalize once at adapter edges                                         | Preserve both native and normalized values throughout actions                | Two simultaneous scales create comparison bugs and leak Plex assumptions.                              |
| Filters              | Reuse the existing AST; separate evaluation from pushdown               | Invent a query DSL or promise universal pushdown                             | Current behavior is mature and tested. Provider support varies only at pushdown.                       |
| Compatibility        | Explicit projection functions at CLI/MCP/DB edges                       | Let deprecated Plex types remain the generic domain model                    | Projections make legacy obligations visible and removable later.                                       |
| Migration sequencing | Move one endpoint family at a time behind the adapter with parity tests | Rewrite `lib/plex.ts`, all actions, types, and outputs in one unverified cut | Mechanical phases reduce the chance of losing obscure fallback or invalidation behavior.               |
| Database             | Keep current Plex tables                                                | Generic schema redesign                                                      | No schema change is necessary to isolate network/domain code.                                          |
| Shell completion     | Prove unchanged templates                                               | Touch all three generators with no option change                             | A no-op edit adds review noise and no user value.                                                      |
| Documentation        | Update adapter and Plex configuration docs                              | Add a new documentation hierarchy                                            | Existing feature docs are the established discoverability surface.                                     |

## Abstraction vs Repetition

### Extract

Extract code when it establishes the boundary or removes repeated protocol policy:

- Extract all repeated `fetch()` setup, auth-header application, 30-second timeout, JSON handling,
  and HTTP error classification from `lib/plex.ts` into one private Plex request helper. The current
  endpoint functions repeat 401 handling and token query construction many times; that is policy,
  not harmless duplication.
- Extract raw-to-generic mapping for tracks, albums, artists, libraries, playlists, and collections.
  Mapping is the single enforcement point for `ratingKey -> id`, Plex 0-10 -> normalized 0-1,
  missing values, and unknown metadata codes.
- Extract machine-identifier lookup and Plex collection URI construction into
  `PlexAdapter.collection.addItems()`. An action should pass collection and item IDs only.
- Extract `advancePaginationOffset()` into `lib/pagination.ts` because four workflows need the same
  no-progress guard and it contains no Plex protocol dependency after renaming its inputs.
- Extract local file-path validation into `lib/media-file-paths.ts`; it is reused by live adapter
  results and saved DB rows but should not be a remote-server capability.
- Extract generic filter value access and recursive evaluation from Plex query pushdown. Keep the
  existing AST and algorithms; only the item fields/rating scale change.
- Extract legacy result projection once if both `commands/plex.ts`, `mcp/schema.ts`, and query
  persistence need `ratingKey`/`userRating`. The conversion must not be rewritten independently in
  three places.
- Extract a single Plex config resolver used by both optional and required factory modes. Return a
  discriminated success/missing/invalid result so warning versus throw behavior does not duplicate
  field precedence.
- Extract one `MediaServerError` and formatter instead of repeating status-string checks in actions.

### Repeat

Repeat small, explicit logic when abstraction would couple unrelated behavior:

- Keep endpoint methods explicit (`getLibraries`, `queryTracks`, `createPlaylist`,
  `addCollectionItems`). Do not encode all endpoints in a metadata table whose types and invalidation
  hooks are harder to follow than the methods.
- Keep separate track/album/artist raw mappers if their payload fields differ. A tiny shared base
  mapper is acceptable, but a reflection-driven “universal media mapper” would hide required-field
  rules.
- Keep explicit cache invalidation beside each mutation. Three clear `cache.invalidate(...)` calls
  are preferable to an event emitter or decorator system.
- Keep scan and rating-update result adaptation explicit because those operations intentionally
  return result objects while other CRUD methods throw. A universal result wrapper would change
  current action semantics.
- Keep Plex-branded option/action result types where they are genuinely public compatibility
  surfaces. Renaming `PlexCopyActionOptions` provides no boundary value if the command is still
  `rfmedia plex copy`.
- Keep action-specific orchestration in `plex-query.ts`, `plex-playlist.ts`, and
  `plex-collection.ts`. Pagination loops can share offset advancement, but their result accumulation,
  deduplication, limits, and user messages are different workflows.
- Keep endpoint-focused tests rather than one parameterized mega-test. Authentication/redaction can
  be shared; playlist and collection fallback cases should remain readable beside their behavior.
- Keep config compatibility tests for both file values and CLI overrides even if they exercise the
  same final resolver. They protect two user inputs, not accidental duplication.

## Interface Design

### Public surfaces

The intended stable public surfaces are:

- `MediaServerAdapter` and its generic entities/capability interfaces from
  `src/types/media-server.ts`.
- `createMediaServerAdapter()`, `createOptionalMediaServerAdapter()`, and
  `requireMediaServerAdapter()` from `src/lib/adapters/index.ts`.
- Existing action exports such as `executePlexQuery()`, `executePlexCopy()`, playlist/collection
  actions, and their Plex-named option/result contracts.
- Existing Commander commands/options, `config.plex`, `plexFilters`, JSON output fields, MCP tool
  names/schemas, and saved Plex query behavior.

Keep the adapter interface concrete and boring:

```typescript
export interface MediaServerAdapter {
  readonly type: MediaServerType;
  readonly capabilities: MediaServerCapabilities;
  readonly features: MediaServerFeatures;
  readonly query: MediaServerQueryCapability;
  readonly library: MediaServerLibraryCapability;
  readonly scan: MediaServerScanCapability;
  readonly playlist: MediaServerPlaylistCapability;
  readonly collection: MediaServerCollectionCapability;
  readonly metadata: MediaServerMetadataCapability;
}
```

Prefer these method principles:

- IDs are opaque `string` values. Do not brand a different ID type for every entity until a real
  mix-up has occurred or a second adapter demonstrates the need.
- Ratings are normalized `number | null` with runtime range validation. Do not attempt to encode
  fractional ranges in the TypeScript type system.
- Return readonly arrays/pages where actions should not mutate server results.
- Use existing operation-specific result objects for scan and rating updates; let query/CRUD throw
  `MediaServerError`.
- Do not expose `fetch`, raw responses, machine identifier, native rating scale values, metadata
  codes, cache controls, or auth refresh on the public adapter.
- Keep capability descriptors as plain objects/arrays. A `ReadonlySet` is acceptable internally but
  a readonly record/array is easier to assert, copy, and include in diagnostic output.

### Extension points

Only three extension points are required:

1. **Provider factory registration:** a static typed mapping from `MediaServerType` to a config
   resolver and constructor. OpenSubsonic can add one entry. No runtime discovery is needed.
2. **Private auth strategy:** `PlexClient` receives an object/function that applies headers and may
   make one refresh decision. This supports token versus future bearer/JWT without changing the
   adapter contract.
3. **Transport/clock injection for tests:** `PlexAdapter` or `PlexClient` accepts optional constructor
   dependencies such as `fetchImpl` and `now`. Production defaults use native globals. Do not expose
   these through CLI factory options or create an application-wide DI container.

Filter pushdown should be data/function behavior owned by each adapter, not another public service.
The generic filter evaluator can ask a capability helper which leaf rules were handled, or the
adapter can return a query plan containing pushed/residual filters. Choose the smaller shape that
fits existing action code; do not add an optimizer framework.

Compatibility aliases in `types/plex.ts` are a migration surface, not an extension point. Mark them
deprecated and ensure new implementation code imports generic names. Do not allow future adapters
to depend on them.

## Testability Patterns and anti-patterns

### Patterns

- **Pure mapper tests:** feed literal Plex payload fragments into functions in
  `lib/adapters/plex/mappers.ts` and assert generic entities. Cover missing `Metadata`, absent
  `Media/Part/file`, unknown type codes, empty arrays, and normalized rating bounds.
- **Injected transport tests:** test `PlexAdapter` with a small fake `PlexTransport`, asserting
  generic requests/results and capability behavior. Test `PlexClient` separately with injected
  `fetch`, real `Request`/`Response` objects, and no network.
- **Injected time:** pass `now: () => number` to the cache. Advance a number in tests rather than
  fake global timers for basic TTL behavior.
- **Small adapter builder:** revise `createMediaServerAdapterMock()` so an action test can override
  only `query.tracks` or `playlist.list` and receive safe defaults for the rest. Return the adapter
  and specifically requested spies, not every internal method by default.
- **Canonical generic fixtures:** one track, album, artist, playlist, collection, and empty page in
  `actions/test-helpers/media-server-fixtures.ts`. Use `id`/normalized `rating` internally. Keep raw
  Plex fixture builders with the adapter mapper tests.
- **Compatibility snapshots/contracts:** before changing action result types, lock existing CLI JSON
  and MCP output in `commands/plex.test.ts` and `mcp/schema.spec.ts`. After migration, prove
  `ratingKey`, `userRating`, arrays, pagination, and query ID fields are unchanged.
- **Factory matrix:** cover required/optional mode × scan enabled/disabled × config/CLI credentials ×
  valid/invalid URL. Preserve the existing warning/throw distinction.
- **Endpoint parity:** migrate the cases in `lib/plex.test.ts`, `plex-collection.test.ts`, and
  `plex-cache.test.ts` to client/adapter tests before deleting old modules. Use a checklist so no
  endpoint or fallback disappears during file moves.
- **Auth safety:** assert tokens/JWTs are in headers, absent from request URLs, cache keys, debug
  messages, and thrown errors. Test a 401 and the maximum one-refresh rule.
- **Boundary test:** expand `check-direct-plex-imports.mjs` and run it from package/root validation.
  Include a fixture or self-test proving it detects `types/plex`, old `lib/plex`, cache, pagination,
  filter, and `adapters/plex/*` imports from forbidden layers.
- **Second-adapter compile proof:** a minimal in-test fake implementing `MediaServerAdapter` with no
  Plex imports is valuable. It proves the generic contract can be implemented without building a
  real second provider.
- **Focused validation:** run typecheck, adapter/unit tests, action compatibility tests, MCP schema
  tests, completion template tests, boundary checker, full rfmedia tests, build, and `git diff
--check`.

### Anti-patterns

| Anti-pattern                                                | Current example / risk                                                                | Preferred correction                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Mocking the bypass module                                   | `plex-adapter.test.ts` currently uses `vi.mock("../plex.js")` and verifies forwarding | Inject a transport/client and verify the adapter's actual mapping and policy.                                         |
| Giant hoisted mock object                                   | `plexMocks` and `MediaServerAdapterMock` expose nearly every operation                | Use focused builders and capability overrides; tests should see only the seam they exercise.                          |
| Testing call-through instead of behavior                    | Expecting `queryPlexTracks(config, options)` proves delegation, not isolation         | Assert request headers/path plus generic returned entities, errors, and invalidation.                                 |
| Global mutable cache in tests                               | `plex-cache.ts` needs global `clearPlexCache()` cleanup                               | Instantiate a cache per adapter/test and inject time. Keep `clear()` for a single instance only.                      |
| Production code importing test-driven compatibility aliases | Actions importing `PlexTrack` because fixtures already use it                         | Convert fixtures first or in the same task; new actions import `MediaTrack`.                                          |
| Duplicated rating conversion                                | `plex-sync.ts` calls `normalizedToPlex()` / `plexToNormalized()` directly             | Normalize at `PlexAdapter` mapping/write edges; action tests use only 0-1 values.                                     |
| Over-snapshotting raw payloads                              | Large snapshots obscure one-field protocol changes and can capture secrets            | Use small literal payloads and explicit assertions; never snapshot auth material.                                     |
| Message-string branching                                    | Checking “Authentication failed (401)” in actions                                     | Branch on `MediaServerError.code`; formatter tests protect user wording.                                              |
| Type assertions hiding leaks                                | Casting Plex results to a generic interface without mapping                           | Use explicit pure mapping functions and runtime guards at the wire boundary.                                          |
| Real network integration in unit suite                      | Plex availability/token would make CI nondeterministic                                | Inject `fetch`; reserve optional real-server smoke tests for manual/local use.                                        |
| One mega contract test                                      | A large table across all capabilities becomes unreadable and brittle                  | Keep a small generic contract suite plus endpoint/capability-specific tests.                                          |
| Boundary checker with a permanent broad allowlist           | Compatibility exceptions can become a new bypass                                      | Allow only named presenter/persistence files; comments must explain and tests must cover each exception.              |
| Simultaneous semantic rewrite                               | Moving files while changing filtering, caching, pagination, and output behavior       | First preserve parity behind the new seam; make semantic changes only when required by normalization or leak removal. |

## Build vs Depend table

| Need                        | Build with existing platform/code                                                 | Add dependency?                                  | Decision rationale                                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP transport              | Node 22 `fetch`, `URL`, `URLSearchParams`, `Headers`, `AbortSignal.timeout()`     | No Plex SDK / Axios                              | Existing endpoints already work with native fetch. A small request helper centralizes policy without introducing SDK model leakage.                                                               |
| Authentication headers      | Small `PlexAuthStrategy` using `Headers`                                          | No OAuth library now                             | Current token auth is one header. JWT refresh requirements are unknown; adding a framework before the protocol is known is premature.                                                             |
| JWT decoding                | Treat bearer credential as opaque unless expiry inspection is explicitly required | No JWT package now                               | The client does not need to verify a server-issued token merely to send it. Add a vetted library only if signature verification or standards-compliant parsing becomes an acceptance requirement. |
| Runtime payload validation  | Focused type guards/parsers beside Plex mappers                                   | No Zod/io-ts solely for this refactor            | Payload shapes are limited and current project uses manual validation. A second validation stack would increase bundle and maintenance cost.                                                      |
| TTL cache                   | Existing `Map` pattern plus injected clock                                        | No LRU/cache package                             | Data volume is tiny and process lifetime is short. Expiry and category invalidation are simple.                                                                                                   |
| Retry/backoff               | Explicit no-retry mutations; at most one auth-controlled retry                    | No retry library                                 | Automatic replay can duplicate writes. Rate-limit retry policy is not part of issue #119.                                                                                                         |
| Adapter registry            | Static typed record/switch                                                        | No plugin framework                              | One current provider and one planned provider do not justify discovery/lifecycle machinery.                                                                                                       |
| Dependency injection        | Constructor parameters with production defaults                                   | No DI container                                  | Only `fetch`, auth, cache, and clock need seams. Plain parameters are clearer and sufficient.                                                                                                     |
| Rating normalization        | Existing `ratings.ts` conversions; Plex-native conversion private to adapter      | No numeric/domain library                        | The math is bounded and already tested. Runtime finite/range guards are enough.                                                                                                                   |
| Filter evaluation           | Existing recursive evaluator and AST guards                                       | No query language/parser                         | The current YAML/config AST already expresses the supported behavior.                                                                                                                             |
| Pagination                  | Existing `advancePaginationOffset()` algorithm                                    | No pagination library                            | Offset/returned/hasMore is a few lines and contains a project-specific stall error.                                                                                                               |
| Errors/formatting           | Existing custom error classes plus `@rfmedia/common` formatter registration       | No error framework                               | The repository already has consistent structured error presentation.                                                                                                                              |
| Configuration               | Existing manual validators and `ConfigError`                                      | No schema dependency                             | Compatibility with current `.rfmedia.yaml` logic matters more than introducing a new validator.                                                                                                   |
| Testing                     | Existing Vitest, `vi.fn`, native `Response`, canonical fixtures                   | No HTTP mocking package initially                | Injecting `fetch` is deterministic and keeps request assertions close to platform behavior. Consider a mock server only if streaming/multi-request scenarios become unwieldy.                     |
| Import boundaries           | Expand current Node script                                                        | No dependency-cruiser/ESLint plugin for one rule | A small directory/import allowlist is easy to understand and run in CI. Reconsider if architecture rules multiply across packages.                                                                |
| Compatibility serialization | Small pure projection functions                                                   | No serializer framework                          | Only a handful of legacy Plex field names/scales need mapping.                                                                                                                                    |

## Open Questions

1. Is `packages/rfmedia-cli/src/types/index.ts` a supported external TypeScript API? If yes, which
   Plex type aliases need a deprecation window and compile-only compatibility tests?
2. Should the provider-neutral filter rename be included in #119, or should actions temporarily use
   a generic adapter query shape with `PlexSmartFilter` compatibility at a narrower edge? The
   evaluator currently mixes reusable recursion with substantial Plex pushdown logic, so migration
   should not be a blind file rename.
3. Does the accepted JWT scope require only an internal bearer/auth strategy seam, or a concrete
   user-configurable issuance and refresh workflow? The latter needs verified Plex protocol details
   and may justify a child issue.
4. Should `MediaServerFeatures.sonicAnalysis` be a static `"server-dependent"` descriptor or a real
   runtime probe? No current action consumes Sonic Analysis, so a probe may be needless network and
   entitlement complexity.
5. Is a static switch in `adapters/index.ts` sufficient for #118, or does the OpenSubsonic design
   already require asynchronous adapter construction? Do not add asynchronous factory lifecycle
   until its authentication/config flow demonstrates the need.
6. Which outward contracts are frozen: CLI text, JSON, MCP schemas, TypeScript exports, and/or saved
   DB rows? Snapshot current machine output before implementation so compatibility work targets
   evidence rather than assumptions.
7. Can `lib/plex.ts` be deleted in the same PR after all tests migrate, or is an undocumented
   internal consumer outside `packages/rfmedia-cli/src` importing it? A repository-wide import
   search should settle this before deletion.
8. Should Plex endpoint methods remain together in `adapters/plex/client.ts`, or split into query,
   playlist, and collection modules? Start together; split only if the moved client remains hard to
   navigate after auth, cache, mapping, and wire types are removed.
9. Should generic feature support use a readonly record/array or a `ReadonlySet`? Prefer the simpler
   serializable structure unless performance or operator requirements prove otherwise.
10. Does the boundary checker run in the existing root validation/pre-push workflow, or does
    `package.json` need an explicit script? Completion requires CI/pre-push evidence that the rule
    cannot silently regress.
