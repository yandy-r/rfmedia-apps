# Issue #56 Action Test Coverage: Architecture Research

## System Overview

Issue [#56](https://github.com/yandy-r/rfmedia-apps/issues/56) strengthens four local rfmedia-cli
action boundaries: album verification, filter verification, incremental sync, and legacy-state
migration. The CLI and MCP layers translate user input, while exported action functions own
orchestration, structured results, filesystem mutation ordering, database lifetime, and cleanup.
Lower-level libraries remain authoritative for verification tiers, inventory diffs, persistence,
history import, and safe file replacement.

```text
Commander CLI / MCP adapter
           |
           v
exported action boundary --------------------------> typed result
   |              |                 |
   v              v                 v
verify plan     sync diff       legacy discovery
and repair      and apply       and import
   |              |                 |
   v              v                 v
filesystem     inventory DB     tracking/history DB
adapters       + media scan     + proof-gated cleanup
```

The intended tests sit at the exported action boundary. They mock destructive or nondeterministic
adapters, assert returned domain results and observable calls, and use real temporary SQLite only
where durable read-back is the contract. No network service, new database schema, command option,
or public wire shape is required.

## Relevant Components

### Entry and translation layers

| Component                 | Responsibility                                                          | Issue #56 relevance                                                                |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/commands/verify.ts`  | Builds `VerifyOptions`, selects album or filter action, formats outcome | Existing command translation; action tests should not duplicate Commander behavior |
| `src/commands/sync.ts`    | Builds `SyncOptions` and invokes sync                                   | One caller of the exported sync action                                             |
| `src/mcp/adapters.ts`     | Translates MCP sync arguments                                           | Shares the same sync action and therefore inherits its corrected contract          |
| `src/commands/migrate.ts` | Validates migration flags and invokes migration                         | Mutual-exclusion validation remains command-owned                                  |

### Exported action seams

| Component                         | Exported seam                                                    | Owned lifecycle                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/actions/verify-album.ts`     | `executeAlbumVerify()` and `executeAlbumVerifyWithFileInput()`   | Source/range expansion, evidence preload, abort cleanup, verification, staged repair, recheck, result aggregation |
| `src/actions/verify-filter.ts`    | `executeFilterVerify()` and `executeFilterVerifyWithFileInput()` | Rating eligibility, destination layout, evidence preload, abort cleanup, verification/fix/recheck, aggregation    |
| `src/actions/sync.ts`             | `executeSyncWithFileInput()`                                     | Input selection, inventory/database setup, diff application, partial-file cleanup, operation status, scan gating  |
| `src/actions/migrate-tracking.ts` | `executeMigrate()`                                               | Discovery, import routing, migration proof aggregation, confirmation, deletion, database close, summary result    |

### Library owners

| Component                        | Authoritative behavior                                                                      | Test boundary                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/lib/tiered-verification.ts` | Converts evidence into present/missing/mismatch outcomes and counters                       | Mock explicit outcomes in action tests; retain its own algorithm tests             |
| `src/lib/filesystem.ts`          | Copy/link, size and existence checks, staged replacement, trash/remove, partial cleanup     | Mock mutation in action tests; assert ordering and exact paths                     |
| `src/lib/conflict-resolver.ts`   | Strategy and interactive conflict decisions                                                 | Mock decisions; verify action-owned mutation and final unresolved truth            |
| `src/lib/inventory.ts`           | Inventory initialization/load/reset, album/filter diffs, source/file persistence            | Mock diff fixtures in action tests; do not retest diff algorithms                  |
| `src/lib/db.ts`                  | SQLite connection, operation rows/counts/status, completed/failed/history/inventory records | Mock lifecycle in action tests; use temporary SQLite for durable migration proof   |
| `src/lib/completed-tracker.ts`   | Legacy completed/failed parsing and database import during normal initialization            | Reuse as the single tracking importer; do not duplicate it in the migration action |
| `src/lib/history.ts`             | Legacy JSONL validation and session/operation persistence                                   | Accept the action-resolved directory and return actual imported counts/proof       |
| `src/lib/signal-handler.ts`      | Global abort signal and ordered cleanup registry                                            | Mock registration; assert exact registration/unregistration and callbacks          |

### Test components

- `src/actions/verify-album.test.ts` and `verify-filter.test.ts` already provide mature hoisted ESM
  mock harnesses for conflict and tier behavior. Extend them only for missing detection, repair, and
  failed/successful recheck.
- `src/actions/sync.test.ts` currently proves materialize -> hash -> inventory ordering. Extend its
  inventory, database, deletion, scan, and cleanup mocks for action lifecycle coverage.
- Create `src/actions/migrate-tracking.test.ts` for discovery/import/deletion routing. Use a hoisted
  virtual filesystem for action tests and a narrowly scoped temporary SQLite integration test for
  importer equivalence.

## Verify Action Flow

### Album mode

```text
source/file/CLI entries
  -> choose range: CLI > per-path > config
  -> preload read-only fingerprint evidence once
  -> register verify-album-abort
  -> find albums and expand every configured suffix
  -> verify each expected destination through verification tier
  -> find extras from the expected filename set
  -> optionally resolve and stage repairs
  -> reverify the complete destination set
  -> aggregate VerifyCommandResult
  -> unregister abort cleanup and close evidence DB in finally
```

`executeAlbumVerify()` keeps the read-only database open while verification uses its candidates and
closes it in `finally`. The batch entry point also unregisters `verify-album-abort` and closes the
single evidence connection in `finally`. Missing and mismatch repair use
`replaceFileWithValidatedStage()`; a completed write is not sufficient proof. The post-repair
verification pass owns final `verified`, issue, and `remainingIssues` values.

### Filter mode

```text
source/file/CLI entries
  -> canonicalize source roots and choose range precedence
  -> load fingerprint candidates once, then close read-only DB
  -> register verify-filter-abort
  -> discover audio and evaluate rating/metadata eligibility
  -> allocate deterministic flat/structured/album destinations
  -> verify eligible tasks and discover extras per directory
  -> optionally resolve, stage, and reverify repairs
  -> aggregate VerifyCommandResult across sources
  -> unregister abort cleanup in finally
```

Filter evidence differs from album evidence: `loadFilterVerificationEvidence()` reads candidates
and closes its database immediately because the returned candidates are detached data. Filtered-out
sources never become expected tasks, so they must not increase missing or expected counts. Album
and filter test harnesses should remain separate because their layout, eligibility, and evidence
ownership differ.

### Verification cleanup proof

- Source/destination observation, not a repair call, determines completeness.
- Safe replacement materializes and validates a stage before swapping the expected destination.
- A failed validator preserves the original destination and remains an unresolved issue.
- `skip` and refused `rename` can produce successful decision records while remaining unresolved;
  final counters must reflect re-observation.
- Batch cleanup must unregister its named abort handler once. Album evidence must also close once on
  success and error; filter evidence must close during preload even if candidate lookup fails.

## Sync Action Flow

```text
CLI source entries or input file
  -> choose legacy JSONL or SQLite inventory context
  -> initialize/reset/load inventory
  -> register abort, partial-file, and optional DB cleanup
  -> for each source:
       path existence check
       -> compute album/filter diff
       -> persist scan time when changes exist
       -> new/updated file materialization
          -> final destination hash
          -> one inventory record for represented first suffix
          -> increment new or updated result count
       -> optional downgraded destination removal
  -> optional media scan after successful non-dry-run writes
  -> unregister cleanup handlers
  -> update DB operation counts/status
  -> close DB once
```

The action consumes diff classification from `inventory.ts`; it should not rediscover file changes.
Classification must survive into `syncFile()`: a detected updated destination must replace its
represented existing artifact, while an unrelated new-file collision still obeys force policy.
This requires an internal updated-entry overwrite intent, not a new global CLI option.

The successful per-file ordering is strict:

1. Add the destination to the in-progress set.
2. Materialize copy, hardlink, or conversion.
3. Remove it from the in-progress set only after materialization succeeds.
4. Hash the final represented destination.
5. Build and append one inventory entry.
6. Count the file as new or updated.

A materialization, hash, or inventory failure must not report a copied file. Later range copies may
be hardlinked from the first destination, but only the first destination is represented in the
inventory row. Dry-run simulates counts without filesystem, database, inventory, prompt, or scan
mutation.

### Sync database and cleanup lifecycle

- SQLite mode initializes one connection and one operation before loading inventory. Legacy and
  dry-run modes avoid that connection.
- `sync-abort` aborts active work. `sync-partial-files` calls `cleanupPartialFile()` for every path
  still in the in-progress set. `sync-database` exists as a global interruption fallback.
- Normal completion unregisters all cleanup names before final database bookkeeping, preventing the
  registered database callback from racing the explicit close.
- Operation counts and `completed`/`partial`/`failed` status must be written before explicit close.
- Tests should invoke captured cleanup callbacks to prove partial-file cleanup, rather than only
  asserting registration names.
- Media scan is an integration side effect after durable action work. It triggers only when a
  non-dry-run run reports at least one new or updated copy; scan failure is warning-only and must not
  rewrite sync success counters.

## Migration Action Flow

### Current flow and defects

```text
resolve DB path -> initialize DB unless dry-run
  -> discover tracking sidecars from cwd
  -> group by options hash
  -> count entries (current non-dry-run path does not persist them)
  -> discover history files from requested/default directory
  -> migrate history from helper's default directory
  -> optionally delete every discovered path
  -> close DB only on normal completion
```

This flow violates the feature's safety boundary in four connected ways:

- manual tracking migration reports counts while an explicit TODO performs no database writes;
- grouping only by options hash can merge different input-file identities;
- custom history discovery and `migrateLegacyHistory()` can target different directories;
- deletion eligibility derives from discovery rather than proven durable import, and the database
  is not closed if an import throws.

### Target flow

```text
resolve one migration context
  -> initialize DB in outer try/finally unless dry-run
  -> discover and validate legacy candidates
  -> group tracking by (input identity, options hash)
  -> import through completed-tracker library owner
  -> import history from the same resolved directory used for discovery
  -> verify durable equivalence / collect per-file proof
  -> derive deletion-eligible paths only from proof
  -> confirm unless force; unlink eligible files independently
  -> return counts and contained errors
  -> close DB exactly once in finally
```

Discovery metadata is preview information, never migration proof. The tracking importer should
reuse the parser and database record functions already owned by `completed-tracker.ts` and return
counts plus enough successful-file evidence for deletion eligibility. The history importer should
accept an optional directory defaulting to `getHistoryDir()` and preserve session identity,
operations, and status in the existing tables.

`--delete-old` operates only on proven or already-equivalent inputs. `force` skips confirmation but
does not bypass proof. One unlink failure remains a contained `MigrateResult.errors` entry and does
not prevent safe sibling deletions. An import or initialization failure must retain every unproven
source and close any initialized connection.

## Integration Points

### Database integration

| Flow                       | Database access                            | Required proof                                                                       |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Album verify quick tier    | None                                       | Filesystem observation                                                               |
| Album verify default/deep  | Read-only connection retained for batch    | Close once in `finally`; candidates correspond to canonical source roots             |
| Filter verify quick tier   | None                                       | Eligibility plus filesystem observation                                              |
| Filter verify default/deep | Read-only candidate preload                | Candidate lookup and immediate close are exception-safe                              |
| Sync SQLite mode           | Read/write operation and inventory context | Materialize/hash/persist ordering; final counts/status before close                  |
| Migrate execute mode       | Read/write tracking and history import     | Database read-back/equivalence before deletion eligibility; close in outer `finally` |
| Dry-run                    | No database initialization or write        | Returned preview derives from validated discovery only                               |

No schema change is required. Existing `operations`, `completed_sources`, `failed_sources`,
`history_sessions`, `history_operations`, and `inventory` tables are sufficient. Operation identity
must preserve both legacy input identity and options hash.

### Filesystem integration

- Verification uses path existence, directory/audio discovery, size/tier reads, extra-file scans,
  staged replacement, removal, and trash. Mock mutations and tier outcomes at the action boundary.
- Sync uses existence, copy/link/conversion, hash, remove, and partial cleanup. Mock these in action
  tests; assert exact paths and ordering.
- Migration uses `fast-glob`, directory listing, file reads, and unlink. A hoisted virtual filesystem
  prevents cwd/home leakage; use real temporary storage only for the importer read-back test.
- No test may scan the real worktree for sidecars, write the user's tracking database, call the real
  trash implementation, or unlink a non-fixture path.

### Output and caller integration

All action surfaces retain existing typed results: `VerifyCommandResult`, `SyncResult`, and
`MigrateResult`. Commander and MCP callers require no signature, output, or option change. Result
counters and stable path/message/code fields are the test contract; decorative logger, spinner,
table, and color output are not.

## Internal Dependencies

- Node ESM/NodeNext imports require `.js` suffixes in TypeScript source.
- `vi.hoisted()` is required for mocks referenced by ESM `vi.mock()` factories.
- The verify suites rely on `clearAllMocks()` retaining implementations and then restore deliberate
  defaults. Sequenced repair tests must supply outcomes for the initial pass and recheck.
- `processInParallel()` should be replaced with the existing deterministic sequential action-test
  mock. Scheduler concurrency belongs to its library tests.
- `pathExists()` is multi-purpose. Mocks must distinguish source roots, destination artifacts,
  inventory files, and history directories to avoid testing the wrong branch.
- Inventory diff algorithms already have dedicated coverage; action tests should inject small
  `newFiles`, `updatedFiles`, `unchangedFiles`, and `downgradedFiles` fixtures.
- Migration grouping and proof should have one production owner. Do not copy legacy parsing or SQL
  writes into both `completed-tracker.ts` and `migrate-tracking.ts`.

## External Dependencies

| Dependency                   | Role                                      | Test treatment                                                |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Node.js 22                   | Runtime, paths, filesystem, abort signals | Use the pinned `mise` runtime and isolated temporary fixtures |
| Vitest 4.0.17                | Test runner and ESM mocking               | Existing dependency; no change                                |
| `@vitest/coverage-v8` 4.0.17 | Focused statement/line measurement        | Existing dependency; no global threshold change               |
| `fast-glob` 3.3.3            | Tracking sidecar discovery                | Mock exact matches in action tests                            |
| `better-sqlite3` 12.6.2      | Durable local persistence                 | Use existing DB layer and one temporary read-back fixture     |
| Media-server scan adapter    | Optional post-sync side effect            | Mock capabilities and success/failure; no network calls       |

There are no required cloud APIs, containers, live media servers, or new packages.

## Architecture Constraints and Completion Evidence

- Do not add a generic fake filesystem or a shared verify harness in this issue. Narrow module mocks
  match the current architecture and avoid a test-infrastructure refactor.
- Do not expose private action helpers only for coverage. Exercise exported action entry points and
  existing library owners.
- Preserve existing conflict tests; add only missing behavioral partitions and lifecycle proof.
- Reach the issue's focused 80% statement/line target per named action without asserting inert log
  branches.
- Prove cleanup, not merely setup: captured callbacks remove in-progress sync files, read-only and
  read/write databases close once on success/error, failed rechecks retain unresolved verification
  truth, and only durably imported legacy files reach unlink.
- No Bash, Zsh, or Fish completion edit is required because the CLI surface does not change.
- Completion requires focused tests/coverage, rfmedia typecheck and full suite, markdown lint,
  registered CI, `Closes #56`, and consistent removal of #56 from all live `ROADMAP.md` backlog,
  sprint, and cross-cutting references.
