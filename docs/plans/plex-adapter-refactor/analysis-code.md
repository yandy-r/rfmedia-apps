# Code Analysis: Plex Adapter Refactor

## Executive Summary

Issue #119 is an ownership inversion rather than a new Plex feature. The repository already has a
grouped `MediaServerAdapter`, a `PlexAdapter`, and action-level resolution helpers, but the contract
and every consumer still traffic in Plex-specific types. The adapter itself is only a delegation
facade over the 2,800-line `lib/plex.ts`, which owns roughly twenty independent `fetch` call sites,
Plex response parsing, URL construction, scan fallback, machine-ID state, playlist/collection
batching, and mutation invalidation. Filter evaluation, pagination, path extraction, and response
caching are additional bypass modules outside the adapter.

The safe implementation order is therefore: establish generic domain contracts and pure helpers;
build a single private Plex transport, cache, mapper, and static token-provider foundation; migrate
endpoint families into `PlexAdapter`; then convert actions and compatibility edges before deleting
the legacy modules. The current tests contain substantial behavioral coverage worth moving rather
than rewriting wholesale. The merged state must preserve Plex-branded config, command, MCP, JSON,
and database fields while ensuring production orchestration depends only on generic types.

One current factory behavior is a release-blocking security issue: `lib/adapters/index.ts` resolves
`plexUrl` and `plexToken` independently. A changed URL can inherit the configured token. Connection
resolution must compare canonical origins and reject a cross-origin URL override unless an explicit
token accompanies it, before constructing an adapter or issuing a request.

## Existing Code Structure

### Current dependency flow

```text
commands/MCP
    -> Plex-branded action option/result types
    -> actions
       -> MediaServerAdapter (whose methods use Plex types)
       -> plex-filter-evaluator / plex-pagination / ratings
    -> PlexAdapter
       -> lib/plex.ts
          -> global fetch
          -> plex-cache.ts
          -> loaded-config.ts
```

The nominal adapter boundary exists, but the dependency direction is not yet provider-neutral:

- `types/media-server.ts` imports `DbPlexQueryResult` plus tracks, albums, artists, queries,
  playlists, collections, and create inputs from `types/plex.ts`.
- `lib/adapters/plex-adapter.ts` imports the complete public function surface from `lib/plex.ts` and
  delegates grouped capability methods to those functions.
- `lib/adapters/action-helpers.ts` still calls `getTrackFilePaths()` from `lib/plex.ts` and imports
  `PlexTrack` and `DbPlexQueryResult`.
- The migrated actions no longer import `lib/plex.ts` directly, but they import Plex entities,
  filters, paging, rating conversions, and metadata-code mappings.
- `scripts/check-direct-plex-imports.mjs` checks only a hard-coded set of 13 action files and only
  the exact `../lib/plex.js` import form. It does not enforce the full boundary.

### Adapter contract and factory

`types/media-server.ts` exposes grouped capabilities:

- `query`: tracks, albums, artists, album tracks, and track file paths.
- `library`: list, lookup by name, and machine identifier.
- `scan`: whole, path, and source-derived scans.
- `playlist`: list, lookup, delete, tracks, create, and add tracks.
- `collection`: list, get, lookup, items, create, add items, and delete.
- `metadata`: track-rating update.

The grouping is a useful stable shape, but its member signatures leak `ratingKey`, `userRating`,
Plex query result names, `machineId`, and database rows. `MediaServerCapabilities` is six coarse
booleans and cannot express rating scale, smart-container support, pushdown, path-scan support, or
server-dependent Sonic Analysis.

`lib/adapters/index.ts` owns two behaviorally different resolution modes:

- Optional mode first checks `scanAfterCopy`/the explicit scan override. It returns `undefined` and
  warns when credentials or URL are unusable, preserving a successful primary file operation.
- Required mode throws the established missing-config or invalid-URL messages.
- CLI values override loaded config values independently. This precedence is compatible for
  same-origin and paired overrides, but unsafe for an unpaired cross-origin URL.
- `getConfiguredMediaServerType()` currently defaults to `"plex"`; there is no discovery logic.

`lib/adapters/plex-adapter.test.ts` tests this factory matrix and thin delegation with hoisted mocks.
These tests should become connection provenance, capabilities/features, and real adapter behavior
tests rather than continuing to mock `lib/plex.ts`.

### Legacy Plex implementation

`lib/plex.ts` is a monolithic compatibility and network layer with these functional regions:

- Connection types and validation: `PlexConfig`, libraries, scan/rating results,
  `validatePlexConfig()`, `isValidPlexUrl()`, and the public-address-oriented
  `isSecurePlexUrl()` blocklist.
- Filter encoding: `buildFilterQueryString()` maps star values and generic-looking fields to Plex
  numeric media codes and Plex query operators.
- Wire mapping: private response shapes and parsers convert `MediaContainer.Metadata` into
  `PlexTrack`, `PlexAlbum`, and `PlexArtist`.
- Query/library: track, album, artist, album-child, section, and machine-identifier operations.
- Scans: whole-library, section/path, source-path matching, and full-scan fallback.
- Metadata: `/:/rate` update with result-object semantics.
- Local paths: file-path extraction/existence checks for live and saved rows.
- Playlists: list/find/tracks/create/add/delete, including machine-ID URI construction and batches.
- Collections: list/get/items/create/add/delete/find, including media-code and URI fallbacks.

Most calls interpolate `X-Plex-Token` into the URL, call global `fetch`, use a 30-second
`AbortSignal.timeout`, then wait 100 ms. There is no single request/error/redirect policy. A few
collection requests already use a token header, demonstrating inconsistent behavior. Auth errors,
status errors, response-body inclusion, and mutation result handling vary by endpoint family.

Machine identifier state is a separate module-level cache inside `plex.ts`. The exported
`clearMachineIdentifierCache()` and re-exported `clearPlexCache()` exist primarily for test cleanup.

### Types, filters, ratings, and pagination

`types/plex.ts` combines multiple layers in one public file:

- Plex protocol constants (`8`, `9`, `10`) and mappings.
- Plex-shaped domain entities with `ratingKey`, `userRating` on `0..10`, `viewCount`, and
  millisecond `duration`.
- Query page results with distinct item keys (`tracks`, `albums`, `artists`), `totalSize`, offset,
  optional pre-filter `pageItemCount`, and `hasMore`.
- Public command/action options and results for copy, playlist, metadata sync, and collections.

This mixture means protocol types cannot simply be deleted. Command/action option and result types
that form the external contract may remain Plex-branded, while network DTOs move to private
`adapters/plex/types.ts` and generic entities/pages move to `types/media-server.ts`.

`types/plex-filters.ts` is a well-formed recursive discriminated union (`rule` versus `group`) with
type guards, named-config filters, and documented star-scale semantics. It should be generalized by
moving the structural AST to `types/media-filters.ts` and retaining Plex aliases/config naming at
the compatibility edge.

`lib/plex-filter-evaluator.ts` contains both reusable residual evaluation and Plex pushdown
planning. It exports:

- field extraction and rule/group evaluation;
- complete filter evaluation;
- extraction of server-compatible conditions and query variants;
- client-side-filtering detection;
- evaluation that skips already-applied server conditions.

The pure evaluator belongs in `lib/media-filter-evaluator.ts`. Plex query parameter/operator
translation belongs in the private Plex mapper/client layer. Actions may coordinate variant pages,
but should not know Plex operator spelling or numeric codes.

`lib/plex-pagination.ts` is a 41-line pure forward-progress guard. It correctly prefers the server's
pre-residual `pageItemCount`, falls back to returned array length, and throws if `hasMore` is true
without progress. Generalize it to `lib/pagination.ts` without changing behavior.

`lib/ratings.ts` already uses normalized `0..1` values for files and provides star and Plex
conversions. `normalizedToPlex()` and `plexToNormalized()` currently live in the generic file,
while actions call them directly. Preserve the generic normalized/star functions there; move Plex
wire conversion behind the adapter mapper. Define and validate the unrated representation once:
the feature spec chooses `number | null` generically, while persisted/public Plex compatibility
continues to use `0..10` and existing zero/unrated behavior.

### Cache implementation

`lib/plex-cache.ts` has a process-global `Map<string, PlexCacheEntry>`. Every read and write consults
`getLoadedConfig()` dynamically; enabled defaults false and an omitted enabled TTL defaults to 300
seconds. Callers build keys as `${config.url}::${category}::${discriminator}`. Tokens are correctly
excluded, but authorization identity is not, so two credentials for the same URL can share values
in a long-lived process.

Only libraries, playlists, and collections are documented cached reads. Successful playlist and
collection mutations invalidate category prefixes. Cache hits avoid both network work and the
100 ms pacing delay. `plex-cache.test.ts` already covers disabled behavior, hit/miss, fake-timer TTL,
prefix invalidation, default/custom TTL, and cleanup. Move these tests to an adapter-local cache
whose constructor captures enabled/TTL state and accepts a clock.

### Actions and compatibility edges

`actions/plex-query.ts` is the largest orchestration boundary for generic migration:

- It merges CLI options, named filters, default filters, and library/type defaults.
- It expands server query variants for OR logic, records conditions already pushed down, and runs
  residual filtering.
- It initializes SQLite by default, saves the query definition and Plex-shaped result rows, and
  returns one of three Plex page shapes plus optional `queryId`.
- It should query generic pages internally, then project `id`, normalized rating, entity kind, and
  fields to the unchanged Plex result and database shapes.

`actions/plex-copy.ts` consumes either saved `DbPlexQueryResult` rows or live Plex queries, extracts
paths, performs filesystem operations, optionally syncs ratings, and resolves a best-effort scan.
Local path extraction belongs in a generic action helper; saved-row conversion remains a persistence
projection.

`actions/plex-playlist.ts` wraps adapter calls in Plex-named local functions and directly imports
Plex filters, entities, query pages, and the pagination helper. It owns copy/sync behavior, file
layout, progress, scan orchestration, and playlist business rules. Those remain in the action;
machine-ID URI composition, Plex item IDs, and `0..10` conversion move into the adapter.

`actions/plex-collection.ts` has similar wrapper functions but additionally exposes Plex numeric
media-code conversion and passes `machineId` plus `ratingKeys` to `collection.addItems()`. The
generic capability should accept collection ID and generic item IDs. The adapter obtains/caches its
machine identifier and builds Plex URIs privately.

`actions/plex-sync.ts` paginates the whole library, maps tracks by local path, reads/writes file
ratings, and performs comparisons. It currently imports `normalizedToPlex()` and
`plexToNormalized()` and sends Plex-scale values through `metadata.updateTrackRating()`. After
migration it should compare normalized ratings and pass `number | null`; only the adapter converts
to Plex scale.

`actions/playlist.ts` is the server-neutral playlist workflow in name, but its remote track seam is
still `PlexTrack`. It should consume `MediaTrack` while preserving its local playlist and database
behavior.

`commands/plex.ts` is a deliberate Plex-branded compatibility boundary. It statically defines the
Commander hierarchy and JSON output envelopes, while action imports are lazy inside handlers.
Existing command options, `plex-*` JSON discriminators, field names, tables, messages, and exit
behavior must not change. Compatibility mapping should happen before formatting rather than by
making generic internals carry Plex names.

`mcp/schema.ts` and `mcp/adapters.ts` currently accept and forward URL/token overrides and expose
Plex result fields. The feature spec freezes schemas and fields for #119, so apply the same
origin/token provenance rule as the CLI and do not add new auth fields. Any later removal of raw MCP
credentials is a separate compatibility decision.

`lib/db.ts` and `types/db.ts` define the fixed SQLite compatibility boundary. `plex_queries` and
`plex_query_results` persist `rating_key`, `media_type`, `user_rating`, `view_count`, and related
fields. `savePlexQueryResults()` expects `PlexQueryResultItem`. Do not migrate schema or rename
tables/columns; add pure projections in the action/persistence edge.

## Implementation Patterns with Examples

### Grouped capability objects

Keep the current composition style, but type it with generic domain values:

```typescript
readonly query: MediaServerQueryCapability = {
  tracks: (options) => this.queryTracks(options),
  albums: (options) => this.queryAlbums(options),
  artists: (options) => this.queryArtists(options),
  albumTracks: (albumId) => this.getAlbumTracks(albumId),
};
```

The object groups give actions a narrow dependency and avoid one oversized flat interface. File
existence checks should not remain a remote-server capability.

### Discriminated unions and explicit projections

The codebase prefers discriminated unions and exhaustive switches. Generic entities should follow
the same convention:

```typescript
type MediaEntity = MediaTrack | MediaAlbum | MediaArtist;

interface MediaTrack {
  readonly kind: "track";
  readonly id: string;
  readonly rating: number | null;
  // track-only fields
}
```

Avoid a single type with many optional properties. At Plex-branded edges, use small pure functions
such as `toPlexQueryResultItem(entity)`; do not scatter `rating * 10` and `id -> ratingKey`
conversions through actions and formatters.

### Constructor injection for private infrastructure

The current test suite stubs global `fetch`, config, and timers. The new private layer should accept
small dependencies while production defaults remain native:

```typescript
interface PlexClientDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
}
```

Inject the token provider, client, cache/clock, and possibly pacing delay. This makes tests assert
headers, redirect mode, cancellation, TTL, and no-request rejection without global coupling.

### Typed errors with compatible presentation

The repository has established custom `Error` subclasses in `lib/errors.ts`, while current Plex
commands mostly render `error.message` with operation-specific prefixes and MCP uses
`normalizeMcpError()`. Add a typed `MediaServerError` with stable reason, operation, server type,
optional status, and retryability. Keep existing command recovery wording through a presenter or
carefully compatible messages. Actions must branch on structured fields, never string matching.

The transport is the only place that should map `401`, `403`, `404`, `429`, `498`, timeout,
network, invalid response, and generic HTTP failure. It must sanitize before formatting and bound
any response excerpt.

### Required versus optional resolution

Preserve the current explicit matrix:

```text
optional + scan disabled             -> undefined, no warning
optional + requested + invalid       -> warning, undefined
required + missing connection        -> throw
required + invalid URL               -> throw
```

Add provenance cases:

```text
configured origin + configured token             -> allowed
same-origin URL override + configured token       -> allowed
different-origin URL override only                -> reject/no request
different-origin URL + explicit token             -> allowed
token override + configured origin                -> allowed
```

Canonical comparison must use parsed `URL.origin`, including default-port normalization, not raw
strings. Reject username/password, query, and fragment in configured base URLs; preserve legitimate
HTTP, loopback, and LAN Plex endpoints.

### Test style

Tests are colocated Vitest files. Existing conventions are:

- define module-scope mocks with `vi.hoisted()` before `vi.mock()`;
- use `vi.clearAllMocks()` in `beforeEach()` to preserve implementations;
- use `mockReset()` only for a particular mock whose queued behavior must be cleared;
- use fake timers for deterministic TTL tests and restore real timers in `afterEach()`;
- isolate config loading and databases; close SQLite before deleting temporary directories;
- use explicit `.js` specifiers even in TypeScript source;
- prefer literal wire fragments and response helpers over `any`.

Convert `media-server-fixtures.ts` first to canonical generic entities/pages, then update
`media-server-adapter-mocks.ts`. A compile-only fake adapter that imports no Plex or database types
is the clearest contract test.

## Integration Points

### Files to create

| File                                | Responsibility                                                                               | Depends on                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `src/types/media-filters.ts`        | Generic recursive filter AST, fields, guards, named structural types                         | Generic media kinds only                              |
| `src/lib/media-filter-evaluator.ts` | Pure residual evaluation and provider-neutral filter planning inputs                         | Generic filters/entities                              |
| `src/lib/pagination.ts`             | Current forward-progress rule under a generic name                                           | No provider modules                                   |
| `src/lib/media-file-paths.ts`       | Extract and optionally validate local track/result paths                                     | Generic tracks plus narrow saved-row projection input |
| `src/lib/adapters/plex/auth.ts`     | Async token-provider contract and static opaque provider                                     | No JWT parsing/dependency                             |
| `src/lib/adapters/plex/client.ts`   | Sole Plex `fetch`, URL, auth-header, redirect, timeout, pacing, body bound, and error policy | Token provider, typed errors                          |
| `src/lib/adapters/plex/cache.ts`    | Per-adapter TTL cache with captured config and injected clock                                | No loaded-config singleton                            |
| `src/lib/adapters/plex/mappers.ts`  | Wire validation, entities, rating conversion, media codes, query encoding                    | Private wire types plus generic domain                |
| `src/lib/adapters/plex/types.ts`    | Private connection, request, and Plex wire DTOs                                              | Platform types only                                   |

Every new module needs a colocated test. If endpoint-family modules are needed to keep
`plex-adapter.ts` reviewable, place them under `lib/adapters/plex/`; they are implementation details
of the adapter, not parallel public facades.

### Files to modify

| File group                                                 | Required change                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `types/media-server.ts`                                    | Define generic entities, pages, queries, features, normalized ratings, and grouped capabilities without Plex/DB imports |
| `types/plex.ts`, `types/plex-filters.ts`, `types/index.ts` | Separate public compatibility/action types from private wire types; retain deliberate aliases/exports                   |
| `lib/adapters/plex-adapter.ts`                             | Compose the private client/cache/mappers and own every endpoint behavior                                                |
| `lib/adapters/index.ts`                                    | Build immutable origin-bound connection settings; preserve optional/required behavior and precedence                    |
| `lib/adapters/action-helpers.ts`                           | Resolve adapters and generic local paths without `lib/plex.ts` or Plex entity imports                                   |
| Plex actions and shared `actions/playlist.ts`              | Consume generic IDs/entities/pages/ratings; retain orchestration, file, DB, progress, confirmation, and dry-run duties  |
| `commands/plex.ts`, MCP files, DB projection sites         | Preserve Plex-branded inputs/outputs through explicit pure conversion                                                   |
| fixtures/mocks and existing tests                          | Move behavioral coverage to generic helpers, private client/cache/mappers, adapter, and compatibility boundaries        |
| architecture script/package validation                     | Detect all forbidden production bypass imports/fetches, not only exact action imports                                   |
| adapter/config/cache/filter/sync docs and README           | Describe final ownership, header auth, provenance rule, generic contract, and compatibility                             |
| `ROADMAP.md`                                               | Mark #119 and its PR shipped without completing dependent features                                                      |

### Files to delete after their tests move

- `src/lib/plex.ts`
- `src/lib/plex-cache.ts`
- `src/lib/plex-filter-evaluator.ts`
- `src/lib/plex-pagination.ts`

Do not delete a module before all its externally observable cases have a new test owner. In
particular, migrate query parsing/filtering, machine-ID caching, scan fallback, rating results,
playlist batches, collection fallback/batches, mutation invalidation, and error behavior.

### Shell completions

No command, alias, option, or candidate changes are designed. Therefore Bash, Zsh, and Fish static
templates should not be edited. Run `src/lib/shell-completions/templates.spec.ts` and command-help
tests to prove parity and that completion generation performs no adapter construction or request.

## Code Conventions

- TypeScript is strict with `noUncheckedIndexedAccess`; never use `any`. Narrow `unknown` Plex wire
  values with guards and check indexed values before use.
- Use ESM imports with explicit `.js` extensions.
- Prefer `import type` for type-only dependencies so the production graph remains clear.
- Add JSDoc to exported functions, including parameters, return values, and thrown conditions.
- Throw configuration/query/CRUD failures early. Preserve result-object semantics for scan and
  rating operations because actions rely on them.
- Keep commands as input validation, lazy action dispatch, and presentation. Keep actions as
  orchestration. Keep protocol, wire mapping, auth, and caching inside the adapter layer.
- Preserve readonly arrays/inputs at the contract; copy only at a private API boundary that needs a
  mutable array.
- Retain dry-run and confirmation before mutation. Never invalidate caches for a dry run or failed
  write.
- Avoid logging secrets or constructing secret-bearing URLs. Debug output is not an exception.
- Keep config and output backwards compatible; add no JWT flag, provider discovery, API-version
  header, new generic command namespace, or database migration.

## Dependencies and Services

### Runtime/platform dependencies

- Node 22 native `fetch`, `URL`, `URLSearchParams`, `Headers`, `AbortSignal`, and cancellation are
  sufficient. Add no third-party Plex SDK.
- The current build uses TypeScript and copies `schema.sql`; this feature does not change build
  packaging or database schema.
- `commander`, `console-table-printer`, `picocolors`, and `@rfmedia/common` remain outer command/MCP
  dependencies only.
- Loaded config remains the source for the existing `plex.*`, `plexFilters`, scan, library mapping,
  page-size, rating-sync, and cache options. Capture adapter-specific cache/connection values at
  construction rather than reading globals per operation.
- Automatic Plex JWT enrollment/refresh, Ed25519/JWK storage, PIN authorization, and `jose` are the
  linked child issue. #119 treats either a legacy token or a pre-issued JWT as an opaque value.

### External service behavior

- Plex requests use relative paths resolved against one normalized base URL.
- Send tokens only as `X-Plex-Token`; request JSON with `Accept: application/json`.
- Set `redirect: "error"`; never forward credentials after a redirect.
- Preserve 30-second per-request timeout and 100 ms delay for live requests. Cache hits skip delay.
- Preserve response-driven pagination and zero-progress failure.
- Do not opt into a new PMS API version in this refactor.
- Sonic Analysis is metadata (`server-dependent`) only; there is no operation to expose.

### Validation commands

The package scripts provide:

```bash
npm run typecheck -w packages/rfmedia-cli
npm run build -w packages/rfmedia-cli
npm run test:run -w packages/rfmedia-cli
npm run test:coverage -w packages/rfmedia-cli
node packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs
```

Also run focused client/cache/mapper/adapter/action/command/completion suites while migrating,
followed by `git diff --check`, markdown validation, and `graphify update .` per repository policy.

## Gotchas and Warnings

1. **Do not preserve a second network path.** Moving functions to private modules is acceptable,
   but `lib/plex.ts` cannot remain a callable transport facade at merge.
2. **Do not compare raw URL strings.** Scheme/host case, default ports, and trailing slash variants
   must resolve to the same canonical origin; embedded credentials/query/fragment must be rejected.
3. **Do not use `isSecurePlexUrl()` as the policy.** Private and loopback Plex servers are core use
   cases, and the existing blocklist is neither complete SSRF protection nor compatible.
4. **Do not put a token in a URL, cache key, log, error, test name, or snapshot.** Assert absence
   semantically in tests.
5. **Do not share cache state by URL alone.** Adapter-local cache is the simplest credential
   isolation. Capture enabled/TTL once and invalidate successful playlist/collection mutations.
6. **Do not infer JWT claims or expiration from token shape.** The static provider sends opaque
   input and does not refresh or retry a mutation.
7. **Do not conflate capability with authorization.** Features say the adapter implements an
   operation; 401/403 must still be surfaced as typed failures.
8. **Do not advance pages by the residual-filtered array length when Plex reports a pre-filter
   count.** That causes duplicates, skips, or stalls. Preserve `pageItemCount` semantics.
9. **Do not lose zero/unrated semantics during normalization.** Exhaustively test null/unrated,
   zero compatibility values, half stars, maximum, and invalid/out-of-range values.
10. **Do not pass machine IDs through the generic collection API.** The Plex adapter should fetch,
    cache, and use its own server identity for URI construction.
11. **Do not move file, database, progress, confirmation, or dry-run work into the adapter.** Those
    are action responsibilities.
12. **Do not edit completion templates for an internal refactor.** A diff in candidates signals
    accidental public CLI drift.
13. **Do not use `vi.resetAllMocks()` indiscriminately.** Existing hoisted implementations will be
    erased and suites may fail only in aggregate.
14. **Do not trust old tests that assert query-string tokens.** Replace those assertions with
    header-only authentication and negative URL/redaction checks while preserving endpoint/query
    semantics.
15. **Watch test ownership during deletion.** `plex.test.ts`, `plex-collection.test.ts`, cache,
    filter-evaluator, and pagination tests collectively encode more behavior than the thin adapter
    tests.

## Task-Specific Guidance

### Foundation task

- Introduce generic media/filter/page/feature/error types first.
- Generalize pagination, residual filter evaluation, and path extraction as pure modules.
- Convert shared fixtures and mocks immediately so subsequent action changes compile against the
  intended contract.
- Add a fake non-Plex adapter compile test and an import assertion proving the generic layer has no
  Plex or DB dependency.
- Preserve Plex public types as compatibility aliases/projections where external imports require
  them; do not let those aliases backflow into generic production code.

### Private Plex infrastructure task

- Create the static async token-provider seam, immutable normalized connection, central client,
  private wire DTOs/guards, mappers, and per-instance cache.
- Test header auth, stable request headers, relative-path resolution, encoded identifiers,
  `redirect: "error"`, timeout/caller cancellation, pacing, typed statuses, body truncation,
  control-character sanitization, and no secret leakage.
- Test connection provenance at the factory before endpoint migration: cross-origin URL-only
  overrides must throw/skip as appropriate and invoke fetch zero times.
- Keep live-request pacing in the client so endpoint methods and cache hits cannot accidentally
  double-delay.

### Endpoint migration task

- Move one capability family with its tests before starting the next: query/library/scan/rating,
  playlists, then collections.
- For every family, preserve exact endpoint/query semantics, response defaults, result-object versus
  throw behavior, pagination, batches, partial-failure behavior, and mutation invalidation.
- Keep Plex media codes, `server://` URIs, machine identifier, rating scale, and wire keys private.
- Add truthful features: native rating range/step, rating reads/writes, smart containers, path scan,
  pushdown descriptors, and `server-dependent` Sonic Analysis.

### Consumer migration task

- Migrate query action and persistence projection first because other copy/container workflows
  reuse its query semantics.
- Then migrate copy/path/filter consumers, followed by playlist, collection, sync, and shared
  playlist consumers.
- Preserve action option/result types and outer field names until the command/MCP/DB projection.
- Keep existing lazy command imports and error prefixes. Add compatibility snapshots or structured
  assertions for help, JSON discriminators/fields, MCP schema/result, SQLite rows, and exit intent.

### Deletion and enforcement task

- Enumerate every production `fetch` and forbidden Plex implementation import. The final audit
  should allow authenticated Plex HTTP only under `lib/adapters/plex/` and ensure generic modules do
  not import Plex modules.
- Delete the four legacy modules only after their behavioral tests have migrated and all consumers
  compile.
- Run focused suites after each deletion, then full tests, coverage, typecheck, build, architecture
  audit, completion parity, docs/markdown checks, `git diff --check`, and graph update.
- Update adapter/config/cache/filter/sync docs to point at the new ownership boundary and header
  auth. Update `ROADMAP.md` with the shipped PR while leaving dependent work open.
