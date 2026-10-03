# Metadata Drift Detection and Reconciliation

Metadata reconciliation spans local audio-tag readers and rating writers, the operation-scoped
SQLite inventory, and the provider-neutral media-server adapter. A new top-level
`rfmedia reconcile scan|apply` command will join complete evidence by exact normalized path,
classify drift with a pure deterministic engine, and keep scan plus default apply preview strictly
read-only. Executed apply will require exactly one explicit winner flag plus `--execute` and
approval, reacquire evidence before mutation, repair only supported targets, and report unsupported
or partial outcomes without claiming convergence.

## Relevant Files

- /packages/rfmedia-cli/src/cli.ts: Registers top-level command factories and shared output options.
- /packages/rfmedia-cli/src/actions/plex-sync.ts: Closest exact-path rating synchronization pattern.
- /packages/rfmedia-cli/src/commands/lidarr-reconcile.ts: Thin nested-command validation and lazy action loading.
- /packages/rfmedia-cli/src/actions/lidarr/reconcile.ts: Provider-neutral report-only reconciliation precedent.
- /packages/rfmedia-cli/src/lib/db.ts: Hardened read-only snapshots and writable SQLite initialization.
- /packages/rfmedia-cli/src/types/db.ts: Inventory and operation row contracts.
- /packages/rfmedia-cli/src/lib/schema.sql: Schema-v11 inventory columns and operation-scoped uniqueness.
- /packages/rfmedia-cli/src/lib/inventory.ts: Persists file stat, path, hash, and rating evidence.
- /packages/rfmedia-cli/src/lib/metadata.ts: Reads normalized embedded audio metadata.
- /packages/rfmedia-cli/src/lib/ratings.ts: Normalizes native file and server rating scales.
- /packages/rfmedia-cli/src/lib/tag-writer.ts: Safe MP3 and FLAC rating mutation boundary.
- /packages/rfmedia-cli/src/lib/audio.ts: Enumerates local audio candidates and exposes symlink risks.
- /packages/rfmedia-cli/src/lib/parallel.ts: Bounded concurrency with cancellation and stable result positions.
- /packages/rfmedia-cli/src/lib/signal-handler.ts: Supplies the process-wide cancellation signal.
- /packages/rfmedia-cli/src/types/media-server.ts: Provider-neutral query and rating mutation capabilities.
- /packages/rfmedia-cli/src/lib/adapters/index.ts: Resolves configured adapters and credential precedence.
- /packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts: Complete response-driven server pagination.
- /packages/rfmedia-cli/src/lib/adapters/plex/metadata.ts: Provider-specific rating write below the adapter.
- /packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts: Projects Plex tracks into normalized metadata.
- /packages/rfmedia-cli/src/lib/shell-completions/bash.ts: Static Bash command and option tree.
- /packages/rfmedia-cli/src/lib/shell-completions/zsh.ts: Static Zsh command and option tree.
- /packages/rfmedia-cli/src/lib/shell-completions/fish.ts: Static Fish command and option tree.
- /packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts: Cross-shell completion parity contract.
- /packages/rfmedia-cli/README.md: Package command reference and operator examples.
- /packages/rfmedia-cli/CHANGELOG.md: Unreleased public behavior record.
- /ROADMAP.md: Live issue focus and open-count status.
- /docs/roadmap-archive.md: Shipped issue and pull-request history.

## Relevant Tables

- inventory: Operation-scoped file path, stat, hash, rating, and sparse metadata evidence.
- operations: Parent copy-operation identity and lifecycle for inventory generations.
- plex_queries: Historical query metadata that is not authoritative reconciliation state.
- plex_query_results: Server-local historical rows that must not replace a fresh adapter snapshot.
- metadata_changes: Existing metadata change history; reuse only if its contract fits exact outcomes.

## Relevant Patterns

**Pure report engine**: Keep observation, comparison, strategy planning, and deterministic ordering
separate from I/O. See
[/packages/rfmedia-cli/src/actions/lidarr/reconcile.ts](/packages/rfmedia-cli/src/actions/lidarr/reconcile.ts).

**Thin command boundary**: Validate mutual exclusion, execution ceremony, and machine-mode rules
before dynamically loading actions. See
[/packages/rfmedia-cli/src/commands/lidarr-reconcile.ts](/packages/rfmedia-cli/src/commands/lidarr-reconcile.ts).

**Immutable scan snapshot**: Use the regular-file, no-symlink, sidecar-free, size-bounded
`openDatabaseReadOnly()` path for scan and preview. See
[/packages/rfmedia-cli/src/lib/db.ts](/packages/rfmedia-cli/src/lib/db.ts).

**Provider-neutral integration**: Query and mutate through `MediaServerAdapter`; provider wire types
remain below the adapter. See
[/packages/rfmedia-cli/src/lib/adapters/index.ts](/packages/rfmedia-cli/src/lib/adapters/index.ts).

**Preview-first authorization**: Winner selection is policy, while `--execute` and confirmation or
`--yes` independently authorize writes. See
[/packages/rfapps-cli/src/actions/reconcile.ts](/packages/rfapps-cli/src/actions/reconcile.ts).

**Capability-bounded writes**: Use `writeRating()` and adapter metadata capability results so
unsupported formats or targets remain typed residuals. See
[/packages/rfmedia-cli/src/lib/tag-writer.ts](/packages/rfmedia-cli/src/lib/tag-writer.ts).

**Exact optimistic database updates**: Target one row and guard expected prior facts rather than
using replace semantics. Extend
[/packages/rfmedia-cli/src/lib/db.ts](/packages/rfmedia-cli/src/lib/db.ts).

**Machine-output discipline**: Emit one deterministic document to stdout and keep prompts,
progress, and diagnostics on stderr. See
[/packages/rfmedia-cli/src/cli.ts](/packages/rfmedia-cli/src/cli.ts).

**Tri-shell parity**: Treat Bash, Zsh, and Fish templates as one public command contract protected
by parity tests. See
[/packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts](/packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts).

## Relevant Docs

**/docs/plans/125-metadata-drift-reconciliation/feature-spec.md**: You _must_ read this for the
settled issue scope, command contract, safety gates, and success criteria.

**/docs/plans/125-metadata-drift-reconciliation/research-architecture.md**: You _must_ read this
when modifying command, action, engine, adapter, or database boundaries.

**/docs/plans/125-metadata-drift-reconciliation/research-patterns.md**: You _must_ read this for
repository conventions, winner flags, authorization ordering, and focused test patterns.

**/docs/plans/125-metadata-drift-reconciliation/research-integration.md**: You _must_ read this for
the field capability matrix, SQLite ambiguity, path matching, partial failure, and provider limits.

**/docs/plans/125-metadata-drift-reconciliation/research-docs.md**: You _must_ read this when
updating operator documentation, completions, changelog, ROADMAP, archive, or the pull request.

**/packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md**: You _must_ read this when
querying or updating inventory rows and documenting database precedence.

**/packages/rfmedia-cli/docs/features/media-server-adapter.md**: You _must_ read this when using or
extending provider-neutral query and metadata capabilities.

**/packages/rfmedia-cli/docs/features/plex-metadata-sync.md**: You _must_ read this to preserve the
existing two-plane sync behavior and reuse normalized rating semantics.

**/docs/features/output-formats.md**: You _must_ read this when designing human, JSON, YAML, CSV,
stdout/stderr, or non-interactive behavior.

**/packages/rfmedia-cli/docs/features/shell-completion.doc.md**: You _must_ read this when updating
the static Bash, Zsh, and Fish completion surfaces.
