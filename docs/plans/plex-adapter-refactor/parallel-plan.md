# Plex Adapter Refactor Implementation Plan

Complete issue #119 as an ownership inversion in the existing feature worktree: establish a
provider-neutral media-server contract, build one private Plex auth/transport/cache/mapping stack,
move endpoint families behind `PlexAdapter`, and migrate consumers through explicit compatibility
projections. Preserve the established Plex CLI, config, MCP/JSON, SQLite, optional-scan, error, and
completion contracts while closing the cross-origin credential-inheritance vulnerability. Delete
all legacy Plex network/cache/filter/pagination bypasses only after their behavior and tests have a
new owner, then finish documentation, ROADMAP, graph, review, CI, merge, and cleanup. Automatic JWT
enrollment/refresh remains in linked child issue #251; #119 accepts supplied tokens/JWTs opaquely.

## Critically Relevant Files and Documentation

- docs/plans/plex-adapter-refactor/feature-spec.md: Resolved scope, architecture, security, and acceptance criteria.
- docs/plans/plex-adapter-refactor/shared.md: Validated source paths, patterns, tables, and required docs.
- docs/plans/plex-adapter-refactor/analysis-code.md: Concrete current behavior, code conventions, and migration gotchas.
- packages/rfmedia-cli/src/types/media-server.ts: Generic contract currently coupled to Plex/DB types.
- packages/rfmedia-cli/src/types/plex.ts: Mixed protocol, domain, action, and compatibility types.
- packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts: Public Plex facade currently delegating to the bypass.
- packages/rfmedia-cli/src/lib/adapters/index.ts: Factory modes, override precedence, and security-critical connection resolution.
- packages/rfmedia-cli/src/lib/plex.ts: Legacy endpoint behavior and regression inventory to migrate.
- packages/rfmedia-cli/src/lib/plex-cache.ts: Existing TTL and invalidation behavior to preserve privately.
- packages/rfmedia-cli/src/lib/plex-filter-evaluator.ts: Reusable residual evaluator mixed with Plex pushdown.
- packages/rfmedia-cli/src/lib/plex-pagination.ts: Existing response-driven forward-progress guard.
- packages/rfmedia-cli/src/actions/plex-query.ts: Query, filtering, pagination, persistence, and output projection.
- packages/rfmedia-cli/src/actions/plex-copy.ts: Live/saved path handling and optional scan semantics.
- packages/rfmedia-cli/src/actions/plex-playlist.ts: Playlist orchestration and query pagination.
- packages/rfmedia-cli/src/actions/plex-collection.ts: Collection media-code and machine-ID leakage.
- packages/rfmedia-cli/src/actions/plex-sync.ts: Plex rating conversion leakage.
- packages/rfmedia-cli/src/commands/plex.ts: Stable Commander and presentation contract.
- packages/rfmedia-cli/src/mcp/schema.ts: Stable MCP input/output compatibility contract.
- packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs: Architecture guard to broaden and enforce.
- packages/rfmedia-cli/docs/features/media-server-adapter.md: Existing adapter architecture and factory semantics.
- packages/rfmedia-cli/docs/features/plex-configuration.md: Config, precedence, scan, and secret behavior.
- packages/rfmedia-cli/docs/features/plex-api-caching.md: Cache defaults, categories, and invalidation.
- packages/rfmedia-cli/AGENTS.md: Mandatory package ESM, typing, action/command, test, and completion rules.
- ROADMAP.md: Sprint/backlog status and dependent issue sequencing.

## Implementation Plan

### Phase 1: Freeze Compatibility and Security Expectations

#### Task 1.1: Characterize Factory, CLI, and MCP Contracts Depends on [none]

**READ THESE BEFORE TASK**

- docs/plans/plex-adapter-refactor/feature-spec.md
- packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts
- packages/rfmedia-cli/src/commands/plex.test.ts
- packages/rfmedia-cli/src/mcp/schema.spec.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts
- packages/rfmedia-cli/src/commands/plex.test.ts
- packages/rfmedia-cli/src/mcp/schema.spec.ts

Add characterization coverage for required/optional adapter resolution, config/CLI precedence,
generated Plex command help/options/aliases, machine discriminators/fields, and the existing MCP
schema. Capture same-origin and explicitly paired override behavior without accepting the unsafe
cross-origin inherited-token case as correct. Preserve lazy command imports and run the three
focused suites; every assertion must remain useful after implementation rather than snapshotting
irrelevant formatting.

#### Task 1.2: Freeze MCP Forwarding and Three-Shell Candidates Depends on [none]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/mcp/adapters.spec.ts
- packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts
- docs/plans/plex-adapter-refactor/research-ux.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/mcp/adapters.spec.ts
- packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts

Lock current MCP result/override forwarding and all Plex candidates across Bash, Zsh, and Fish.
Ensure completion tests prove no adapter construction or network request is required. Do not edit
the three template implementations; a candidate diff is a regression unless later implementation
accidentally changes the public CLI and must be corrected. Run both focused specs.

### Phase 2: Establish the Provider-Neutral Foundation

#### Task 2.1: Define Generic Media Entities, Features, Pages, and Errors Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- docs/plans/plex-adapter-refactor/feature-spec.md
- packages/rfmedia-cli/src/types/media-server.ts
- packages/rfmedia-cli/src/lib/errors.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/types/media-server.test.ts

Files to Modify

- packages/rfmedia-cli/src/types/media-server.ts

Replace Plex/DB-shaped domain ownership with discriminated track/album/artist entities, opaque IDs,
generic libraries/playlists/collections, response-driven pages, normalized `0..1 | null` ratings,
feature descriptors, and typed media-server errors. Correct capability signatures so machine IDs,
Plex metadata codes, native ratings, and local file existence do not cross the boundary. Add a
minimal non-Plex fake adapter contract test with no Plex/DB imports. Preserve query/CRUD throw and
scan/rating result semantics; run the focused test. Temporary downstream type errors must remain
bounded to their declared migration owners and reach zero at Task 5.12's package-wide typecheck
barrier; Task 2.7 is only the focused fixture/type-contract barrier. Do not weaken the final
contract to make an intermediate task globally green.

#### Task 2.2: Generalize the Filter AST with Plex Compatibility Aliases Depends on [2.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/types/plex-filters.ts
- packages/rfmedia-cli/src/types/plex-filters.test.ts
- packages/rfmedia-cli/docs/features/plex-filters.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/types/media-filters.ts
- packages/rfmedia-cli/src/types/media-filters.test.ts

Files to Modify

- packages/rfmedia-cli/src/types/plex-filters.ts

Move the recursive filter AST, guards, complexity constraints, and media-domain fields to generic
names. Retain deprecated Plex aliases and the `plexFilters` configuration surface without creating a
new DSL. Keep Plex query-parameter spelling and metadata codes out of the generic file. Port guard
coverage and run the new plus existing filter type suites.

#### Task 2.3: Generalize Residual Filter Evaluation Depends on [2.1, 2.2]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex-filter-evaluator.ts
- packages/rfmedia-cli/src/lib/plex-filter-evaluator.test.ts
- packages/rfmedia-cli/src/types/media-filters.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/media-filter-evaluator.ts
- packages/rfmedia-cli/src/lib/media-filter-evaluator.test.ts

Extract pure field access, recursive rule/group evaluation, residual planning inputs, short-circuit
behavior, and complexity guards over generic entities and normalized ratings. Keep Plex pushdown
encoding private for the later query endpoint module. Port nested, missing-field, already-applied,
query-variant, and rating boundary cases; do not delete the old module yet.

#### Task 2.4: Generalize Response-Driven Pagination Depends on [2.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex-pagination.ts
- packages/rfmedia-cli/src/lib/plex-pagination.test.ts
- docs/plans/plex-adapter-refactor/research-technical.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/pagination.ts
- packages/rfmedia-cli/src/lib/pagination.test.ts

Move the current forward-progress algorithm to generic page metadata, using the server-returned
pre-residual count and rejecting `hasMore` without progress. Port all short-page, missing-total,
filtered-page, and stalled-page cases. Do not delete the Plex-named helper until consumers migrate.

#### Task 2.5: Move Local Media Path Checks Out of the Adapter Depends on [2.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/adapters/action-helpers.ts
- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/types/db.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/media-file-paths.ts
- packages/rfmedia-cli/src/lib/media-file-paths.test.ts

Files to Modify

- packages/rfmedia-cli/src/lib/adapters/action-helpers.ts

Create a provider-neutral local helper for live generic tracks and narrowly projected saved rows,
preserving existing path-existence and missing-path behavior. Remove filesystem work from the
server capability and stop action helpers from importing `lib/plex.ts` or Plex entities. Run the
new helper tests and relevant action-helper tests.

#### Task 2.6: Separate Plex Compatibility Types and Public Exports Depends on [2.1, 2.2]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/types/plex.ts
- packages/rfmedia-cli/src/types/index.ts
- docs/plans/plex-adapter-refactor/analysis-code.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/types/plex.ts
- packages/rfmedia-cli/src/types/index.ts
- packages/rfmedia-cli/src/types/plex-filters.test.ts

Retain only intentional Plex command/action result contracts and deprecated public aliases while
removing raw wire/domain ownership from public generic use. Export the new generic contract and
filter vocabulary deliberately; do not export future private adapter DTOs. Add exact compatibility
coverage for IDs, media kinds, rating projection expectations, and filter aliases. Run focused type
tests; downstream migrations may temporarily rely on explicit compatibility adapters only.

#### Task 2.7: Convert Canonical Adapter Fixtures and Mocks Depends on [2.1, 2.5, 2.6]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/test-helpers/media-server-fixtures.ts
- packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts
- packages/rfmedia-cli/src/actions/playlist-adapter.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/test-helpers/media-server-fixtures.ts
- packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts
- packages/rfmedia-cli/src/actions/playlist-adapter.test.ts

Convert shared fixtures to generic IDs, discriminated entities, normalized ratings, returned page
metadata, feature defaults, and corrected collection signatures. Keep the mock builder focused on
overridable grouped capabilities instead of exposing private Plex mechanics. Update the adapter
integration test and run it. This is the fixture barrier for consumer tests; run the focused suite
and type-level contract assertions, but defer the clean package-wide typecheck until all production
adapter/action consumers converge in Task 5.12.

#### Task 2.8: Centralize HTTP URL Format Validation Depends on [2.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/config.ts
- packages/rfmedia-cli/src/lib/config.test.ts
- packages/rfmedia-cli/src/lib/plex.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/http-url.ts

Files to Modify

- packages/rfmedia-cli/src/lib/config.ts
- packages/rfmedia-cli/src/lib/config.test.ts

Move reusable HTTP(S) URL parsing/format validation out of the legacy Plex facade without applying
the incompatible public-IP-only SSRF blocklist. Reject malformed protocols and preserve existing
config error messages, LAN/loopback support, and config tests. Remove the `./plex.js` import/mock
from config code/tests, expose a small typed normalization result that Task 4.5 can reuse, and run
`npm run test:run -w packages/rfmedia-cli -- src/lib/config.test.ts` plus scoped typecheck.

### Phase 3: Build the Private Plex Infrastructure

#### Task 3.1: Define Private Connection and Wire Types Depends on [2.1, 2.6]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/types/plex.ts
- docs/plans/plex-adapter-refactor/research-external.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/adapters/plex/types.ts
- packages/rfmedia-cli/src/lib/adapters/plex/types.test.ts

Define immutable connection/cache settings, request inputs, metadata codes, and narrow Plex wire DTOs
for only consumed fields. Keep credentials opaque, bound to a normalized origin, and excluded from
serializable/loggable shapes. Add runtime guards for malformed consumed fields without adding a
schema dependency. Run the focused test and typecheck the new module.

#### Task 3.2: Add the Static Opaque Token Provider Depends on [3.1]

**READ THESE BEFORE TASK**

- docs/plans/plex-adapter-refactor/research-security.md
- packages/rfmedia-cli/src/lib/adapters/plex/types.ts
- <https://developer.plex.tv/pms/>

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/adapters/plex/auth.ts
- packages/rfmedia-cli/src/lib/adapters/plex/auth.test.ts

Create the private async token-provider seam and production static provider. Return legacy-looking
and JWT-looking inputs unchanged; never decode claims, persist secrets, enroll, refresh, or authorize
retry in #119. Reject empty/control-character credentials using secret-free errors and cover
redaction plus `handleAuthFailure -> fail` behavior. Child issue #251 owns the rotating provider.

#### Task 3.3: Implement the Sole Authenticated Plex Client Depends on [2.1, 3.1, 3.2]

**READ THESE BEFORE TASK**

- docs/plans/plex-adapter-refactor/research-security.md
- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/lib/errors.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/adapters/plex/client.ts
- packages/rfmedia-cli/src/lib/adapters/plex/client.test.ts

Implement the only authenticated `fetch` boundary using relative paths, `URL`/`URLSearchParams`,
`Accept: application/json`, `X-Plex-Token`, `redirect: "error"`, composed caller/request
cancellation, the existing 30-second timeout and one 100 ms live-request delay. Bound response and
error bodies, sanitize before formatting, classify configuration/auth/authorization/not-found/
rate-limit/JWT-expiry/timeout/network/invalid-response failures, and allow at most one provider-
authorized read retry while the static provider never retries. Inject fetch/delay for deterministic
tests. Prove tokens are absent from URLs/errors/loggable state, redirects cannot forward them, and
mutations are never replayed.

#### Task 3.4: Implement Adapter-Local TTL Caching Depends on [3.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex-cache.ts
- packages/rfmedia-cli/src/lib/plex-cache.test.ts
- packages/rfmedia-cli/docs/features/plex-api-caching.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/adapters/plex/cache.ts
- packages/rfmedia-cli/src/lib/adapters/plex/cache.test.ts

Move the small `Map`/TTL mechanism into an isolated instance with captured enabled/TTL settings,
300-second default, injected clock, bounded keys/categories, clear, and explicit invalidation.
Exclude tokens, auth headers, and full credential-bearing URLs from keys; separate adapter/
credential contexts by lifecycle. Port disabled, default/custom TTL, expiry, hit/miss, isolation,
and invalidation tests. The cache must not read loaded config or call the network.

#### Task 3.5: Implement Plex Wire and Compatibility Mappers Depends on [2.1, 2.6, 3.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/lib/ratings.ts
- packages/rfmedia-cli/src/types/db.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts
- packages/rfmedia-cli/src/lib/adapters/plex/mappers.test.ts

Create pure mappings for Plex wire tracks/albums/artists/libraries/playlists/collections, numeric
media codes, generic IDs, normalized/native/star ratings, and legacy persistence/machine fields.
Validate finite range before requests and preserve current zero/unrated semantics. Cover missing
containers/parts, unknown codes, exact null/zero/half/full round trips, NaN/out-of-range rejection,
and generic-to-legacy projection without leaking raw wire types.

### Phase 4: Move Plex Endpoint Families and Compose the Adapter

#### Task 4.1: Move Query, Library, Identity, and Scan Endpoints Depends on [2.2, 2.3, 2.4, 2.5, 3.3, 3.4, 3.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/lib/plex.test.ts
- packages/rfmedia-cli/docs/features/plex-filters.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts
- packages/rfmedia-cli/src/lib/adapters/plex/query-library.test.ts

Move server identity, libraries, track/album/artist queries, album children, Plex filter pushdown,
page metadata, machine-ID caching, whole/path/source scans, mapping resolution, and full-scan
fallback into one private capability family. Use only the injected client/cache/mappers and preserve
case-insensitive lookup, endpoint/query encoding, request pacing location, malformed response errors,
cache-hit equivalence, optional scan result semantics, and zero-progress safety. Port every relevant
legacy case before considering the family complete.

#### Task 4.2: Move Playlist Endpoints and Batching Depends on [3.3, 3.4, 3.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/lib/plex.test.ts
- docs/plans/plex-adapter-refactor/feature-spec.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/adapters/plex/playlists.ts
- packages/rfmedia-cli/src/lib/adapters/plex/playlists.test.ts

Move playlist list/find/tracks/create/add/delete behavior, smart option, source URI construction,
encoding, established batch/warning behavior, error mapping, and successful mutation invalidation.
An empty addition is a no-op and a failed/ambiguous mutation is never replayed. Port all playlist
legacy cases and assert cache invalidation only after success.

#### Task 4.3: Move Collection Endpoints and Fallbacks Depends on [3.3, 3.4, 3.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/lib/plex-collection.test.ts
- packages/rfmedia-cli/docs/features/plex-collections.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/adapters/plex/collections.ts
- packages/rfmedia-cli/src/lib/adapters/plex/collections.test.ts

Move collection list/get/find/items/create/add/delete behavior, media-code mapping, machine-ID source
URI construction, 50-item batching, and current HTTP 400 one-by-one recovery. The public capability
accepts generic collection/item IDs only. Preserve partial-failure behavior, case-insensitive lookup,
malformed response handling, and successful invalidation; port every collection legacy case.

#### Task 4.4: Move Normalized Metadata Rating Updates Depends on [3.3, 3.4, 3.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/lib/ratings.ts
- packages/rfmedia-cli/src/lib/adapters/plex/cache.ts
- packages/rfmedia-cli/docs/features/plex-metadata-sync.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/adapters/plex/metadata.ts
- packages/rfmedia-cli/src/lib/adapters/plex/metadata.test.ts

Move track rating mutation behind normalized input validation and private Plex `0..10` conversion.
Preserve its non-throwing result object, current status/message intent, timeout/DNS/auth distinctions,
and exactly one request with no automatic replay. Invalidate cached rating-bearing query/library
data only after confirmed success; failures and invalid-before-request paths do not invalidate.
Cover null/zero/half/full, success/failure invalidation, invalid-before-request, 401/403/429/498,
timeout, and generic failure behavior.

#### Task 4.5: Compose PlexAdapter and Secure Factory Resolution Depends on [1.1, 2.8, 4.1, 4.2, 4.3, 4.4]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts
- packages/rfmedia-cli/src/lib/adapters/index.ts
- packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts
- docs/plans/plex-adapter-refactor/research-security.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts
- packages/rfmedia-cli/src/lib/adapters/index.ts
- packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts

Compose the four private capability families into the sole public adapter, publish truthful coarse
capabilities and semantic features, and remove every call into `lib/plex.ts`. Move Plex-specific
config validation/resolution behind a private builder while preserving public factory APIs and
required/optional messages. Canonicalize origins; reject embedded credentials/query/fragment and a
changed-origin URL override without an explicit token before any request, while allowing same-origin
inheritance, token-only override, and paired override. Preserve HTTP/LAN support. Expand tests across
the full factory matrix, zero-request security regression, opaque JWT, cache construction, hidden
machine ID, normalized ratings, and features. Assert ratings are readable/writable, normalized at
the generic boundary, and described with Plex native `{ min: 0, max: 10, step: 1 }`; assert Sonic
Analysis is exactly `server-dependent` and has no callable operation. Run adapter/client endpoint
suites.

### Phase 5: Migrate Actions and Compatibility Edges

#### Task 5.1: Migrate Plex Query and Saved-Result Projection Depends on [2.3, 2.4, 2.7, 4.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/plex-query.ts
- packages/rfmedia-cli/src/actions/plex-query.test.ts
- packages/rfmedia-cli/src/lib/db.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/plex-query.ts
- packages/rfmedia-cli/src/actions/plex-query.test.ts
- packages/rfmedia-cli/src/actions/plex-query-adapter.mock.ts

Use generic queries/entities/pages, generic residual evaluation and pagination, and a single pure
projection into unchanged action/SQLite fields. Preserve named/default filter precedence, library/
type defaults, query variants, result totals/hasMore, save/no-save behavior, table/machine values,
and errors. Run focused track/album/artist, filter, DB-row, pagination, and override cases.

#### Task 5.2: Migrate Plex Copy Paths and Optional Scans Depends on [2.5, 2.7, 4.5, 5.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/plex-copy.ts
- packages/rfmedia-cli/src/actions/plex-copy.test.ts
- packages/rfmedia-cli/src/lib/media-file-paths.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/plex-copy.ts
- packages/rfmedia-cli/src/actions/plex-copy.test.ts
- packages/rfmedia-cli/src/actions/plex-copy-adapter.mock.ts

Consume generic live tracks and narrowly projected saved rows through the generic path helper.
Preserve copy engine options/counts, allowed roots, dry-run, rating sync, mapped path scan, lookup
fallback to full scan, disabled/unconfigured skip, warning intent, and primary-result exit behavior.
Run live/saved, missing path, security, scan, and sync-on-copy cases.

#### Task 5.3: Migrate Plex Playlist Orchestration Depends on [2.3, 2.4, 2.7, 4.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/plex-playlist.ts
- packages/rfmedia-cli/src/actions/plex-playlist.test.ts
- packages/rfmedia-cli/src/lib/adapters/plex/playlists.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/plex-playlist.ts
- packages/rfmedia-cli/src/actions/plex-playlist.test.ts
- packages/rfmedia-cli/src/actions/plex-playlist-adapter.mock.ts

Remove Plex entity/filter/pagination imports and local transport-forwarding wrappers. Use generic
capabilities while preserving export/sync/list/create/add orchestration, case-insensitive lookup,
filter/default precedence, pagination, file work, dry-run, batch warnings, action/result fields, and
optional scans. Run the full focused playlist suite.

#### Task 5.4: Migrate Plex Collection Orchestration Depends on [2.3, 2.4, 2.7, 4.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/plex-collection.ts
- packages/rfmedia-cli/src/actions/plex-collection.test.ts
- packages/rfmedia-cli/src/lib/adapters/plex/collections.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/plex-collection.ts
- packages/rfmedia-cli/src/actions/plex-collection.test.ts
- packages/rfmedia-cli/src/actions/plex-collection-adapter.mock.ts

Remove machine-ID, source URI, metadata-code, Plex entity, and native pagination knowledge. Pass
generic kinds/IDs to the adapter and preserve create/add/list/show/delete, smart/static validation,
folder/path matching, named filters, dedupe, confirmations, dry-run, not-found hints, and outward
metadata fields through projection. Run the full focused collection suite.

#### Task 5.5: Migrate Plex Metadata Sync to Normalized Ratings Depends on [2.4, 2.7, 4.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/plex-sync.ts
- packages/rfmedia-cli/src/actions/plex-sync.test.ts
- packages/rfmedia-cli/src/lib/adapters/plex/metadata.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/plex-sync.ts
- packages/rfmedia-cli/src/actions/plex-sync.test.ts
- packages/rfmedia-cli/src/actions/plex-sync-adapter.mock.ts

Compare and write normalized ratings through generic pages/capabilities; remove direct Plex rating
conversion. Preserve push/pull/both conflict policy, file-tag scales, workers/progress, only-rated,
dry-run, defaults, pagination, partial failures, and machine output fields. Cover null/zero/half/full
round trips and run the focused sync suite.

#### Task 5.6: Migrate the Shared Playlist Workflow Depends on [2.7, 4.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/playlist.ts
- packages/rfmedia-cli/src/actions/playlist.test.ts
- packages/rfmedia-cli/src/actions/playlist-adapter.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/playlist.ts
- packages/rfmedia-cli/src/actions/playlist.test.ts

Replace Plex remote entity types with generic tracks/playlists while leaving local playlist/database
orchestration and the public `--plex-playlist` vocabulary unchanged. Preserve create/update/source/
list/show/delete behavior, file matching, progress, dry-run, and error intent. Run both playlist
suites with the generic shared mock.

#### Task 5.7: Generalize Filter Authoring and Config Types Depends on [2.2, 2.6]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/filter.ts
- packages/rfmedia-cli/src/types/config.ts
- packages/rfmedia-cli/src/lib/config.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/filter.ts
- packages/rfmedia-cli/src/types/config.ts

Use generic internal filter names while retaining the exact `plexFilters` YAML shape, validation,
precedence, and serialized compatibility. Do not introduce generic config/provider migration.
Run filter and configuration tests plus scoped typecheck.

#### Task 5.8: Preserve Commander and Machine Output Compatibility Depends on [1.1, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/commands/plex.ts
- packages/rfmedia-cli/src/commands/plex.test.ts
- docs/plans/plex-adapter-refactor/research-ux.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/commands/plex.ts
- packages/rfmedia-cli/src/commands/plex.test.ts

Adapt generic action values through explicit Plex compatibility presentation while preserving every
command path, positional argument, option/alias/default/conflict, lazy import, table/message intent,
`plex-*` discriminator, JSON/YAML/CSV fields, stdout/stderr separation, progress suppression, and
exit behavior. Add no JWT option and no generic namespace. Run the full Plex command and completion
parity suites; the completion templates must remain unchanged.

#### Task 5.9: Preserve MCP Schema with Safe Override Semantics Depends on [1.1, 4.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/mcp/schema.ts
- packages/rfmedia-cli/src/mcp/schema.spec.ts
- docs/plans/plex-adapter-refactor/research-security.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/mcp/schema.spec.ts

Freeze current fields and optionality in tests; connection provenance is enforced by the shared
factory, so URL-only cross-origin input is rejected without inheriting config credentials while
paired input remains valid. Add no new required auth field and keep `mcp/schema.ts` plus serialized
schema/output unchanged unless compilation requires an in-scope type-only adjustment. Run the
focused schema suite and verify production schema has no diff when no adjustment is required.

#### Task 5.10: Preserve MCP Adapter Results and Forwarding Depends on [1.2, 4.5, 5.1, 5.9]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/mcp/adapters.ts
- packages/rfmedia-cli/src/mcp/adapters.spec.ts
- packages/rfmedia-cli/src/actions/plex-query.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/mcp/adapters.ts
- packages/rfmedia-cli/src/mcp/adapters.spec.ts

Project generic query results into the unchanged MCP Plex fields and preserve same-origin/token-only/
paired override forwarding. Cover rejected URL-only cross-origin resolution, secret-free normalized
errors, and exact result field/discriminator compatibility. Run focused MCP adapter/server suites.

#### Task 5.11: Remove Obsolete Direct Plex Facade Mocks Depends on [2.5, 4.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/actions/copy-album.test.ts
- packages/rfmedia-cli/src/actions/queue.test.ts
- packages/rfmedia-cli/src/lib/adapters/action-helpers.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/actions/copy-album.test.ts
- packages/rfmedia-cli/src/actions/queue.test.ts

Replace the remaining `../lib/plex.js` scan mocks with the established generic adapter/action-helper
seam, preserving their file-operation and optional-scan assertions. Do not broaden production scope
or duplicate the shared mock builder. Run
`npm run test:run -w packages/rfmedia-cli -- src/actions/copy-album.test.ts src/actions/queue.test.ts`
and confirm `rg` finds no direct Plex facade mock in either file.

#### Task 5.12: Converge the Generic Type Contract Depends on [5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/types/media-server.ts
- packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts
- packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts

**Instructions**

Files to Create

- None.

Files to Modify

- Only the bounded Task 2.x/4.5/5.x owner file responsible for a reported type error.

Run `npm run typecheck -w packages/rfmedia-cli` and require zero errors before any legacy deletion.
If a type error remains, route the smallest fix to its declared owner and rerun that focused suite;
do not add Plex fields back to generic entities, use `any`, double-cast, or broaden compatibility
aliases. Also run the non-Plex fake-adapter contract test and `rg` assertions proving generic types
and production actions have no Plex/DB/private-adapter imports.

### Phase 6: Remove Bypasses and Enforce the Architecture

#### Task 6.1: Remove the Legacy Pagination Module Depends on [2.4, 5.1, 5.3, 5.4, 5.5, 5.12]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/pagination.ts
- packages/rfmedia-cli/src/lib/plex-pagination.ts
- packages/rfmedia-cli/src/lib/plex-pagination.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/lib/plex-pagination.ts
- packages/rfmedia-cli/src/lib/plex-pagination.test.ts

Delete the superseded implementation/test only after `rg` finds no import. Confirm every behavioral
case exists in the generic suite and run generic pagination plus affected action tests. Stage both
deletions explicitly.

#### Task 6.2: Remove the Legacy Filter Evaluator Depends on [2.3, 5.1, 5.3, 5.4, 5.7, 5.12]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/media-filter-evaluator.ts
- packages/rfmedia-cli/src/lib/plex-filter-evaluator.ts
- packages/rfmedia-cli/src/lib/plex-filter-evaluator.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/lib/plex-filter-evaluator.ts
- packages/rfmedia-cli/src/lib/plex-filter-evaluator.test.ts

Delete the superseded module/test after zero-import proof and replacement-case mapping. Run generic
filter tests plus query/playlist/collection/filter suites. Stage both deletions explicitly.

#### Task 6.3: Audit Legacy Plex Behavior Ownership Depends on [4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.8, 5.10, 5.11, 6.1, 6.2]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex.test.ts
- packages/rfmedia-cli/src/lib/plex-collection.test.ts
- packages/rfmedia-cli/src/lib/plex-cache.test.ts
- docs/plans/plex-adapter-refactor/analysis-code.md

**Instructions**

Files to Create

- docs/plans/plex-adapter-refactor/legacy-behavior-matrix.md

Map every legacy endpoint, parser, pagination, scan fallback, machine-ID cache, rating result,
playlist batch, collection fallback, cache invalidation, and error test to an exact replacement
suite/test name. Record zero unresolved gaps as the exit condition; if a gap exists, stop this task
and route it back to the bounded Task 4.x/5.x owner rather than editing an undeclared destination.
Also record repository-wide imports/mocks/fetch sites remaining before deletion. This matrix is part
of the committed design/implementation evidence.

#### Task 6.4: Remove the Legacy Plex Network Facade and Monolithic Tests Depends on [6.3]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/lib/plex.test.ts
- packages/rfmedia-cli/src/lib/plex-collection.test.ts
- docs/plans/plex-adapter-refactor/analysis-code.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/lib/plex.ts
- packages/rfmedia-cli/src/lib/plex.test.ts
- packages/rfmedia-cli/src/lib/plex-collection.test.ts

Require the completed zero-gap legacy behavior matrix, then delete only the facade and monolithic
tests. Repository-wide search must find no production/test import, mock, endpoint construction,
token query placement, or Plex `fetch` outside the private adapter directory, except the still-
present global cache import that is removed in Task 6.5. Run all private Plex, adapter, action,
command, MCP, config, and type suites; stage all three deletions explicitly. Do not edit destination
tests in this task and do not retain a callable compatibility transport.

#### Task 6.5: Remove the Process-Global Plex Cache Depends on [3.4, 4.1, 4.2, 4.3, 6.4]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/adapters/plex/cache.ts
- packages/rfmedia-cli/src/lib/plex-cache.ts
- packages/rfmedia-cli/src/lib/plex-cache.test.ts

**Instructions**

Files to Modify

- packages/rfmedia-cli/src/lib/plex-cache.ts
- packages/rfmedia-cli/src/lib/plex-cache.test.ts

After the facade is gone, require zero remaining imports and delete the global cache plus old test.
Confirm the behavior matrix maps every TTL/invalidation case, then run private cache, query/library,
playlist, collection, metadata, and adapter suites. Stage both deletions explicitly.

#### Task 6.6: Broaden and Wire the Dependency-Direction Audit Depends on [6.1, 6.2, 6.4, 6.5]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs
- packages/rfmedia-cli/package.json
- docs/plans/plex-adapter-refactor/feature-spec.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs
- packages/rfmedia-cli/package.json

Files to Create

- packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs

Expand the simple Node guard across generic types/helpers, actions, commands, and MCP modules. Reject
legacy Plex API/cache/filter/pagination imports, private adapter imports from upper layers, raw
authenticated fetch ownership outside `lib/adapters/plex/`, and production use of Plex compatibility
aliases outside a narrow documented allowlist. Add a permanent Node test that seeds representative
direct legacy imports, upper-layer private-adapter imports, and authenticated fetch violations and
proves the guard rejects each; also prove the real tree passes. Wire the test and clean audit into
normal rfmedia validation, then run the exact new scripts plus package typecheck/build.

### Phase 7: Documentation, Graph, and Local Delivery Proof

#### Task 7.1: Document the Completed Adapter, Auth, and Cache Boundary Depends on [6.6]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/docs/features/media-server-adapter.md
- packages/rfmedia-cli/docs/features/plex-configuration.md
- packages/rfmedia-cli/docs/features/plex-api-caching.md
- docs/plans/plex-adapter-refactor/feature-spec.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/docs/features/media-server-adapter.md
- packages/rfmedia-cli/docs/features/plex-configuration.md
- packages/rfmedia-cli/docs/features/plex-api-caching.md

Document generic contracts/features, one-way imports, header-only opaque tokens, static JWT
compatibility, origin-bound overrides, redirect rejection, optional/required factory behavior,
adapter-local TTL/isolation, and mutation invalidation. Link child #251 for enrollment/refresh and
state that no user migration or new completion candidate is required. Run repository markdown lint.

#### Task 7.2: Update Filter, Rating, and Package Documentation Depends on [6.6]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/docs/features/plex-filters.md
- packages/rfmedia-cli/docs/features/plex-metadata-sync.md
- packages/rfmedia-cli/README.md

**Instructions**

Files to Modify

- packages/rfmedia-cli/docs/features/plex-filters.md
- packages/rfmedia-cli/docs/features/plex-metadata-sync.md
- packages/rfmedia-cli/README.md

Describe generic residual evaluation versus private Plex pushdown, normalized internal ratings versus
unchanged Plex/star compatibility scales, and the completed adapter reference. Preserve all command
and config examples. Run markdown lint/link checks available in repository scripts.

#### Task 7.3: Run Full Validation and Refresh the Knowledge Graph Depends on [7.1, 7.2]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/package.json
- package.json
- packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts
- packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs

**Instructions**

Files to Create

- None.

Files to Modify

- None unless a validation failure proves an in-scope defect.

Remove the temporary `node_modules` symlink, run `npm ci`, and require each command below to exit 0
unless the production audit has a documented pre-existing advisory disposition in the PR:

```bash
node packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs
node --test packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs
npm run test:run -w packages/rfmedia-cli -- src/lib/shell-completions/templates.spec.ts src/commands/plex.test.ts src/mcp/schema.spec.ts src/mcp/adapters.spec.ts
npm run test:run
npm run test:coverage -w packages/rfmedia-cli
npm run typecheck
npm run build:all
npm run lint:md
npm run format:check
npm audit --omit=dev
git diff --check
graphify update .
```

Verify the graph or resolve an explicit initialization/update failure; stage graph output only if
repository tracking conventions require it. Confirm Bash/Zsh/Fish implementation files are
unchanged, `node_modules` is untracked/ignored and not staged, the main checkout remains clean, all
intended deletions are present, and every design/planning artifact under
`docs/plans/plex-adapter-refactor/` is included as the durable workflow record.

### Phase 8: Review, Publish, Merge, and Cleanup

#### Task 8.1: Perform Formal Local Review and Fix Findings Depends on [7.3]

**READ THESE BEFORE TASK**

- docs/plans/plex-adapter-refactor/feature-spec.md
- docs/plans/plex-adapter-refactor/parallel-plan.md
- .github/pull_request_template.md

**Instructions**

Files to Create

- docs/prps/reviews/plex-adapter-refactor-review.md

Files to Modify

- Only files named by actionable review findings.

Run the repository code-review workflow over the complete `origin/master...HEAD` plus working-tree
diff. Review correctness, security, secret redaction, compatibility, test quality, import direction,
and legacy-case coverage. Apply every high/medium actionable fix through the review-fix workflow,
update finding statuses in place, rerun the exact affected focused suites, then repeat review until
no actionable finding remains. Re-run Task 7.3's full validation if any production file changes.

#### Task 8.2: Commit, Push, and Open the Draft PR Depends on [8.1]

**READ THESE BEFORE TASK**

- .github/pull_request_template.md
- docs/plans/plex-adapter-refactor/legacy-behavior-matrix.md
- docs/prps/reviews/

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Confirm the feature branch/worktree and clean main checkout, remove any untracked `node_modules`,
then stage the complete intended diff with `git add -A` so deletions, design/planning artifacts,
review evidence, tests, and docs are included. Create reviewable conventional commit(s), push
`feat/plex-adapter-refactor` to `origin`, and open a draft PR targeting the actual default branch
`master` through the GitHub connector. Use every required repository template section, exact local
validation commands/outcomes, risk/rollback, `Closes #119`, and a note that child #251 remains open.
Record the real PR number for Task 8.3.

#### Task 8.3: Update ROADMAP with the Real Closing PR Depends on [8.2]

**READ THESE BEFORE TASK**

- ROADMAP.md
- docs/plans/plex-adapter-refactor/feature-spec.md
- The authenticated GitHub records for issues #119 and #251 and the new draft PR.

**Instructions**

Files to Modify

- ROADMAP.md

Use the real PR number to mark #119 as delivered by the closing PR across Sprint 3, backlog, and
cross-cutting references, and accurately describe newly unblocked dependent work without marking it
shipped. Keep #251 open/deferred and linked. Run `npm run lint:md -- ROADMAP.md` if supported,
otherwise `npm run lint:md`, plus `git diff --check`; commit the roadmap update, push it, and update
the draft PR body/test evidence if needed.

#### Task 8.4: Resolve Remote Review Findings and Revalidate Depends on [8.3]

**READ THESE BEFORE TASK**

- The draft PR conversation, reviews, inline threads, and check annotations.
- docs/prps/reviews/
- .github/pull_request_template.md

**Instructions**

Files to Create

- None unless a repository review artifact is required by the review-fix workflow.

Files to Modify

- Only files required by actionable PR feedback.

Mark the locally reviewed, ROADMAP-updated draft PR ready for review first, then wait through the
repository's configured human/bot review window and inspect every top-level comment, review, inline
thread, and check annotation. Apply valid fixes,
reply with evidence where a comment is non-actionable/out of scope, resolve threads only after the
corresponding outcome, update the local review artifact, and rerun focused plus Task 7.3 validation
proportional to the change. Commit/push fixes and continue until zero unresolved actionable review
threads remain after the latest pushed SHA.

#### Task 8.5: Monitor Required CI to Green Depends on [8.4]

**READ THESE BEFORE TASK**

- The PR status/check rollup.
- Any failed GitHub Actions job logs and annotations.

**Instructions**

Files to Create

- None.

Files to Modify

- Only files required to fix a reproducible CI failure.

Monitor the PR's required checks through completion. For a failure, inspect the exact job/log,
reproduce locally where possible, make only an in-scope fix, rerun relevant local validation,
commit/push, and resume monitoring. Distinguish external review-bot latency from code failure. Do
not proceed until required CI is green, the head SHA is current, the PR is mergeable, and a final
post-ready/post-push review refresh confirms no new actionable comments or unresolved threads.

#### Task 8.6: Squash Merge and Verify Issue Hierarchy Depends on [8.5]

**READ THESE BEFORE TASK**

- The final PR head SHA, mergeability, approvals, and green status rollup.
- The authenticated GitHub records for #119 and #251.

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Squash merge the PR through the GitHub connector using the verified final head SHA and repository
title/body conventions. Confirm the PR is merged, issue #119 closed by the PR, child #251 remains
open and attached beneath #119, and #251 still owns automatic enrollment/refresh while merged #119
implements only opaque supplied legacy/JWT tokens. Confirm the remote feature branch is deleted or
delete it as part of cleanup.

#### Task 8.7: Clean the Worktree, Branches, and Main Checkout Depends on [8.6]

**READ THESE BEFORE TASK**

- `git worktree list`
- `git branch -vv`
- `git ls-remote --heads origin feat/plex-adapter-refactor`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

After verifying the merge, explicitly switch all subsequent command/tool working directories to the
main checkout at `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps` and verify it is safe/clean.
From that checkout, remove the feature worktree by its absolute path, delete the local feature
branch, prune stale worktree metadata and remote-tracking refs, and confirm the remote feature
branch is absent. Fetch and fast-forward the main checkout's `master` to the squash merge without
overwriting unrelated user work. Require a clean main checkout, no feature worktree/branch/ref, and
no leftover untracked dependency directory attributable to this task.

#### Task 8.8: Audit the Completed Lifecycle Depends on [8.7]

**READ THESE BEFORE TASK**

- docs/plans/plex-adapter-refactor/feature-spec.md from merged `master`.
- docs/plans/plex-adapter-refactor/parallel-plan.md from merged `master`.
- Final GitHub PR, issue #119, and child #251 states.

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Run this task from `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps`, never from the removed
feature worktree. Compare the merged result to every feature-spec success criterion and the user's requested lifecycle.
Report concrete evidence for design, planning, implementation, tests, unchanged completions,
ROADMAP, local/remote review resolution, green CI, squash merge, issue closure, open/linked child,
and branch/worktree cleanup. If any safe in-scope step is incomplete, finish it before declaring the
goal achieved.

## Advice

- Treat the cross-origin URL-only override as the single intentional compatibility tightening:
  canonicalize with `URL.origin`, require a paired token for a changed origin, and prove zero
  requests before returning the error/warning.
- Keep `client.ts` as the security choke point. Endpoint families receive only relative paths and
  structured queries and cannot choose an origin, attach credentials, follow redirects, or format
  raw response bodies independently.
- Intermediate phase changes may temporarily make downstream TypeScript consumers stale; resolve
  them at the next dependency barrier rather than weakening the final generic contract or adding
  permanent Plex fields to generic entities.
- Preserve test evidence by moving each legacy case to its new owner before deletion. In particular,
  retain pagination forward progress, optional scan fallback, machine-ID caching, playlist batches,
  collection HTTP 400 recovery, mutation invalidation, and scan/rating result semantics.
- Never expose Plex machine IDs, metadata codes, source URIs, query operator spellings, native
  ratings, token placement, cache keys, or raw wire containers through `MediaServerAdapter`.
- Keep commands lazy and Plex-branded, keep actions responsible for files/DB/progress/dry-run, and
  keep compatibility projections at command/MCP/SQLite edges. No completion template edit belongs
  in #119.
- Use isolated file ownership per parallel batch. `media-server.ts`, `plex-adapter.ts`,
  `adapters/index.ts`, `commands/plex.ts`, `types/index.ts`, and the architecture guard are serialized
  convergence files.
- Use the existing Node/Vitest/Map/custom-error stack. Add no Plex SDK, cache framework, schema
  library, JWT parser, API-version opt-in, provider discovery, generic database migration, or public
  auth workflow.
- Treat Phase 8 as part of completion, not a handoff: the goal is achieved only after the PR is
  reviewed, green, squash-merged, #119 is closed, #251 remains open/linked, and all feature
  worktree/branch refs are removed with main clean and synchronized.
