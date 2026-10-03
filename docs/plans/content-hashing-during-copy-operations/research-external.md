# External API Research: Content Hashing During Copy Operations

## Executive Summary

Issue #111 does not require a new runtime dependency. The repository already targets Node.js 22 or
newer and pins `better-sqlite3` 12.6.2, so the strongest implementation uses Node's built-in
`node:crypto`, `node:stream/promises`, and `node:fs` APIs, then persists the completed digest through
the existing synchronous SQLite connection.

For an ordinary byte-for-byte copy, compute SHA-256 in the same pass that writes the destination:
`ReadStream -> hash-tap Transform -> WriteStream`. The tap must call `hash.update(chunk)` and forward
the unchanged chunk. Piping through Node's `Hash` object itself is not a copy tee: a `Hash` stream
emits the digest, not the original file bytes. Await `pipeline()` before calling `digest("hex")`, and
pass the operation's `AbortSignal` as the pipeline's final options argument.

This one-pass design removes the extra full-file read that would otherwise make the issue's `<5%`
copy-time overhead target difficult. It does not prove that target: SHA-256 is synchronous CPU work,
copy worker concurrency can create event-loop contention, hardlinks have no write stream, and ffmpeg
conversions produce their destination outside the Node pipeline. Benchmark direct copies, hardlinks,
conversions, warm-cache runs, and cold-cache runs independently before accepting the performance
claim.

Persist only after the file stream or converter has finished successfully and the digest is final.
Filesystem I/O and SQLite cannot share an atomic transaction, and `better-sqlite3` transaction
functions cannot contain asynchronous copy work. A failed pipeline must remove or quarantine the
partial destination; a failed database insert must be surfaced as an incomplete copy/tracking result
that resume logic can repair. Existing inventory rows should migrate with a nullable hash so old
databases remain readable and can be backfilled deliberately.

The current repository shape supports this approach: copy behavior is centralized around
`copyOrLink()` plus conversion paths, inventory already owns destination path and copy metadata, and
the SQLite layer uses prepared statements and synchronous batch transactions. The API seam should
return a structured result containing the actual copy method and the digest, then thread that value
into inventory storage instead of rereading the destination in each action.

## Primary APIs

### Node.js `node:crypto`

Official documentation:

- [Node.js 22 Crypto API](https://nodejs.org/docs/latest-v22.x/api/crypto.html)
- [`crypto.createHash()`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatehashalgorithm-options)
- [`Hash.update()`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#hashupdatedata-inputencoding)
- [`Hash.digest()`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#hashdigestencoding)

`createHash("sha256")` creates a streaming SHA-256 accumulator. `update()` accepts `Buffer` chunks
and may be called repeatedly. `digest("hex")` returns the conventional lowercase hexadecimal form;
SHA-256 therefore occupies 64 text characters. A `Hash` cannot be reused after `digest()`, so every
copy attempt and every retry needs a fresh instance.

Node also exposes one-shot hash helpers, but they require the complete input in memory. They are not
appropriate for multi-gigabyte media files. The incremental `createHash()` interface keeps memory
bounded by stream buffering.

### Node.js streams and filesystem APIs

Official documentation:

- [Node.js 22 Stream API](https://nodejs.org/docs/latest-v22.x/api/stream.html)
- [Promise-based `pipeline()`](https://nodejs.org/docs/latest-v22.x/api/stream.html#streampipelinesource-transforms-destination-options)
- [Stream backpressure and buffering](https://nodejs.org/docs/latest-v22.x/api/stream.html#buffering)
- [`fs.createReadStream()`](https://nodejs.org/docs/latest-v22.x/api/fs.html#fscreatereadstreampath-options)
- [`fs.createWriteStream()`](https://nodejs.org/docs/latest-v22.x/api/fs.html#fscreatewritestreampath-options)
- [`fsPromises.copyFile()` failure semantics](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisescopyfilesrc-dest-mode)
- [`fsPromises.link()`](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromiseslinkexistingpath-newpath)

`pipeline()` forwards errors, applies backpressure, and destroys the participating streams when one
fails. Its promise form accepts `{ signal }`; aborting destroys the underlying pipeline with an
`AbortError`. Destruction closes descriptors but does not establish application-level cleanup of a
partially written destination. Node explicitly makes no atomicity guarantee even for `copyFile()` and
only attempts to remove a destination after an error. A manual stream pipeline therefore needs its
own deterministic partial-file cleanup policy.

Streams bound memory by pausing reads when downstream buffers reach their high-water marks. Use the
defaults initially. Buffer-size tuning is platform- and workload-sensitive and should only follow
benchmarks; increasing buffers is not a substitute for respecting backpressure.

### `better-sqlite3` 12.6.2

Official project documentation matching the pinned version:

- [`better-sqlite3` 12.6.2 API](https://github.com/WiseLibs/better-sqlite3/blob/v12.6.2/docs/api.md)
- [Raw 12.6.2 API reference](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v12.6.2/docs/api.md)
- [`better-sqlite3` project README](https://github.com/WiseLibs/better-sqlite3/tree/v12.6.2)

Relevant surfaces are:

- `db.prepare(sql)` creates a reusable prepared statement.
- `statement.run(...)` performs an insert/update and throws on failure.
- `statement.get(...)` returns the first row or `undefined`.
- `statement.all(...)` returns all rows.
- `db.transaction(fn)` commits when the synchronous function returns and rolls back when it throws.
- `db.pragma(...)` is the supported wrapper for SQLite pragmas.
- `SqliteError.code` exposes SQLite's extended result code.

The critical caveat is explicit in the library documentation: transaction functions do not work
with async functions. They commit when the async function first returns its promise, before awaited
copy work runs. SQLite also serializes transactions, so holding a write transaction across event-loop
ticks would be harmful even if it were possible.

### SQLite schema, transaction, and index behavior

Official SQLite documentation:

- [Datatypes and storage classes](https://www.sqlite.org/datatype3.html)
- [Transactions](https://www.sqlite.org/lang_transaction.html)
- [Write-ahead logging](https://www.sqlite.org/wal.html)
- [`PRAGMA synchronous` and `busy_timeout`](https://www.sqlite.org/pragma.html)
- [`ALTER TABLE ADD COLUMN`](https://www.sqlite.org/lang_altertable.html#altertabaddcol)
- [UPSERT](https://www.sqlite.org/lang_upsert.html)
- [`ON CONFLICT` and `REPLACE`](https://www.sqlite.org/lang_conflict.html)
- [Partial indexes](https://www.sqlite.org/partialindex.html)

A digest can be stored as 64-character hexadecimal `TEXT` or a 32-byte `BLOB`. SQLite stores BLOB
bytes exactly, while TEXT uses the database text encoding. The repository's machine- and human-facing
interfaces already favor strings, so lowercase hex `TEXT` is the simplest compatible contract. Raw
BLOB is smaller but adds conversion at every TypeScript and JSON boundary.

`ALTER TABLE inventory ADD COLUMN content_hash TEXT` is a fast, compatible migration for existing
rows because the new value is nullable. Retrieval must preserve `NULL` as "not computed" rather than
confusing it with the SHA-256 of an empty file.

SQLite allows multiple simultaneous readers but only one writer. WAL improves reader/writer
concurrency; it does not permit multiple simultaneous write transactions. Under WAL,
`synchronous=NORMAL` avoids a sync on most commits and protects consistency, but a recent commit may
be lost after an OS crash or power failure. That durability tradeoff is acceptable only if inventory
hashes are explicitly treated as rebuildable metadata.

## Libraries/SDKs

### Recommended: built-in Node.js APIs only

Use `node:crypto`, `node:stream`, `node:stream/promises`, `node:fs`, and `node:fs/promises`. They are
stable in the repository's Node 22 baseline, avoid native dependency changes, operate on arbitrarily
large files, and integrate with the existing `AbortSignal` and retry design.

Do not add a hashing package. A wrapper would duplicate a small built-in API and complicate the
performance/failure boundary without improving SHA-256 correctness.

### Existing `better-sqlite3`

Keep `better-sqlite3` as the database boundary. Its synchronous prepared statements are well suited
to the short metadata write that follows each completed asynchronous file operation. For multiple
completed files, prepare once and execute the inserts in one synchronous `db.transaction()` call.
Never place `await pipeline(...)`, ffmpeg conversion, file reads, or hashing inside that transaction.

### Not recommended for baseline implementation

- `crypto.hash()` or `readFile()` plus a one-shot digest: materializes the entire file in memory.
- A worker-thread hashing pool: adds transfer, lifecycle, and error complexity. Consider it only if
  profiling shows SHA-256, rather than storage, is the bottleneck and the `<5%` target cannot be met.
- SQLite hash extensions: unnecessary for hashing file streams and would introduce extension loading,
  binary compatibility, and deployment concerns.
- Web Crypto `subtle.digest()`: accepts a complete `ArrayBuffer`, so it is not a streaming media-file
  solution.

## Integration Patterns

### Direct copy: hash the bytes that flow to the destination

The copy primitive should return a result such as:

```typescript
interface HashedCopyResult {
  method: "copy" | "hardlink";
  contentHash: string;
  size: number;
  mtime: number;
}
```

For a plain copy:

1. Create a fresh SHA-256 `Hash` and a pass-through `Transform` that updates it.
2. Create source and destination streams.
3. Await `pipeline(source, hashTap, destination, { signal })`.
4. Restore timestamps if the existing copy contract requires it.
5. Call `hash.digest("hex")` exactly once.
6. Return the copy metadata and digest.
7. Persist the returned digest after the copy primitive has succeeded.

This digest represents the bytes accepted by the destination stream. Later verification should read
the destination and recompute SHA-256; that is the step that detects corruption after write time.

### Hardlinks and already-existing destinations

A hardlink has no byte-copy stream to tap. After a successful `link()`, hash the linked file with a
read stream before recording completion. Because both names refer to the same inode, source and
destination content are identical at that moment. If external writers can mutate the inode during
hashing, compare `stat` identity/size/mtime before and after the read and fail or retry when it changes.

Within one operation, a known hash may be reused for subsequent copies/hardlinks sourced from the
first completed copy only when immutability is guaranteed or file identity plus metadata is rechecked.
Otherwise, correctness requires hashing the actual copy source/destination. Resume and conflict-skip
paths must not invent a hash from size and mtime; either retain a previously stored digest or compute
the destination digest before backfilling the row.

### Converted files

The hash must identify final destination bytes, not the pre-conversion source. The current ffmpeg
integration writes directly to a named output file, so compute SHA-256 after ffmpeg exits successfully.
That costs a second destination read. Reworking ffmpeg to emit media on stdout through a hashing
pipeline could remove the reread, but it changes subprocess/output-container behavior and should be a
separate, benchmark-driven optimization.

### Database write and retrieval

Add a nullable hash column through the versioned migration and include it in prepared inventory writes
and typed reads. Prefer a true UPSERT over `INSERT OR REPLACE`: SQLite's `REPLACE` algorithm deletes
the conflicting row before inserting a new row, which can change row identity and trigger foreign-key
or trigger side effects. An UPSERT preserves the existing inventory row:

```sql
INSERT INTO inventory (
  operation_id, source_path, relative_path, mtime, size,
  rating, dest_path, content_hash, copied_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(operation_id, source_path, relative_path) DO UPDATE SET
  mtime = excluded.mtime,
  size = excluded.size,
  rating = excluded.rating,
  dest_path = excluded.dest_path,
  content_hash = excluded.content_hash,
  copied_at = excluded.copied_at;
```

Expose retrieval through the existing inventory queries or a focused prepared lookup. Legacy rows
return `null`. If deduplication will query `WHERE content_hash = ?`, add and validate a partial index:

```sql
CREATE INDEX IF NOT EXISTS idx_inventory_content_hash
  ON inventory(content_hash)
  WHERE content_hash IS NOT NULL;
```

The partial form avoids indexing migrated `NULL` rows. Do not make the hash unique: duplicate content
is expected and is the feature's downstream signal.

### Failure ordering and recovery

Use this state transition per file:

1. `copying`: destination may be partial and must be registered for cleanup.
2. `file_complete`: pipeline/conversion closed successfully and digest is final.
3. `tracked`: SQLite insert/update succeeded.

No cross-resource transaction can collapse steps 2 and 3. If step 1 fails or is aborted, remove the
partial output and do not write a digest. If step 3 fails, report a tracking failure and either remove
the newly created file or leave an explicit recoverable "file complete, database missing" state for
resume. Silent success is not acceptable because downstream content-addressed features would observe
an incomplete inventory.

For retries, recreate the read stream, write stream, transform, and `Hash` on each attempt. A digest
accumulator that has processed bytes from a failed attempt cannot be reset or safely reused.

### Performance validation

Measure the feature against the existing copy path, not an isolated hash microbenchmark. At minimum:

- direct copies of representative small tracks and large lossless files;
- hardlinks, which previously required no file data read;
- conversion output, where hashing adds a read after ffmpeg;
- worker counts used by album/filter copy modes;
- cold-cache and warm-cache runs;
- database enabled and disabled, with per-file writes versus synchronous batch transaction writes;
- 10K/25K/50K inventory rows to confirm lookup and insert plans.

Report median and tail duration plus throughput, CPU time, peak RSS, event-loop responsiveness, and
SQLite write time. The issue's `<5%` threshold should be evaluated separately for direct byte copies,
hardlinks, and conversions; averaging unlike methods can hide a serious regression. Do not tune
`highWaterMark`, raise copy concurrency, reuse a hash without proof, or add worker threads until the
measurements identify the limiting resource.

## Constraints and Gotchas

### A `Hash` stream is not a transparent transform

Node documents `Hash` as a transform, but its readable output is the digest. A pipeline of
`source -> createHash("sha256") -> destination` writes the digest to the destination, not the file.
Use a transparent transform that calls `hash.update(chunk)` and forwards `chunk`.

### Abort closes streams but does not define partial-file policy

Passing `{ signal }` to `pipeline()` is necessary so an abort destroys all streams promptly. It is
not sufficient for copy semantics: explicitly remove the partial destination and ensure no hash is
stored. Preserve `AbortError` classification rather than wrapping every failure as an undifferentiated
filesystem error.

### Hash computation is synchronous CPU work

`Hash.update()` is incremental but synchronous. Multiple concurrent copy streams interleave on the
same JavaScript thread; they do not automatically hash in parallel through libuv's worker pool. High
copy-worker counts can therefore reduce throughput or responsiveness on fast storage. Benchmark the
existing worker defaults before changing concurrency.

### Hardlinks change the performance profile

Creating a hardlink is metadata-only, but computing its first content hash requires reading the entire
file. A global `<5%` target may be impossible for a hardlink-only workload unless a previously computed
digest can be reused under a validated immutability contract. The issue must define whether correctness
or the performance target wins in this case.

### Conversion hashes must cover output bytes

Hashing the source during a conversion is incorrect for downstream deduplication, conversion caching,
and destination verification. Store the converted file's SHA-256. Two encoder versions or settings may
produce different bytes from the same source, which is precisely why the output hash matters.

### Files can change during hashing

Node streams do not snapshot ordinary files. If another process changes or truncates a file while it is
being read, the digest covers whatever byte sequence the stream observed. For direct copy, the tap still
hashes the bytes sent to the writer; for hardlink and verification reads, use before/after stat checks if
concurrent mutation is in scope.

### Filesystem and database success are not atomic

Do not open a `better-sqlite3` transaction, await a copy, then assume the transaction protects both.
The library explicitly disallows async transaction functions, and SQLite cannot roll back a filesystem
write. Model and test the gap between file completion and inventory persistence.

### WAL does not allow multiple writers

WAL lets readers proceed with a writer but SQLite still permits only one write transaction at a time.
Keep hash inserts short, retain a bounded busy timeout, and batch prepared inserts where it improves
measured throughput. A busy or full-disk error must fail tracking; it must not be logged and ignored.

### `synchronous=NORMAL` is a durability decision

In WAL mode it is consistent and survives application crashes, but the most recent transactions can be
lost after OS crash or power failure. If the project promises that every completed copy has a durable
hash record immediately after return, use or evaluate `FULL`; otherwise document that hashes are
rebuildable and make resume/backfill deterministic.

### Storage representation is a contract

Normalize to lowercase 64-character hex before insertion and validate on write/read. `NULL` means
"not computed". Do not use an empty string as a sentinel, and do not add a unique constraint. If future
algorithm agility is likely, either add `content_hash_algorithm` now or define the stored value as
`sha256:<hex>`; changing representation later affects every query and downstream cache key.

### Integrity is not authenticity

SHA-256 is suitable for byte identity, accidental-corruption detection, and advisory deduplication.
A hash stored in the same mutable database is not proof against an attacker who can alter both the file
and database. Authentication would require a trusted signature or keyed MAC and is outside issue #111.

### Scope must cover the real copy graph

In this repository, `copy-album.ts` and `copy-filter.ts` include direct copies, range-copy optimization,
hardlinks, conversion, conflict skips, resume paths, and parallel copies. Other commands also call
`copyOrLink()` for sync, Plex copy/playlists, and verify repair. If "every rfmedia-cli copy operation"
means every filesystem copy in the package, centralizing the hashed primitive is necessary but not
sufficient: each caller also needs a database ownership/operation ID and defined inventory semantics.
If issue #111 means only the `rfmedia copy` command, that narrower boundary should be stated and tested.

## Short Code Examples

### One-pass copy and SHA-256

```typescript
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function copyWithSha256(source: string, destination: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(createReadStream(source), tap, createWriteStream(destination), { signal });

  return hash.digest("hex");
}
```

Production code must wrap this with parent-directory creation, timestamp preservation, retry using
fresh streams/hash state, and partial-destination cleanup.

### Streaming hash for hardlinks, conversions, and verification

```typescript
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
```

The repository can instead use `pipeline(input, hash)` when it only needs a digest and no copied byte
stream, but must still call `digest()` once and handle abort/cleanup consistently.

### Prepared storage and focused retrieval

```typescript
const setHash = db.prepare(`
  UPDATE inventory
  SET content_hash = ?
  WHERE operation_id = ? AND source_path = ? AND relative_path = ?
`);

const getHash = db.prepare(`
  SELECT content_hash
  FROM inventory
  WHERE operation_id = ? AND source_path = ? AND relative_path = ?
`);

setHash.run(contentHash, operationId, sourcePath, relativePath);
const row = getHash.get(operationId, sourcePath, relativePath) as { content_hash: string | null } | undefined;
```

For batch copy completion, call the already-prepared write statement repeatedly inside one synchronous
`db.transaction()` wrapper after all relevant async copy/hash work has completed.

## Open Questions

1. Does "every copy operation" mean only album/filter execution behind `rfmedia copy`, or also sync,
   Plex copy/playlists, verify `--fix`, conflict resolver copies, and any future caller of
   `copyOrLink()`?
2. Must hashes exist when SQLite tracking/inventory is disabled, and if so where are they returned or
   persisted?
3. For a database write failure after a successful file copy, should the new destination be removed,
   retained as an explicitly resumable untracked file, or recorded through a separate pending journal?
4. Is the `<5%` target required for hardlink-only workloads? Hashing a previously unseen hardlink turns
   a metadata-only operation into a full-file read.
5. May a digest be reused across subsequent range copies/hardlinks when file identity, size, and mtime
   match, or must every destination be read independently?
6. Should conversion output be reread after ffmpeg, or is refactoring ffmpeg stdout into a hashing
   pipeline in scope?
7. Is the storage format fixed lowercase SHA-256 hex, or should the schema include an algorithm column
   or `sha256:` prefix for future migration?
8. Should the schema add a partial `content_hash` index now for dedup lookup, or wait until the first
   downstream hash-query feature to avoid unnecessary write amplification?
9. Does "verified at read time" apply to explicit verify commands only, or must every inventory read
   recompute the destination hash? The latter would turn metadata reads into full library scans.
10. What is the required durability after OS crash or power loss: rebuildable hashes under WAL plus
    `synchronous=NORMAL`, or fully durable hash commits under `synchronous=FULL`?
11. Should hash verification detect and reject files that change during the read using before/after
    stat checks?
12. What benchmark corpus, storage types, worker counts, and pass/fail calculation define the `<5%`
    acceptance gate?
