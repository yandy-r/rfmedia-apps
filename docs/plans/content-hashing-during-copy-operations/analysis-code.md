# Code Analysis: Content Hashing During Copy Operations

## Executive Summary

PR #233 already implements the schema-version-9 hashing vertical slice. The closeout should harden
that code, not create a new hashing service, schema, CLI flag, or artifact ledger. The verified
runtime path is:

```text
CLI / queue / MCP
  -> album copy | filter copy | sync action
  -> copy, hardlink, or conversion
  -> lowercase SHA-256 of final artifact bytes
  -> inventory mapping
  -> prepared SQLite write
  -> completion tracking
```

Three concrete gaps remain in current source:

1. `lib/db.ts:initializeDatabase()` executes pragmas and `schema.sql` before
   `migrations.ts:runMigrations()` rejects a schema newer than version 9.
2. `lib/filesystem.ts:copyOrLinkWithHash()` checks an `AbortSignal` before work but does not pass it
   to `pipeline()` and does not remove a newly created partial destination after terminal failure.
3. `lib/db.ts:recordInventoryFile()` and `recordInventoryFiles()` accept arbitrary non-null digest
   strings.

Album/filter/sync already hash final artifacts and generally persist inventory before completion.
The implementation should preserve those paths and add proof-oriented failure tests around them.

## Existing Code Structure

- `packages/rfmedia-cli/src/lib/filesystem.ts`
  - `copyOrLinkWithHash()` is the optimized regular-copy boundary. It creates a fresh SHA-256 and
    transparent `Transform` inside each retry callback, streams unchanged chunks into the writer,
    restores timestamps, and returns `{ method, contentHash, mtime, size }`.
  - Its hardlink branch links first and then hashes the bytes with private `hashFile()`.
  - `withRetry()` owns the bounded transient-error policy. `cleanupPartialFile()` is the existing
    best-effort cleanup primitive, but it removes any existing target and therefore cannot be called
    blindly without first establishing helper ownership.
- `packages/rfmedia-cli/src/lib/integrity.ts`
  - `calculateHash()` streams an existing file into Node SHA-256. Album conversions, filter copies,
    and sync use it after destination finalization.
  - `verifyFileIntegrity()` is a separate source/destination read-back comparison used by
    `--verify`; do not merge its semantics with persisted fingerprints.
- `packages/rfmedia-cli/src/lib/db.ts`
  - `initializeDatabase()` opens SQLite, applies WAL/concurrency pragmas, executes `schema.sql`, then
    calls `runMigrations()`.
  - `recordInventoryFile()` is the single-row prepared write.
  - `recordInventoryFiles()` reuses one prepared statement inside a synchronous
    `better-sqlite3` transaction.
- `packages/rfmedia-cli/src/lib/migrations.ts` and `src/lib/schema.sql`
  - `CURRENT_SCHEMA_VERSION` is 9.
  - New databases receive nullable `inventory.content_hash TEXT` from `schema.sql`.
  - Version-8 databases use `PRAGMA table_info(inventory)`, guarded `ALTER TABLE`, and only then
    update metadata to version 9.
- `packages/rfmedia-cli/src/lib/inventory.ts` and `src/types/{inventory,db}.ts`
  - Application data uses optional/nullable `contentHash`; SQLite rows use nullable
    `content_hash`.
  - `loadInventoryFromDb()` omits `contentHash` when the database value is `NULL`.
  - `appendFileRecordToDb()` maps portable entries back through `recordInventoryFile()`.
- `packages/rfmedia-cli/src/actions/copy-album.ts`
  - Regular tracked copies use `copyOrLinkWithHash()`; conversions call `calculateHash()` on the
    converted destination.
  - `recordAlbumInventory()` batch-writes collected rows before `recordCompletedAlbumCopy()`.
  - The private `benchmarkDisableContentHashing` seam is used only by benchmarks.
- `packages/rfmedia-cli/src/actions/copy-filter.ts`
  - All tracked branches converge on `recordCopiedFileInventory()`, which hashes the accepted final
    destination, builds metadata, and calls `recordInventoryFile()`.
  - Existing-destination `skip` branches intentionally hash the accepted destination before
    recording it.
- `packages/rfmedia-cli/src/actions/sync.ts`
  - `syncFile()` materializes the destination, hashes `destPath`, then calls
    `appendFileRecord()`. Its existing model records only the first suffix for a source item; do not
    broaden that identity in this issue.
- `packages/rfmedia-cli/src/actions/queue.ts` and `src/mcp/adapters.ts`
  - Queue jobs and MCP tools delegate to the same `*WithFileInput()` actions. They need delegation
    regression assertions, not duplicate hashing implementations.

## Implementation Patterns with Examples

Keep a fresh hash and streams inside each retry attempt:

```typescript
const contentHash = await withRetry(async () => {
  const hash = createHash("sha256");
  const hashTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(createReadStream(source), hashTransform, createWriteStream(dest), { signal });
  return hash.digest("hex");
});
```

Do not hoist `hash`, streams, or the transform outside the retry callback; a failed attempt must not
contaminate the next digest. Capture whether `dest` existed before the helper starts, and on terminal
failure remove it only when it was absent initially and this invocation may have created it.
Preserve abort identity rather than translating it into an undifferentiated filesystem error.

Use one private database validator from both write APIs:

```typescript
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function validateContentHash(contentHash: string | null | undefined): void {
  if (contentHash != null && !SHA256_HEX_PATTERN.test(contentHash)) {
    throw new Error("contentHash must be a lowercase 64-character SHA-256 digest");
  }
}
```

For `recordInventoryFile()`, validate before `stmt.run()`. For `recordInventoryFiles()`, validate
each entry inside the existing transaction immediately before its `stmt.run()` so one malformed
entry rolls back earlier rows in that batch. Continue binding all values positionally.

For schema compatibility, add a read-only preflight before opening/configuring the writable
connection or, at minimum, before any pragma or `db.exec(schema)`. Inspect `sqlite_master` for the
`metadata` table, read exactly one `schema_version`, parse it strictly, and:

- allow a genuinely new/empty database to initialize;
- reject an existing structured database with missing or malformed version metadata;
- reject a version greater than `CURRENT_SCHEMA_VERSION` and close the connection;
- leave the existing v8-to-v9 migration unchanged.

Do not use `getCurrentSchemaVersion()`'s current `parseInt()` behavior for strict preflight because
values such as `9junk` or missing metadata can be misclassified.

## Integration Points

1. `lib/db.ts` may import `CURRENT_SCHEMA_VERSION` from `lib/migrations.ts`, but note the existing
   reverse import (`migrations.ts` imports `getCurrentSchemaVersion()` from `db.ts`). Prefer moving a
   small version constant/preflight helper to a dependency-neutral module or passing the supported
   version into a local helper; avoid creating a fragile runtime cycle.
2. `lib/filesystem.ts:copyOrLinkWithHash()` receives the action signal already. Pass it to the
   regular-copy pipeline. For hardlink/final-file reads, either extend
   `integrity.ts:calculateHash(filePath, signal?)` and reuse it or make the private helper
   signal-aware. Hash the linked destination path to make final-artifact intent explicit.
3. Thread the optional signal through conversion hashing in `copy-album.ts`, through
   `copy-filter.ts:recordCopiedFileInventory()`, and through `sync.ts:syncFile()` if
   `calculateHash()` becomes signal-aware. Keep hashing within the existing worker limit.
4. `copy-album.ts:executeAlbumCopyWithFileInput()` creates a local abort controller and
   `inProgressFiles`, but its call to `executeAlbumCopy()` currently omits both arguments. Pass
   `localAbortController.signal` and `inProgressFiles`, matching the existing filter wrapper.
5. Do not change `commands/copy.ts`, MCP schemas, result types, routine logs, or shell completion
   templates. Queue/MCP should continue inheriting behavior by delegation.
6. Do not extend Plex query copy, playlist export/sync, repair/conflict writes, video linking, or
   untracked watch execution. They do not own the general inventory operation required by this
   contract.

## Code Conventions

- The package is strict TypeScript with NodeNext ESM. Relative imports require `.js` suffixes;
  preserve `import type` under `verbatimModuleSyntax`.
- Use camelCase in application DTOs (`contentHash`) and snake_case only for SQLite row types and
  columns (`content_hash`).
- Keep filesystem and hash I/O asynchronous, but keep `better-sqlite3` transactions synchronous.
  Never open a stream or `await` inside `db.transaction()`.
- Prefer small functions and explicit parameters over classes or a dependency container.
- Preserve JSDoc on exported helpers, including abort/failure behavior where signatures change.
- Preserve the existing retry allowlist and error/logging style. Do not log full stored hashes in
  routine output.
- Keep `content_hash` nullable for legacy reads. Non-null validation applies to producer input; it
  must not invent a digest for migrated or omitted rows.
- Use repository formatting and Markdown conventions; do not make unrelated cleanup edits.

## Dependencies and Services

- Runtime: Node.js 22+ built-ins `node:crypto`, `node:fs`, `node:fs/promises`, `node:stream`, and
  `node:stream/promises`.
- Database: existing pinned `better-sqlite3` synchronous prepared statements and transactions.
- Filesystem helper: existing `fs-extra`; no new copy or hashing dependency is needed.
- Conversion: existing FFmpeg path in `lib/convert.ts`; hash only after conversion succeeds and the
  output stream/process is closed.
- Tests and benchmarks: Vitest 4, real temporary files/SQLite databases, and
  `benchmarks/copy.bench.ts`. The build copies `src/lib/schema.sql` into `dist/lib/schema.sql`, so
  schema edits would require build validation even though none are expected here.
- No network API, MCP schema, daemon, worker pool, SQLite extension, external checksum executable,
  or new configuration is required.

## Gotchas and Warnings

- `schema.sql` contains idempotent DDL and migration SQL; it is still mutation. Reject future
  versions before executing any of it, and preferably before WAL mode can create sidecar files.
- `getCurrentSchemaVersion()` currently maps missing metadata to `0` and uses permissive
  `parseInt()`. That is suitable for historical migration flow but insufficient to distinguish an
  empty database from malformed existing state.
- `cleanupPartialFile()` removes the supplied path recursively through `fs-extra`. Never call it on
  a destination that existed before the helper invocation.
- The current catch in `copyOrLinkWithHash()` wraps errors with `new Error(...)`, losing `code` and
  abort classification. Preserve the cause/code where practical so callers and tests can recognize
  cancellation.
- A streamed digest fingerprints bytes submitted to the writer; it is not destination read-back
  verification. Keep `--verify` separate.
- Hardlinks share an inode. Their stored value is a snapshot and can become stale after mutation
  through either path.
- `inventory` is unique on `(operation_id, source_path, relative_path)` and portable inventory is a
  `Map` keyed by relative path. Do not add one-to-many ranged artifact persistence, a hash index, or
  an artifact table in this closeout.
- Album/filter hooks run around writes. Do not redesign hook mutation semantics here; tests should
  assert the current persisted-finalization ordering without introducing a new lifecycle.
- The benchmark-only hash-disable property must remain absent from `CopyOptions`, CLI/config/MCP
  surfaces, and completions.

## Task-Specific Guidance

1. Add future-schema preflight in `lib/db.ts` (and a small neutral helper module only if needed to
   avoid the `db.ts`/`migrations.ts` import cycle). Extend `lib/db.test.ts` with new-v9, v8 migration,
   v9 reopen, malformed metadata, and future-version immutability cases. Snapshot `sqlite_schema`
   and metadata before/after rejection.
2. Add shared digest validation in `lib/db.ts`. Test `NULL`/omitted compatibility, valid single and
   batch writes, uppercase/wrong-length/non-hex rejection, and a mixed batch whose earlier valid row
   is rolled back.
3. Harden `lib/filesystem.ts:copyOrLinkWithHash()` with signal-aware pipeline execution,
   retry-local state, ownership-bounded cleanup, and preserved abort/error identity. Extend
   `lib/filesystem.test.ts` with real-file regular and hardlink digests plus deterministic injected
   failure/cancellation seams; avoid timer-only large-file tests.
4. If `calculateHash()` accepts a signal, extend `lib/integrity.test.ts` for known lowercase digest,
   read error, and abort propagation. Reuse it for final conversion/hardlink reads rather than
   creating another public hashing module.
5. Audit action ordering without broad refactoring:
   - album: file/convert -> hash -> `recordInventoryFiles()` -> `recordCompletedAlbumCopy()` ->
     source completion;
   - filter: final destination -> `recordCopiedFileInventory()` -> granular/source completion;
   - sync: final destination -> `calculateHash()` -> `appendFileRecord()` -> success result.
     Add focused hash/DB failure tests proving no completion marker follows failure. Add missing sync
     action coverage in a new colocated `actions/sync.test.ts` only if no narrower existing seam is
     available.
6. Keep queue tests in `actions/queue.test.ts` and MCP tests in `mcp/adapters.spec.ts` limited to
   delegation. Run `lib/shell-completions/templates.spec.ts` without editing templates.
7. Preserve the paired cases in `benchmarks/copy.bench.ts`: tracked SQLite baseline with the
   internal hash-disable seam versus tracked SQLite hashing. Use identical fixtures/options, repeat
   measurements, and report median/spread/throughput/memory. Do not add a CI wall-clock assertion.
8. Validate focused tests first, then package `typecheck`, `test:run`, `build`, completion tests,
   repository-native formatting/lint gates, and `git diff --check`.
