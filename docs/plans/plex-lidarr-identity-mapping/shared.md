# Plex-Lidarr Identity Mapping

The feature extends the optional capabilities of `MediaServerAdapter` with provider-neutral artist
identity data while keeping Plex GUID wire shapes and authenticated requests private. Projected
Plex artists and the existing Lidarr artist facade feed a pure MBID-first bridge resolver whose
name-based outcomes are suggestions only. A feature-owned SQLite module stores one strictly
validated, versioned snapshot per complete Plex-machine/library and Lidarr-origin scope, and a pure
expansion calculator supplies later workflows with fail-closed track-to-album impact evidence.

## Relevant Files

- /packages/rfmedia-cli/src/types/media-server.ts: Provider-neutral adapter capability contracts.
- /packages/rfmedia-cli/src/types/lidarr.ts: Existing projected Lidarr artist contract.
- /packages/rfmedia-cli/src/types/db.ts: Tracking database connection type.
- /packages/rfmedia-cli/src/types/index.ts: Public type export surface.
- /packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts: Plex capability composition root.
- /packages/rfmedia-cli/src/lib/adapters/plex/client.ts: Sole authenticated Plex transport.
- /packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts: Library resolution and pagination pattern.
- /packages/rfmedia-cli/src/lib/adapters/plex/types.ts: Private Plex wire projection boundary.
- /packages/rfmedia-cli/src/lib/lidarr/client.ts: Existing Lidarr artist acquisition facade.
- /packages/rfmedia-cli/src/lib/lidarr/types.ts: Strict Lidarr response projectors.
- /packages/rfmedia-cli/src/lib/fuzzy-match.ts: Existing distance dependency and unsafe winner precedent.
- /packages/rfmedia-cli/src/lib/lidarr/audit-identity.ts: Artist normalization edge-case fixtures.
- /packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts: Feature-owned SQLite CRUD precedent.
- /packages/rfmedia-cli/src/lib/db.ts: Schema initialization and supported-version checks.
- /packages/rfmedia-cli/src/lib/schema.sql: Current writable database schema.
- /packages/rfmedia-cli/src/lib/migrations.ts: Sequential database migration registry.
- /packages/rfmedia-cli/src/lib/db.test.ts: Fresh schema and migration coverage.
- /packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts: Shared capability mock pattern.
- /packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs: Provider-boundary architecture gate.
- /packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts: Pure checked expansion-evidence precedent.
- /ROADMAP.md: Live issue inventory and next-work sequencing.
- /docs/roadmap/archive.md: Completed roadmap item archive.

## Relevant Tables

- metadata: Stores the exact tracking database schema version; #207 advances it from 10 to 11.
- lidarr_metadata_cache: Existing single-provider response cache pattern; must not store bridge data.
- bridge_identity_snapshots: New versioned complete snapshot per Plex/Lidarr artist scope.

## Relevant Patterns

**Private Provider Projection**: Provider wire data becomes frozen domain values behind the adapter
boundary. See
[/packages/rfmedia-cli/src/lib/adapters/plex/types.ts](/packages/rfmedia-cli/src/lib/adapters/plex/types.ts).

**Sole Authenticated Transport Owner**: Endpoint families use the existing origin-bound transport.
See
[/packages/rfmedia-cli/src/lib/adapters/plex/client.ts](/packages/rfmedia-cli/src/lib/adapters/plex/client.ts).

**Handwritten Lidarr Facade**: Bridge code consumes projected artists without generated imports or
handwritten endpoints. See
[/packages/rfmedia-cli/src/lib/lidarr/client.ts](/packages/rfmedia-cli/src/lib/lidarr/client.ts).

**Feature-Owned SQLite CRUD**: One module owns parameterized reads, writes, purge, clock handling,
and strict row projection. See
[/packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts](/packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts).

**Sequential Exact Schema Migration**: Writable and read-only schema versions advance together.
See [/packages/rfmedia-cli/src/lib/migrations.ts](/packages/rfmedia-cli/src/lib/migrations.ts).

**Pure Typed Evidence**: Domain calculations return immutable evidence and stable codes without
prompting or performing mutations. See
[/packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts](/packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts).

**Architecture Enforcement**: Static tests prevent private provider imports, extra fetch owners,
generated Lidarr imports, and handwritten endpoints. See
[/packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs](/packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs).

## Relevant Docs

**/docs/plans/plex-lidarr-identity-mapping/feature-spec.md**: You _must_ read this when implementing
issue #207 contracts, safety rules, or acceptance criteria.

**/docs/plans/plex-lidarr-identity-mapping/research-security.md**: You _must_ read this when handling
GUID projection, fuzzy outcomes, cache scope, or expansion evidence.

**/docs/plans/plex-lidarr-identity-mapping/research-technical.md**: You _must_ read this when
modifying provider boundaries, migrations, or architecture checks.

**/docs/plans/plex-lidarr-identity-mapping/research-practices.md**: You _must_ read this when
choosing abstractions, test ownership, or dependencies.

**/research/rfmedia-lidarr-integration/report.md**: You _must_ read this when defining
track-to-album expansion semantics.

**/packages/rfmedia-cli/README.md**: You _must_ read this before changing any public CLI surface;
issue #207 deliberately adds none.
