# Issue #56 Action Tests: Implementation Context

## Executive Summary

Issue [#56](https://github.com/yandy-r/rfmedia-apps/issues/56) should ship as focused action-contract
coverage plus the smallest production fixes needed to make those tests truthful. Extend the mature
album/filter verify suites, expand the narrow sync suite, and add the missing migration action
suite. Preserve existing conflict and fingerprint tests; do not build a new test framework or
duplicate lower-level tier/diff algorithms.

The accepted behavior is stricter than the original tests-only wording because current action code
contains data-correctness defects that the required scenarios expose:

- an inventory-classified sync update can be skipped when its destination already exists;
- downgrade cleanup trusts an inventory destination path without containment proof;
- manual tracking migration reports counts without persisting rows;
- tracking sidecars are grouped by options hash without input identity;
- explicit history discovery can import from another directory;
- migration cleanup includes discovered rather than durably proven files;
- migration database cleanup is not exception-safe.

The implementation must preserve observation-based verification truth, the sync sequence
`materialize -> hash -> persist -> count`, and migration sequence
`validate -> import transaction -> read-back proof -> optional unlink`. No new command, option,
database schema, dependency, MCP shape, JSON result shape, or shell-completion entry is required.
Focused V8 coverage must reach at least 80% statements and lines for each of the four action files
through distinct behavioral partitions, not filler.

## Architecture Context

### Layer ownership

```text
Commander / MCP translation
  -> exported action orchestration
     -> library-owned filesystem, verification, inventory, and persistence
        -> structured result and durable state
```

- `commands/verify.ts`, `commands/sync.ts`, `commands/migrate.ts`, and `mcp/adapters.ts` translate
  input and exit/output behavior. Their surfaces remain unchanged.
- Exported action functions are the action-test seams:
  `executeAlbumVerify*()`, `executeFilterVerify*()`, `executeSyncWithFileInput()`, and
  `executeMigrate()`.
- `tiered-verification.ts` owns evidence classification; action tests inject outcomes.
- `inventory.ts` owns diff computation and SQLite/JSONL routing; sync action tests inject compact
  diffs and assert application/persistence.
- `completed-tracker.ts` and `history.ts` must remain the single owners of legacy format parsing and
  durable import. `migrate-tracking.ts` orchestrates discovery, proof, prompting, and cleanup.
- `filesystem.ts` owns safe copy/staging/removal primitives. Tests use real isolated files only when
  containment or persistence is the property; destructive action calls otherwise stay mocked.

### Verify flows

Album verification expands source albums over the selected range, verifies every expected
destination, discovers extras, optionally repairs through validated staging, and re-verifies the
full set. The batch entry chooses range precedence `CLI > per-path > config`, registers
`verify-album-abort`, opens read-only evidence once for non-quick tiers, and closes/unregisters in
`finally`.

Filter verification first determines rating/metadata eligibility, then allocates exact flat,
preserve-structure, album, range, collision, and conversion destinations. Only eligible files enter
the expected set. Its non-quick evidence loader reads candidates and closes the database
immediately; the batch entry owns abort registration/unregistration. Repair must use the
precomputed source/destination mapping and final re-observation.

For both actions, attempted mutation is not terminal truth. A missing/mismatched file becomes
repaired only when the selected verification tier passes after staging/publication. Failed or
unverifiable rechecks remain in issues and `remainingIssues`. Existing skip/overwrite, keep/remove,
force, trash, ask/apply-all, dry-run, rename-refusal, and tier cases remain authoritative.

### Sync flow

`executeSyncWithFileInput()` chooses CLI entries or input file, resolves SQLite versus legacy
inventory, optionally resets/loads inventory, registers abort/partial-file/database cleanup, and
applies an album or filter diff per source. Each successful file must materialize final bytes, hash
the represented first range destination, append one inventory record, and only then increment the
new/updated counter. Missing sources and per-file failures are contained so later sources run.

Preserve classification into the write decision. An `updated` item is authorized to replace its
represented existing destination; a `new` collision still follows existing force policy. Do not
set global `force` or change the one-inventory-row-per-source model.

Filter downgrade deletion consumes a persisted `destPath`, which must be treated as an untrusted
claim. Before non-recursive deletion, prove component-aware canonical containment under the
selected destination and reject traversal, absolute outside-root paths, symlinked parents,
directories, and special files. `force` never weakens containment.

Normal finalization unregisters cleanup callbacks, writes operation counts/status while the
database is open, then closes exactly once. Captured `sync-partial-files` callbacks must prove that
in-progress destinations are cleaned after interruption. A media scan is best-effort and permitted
only after a real non-dry-run new/updated success.

### Migration flow

The target migration flow is:

```text
capture and resolve roots
  -> initialize writable DB unless dry-run
  -> discover and fully validate candidates
  -> group tracking by (input identity, options hash)
  -> import through library owner in an operation/session transaction
  -> read back durable equivalence
  -> mark individual files imported/already-equivalent/failed
  -> confirm proof-filtered cleanup unless force
  -> revalidate contained regular-file identity and unlink eligible files
  -> aggregate counts/errors
  -> close DB exactly once in finally
```

Discovery and parsed line counts are preview data, never proof. Reuse/consolidate the current
private tracking importer instead of adding parsing/SQL to the action. History import must accept
the same resolved directory used by discovery and validate a complete JSONL session before
mutation; malformed or non-equivalent existing sessions remain deletion-ineligible. Keep proof
details internal where possible and retain the existing `MigrateResult` public shape.

Dry-run may discover and report prospective counts but must not initialize SQLite, import, prompt,
unlink, copy, persist inventory, or scan. `force` bypasses only confirmation, never proof,
containment, identity, or validation.

## Critical Files Reference

| File                                                              | Role and required change                                                                                                   | Recommended owner                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/rfmedia-cli/src/actions/verify-album.test.ts`           | Add dense missing detection, successful/failed repair recheck, and only needed batch lifecycle coverage                    | Verify-album task                                         |
| `packages/rfmedia-cli/src/actions/verify-filter.test.ts`          | Add eligible-missing truth, exact flat/structured repair mapping, failed recheck, and only needed batch lifecycle coverage | Verify-filter task                                        |
| `packages/rfmedia-cli/src/actions/sync.ts`                        | Carry new/updated classification into materialization; enforce safe downgrade target; retain lifecycle/order               | Sync task                                                 |
| `packages/rfmedia-cli/src/actions/sync.test.ts`                   | Add classification, continuation, downgrade containment/policy, DB/legacy lifecycle, cleanup callback, and scan gating     | Sync task                                                 |
| `packages/rfmedia-cli/src/lib/completed-tracker.ts`               | Make one tracking importer reusable and return durable per-file/group proof                                                | Migration-library task                                    |
| `packages/rfmedia-cli/src/lib/completed-tracker.test.ts`          | Prove separate same-hash inputs, completed/failed row equivalence, transaction failure, and already-equivalent behavior    | Migration-library task                                    |
| `packages/rfmedia-cli/src/lib/history.ts`                         | Accept resolved history directory; validate/import complete sessions atomically; return proof                              | Migration-library task                                    |
| `packages/rfmedia-cli/src/lib/history.test.ts` (new if needed)    | Prove custom path, atomic valid session, malformed retention, and equivalence conflict                                     | Migration-library task                                    |
| `packages/rfmedia-cli/src/actions/migrate-tracking.ts`            | Use shared importers, input-aware grouping, proof-gated cleanup, root/leaf validation, and `try/finally` close             | Migration-action task after library task                  |
| `packages/rfmedia-cli/src/actions/migrate-tracking.test.ts` (new) | Prove dry-run, routing, proof consumption, confirmation/force, selective cleanup, unlink failures, and close-on-error      | Migration-action task                                     |
| `packages/rfmedia-cli/src/lib/filesystem.ts` and test             | Reuse existing safe primitives; change only if sync/migration needs a generally applicable contained-leaf helper           | Assign exclusively to the task that first proves the need |
| `packages/rfmedia-cli/src/types/results.ts`                       | Existing public results; avoid changes unless contained migration errors cannot be represented                             | Migration-action task only if evidence requires           |
| `packages/rfmedia-cli/README.md`                                  | Document durable migration, per-file cleanup proof, force semantics, and explicit history path after behavior changes      | Documentation task                                        |
| `packages/rfmedia-cli/docs/features/undo-history-system.md`       | Clarify explicit versus automatic migration and custom-directory behavior                                                  | Documentation task                                        |
| `ROADMAP.md`                                                      | Remove all three live #56 entries and record shipped completion consistently                                               | Documentation/closeout task                               |

Audit but do not modify `commands/*`, `mcp/*`, `schema.sql`, package manifests, Vitest global
configuration, or Bash/Zsh/Fish templates unless a focused regression proves a surface defect.

## Patterns to Follow

### Test boundaries

- Drive exported actions; never export same-file helpers or mock the action under test.
- Use `vi.hoisted()` state for ESM factories. Prefer `clearAllMocks()` plus explicit default
  restoration; `resetAllMocks()` erases implementations and causes order-dependent failures.
- Use `importOriginal` for partial built-in mocks so real `mkdtemp`, `mkdir`, and `rm` remain
  available.
- Keep `processInParallel()` deterministic with the existing sequential mock and `workers: 1`.
- Assert typed results/durable state first, prohibited mutations and semantic ordering second, and
  log text only when notification is the contract.
- Use path-sensitive `pathExists` mocks. It serves source roots, destination files, inventories, and
  history directories; an unconditional boolean can test the wrong branch.

### Fixture strategy

- Extend each verify suite locally; their similar mock declarations hide different layout and
  evidence ownership, so a shared harness is not justified.
- Add small local sync builders such as `emptyDiff()` and mode-specific options; do not introduce a
  scenario DSL.
- Use a hoisted virtual legacy-file map for migration action discovery/read/unlink failures. Never
  glob the real worktree or use the real home history/database.
- Use unique temporary roots and a temporary SQLite database in library tests where durable
  equivalence, transactions, containment, symlink behavior, or actual bytes are the assertion.
- Restore cwd, environment, loaded config, logger/JSON mode, prompt mode, signal state, timers, and
  spies in `finally`/`afterEach`.

### Behavioral patterns

- **Observe -> authorize -> stage -> validate -> publish -> observe** for verification repair.
- **Classify -> materialize -> hash -> persist -> count** for sync.
- **Discover -> validate -> transact -> read back -> authorize cleanup -> unlink** for migration.
- Continue independent work for per-file/per-source failures and retain stable path, destination,
  message, and optional errno code.
- Reject action-wide invalid configuration/setup after releasing acquired resources; do not convert
  an unknowable migration into a success-shaped zero result.

## Cross-Cutting Concerns

### Data protection and path safety

- Legacy sidecars/history are the only recoverable state until durable equivalence is proven.
- Cleanup eligibility is explicit per file or atomic pair, not derived from aggregate counts.
- Group tracking identity by normalized/captured root plus input identity and options hash; reject
  duplicate members rather than last-write-wins.
- Bind discovery, import, and cleanup to one captured canonical root; disable symlink traversal and
  revalidate the same regular file immediately before non-recursive unlink.
- Treat inventory destinations as untrusted. Use component-aware containment, not string prefix
  checks, and preserve outside-root sentinel files in tests.
- Do not broaden issue #56 to verify-extra race hardening unless a required regression demonstrates
  it; shared staging already owns repair safety.

### Resource lifecycle and failure truth

- The function that successfully opens a database closes it exactly once. Migration needs an outer
  `try/finally`; verify/sync existing patterns must remain intact.
- Verification fix counters derive from final recheck, sync counts from completed persistence, and
  migration counts from committed/equivalent records.
- Preserve primary failures when cleanup also fails. Use contained structured cleanup errors where
  the current result model supports them.
- Dry-run must prove the absence of every mutation class, not merely one copy/unlink call.

### Compatibility and documentation

- Preserve `VerifyCommandResult`, `SyncResult`, and `MigrateResult` externally.
- Preserve operation/session/inventory tables; schema version remains unchanged.
- Sync fixes apply automatically to both Commander and MCP because both use the same action.
- Update README/history docs only for corrected migration promises. Verify/sync docs already state
  the target behavior and should be audited unchanged.
- Audit Bash, Zsh, and Fish completion templates as byte-for-byte unchanged and run template parity.

### Coverage and delivery

- Measure statements and lines per action file with explicit focused includes. The four-file
  aggregate is not sufficient.
- Admit another test only for a distinct input partition, mutation policy, failure boundary, or
  lifecycle guarantee. Do not test decorative logs, every suffix/rating/codec, or private branches.
- Run focused suites, focused coverage, typecheck, full rfmedia suite, markdown lint, the real
  repository hooks, and registered CI under Node 22 via `mise exec`.

## Parallelization Opportunities

Use dependency-aware waves and exclusive file ownership. Workers must not edit another task's
files or create shared helpers without coordination.

### Wave 1 — independent verification and sync work

| Task                            | Exclusive ownership                                                                               | Deliverable                                                                                                                                    | Dependencies                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| A. Album verification           | `verify-album.test.ts` only                                                                       | Missing no-fix/fix/failed-recheck truth; batch resource case only if needed for behavioral coverage                                            | Existing harness                   |
| B. Filter verification          | `verify-filter.test.ts` only                                                                      | Eligible missing mapping, flat plus one structured/ranged case, failed recheck; batch case only if needed                                      | Existing harness                   |
| C. Sync contract/fix            | `sync.ts`, `sync.test.ts`; filesystem helper files only if explicitly assigned                    | Updated-existing replacement, truthful counters/order, continuation, safe downgrade cleanup, DB/legacy lifecycle, partial cleanup, scan gating | Existing inventory/filesystem APIs |
| D. Migration library foundation | `completed-tracker.ts`, `completed-tracker.test.ts`, `history.ts`, optional new `history.test.ts` | Transactional tracking/history import, input-safe identity, custom directory, proof result, real DB equivalence                                | Existing DB APIs/schema            |

Tasks A, B, C, and D have no overlapping primary files and can run concurrently. Task C must not
modify inventory diff algorithms; task D must not modify migration action orchestration.

### Wave 2 — migration action orchestration

| Task                | Exclusive ownership                                                                        | Deliverable                                                                                                                                     | Dependencies               |
| ------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| E. Migration action | `migrate-tracking.ts`, new `migrate-tracking.test.ts`; `types/results.ts` only if approved | Input-aware grouping, shared importer routing, proof-filtered confirmation/deletion, path revalidation, dry-run, partial errors, close-on-throw | Task D's stable proof APIs |

Task E starts after D to avoid mocking or coding against an unstable importer result. If D changes
the internal proof type, D owns that type in its library module; E consumes it rather than moving it
to a public result file without need.

### Wave 3 — integration, coverage, and closeout

| Task                      | Exclusive ownership                                           | Deliverable                                                                                   | Dependencies            |
| ------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------- |
| F. Integration/review     | Read-only review first; fixes dispatched to owning task files | Cross-action safety review, full focused suite, per-file coverage, typecheck/full suite/hooks | A-E complete            |
| G. Documentation/closeout | `README.md`, `undo-history-system.md`, `ROADMAP.md`, PR body  | Corrected migration docs, all #56 completion parity, completion audit/result evidence         | Final behavior from E/F |

Reassign fixes by file owner instead of letting the integration task edit across all files. The
documentation task must not start migration wording until the final proof/cleanup semantics are
settled.

## Implementation Constraints

- Runtime is Node 22.22.2/NodeNext ESM; repository imports retain `.js` suffixes.
- Use existing Vitest 4, V8 coverage, `fast-glob`, `better-sqlite3`, and built-in filesystem APIs.
  Add no dependency or generic fake filesystem.
- No new CLI/MCP option, configuration key, database table/column, schema version, or completion
  template.
- No test-only production exports. A newly exported library importer is allowed only as the single
  real production owner used by automatic and manual migration.
- Preserve automatic tracking/history migration compatibility; new directory parameters default to
  existing resolution.
- Preserve new-file collision behavior while fixing updated destinations. Preserve one inventory
  row for the first represented range destination.
- Preserve non-recursive, proof-gated cleanup. `force` affects confirmation only.
- Never let tests glob/unlink the worktree, read/write the user's home database/history, call real
  trash, or contact a live media server.
- Prefer structured `MigrateResult.errors` for contained per-file failures. Action-wide setup/import
  failure may reject after close; pick one stable contract and test it consistently.
- If already-present operations/sessions can be deletion-eligible, require full row equivalence;
  existence by ID alone is insufficient.
- Do not silently broaden removed-source sync policy; issue #56 covers downgraded deletion and
  updated destination correctness.

## Key Recommendations

1. Land A-D in parallel, stabilize the migration proof API, then implement E. Keep ownership
   exclusive and dispatch review fixes back to owners.
2. Make verification additions small: one dense detection scenario, one successful repair, and one
   failed repair/recheck per action family. Retain all existing conflict coverage.
3. Make the sync update fix classification-aware; never use global force. Add containment tests for
   downgrade destinations and prove the captured partial-file cleanup callback.
4. Consolidate tracking import in `completed-tracker.ts`, forward one resolved history root, and
   make whole operation/session import atomic or equivalence-proven.
5. Build migration deletion candidates only from `imported` or fully `already-equivalent` proof.
   Keep malformed, ambiguous, failed, and partially imported files.
6. Use virtual action fixtures for deterministic destructive failures and real temporary SQLite /
   filesystem fixtures only for persistence, containment, and transaction proof.
7. Treat 80% statements/lines per named action as a measured constraint after behavioral tests.
   Reject filler and a global Vitest threshold.
8. Complete through full Node 22 verification, real hooks, registered CI, required PR template with
   `Closes #56`, issue closure, all ROADMAP references, and explicit no-change completion audit.

Open decisions should be resolved before Task D/E APIs solidify: the stored command for legacy
operations, whether a completed/failed pair is cleanup-atomic, equivalence rules for pre-existing
sessions, and whether malformed import failures expand `MigrateResult.errors`. Default each
uncertainty toward retaining legacy files and reporting incomplete migration.
