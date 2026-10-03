# Plex-Lidarr Identity Mapping: Code Analysis

## Executive Summary

Issue #207 fits the repository as four narrow layers: public provider-neutral contracts, a private
Plex identity endpoint family, a pure bridge resolver/expansion calculator, and a dedicated SQLite
snapshot owner. The implementation must reuse the existing Plex transport and Lidarr facade; bridge
code should receive only projected values and must remain network-free.

The strongest existing patterns are fresh frozen projections from `unknown`, capability composition
around injected private dependencies, deterministic pure evidence with checked arithmetic, and
feature-owned parameterized SQLite CRUD. Two precedents must not be copied unchanged:
`findBestMatch()` logs and chooses a single winner, while `readLidarrCache<T>()` casts parsed JSON to
`T`; #207 requires suggestion-only fuzzy outcomes and strict cache reprojection.

## Existing Code Structure

- `packages/rfmedia-cli/src/types/media-server.ts`: capability-oriented provider-neutral adapter.
  All current capabilities are required; #207 adds an optional identity capability so non-Plex
  implementations and existing consumers remain valid.
- `packages/rfmedia-cli/src/types/lidarr.ts`: `LidarrArtist` already carries local `id`,
  `artistName`, and `foreignArtistId`.
- `packages/rfmedia-cli/src/types/db.ts`: `DbConnection` is the direct
  `better-sqlite3` connection type; row interfaces use database column names.
- `packages/rfmedia-cli/src/types/index.ts`: public type barrel. Media-server types are explicitly
  re-exported; bridge domain contracts belong here, but private Plex/cache row types do not.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`: Plex composition root. It constructs one
  origin-bound `PlexClient`, one adapter-local response cache, and endpoint families that share
  those instances.
- `packages/rfmedia-cli/src/lib/adapters/plex/client.ts`: sole authenticated Plex request owner.
  `PlexTransport.request<T>()` accepts a relative path, operation label, structured query, and
  optional abort signal; it rejects redirects, bounds bodies, sanitizes errors, and sends the token
  only in `X-Plex-Token`.
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`: library resolution, structured
  `/library/sections/{id}/all` requests, page validation, forward-progress checks, and the private
  cached machine-identifier seam.
- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`: private Plex wire types and
  `unknown` guards. This is the correct owner for bounded `Guid` wire fields; ordinary query DTOs
  should remain unchanged.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: stable handwritten facade and sole generated SDK
  importer. `listArtists(signal?)` already returns the complete projected artist collection.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: validates generated results and returns fresh,
  deeply frozen domain values. Its artist guard checks `foreignArtistId` as a terminal-safe label,
  not as an artist MBID.
- `packages/rfmedia-cli/src/lib/fuzzy-match.ts`: exposes the installed Levenshtein implementation,
  but its winner helpers have weak defaults, first-winner behavior, and per-comparison logging.
- `packages/rfmedia-cli/src/lib/lidarr/audit-identity.ts`: pure O(n) duplicate bucketing and useful
  normalization fixtures; its accent/article folding is audit policy, not a shared bridge policy.
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`: sole-owner, parameterized SQLite CRUD,
  injected clock, origin isolation, and upsert/purge precedent.
- `packages/rfmedia-cli/src/lib/db.ts`, `schema.sql`, and `migrations.ts`: schema initialization,
  compatibility preflight, exact read-only version gate, and sequential migrations.
- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`: precedent for a synchronous pure
  calculator that validates safe integers, preserves unknown evidence, emits stable codes, and
  deeply freezes output.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: production-tree architecture gate
  for private Plex imports, generated Lidarr imports/re-exports, handwritten Lidarr paths, and
  authenticated `fetch` ownership.

## Implementation Patterns with Examples

### Capability composition and dependency injection

`PlexAdapter` constructs private dependencies once and passes narrow seams to endpoint families:

```ts
const transport = new PlexClient(connection, tokenProvider);
const cache = createPlexResponseCache(connection.cache);
const queryLibrary = createPlexQueryLibraryFamily({ transport, cache, ... });
```

Follow this shape for `createPlexIdentityCapability(...)`. Inject `PlexTransport`, the library
resolver (or capability), `getMachineIdentifier`, page size, and optionally the adapter-local cache.
Do not read configuration or create another client inside `plex/identity.ts`. Expose the resulting
capability as `adapter.identity`; keep the machine identifier obtainable only through
`identity.getInstanceId()`, never as an enumerable adapter/config property.

The shared adapter mock uses a mapped type to preserve exact method signatures:

```ts
type MockedCapability<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};
```

Add optional identity input/output to that helper once instead of creating bridge-specific mock
classes. The default should represent absence or an empty page without forcing every existing test
to configure identity.

### Strict private provider projection

Plex endpoint modules request `unknown`, validate the envelope and every item, then map only consumed
fields:

```ts
const response = await transport.request<unknown>({ path, operation, options });
if (!isPlexWireMetadataResponse(response, isPlexWireArtistIdentity)) {
  throw invalidResponse(operation, "Plex returned malformed artist identity metadata");
}
```

Add a private wire identity shape rather than widening `PlexWireArtist` used by generic query.
Bounds must cover item count, title length, GUID count, and GUID length. Accept only the consumed
GUID object shape and MusicBrainz artist scheme; unknown providers are ignored, while malformed or
multiple distinct artist MBIDs make that source identity conflicting. Construct fresh frozen
provider-neutral values so no wire array/reference escapes.

Use the existing request pattern:

```ts
{
  path: `/library/sections/${encodedSectionId}/all`,
  operation: "list Plex artist identities",
  options: {
    method: "GET",
    signal,
    query: {
      type: 8,
      includeGuids: 1,
      "X-Plex-Container-Start": offset,
      "X-Plex-Container-Size": limit,
    },
  },
}
```

Resolve the configured library to its stable section `id`; return that ID in page/snapshot scope.
Calculate paging from the server's response `offset`, raw returned count, and `totalSize`, and call
`advancePaginationOffset()` so `hasMore` plus zero returned items fails rather than looping.

### Stable Lidarr facade boundary

Consume `LidarrClientApi.listArtists(signal)` unchanged. It calls the generated `GET artist`
operation and `projectLidarrArtistArray()`, which rejects duplicate local IDs and returns a frozen
complete list. The resolver must still canonicalize and validate `foreignArtistId` as an artist
UUID because the existing guard only enforces a bounded safe label.

Bridge modules must not import `lib/lidarr/generated/**`, add `/api/v1/` literals, or construct an
endpoint. The numeric Lidarr `id` is a target locator/evidence field; the canonical lowercase
artist MBID is identity.

### Pure deterministic resolver

Model ordinary uncertainty as discriminated data, not thrown exceptions. Resolve in explicit order:

1. Strictly canonicalize provider artist MBIDs to lowercase.
2. Detect malformed, contradictory, or duplicate authoritative evidence.
3. Resolve only a unique one-to-one MBID join automatically.
4. When no authoritative MBID exists, score a bounded candidate set.
5. Return `suggested` only when score is at least `0.90` and the lead over runner-up is at least
   `0.08`; names never produce `resolved`.
6. Return `ambiguous`, `unmatched`, `conflict`, or `unavailable` with stable reason codes.

Use `fastest-levenshtein` directly behind bridge-local normalization. Do not call
`findClosestMatch()`/`findBestMatch()` and do not import `foldArtistName()`: those policies choose
winners or normalize differently. Rank all retained candidates deterministically by score
descending, normalized title, then opaque/local ID; bound output and comparison work. Return fresh
frozen candidates/snapshots and never log raw names per comparison.

### Checked expansion evidence

Mirror `cascade-analysis.ts`: validate non-negative safe integers, deduplicate identifiers with
`Set`, use checked addition, derive rather than accept flags, and freeze nested output. A target
album with unknown track count makes `trackExpansionRatio` `null` and `complete` false; never use
zero as a substitute. Avoid importing `LidarrPlanValidationError` or cascade-specific contracts
just to reuse arithmetic.

### Dedicated strict SQLite snapshot

Mirror the ownership and binding style of `metadata-cache.ts`, but not its generic cast:

```ts
const row = db.prepare("SELECT ... WHERE ... = ?").get(...scopeValues);
const parsed: unknown = JSON.parse(row.payload_json);
const snapshot = projectBridgeArtistIdentitySnapshot(parsed);
```

Check `Buffer.byteLength(row.payload_json, "utf8")` before parsing, validate timestamps and both
snapshot/resolver versions, and strictly reproject every nested value. Invalid/incompatible stored
evidence must never be cast to the domain type. Validate the complete in-memory snapshot before
opening the replacement transaction; perform one parameterized upsert so a failed refresh preserves
the previous row. An injected `now?: () => Date` is the established deterministic clock seam.

## Integration Points (files create/modify)

### Create

- `packages/rfmedia-cli/src/types/bridge.ts`: external-ID, identity page, resolution union,
  candidates, complete snapshot/scope, expansion input/output, stable reason/version constants,
  and cache error contract.
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`: private bounded GUID acquisition and
  projection using injected Plex seams.
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.test.ts`: wire/provider/pagination/abort and
  instance/library-scope tests using a fake `PlexTransport`.
- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`: pure MBID-first resolver, bridge-local fuzzy
  policy, and expansion calculator.
- `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts`: table-driven exact/conflict/suggestion/
  ambiguity/order/boundary/immutability/expansion tests.
- `packages/rfmedia-cli/src/lib/bridge/cache.ts`: sole snapshot table CRUD and strict
  unknown-to-domain projector.
- `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`: real temp-file SQLite round-trip,
  replacement, corruption, scope isolation, rollback, and purge tests.

Do not add a `lib/bridge/index.ts`, repository class, provider registry, command, presenter, prompt,
or MusicBrainz client.

### Modify

- `packages/rfmedia-cli/src/types/media-server.ts`: add provider-neutral identity records/page and
  `MediaServerIdentityCapability`; make `MediaServerAdapter.identity` optional. If a capability flag
  is added, it must also be optional/additive so existing literal adapters remain source-compatible.
- `packages/rfmedia-cli/src/types/index.ts`: export public bridge and identity types/constants only.
- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`: add private bounded GUID/identity wire
  contracts and guards.
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`: expose only the narrow library
  lookup/instance seams required by the private identity family, or compose identity alongside this
  family without making machine identity public.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`: create identity from the same transport,
  cache, library resolver, and machine-ID seam; retain frozen adapter composition.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts`: assert identity composition while
  proving token/raw GUID/machine-ID leakage is absent and ordinary capability shapes still work.
- `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts`: typed optional
  identity mock seam.
- `packages/rfmedia-cli/src/lib/schema.sql`: add `bridge_identity_snapshots`, full scope uniqueness,
  positive version checks, `entity_kind = 'artist'`, and fresh-schema version `11`.
- `packages/rfmedia-cli/src/lib/migrations.ts`: set `CURRENT_SCHEMA_VERSION = 11` and add the
  sequential v10-to-v11 branch.
- `packages/rfmedia-cli/src/lib/db.ts`: set `SUPPORTED_READ_ONLY_SCHEMA_VERSION = 11` and update
  schema-version documentation.
- `packages/rfmedia-cli/src/lib/db.test.ts`: fresh v11, v10 migration with preserved data,
  exact read-only v11 acceptance, v10 rejection, and v12 future-schema rejection.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and its test: ensure
  `lib/bridge/**` receives no provider/generated/fetch exemption and keep the real-tree audit.
- `ROADMAP.md` and `docs/roadmap-archive.md`: archive #207 and make #208 the next Layer 3 item.

No changes are required to Lidarr generated code/OpenAPI, dependencies, commands, config, Bash/Zsh/
Fish completions, README CLI surface, or the reserved `plex-alignment` audit slot.

## Code Conventions

- NodeNext ESM imports use `.js` specifiers even from TypeScript.
- Public contracts use `readonly`; runtime producers use `Object.freeze()` for the outer object,
  nested objects, and copied arrays.
- Parse external/storage values as `unknown`; guards validate only consumed fields and project new
  objects rather than retaining provider references.
- Use `satisfies` for static capability/feature objects when it preserves literal types.
- Errors have stable codes/operation labels and bounded sanitized messages; never include tokens,
  API keys, raw response bodies, raw GUID URLs, or full candidate names in diagnostics.
- SQL values are positional parameters. One feature module owns every statement for its table.
- Tests use Vitest `describe`/`it`/`it.each`, direct object assertions, and fixed fixtures. Plex
  endpoint tests fake `PlexTransport`; DB tests use real temporary files, never `:memory:`, and
  clean up in `afterEach`.
- Keep test ownership layered: wire tests own malformed Plex data, resolver tests own policy,
  cache tests own persistence/corruption, and one adapter test owns composition.

## Dependencies and Services

- `fastest-levenshtein`: reuse only its `distance` function; bridge code owns normalization,
  thresholds, runner-up margin, ordering, and comparison bounds.
- `better-sqlite3`: reuse prepared statements and `db.transaction()`; no ORM or migration framework.
- Plex PMS: only `GET /`, `GET /library/sections`, and bounded
  `GET /library/sections/{sectionId}/all?type=8&includeGuids=1` through `PlexTransport`.
- Lidarr: only existing `LidarrClientApi.listArtists()` through the stable generated-client facade.
- MusicBrainz: identifier syntax only; no network request, SDK, rate limiter, or new credential.

## Gotchas and Warnings

- The current database version lives in `metadata(key = 'schema_version')`, not a table named
  `schema_meta` as stated in `shared.md`.
- `initializeDatabase()` executes `schema.sql` before `runMigrations()`. Therefore the v11 table is
  normally created idempotently by schema execution for a v10 database; the migration branch still
  must advance metadata and document/verify the transition.
- `INSERT OR IGNORE ... schema_version = '11'` changes only fresh databases. Existing v10 rows
  require the explicit migration update.
- Writable `CURRENT_SCHEMA_VERSION` and exact read-only
  `SUPPORTED_READ_ONLY_SCHEMA_VERSION` must advance together. After the bump, tests representing a
  future schema must use v12, not v11.
- The schema/table scope must include both canonical credential-free origins, Plex machine ID,
  stable library section ID, and entity kind. Origin or display name alone permits cross-instance
  contamination.
- Existing `PlexCacheCategory` already uses `"identity"` for the server machine ID. Do not put the
  durable bridge snapshot into this adapter-local response cache or `lidarr_metadata_cache`.
- The Plex client already caps the full response body at 8 MiB, but that does not bound GUID array
  cardinality, individual strings, or fuzzy comparison count.
- `LidarrArtist.foreignArtistId` is not guaranteed canonical by its existing projector. Validate
  entity semantics and lowercase form inside the bridge.
- Duplicate Lidarr local IDs are rejected by `projectLidarrArtistArray()`, but duplicate MBIDs are
  allowed and must become a bridge `conflict`.
- Case-insensitive library lookup returns the library `id`; cache scope must use that stable ID, not
  the configured/title string.
- `findBestMatch()` logs every comparison and tie behavior depends on input order. It is unsafe for
  this feature.
- JSON parsing success is not domain validation. Corrupt, oversized, or incompatible snapshot
  payloads must not cross via `as BridgeArtistIdentitySnapshot`.
- A cached or fuzzy outcome is evidence only. #207 must not add an apply path or imply authorization
  for later mutation.
- Expansion ratio is `null` when target counts are incomplete. Check safe-integer overflow before
  addition and before forming a finite ratio.
- `docs/roadmap/archive.md` in the planning inputs does not exist in this worktree; the repository's
  actual archive is `docs/roadmap-archive.md`.

## Task-Specific Guidance

1. Define the provider-neutral frozen contracts and stable version/reason constants first. Keep v1
   artist-only; do not predeclare album MBID semantics.
2. Implement Plex wire guards and the identity endpoint around injected `PlexTransport`, stable
   library lookup, cached machine ID, structured query parameters, abort forwarding, and
   forward-progress validation.
3. Compose `adapter.identity` from existing private dependencies. Prove reflection/serialization
   exposes neither token nor raw provider identity data.
4. Implement one pure resolver with explicit MBID-first phases. Bound inputs/candidates/comparisons;
   produce deterministic candidate ordering and deeply frozen outcomes.
5. Add the pure expansion calculator beside the resolver, using distinct-ID set semantics and
   fail-closed incomplete evidence.
6. Add the dedicated snapshot table and strict cache owner. Validate before the transaction, upsert
   one complete row, reproject on read, and preserve the previous generation on failure.
7. Bump schema, migration, and read-only gates together; test fresh v11 and data-preserving v10
   upgrade with real files.
8. Extend architecture tests and run package/root/codegen/completion-parity validation, while making
   no completion-template edits. Keep `plex-alignment` reserved for #208.
