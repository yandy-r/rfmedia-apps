# Centralized Tracking Database

This document describes the current SQLite tracking contract used by rfmedia-cli.

## Overview

The default tracking backend is a SQLite database selected from the existing XDG or legacy path. It
consolidates operation progress, file inventory, granular album-range completion, undo history,
queue state, Plex/playlist feature state, Lidarr resilience state, and Plex-Lidarr identity
snapshots into one queryable store. Metadata reconciliation consumes operation-scoped inventory
evidence; it does not reinterpret `inventory` as one canonical global catalog.

The tracking backend provides:

- resumable copy and sync operations;
- per-album-suffix completion for efficient range expansion;
- file inventory for album copy, filter copy, and sync;
- observational Plex-Lidarr artist snapshots for exact-scope offline reporting;
- transactional writes and foreign-key cleanup;
- migration from older database schemas and legacy sidecar tracking.

The database is an implementation detail of existing commands. Content fingerprinting does not add
a new CLI flag, operation identity, or output field.

## Database Location and Configuration

Default-path search order:

1. Existing `~/.config/rfmedia/tracking.db` (XDG location)
2. Existing `~/.rfmedia/tracking.db` (legacy location)
3. `~/.config/rfmedia/tracking.db` when a write-capable command needs a new database

Configure a different path or select legacy tracking in `.rfmedia.yaml`:

```yaml
tracking:
  database: /custom/path/tracking.db
  useLegacy: false
```

| Option               | Type      | Default             | Description                                      |
| -------------------- | --------- | ------------------- | ------------------------------------------------ |
| `tracking.database`  | `string`  | Default-path search | Path to the SQLite database                      |
| `tracking.useLegacy` | `boolean` | `false`             | Use legacy file-based tracking instead of SQLite |

Copy tracking can also be disabled with `copy.trackCompleted: false` or
`--no-track-completed`. Disabling tracking does not initialize a hidden database solely to store
content hashes.

## Schema Version 11

The current schema version is **11**. The database contains these groups of tables:

| Area                    | Tables                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Copy and sync tracking  | `operations`, `completed_sources`, `failed_sources`, `inventory`, `completed_album_copies`                         |
| Undo history            | `history_sessions`, `history_operations`                                                                           |
| Queue                   | `queue_jobs`, `queue_job_sources`, `queue_job_selections`, `queue_job_selected_items`                              |
| Plex queries            | `plex_queries`, `plex_query_results`                                                                               |
| Playlist features       | `playlist_exports`, `playlist_export_tracks`, `smart_playlists`, `smart_playlist_history`, `smart_playlist_tracks` |
| Lidarr resilience       | `lidarr_deferred_intents`, `lidarr_metadata_cache`, `lidarr_circuit_state`                                         |
| Provider identity cache | `bridge_identity_snapshots`                                                                                        |
| Schema metadata         | `metadata`                                                                                                         |

This guide focuses on the copy and sync tracking tables. See `src/lib/schema.sql` for the complete
schema.

### Operations and Completion

`operations` identifies a copy or sync operation by its command, mode, input identifier, and options
hash. `completed_sources` and `failed_sources` record source-level outcomes.

`completed_album_copies` supplements source completion with one row per completed album suffix. This
is the existing range-expansion model: command logic can identify completed suffixes and process only
missing suffixes. Content hashes do not change operation identity or replace per-suffix completion
tracking.

### Inventory

The inventory `content_hash` field was introduced in schema version 9 and remains unchanged in
schema version 11:

```sql
CREATE TABLE inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  rating REAL,
  genre TEXT,
  year INTEGER,
  bpm REAL,
  artist TEXT,
  dest_path TEXT NOT NULL,
  content_hash TEXT,
  copied_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
  UNIQUE(operation_id, source_path, relative_path)
);
```

The unique key intentionally preserves one inventory row for each source file within an operation.
For ranged output, the row stores the destination represented by the command's current one-row
model; it is not a one-to-many artifact ledger.

Metadata reconciliation joins a local file to inventory only through its root-contained,
normalized absolute `dest_path`. Row ID, `operation_id`, `source_path`, and `relative_path` remain
provenance rather than alternate matching keys. Different operations can legitimately record the
same destination, so multiple rows for one `dest_path` are ambiguous unless
`--operation-id <positive-integer>` selects a generation that leaves exactly one candidate.
Reconciliation never chooses the newest row or guesses by filename.

The schema can store `rating`, `genre`, `year`, `bpm`, and `artist`, but current production
inventory creation generally persists path, stat, rating, and hash evidence. The other metadata
columns can therefore be `NULL`. A `NULL` value is absent database evidence, not an instruction
for `--db-wins` to clear a file or media-server value.

### Plex-Lidarr Identity Snapshots

Schema version 11 added `bridge_identity_snapshots`. Its unique scope is the canonical,
credential-free Plex origin, Plex machine ID, stable Plex library section ID, canonical Lidarr
origin, and artist entity kind. Payload and resolver versions are stored separately from the
database schema version.

`rfmedia lidarr reconcile` writes snapshot document version 2 into this existing schema-version-11
table after a complete live observation validates. Snapshot v2 contains every Plex resolution
outcome and a bounded minimal projection of every Lidarr artist, which is required to reproduce
truthful reverse gaps offline. The payload-only v1-to-v2 change does not add a table, column, index,
or database migration. Snapshot v1 remains stored but is incompatible with offline reconciliation
and requires a successful live refresh.

The live cache replacement is a short atomic same-scope upsert. It is observational durability, not
a Plex or Lidarr mutation, and a failed or older replacement does not erase a newer valid
generation.

Offline reconciliation opens an existing schema-version-11 database read-only. It filters compatible
snapshot-v2 metadata by both canonical origins, artist kind, and optional stable Plex library ID,
then requires exactly one full scope. It never chooses the newest row, merges scopes, migrates the
database, refreshes the cache, or writes SQLite sidecars. Cached evidence is always reported as
stale with capture time, verification time, and age, and it never authorizes a mutation.

The immutable read-only database snapshot is limited to 256 MiB before any file contents are loaded
into memory. Oversized tracking databases fail closed; operators must compact or archive historical
tracking data before retrying offline reconciliation or evidence-backed verification.

## Inventory Producers

The following database-tracked workflows own general copy-operation inventory rows:

| Producer      | Inventory behavior                                                                |
| ------------- | --------------------------------------------------------------------------------- |
| Album copy    | Persists file records in a batch before recording suffix/source completion        |
| Filter copy   | Persists each accepted final destination before successful completion tracking    |
| Sync          | Updates the represented destination in its existing one-row-per-source model      |
| Queue and MCP | Inherit the same behavior when they delegate to album/filter copy or sync actions |

This does not imply that Plex query copy, playlist export/sync, repair, `link-videos`, or untracked
watch writes create general copy-operation inventory rows. Those surfaces retain their existing
storage models.

## Content Fingerprint Contract

`inventory.content_hash` stores a lowercase, 64-character SHA-256 fingerprint of the final
destination bytes at write time.

- A regular copy obtains the digest from the completed copy pipeline.
- A converted file is hashed after conversion, so the digest represents the converted artifact,
  not the source encoding.
- A hardlink is hashed after link creation. The value is a snapshot of the shared inode at that
  time; later writes through any hardlink can make the stored value stale.
- Existing version-8 rows and legacy inventory may contain `NULL` or omit the portable
  `contentHash` field. Unknown hashes are not fabricated or automatically backfilled.
- New successful database-inventoried writes must provide a valid non-null digest.
- Full hashes are not printed during routine operation.

The producer work associated with issue #111 and PRs #233 and #248 records these final-artifact
fingerprints. It is distinct from the copy command's `--verify` option, which immediately reads back
source and destination for byte-identical work. Issue #116 adds a later, read-only consumer through
the default and deep tiers of `rfmedia verify`.

These hashes provide local integrity evidence. They are not digital signatures, do not identify a
trusted producer, and do not establish artifact authenticity. Stale-hardlink policy,
deduplication, and one-to-many artifact storage remain outside this schema contract.

## Read-Only Verification Consumer

The quick tier compares source and destination metadata and does not resolve or open the tracking
database. Default and deep verification select the database in this order:

1. Explicit `--tracking-database`
2. `undo.database`
3. `tracking.database`
4. The existing default-path search described above

Verification then opens only an existing, non-symlink, regular schema-version-11 database. It reads
an immutable in-memory snapshot, capped at 256 MiB before file loading, with SQLite `query_only`
enabled. It does not initialize a missing database, migrate an older schema, accept a newer schema,
change journal mode, write metadata or inventory, backfill fingerprints, or create WAL/SHM/journal
sidecars. Active SQLite sidecars, oversized files, and a database that changes while the snapshot is
read are rejected.

Candidate lookup joins `inventory` with `operations` for the requested source paths. The verifier
then requires exactly one normalized match across source path, relative path, destination path, and
conversion key. It does not guess across operations, substitute another destination, or redirect a
configured path. No match is missing evidence; multiple exact matches are ambiguous evidence.

Legacy version-8 rows migrated through version 9 to the current schema retain nullable hashes. A
`NULL`, malformed, missing, or ambiguous fingerprint is reported as unverifiable rather than
corrupt. There is no verification-time backfill. Converted artifacts remain verifiable against the
stored hash of their final converted bytes, while deep source-to-destination byte comparison is not
applicable because conversion changes the bytes.

Ranged output retains the existing one-row-per-source representation. Only the destination recorded
by that row can supply exact fingerprint evidence; verification does not infer hashes for other
ranged artifacts.

## Metadata Reconciliation Consumer

`rfmedia reconcile scan` and the default `rfmedia reconcile apply` preview reuse the hardened
read-only snapshot contract above. They require an existing schema-version-11 database and never
initialize, create, migrate, checkpoint, change journal mode, or write it. They also reject active
SQLite sidecars rather than creating or consuming mutable WAL state.

Only an authorized apply (`--execute` plus interactive approval or `--yes`) may reopen SQLite
writable. A database target updates exactly one selected inventory row and only its rating and/or
filesystem-derived mtime and size. The short transaction guards the update with the reviewed row
ID, operation ID, normalized destination, prior rating, prior mtime, and prior size. If any
expected value changed, no row is overwritten and the outcome is reported as `stale-evidence`.

A missing destination remains a report-only stale finding. For a uniquely selected, still-present
regular file, apply may refresh changed stat evidence after fresh verification. It never deletes a
missing or stale inventory row, so prior operation history remains available.

File-tag writes, media-server requests, and SQLite updates cannot share one atomic transaction.
External targets run before the guarded database update, each target retains its own outcome, and
an executed apply performs a fresh post-apply scan so partial convergence is visible. Metadata
reconciliation adds no table, column, or schema migration; the current schema remains version 11.

## Write and Failure Ordering

Tracked file success follows this order:

```text
write, link, or convert destination
  -> finalize SHA-256
  -> persist inventory
  -> record suffix/source completion
```

A copy, conversion, hash, or inventory-persistence failure therefore cannot produce a new completion
marker with an unknown fingerprint. Batch inventory validation runs inside the existing SQLite
transaction, so an invalid digest rolls back the batch.

Dry-run stops before this lifecycle: it performs no destination write, hash read, database creation
or schema migration, inventory write, or completion write.

## Migration Behavior

Database initialization performs a compatibility preflight before applying schema DDL to an existing
versioned database. A database newer than schema version 11 is rejected unchanged so that an older
CLI cannot rewrite it.

The version-8 to version-9 migration:

1. inspects `PRAGMA table_info(inventory)`;
2. adds nullable `content_hash TEXT` only when the column is absent;
3. records schema version 9 after the migration succeeds.

The migration deliberately does not scan destination files or backfill historical rows. Migration
then creates the Lidarr resilience tables at version 10 and `bridge_identity_snapshots` at version
11 using idempotent schema DDL. Reopening a version-11 database performs no schema churn.

Legacy `.completed.*` and `.failed.*` files can still be imported when database tracking is selected.
The original files are preserved. Selecting `tracking.useLegacy: true` continues using sidecar files
and does not create or migrate SQLite solely for fingerprint storage.

## Data Flow

```text
copy-album / copy-filter / sync
  |
  +-- dry-run --------------------------> preview only
  |
  +-- tracking disabled ----------------> filesystem action only
  |
  +-- legacy tracking ------------------> sidecar completion/inventory routing
  |
  `-- database tracking
       -> preflight and open schema v11
       -> find or create operation
       -> load completed and inventory state
       -> write/hash/persist each successful artifact
       -> record completion only after inventory succeeds
       -> update operation status and counts
```

## Core APIs

### Initialization and Operations

```typescript
const db = await initializeDatabase();

const operationId = createOperation(db, {
  command: "copy-filter",
  mode: "filter",
  inputFile: "paths.txt",
  optionsHash: "filter-r80-mp3",
  ratingKey: "r80",
  rangeKey: null,
  convertKey: "mp3",
});
```

### Inventory Writes

```typescript
recordInventoryFile(db, operationId, {
  sourcePath: "/music/Artist",
  relativePath: "Album/01-Track.flac",
  mtime: 1705420000000,
  size: 8234567,
  rating: 0.8,
  destPath: "/dest/liked-songs/Artist/01-Track.mp3",
  contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
});
```

Both `recordInventoryFile()` and `recordInventoryFiles()` reject non-null values that do not match
`/^[a-f0-9]{64}$/`. The batch API uses one prepared statement inside a synchronous transaction;
filesystem reads and hashing remain outside that transaction.

### Portable Inventory Mapping

Database `content_hash` maps to the portable `contentHash?: string | null` field. A present digest,
explicit `null`, and an omitted legacy value remain distinguishable without manufacturing data.

## Implementation Files

| File                              | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `src/lib/schema.sql`              | Complete schema and version metadata                           |
| `src/lib/migrations.ts`           | Current version and sequential migrations                      |
| `src/lib/db.ts`                   | Initialization, read-only snapshot opening, queries, CRUD APIs |
| `src/lib/inventory.ts`            | Database/legacy inventory routing and portable mapping         |
| `src/lib/completed-tracker.ts`    | Database/legacy completion routing and migration               |
| `src/lib/tiered-verification.ts`  | Exact candidate resolution and tier evidence policy            |
| `src/actions/reconcile.ts`        | Read-only acquisition and authorized guarded updates           |
| `src/lib/bridge/cache.ts`         | Strict identity snapshot CRUD and compatible-scope selection   |
| `src/actions/lidarr/reconcile.ts` | Live/offline identity cache lifecycle                          |
| `src/actions/copy-album.ts`       | Album inventory batches and completion ordering                |
| `src/actions/copy-filter.ts`      | Filter destination fingerprint persistence                     |
| `src/actions/sync.ts`             | Incremental inventory updates                                  |
| `src/actions/verify-album.ts`     | Album verification consumer                                    |
| `src/actions/verify-filter.ts`    | Filter verification consumer                                   |

## Related Documentation

- [Tracking System](tracking-system.md) - operation identity and granular range expansion
- [Sync Command](sync-command.doc.md) - incremental inventory behavior
- [Undo/History System](undo-history-system.md) - history tables and rollback
- [Content Hashing During Copy Operations](content-hashing-during-copy-operations.md) - fingerprint producer contract
- [File Integrity Verification](../../../../docs/features/file-integrity-verification.md) - copy read-back and tiered verification
- [Metadata Reconciliation](metadata-reconciliation.md) - three-plane inventory consumer and guarded repair
- [Plex-Lidarr Reconciliation](plex-lidarr-reconciliation.md) - snapshot-v2 live and offline operator contract
