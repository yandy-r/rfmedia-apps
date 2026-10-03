# Plan: Content Hashing During Copy Operations

## Summary

Compute SHA-256 content hashes for successful rfmedia copy operations and persist them in SQLite alongside copied-file metadata. This adds content-addressable infrastructure for future duplicate detection, conversion caching, integrity verification, and incremental sync without changing the normal CLI output contract.

## User Story

As an `rfmedia` user managing copied music libraries, I want every successful copy operation to record a SHA-256 content hash in the tracking database so copied files can be identified and verified by content, not only by path, timestamp, or size.

## Problem -> Solution

Current copy operations copy, hardlink, or convert files and can optionally verify SHA-256 equality, but they do not persist content hashes in the SQLite schema or database types. -> Successful non-dry-run copy paths compute a lowercase SHA-256 hash for the final destination bytes and persist it with copied-file metadata through the existing SQLite tracking layer.

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A
- **PRD Phase**: standalone
- **Estimated Files**: 15

## Batches

Tasks grouped by dependency for parallel execution. Tasks within the same batch run concurrently; batches run in order.

| Batch | Tasks              | Depends On | Parallel Width |
| ----- | ------------------ | ---------- | -------------- |
| B1    | 1.1, 1.2, 1.3      | -          | 3              |
| B2    | 2.1, 2.2           | B1         | 2              |
| B3    | 3.1, 3.2, 3.3      | B2         | 3              |
| B4    | 4.1, 4.2, 4.3, 4.4 | B3         | 4              |
| B5    | 5.1, 5.2           | B4         | 2              |

- **Total tasks**: 14
- **Total batches**: 5
- **Max parallel width**: 4

---

## UX Design

### Before

No visible hash persistence. Users can opt into SHA-256 source/destination comparison with `--verify`, while normal copy output reports counts, failures, elapsed time, and tracking summaries.

### After

Internal change only. Normal text and JSON output remain unchanged; SQLite rows gain stored content hashes for successful copied files.

### Interaction Changes

| Touchpoint                 | Before                                                                   | After                                     | Notes                                |
| -------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------ |
| `rfmedia copy` text output | Shows copy counts and summary timing                                     | Same output                               | Do not add routine hash display      |
| `rfmedia copy --json`      | Emits command, mode, source, destination, result counts/failures         | Same JSON shape                           | Avoid API/output compatibility break |
| SQLite tracking DB         | Stores path, mtime, size, rating metadata, destination, copied timestamp | Also stores SHA-256 for destination bytes | Implementation-visible only          |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                              | Lines                         | Why                                                                  |
| -------------- | ------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/integrity.ts`       | 1-45                          | Existing SHA-256 streaming helper and verification behavior          |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/db.ts`              | 86-120, 576-625               | SQLite initialization and inventory write/read pattern               |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/schema.sql`         | 57-83, 322-358                | Inventory table and schema version metadata                          |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/migrations.ts`      | 11-80                         | Current schema version and migration style                           |
| P0 (critical)  | `packages/rfmedia-cli/src/actions/copy-album.ts`  | 160-451, 1340-1640            | Album copy, conversion, verification, and tracking DB integration    |
| P0 (critical)  | `packages/rfmedia-cli/src/actions/copy-filter.ts` | 436-459, 1913-1943, 3050-3060 | Filter copy helper, inline range copy paths, and tracking completion |
| P1 (important) | `packages/rfmedia-cli/src/actions/sync.ts`        | 181-325                       | Existing inventory write after copy path                             |
| P1 (important) | `packages/rfmedia-cli/src/lib/inventory.ts`       | 220-248, 444-461              | Inventory adapter into database writes                               |
| P1 (important) | `packages/rfmedia-cli/src/types/db.ts`            | 72-101                        | DB row and parameter type conventions                                |
| P1 (important) | `packages/rfmedia-cli/src/lib/filesystem.ts`      | 224-288                       | Shared copy/hardlink behavior and error wrapping                     |
| P1 (important) | `packages/rfmedia-cli/src/actions/plex-copy.ts`   | 254-256, 593-608              | Additional copy action using direct copy/convert loops               |
| P2 (reference) | `packages/rfmedia-cli/src/lib/db.test.ts`         | 23-115                        | DB schema and migration test style                                   |
| P2 (reference) | `packages/rfmedia-cli/src/lib/integrity.test.ts`  | 1-62                          | Existing hash helper test style                                      |
| P2 (reference) | `packages/rfmedia-cli/benchmarks/copy.bench.ts`   | 36-60                         | Existing copy performance benchmark                                  |

## External Documentation

| Topic                              | Source                                                               | Key Takeaway                                                                    |
| ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Node.js `crypto.createHash`        | <https://nodejs.org/api/crypto.html>                                 | Use built-in SHA-256 streams; no hashing dependency needed                      |
| Node.js `stream/promises.pipeline` | <https://nodejs.org/api/stream.html>                                 | Existing helper already uses promise pipeline for stream hashing                |
| SQLite `ALTER TABLE ADD COLUMN`    | <https://www.sqlite.org/lang_altertable.html>                        | Nullable appended columns migrate existing databases without rewriting all rows |
| better-sqlite3 prepared statements | <https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md> | Keep writes in prepared statements; do not introduce ORM or migration framework |

---

## Patterns to Mirror

Code patterns discovered in the codebase. Follow these exactly.

### NAMING_CONVENTION

```
// SOURCE: packages/rfmedia-cli/src/types/db.ts:74-88
export interface DbInventoryEntry {
  id: number;
  operation_id: number;
  source_path: string;
  relative_path: string;
```

Use PascalCase for TypeScript interfaces, camelCase for input parameters, and snake_case for SQLite row fields. New files, if any, should use kebab-case, matching `copy-album.ts`, `copy-filter.ts`, and colocated `.test.ts` files.

### ERROR_HANDLING

```
// SOURCE: packages/rfmedia-cli/src/lib/filesystem.ts:284-287
} catch (err) {
  const error = err as FileOperationError;
  throw new Error(createActionableMessage(error, `copy ${source} to ${dest}`));
}
```

Hashing failures should propagate as operation failures after successful file creation, using existing failed-source tracking. Do not swallow hash errors and then mark the source completed.

### LOGGING_PATTERN

```
// SOURCE: packages/rfmedia-cli/src/lib/db.ts:163-165
const operationId = Number(result.lastInsertRowid);
logDebug(`Created operation ${operationId}: ${params.command} (${params.optionsHash})`);
return operationId;
```

Use concise debug logs for structural events only. Do not routinely log full SHA-256 values; existing verification debug logs in `integrity.ts` are mismatch-oriented and should not be copied into normal persistence.

### REPOSITORY_PATTERN

```
// SOURCE: packages/rfmedia-cli/src/lib/db.ts:592-596
const stmt = db.prepare(`
  INSERT OR REPLACE INTO inventory (
    operation_id, source_path, relative_path, mtime, size, rating,
    genre, year, bpm, artist, dest_path, copied_at
```

Database access is function-based around `better-sqlite3`. Add hash persistence through prepared statements in `db.ts`, and keep schema changes in `schema.sql` plus `migrations.ts`.

### SERVICE_PATTERN

```
// SOURCE: packages/rfmedia-cli/src/actions/copy-filter.ts:436-442
async function copyOrConvertFile(
  source: string,
  dest: string,
  hardlink: boolean,
  convertFormat?: ConvertFormat,
```

Action modules use module-local async helpers with explicit parameters. Prefer a small shared hash-recording helper over a new service class or broad copy-system refactor.

### TEST_STRUCTURE

```
// SOURCE: packages/rfmedia-cli/src/lib/db.test.ts:8-14
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
```

Use Vitest with colocated tests. DB tests create temporary directories, initialize a real SQLite database, close handles in `afterEach`, and remove temp files.

---

## Files to Change

| File                                                   | Action | Justification                                                                                                            |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/rfmedia-cli/src/lib/integrity.ts`            | UPDATE | Reuse/extend the existing SHA-256 utility for single destination hashing without forcing source+destination verification |
| `packages/rfmedia-cli/src/lib/db.ts`                   | UPDATE | Add hash fields to inventory writes and prepared read helpers for tests/downstream consumers                             |
| `packages/rfmedia-cli/src/lib/schema.sql`              | UPDATE | Add nullable SHA-256 storage to copied-file metadata and advance schema metadata                                         |
| `packages/rfmedia-cli/src/lib/migrations.ts`           | UPDATE | Increment `CURRENT_SCHEMA_VERSION` and add version 9 migration logic                                                     |
| `packages/rfmedia-cli/src/types/db.ts`                 | UPDATE | Expose new hash column(s) on DB row and write parameter contracts                                                        |
| `packages/rfmedia-cli/src/types/inventory.ts`          | UPDATE | Add optional hash fields to inventory entries so sync/inventory paths can pass hashes through                            |
| `packages/rfmedia-cli/src/lib/inventory.ts`            | UPDATE | Map optional hash fields into `recordInventoryFile` for database-backed inventory                                        |
| `packages/rfmedia-cli/src/actions/copy-album.ts`       | UPDATE | Compute/persist hashes after successful album copy, hardlink, and conversion destinations                                |
| `packages/rfmedia-cli/src/actions/copy-filter.ts`      | UPDATE | Compute/persist hashes after successful filter copy, range copy, hardlink, and conversion destinations                   |
| `packages/rfmedia-cli/src/actions/sync.ts`             | UPDATE | Preserve inventory hash data for sync copy operations, which already write copied-file inventory rows                    |
| `packages/rfmedia-cli/src/actions/plex-copy.ts`        | UPDATE | Include Plex copy paths if they write to the same tracking DB during copy result workflows                               |
| `packages/rfmedia-cli/src/lib/db.test.ts`              | UPDATE | Verify schema version, migration from version 8, and hash persistence/read behavior                                      |
| `packages/rfmedia-cli/src/lib/integrity.test.ts`       | UPDATE | Cover any new single-file hash helper behavior and error propagation                                                     |
| `packages/rfmedia-cli/src/actions/copy-album.test.ts`  | UPDATE | Assert hash persistence after successful album copy paths and skip on dry-run                                            |
| `packages/rfmedia-cli/src/actions/copy-filter.test.ts` | UPDATE | Assert hash persistence after successful filter copy paths and skip on dry-run                                           |
| `packages/rfmedia-cli/src/actions/plex-copy.test.ts`   | UPDATE | Assert Plex copy hash persistence if Plex copy is wired                                                                  |
| `packages/rfmedia-cli/benchmarks/copy.bench.ts`        | UPDATE | Measure copy overhead against the `<5%` acceptance target                                                                |

## NOT Building

- Generic `HashingService`, hash worker pool, or pluggable hash algorithms; one SHA-256 use case exists and `integrity.ts` already owns hashing.
- New database migration framework; follow the existing `schema.sql` plus `migrations.ts` pattern.
- New CLI flags, JSON output fields, text summaries, or user-facing checksum displays.
- Retroactive backfill for old rows; store hashes for new successful copy operations only.
- Duplicate detection, conversion caching, Merkle verification, or content-based incremental sync; this feature only creates the storage foundation.
- Broad refactor of duplicated copy logic across album/filter/Plex/sync actions.

---

## Step-by-Step Tasks

### Task 1.1: Extend DB And Inventory Types - Depends on [none]

- **BATCH**: B1
- **ACTION**: Update `packages/rfmedia-cli/src/types/db.ts` and `packages/rfmedia-cli/src/types/inventory.ts` with nullable/optional SHA-256 fields.
- **IMPLEMENT**: Add `content_hash: string | null` to `DbInventoryEntry`. Add `contentHash?: string | null` to file inventory entry/write contracts; keep TS inputs camelCase and DB rows snake_case.
- **MIRROR**: `NAMING_CONVENTION`, `REPOSITORY_PATTERN`
- **IMPORTS**: None expected.
- **GOTCHA**: Existing rows need nullable DB representation; do not require hashes on legacy inventory data.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run typecheck`

### Task 1.2: Add SQLite Schema Version 9 - Depends on [none]

- **BATCH**: B1
- **ACTION**: Update `packages/rfmedia-cli/src/lib/schema.sql` to add `content_hash TEXT` to `inventory` and advance metadata comments/version to 9.
- **IMPLEMENT**: Add the column in the `CREATE TABLE IF NOT EXISTS inventory` definition near copied-file metadata. Add idempotent migration SQL for existing DBs if this repo's schema file pattern requires `ALTER TABLE` guards; keep existing index strategy unless hash lookup is immediately needed.
- **MIRROR**: `REPOSITORY_PATTERN`
- **IMPORTS**: None.
- **GOTCHA**: SQLite cannot add a `NOT NULL` column without a default; use nullable storage for existing rows.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/lib/db.test.ts`

### Task 1.3: Update Migration Constant - Depends on [none]

- **BATCH**: B1
- **ACTION**: Increment `CURRENT_SCHEMA_VERSION` in `packages/rfmedia-cli/src/lib/migrations.ts` and add a version 9 block.
- **IMPLEMENT**: Follow the existing sequential `if (currentVersion < N)` style. Ensure older DBs advance metadata to `9` without dropping existing tracking, history, queue, or inventory rows.
- **MIRROR**: `REPOSITORY_PATTERN`, `ERROR_HANDLING`
- **IMPORTS**: None.
- **GOTCHA**: `initializeDatabase` executes `schema.sql` before migrations; make the version path idempotent for reopened databases.
- **VALIDATE**: Add/adjust DB migration tests, then run `cd packages/rfmedia-cli && npm run test:run -- src/lib/db.test.ts`.

### Task 2.1: Add DB Hash Persistence - Depends on [1.1, 1.2, 1.3]

- **BATCH**: B2
- **ACTION**: Update `packages/rfmedia-cli/src/lib/db.ts` inventory write/read helpers for `content_hash`.
- **IMPLEMENT**: Add `contentHash?: string | null` to `recordInventoryFile`'s entry parameter, include `content_hash` in `INSERT OR REPLACE`, and return it from existing inventory queries. Add a focused lookup helper only if tests or downstream callers need one.
- **MIRROR**: `REPOSITORY_PATTERN`
- **IMPORTS**: Existing imports should be enough.
- **GOTCHA**: Keep prepared statements with positional placeholders; do not interpolate hash or path values into SQL.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/lib/db.test.ts`

### Task 2.2: Add Single Destination Hash Helper - Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Update `packages/rfmedia-cli/src/lib/integrity.ts` only if the existing `calculateHash(filePath)` needs a clearer copy-facing wrapper.
- **IMPLEMENT**: Prefer reusing `calculateHash(destPath)` directly. If adding a wrapper, keep it thin and return the lowercase hex string from the final destination file after the copy/conversion succeeds.
- **MIRROR**: `SERVICE_PATTERN`, `TEST_STRUCTURE`
- **IMPORTS**: Existing `node:crypto`, `node:fs`, and `node:stream/promises`.
- **GOTCHA**: Do not call `verifyFileIntegrity` for persistence; it hashes both source and destination and skips converted-file semantics.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/lib/integrity.test.ts`

### Task 3.1: Pass Hash Through Inventory Adapter - Depends on [2.1, 2.2]

- **BATCH**: B3
- **ACTION**: Update `packages/rfmedia-cli/src/lib/inventory.ts` to persist optional `contentHash`.
- **IMPLEMENT**: Map `entry.contentHash ?? null` into `recordInventoryFile`. Ensure legacy JSONL inventory records can omit the field and still load.
- **MIRROR**: `REPOSITORY_PATTERN`
- **IMPORTS**: None expected.
- **GOTCHA**: JSONL compatibility matters for legacy inventory mode; optional is required there.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/lib/inventory.test.ts src/lib/db.test.ts`

### Task 3.2: Wire Sync Copy Inventory Hashes - Depends on [2.1, 2.2]

- **BATCH**: B3
- **ACTION**: Update `packages/rfmedia-cli/src/actions/sync.ts` so copied files recorded in inventory include destination content hashes.
- **IMPLEMENT**: After copy/convert succeeds and before `appendFileRecord`, compute `calculateHash(destPath)` and pass it into `createFileInventoryEntry` or assign it on the returned entry. Keep dry-run and skipped files unchanged.
- **MIRROR**: `SERVICE_PATTERN`
- **IMPORTS**: `calculateHash` from `../lib/integrity.js`.
- **GOTCHA**: For converted files, hash `destPath`, not the original source. For range copies, record the hash associated with the destination currently stored in inventory.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/actions/sync.test.ts`

### Task 3.3: Add DB And Hash Tests - Depends on [2.1, 2.2]

- **BATCH**: B3
- **ACTION**: Update `packages/rfmedia-cli/src/lib/db.test.ts` and `packages/rfmedia-cli/src/lib/integrity.test.ts`.
- **IMPLEMENT**: Assert schema version `9`, migration from version `8`, nullable legacy hash rows, and persisted/retrieved 64-character hashes. Keep integrity helper tests mocked like the existing `calculateHash` tests.
- **MIRROR**: `TEST_STRUCTURE`
- **IMPORTS**: Vitest helpers and existing temp directory utilities.
- **GOTCHA**: Close DB handles before removing temp directories.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/lib/db.test.ts src/lib/integrity.test.ts`

### Task 4.1: Wire Album Copy Hash Persistence - Depends on [3.1]

- **BATCH**: B4
- **ACTION**: Update `packages/rfmedia-cli/src/actions/copy-album.ts` at successful copy/hardlink/convert points.
- **IMPLEMENT**: After each final destination is created and before completion is recorded, hash the final destination path and persist it through the SQLite inventory/hash helper when a tracking DB is available. Preserve existing `--verify` cleanup behavior and dry-run behavior.
- **MIRROR**: `SERVICE_PATTERN`, `ERROR_HANDLING`
- **IMPORTS**: `calculateHash` plus DB/inventory helper imports as needed.
- **GOTCHA**: The first-copy optimization creates later copies from an existing destination; each destination still needs its own post-success hash record.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/actions/copy-album.test.ts`

### Task 4.2: Wire Filter Copy Hash Persistence - Depends on [3.1]

- **BATCH**: B4
- **ACTION**: Update `packages/rfmedia-cli/src/actions/copy-filter.ts` helper and inline copy paths.
- **IMPLEMENT**: Return or carry hash metadata from `copyOrConvertFile` where useful, and compute destination hashes after successful inline `copyOrLink`/`convertFile` paths. Persist hash rows only for successful non-dry-run copies.
- **MIRROR**: `SERVICE_PATTERN`, `ERROR_HANDLING`
- **IMPORTS**: `calculateHash` plus DB/inventory helper imports as needed.
- **GOTCHA**: Converted outputs must store the converted destination hash; existing `--verify` intentionally skips converted comparison and should stay separate.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/actions/copy-filter.test.ts`

### Task 4.3: Wire Plex Copy Hash Persistence - Depends on [3.1]

- **BATCH**: B4
- **ACTION**: Update `packages/rfmedia-cli/src/actions/plex-copy.ts` if Plex copy uses the same tracking database during copied-file workflows.
- **IMPLEMENT**: At direct copy/convert loops, hash each final destination after success and persist via the same DB helper. If no operation/tracking context exists for a path, document the reason in a code comment and leave Plex copy out of scope.
- **MIRROR**: `SERVICE_PATTERN`
- **IMPORTS**: `calculateHash` plus DB helper imports as needed.
- **GOTCHA**: Do not create an unrelated tracking operation solely for Plex copy unless existing architecture already does so.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/actions/plex-copy.test.ts`

### Task 4.4: Add Action-Level Tests - Depends on [3.1]

- **BATCH**: B4
- **ACTION**: Update copy action tests for album, filter, sync, and Plex copy paths touched by this implementation.
- **IMPLEMENT**: Mock `calculateHash` with a deterministic 64-character hex string. Assert persistence after success, no persistence on dry-run/skips/failures, and failure propagation when hashing rejects.
- **MIRROR**: `TEST_STRUCTURE`
- **IMPORTS**: Vitest `vi`, existing hoisted mock style.
- **GOTCHA**: Keep mocked module implementations stable; use existing `vi.hoisted` patterns.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run test:run -- src/actions/copy-album.test.ts src/actions/copy-filter.test.ts src/actions/sync.test.ts src/actions/plex-copy.test.ts`

### Task 5.1: Add Performance Benchmark Coverage - Depends on [4.1, 4.2]

- **BATCH**: B5
- **ACTION**: Update `packages/rfmedia-cli/benchmarks/copy.bench.ts` or benchmark helpers to measure hashing overhead.
- **IMPLEMENT**: Compare regular copy workloads with content hashing enabled against a comparable baseline. Record enough detail in benchmark names/output for the `<5%` target to be evaluated.
- **MIRROR**: `TEST_STRUCTURE`
- **IMPORTS**: Existing benchmark helpers.
- **GOTCHA**: Dry-run benchmarks do not exercise hashing and should not be used for overhead acceptance.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run bench -- copy.bench.ts`

### Task 5.2: Run Full Validation - Depends on [4.4, 5.1]

- **BATCH**: B5
- **ACTION**: Run package-level validation commands and fix regressions in touched areas only.
- **IMPLEMENT**: Run typecheck and the relevant unit tests first, then the full rfmedia test suite. Run benchmark validation and record whether overhead is below 5%.
- **MIRROR**: `TEST_STRUCTURE`
- **IMPORTS**: None.
- **GOTCHA**: Benchmarks can be noisy; use the repo's existing benchmark guidance and compare like-for-like local runs.
- **VALIDATE**: `cd packages/rfmedia-cli && npm run typecheck && npm run test:run && npm run bench -- copy.bench.ts`

---

## Testing Strategy

### Unit Tests

| Test                        | Input                                  | Expected Output                                                      | Edge Case? |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------------- | ---------- |
| DB initializes new schema   | New temp SQLite DB                     | `getCurrentSchemaVersion(db) === 9`; `inventory.content_hash` exists | No         |
| DB migrates v8 to v9        | Existing DB with metadata value `8`    | Existing rows remain; new nullable hash column exists                | Yes        |
| Inventory write stores hash | `recordInventoryFile(... contentHash)` | `getInventory` returns `content_hash` matching input                 | No         |
| Legacy inventory row        | Existing row without hash              | returned `content_hash` is `null`                                    | Yes        |
| Hash helper                 | Small temp file                        | lowercase 64-character SHA-256 hex                                   | No         |
| Album copy success          | Mock successful copy and hash          | hash persistence helper called after copy                            | No         |
| Filter conversion success   | Mock conversion and hash               | stored hash comes from final destination path                        | Yes        |
| Dry-run copy                | `dryRun: true`                         | no hash calculation or DB insert                                     | Yes        |
| Hash failure                | `calculateHash` rejects                | operation records failure and does not mark completed                | Yes        |

### Edge Cases Checklist

- [ ] Dry-run copies
- [ ] Skipped destination because it already exists
- [ ] Hardlink success
- [ ] Copy fallback after hardlink not possible
- [ ] Converted audio output
- [ ] Range copies using first-copy optimization
- [ ] Hash stream error after destination creation
- [ ] Existing SQLite database at schema version 8
- [ ] Legacy JSONL inventory entries without hash
- [ ] Worker-limited parallel copy runs

---

## Validation Commands

### Static Analysis

```bash
cd packages/rfmedia-cli && npm run typecheck
```

EXPECT: Zero type errors.

### Unit Tests

```bash
cd packages/rfmedia-cli && npm run test:run -- src/lib/db.test.ts src/lib/integrity.test.ts src/lib/inventory.test.ts src/actions/copy-album.test.ts src/actions/copy-filter.test.ts src/actions/sync.test.ts src/actions/plex-copy.test.ts
```

EXPECT: All affected tests pass.

### Full Test Suite

```bash
cd packages/rfmedia-cli && npm run test:run
```

EXPECT: No regressions.

### Database Validation

```bash
cd packages/rfmedia-cli && npm run test:run -- src/lib/db.test.ts
```

EXPECT: Schema version 9, v8 migration, and hash persistence tests pass.

### Performance Validation

```bash
cd packages/rfmedia-cli && npm run bench -- copy.bench.ts
```

EXPECT: Regular copy workload overhead from content hashing is below 5% compared with the local baseline run.

### Manual Validation

- [ ] Run an album copy into a temp destination with a temp tracking database.
- [ ] Query SQLite `inventory` rows and confirm `content_hash` is 64 lowercase hex chars.
- [ ] Repeat with `--convert mp3` and confirm the stored hash matches the converted destination bytes.
- [ ] Repeat with `--dry-run` and confirm no hash rows are inserted.
- [ ] Run with `--debug` and confirm routine hash persistence does not print full hashes.

---

## Acceptance Criteria

- [ ] Every successful non-dry-run `rfmedia copy` album-mode file copy records a 64-character lowercase hex SHA-256 content hash in SQLite for the copied destination file.
- [ ] Every successful non-dry-run `rfmedia copy` filter-mode file copy records a 64-character lowercase hex SHA-256 content hash in SQLite for the copied destination file.
- [ ] Copy operations that use audio conversion store the SHA-256 hash of the final converted destination file, not original source bytes.
- [ ] Copy operations that create hardlinks store a SHA-256 hash after the hardlink succeeds.
- [ ] Dry-run copy commands do not create files and do not insert hash records.
- [ ] SQLite schema version increments from 8 to 9 and existing databases migrate without losing tracking, inventory, completed-copy, or history records.
- [ ] DB type definitions and read/write helpers expose stored hash values for tests and future consumers.
- [ ] Hashing uses Node.js built-in `crypto`/stream APIs and returns lowercase hex strings matching `/^[a-f0-9]{64}$/`.
- [ ] Hashing failure causes the affected file operation to fail and follow existing failed-source tracking rather than marking the source completed.
- [ ] Routine content-hash persistence does not log full SHA-256 values by default.
- [ ] Hash calculation observes existing copy worker limits and does not create an unbounded parallel stream-reader pool.
- [ ] Copy-time overhead is measured with the existing copy benchmark suite and remains below 5% for regular copy workloads.

## Completion Checklist

- [ ] Code follows discovered module-local helper and function-based DB patterns.
- [ ] Error handling matches existing filesystem/hash failure behavior.
- [ ] Logging avoids routine full-hash disclosure.
- [ ] Tests follow Vitest colocated test patterns.
- [ ] No new runtime hashing dependency added.
- [ ] No new CLI output, flags, or JSON fields added.
- [ ] Schema version and migration tests updated.
- [ ] Benchmark result recorded for the `<5%` overhead target.
- [ ] Documentation updated only if implementation changes user-visible behavior.
- [ ] Self-contained - no questions needed during implementation.

## Risks

| Risk                                             | Likelihood | Impact | Mitigation                                                                                                     |
| ------------------------------------------------ | ---------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| Hashing doubles read I/O for copy operations     | Medium     | Medium | Hash destination after success and measure with `copy.bench.ts`; avoid extra source hashing outside `--verify` |
| Converted files accidentally store source hash   | Medium     | High   | Always hash final destination path after conversion completes                                                  |
| Existing DB migration mishandles v8 databases    | Low        | High   | Add explicit v8-to-v9 migration test using temp DB and existing row preservation                               |
| Routine logs disclose content fingerprints       | Low        | Medium | Do not log full hashes during normal persistence; keep mismatch logs scoped to verification                    |
| Parallel hash reads bypass worker caps           | Medium     | Medium | Compute within existing copy task flow and do not spawn separate unbounded workers                             |
| Scope expands into dedup/cache/sync feature work | Medium     | Medium | Keep downstream features in NOT Building; only persist hash foundation                                         |

## Notes

- Issue 111 lists `src/lib/hasher.ts`, `src/lib/copy.ts`, `src/types/database.ts`, and `src/lib/database.ts`, but the current repo structure maps those concerns to `packages/rfmedia-cli/src/lib/integrity.ts`, action modules, `src/types/db.ts`, and `src/lib/db.ts`.
- The existing `inventory` table is the closest match for "alongside file path and copy metadata"; use it unless implementation discovers a stronger existing per-file copy table.
- Enhanced research dispatch completed with six standalone researchers; the seventh synthesis role was covered locally because the runtime agent limit was reached.
