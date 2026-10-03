# Context Analysis: Plex Adapter Refactor

## Executive Summary

Issue #119 completes the boundary introduced by #117: `MediaServerAdapter` becomes genuinely
provider-neutral, while `PlexAdapter` and private modules under `lib/adapters/plex/` become the only
owners of Plex HTTP, authentication, wire mapping, native rating conversion, caching, endpoint
fallbacks, and machine identifiers. Existing `rfmedia plex` commands, configuration, MCP/JSON
fields, SQLite tables, error intent, optional-scan behavior, and shell completions remain compatible
through explicit projections at Plex-branded edges. Automatic JWT enrollment and refresh is
deliberately excluded and is now tracked as linked child issue #251; #119 accepts legacy tokens and
pre-issued JWTs as opaque values through the existing token input.

## Architecture Context

- **System Structure**: Preserve the current grouped query, library, scan, playlist, collection,
  and metadata capability shape, but replace every `Plex*`/database type crossing that boundary with
  generic media entities, pages, operation results, normalized ratings, features, and typed errors.
- **Dependency Direction**: Enforce `commands/MCP/actions -> generic MediaServerAdapter ->
PlexAdapter -> adapters/plex/*`. Generic types/helpers and actions must not import Plex wire,
  transport, cache, filter-pushdown, pagination, or adapter-private modules.
- **Plex Composition**: Keep `plex-adapter.ts` as the public concrete facade. Compose small private
  `auth`, `client`, `cache`, `mappers`, and `types` modules beneath it; do not replace one 2,800-line
  file with an untestable monolithic class or a capability-class framework.
- **Domain Model**: Use opaque `id`, discriminated track/album/artist entities, generic library/
  playlist/collection values, response-driven pages, and finite normalized `0..1 | null` ratings.
  Plex `ratingKey`, metadata codes, server URIs, machine IDs, and native `0..10` ratings remain
  private or are reconstructed only at compatibility/persistence boundaries.
- **Data Flow**: Existing argv/config/MCP inputs resolve to a provenance-bound connection; actions
  issue generic operations; `PlexAdapter` maps them to private endpoints; the transport authenticates,
  paces, bounds, and parses the request; mappers return generic values; commands/MCP/SQLite project
  them back to the established Plex field names and scales.
- **Connection Resolution**: Preserve required versus optional factory modes and current precedence,
  but resolve URL and credential together. A same-origin URL override may inherit the configured
  credential; a changed origin requires an explicit paired token; a URL-only cross-origin override
  fails before any request.
- **Authentication**: The #119 production provider returns the configured opaque credential and
  sends it only as `X-Plex-Token`. It does not inspect JWT claims, enroll, refresh, persist keys, or
  retry mutations. The provider seam exists so #251 can add the lifecycle without changing endpoint
  methods.
- **Feature Model**: Retain coarse capability groups and add truthful semantic descriptors for
  rating read/write/native scale, smart containers, path scans, filter pushdown, and Sonic Analysis
  as `server-dependent`. Feature metadata must not imply a callable Sonic operation.
- **Cache Lifecycle**: Capture existing opt-in enablement and 300-second default TTL at adapter
  construction. Use isolated adapter-owned state, injected time, secret-free keys, cache-hit/live
  result equivalence, and explicit invalidation after successful playlist/collection mutations.
- **Compatibility Boundary**: CLI/MCP/persistence surfaces may intentionally retain Plex terminology,
  `ratingKey`, `userRating`, metadata fields, and `plex_*` schema names. These are pure projections,
  never alternate network/cache entry points.

## Critical Files Reference

- `packages/rfmedia-cli/src/types/media-server.ts`: Central contract to remove Plex and DB imports
  from; owns generic entities, capabilities, features, pages, ratings, results, and error types.
- `packages/rfmedia-cli/src/types/plex.ts`: Narrow to private/edge compatibility types and deliberate
  deprecated aliases; production generic consumers must stop importing it.
- `packages/rfmedia-cli/src/types/plex-filters.ts`: Compatibility alias surface for the new generic
  filter AST; its Plex query encoding moves below the adapter.
- `packages/rfmedia-cli/src/types/index.ts`: Public export boundary requiring deliberate generic
  exports and no private Plex wire-type leakage.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`: Replace the thin `lib/plex.ts` forwarding
  facade with composed adapter-owned endpoint behavior and feature declarations.
- `packages/rfmedia-cli/src/lib/adapters/index.ts`: Preserve factory API/modes while moving Plex
  resolution behind a provider-specific resolver and enforcing origin/credential provenance.
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`: Keep as the action resolution boundary;
  remove Plex config, DB row, entity, and filesystem/API coupling.
- `packages/rfmedia-cli/src/lib/plex.ts`: Behavioral source and regression inventory to migrate by
  endpoint family, then delete so no callable network bypass remains.
- `packages/rfmedia-cli/src/lib/plex-cache.ts`: Existing TTL/invalidation semantics to move into an
  adapter instance, then delete.
- `packages/rfmedia-cli/src/lib/plex-filter-evaluator.ts`: Reuse recursive evaluation and complexity
  guards in a provider-neutral helper; leave Plex pushdown compilation private.
- `packages/rfmedia-cli/src/lib/plex-pagination.ts`: Reuse its zero-progress algorithm under a
  provider-neutral page contract, then delete the Plex-named module.
- `packages/rfmedia-cli/src/lib/ratings.ts`: Reuse star/normalized conversions; confine Plex-native
  conversion to private mappers or compatibility projections.
- `packages/rfmedia-cli/src/lib/errors.ts`: Follow existing typed-error and formatter conventions
  rather than propagating raw responses or parsing message strings in actions.
- `packages/rfmedia-cli/src/lib/loaded-config.ts`: Preserve loaded-config state and precedence;
  provider resolution may consume it, but the client/cache must not read global config dynamically.
- `packages/rfmedia-cli/src/lib/db.ts`: Preserve saved-query schema/functions and add explicit
  generic-to-legacy projections without a migration.
- `packages/rfmedia-cli/src/actions/plex-query.ts`: Main filter, pagination, persistence, and outward
  result projection consumer.
- `packages/rfmedia-cli/src/actions/plex-copy.ts`: Separate generic live-track/local-path handling
  from legacy saved-result compatibility and optional scanning.
- `packages/rfmedia-cli/src/actions/plex-playlist.ts`: Migrate entities/filter/pagination to generic
  capabilities while retaining batching and outward result schemas.
- `packages/rfmedia-cli/src/actions/plex-collection.ts`: Remove metadata-code and machine-ID/URI
  knowledge; pass generic kinds and item IDs only.
- `packages/rfmedia-cli/src/actions/plex-sync.ts`: Stop converting Plex ratings in orchestration;
  compare/write normalized ratings across the adapter boundary.
- `packages/rfmedia-cli/src/actions/playlist.ts`: Shared workflow proving generic media/playlist
  types coexist with the stable `--plex-playlist` UX.
- `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts`: Generalize the
  reusable grouped-capability mock and feature defaults.
- `packages/rfmedia-cli/src/actions/test-helpers/media-server-fixtures.ts`: Convert canonical
  fixtures first so action migrations share IDs, normalized ratings, and page semantics.
- `packages/rfmedia-cli/src/commands/plex.ts`: Stable Commander/human/machine compatibility edge;
  preserve commands, flags, help, discriminators, fields, output channels, and exit behavior.
- `packages/rfmedia-cli/src/mcp/schema.ts` and `packages/rfmedia-cli/src/mcp/adapters.ts`: Preserve
  public schema/output compatibility while applying the same connection-provenance rule.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Expand the existing simple guard to
  cover all generic/action/command/MCP layers and narrow compatibility allowlists.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Required evidence that Bash,
  Zsh, and Fish candidates remain unchanged without contacting Plex.
- `packages/rfmedia-cli/package.json`: Wire architecture checks into normal validation and use the
  repository's existing typecheck/build/test scripts.
- `ROADMAP.md`: Mark #119 shipped only after the PR exists; leave #251, #118, and dependent work
  pending while recording the newly unblocked sequencing.

## Patterns to Follow

- **Grouped Capabilities**: Retain the existing object-group contract from
  `types/media-server.ts`; change its data types and semantics rather than introducing a plugin or
  service-locator framework.
- **Required/Optional Resolution**: Preserve `createMediaServerAdapter`,
  `createOptionalMediaServerAdapter`, and `requireMediaServerAdapter` behavior. Required Plex work
  throws actionable configuration failures; optional scans warn/skip and never rewrite successful
  primary work.
- **Action-Oriented Orchestration**: Actions own user intent, files, persistence, progress,
  confirmations, dry-run, and partial failures. The adapter owns remote protocol behavior only.
- **Explicit Queries**: Keep separate tracks/albums/artists/album-tracks methods rather than a
  conditional generic query API; they are clear, mockable, and match current behavior.
- **Pure Mappers and Projections**: Centralize wire-to-domain and generic-to-legacy conversion.
  Avoid scattered `id -> ratingKey` and `rating * 10` logic across commands, MCP, and persistence.
- **Normalized Ratings**: Validate `0..1 | null` at runtime, reuse star conversions at the CLI/file
  boundary, and test unrated, zero, half-star, full-scale, NaN, and out-of-range cases.
- **Response-Driven Pagination**: Reuse the existing forward-progress guard based on returned count,
  offset, and total/has-more metadata; never assume requested page size was returned.
- **Injected Test Seams**: Inject fetch/request function, token provider, clock, timeout/caller
  signal, and cache state. Test mappers as pure functions and actions through generic adapter mocks.
- **Typed Errors, Compatible Presentation**: Classify configuration, auth, authorization, not-found,
  rate-limit, timeout, network, invalid-response, and request failures internally. Format them at
  the Plex edge to preserve familiar operation-oriented recovery text.
- **Static Boundary Enforcement**: Extend the existing Node import checker instead of adding an
  architecture-lint dependency; include a compile-only non-Plex fake adapter contract test.
- **Mechanical Migration**: Move endpoint families with their existing behavioral tests before
  deleting old owners. Preserve current paths, historical PMS API behavior, fallbacks, batching,
  invalidation, pacing, and result semantics during movement.

## Cross-Cutting Concerns

- **Security Release Blocker**: Prevent configured-token exfiltration through independent URL/token
  fallback. Canonicalize origins, bind credential provenance, reject changed-origin inheritance,
  and prove rejection performs zero requests.
- **Transport Safety**: Use relative paths, `URL`/`URLSearchParams`, `Accept: application/json`,
  header-only credentials, `redirect: "error"`, composed cancellation/30-second timeout, bounded
  bodies/diagnostics, control-character-safe redaction, and typed status mapping. Never log or cache
  token/JWT/authorization material.
- **Mutation Safety**: Do not automatically replay playlist, collection, rating, or scan writes.
  Preserve 100-item playlist batches, 50-item collection batches, HTTP 400 single-item fallback,
  confirmations, dry-run, and partial-failure reporting.
- **Cache Correctness**: Separate adapter/credential contexts, skip pacing on hits, never cache
  failed/malformed/auth responses, and invalidate only after successful mutations.
- **Compatibility**: Freeze CLI help/options/aliases, config keys and precedence, MCP/JSON schemas,
  stdout/stderr separation, human star display, SQLite meaning, saved rows, exit codes, and optional
  scan warnings. Cross-origin credential inheritance is the one intentional safety tightening.
- **Performance and Bounds**: Preserve 100 ms live-request pacing and lazy action imports. Pagination,
  page/item counts, response bodies, and total operations need bounded forward progress and caller
  cancellation without adding hidden output or unbounded retry layers.
- **Testing**: Migrate every meaningful `plex.ts`/cache/filter/pagination case before deletion, then
  cover contracts, transport security, mapping/rating round trips, cache TTL/isolation/invalidation,
  endpoint fallbacks, actions, commands, MCP, persistence, and all-shell parity.
- **Delivery Hygiene**: Run package typecheck/build/full tests, coverage, import guard, markdown and
  whitespace checks, completion parity, clean dependency-audit disposition, and `graphify update .`.
  Graph output is absent in this worktree, so verify generated state before deciding what to stage.

## Parallelization Opportunities

- **Baseline vs Generic Foundation**: CLI/help/output/MCP/DB/completion fixtures and the generic
  filter/pagination/path/rating contracts can proceed independently if fixture/helper file ownership
  is separated.
- **Private Foundation**: After generic contracts stabilize, auth/client security work can run in
  parallel with cache/mapper/type work because they have distinct files and deterministic seams.
- **Endpoint Families**: Query/library/scan/rating, playlist, and collection behavior can migrate in
  parallel only after the shared client/mappers exist and only if each task owns separate private
  endpoint modules/tests; concurrent edits to `plex-adapter.ts` should be serialized or assigned to
  one integration task.
- **Consumer Migration**: Query/copy/persistence, playlist/shared-playlist, collection, and rating
  sync consumers are separable after adapter signatures settle. Factory/MCP provenance changes
  should be one security-focused task because the behavior spans all callers.
- **Enforcement and Documentation**: The architecture guard, completion verification, docs, and
  `ROADMAP.md` can be prepared alongside late consumer work but must be finalized only after the
  import graph and public behavior are stable.
- **Deletion Gate**: Delete legacy modules and their old tests only in a final sequential task after
  repository-wide searches prove all behavior/tests have migrated and the broadened audit passes.

## Implementation Constraints

- Node.js 22+, strict TypeScript, ESM, and `.js` import suffixes remain mandatory; add no Plex SDK,
  cache library, schema framework, or JWT dependency in #119.
- Preserve every existing `plex.*`, `plexFilters`, cache, library mapping, scan, and sync setting;
  add no required key, command, public auth flag, or database migration.
- Preserve `rfmedia plex query|copy|playlist|sync|collection`, existing `--plex-*` flags, output
  discriminators/fields, human terminology, 1-5-star UX, and completion candidates.
- Existing token inputs remain opaque and may contain a legacy token or pre-issued JWT. Enrollment,
  key storage, PIN UX, refresh, revocation, and persistence belong exclusively to child #251.
- Keep current Plex endpoint behavior and omit `X-Plex-Pms-Api-Version`; modernization through
  provider discovery/version opt-in is future work and could break older servers.
- Permit configured HTTP(S) LAN/loopback servers for local compatibility; do not misuse a public-IP
  SSRF blocklist. Trust is established through configured canonical origins and provenance binding.
- Do not expose Plex machine identifiers, source URIs, metadata codes, raw response containers,
  credential placement, or cache implementation through the generic contract.
- The adapter returns remote `filePath` data, but local existence/allowed-root checks remain generic
  action-side filesystem work.
- Query/CRUD methods continue to throw; scan/rating methods keep their existing result-object
  contracts. Optional scans remain best effort and dry runs send no requests.
- `plex_queries`, `plex_query_results`, `rating_key`, `user_rating`, and `media_type` remain unchanged
  and retain Plex `0..10` persistence semantics.
- Legacy `lib/plex.ts`, `plex-cache.ts`, `plex-filter-evaluator.ts`, and `plex-pagination.ts` must be
  deleted after migration; a retained compatibility module must be pure and cannot call the network.

## Key Recommendations

- Establish compatibility fixtures and the expanded boundary guard first so every later task has
  measurable acceptance criteria.
- Build generic domain/filter/page/path/error contracts and generic mocks before changing actions;
  prove a non-Plex fake adapter compiles without Plex or database imports.
- Implement origin-bound static auth and the only authenticated transport before moving endpoints;
  prioritize negative tests for URL-only cross-origin overrides, header secrecy, redirects, body
  bounds, cancellation, and typed `401/403/429/498` behavior.
- Build adapter-private cache and mappers with injected dependencies, then migrate endpoint families
  mechanically while carrying over each current fallback, batch, timeout, pacing, and invalidation
  regression case.
- Migrate consumers in dependency-safe groups, using one compatibility projection layer for CLI,
  MCP, and persistence rather than allowing Plex aliases to remain the runtime domain model.
- Finish with a repository-wide import/fetch audit, deletion of every bypass module, full public
  compatibility validation, unchanged three-shell templates, docs/ROADMAP/graph updates, and the
  complete PR review/CI lifecycle.
