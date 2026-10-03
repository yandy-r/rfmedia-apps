# Pattern Research: Content Hashing During Copy Operations

## Architectural Patterns

### Audit and harden the shipped vertical slice

`docs/plans/content-hashing-during-copy-operations/feature-spec.md` defines issue #111 as a closeout
of PR #233, not a greenfield feature. Preserve the current vertical slice:

```text
command/delegated entry point
  -> action orchestration
  -> filesystem or conversion primitive
  -> hash final artifact
  -> inventory mapping
  -> prepared SQLite write
  -> completion/status update
```

Concrete boundaries already exist:

- CLI command/action separation: `packages/rfmedia-cli/src/commands/copy.ts` delegates to
  `actions/copy-album.ts:executeAlbumCopyWithFileInput()` or
  `actions/copy-filter.ts:executeFilterCopyWithFileInput()`.
- Queue and MCP reuse the same actions through `actions/queue.ts` and `mcp/adapters.ts`; do not add
  parallel hashing implementations for these entry points.
- Filesystem work belongs in `src/lib/filesystem.ts`; SHA-256 of an existing artifact belongs in
  `src/lib/integrity.ts:calculateHash()`; SQLite belongs in `src/lib/db.ts`.
- `src/lib/inventory.ts:createFileInventoryEntry()` translates source metadata into the portable
  inventory model. It should receive the digest, not hide a filesystem read.
- Completion ordering is owned by actions. In album copy,
  `copy-album.ts:recordAlbumInventory()` precedes `recordCompletedAlbumCopy()` in successful paths.
  Filter and sync paths should preserve the same write/hash/inventory/completion order.

Do not introduce the issue body's historical `hasher.ts`, `copy.ts`, or `database.ts` suggestions;
the repository's actual seams are `filesystem.ts`, `integrity.ts`, `db.ts`, `inventory.ts`, and the
three in-scope actions.

### Preserve the schema-version-9 model

`src/lib/schema.sql` already defines nullable `inventory.content_hash TEXT`, and
`src/lib/migrations.ts:CURRENT_SCHEMA_VERSION` is 9. Follow the existing sequential migration style:

- new databases receive the column from `schema.sql`;
- version-8 databases use `PRAGMA table_info(inventory)` and guarded `ALTER TABLE` in
  `runMigrations()`;
- historical rows remain `NULL`;
- no new table, key, index, backfill, or schema version belongs in this closeout.

The hardening gap is initialization order. `src/lib/db.ts:initializeDatabase()` currently executes
`schema.sql` before `runMigrations()` rejects a future version. Add a small read-only compatibility
preflight before `db.exec(schema)`, while distinguishing a new database without `metadata` from an
existing malformed/future database. Keep connection ownership local: any failure after opening the
database must close it before rethrowing.

### Keep asynchronous I/O outside synchronous transactions

`better-sqlite3` transactions in `db.ts:recordInventoryFiles()` are synchronous. Hash calculation,
streaming, conversion, and metadata reads must finish before entering that transaction. The batch
transaction should contain validation and prepared writes only; never `await` or open a stream inside
it.

## Code Conventions

- TypeScript uses ESM/NodeNext. Relative imports end in `.js`, as demonstrated throughout
  `src/lib/filesystem.ts` and `src/actions/copy-album.ts`.
- Application fields are camelCase (`contentHash` in `types/inventory.ts:FileInventoryEntry`);
  database row fields are snake_case (`content_hash` in `types/db.ts:DbInventoryEntry`). Preserve the
  conversion at `inventory.ts:loadInventoryFromDb()` and `appendFileRecordToDb()`.
- Lowercase SHA-256 hex is the only accepted new digest representation. Use one module-local pattern
  such as `/^[a-f0-9]{64}$/` in `db.ts`; do not add an algorithm enum or digest class.
- Keep `content_hash` nullable on reads for version-8 migration compatibility. Validate non-null
  producer input at `recordInventoryFile()` and `recordInventoryFiles()` rather than making the
  public read type falsely non-null.
- Prefer small functions and explicit parameters over service classes. Existing examples are
  `copy-album.ts:createInventoryRecord()`, `copy-filter.ts:recordCopiedFileInventory()`, and
  `sync.ts:copyOrConvertFile()`.
- Export only reusable boundaries. Digest validation can remain private to `db.ts` and be exercised
  through the two public write APIs.
- Retain JSDoc for exported helpers, including `@param`, `@returns`, and `@throws`, matching
  `filesystem.ts:copyOrLinkWithHash()` and `integrity.ts:calculateHash()`.
- Keep routine logs path/status oriented. `integrity.ts:verifyFileIntegrity()` logs digests only on a
  mismatch in debug output; normal copy output should not add stored hashes.
- Preserve the benchmark-only seam as an internal structural type in
  `benchmarks/copy.bench.ts:BenchmarkCopyOptions`; do not add it to `CopyOptions`, CLI flags, JSON,
  MCP schemas, or completions.
- No command or option changes means `lib/shell-completions/bash.ts`, `zsh.ts`, and `fish.ts` remain
  byte-for-byte unchanged. Run `shell-completions/templates.spec.ts` as a regression gate only.

## Error Handling

### Filesystem and cancellation

Mirror `filesystem.ts:withRetry()` and `createActionableMessage()`:

- retry only existing transient codes (`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`);
- create a fresh hash accumulator, streams, and transform inside each retry callback, as
  `copyOrLinkWithHash()` already does;
- pass the existing `AbortSignal` into `pipeline()` so cancellation interrupts active I/O, not only
  checks before it;
- do not retry aborts or non-transient hash/read/write errors;
- wrap terminal filesystem failures with the existing actionable path/context messages.

Before a stream-copy attempt, establish whether the destination already existed. On exhausted retry
or cancellation, clean up only a destination that this helper may have newly created. Reuse the
best-effort behavior of `filesystem.ts:cleanupPartialFile()`, but never recursively remove a
pre-existing user path. If cleanup fails, preserve the primary error and emit only diagnostic detail
for the cleanup failure.

Hardlink and conversion semantics remain distinct:

- `copyOrLinkWithHash()` hashes after link creation because there is no write stream;
- action conversion paths call `convertFile()` first and `integrity.ts:calculateHash(destPath)` only
  after the converter succeeds;
- neither path records inventory after hashing fails.

### SQLite validation and compatibility

Validate digests at the shared persistence boundary:

- `recordInventoryFile()` accepts `null`/omitted legacy values but throws before statement execution
  for any non-null value not matching lowercase 64-hex.
- `recordInventoryFiles()` validates each entry inside its existing `db.transaction()` callback so a
  malformed later entry rolls back earlier inserts in the batch.
- Do not interpolate hashes or paths into SQL; retain positional placeholders.

Follow `migrations.ts:runMigrations()` for future-version rejection, but move the compatibility check
ahead of `db.exec(schema)` in `initializeDatabase()`. A rejected future database must remain
unchanged. Wrap the full post-open initialization path in `try/catch`, close on error, and rethrow the
original error; the existing migration-only catch is too late for schema/preflight failures.

Actions already collect per-file failures in `FailedOperation` and set operation status through
`db.ts:updateOperationStatus()`. A copy, conversion, hash, database, or cancellation failure must not
fall through to `recordCompleted()` or `recordCompletedAlbumCopy()`.

## Testing Approach

Use Vitest with the repository's existing mix of real resources and focused mocks.

### Filesystem tests

Extend `src/lib/filesystem.test.ts` beside the existing real-file
`describe("copyOrLinkWithHash")` case:

- known regular-copy bytes produce the expected lowercase SHA-256;
- same-filesystem hardlink produces the same snapshot digest;
- an already-aborted signal rejects without creating a destination;
- active pipeline cancellation propagates and removes only a newly created partial destination;
- retry attempts use fresh hash state and final bytes, not accumulated failed-attempt state;
- a pre-existing destination is not removed by terminal cleanup.

Prefer deterministic stream/module mocks for “failure after destination creation” rather than a
timer racing a large temporary file. Keep at least one real temporary-file success test to prove the
Node stream integration.

### Database and migration tests

Extend `src/lib/db.test.ts`, which already uses `mkdtemp()`, real `better-sqlite3`, closes handles in
`afterEach`, and removes the temp directory:

- new database reports version 9 and includes `content_hash`;
- existing version 8 gains the nullable column and preserves its row;
- existing version 9 reopens without schema churn;
- version 10 is rejected before DDL and an exact `sqlite_master`/metadata snapshot is unchanged;
- valid single and batch hashes persist;
- uppercase, short, long, and non-hex non-null values are rejected;
- a batch with a valid early row and invalid later row leaves no rows from that batch;
- `NULL` retrieval remains supported.

Test the public APIs (`initializeDatabase()`, `recordInventoryFile()`,
`recordInventoryFiles()`, `getInventory()`), not private validator helpers.

### Action and delegation tests

- Extend `actions/copy-album.test.ts` from its existing inventory assertion to prove conversion/hash
  failure prevents the subsequent completion call and batch persistence occurs before completion.
- Extend `actions/copy-filter.test.ts` around `recordCopiedFileInventory()` for final destination,
  dry-run, accepted-existing-file, and hash failure ordering.
- Add focused `actions/sync.ts:syncFile()` coverage showing the inventory row receives a non-null
  final-destination hash before operation success. Preserve the feature spec's existing one-row-per-source
  semantics rather than adding ranged artifact storage.
- Queue and MCP tests should assert delegation to the top-level copy/sync actions; do not duplicate
  the filesystem matrix at each adapter.
- Plex, playlist, repair, link-video, and non-tracked watch paths are explicit deferred scope and
  should not receive speculative implementation tests in this plan.

### Benchmark and validation

Keep `benchmarks/copy.bench.ts` paired cases:

- “copy with SQLite inventory baseline (hash disabled)”;
- “copy with content hashing + SQLite inventory”.

Both must use the same fixture, filesystem, workers, force policy, tracking database, warmup, and
iteration settings from `benchmarks/helpers.ts:benchOptionsFor()`. Report medians, spread,
throughput, and memory for repeated small-file and representative media-sized samples. The `<5%`
target is evidence, not a wall-clock unit test; do not add a flaky CI timing assertion.

Run focused tests first, then package typecheck/test/build, completion template tests, repository
gates, benchmark evidence, and `git diff --check`.

## Patterns to Follow

| Concern                         | Pattern to mirror                                                                   | Concrete source                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| One-pass identical copy hashing | Fresh `createHash()` and transparent `Transform` inside the retry callback          | `packages/rfmedia-cli/src/lib/filesystem.ts:copyOrLinkWithHash()`                       |
| Existing-file hashing           | Stream file into SHA-256 and return lowercase hex                                   | `packages/rfmedia-cli/src/lib/integrity.ts:calculateHash()`                             |
| Retry policy                    | Small retryable-code allowlist and bounded backoff                                  | `packages/rfmedia-cli/src/lib/filesystem.ts:withRetry()`                                |
| Actionable filesystem errors    | Map errno to path/context guidance                                                  | `packages/rfmedia-cli/src/lib/filesystem.ts:createActionableMessage()`                  |
| Best-effort partial cleanup     | Preserve primary failure while cleanup logs diagnostic detail                       | `packages/rfmedia-cli/src/lib/filesystem.ts:cleanupPartialFile()`                       |
| Album inventory batching        | Collect records, then use one prepared transaction before completion                | `packages/rfmedia-cli/src/actions/copy-album.ts:recordAlbumInventory()`                 |
| Filter inventory finalization   | Hash accepted destination, construct inventory entry, persist through shared DB API | `packages/rfmedia-cli/src/actions/copy-filter.ts:recordCopiedFileInventory()`           |
| Sync inventory routing          | `createFileInventoryEntry()` then `appendFileRecord()`                              | `packages/rfmedia-cli/src/actions/sync.ts:syncFile()`                                   |
| Database writes                 | Positional prepared statement and `db.transaction()` batch                          | `packages/rfmedia-cli/src/lib/db.ts:recordInventoryFile()` and `recordInventoryFiles()` |
| Nullable legacy mapping         | Include `contentHash` only when DB value is non-null                                | `packages/rfmedia-cli/src/lib/inventory.ts:loadInventoryFromDb()`                       |
| Guarded v8 migration            | Inspect table columns before `ALTER TABLE`, then advance metadata                   | `packages/rfmedia-cli/src/lib/migrations.ts:runMigrations()`                            |
| Real migration tests            | Temporary SQLite database with explicit old schema and preserved row                | `packages/rfmedia-cli/src/lib/db.test.ts` version-9 migration suite                     |
| Real digest test                | Temporary source/destination and independently computed expected digest             | `packages/rfmedia-cli/src/lib/filesystem.test.ts` `copyOrLinkWithHash` suite            |
| Like-for-like performance       | Hash-disabled tracked baseline versus hash-enabled tracked copy                     | `packages/rfmedia-cli/benchmarks/copy.bench.ts`                                         |

Avoid patterns that expand the closeout: no new schema version/index/artifact table, no generic
hashing service, no second copy pipeline, no algorithm flag, no completion edits, no read-time
verification, and no broad Plex/watch provenance retrofit.
