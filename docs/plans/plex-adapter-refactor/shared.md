# Plex Adapter Refactor

Issue #119 completes the boundary introduced by issue #117: actions keep using the grouped
`MediaServerAdapter`, but its types become provider-neutral and `PlexAdapter` becomes the sole owner
of Plex HTTP, auth, wire mapping, rating conversion, caching, and protocol fallbacks. Existing
`rfmedia plex` commands, config, MCP/JSON fields, saved-query tables, optional scan semantics, and
shell completions remain compatible through explicit projections at Plex-branded edges. The final
state removes the legacy Plex API/cache/filter/pagination bypass modules and enforces the dependency
direction with automated import checks and compatibility tests.

## Relevant Files

- packages/rfmedia-cli/src/types/media-server.ts: Generic adapter contract currently leaking Plex and DB types.
- packages/rfmedia-cli/src/types/plex.ts: Plex compatibility and wire types to narrow or privatize.
- packages/rfmedia-cli/src/types/plex-filters.ts: Existing filter AST requiring generic aliases.
- packages/rfmedia-cli/src/types/index.ts: Public type exports requiring deliberate compatibility aliases.
- packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts: Thin facade to replace with composed Plex implementation.
- packages/rfmedia-cli/src/lib/adapters/index.ts: Required/optional factory, precedence, and connection provenance.
- packages/rfmedia-cli/src/lib/adapters/action-helpers.ts: Action resolution and local path helper boundary.
- packages/rfmedia-cli/src/lib/plex.ts: Legacy endpoint behavior and tests to migrate before deletion.
- packages/rfmedia-cli/src/lib/plex-cache.ts: Global cache mechanism to move into adapter lifecycle.
- packages/rfmedia-cli/src/lib/plex-filter-evaluator.ts: Reusable filter evaluation mixed with Plex pushdown.
- packages/rfmedia-cli/src/lib/plex-pagination.ts: Defensive offset algorithm to generalize.
- packages/rfmedia-cli/src/lib/ratings.ts: Existing star, normalized, and Plex rating conversions.
- packages/rfmedia-cli/src/lib/errors.ts: Established typed error conventions and formatter integration.
- packages/rfmedia-cli/src/lib/loaded-config.ts: Loaded Plex config and existing precedence source.
- packages/rfmedia-cli/src/lib/db.ts: Saved Plex query persistence compatibility boundary.
- packages/rfmedia-cli/src/actions/plex-query.ts: Query, filter, pagination, persistence, and legacy projection consumer.
- packages/rfmedia-cli/src/actions/plex-copy.ts: Live/saved query path extraction and optional scan workflow.
- packages/rfmedia-cli/src/actions/plex-playlist.ts: Playlist orchestration and pagination consumer.
- packages/rfmedia-cli/src/actions/plex-collection.ts: Collection type, machine-ID, and item-ID leakage.
- packages/rfmedia-cli/src/actions/plex-sync.ts: Rating conversion leakage and full-library pagination.
- packages/rfmedia-cli/src/actions/playlist.ts: Shared playlist workflow consuming Plex entities.
- packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts: Shared adapter mock builder to generalize.
- packages/rfmedia-cli/src/actions/test-helpers/media-server-fixtures.ts: Canonical fixtures to convert first.
- packages/rfmedia-cli/src/commands/plex.ts: Stable Commander, human, and machine-output compatibility edge.
- packages/rfmedia-cli/src/mcp/schema.ts: Stable MCP schema including connection override compatibility.
- packages/rfmedia-cli/src/mcp/adapters.ts: MCP-to-action projection and override propagation.
- packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs: Existing architecture guard to broaden and wire into validation.
- packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts: Three-shell candidate parity evidence.
- packages/rfmedia-cli/package.json: rfmedia validation scripts and architecture-check integration.
- ROADMAP.md: Sprint/backlog status and dependent issue sequencing.

## Relevant Tables

- plex_queries: Saved Plex query definitions and compatibility metadata; schema remains unchanged.
- plex_query_results: Saved result IDs, `rating_key`, `user_rating`, type, and file data; projected from generic entities.

## Relevant Patterns

**Grouped Adapter Capabilities**: Retain the existing query/library/scan/playlist/collection/metadata
shape while replacing Plex-shaped members with generic types. See
[/packages/rfmedia-cli/src/types/media-server.ts](/packages/rfmedia-cli/src/types/media-server.ts).

**Required Versus Optional Resolution**: Required Plex workflows throw configuration errors while
best-effort scans warn and skip. Preserve the factory matrix in
[/packages/rfmedia-cli/src/lib/adapters/index.ts](/packages/rfmedia-cli/src/lib/adapters/index.ts).

**Action-Oriented Orchestration**: Actions own files, persistence, progress, dry-run, and user intent;
the adapter owns remote protocol behavior. See
[/packages/rfmedia-cli/src/actions/plex-copy.ts](/packages/rfmedia-cli/src/actions/plex-copy.ts).

**Normalized Rating Boundaries**: Reuse existing normalized/star conversion and keep Plex-native
conversion inside the adapter. See
[/packages/rfmedia-cli/src/lib/ratings.ts](/packages/rfmedia-cli/src/lib/ratings.ts).

**Pure Compatibility Projection**: Preserve Plex-named machine and persistence fields at outer
edges rather than leaking them into the generic contract. See
[/packages/rfmedia-cli/src/actions/plex-query.ts](/packages/rfmedia-cli/src/actions/plex-query.ts).

**Injected Test Seams**: Use focused adapter mocks, injected fetch/clock, literal wire fragments,
and canonical generic fixtures. See
[/packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts](/packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts).

**Static Architecture Enforcement**: Extend the current zero-direct-import script instead of adding
a new lint framework. See
[/packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs](/packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs).

## Relevant Docs

**/docs/plans/plex-adapter-refactor/feature-spec.md**: You _must_ read this for resolved scope,
architecture, security, compatibility, phasing, and acceptance criteria.

**/docs/plans/plex-adapter-refactor/research-security.md**: You _must_ read this when changing
connection overrides, auth headers, redirects, caches, request bounds, or redaction.

**/packages/rfmedia-cli/docs/features/media-server-adapter.md**: You _must_ read this when changing
the adapter contract, factory modes, action imports, or adapter tests.

**/packages/rfmedia-cli/docs/features/plex-configuration.md**: You _must_ read this when changing
config resolution, CLI overrides, optional scans, or authentication behavior.

**/packages/rfmedia-cli/docs/features/plex-api-caching.md**: You _must_ read this when moving cache
state, TTL defaults, categories, or invalidation.

**/packages/rfmedia-cli/docs/features/plex-filters.md**: You _must_ read this when generalizing the
filter AST or separating pushdown from residual evaluation.

**/packages/rfmedia-cli/docs/features/plex-metadata-sync.md**: You _must_ read this when changing
rating representations or synchronization behavior.

**/packages/rfmedia-cli/AGENTS.md**: You _must_ read this for package architecture, test, ESM,
command/action, config, output, and shell-completion rules.
