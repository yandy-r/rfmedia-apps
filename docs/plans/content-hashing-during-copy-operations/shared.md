# Content Hashing During Copy Operations

Issue #111 is a bounded hardening and closeout of the schema-version-9 content fingerprint pipeline
already merged in PR #233. Album/filter copy and sync actions materialize final artifacts through the
filesystem/conversion layer, pass lowercase SHA-256 fingerprints through the portable inventory
model, persist them with prepared SQLite writes, and only then record completion; CLI, queue, and MCP
entry points delegate to those actions. Implementation should preserve this architecture while adding
pre-DDL future-schema rejection, shared digest validation, signal-aware stream hashing with
ownership-bounded partial cleanup, proof-oriented tests, honest benchmark evidence, and corrected
documentation/roadmap state. No new CLI/MCP/output/completion surface, schema version, artifact table,
index, or broad Plex/playlist/repair provenance model belongs in this change.

## Relevant Files

- `packages/rfmedia-cli/src/lib/filesystem.ts`: One-pass copy hashing, hardlinks, retries, aborts, and partial cleanup.
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`: Real-file digest and failure/cancellation coverage.
- `packages/rfmedia-cli/src/lib/integrity.ts`: Final-file SHA-256 and separate immediate verification behavior.
- `packages/rfmedia-cli/src/lib/integrity.test.ts`: Existing-file digest and error propagation tests.
- `packages/rfmedia-cli/src/lib/db.ts`: Database initialization and shared inventory read/write boundary.
- `packages/rfmedia-cli/src/lib/db.test.ts`: Real SQLite schema, migration, persistence, and rollback tests.
- `packages/rfmedia-cli/src/lib/migrations.ts`: Current schema version and guarded version-8 upgrade.
- `packages/rfmedia-cli/src/lib/schema.sql`: Version-9 schema containing nullable `content_hash`.
- `packages/rfmedia-cli/src/lib/inventory.ts`: SQLite/JSONL camelCase mapping and inventory routing.
- `packages/rfmedia-cli/src/lib/inventory.test.ts`: Present, null, and omitted hash mapping coverage.
- `packages/rfmedia-cli/src/actions/copy-album.ts`: Stream/conversion/hardlink hashes and batch inventory ordering.
- `packages/rfmedia-cli/src/actions/copy-album.test.ts`: Album success/failure ordering and hash persistence tests.
- `packages/rfmedia-cli/src/actions/copy-filter.ts`: Final-destination hashing and single-row inventory writes.
- `packages/rfmedia-cli/src/actions/copy-filter.test.ts`: Filter path, dry-run, accepted-file, and failure coverage.
- `packages/rfmedia-cli/src/actions/sync.ts`: Final-destination hashing for the existing sync inventory model.
- `packages/rfmedia-cli/src/actions/queue.ts`: Delegates queued work to album/filter actions.
- `packages/rfmedia-cli/src/mcp/adapters.ts`: Delegates MCP copy/sync tools to the same actions.
- `packages/rfmedia-cli/benchmarks/copy.bench.ts`: Like-for-like tracked copy benchmark seam.
- `packages/rfmedia-cli/README.md`: Canonical CLI guide with stale sync-only inventory claims.
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`: Stale schema/tracking architecture guide.
- `packages/rfmedia-cli/docs/features/tracking-system.md`: Completion and range semantics to preserve.
- `packages/rfmedia-cli/docs/features/graceful-interruption.md`: Cancellation and partial-output contract.
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`: Benchmark methodology and evidence limits.
- `packages/rfmedia-cli/docs/features/sync-command.doc.md`: Sync inventory behavior and legacy routing.
- `docs/features/file-integrity-verification.md`: Canonical `--verify` semantics requiring distinction.
- `docs/features/file-integrity-quick-reference.md`: User-facing verification quick reference.
- `ROADMAP.md`: Three pending #111 references requiring shipped/PR linkage updates.
- `.github/pull_request_template.md`: Required final PR structure and testing evidence fields.

## Relevant Tables

- `metadata`: Stores `schema_version`; compatibility must be checked before schema DDL.
- `operations`: Owns command/tracking identity referenced by inventory and completion rows.
- `inventory`: Stores source/final-destination metadata and nullable version-9 `content_hash`.
- `completed_sources`: Records source-level success after inventory persistence.
- `completed_album_copies`: Records suffix/album completion after batch inventory persistence.

## Relevant Patterns

**Command/action delegation**: Commands, queue, and MCP adapters delegate to shared actions instead of
duplicating filesystem logic. See
[`packages/rfmedia-cli/src/commands/copy.ts`](../../../packages/rfmedia-cli/src/commands/copy.ts),
[`packages/rfmedia-cli/src/actions/queue.ts`](../../../packages/rfmedia-cli/src/actions/queue.ts),
and [`packages/rfmedia-cli/src/mcp/adapters.ts`](../../../packages/rfmedia-cli/src/mcp/adapters.ts).

**One-pass copy fingerprinting**: A fresh SHA-256 and transparent transform live inside every retry
attempt, forwarding unchanged chunks to the writer. See
[`packages/rfmedia-cli/src/lib/filesystem.ts`](../../../packages/rfmedia-cli/src/lib/filesystem.ts).

**Final-artifact hashing**: Conversion, hardlink, filter, and sync paths hash the artifact that will
be inventoried only after materialization succeeds. See
[`packages/rfmedia-cli/src/lib/integrity.ts`](../../../packages/rfmedia-cli/src/lib/integrity.ts).

**Prepared transactional inventory writes**: Single and batch writes use positional parameters;
the batch executes synchronously in one `better-sqlite3` transaction. See
[`packages/rfmedia-cli/src/lib/db.ts`](../../../packages/rfmedia-cli/src/lib/db.ts).

**Nullable legacy compatibility**: Database `content_hash` maps to optional/nullable portable
`contentHash`, preserving version-8 and JSONL records without fabricating a digest. See
[`packages/rfmedia-cli/src/lib/inventory.ts`](../../../packages/rfmedia-cli/src/lib/inventory.ts).

**Guarded sequential migration**: Inspect existing structure before applying a nullable column and
advance metadata only after success. See
[`packages/rfmedia-cli/src/lib/migrations.ts`](../../../packages/rfmedia-cli/src/lib/migrations.ts).

**Write-before-completion ordering**: Actions collect successful artifact records, persist inventory,
and only then record source/suffix completion. See
[`packages/rfmedia-cli/src/actions/copy-album.ts`](../../../packages/rfmedia-cli/src/actions/copy-album.ts).

**Real-resource regression tests**: Temporary files and temporary SQLite databases exercise public
APIs and cleanup/rollback behavior. See
[`packages/rfmedia-cli/src/lib/filesystem.test.ts`](../../../packages/rfmedia-cli/src/lib/filesystem.test.ts)
and [`packages/rfmedia-cli/src/lib/db.test.ts`](../../../packages/rfmedia-cli/src/lib/db.test.ts).

## Relevant Docs

**`docs/plans/content-hashing-during-copy-operations/feature-spec.md`**: You _must_ read this for the
authoritative scope, invariants, exclusions, testing, and delivery contract.

**`docs/prps/plans/completed/content-hashing-during-copy-operations.plan.md`**: You _must_ read this
for PR #233's historical implementation boundary; do not treat its old validation as current proof.

**`docs/prps/reports/content-hashing-during-copy-operations-report.md`**: You _must_ read this for the
files and benchmark seam shipped by PR #233.

**`packages/rfmedia-cli/README.md`**: You _must_ read this when correcting public tracking,
fingerprinting, and `--verify` documentation.

**`packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`**: You _must_ read this when
updating schema version, inventory producers, and migration documentation.

**`packages/rfmedia-cli/docs/features/tracking-system.md`**: You _must_ read this when preserving
operation, range, and completion semantics.

**`packages/rfmedia-cli/docs/features/graceful-interruption.md`**: You _must_ read this when changing
abort propagation or partial-output cleanup.

**`packages/rfmedia-cli/docs/features/performance-benchmarks.md`**: You _must_ read this when running
or reporting the `<5%` performance target.

**`docs/features/file-integrity-verification.md`**: You _must_ read this to keep explicit
source/destination verification distinct from persisted write-time fingerprints.

**`ROADMAP.md`**: You _must_ read this when marking every #111 entry shipped while preserving #116
as downstream read-time work.
