# Practices Research: Content Hashing During Copy Operations

## Executive Summary

Complete issue #111 by extending PR #233's existing hash, copy, inventory, SQLite, and benchmark
seams rather than introducing a new copy service or dependency. Keep the core patch focused on direct
album/filter copy and sync, preserve queue/MCP delegation, and treat watch/Plex provenance as explicit
follow-up work unless the issue scope is broadened.

## Existing Reusable Code

The smallest completion path should extend the implementation already shipped in PR #233 rather
than introduce a second hashing or copy subsystem.

| Existing code                                                                                                                | Reuse recommendation                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/integrity.ts:calculateHash()`                                                                  | Keep this as the single public SHA-256 file-hash function. It already uses `node:crypto`, `createReadStream()`, and `stream/promises.pipeline()` and returns lowercase hex.                        |
| `packages/rfmedia-cli/src/lib/filesystem.ts:copyOrLinkWithHash()`                                                            | Reuse for byte-identical copies and hardlinks. It streams ordinary copies through a hash transform and returns `method`, `contentHash`, source `mtime`, and source `size`, avoiding a second read. |
| `packages/rfmedia-cli/src/lib/filesystem.ts:copyOrLink()`                                                                    | Retain for workflows where hashing is deliberately outside the helper, such as conversion followed by `calculateHash(finalDestPath)`. Do not add database behavior here.                           |
| `packages/rfmedia-cli/src/lib/inventory.ts:createFileInventoryEntry()`                                                       | Reuse to obtain normalized relative source identity and source snapshot metadata. Keep destination hashing as an explicit input so inventory code does not perform hidden filesystem I/O.          |
| `packages/rfmedia-cli/src/lib/db.ts:recordInventoryFile()` and `recordInventoryFiles()`                                      | Reuse the prepared-statement and transaction patterns for durable writes. Any new artifact write helper should mirror these functions rather than add an ORM or repository class.                  |
| `packages/rfmedia-cli/src/actions/copy-album.ts:createInventoryRecord()` and `recordAlbumInventory()`                        | Preserve the action-local batching seam. It is suited to album-directory copies, where all file records are collected before one SQLite transaction.                                               |
| `packages/rfmedia-cli/src/actions/copy-filter.ts:recordCopiedFileInventory()`                                                | Preserve the action-local finalization seam, but make its ordering and database key semantics match album copy. It is the natural place for filter-copy post-conversion hashing.                   |
| `packages/rfmedia-cli/src/lib/schema.sql` and `src/lib/migrations.ts:runMigrations()`                                        | Continue the existing schema-file plus sequential-version migration pattern. Do not add a migration framework for one schema change.                                                               |
| `packages/rfmedia-cli/src/actions/copy-album.test.ts`, `copy-filter.test.ts`, `lib/db.test.ts`, and `lib/filesystem.test.ts` | Extend the existing Vitest styles: action-level injected/mocked dependencies, real temporary SQLite databases for schema behavior, and real temporary files for digest correctness.                |
| `packages/rfmedia-cli/benchmarks/copy.bench.ts`                                                                              | Keep the paired tracked-copy baseline and hash-enabled cases. They already compare identical SQLite inventory work via the internal `benchmarkDisableContentHashing` escape hatch.                 |

One small cleanup is justified: `filesystem.ts` has a private `hashFile()` that duplicates
`integrity.ts:calculateHash()`. Importing and reusing `calculateHash()` for the hardlink branch would
leave one algorithm implementation while preserving `copyOrLinkWithHash()`'s streaming fast path for
ordinary copies.

## Modularity

Maintain the current layer boundaries:

1. `lib/filesystem.ts` owns filesystem materialization, retry, cancellation, timestamp preservation,
   and the hash produced during an identical-byte copy stream.
2. `lib/integrity.ts` owns hashing an already-materialized file and comparing two files.
3. `lib/inventory.ts` owns translating source/destination metadata into inventory types.
4. `lib/db.ts` owns synchronous prepared SQL and transactions.
5. `actions/copy-album.ts`, `copy-filter.ts`, and `sync.ts` own orchestration and decide when a
   destination is final enough to hash and record.

Do not make `copyOrLinkWithHash()` open SQLite, and do not make `recordInventoryFile()` read the
filesystem. Both would hide expensive/failing work behind the wrong interface and make unit tests
harder. Actions should pass an already-known hash when the copy helper produced one, or call
`calculateHash(finalDestPath)` after conversion or other byte mutation.

The current database model needs an explicit decision before implementation. `schema.sql` declares
`UNIQUE(operation_id, source_path, relative_path)`, while album ranges and filter ranges can create
many destination files from one relative source path. `recordInventoryFile()` uses `INSERT OR
REPLACE`, so later destinations can replace earlier ones. At the same time,
`inventory.ts:loadInventoryFromDb()` reduces rows to `Map<relativePath, FileInventoryEntry>`, showing
that `inventory` also models one source snapshot for incremental sync.

If issue #111 continues to require every destination artifact, the cleanest separation is a small
destination-artifact table keyed by `(operation_id, dest_path)` with source identity, final path,
SHA-256, and commit timestamp. Keep the existing inventory table as sync source state. This is more
maintainable than forcing one-to-many destinations into `FileInventoryEntry.files`, and safer than a
table rebuild that silently changes sync semantics. Mirror `recordInventoryFile(s)` with a batched
`recordCopyArtifact(s)` helper and migrate existing non-null version-9 hashes into one artifact row
per existing inventory row.

If the accepted scope is only one canonical hash per source inventory item, no schema change is
needed, but that narrower contract must replace the issue's “every copy operation” wording. The code
should not pretend the current unique key preserves ranged destinations.

## KISS

Recommended core completion scope:

- direct album copy in `copy-album.ts`, including conversion, hardlink, conflict rename/overwrite,
  and every suffix;
- direct filter copy in `copy-filter.ts`, including flat/structured/album modes and every suffix;
- incremental copy writes in `sync.ts`, removing the current `suffixNum === suffixes[0]` recording
  limitation;
- queue and MCP coverage through their existing delegation to
  `executeAlbumCopyWithFileInput()`, `executeFilterCopyWithFileInput()`, and
  `executeSyncWithFileInput()`.

Broad Plex and watch integration is over-scope for the smallest issue #111 completion:

- `actions/watch.ts:processChange()` calls low-level `executeAlbumCopy()` and
  `executeFilterCopy()` without a tracking operation. Giving a long-running watch session correct
  operation ownership, database lifecycle, resume semantics, and failure status is a separate design
  problem, not a hash-helper change.
- `actions/plex-copy.ts:executePlexCopy()` explicitly states that its database is for Plex query
  history and creates no copy-tracking operation. `actions/plex-playlist.ts:executePlaylistExport()`
  has separate copy/convert/hardlink loops and optional rating mutation. Adding provenance and final
  hash persistence there crosses a different schema and command boundary.

Record those omissions as follow-up issues or explicitly extend #111 before implementing them. Do not
silently claim they are covered. The same applies to repair copies in `verify-album.ts` /
`verify-filter.ts` and the separate `link-videos.ts` command.

Other KISS constraints:

- fixed SHA-256 only; no pluggable algorithms, Merkle tree, worker pool, or `HashingService` class;
- no eager scan/backfill of legacy null hashes during migration;
- no dedupe, tiered-verification, or health-analytics command behavior;
- no broad consolidation of the duplicated Plex/filter/album copy loops in this change;
- no new CLI flag or output field unless the issue explicitly adds user-selectable hash policy.

Because hashing should be an internal invariant, shell completion templates are a no-op. Bash, zsh,
and fish snapshots only need updating when command names or options change; this work should change
neither.

## Abstraction vs Repetition

Prefer two small primitives over a generic copy service:

```typescript
copyOrLinkWithHash(source, dest, hardlink, signal);
calculateHash(finalDestPath);
```

The first is optimized for byte-identical materialization. The second handles conversion and any
post-copy mutation where hashing must occur after the final bytes exist. A shared `copyOrConvertWithHash`
would pull `convert.ts` into the filesystem layer, duplicate action-specific history/hook behavior,
and make the API encode too many policies.

Database repetition should be consolidated only at the write boundary. A small typed artifact input
and `recordCopyArtifact()` / `recordCopyArtifacts()` pair in `db.ts` is enough. Album copy can batch;
filter and sync can write one final destination at a time. Do not create service classes or dependency
containers around synchronous `better-sqlite3` calls.

Keep source metadata collection in `createFileInventoryEntry()`. Do not reuse source `size` or `mtime`
as destination metadata after conversion. If a destination-artifact table needs size, read it at the
same finalization point as the digest and name it explicitly (`destSize`) rather than changing the
meaning of existing inventory fields.

Post-copy ordering should be made consistent with minimal edits. Verification and any byte-mutating
finalization must complete before the artifact hash is persisted. Observational `afterCopy` hooks may
run after commit; if plugins are allowed to mutate destination bytes, the plugin contract must say so
and hashing must follow those hooks. Avoid a new lifecycle abstraction until that policy is decided.

## Interfaces

Retain the existing `copyOrLinkWithHash()` result shape, or name it locally for readability:

```typescript
interface HashedCopyResult {
  method: "copy" | "hardlink";
  contentHash: string;
  mtime: number;
  size: number;
}
```

For persistent destination artifacts, use a narrow database DTO rather than exposing action options:

```typescript
interface CopyArtifactRecord {
  sourcePath: string;
  relativePath: string;
  destPath: string;
  contentHash: string;
  copiedAt?: number;
}
```

`contentHash` should be required on new artifact writes. Nullable hashes belong only to migrated
legacy inventory rows; allowing `undefined` in the new write interface would recreate the current
“successful but unhashed” state.

Queries needed to prove the foundation should also remain narrow:

- get artifacts for an operation;
- get the artifact for an operation and destination;
- get artifacts by exact content hash.

These are data-access boundaries for tests and downstream consumers, not dedupe or verification
features. Keep SQL parameters prepared and return existing snake_case database row types, following
`getInventory()` in `db.ts`.

Use a unique key on `(operation_id, dest_path)`. Add a normal index on `content_hash` only if #111 is
expected to provide a usable lookup foundation for #38/#116/#120; those consumers query by digest,
and the index avoids a later full-table-scan surprise. Do not add both redundant single-column and
composite indexes without checking the actual query plan, following the index-pruning comments in
`schema.sql` and the existing `scripts/explain-query-plans.mjs` practice.

## Testability

Use the established test seams rather than large end-to-end fixtures:

- Extend `lib/filesystem.test.ts` with real files for copy, hardlink, cancellation/error cleanup, and
  digest equality. Reuse `calculateHash()` rather than mocking Node crypto.
- Extend `lib/db.test.ts` with a real temporary database for the next migration, preservation of
  version-9 rows, destination uniqueness, sibling-range retention, exact-hash lookup, and transaction
  rollback. Add an `EXPLAIN QUERY PLAN` assertion or repository script check if a hash index is added.
- Extend `actions/copy-album.test.ts` from its existing single-suffix hash assertion to at least two
  suffixes and assert two destination records survive.
- Extend `actions/copy-filter.test.ts` with range, conversion, skip/adoption, hash failure, and dry-run
  cases around `recordCopiedFileInventory()`.
- Add focused sync action coverage around `syncFile()` proving every suffix is recorded; the current
  `suffixNum === suffixes[0]` branch should have a regression test before it changes.
- Test queue and MCP only as delegation/contract checks. Their actions already route to the same
  top-level entrypoints, so duplicating filesystem matrices there adds cost without coverage value.
- If watch/Plex remain follow-ups, add no speculative implementation tests; document the exclusion in
  the issue/plan.

Benchmark practice should remain paired and end-to-end. In `benchmarks/copy.bench.ts`, compare “SQLite
inventory baseline (hash disabled)” against “content hashing + SQLite inventory” with the same source,
destination shape, worker count, force behavior, and fresh operation per iteration. Keep the internal
benchmark-only escape hatch out of CLI/types. Report repeated medians across existing scales; do not
declare `<5%` from one noisy run or from the unrelated no-tracking copy case.

## Build vs Depend

Build on existing platform dependencies:

- Node's built-in `crypto.createHash("sha256")` for hashing;
- Node streams and `pipeline()` for bounded-memory reads/copies;
- existing `better-sqlite3` prepared statements and transactions;
- existing Vitest tests/benchmarks and temporary filesystem helpers.

Do not add a hashing package, native checksum binary, ORM, migration package, content-addressable
storage library, or benchmark framework. The repository already has every primitive needed, and an
external dependency would add installation, platform, security, and maintenance cost without solving
the remaining data-model and workflow-ordering gaps.

## Open Questions

1. Is the accepted contract every destination artifact or one canonical inventory hash per source?
   This decides whether a destination-artifact table is required. Recommendation: preserve the issue's
   every-destination wording and separate artifacts from sync source state.
2. Are watch and Plex copy/export required before closing #111? Recommendation: no for the smallest
   maintainable patch; create explicit follow-ups because their operation/provenance lifecycles differ.
3. Should disabling completed-source tracking disable artifact persistence? Recommendation: no, but
   separating those concerns may require a top-level database context change and should be scoped
   explicitly.
4. May `afterCopy` plugins mutate destination bytes? The answer determines whether persistence occurs
   before or after the hook and must be uniform in album and filter actions.
5. Should existing version-9 `inventory.content_hash` remain authoritative, be dual-written, or become
   migration-only compatibility data if an artifact table is added? Recommendation: migrate non-null
   values, make the artifact table authoritative, and avoid indefinite dual-write logic.
6. Is a `content_hash` index part of the foundation or deferred until the first consumer? Recommendation:
   include it if exact-hash lookup is an acceptance criterion, and verify its write overhead/query plan.
7. How should a completed filesystem write followed by SQLite failure recover? Recommendation: report
   failure and use existing history/cleanup ownership to remove only files known to be newly created;
   do not introduce broad rollback machinery in #111.
8. Is the `<5%` goal an informational benchmark or a hard CI gate? Recommendation: require reproducible
   median evidence now and defer a hard gate until variance is characterized on CI runners.
