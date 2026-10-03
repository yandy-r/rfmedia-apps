# Issue #208 Plex-Lidarr Reconciliation

Issue #208 adds a report-first `rfmedia lidarr reconcile` workflow on top of the provider-neutral
Plex identity capability, the handwritten Lidarr facade, and the exact-MBID-first bridge resolver
shipped by #207. Snapshot v2 must first retain the complete minimal Lidarr artist catalog and allow
credential-free, exact-one cached-scope selection so offline `lidarr_only` results are truthful.
The public command then uses one pure reconciliation engine for live and offline evidence while
keeping all Plex/Lidarr mutations outside scope in #209/#221.

## Relevant Files

- `packages/rfmedia-cli/src/types/bridge.ts`: Existing identity snapshot and cache contracts.
- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`: Exact-MBID resolver and snapshot constructor.
- `packages/rfmedia-cli/src/lib/bridge/cache.ts`: Sole strict SQLite snapshot CRUD owner.
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`: Bounded Plex artist identity pages.
- `packages/rfmedia-cli/src/types/media-server.ts`: Provider-neutral optional identity capability.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Handwritten complete Lidarr artist facade.
- `packages/rfmedia-cli/src/actions/lidarr/audit.ts`: Closest multi-source orchestration pattern.
- `packages/rfmedia-cli/src/commands/lidarr-audit.ts`: Closest DI/output/failure presentation pattern.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Lidarr namespace and shared presenter injection.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Cross-shell parity gate.
- `packages/rfmedia-cli/src/lib/db.ts`: Writable and immutable read-only database lifecycles.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Provider-boundary architecture gate.
- `ROADMAP.md`: Live issue inventory and Layer 3 sequencing.
- `docs/roadmap-archive.md`: Authoritative shipped-history destination.

## Relevant Tables

- `bridge_identity_snapshots`: Exact Plex-instance/library and Lidarr-origin scoped snapshot JSON.

## Relevant Patterns

**Provider-neutral adapter boundary**: Actions consume `MediaServerAdapter.identity`, never Plex
private DTOs or transport code. See
[`packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`](../../../packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts).

**Handwritten Lidarr facade**: Upper layers use projected domain types and never generated endpoints
or handwritten API paths. See
[`packages/rfmedia-cli/src/lib/lidarr/client.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/client.ts).

**Exact-evidence identity**: Only a unique one-to-one canonical MBID join is authoritative; name
scores remain review-only suggestions. See
[`packages/rfmedia-cli/src/lib/bridge/mapping.ts`](../../../packages/rfmedia-cli/src/lib/bridge/mapping.ts).

**Strict snapshot persistence**: Cached JSON is byte-capped, version-gated, and reprojected from
`unknown`; complete generations replace atomically. See
[`packages/rfmedia-cli/src/lib/bridge/cache.ts`](../../../packages/rfmedia-cli/src/lib/bridge/cache.ts).

**Command/action/pure-engine separation**: Commands parse and present, actions own I/O, and library
modules remain deterministic and framework-free. See
[`packages/rfmedia-cli/src/commands/lidarr-audit.ts`](../../../packages/rfmedia-cli/src/commands/lidarr-audit.ts)
and
[`packages/rfmedia-cli/src/actions/lidarr/audit.ts`](../../../packages/rfmedia-cli/src/actions/lidarr/audit.ts).

**Static completion parity**: Bash, Zsh, and Fish are maintained together and locked by one exact
option/value-taking test. See
[`packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`](../../../packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts).

## Relevant Docs

**`docs/plans/plex-lidarr-identity-mapping/feature-spec.md`**: You _must_ read this for #207 identity,
snapshot, evidence, and non-mutation decisions.

**`packages/rfmedia-cli/docs/features/lidarr-audit.md`**: You _must_ read this when correcting the
reserved `plex-alignment` guidance.

**`packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`**: You _must_ read this when defining
cached provenance and why `--offline` is distinct from live-first stale fallback.

**`packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`**: You _must_ read this when
preserving scheduler, cancellation, and local-only operation boundaries.

**`docs/architecture/data-flow.md`**: You _must_ read this when documenting cross-provider command
flow and cache persistence.

**`docs/architecture/overview.md`**: You _must_ read this for CLI package and provider boundaries.

**`packages/rfmedia-cli/README.md`**: You _must_ read this when adding the public command contract
and examples.

**`ROADMAP.md`** and **`docs/roadmap-archive.md`**: You _must_ read these before final issue-count,
dependency, and shipped-history updates.
