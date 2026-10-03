# Content Hashing During Copy Operations: Integration Research

## Executive Summary

Issue #111 integrates with existing rfmedia-cli boundaries and requires no new public endpoint,
runtime service, dependency, configuration key, output schema, or shell completion. PR #233 already
connected SHA-256 persistence to the inventory-backed copy graph:

```text
CLI / Queue / MCP
  -> album copy | filter copy | sync actions
  -> filesystem copy/link or FFmpeg conversion
  -> SHA-256 finalization
  -> inventory adapter
  -> prepared SQLite inventory write
  -> completion tracking and optional Plex scan
```

The closing work is integration hardening. `copyOrLinkWithHash()` must propagate the existing
`AbortSignal` into its stream pipeline and clean only newly created partial outputs after exhausted
retries. Database initialization must reject a schema version newer than 9 before executing schema
DDL. Both shared inventory write APIs must validate non-null lowercase SHA-256 values before
statement execution, with a malformed batch rolling back atomically.

The feature spec deliberately limits scope to workflows that own general SQLite inventory rows:
album/filter `rfmedia copy`, `rfmedia sync`, and queue/MCP routes that delegate to those actions.
Plex query copy, playlist export/sync, repair writes, link-videos, and watch execution without a
tracking context lack the same operation/inventory identity and remain deferred. Read-time hash
comparison belongs to issue #116.

## API/CLI/MCP endpoints

### CLI entry points

`packages/rfmedia-cli/src/commands/copy.ts` is the primary user entry point. Commander parses copy
options, builds `CopyOptions`, and dispatches by mode:

```text
rfmedia copy ... album mode
  -> executeAlbumCopyWithFileInput(source, destination, options)

rfmedia copy ... filter mode
  -> executeFilterCopyWithFileInput(source, destination, options)
```

The `*WithFileInput()` actions resolve positional, `--file`, `--paths`, and multi-source input;
initialize tracking/database state when enabled; and invoke `executeAlbumCopy()` or
`executeFilterCopy()` with a `TrackingConfig` containing `db` and `operationId`. Hashes are therefore
an action/inventory invariant, not a command-rendering concern.

`packages/rfmedia-cli/src/commands/sync.ts` dispatches to:

```typescript
executeSyncWithFileInput(destination, syncOptions);
```

`syncFile()` creates or updates the destination, hashes that final path, constructs a
`FileInventoryEntry`, and routes it through `appendFileRecord()`. Its existing one-row-per-source
inventory behavior is retained by the feature spec.

No new CLI option is introduced. Existing `--verify` remains an immediate source/destination
comparison; it does not enable persistence. Existing `--tracking-database`,
`--use-legacy-tracking`, `--no-track-completed`, `--dry-run`, `--hardlink`, `--convert`, and
`--workers` retain their meanings.

### Queue delegation

`packages/rfmedia-cli/src/actions/queue.ts` executes queued copy jobs by dynamically importing and
calling the same top-level actions:

```text
queued album copy -> executeAlbumCopyWithFileInput()
queued filter copy -> executeFilterCopyWithFileInput()
```

Queue serialization does not carry a hash field and should not. Hashing occurs when the queued job
materializes a file, using the resolved runtime database/tracking context. Existing queue delegation
tests are the correct integration seam; duplicating the full hash matrix in queue tests would couple
the queue transport to filesystem internals.

### MCP endpoints

The MCP tool names remain:

- `rfmedia.copy.album`;
- `rfmedia.copy.filter`;
- `rfmedia.sync`.

The verified route is:

```text
mcp/server.ts
  -> mcp/tools-mutate.ts
  -> mcp/adapters.ts
  -> executeAlbumCopyWithFileInput()
     | executeFilterCopyWithFileInput()
     | executeSyncWithFileInput()
```

MCP inputs already expose `trackingDatabase` and `useLegacyTracking`, and the adapters build the
same `CopyOptions`/`SyncOptions` consumed by CLI actions. No MCP schema, tool name, result field, or
JSON-RPC change is needed. Adapter tests should prove delegation and option forwarding; action/DB
tests prove the actual digest invariant.

### Internal hashing and inventory APIs

The existing internal contracts are sufficient:

```typescript
copyOrLinkWithHash(
  source: string,
  dest: string,
  useHardlink: boolean,
  signal?: AbortSignal,
): Promise<{
  method: CopyMethod;
  contentHash: string;
  mtime: number;
  size: number;
}>;

calculateHash(filePath: string): Promise<string>;

recordInventoryFile(
  db: DbConnection,
  operationId: number,
  entry: InventoryFileRecordParams,
): void;

recordInventoryFiles(
  db: DbConnection,
  operationId: number,
  entries: InventoryFileRecordParams[],
): void;

getInventory(db: DbConnection, operationId: number): DbInventoryEntry[];

getInventoryForSource(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
): DbInventoryEntry[];
```

`copyOrLinkWithHash()` hashes regular copy chunks in the same pipeline that writes the destination.
Hardlinks have no write stream, so the helper reads the linked inode after link creation. Converted
files are hashed through `calculateHash(finalDestPath)` after FFmpeg exits successfully. The stored
digest is an expected write/finalization-time fingerprint; no read API implicitly rehashes files.

## Database Schema

### Current storage contract

`packages/rfmedia-cli/src/lib/schema.sql` defines schema version 9 and extends `inventory` with:

```sql
content_hash TEXT -- nullable SHA-256 of destination bytes
```

The relevant inventory identity remains:

```sql
UNIQUE(operation_id, source_path, relative_path)
```

The closeout does not change that identity, add a table, add an index, or create schema version 10.
`content_hash` remains nullable because existing rows and legacy JSONL records have no trustworthy
observed digest. New successful in-scope database writes must supply a non-null string matching
`/^[a-f0-9]{64}$/`.

`packages/rfmedia-cli/src/types/db.ts::DbInventoryEntry` exposes
`content_hash: string | null`. The portable boundary in
`packages/rfmedia-cli/src/types/inventory.ts::FileInventoryEntry` exposes optional nullable
`contentHash`. `inventory.ts` maps present database values to `contentHash` and maps omitted legacy
values to `null` at the write boundary.

No `content_hash` index is currently justified. The current readers scope inventory by operation or
source and do not execute `WHERE content_hash = ?`. A downstream dedup/health feature should add a
measured partial non-unique index when it introduces the first real hash lookup.

### Initialization and migration

The verified initialization path is:

```text
initializeDatabase(path)
  -> create parent directory when absent
  -> open better-sqlite3 connection
  -> configure WAL / synchronous / busy_timeout / foreign_keys
  -> load and execute schema.sql
  -> runMigrations(db)
```

That order currently executes schema DDL before `runMigrations()` rejects
`currentVersion > CURRENT_SCHEMA_VERSION`. The feature spec requires an existing-version preflight:

1. open an existing database;
2. inspect whether `metadata` and a valid `schema_version` exist;
3. reject a value greater than 9 before `schema.sql` executes;
4. distinguish a genuinely new/unversioned database from malformed version metadata;
5. only then configure/initialize/migrate through the normal path.

The v8-to-v9 migration in `packages/rfmedia-cli/src/lib/migrations.ts` remains:

1. inspect `PRAGMA table_info(inventory)`;
2. execute `ALTER TABLE inventory ADD COLUMN content_hash TEXT` only when absent;
3. update `metadata.schema_version` to `9`;
4. retain existing rows with `content_hash = NULL`.

Tests must reopen an existing v9 database without churn and snapshot `sqlite_schema` plus metadata
for a future-version database to prove rejection did not execute schema DDL.

### Prepared writes and transactions

`recordInventoryFile()` and `recordInventoryFiles()` use static SQL and positional parameters for
paths, metadata, and hashes. This is the correct injection boundary and must be retained.

Add one shared non-null digest validator before `Statement.run()`. For the batch API, validation must
occur inside the existing synchronous `db.transaction()` loop or validate the complete batch before
the transaction begins; either approach must prove that one invalid entry results in zero committed
batch rows. Async copy/hash work must never run inside a `better-sqlite3` transaction.

The per-file lifecycle stays:

```text
filesystem/conversion success
  -> digest finalization
  -> prepared inventory write/transaction
  -> completed source/suffix marker
```

SQLite cannot atomically roll back a filesystem write. A database failure is therefore an explicit
failed/partial operation, never successful completion with `NULL`.

## External Services

### Local filesystem and Node.js runtime

Node.js 22 built-ins are the hashing and I/O integration:

- `node:crypto::createHash("sha256")` for fixed SHA-256;
- `node:fs::createReadStream/createWriteStream` for bounded file I/O;
- `node:stream::Transform` as a transparent hash tap that forwards unchanged chunks;
- `node:stream/promises::pipeline` for backpressure and error propagation;
- `node:fs/promises::link/stat/utimes` for hardlinks, metadata capture, and timestamp restoration.

The existing action `AbortSignal` must be passed to `pipeline()`. Every retry creates new streams,
transform, and hash state. On exhausted retry/abort, cleanup is limited to a destination proven new
for that operation; no recursive or pre-existing-path deletion is authorized.

No hashing daemon, web service, cloud API, SQLite extension, worker pool, or shell command is added.

### FFmpeg conversion

`packages/rfmedia-cli/src/lib/convert.ts::convertFile()` is the existing external process boundary.
The hash integration does not modify FFmpeg argv or stream encoder output through Node. It waits for
successful conversion, resolves the converted final filename, then reads that final destination via
`calculateHash()`.

This adds one destination read to conversion and must be measured separately from ordinary copy.
Hashing the source or encoder input would violate the final-artifact contract.

### SQLite / `better-sqlite3`

SQLite is a local embedded service boundary. `better-sqlite3` remains the only database dependency;
WAL allows concurrent readers but still serializes writers. Hash writes are short synchronous
prepared statements, with batch inserts in one synchronous transaction. Existing `busy_timeout =
5000` behavior remains; a busy/full/read-only database error must fail tracking, not silently drop
the digest.

The database, `-wal`, and `-shm` files collectively contain paths, metadata, and content
fingerprints. No new remote persistence or telemetry is introduced.

### Optional media-server scan

Album/filter/sync actions resolve an optional scan adapter through
`resolveOptionalScanAdapter()`. Hash persistence does not call Plex directly and does not alter the
media-server adapter contract. The integration order must keep copy/hash/inventory success ahead of
successful completion and scan eligibility. A source that fails required hashing or persistence
must not be presented as fully completed merely because a later scan succeeds.

### Plugins

Album/filter actions invoke `beforeCopy`, `afterCopy`, and batch plugin hooks. No plugin schema
change is included. The feature contract assumes `afterCopy` is observational with respect to final
bytes. If plugins are allowed to mutate destination content, hashing must move after the mutation or
a child issue must define post-hook rehash and failure semantics; that broader plugin contract is not
introduced implicitly here.

## Internal Services

### Command/action separation

Commands parse/validate user input and preserve output shapes. Actions own file processing,
tracking setup, failure aggregation, completion order, plugin hooks, and optional scan coordination.
Hash behavior stays below commands so CLI, queue, and MCP receive one implementation.

### Tracking and operation identity

`completed-tracker.ts` creates `TrackingConfig` and initializes/loads operation state. The top-level
album/filter actions attach `db` and `operationId` when database tracking is active. Inventory writes
require both; legacy tracking and `--no-track-completed` intentionally do not create a hidden hash-only
database lifecycle.

`recordCompleted()` and `recordCompletedAlbumCopy()` are downstream of successful inventory
persistence. Focused tests should fail hash/DB calls and prove these completion APIs are not invoked
for the affected file/source.

### Filesystem and integrity modules

`filesystem.ts` owns materialization plus one-pass copy hashing. `integrity.ts` owns final-file SHA-256
and immediate source/destination comparison. Keep these concerns distinct:

- `copyOrLinkWithHash()` returns the write-time fingerprint with actual copy method and source
  metadata;
- `calculateHash()` reads one final file for conversion/filter/sync/hardlink support;
- `verifyFileIntegrity()` reads both paths for explicit `copy --verify` behavior.

Do not make `getInventory()` or inventory loading perform I/O verification. That would turn metadata
reads into unbounded library scans and belongs to issue #116.

### Inventory adapter

`inventory.ts` routes database-backed contexts to `getInventory*()` / `recordInventoryFile()` and
legacy contexts to JSONL. It is the camelCase/snake_case mapping boundary and must preserve present,
`null`, and omitted hashes. `createFileInventoryEntry()` gathers source metadata and carries the
already-finalized destination digest; it should not recalculate one implicitly.

### Parallelism and cancellation

Album/filter work uses the existing bounded `processInParallel()` worker model. Hashing remains
inside each file worker; no independent hash pool is created. Cancellation flows from the global
signal handler through action-local controllers into filesystem/hash streams. Database writes that
have already started remain synchronous and short.

### Output and completion integration

Human/machine copy results and exit handling remain unchanged. Hash/DB failure enters the existing
failed-operation collection and yields nonzero command status. Full digests are not added to normal
logs, JSON, YAML, CSV, MCP structured content, or progress output.

Bash, Zsh, and Fish generators already expose the existing copy/sync/tracking/verify options. Since
there is no new public surface, no template edit is required; run
`src/lib/shell-completions/templates.spec.ts` as regression evidence only.

## Configuration

### Existing controls

| Control                                               | Integration effect                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `--tracking-database <path>` / MCP `trackingDatabase` | Selects the SQLite database receiving operation/inventory rows                          |
| `--use-legacy-tracking` / MCP `useLegacyTracking`     | Selects legacy tracking; no SQLite inventory hash is created                            |
| `--no-track-completed`                                | Disables the tracking/inventory owner; no hidden hash database is opened                |
| `--dry-run`                                           | Performs no file copy, hash read, database initialization/migration, or inventory write |
| `--hardlink`                                          | Uses link when possible, then snapshot-hashes linked bytes; fallback behaves as copy    |
| `--convert <format>`                                  | Runs FFmpeg and hashes the final converted output                                       |
| `--verify`                                            | Adds immediate source/destination comparison; independent of persistence                |
| `--workers <n>`                                       | Bounds concurrent copy/hash work through existing validation/parallel helpers           |
| copy/sync input and range options                     | Affect source/destination selection, not hash algorithm or format                       |

Default database resolution continues through `resolveUndoDatabasePath()` / existing rfmedia config
and the XDG-or-legacy fallback in `getDefaultDatabasePath()`. Existing `tracking.useLegacy` config
continues to select the backend. No `hash`, `hashAlgorithm`, `hashWorkers`, `verifyOnRead`, or backfill
configuration is added.

### Configuration precedence

CLI/MCP overrides are converted into `CopyOptions`/`SyncOptions`; loaded copy/tracking defaults fill
unspecified values; actions resolve the final database and legacy-mode decision before filesystem
mutation. The same resolved options flow through queue/MCP delegation. Hashing must not depend on
output format, interactivity, progress visibility, or media-server scan settings.

## Integration Points

### Verified path matrix

| Path                                                      | Verified role                                          | Planned integration change                                                         |
| --------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/commands/copy.ts`               | Album/filter CLI dispatch and existing options         | None; regression only                                                              |
| `packages/rfmedia-cli/src/commands/sync.ts`               | Sync CLI dispatch                                      | None; regression only                                                              |
| `packages/rfmedia-cli/src/actions/queue.ts`               | Delegates queued jobs to top-level copy actions        | None; delegation regression only                                                   |
| `packages/rfmedia-cli/src/mcp/schema.ts`                  | Existing copy/sync tool names and tracking inputs      | None                                                                               |
| `packages/rfmedia-cli/src/mcp/adapters.ts`                | Delegates MCP calls to album/filter/sync actions       | None; adapter regression only                                                      |
| `packages/rfmedia-cli/src/actions/copy-album.ts`          | Stream/conversion/hardlink hashing and batch inventory | Audit ordering; change only proven gap                                             |
| `packages/rfmedia-cli/src/actions/copy-filter.ts`         | Final destination hashing and single-row inventory     | Audit ordering; change only proven gap                                             |
| `packages/rfmedia-cli/src/actions/sync.ts`                | Final destination hash before inventory append         | Audit ordering; change only proven gap                                             |
| `packages/rfmedia-cli/src/lib/filesystem.ts`              | Copy/link/hash/retry/cleanup boundary                  | Pass signal to pipeline; fresh retry state; bounded partial cleanup                |
| `packages/rfmedia-cli/src/lib/integrity.ts`               | Final-file SHA-256 and explicit verification           | Optional signal propagation if required; retain semantics                          |
| `packages/rfmedia-cli/src/lib/inventory.ts`               | DB/JSONL mapping and append routing                    | Preserve present/null/omitted digest mapping                                       |
| `packages/rfmedia-cli/src/lib/db.ts`                      | DB initialization, prepared inventory writes/reads     | Future-version preflight; shared digest validation                                 |
| `packages/rfmedia-cli/src/lib/migrations.ts`              | Version 9 compatibility migration                      | Retain guarded v8-to-v9 logic                                                      |
| `packages/rfmedia-cli/src/lib/schema.sql`                 | Nullable content hash and schema metadata              | No schema change                                                                   |
| `packages/rfmedia-cli/src/types/db.ts`                    | Snake-case DB row contract                             | No change unless validator type is exported                                        |
| `packages/rfmedia-cli/src/types/inventory.ts`             | Portable optional nullable digest                      | No change                                                                          |
| `packages/rfmedia-cli/benchmarks/copy.bench.ts`           | Hash-enabled vs benchmark-only disabled baseline       | Add/record repeated representative evidence, no CI time assertion                  |
| `packages/rfmedia-cli/src/lib/shell-completions/*.ts`     | Bash/Zsh/Fish templates                                | No edits; run parity tests                                                         |
| `packages/rfmedia-cli/README.md` / canonical feature docs | User contract                                          | Document fingerprint vs verification, legacy/tracking/conversion/hardlink behavior |
| `ROADMAP.md`                                              | Project delivery state                                 | Mark all #111 references shipped and link implementation/closeout PRs              |

### Deferred boundaries

| Boundary                                                           | Why deferred                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `actions/watch.ts` low-level action calls without tracking context | No durable inventory owner in the current route                          |
| `actions/plex-copy.ts`                                             | SQLite is used for Plex query history, not a general copy operation      |
| `actions/plex-playlist.ts`                                         | Playlist tables/provenance differ and copied tags may mutate after write |
| verify repair/conflict resolver                                    | Repair semantics are not inventory-producing copy operations             |
| `actions/link-videos.ts`                                           | Separate video-inventory domain                                          |
| Hash lookup/index consumers                                        | Dedup/health/read-time verification own query and indexing requirements  |

### Validation paths

- Filesystem: `src/lib/filesystem.test.ts` and `src/lib/integrity.test.ts`.
- Database/migration: `src/lib/db.test.ts`.
- Mapping: `src/lib/inventory.test.ts`.
- Actions: `src/actions/copy-album.test.ts`, `copy-filter.test.ts`, and existing sync coverage.
- Delegation: `src/actions/queue.test.ts`, `src/actions/queue-adapter.test.ts`, and
  `src/mcp/adapters.spec.ts`.
- Completion regression: `src/lib/shell-completions/templates.spec.ts`.
- Performance: `benchmarks/copy.bench.ts` with captured repeated results.

The implementation plan should order database preflight/validation and filesystem hardening before
action-level failure tests, then complete integration evidence, documentation, and ROADMAP closeout.
