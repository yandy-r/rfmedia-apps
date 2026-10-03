# Issue 56 Action-Test Business Research

## Executive Summary

Issue [#56](https://github.com/yandy-r/rfmedia-apps/issues/56) asks for production-risk coverage of
the `verify-album`, `verify-filter`, `sync`, and `migrate-tracking` actions. The valuable outcome is
not four files or an isolated 80% number: it is proof that the CLI reports filesystem drift
truthfully, repairs only authorized discrepancies, persists incremental state before claiming
success, and never discards legacy state before migration is proven.

Later work substantially covers verification conflict handling and adds a narrow sync fingerprint
suite. It does not close the issue: missing-file verification is still absent at the action boundary,
sync's ordinary diff lifecycle is largely untested, and `migrate-tracking.test.ts` does not exist.
More importantly, current manual tracking migration counts discovered records without inserting
them, so `--delete-old` can delete the only legacy copy after a false success report.

## Live Issue Intent

The open issue was created on 2026-01-26 and has no comments, child issues, milestone, or later
acceptance amendment. Its explicit scope is:

- add action tests for album verification, filter verification, sync, and tracking migration;
- mock filesystem operations;
- cover size mismatch, missing file, and extra file behavior;
- cover verify fix mode across conflict scenarios;
- reach 80%+ coverage without adding unnecessary tests.

The percentage is a supporting signal, not the acceptance oracle. A small contract matrix that
fails on data loss, false success, or an incorrect repair is more valuable than exhaustive branches
that only restate mocks.

## User Stories

- **Library operator verifying ranged albums:** can distinguish complete copies from missing,
  mismatched, or extra artifacts for every expected suffix.
- **Library operator verifying a rating-filtered export:** gets the same truthful result across
  flat, structure-preserving, album, ranged, and converted layouts.
- **Operator using `verify --fix`:** can restore missing or mismatched expected artifacts and remove
  extras only after the selected conflict policy authorizes it; skipped or refused issues remain
  unresolved.
- **Operator running incremental sync:** receives only new/changed files, has downgraded files
  handled according to policy, and can rerun safely from inventory after partial failure.
- **Operator leaving legacy sidecars/history:** can preview and migrate state into SQLite without
  losing resumability or undo history, and can remove old files only after durable migration.
- **Automation consumer:** receives counts, failure details, and exit semantics that reflect real
  filesystem/database outcomes rather than attempted work.

## Business Rules

### Verification

The source and command options define an **expected artifact set**. Album mode expands each source
album over its numeric range. Filter mode first selects eligible audio files from ratings/metadata,
then maps them into the chosen flat, structured, album, range, and conversion layout.

Each expected artifact has one actionable state:

- `missing`: the destination artifact is absent;
- mismatch: the destination exists but selected verification evidence disagrees;
- `present`: the selected tier proves the expected contract;
- failure/unverifiable/unstable: the check could not safely prove the artifact;
- `extra`: a destination file is outside the expected set.

Missing, mismatch, extra, failure, unverifiable, and unstable states keep the result incomplete.
`--fix` does not redefine correctness: after any repair the action must re-run verification and
derive final counts from the observed destination. A successful copy call alone is not proof of a
successful fix.

Conflict policy applies only where there is a competing destination decision:

- missing expected files are copied/reconverted without an overwrite conflict;
- overwrite repairs mismatches at the expected path;
- skip leaves a mismatch unresolved;
- rename is not a valid repair because the expected path would remain wrong;
- overwrite/force maps to remove for extras, skip/rename maps to keep;
- `--trash` changes authorized extra removal from permanent deletion to trash;
- dry-run reports intended work but mutates nothing;
- non-interactive or machine output must not invent an answer when no strategy is provided.

### Sync

Sync is an incremental reconciliation between current source state, the destination, and an
operation-scoped inventory. The externally meaningful classifications are new, updated, unchanged,
downgraded, removed, and failed.

The write ordering is a safety contract:

```text
materialize final destination -> hash final bytes -> persist inventory -> count success
```

If copying/conversion, hashing, or inventory persistence fails, that file is failed and must not be
counted or persisted as successful. Other sources continue. Dry-run computes the proposed diff but
does not create a database, inventory, destination, deletion, hash, completion record, or media scan.

An updated source must replace its represented destination even when that destination already
exists; otherwise a detected update silently becomes no work. Current `syncFile()` has a generic
`!force && pathExists(destPath)` skip before materialization, so an action test for an updated file
with an existing destination is likely to expose a real defect. Missing sources must be reported as
`ENOENT` while later sources still run.

### Legacy Migration

Legacy `.completed.<hash>.txt` and `.failed.<hash>.txt` files preserve resumability; history JSONL
preserves undo/audit sessions. Migration is successful only when equivalent records are durably
queryable in SQLite. Discovery and line counts are a preview, not migration.

The migration identity must include the input sidecar basename as well as the options hash. Two
different input lists commonly share the same options hash and must not collapse into one operation.
Malformed files or entries may be skipped with a surfaced warning/error, but must never be included
in an unconditional deletion set.

`--delete-old` means delete **successfully migrated** legacy files. It must not delete merely
discovered files, must preserve files on database or record failure, and should continue collecting
per-file deletion failures. `--force` bypasses only the cleanup confirmation; it does not weaken the
migration proof. `--history-path` must govern both discovery and actual import.

## Current Coverage and Remaining Value

| Action             | Later coverage already present                                                                                                        | Remaining high-value contract                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify-album`     | Size-mismatch skip/overwrite, extra keep/remove/trash, interactive/apply-all, force, dry-run, tier aggregation, staged repair/refusal | Detect and fix a genuinely missing expected file, then prove post-fix counts; retain failed missing repair as unresolved                               |
| `verify-filter`    | Equivalent conflict matrix plus duplicate flat names, ranged/converted layouts, skipped extras, staged repair safety                  | Detect/fix missing files in representative flat and structured/ranged mapping without duplicating every layout combination                             |
| `sync`             | Three tests pin dry-run persistence exclusion and hash/inventory failure ordering                                                     | New/updated/unchanged classification, existing-destination update, downgrade delete/keep, missing-source continuation, DB/legacy routing and lifecycle |
| `migrate-tracking` | No action test; lower-level automatic sidecar migration has partial tests                                                             | Manual action discovery, durable tracking/history import, option routing, dry-run, cleanup gating, failure preservation, operation identity            |

The two verification suites were added later on the same day as the issue and expanded by tiered
verification and conversion work. Those tests satisfy most of “fix mode with conflict scenarios”;
rewriting the matrix would be filler. The sync suite arrived with later content-hash hardening and
intentionally proves only persistence ordering. Lower-level `completed-tracker.test.ts` proves some
automatic sidecar import behavior, but cannot prove the manual command's discovery, summary, cleanup,
or history-path workflow.

## Focused Acceptance Scenarios

### Verify album

1. One expected ranged destination is absent: result reports `missing`, expected total remains
   correct, and status is incomplete.
2. With `--fix`, the missing artifact is staged/materialized and reverified; only a passing recheck
   moves it to verified and increments repair counts.
3. If missing repair fails or recheck still disagrees, the issue and failure remain and completion
   is not reported.
4. Keep the existing mismatch/extra conflict suite as the proof for skip, overwrite, force, trash,
   ask/apply-all, dry-run, and rename refusal.

### Verify filter

1. An eligible track absent from the computed destination is reported missing; an ineligible track
   is not expected.
2. Missing repair uses the exact precomputed destination mapping and source path, including one
   non-flat or ranged/conversion case that catches path reconstruction errors.
3. Failed or unverifiable staged repair leaves the discrepancy unresolved.
4. Keep existing duplicate-name, tier, mismatch, and extra conflict tests rather than multiplying
   equivalent rating thresholds and layouts.

### Sync

1. A diff with new, updated, and unchanged files produces truthful counters and inventory writes;
   the updated existing destination is actually replaced.
2. Copy/convert failure, hash failure, and inventory failure each prevent success persistence while
   later work continues. Retain the two existing persistence-failure tests.
3. Downgraded files are removed only when enabled; dry-run counts proposed deletion without calling
   remove; removal failure is aggregated.
4. A missing source is reported and does not stop a following valid source.
5. Database mode initializes/closes the configured database and finalizes operation status/counts;
   legacy mode writes its JSONL inventory without initializing SQLite.
6. Dry-run performs no mutation or media scan. A real successful destination change may request one
   scan; unchanged/failed-only runs do not.

### Migrate tracking

1. Pair completed and failed sidecars for the same input/options identity, ignore comments/blanks,
   and verify equivalent completed/failed rows in SQLite before reporting migration.
2. Two input basenames with the same options hash create distinct operation groups.
3. Valid history JSONL is imported with session/operation counts; malformed files are surfaced and
   retained. A custom history path is used for import, not just discovery.
4. Dry-run reports prospective counts but never initializes SQLite, imports, prompts, or unlinks.
5. `trackingOnly` and `historyOnly` route only to their selected domain.
6. `deleteOld` with declined confirmation preserves all files; force skips the prompt but still
   requires successful import; partial migration deletes only proven files.
7. Database/import failure closes resources, returns or throws a truthful failure, and preserves all
   relevant legacy files.

## Gotchas and Edge Cases

- `migrateTrackingFiles()` currently contains a TODO in its non-dry-run branch and increments
  `operations`/`sources` without calling the existing migration helper. The summary is therefore a
  false success signal.
- `executeMigrate()` builds the deletion list from every discovered file, not successfully migrated
  files. Combined with the TODO, `--delete-old --force` is a direct data-loss path.
- Tracking files are currently grouped only by `hash`; different input files with identical options
  can overwrite one another in the group map.
- Custom `historyPath` is used by discovery, but actual import calls `migrateLegacyHistory(db)`,
  whose implementation always reads `getHistoryDir()`. Preview and execution can target different
  directories.
- Migration exceptions are not guarded by a `finally`, so the database may not close on a thrown
  discovery/import error. The returned `errors` array currently captures deletion failures only.
- Verify action suites mock the shared tier verifier. That is appropriate for action orchestration;
  actual size/hash algorithms belong in `tiered-verification.test.ts`. Do not duplicate them here.
- Both verify suites default `pathExists` to true, which explains why explicit missing-artifact
  action coverage is still absent despite broad conflict coverage.
- Sync's inventory represents one destination per source file even for ranged output. Tests should
  preserve this established model rather than inventing a per-artifact ledger.
- “Removed source” and “downgraded rating” are separate diff concepts. Only the latter has an
  explicit destination deletion workflow today; tests should not silently redefine source-removal
  policy.
- Avoid assertions on decorative log text, spinner/progress calls, private helper call counts, every
  numeric range member, or every rating scale spelling unless they change an external outcome.

## Success Criteria

- The four named action areas have focused tests, with no requirement to manufacture a separate
  test file when existing suites already own the action.
- Tests fail on false completeness, unsafe repair, false sync success, or deletion before proven
  migration.
- Missing, mismatch, and extra verification outcomes are each proven at the action boundary; the
  existing conflict matrix remains green.
- Sync proves both diff behavior and the write/hash/persist ordering in database and legacy routing.
- Manual migration proves database contents, not just counters, and cleanup is restricted to proven
  imports.
- Dry-run is mutation-free across sync, verify fixes, and migration.
- Partial failures are aggregated and recoverable; successful independent work can continue.
- Focused suites meet or improve the issue's 80%+ target for the touched action modules, while
  assertions remain contract-oriented and avoid filler permutations.

## Relevant Files

- `packages/rfmedia-cli/src/actions/verify-album.ts` — ranged album expected-set traversal, drift
  aggregation, conflict authorization, staged repair, and post-repair recheck.
- `packages/rfmedia-cli/src/actions/verify-album.test.ts` — existing conflict and tier orchestration
  suite; extend only for missing-artifact behavior.
- `packages/rfmedia-cli/src/actions/verify-filter.ts` — rating/metadata selection and destination
  mapping across filter layouts, plus repair.
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts` — existing filter conflict/layout/tier
  suite; extend with targeted missing-artifact scenarios.
- `packages/rfmedia-cli/src/actions/sync.ts` — diff orchestration, destination writes, hash/inventory
  ordering, downgrade cleanup, operation finalization, and scanning.
- `packages/rfmedia-cli/src/actions/sync.test.ts` — narrow later suite covering fingerprint
  persistence ordering only.
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts` — manual discovery, migration summaries,
  cleanup, and the critical count-only tracking migration gap.
- `packages/rfmedia-cli/src/lib/completed-tracker.ts` — existing automatic tracking-sidecar migration
  logic and reusable semantic reference.
- `packages/rfmedia-cli/src/lib/history.ts` — legacy history import and default-directory behavior.
- `packages/rfmedia-cli/src/lib/inventory.ts` — authoritative sync diff and inventory contracts.
- `packages/rfmedia-cli/src/lib/tiered-verification.ts` — authoritative verification evidence and
  outcome semantics; action tests should mock this boundary.

## Relevant Documentation

- `packages/rfmedia-cli/docs/features/verify-command.doc.md`
- `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`
- `packages/rfmedia-cli/docs/features/sync-command.doc.md`
- `packages/rfmedia-cli/docs/features/tracking-system.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- `packages/rfmedia-cli/docs/features/undo-history-system.md`
- `packages/rfmedia-cli/docs/features/conflict-resolution.md`
