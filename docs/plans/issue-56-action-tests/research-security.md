# Security Research: Issue 56 Action Tests

## Executive Summary

Issue 56 covers local filesystem actions, not a network security boundary. Its security value is
preventing the CLI from losing or misclassifying operator data when migration, verification, or
sync partially fails.

The current `migrate-tracking` implementation has release-blocking data-loss paths. Tracking
"migration" only increments counters, while `--delete-old` deletes every discovered sidecar. A
custom history path is discovered but the importer reads the default directory, and grouping by
options hash alone merges sidecars belonging to different inputs. Cleanup must remain disabled
until each individual legacy file has a durable, equivalent database result.

Sync also consumes `destPath` from a weakly validated inventory and passes it directly to a
recursive remove helper for rating downgrades. Tests must prove containment under the selected
destination. The broad verify conflict suites are useful, but their permissive filesystem mocks do
not prove real no-follow, staging, or deletion behavior. Use isolated temporary roots for path and
deletion contracts, and mock only database, prompt, logging, and failure-injection boundaries.

## Findings by Severity

### CRITICAL

| ID      | Finding                                                                      | Evidence and impact                                                                                                                                                                                                                                                                                                                               | Required mitigation and test                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-C01 | `--delete-old` can erase tracking state that was never migrated.             | `migrateTrackingFiles()` contains a TODO and only increments `operations` and `sources`; `executeMigrate()` then builds its deletion list from every discovered file. `--force` removes the confirmation but does not add any proof of persistence. Resumability state can be permanently lost while the command reports success.                 | Implement actual database inserts in a transaction keyed to the legacy operation. Track per-file outcomes and construct cleanup solely from files whose records were committed and read back successfully. Add an action test that inspects database rows before allowing `unlink`, plus failure tests proving zero deletion after read, insert, commit, or verification failure. **Confidence**: High.                                                                   |
| SEC-C02 | A custom history path can be deleted without being imported.                 | Discovery uses `options.historyPath`, but execution calls `migrateLegacyHistory(db)`, which always reads `getHistoryDir()`. Cleanup still uses the custom-path discovery list. The command can import unrelated/default history and delete the requested legacy files untouched.                                                                  | Pass the exact resolved history root through discovery and import, return per-file import results, and bind cleanup to those results. Test with different populated default and custom directories; assert only custom records are persisted and only proven custom files become deletion candidates. **Confidence**: High.                                                                                                                                               |
| SEC-C03 | Tracking identity collisions can discard one input's state.                  | `groupTrackingFilesByOperation()` keys only on `hash`. Two basenames with identical copy options overwrite each other's completed/failed member in the group, while cleanup retains and can delete all original files.                                                                                                                            | Use at least normalized discovery root plus `inputFile` basename plus options hash as identity. Reject duplicate members instead of last-write-wins. Test two input basenames with the same hash and verify distinct operations and complete row parity before cleanup. **Confidence**: High.                                                                                                                                                                             |
| SEC-C04 | Sync downgrade cleanup can delete outside the selected destination.          | Legacy JSONL inventory casts `record.file` without validating its fields. `computeFilterSyncDiff()` copies stored `destPath` into `downgradedFiles`, and `deleteDowngradedFiles()` passes it directly to the recursive `remove()` helper. A stale, corrupted, or edited inventory can therefore target an arbitrary path writable by the process. | Treat inventory paths as claims. Validate record shape, derive or validate the expected destination, require canonical component-aware containment beneath the selected destination, reject symlinks/special files, and unlink only an expected regular-file leaf. Add real-filesystem tests for `../`, absolute outside-root paths, symlinked parents, and a directory substituted for the expected file. `--force` must never bypass containment. **Confidence**: High. |
| SEC-C05 | Partially parsed history can be reported as migrated and then fully deleted. | Discovery counts every non-header line. The importer silently skips malformed operation lines, still counts the session as migrated, and cleanup selects the whole discovered JSONL file. Already-present session IDs are also skipped without proving row equivalence. Audit/undo entries can be lost.                                           | Validate the complete file before mutation, transact one session atomically, distinguish `imported`, `already-equivalent`, and `failed`, and retain any file with malformed or unverified entries. Test a valid header with one valid and one malformed operation, and an existing but non-equivalent database session; neither source file may be deleted. **Confidence**: High.                                                                                         |

### WARNING

| ID      | Finding                                                                              | Evidence and impact                                                                                                                                                                                                                                                                    | Required mitigation and test                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-W01 | Sync can classify an update, skip its existing destination, and leave stale bytes.   | `syncFile()` skips any existing destination unless `force` is set. That guard also applies to files placed in `updatedFiles`, so an updated-source contract can become a successful no-op.                                                                                             | Carry the diff reason into materialization. An authorized update must atomically replace and re-hash the represented destination; an unchanged file must not enter this path. Test updated/existing, missing-destination, unchanged, and overwrite-failure cases against observable bytes and inventory rows, not only counters. **Confidence**: High.                                                                 |
| SEC-W02 | Migration discovery has an unnecessarily broad deletion scope.                       | Tracking discovery recursively searches `process.cwd()` for matching names. No explicit migration root, canonical containment check, or symlink policy is bound to later `unlink` calls. An operator can capture unrelated nested sidecars, especially from a broad working directory. | Accept or derive an explicit root, canonicalize it once, set glob traversal to avoid symbolic links, and present exact candidates before confirmation. Revalidate each candidate as the same regular file immediately before unlink. Test nested unrelated roots and symlink traversal. **Confidence**: High.                                                                                                          |
| SEC-W03 | Verify extra-file removal is pathname-based and can race with directory replacement. | Extra names originate from `readdir`, but later `remove()` is recursive. A file can be replaced by a directory or redirected through a changed parent between scan and mutation. Repair writes use validated staging, but extra removal does not receive equivalent identity controls. | Bind the destination root and parent identity, `lstat` the exact leaf, reject symlinks/directories/special files, and use non-recursive unlink for an expected regular file. Prefer trash by default where product behavior permits. Add a test that substitutes a directory after discovery and proves refusal. **Confidence**: Medium; exploitation requires concurrent or independently writable destination state. |
| SEC-W04 | Migration exceptions can leave the SQLite connection open.                           | `executeMigrate()` closes the database only on its normal path. Discovery, parsing, import, prompt, or deletion exceptions bypass `closeDatabase()`, potentially retaining locks and complicating safe retry.                                                                          | Put closure in `finally`; preserve the original error and keep all unproven files. Test an import rejection and a prompt/deletion rejection, asserting exactly one close and no unauthorized unlink. **Confidence**: High.                                                                                                                                                                                             |
| SEC-W05 | Full-file reads permit avoidable memory and runtime exhaustion.                      | Tracking and history discovery use `readFile()` and split entire files. Recursive discovery may process many large matching files before the operator can assess the candidate set.                                                                                                    | Stream and bound line length, file count, and total bytes; reject oversized inputs as retained failures. Tests should use small configured limits rather than large fixtures. **Confidence**: High.                                                                                                                                                                                                                    |

### ADVISORY

| ID      | Finding                                                                               | Evidence and impact                                                                                                                                                                                                                                                                                | Recommended mitigation and test                                                                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-A01 | Existing verify mocks can create false confidence in destructive and staged behavior. | Both verify suites default `pathExists()` to true and replace the real validated-stage helper with a callback shim. This is appropriate for orchestration but masks missing artifacts and does not exercise private staging, no-follow checks, parent permissions, atomic publication, or cleanup. | Keep focused mocked action tests for decision routing, but add only the missing action-boundary cases and rely on real filesystem contract tests for the shared helper. Explicitly program each path's existence; never use an unconditional true default in missing/deletion tests. **Confidence**: High. |
| SEC-A02 | Global test state can leak across cases.                                              | These actions depend on `process.cwd()`, loaded config, logger mode, interactive mode, signal cleanup registration, and module-level mocks. `vi.clearAllMocks()` clears calls but retains implementations.                                                                                         | Give every test a unique `mkdtemp()` root; save/restore cwd and environment in `finally`; reset implementations explicitly; close real databases; unregister signal handlers; and use serial execution only for tests that intentionally mutate process-global state. **Confidence**: High.                |
| SEC-A03 | No new dependency is needed for issue 56.                                             | Node filesystem/temp APIs, existing Vitest, `better-sqlite3`, and existing `fast-glob` cover the required tests. Adding a virtual filesystem would reduce fidelity for rename, permission, symlink, and SQLite behavior.                                                                           | Use built-ins and the pinned toolchain. Run the repository's normal dependency audit separately; do not bury unrelated dependency upgrades in the action-test change. **Confidence**: High.                                                                                                                |

## Authentication and Authorization

N/A for application authentication. The actions are local-only and inherit the invoking process's
operating-system permissions. Those permissions are the authorization boundary: tests must prove
that `--force` bypasses only a confirmation or conflict choice, never destination containment,
file-type checks, migration proof, or source preservation. Running the CLI as root materially
widens every deletion consequence and should not be required.

## Data Protection

- Treat tracking sidecars and history JSONL as the only recoverable copy until database equivalence
  is proven. Discovery and counts are not evidence of migration.
- Commit database records before cleanup, then query the committed operation/session and compare
  completed, failed, and history-operation counts and identities.
- Preserve malformed, partially imported, ambiguous, and non-equivalent files. Cleanup should be
  per file, not all-or-nothing by command success.
- Avoid logging full legacy contents. Paths already reveal library structure; error output should
  sanitize control characters and remain bounded.
- For sync overwrite, materialize to a private same-directory stage, verify/hash it, then publish
  atomically. The previous destination must survive every pre-commit failure.

## Dependency Security

| Boundary             | Security posture                                                         | Recommendation                                                                                              |
| -------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Node filesystem APIs | Necessary to prove actual path, rename, permission, and unlink semantics | Use real per-test temporary roots for destructive contracts; mock only selected failure injection           |
| `better-sqlite3`     | Existing native persistence boundary                                     | Use a real temporary database for migration equivalence and transaction tests; close in `finally`           |
| `fast-glob`          | Existing recursive discovery boundary                                    | Set an explicit root and no-symlink traversal; test candidate scope rather than mocking returned paths only |
| Vitest module mocks  | Useful for prompts, logging, adapters, and deterministic failures        | Do not mock away the security property being asserted; reset implementations as well as call history        |

No additional package is justified. Dependency vulnerability remediation should follow the normal
lockfile/audit workflow and remain separate unless a current advisory directly blocks these tests.

## Input Validation

- Validate tracking filenames into `{input identity, type, supported options hash}`; reject empty,
  ambiguous, duplicate, or unsupported components.
- Validate every tracking line as a non-empty path according to the legacy format. Do not convert a
  read failure to a trustworthy zero-entry result.
- Validate history headers and every operation field before opening a transaction. `_header` being
  truthy is insufficient.
- Validate JSONL inventory file records field by field, including finite timestamps/sizes,
  normalized relative paths, rating range, digest format, and destination containment.
- Canonicalize roots with path-component-aware checks. String prefix tests are insufficient.
- Reject symlinks and non-regular files at destructive leaf operations; revalidate immediately
  before mutation.

## Infrastructure and Test Isolation

1. Create a unique temporary source, destination, history, tracking, and database root per test.
2. Never discover from the repository or the host's real history directory in a test.
3. Seed sentinel files both inside and outside the authorized root and assert their bytes survive
   every failure and dry-run scenario.
4. Restore cwd, environment, loaded config, logger/JSON mode, prompt mode, fake timers, and spies in
   `afterEach`/`finally`, even when the action throws.
5. Use real files for containment, symlink, atomic replacement, and deletion tests. Use mocks for
   prompt decisions, logging, media scans, and injected database/filesystem failures.
6. Assert absence of mutation, not merely absence of one mocked call: no database rows, unlinks,
   destination changes, inventory appends, scans, or leaked stage files in dry-run/failure cases.
7. Avoid parallel execution for cases that change cwd or process-global configuration. Other
   temporary-root tests may run concurrently.

## Secure Coding Guidelines

1. Make destructive eligibility an explicit result of successful migration or validated diff, not
   an inference from discovery.
2. Preserve ordering: validate input, transact/import, read back equivalence, then optionally unlink.
3. Never let `force` weaken containment, file identity, transaction, or verification rules.
4. Use exact operation identity; never merge records by options hash alone.
5. Use non-recursive deletion for expected files and identity-bound staged replacement for writes.
6. Fail closed on malformed persisted state while preserving the original artifact for recovery.
7. Close databases, handles, and registered cleanup hooks in `finally`.
8. Report persisted outcomes, not attempted work or discovered line counts.

## Security Trade-offs

| Decision              | Recommended default                                     | Trade-off                                                                             |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Cleanup gating        | Delete only individually proven, equivalent files       | More bookkeeping; prevents irreversible partial migration                             |
| Malformed legacy data | Retain and report exact file/line                       | Requires operator repair; preserves recoverability                                    |
| Filesystem realism    | Real temp roots for path/destructive contracts          | Slightly slower than full mocks; materially higher confidence                         |
| Symlink handling      | Reject for destructive leaves and traversal             | May reject intentional layouts; an explicit trusted-root policy can be designed later |
| Overwrite behavior    | Private staged write plus validation and atomic publish | Additional I/O and cleanup; old content remains recoverable on failure                |
| Dependency scope      | No new packages or opportunistic upgrades               | Audit remediation may require a separate change                                       |

## Open Questions

1. What exact legacy tracking metadata is sufficient to reconstruct the original database operation
   beyond basename and options hash?
2. Should `--history-path` be a directory only, and should it replace or supplement the configured
   default history directory? The security requirement is that discovery, import, and cleanup use
   one explicit interpretation.
3. Should successfully migrated legacy files be deleted permanently, moved to trash, or retained
   with a migrated suffix for a recovery window?
4. Is a symlinked destination root supported? If yes, resolve that root once and bind all child
   operations beneath it; do not follow per-entry links.
5. Should sync downgrade removal require confirmation/trash in addition to the existing
   `deleteDowngraded` option, or is strict inventory validation and containment sufficient?
