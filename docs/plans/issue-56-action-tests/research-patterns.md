# Pattern Research: Issue 56 Critical Action Tests

## Architectural Patterns

### Test through exported action seams

The four in-scope behaviors already have public orchestration boundaries:

- `packages/rfmedia-cli/src/actions/verify-album.ts:executeAlbumVerify()` and
  `executeAlbumVerifyWithFileInput()`;
- `packages/rfmedia-cli/src/actions/verify-filter.ts:executeFilterVerify()` and
  `executeFilterVerifyWithFileInput()`;
- `packages/rfmedia-cli/src/actions/sync.ts:executeSyncWithFileInput()`;
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts:executeMigrate()`.

Exercise those exports and control their imported dependencies. Do not export or directly test
same-file helpers such as `fixAlbumCopy()`, `fixFilteredTracks()`, `syncFile()`,
`migrateTrackingFiles()`, or `deleteLegacyFiles()` merely to raise coverage. Vitest cannot replace a
same-module call by mocking an exported alias, and the helpers are implementation details. The
stable action contract is the returned `VerifyCommandResult`, `SyncResult`, or `MigrateResult` plus
observable filesystem/database effects.

This preserves the repository's layer ownership:

```text
command / adapter
  -> exported action orchestration
  -> library-owned filesystem, verification, inventory, and persistence seams
  -> structured result and durable state
```

**Confidence**: High. Every target action already exposes an orchestration entry point and existing
tests use it.

### Treat verification as observe, authorize, repair, observe

Both verification actions already separate expected-artifact discovery from repair. Preserve this
state transition:

```text
derive expected path
  -> verify selected tier
  -> classify missing/mismatch/extra
  -> authorize repair when needed
  -> materialize into a stage
  -> verify staged artifact
  -> publish destination
  -> verify final destination
  -> derive terminal counts
```

The reference implementation is
`packages/rfmedia-cli/src/actions/verify-album.ts:repairContentArtifact()`. It uses
`replaceFileWithValidatedStage()` or `convertFileWithValidation()`, validates an authoritative open
file target with `verifyFileByTier()`, and performs a final verification after publication.
`verify-filter.ts:fixFilteredTracks()` has the equivalent staged-validation seam.

Tests must distinguish three outcomes:

1. missing and not fixed: unresolved;
2. repair staged and final verification returns `present`: repaired;
3. materialization, staged validation, or final validation fails: contained in `failedFixes` and
   still unresolved.

Assert `repairedFiles`, `reverifiedFiles`, `refusedFiles`, and `remainingIssues`, not only that
`copyOrLink()` was called. A successful mock write is not proof of a repaired artifact.

**Confidence**: High. These counters and failure fields are explicit in
`packages/rfmedia-cli/src/types/results.ts:FixResult`.

### Carry sync classification into the write decision

`packages/rfmedia-cli/src/actions/sync.ts` computes a `SyncDiff`, then combines `newFiles` and
`updatedFiles` before calling `syncFile()`. The current generic existence guard inside `syncFile()`
can skip both classes when `force` is false. The fix should carry explicit updated-entry intent to
the materialization decision; it should not set global `force` or weaken collision policy for new
files.

A small parameter or local work-item shape is consistent with the codebase's functional style:

```ts
type SyncWorkItem = {
  filePath: string;
  classification: "new" | "updated";
};
```

The exact type may remain module-local. The important invariant is that an inventory-classified
update replaces its represented destination, while an unrelated new-file collision still follows
the existing force policy.

Keep the established one-inventory-row-per-source model for ranged output. The first represented
destination is hashed and recorded; issue 56 does not introduce an artifact ledger.

**Confidence**: High. The diff classification and generic destination skip are directly visible in
the current action.

### Preserve materialize, hash, persist, count ordering

The successful sync path is action-owned and must remain:

```text
materialize final destination
  -> calculateHash(final destination)
  -> createFileInventoryEntry(..., contentHash)
  -> appendFileRecord(...)
  -> increment new/updated success count
```

`packages/rfmedia-cli/src/actions/sync.test.ts` already uses a semantic `events` array to prove
`materialize -> hash -> inventory`. Extend this pattern for classification and failures. If copy,
conversion, hashing, entry construction, or persistence fails, `syncFile()` returns a contained
`SyncFailedOperation`; the outer loop continues and must not increment success.

Do not move hashing into a mocked inventory helper or count a file before `appendFileRecord()`
returns. That would make a partial failure non-resumable while reporting success.

**Confidence**: High. Existing tests already pin hash and inventory failure behavior.

### Make migration return proof, not discovery

The current `executeMigrate()` flow treats discovered `legacyFiles` as deletion candidates, while
`migrateTrackingFiles()` only counts entries. Replace that count-only boundary with a reusable,
library-owned importer that returns enough proof to identify individually safe source files.

Persistence semantics belong beside the existing parsers and database writes:

- tracking sidecars:
  `packages/rfmedia-cli/src/lib/completed-tracker.ts:migrateLegacyTracking()`;
- history JSONL:
  `packages/rfmedia-cli/src/lib/history.ts:migrateLegacyHistory()`;
- orchestration, confirmation, summary, and cleanup:
  `packages/rfmedia-cli/src/actions/migrate-tracking.ts:executeMigrate()`.

The library result should distinguish imported, already equivalent, malformed/failed, and their
source paths. The action derives cleanup eligibility only from imported or already-equivalent
proof. It must not infer success from glob matches, parsed line counts, aggregate operation counts,
or absence of a thrown error.

Preserve operation identity as `(inputFile, optionsHash)`. Grouping only by hash merges different
input sidecars. Forward one resolved history directory to both discovery and import so the action
cannot inspect one root and migrate another.

**Confidence**: High. The current TODO, hash-only grouping, custom-path divergence, and broad
deletion list are concrete implementation gaps identified by the feature spec.

### Keep resource ownership exception-safe

The function that opens a database owns closing it. Follow the existing `try/finally` shape in
`executeSyncWithFileInput()`, `executeAlbumVerify()`, and `executeFilterVerify()`:

```ts
let db: DbConnection | undefined;
try {
  db = await initializeDatabase(dbPath);
  // orchestrate
} finally {
  if (db) closeDatabase(db);
}
```

Close once after success, contained partial failure, or thrown import/discovery error. Do not close
inside a library importer and again in the action. Dry-run must not initialize a database, so it has
nothing to close.

**Confidence**: High. This matches existing action resource ownership.

## Code Conventions

- Use strict TypeScript ESM: `node:` imports for built-ins and `.js` suffixes for repository
  imports. Follow every current action test.
- Keep reusable persistence logic in `src/lib/`; keep CLI routing, prompts, summaries, and deletion
  coordination in `src/actions/`. Do not copy parsing/database SQL into `migrate-tracking.ts`.
- Prefer module-local functions and explicit parameters over a new service class. Existing action
  code is function-oriented, and issue 56 needs no framework.
- Reuse result types in `packages/rfmedia-cli/src/types/results.ts` and
  `packages/rfmedia-cli/src/types/inventory.ts`. Add narrowly typed migration proof only if existing
  `legacyFiles` cannot represent eligibility without ambiguity.
- Preserve stable failure fields: `path` or `sourcePath`, `destPath` when known, `message`, and
  optional errno `code`. Do not expose raw fingerprints or database internals in failures.
- Use `normalizePath()` at persistence identity boundaries and `path.resolve()`/`path.relative()`
  where the existing verification evidence API expects canonical or relative paths. Do not compare
  paths by basename alone.
- Keep option behavior compatible. No new CLI option, command, schema version, dependency, MCP
  surface, or shell-completion change is needed.
- Keep verification harnesses separate. Album expected-path ownership differs from filter
  rating/layout ownership, so a shared action-fixture abstraction would hide important differences.
- Reuse `packages/rfmedia-cli/src/test-utils/filesystem.ts` for temporary directory lifecycle and
  dummy files. Keep domain-specific hoisted mock bags in their test files.
- Use behavioral test names: “replaces an updated existing destination” or “retains an unproven
  sidecar after import failure.” Avoid generic names such as “handles errors.”

**Confidence**: High. These conventions are established in current rfmedia source and testing
guidance.

## Error Handling

### Contain independent work; reject action-wide setup failures

Verification and sync already collect per-file failures so later files/sources can continue. Keep
that shape:

- verification: `FailedOperation` in `VerifyCommandResult.failed` or `FixResult.failedFixes`;
- sync: `SyncFailedOperation` in `SyncResult.failed` with `failedFiles` incremented;
- migration deletion: `FailedOperation` in `MigrateResult.errors`, continuing safe sibling
  deletions.

Database initialization failure, invalid action-wide configuration, or an importer failure that
makes the migration result unknowable may reject after cleanup. Do not catch such an error merely to
emit a success-shaped result with zero counts.

### Fail closed at proof boundaries

- A missing verification source path is refused and remains unresolved.
- A staged artifact that does not return `present` is never published as repaired.
- A sync hash or inventory failure is not counted as copied.
- A malformed history file is not reported as a migrated session and is not deletion-eligible.
- A tracking/history import failure preserves its legacy file even if sibling imports succeed.
- `--force` skips cleanup confirmation only; it does not make an unproven file eligible.

### Preserve the primary error

Cleanup and close logic belongs in `finally` or best-effort follow-up. If database close or partial
file cleanup also fails, do not replace the import/materialization error that explains the unsafe
state. Record a distinct contained cleanup failure when the result model permits it.

### Keep terminal counts derived from outcomes

Do not increment counters when work starts. Update verification repair counts after re-verification,
sync counters after inventory persistence, and migration counts after durable import/equivalence.
For database-backed sync, update operation status and counts before closing, using the terminal
contained failures.

**Confidence**: High for per-file containment and fail-closed rules; Medium for the exact thrown
versus returned migration setup-error taxonomy because the feature spec deliberately permits either
for action-wide failures.

## Testing Approach

### Hoisted module boundaries

Follow `packages/rfmedia-cli/src/actions/verify-album.test.ts`,
`verify-filter.test.ts`, and `sync.test.ts`:

```ts
const mocks = vi.hoisted(() => ({
  pathExists: vi.fn(),
  copyOrLink: vi.fn(),
}));

vi.mock("../lib/filesystem.js", () => ({
  pathExists: mocks.pathExists,
  copyOrLink: mocks.copyOrLink,
}));
```

Use `vi.clearAllMocks()` for call history and explicitly re-establish defaults in `beforeEach`.
Use `vi.restoreAllMocks()` for spies such as `console.error`. Avoid routine `vi.resetAllMocks()`;
it erases hoisted implementations and creates test-order failures. Use `importOriginal` when only a
few `node:fs/promises` or library exports need replacement.

### Verification tests

Extend the current suites rather than create new files:

- set `pathExists` by candidate path so source/destination existence is readable;
- return one `missing` outcome and preserve the exact expected relative destination;
- make staged and final `verifyFileByTier()` responses explicit rather than depending on a long
  queue with undocumented call positions;
- assert final `issues`, counts, `fixResults`, and prohibited writes;
- retain the existing mismatch/extra conflict matrix instead of duplicating it for missing files.

One album range member and one representative filter layout edge are sufficient. Tier algorithms
remain covered by `packages/rfmedia-cli/src/lib/tiered-verification.test.ts`.

### Sync tests

Expand `packages/rfmedia-cli/src/actions/sync.test.ts` with a small diff builder and exact
classifications. Preserve its semantic event pattern. Critical partitions are:

- new, updated-existing, and unchanged in one readable scenario;
- missing source followed by a valid source;
- downgrade absent, delete success, and delete failure;
- legacy inventory versus database lifecycle;
- dry-run with no initialization, mutation, prompt, persistence, or scan;
- successful change versus unchanged/failed-only scan gating.

Assert returned counters and `failed[]` before collaborator calls. Do not mock `syncFile()`; it is
the same-file orchestration being tested.

### Migration tests

Create `packages/rfmedia-cli/src/actions/migrate-tracking.test.ts`. Use a hybrid fixture:

- real unique temporary roots and a temporary SQLite database where durable equivalence is the
  contract;
- mocked `fast-glob` or a narrowly controlled fixture root for discovery;
- partial `node:fs/promises` mocks for exact `readFile`, `readdir`, and `unlink` failures;
- mocked `confirm`, logger, and config/path resolution for deterministic non-interactive behavior.

Read rows back through public database APIs where available. Lower-level importer tests belong next
to `completed-tracker.test.ts` and history tests; the action suite should prove routing, proof
consumption, prompt behavior, cleanup eligibility, summaries, and close-on-error.

### Deterministic fixture rules

- Use `createTempTestDir()`/`cleanupTempDir()` and never the user's home, current tracking database,
  or repository-wide glob results.
- Do not call `process.chdir()`; inject or mock the discovery root.
- Set action workers to one unless concurrency is the behavior under test.
- Mock TTY detection, progress, prompts, media scans, and time-sensitive IDs.
- Use fixed paths, hashes, ratings, and JSONL records.
- Assert structured fields and stable message fragments, not colored/glyph-heavy full logs.
- Run focused files first, then full package tests to expose mock leakage.

**Confidence**: High. These patterns are already used by the relevant suites and shared utilities.

## Patterns to Follow

| Concern                      | Pattern to mirror                                          | Concrete source                                                            |
| ---------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Exported action testing      | Invoke the public action and mock imported boundaries      | `packages/rfmedia-cli/src/actions/sync.test.ts`                            |
| Hoisted ESM mocks            | `vi.hoisted()` bag referenced by top-level `vi.mock()`     | `packages/rfmedia-cli/src/actions/verify-album.test.ts`                    |
| Partial module mock          | `importOriginal` plus selected replacements                | `packages/rfmedia-cli/src/actions/verify-filter.test.ts`                   |
| Stable mock lifecycle        | `clearAllMocks`, reset defaults, restore spies             | `packages/rfmedia-cli/docs/testing/troubleshooting.md`                     |
| Isolated filesystem fixtures | Unique temp root and forced recursive cleanup              | `packages/rfmedia-cli/src/test-utils/filesystem.ts`                        |
| Staged repair                | Materialize, validate open stage, publish, final verify    | `packages/rfmedia-cli/src/actions/verify-album.ts:repairContentArtifact()` |
| Filter path preservation     | Carry issue `sourcePath` and computed relative destination | `packages/rfmedia-cli/src/actions/verify-filter.ts:fixFilteredTracks()`    |
| Per-file failure containment | Return structured failure and continue outer source loop   | `packages/rfmedia-cli/src/actions/sync.ts:syncFile()`                      |
| Persistence ordering         | Semantic `materialize`, `hash`, `inventory` events         | `packages/rfmedia-cli/src/actions/sync.test.ts`                            |
| Real database proof          | Temporary SQLite with public read-back                     | `packages/rfmedia-cli/src/lib/completed-tracker.test.ts`                   |
| History import ownership     | Parse and write legacy sessions in the library             | `packages/rfmedia-cli/src/lib/history.ts:migrateLegacyHistory()`           |
| Resource finalization        | Update terminal state, then close in `finally`             | `packages/rfmedia-cli/src/actions/sync.ts:executeSyncWithFileInput()`      |
| Best-effort deletion errors  | Continue and collect path/message/code                     | `packages/rfmedia-cli/src/actions/migrate-tracking.ts:deleteLegacyFiles()` |

**Confidence**: High.

## Anti-Patterns

- Do not export private helpers for test access or use `rewire`-style techniques.
- Do not add a generic fake filesystem dependency; real tiny fixtures plus narrow mocks are enough.
- Do not duplicate the verify conflict strategy/layout cross-product already covered.
- Do not assert only collaborator calls when a structured result or database read-back is the real
  contract.
- Do not reconstruct filter destinations from basenames during repair.
- Do not use global `force` to make updated sync entries overwrite; it changes new-collision policy.
- Do not increment sync success before hashing and inventory persistence finish.
- Do not treat discovered, parsed, or counted legacy files as migrated.
- Do not group tracking operations by options hash alone.
- Do not discover history from one directory and import from the default directory.
- Do not build cleanup targets from all discovered files or let `--force` bypass proof.
- Do not delete malformed, partially imported, or failed legacy artifacts.
- Do not initialize SQLite, mutate files, prompt, or trigger a scan in dry-run.
- Do not rely on test order, TTY state, wall time, home-directory contents, or a shared cwd.
- Do not chase 80% with decorative logger, spinner, every-range-member, every-codec, or private-branch
  assertions.

**Confidence**: High. Each anti-pattern either contradicts the feature spec or reproduces a current
documented defect.

## Validation

Use the pinned Node 22 runtime. Run focused behavioral tests before package-wide gates:

```bash
mise exec -- npm run test:run --workspace packages/rfmedia-cli -- \
  src/actions/verify-album.test.ts \
  src/actions/verify-filter.test.ts \
  src/actions/sync.test.ts \
  src/actions/migrate-tracking.test.ts

mise exec -- npm run test:coverage --workspace packages/rfmedia-cli -- \
  src/actions/verify-album.test.ts \
  src/actions/verify-filter.test.ts \
  src/actions/sync.test.ts \
  src/actions/migrate-tracking.test.ts

mise exec -- npm run typecheck --workspace packages/rfmedia-cli
mise exec -- npm run test:run --workspace packages/rfmedia-cli
```

Inspect statements and lines for each named action rather than relying on aggregate coverage. Add a
test only for an uncovered behavioral partition. No completion template test is required by a
surface change, but the repository's normal full gates should still demonstrate unchanged parity.

**Confidence**: High for commands and coverage intent; focused coverage output may need an explicit
`--coverage.include` during implementation if the default report omits unimported action files.
