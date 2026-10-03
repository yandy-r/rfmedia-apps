# Architecture Research: Content Hashing During Copy Operations

## System Overview

The content-hashing feature sits inside the `rfmedia` TypeScript CLI's existing copy and inventory
pipeline. User-facing entry points normalize `CopyOptions` and delegate to the same action layer:

- `packages/rfmedia-cli/src/commands/copy.ts` dispatches interactive/CLI album and filter copies.
- `packages/rfmedia-cli/src/actions/queue.ts` restores queued options and delegates queued copy jobs.
- `packages/rfmedia-cli/src/mcp/adapters.ts` adapts MCP album, filter, and sync requests to the same
  action functions.

The inventory-owning action layer is `packages/rfmedia-cli/src/actions/copy-album.ts`,
`packages/rfmedia-cli/src/actions/copy-filter.ts`, and `packages/rfmedia-cli/src/actions/sync.ts`.
These actions coordinate asynchronous filesystem work, optional conversion and hardlinking,
inventory capture, completion tracking, undo history, hooks, concurrency, and cancellation. Hashes
are part of the inventory record for successful writes; they are not a separate operation or a
user-visible copy result.

Hash creation has two architectural paths. Regular album copies can use the transparent SHA-256
stream in `packages/rfmedia-cli/src/lib/filesystem.ts`, which returns the digest with copy metadata.
Operations without that byte-copy stream (conversions, hardlinks, filter copies, and sync's first
destination) read the final artifact with `calculateHash()` from
`packages/rfmedia-cli/src/lib/integrity.ts`. Both converge on the portable inventory model in
`packages/rfmedia-cli/src/lib/inventory.ts` and the synchronous SQLite APIs in
`packages/rfmedia-cli/src/lib/db.ts`.

The database is also shared with operation history and completed-source tracking. New databases are
created from `packages/rfmedia-cli/src/lib/schema.sql`; existing databases are upgraded by
`packages/rfmedia-cli/src/lib/migrations.ts`. Schema version 9 adds nullable
`inventory.content_hash`, allowing historical version 8 rows to remain unknown while new tracked
writes carry a lowercase SHA-256 value.

## Relevant Components

| Path                                                | Architectural role                                                                                            | Hashing relevance                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/commands/copy.ts`         | Parses copy options and dispatches album or filter mode                                                       | No hash option is exposed; behavior is inherited from actions                                                     |
| `packages/rfmedia-cli/src/actions/queue.ts`         | Executes persisted copy jobs through album/filter actions                                                     | Queue routes inherit hashing without a queue schema change                                                        |
| `packages/rfmedia-cli/src/mcp/adapters.ts`          | Converts MCP arguments into copy/sync action options                                                          | MCP copy and sync routes inherit hashing without output-schema changes                                            |
| `packages/rfmedia-cli/src/actions/copy-album.ts`    | Recursively copies albums, converts audio, processes suffix ranges, batches inventory, and records completion | Uses one-pass copy hashing, post-conversion hashing, and inventory-before-completion ordering                     |
| `packages/rfmedia-cli/src/actions/copy-filter.ts`   | Selects rated tracks, creates first and ranged copies, records per-file inventory, and tracks completion      | `recordCopiedFileInventory()` hashes the accepted destination before the SQLite write                             |
| `packages/rfmedia-cli/src/actions/sync.ts`          | Diffs inventory, writes new/updated destinations, and persists incremental inventory                          | Hashes the first destination represented by sync's existing one-row-per-source-file model                         |
| `packages/rfmedia-cli/src/lib/filesystem.ts`        | Shared async copy/hardlink helpers, retries, timestamps, and partial-file cleanup utilities                   | `copyOrLinkWithHash()` streams copy bytes through SHA-256; hardlinks require a snapshot read                      |
| `packages/rfmedia-cli/src/lib/integrity.ts`         | Shared full-file hashing and immediate source/destination comparison                                          | `calculateHash()` handles final artifacts; `verifyFileIntegrity()` remains the distinct `--verify` read-back path |
| `packages/rfmedia-cli/src/lib/inventory.ts`         | Maps SQLite/JSONL inventory and creates file entries                                                          | Carries `contentHash` through create, append, load, and legacy serialization paths                                |
| `packages/rfmedia-cli/src/lib/db.ts`                | Opens `better-sqlite3`, applies pragmas/schema, and exposes inventory writes/reads                            | Persists `content_hash` in single and transactional batch APIs                                                    |
| `packages/rfmedia-cli/src/lib/schema.sql`           | Canonical new-database schema asset                                                                           | Defines nullable `inventory.content_hash TEXT` and schema version 9                                               |
| `packages/rfmedia-cli/src/lib/migrations.ts`        | Application-managed schema upgrades                                                                           | Guardedly adds `content_hash` for pre-v9 databases and rejects versions above 9                                   |
| `packages/rfmedia-cli/src/lib/completed-tracker.ts` | Records source- and suffix-level success/failure in SQLite or legacy files                                    | Completion must occur only after hash finalization and inventory persistence                                      |
| `packages/rfmedia-cli/src/types/inventory.ts`       | Portable inventory contracts                                                                                  | `FileInventoryEntry.contentHash` is optional/nullable for legacy compatibility                                    |
| `packages/rfmedia-cli/src/types/db.ts`              | SQLite row contracts                                                                                          | `DbInventoryEntry.content_hash` is `string \| null`                                                               |
| `packages/rfmedia-cli/benchmarks/copy.bench.ts`     | Direct-copy and hardlink benchmark harness                                                                    | Compares tracked copies with a benchmark-only hash-disable seam against hashing enabled                           |

## Data Flow

1. **Entry and database setup.** CLI, queue, or MCP code constructs `CopyOptions` and delegates to
   an action. Album/filter actions open SQLite when tracking or undo requires it; sync opens SQLite
   for non-legacy, non-dry-run inventory. `initializeDatabase()` configures WAL,
   `synchronous=NORMAL`, a busy timeout, and foreign keys, then loads the SQL asset and runs
   migrations. The feature specification requires the future-version compatibility check to occur
   before schema DDL so an unsupported database is not mutated during this setup.
2. **Destination creation.** Album direct copies call `copyOrLinkWithHash()`. Its copy branch reads
   the source, updates SHA-256 in a transparent transform, forwards unchanged chunks to the
   destination, restores timestamps, and returns `{ method, contentHash, mtime, size }`. The
   hardlink branch creates the link and performs a full-file hash because there is no copy stream.
   Album conversions hash the converted destination after the converter succeeds. Filter and sync
   paths currently create/convert/link first, then call `calculateHash()` on the final destination.
3. **Inventory construction.** The action associates the digest with source identity, relative
   path, source metadata, rating/extended metadata, absolute destination, and copy time.
   `copy-album.ts` accumulates per-directory records for a batch write; `copy-filter.ts` writes one
   record per accepted destination; `sync.ts` appends the first destination for each source file to
   its existing incremental inventory.
4. **Persistence.** `recordInventoryFile()` and `recordInventoryFiles()` insert positional values
   into `inventory.content_hash`; the batch API uses one prepared statement inside a synchronous
   `better-sqlite3` transaction. The feature contract requires lowercase 64-hex validation at both
   shared write APIs, with batch validation occurring inside the transaction so one invalid entry
   rolls back the batch. Async copy/hash work remains outside SQLite transactions.
5. **Completion.** Album and filter actions call the completed tracker only after successful file
   processing. The required invariant is `write/convert -> finalize hash -> persist inventory ->
mark suffix/source complete`; a hash or inventory error must therefore flow through the existing
   failed/partial operation path rather than producing a completion marker.
6. **Read and future consumption.** `getInventory()`/`getInventoryForSource()` return
   `DbInventoryEntry` rows, and `loadInventory()` maps non-null `content_hash` values back to
   `FileInventoryEntry.contentHash`. Version 8 migrations intentionally map old rows to `NULL`.
   Stored hashes are write-time fingerprints for future verification/deduplication consumers;
   `--verify` continues to call `verifyFileIntegrity()` and independently reads both source and
   destination.

## Integration Points

- **Shared copy primitive contract.** `copyOrLinkWithHash()` is the efficient integration point for
  byte-identical album copies. Each retry must own fresh streams and hash state, pass the existing
  `AbortSignal` to `pipeline()`, and remove only a newly created partial destination that the helper
  owns. Its returned `mtime` and `size` let album inventory avoid an additional metadata read.
- **Final-artifact boundary.** Conversion cannot hash source bytes because the inventory destination
  contains transformed bytes. Hardlink, conversion, filter, and sync paths must finalize the hash
  only after the destination exists successfully. Hardlink hashes are snapshots, since source and
  destination share an inode after creation.
- **Inventory context boundary.** Album/filter inventory is active only when tracking supplies both
  a `DbConnection` and `operationId`; sync uses an `InventoryContext` that can route to SQLite or
  legacy JSONL. The contract must not open a hidden database merely because completed tracking is
  disabled or legacy mode is selected. Dry-run bypasses database setup and all copy/hash/write work.
- **Persistence trust boundary.** `recordInventoryFile()` and `recordInventoryFiles()` are the last
  shared boundary before SQLite and therefore the correct enforcement point for digest shape. The
  column remains nullable so legacy rows and explicitly unknown portable records still load.
- **Operation identity.** `inventory` is unique by operation, source path, and relative path. Album
  ranges can produce inventory for multiple destinations under one operation; sync intentionally
  persists only its first destination. Expanding to a general one-to-many artifact ledger is outside
  this issue.
- **Completion and error propagation.** `recordCompleted()` and `recordCompletedAlbumCopy()` share
  the same tracking database as inventory when SQLite tracking is active. Action tests must prove
  that hash/copy/database failures prevent completion, while successful persistence precedes it.
- **Schema compatibility.** `schema.sql` is executed by `initializeDatabase()` and copied into
  `dist/lib/schema.sql` by the `copy-assets` build script. Migration behavior therefore spans
  `db.ts`, `schema.sql`, and `migrations.ts`; future-version detection must inspect existing metadata
  before DDL, while the version 8-to-9 migration retains its `PRAGMA table_info(inventory)` guard.
- **Delegated entry points.** CLI, queue, and MCP layers do not implement filesystem or inventory
  behavior. Regression coverage should assert delegation rather than duplicate hashing logic or add
  new MCP/queue fields.
- **User interface stability.** This feature adds no flag, log field, JSON/MCP output field, or hash
  display. Bash, Zsh, and Fish completion templates need parity tests only; no completion content
  changes are architecturally required.
- **Performance seam.** The private album inventory `hashContent` setting is driven by
  `benchmarkDisableContentHashing` only in the benchmark path. It permits like-for-like direct-copy
  comparisons without becoming a runtime CLI option.

## Key Dependencies

- **Node.js 22 built-ins:** `node:crypto` supplies SHA-256; `node:fs` supplies streams and hardlinks;
  `node:stream` supplies the transparent transform; `node:stream/promises` supplies pipeline and
  cancellation integration. `packages/rfmedia-cli/package.json` requires Node.js 22 or newer.
- **`better-sqlite3` (`^12.6.2`):** provides synchronous prepared statements, transactions, schema
  inspection, and the shared tracking/inventory store. Async filesystem work cannot run inside its
  transaction callbacks.
- **`fs-extra` (`^11.0.0`) and filesystem helpers:** support directory creation, removal, copying,
  retry handling, timestamp restoration, and partial-file cleanup around the hash pipeline.
- **FFmpeg conversion layer:** `packages/rfmedia-cli/src/lib/convert.ts` produces converted outputs;
  hashes must be computed from those outputs after successful conversion.
- **Concurrency and cancellation:** `packages/rfmedia-cli/src/lib/parallel.ts` schedules album and
  filter tasks, while `packages/rfmedia-cli/src/lib/signal-handler.ts` supplies the global/local
  abort lifecycle and partial-file cleanup hooks.
- **Vitest and TypeScript:** focused coverage lives beside the relevant action and library modules,
  including `filesystem.test.ts`, `integrity.test.ts`, `db.test.ts`, `inventory.test.ts`,
  `copy-album.test.ts`, `copy-filter.test.ts`, and sync/delegation tests. The package build also copies
  the SQL schema asset, so both typechecking and a package build exercise architectural boundaries.
