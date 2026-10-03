# Feature Specification: Metadata Drift Detection and Reconciliation

- **Issue:** #125
- **Command:** `rfmedia reconcile scan|apply`
- **Status:** Approved for implementation
- **Release boundary:** Three-way report with explicitly authorized, capability-bounded repair

## Executive Summary

Issue #125 adds a top-level reconciliation workflow for metadata that can diverge between embedded
audio tags, rfmedia's SQLite inventory, and a current media-server track snapshot. The command joins
all three evidence planes by exact normalized file path, reports missing values, conflicting values,
stale inventory, ambiguous evidence, unsupported repairs, and in-sync records, and emits equivalent
human, JSON, YAML, and CSV results. It is distinct from the existing two-way, rating-only
`rfmedia plex sync` workflow and the artist-identity-only `rfmedia lidarr reconcile` report.

`rfmedia reconcile scan <source-path>` is strictly observational and opens only an existing,
immutable SQLite snapshot. `rfmedia reconcile apply <source-path>` requires exactly one of
`--file-wins`, `--db-wins`, or `--server-wins`, reruns the same scan, and produces a preview by
default; mutation requires both `--execute` and interactive approval or `--yes`. A winner flag
selects rating authority but never grants write authority. Apply fails closed when the rating
authority or identity is missing, invalid, ambiguous, or unsupported unless the operator explicitly
adds `--allow-partial`, and it reports target outcomes independently because file, SQLite, and
provider writes cannot share one transaction.

The read contract covers normalized rating, primary artist, first genre, and release year. The
current public write boundaries support normalized rating across all three planes but do not
provide symmetric non-rating repair. V1 apply therefore requests rating repair only, plus refresh
of one uniquely selected inventory row's changed stat evidence when the destination still exists.
Non-rating drift remains separately counted observation data and is never planned as an implicit
SQLite-only mutation. Expanding generic audio-tag and media-server metadata writers is a separate
compatibility and provider-contract change, not an implicit private Plex call in this feature.

## Scope and Non-Goals

### In scope

- A new top-level `rfmedia reconcile` namespace with `scan` and `apply` leaves.
- Exact-path joining of local audio files, SQLite inventory rows, and provider-neutral server
  tracks within one explicit source root and media library.
- Optional `--operation-id` to select one inventory generation when historical rows are otherwise
  ambiguous.
- Comparable fields: `rating`, `artist`, `genre`, and `year`.
- Stable categories for missing file tags or values, missing database/server evidence, conflicting
  values, stale database rows, ambiguous evidence, unsupported targets, per-plane failures, and
  in-sync records.
- Explicit `file-wins`, `db-wins`, and `server-wins` policy with preview-first apply.
- Rating repair through the existing file and media-server boundaries and exact SQLite updates.
- Refresh of changed stat evidence for one uniquely selected, still-present inventory destination.
- Fresh pre-apply acquisition, exact inventory-row targeting, post-apply verification, deterministic
  ordering, cancellation, bounded concurrency, and partial-result truthfulness.
- Human, JSON, YAML, and fixed-column CSV output.
- Bash, Zsh, and Fish completion parity, feature documentation, changelog, ROADMAP, and archive
  updates.

### Out of scope

- Fuzzy path matching, filename-only matching, acoustic fingerprints, or guessing across moved
  libraries.
- Treating operation-scoped inventory as one global mutable catalog.
- Automatic deletion of stale inventory rows.
- Generic title, album, album-artist, BPM, artwork, custom-tag, style, or mood repair.
- New direct Plex imports or handwritten provider endpoints above `MediaServerAdapter`.
- Schema migration, a new reconciliation snapshot table, daemon/watch mode, scheduled healing, or
  offline use of an old media-server response.
- Sealed cross-invocation plan artifacts. Apply reruns a fresh scan in the same invocation and
  revalidates each target.
- Changes to `rfmedia plex sync` or `rfmedia lidarr reconcile` public behavior.

## Child Issue Decision

No child issue is required. The report engine, command/action integration, supported repair path,
completion surface, and documentation form one cohesive public contract and can be reviewed in one
pull request. Arbitrary non-rating file/provider mutation is intentionally outside this release;
if requested later, it should be tracked as a focused adapter/tag-writer enhancement rather than a
blocking child of #125.

## User Stories

1. As an operator, I can scan one music root and see metadata drift across files, the selected
   rfmedia inventory generation, and the current media server without modifying any source.
2. As an operator, I can distinguish an absent tag from a conflicting value, a missing inventory
   row, a stale inventory path/stat record, duplicate evidence, and an unsupported repair.
3. As an operator, I can preview exactly what `file-wins`, `db-wins`, or `server-wins` would change
   before granting write authority.
4. As an operator, I can execute a chosen strategy and receive per-target applied, skipped, failed,
   and residual outcomes followed by a fresh convergence check.
5. As an automation author, I receive stable fields, deterministic ordering, stdout-only machine
   output, and a nonzero exit code for operational failure or incomplete requested apply.
6. As a maintainer, I can add another media-server adapter without importing Plex wire types into
   the reconciliation engine.

## Command Contract

### Scan

```text
rfmedia reconcile scan <source-path>
  [--library <name>]
  [--tracking-database <path>]
  [--operation-id <positive-integer>]
  [--workers <positive-integer>]
  [--no-progress]
```

`scan` requires a source root and an existing tracking database. It resolves the configured media
server through the public adapter, drains the selected library to a complete response-driven
snapshot, reads an immutable existing-file database snapshot through
`openReconciliationDatabaseReadOnly()`, and performs no state change.

### Apply

```text
rfmedia reconcile apply <source-path>
  (--file-wins | --db-wins | --server-wins)
  [--library <name>]
  [--tracking-database <path>]
  [--operation-id <positive-integer>]
  [--workers <positive-integer>]
  [--popm-email <email>]
  [--execute]
  [--allow-partial]
  [-y|--yes]
  [--no-progress]
```

- Exactly one winner flag is mandatory. Commander declares the three flags mutually conflicting,
  and the action independently normalizes and revalidates the one selected strategy.
- Without `--execute`, apply returns the exact preview and performs no write or confirmation.
- With `--execute`, a TTY run prompts with a default-No confirmation unless `--yes` is present.
- Machine/non-interactive execution with `--execute` requires `--yes`; it never attempts a prompt.
- `--yes` without `--execute` does not enable mutation.
- A known blocker in the requested rating/stat plan prevents every write unless `--allow-partial`
  is present. That flag is inert without `--execute`; when active, only independently actionable
  records run and the result remains partial and nonzero while requested drift remains.
- `--popm-email` affects only supported Linux MP3 rating writes.
- Global `--output json|yaml|csv` works on either side of the command hierarchy through the
  existing root option reconciliation.

## Business Rules

1. **Exact identity only:** evidence joins on the root-contained, normalized absolute local path,
   the exact normalized absolute `inventory.dest_path`, and the server track path. Paths are not
   case-folded. Empty, relative, escaping, duplicate, or provider-mapped paths are not guessed;
   `source_path`, `relative_path`, `operation_id`, and row ID remain provenance and update guards.
2. **Complete acquisition:** a server snapshot must prove stable totals and forward pagination.
   Partial/cancelled acquisition cannot produce an authoritative report or authorize apply.
3. **Historical database truth:** every inventory row retains its operation identity. When multiple
   rows claim one destination and `--operation-id` does not select exactly one, database authority
   is ambiguous.
4. **Read-only scan:** scan never initializes, migrates, checkpoints, or writes SQLite and never
   sends a provider/file mutation.
5. **Preview-first apply:** apply without `--execute` must not open SQLite writable, write a tag,
   send a provider update, write history, or alter a completion marker.
6. **One authority:** a strategy chooses the sole value source per field. Missing or ambiguous
   authority never falls back to another plane.
7. **Rating-only requested repair:** V1 plans writes only for normalized rating and uniquely
   selected stale stat evidence. Artist, genre, and year drift is observed separately and never
   produces a target mutation.
8. **Fail-closed partial policy:** a known blocker in the requested plan prevents all mutation
   unless `--allow-partial` is explicit. Partial execution attempts only independent actionable
   records, retains every blocker/residual, and cannot report full success.
9. **Rating precision:** ratings use normalized `0..1` values and compare server values at the
   adapter's declared native step. `null` is missing/unrated evidence, not numeric zero.
10. **Text normalization:** artist and genre comparisons use Unicode normalization, trimmed
    whitespace, and case-folded comparison while preserving source text for presentation.
11. **Year validation:** years must be finite safe integers in the supported media range; malformed
    values are invalid evidence, not conflicts.
12. **Stale database evidence:** a selected inventory row is stale when `dest_path` is absent or its
    stored size/integer-millisecond mtime no longer matches the regular file. A missing destination
    is report-only and unrepairable. Apply may refresh stat evidence only for one uniquely selected,
    still-present regular file after fresh verification; it never deletes inventory history.
13. **Fresh apply:** execution reacquires all three planes immediately before planning. Each
    `db-wins` record with authority-derived external mutations holds one short writable,
    identity-pinned SQLite `BEGIN IMMEDIATE` authority reservation across those mutations, commits
    the refreshed generation on success, and rolls back on error or cancellation. External-only
    records under the other strategies use a non-mutating current-generation guard.
14. **Fresh server proof:** bracket complete authoritative snapshots with uncached
    `libraryContentVersion()` reads and use uncached `trackById()` for targeted pre-write and
    post-write evidence. Every provider query receives the caller's `AbortSignal`; the signal is
    not part of query-cache identity.
15. **Checked file boundary:** before a file write, apply repeats root containment, `lstat`,
    regular-file/no-symlink, and stat fingerprint checks, then post-verifies the rating. Linux MP3
    mutation pins a trusted directory chain and uses descriptor-anchored source, stage, replacement,
    and cleanup. The source must be owned by the effective user or root, must not grant group,
    world, or access-ACL-effective write permission, and is revalidated immediately before
    publication while retaining mode, ownership, POSIX ACLs, and extended attributes. FLAC and
    other formats remain observable but unsupported reconciliation mutation targets.
16. **Write ordering:** for a record, external file/provider targets are attempted before the
    SQLite target so the database does not claim convergence before non-transactional writes
    succeed. A failed target prevents later targets for that record and is reported as partial.
17. **Exact database update:** SQLite updates use row ID plus expected `operation_id`, `dest_path`,
    `mtime`, `size`, and prior rating inside a short transaction. A zero-row guarded update is
    `stale-evidence`, not last-writer-wins.
18. **Trusted SQLite namespace:** writable reconciliation requires the main database and complete
    controlling ancestor chain to exclude untrusted write/rename authority, while allowing safe
    sticky-directory ancestry. The chain and main-file descriptors stay open from validation
    through commit; the immediate transaction pins WAL/SHM before schema access. Same-effective-user
    processes are inside the trust boundary because they can already write the reviewed database.
19. **Postcondition:** touched records are rescanned after apply. Only a fresh report with no
    requested rating drift and no pending database-stat refresh is counted reconciled; observed
    non-rating residuals remain separately visible.
20. **Exit semantics:** drift found by scan and a successfully computed preview are report data and
    exit zero, even when the preview is blocked. Acquisition/validation/read failures are
    operational failures. Declined, blocked, cancelled, partial, stale, failed, or incompletely
    verified execution is nonzero.
21. **Privacy:** machine and human output may include selected media paths and metadata values but
    never credentials, raw provider responses, database payloads, or full content hashes.

## Field Capability Matrix

| Field    | File read | DB read | Server read  | File write | DB write | Server write | V1 apply |
| -------- | --------- | ------- | ------------ | ---------- | -------- | ------------ | -------- |
| `rating` | Yes       | Yes     | Yes          | Linux MP3  | Yes      | Yes          | Yes      |
| `artist` | Yes       | Yes     | Yes          | No         | No       | No           | Observe  |
| `genre`  | First     | First   | If projected | No         | No       | No           | Observe  |
| `year`   | Yes       | Yes     | Yes          | No         | No       | No           | Observe  |

If the active adapter does not project track genres, genre still participates in file/DB
comparison and the server plane is reported unavailable for that field. OGG/Opus and M4A/AAC
rating writes remain unsupported through the existing tag-writer result contract.

## Result Contract

### Evidence

```ts
type ReconciliationPlane = "file" | "database" | "server";
type ReconciliationField = "rating" | "artist" | "genre" | "year";
type ReconciliationStrategy = "file-wins" | "db-wins" | "server-wins";

interface ReconciliationValue {
  readonly plane: ReconciliationPlane;
  readonly state: "present" | "missing" | "unavailable" | "invalid";
  readonly value: string | number | null;
}
```

### Finding

```ts
type ReconciliationFindingCode =
  | "missing-value"
  | "missing-database-entry"
  | "missing-server-track"
  | "stale-database-entry"
  | "conflicting-value"
  | "ambiguous-database-entry"
  | "ambiguous-server-path"
  | "unsupported-target"
  | "read-failed"
  | "in-sync";

interface ReconciliationFinding {
  readonly path: string;
  readonly field: ReconciliationField | null;
  readonly code: ReconciliationFindingCode;
  readonly evidence: readonly ReconciliationValue[];
  readonly operationIds: readonly number[];
  readonly serverTrackIds: readonly string[];
  readonly repairable: boolean;
}
```

### Apply outcomes

```ts
interface RatingTargetOutcome {
  readonly kind: "rating";
  readonly path: string;
  readonly target: ReconciliationPlane;
  readonly status: "planned" | "applied" | "skipped" | "unsupported" | "failed";
  readonly code: string;
  readonly before: number | null;
  readonly intended: number;
}

interface DatabaseStatOutcome {
  readonly kind: "database-stat";
  readonly path: string;
  readonly target: "database";
  readonly inventoryRowId: number;
  readonly status: "planned" | "applied" | "skipped" | "failed";
  readonly code: string;
  readonly before: { readonly mtime: number; readonly size: number };
  readonly intended: { readonly mtime: number; readonly size: number };
}

type ReconciliationTargetOutcome = RatingTargetOutcome | DatabaseStatOutcome;
```

```ts
type ReconciliationStatus =
  | "scanned"
  | "preview"
  | "declined"
  | "blocked"
  | "applied"
  | "partial"
  | "failed"
  | "cancelled";

interface ReconciliationResult {
  readonly schema: "rfmedia.reconcile.v1";
  readonly status: ReconciliationStatus;
  readonly success: boolean;
  readonly exitCode: 0 | 1 | 130 | 143;
  readonly mode: "scan" | "apply";
  readonly strategy: ReconciliationStrategy | null;
  readonly requestedFields: readonly ["rating"];
  readonly requestedOperations: readonly ["rating", "database-stat-refresh"];
  readonly executed: boolean;
  readonly executable: boolean;
  readonly allowPartial: boolean;
  readonly counts: ReconciliationCounts;
  readonly findings: readonly ReconciliationFinding[];
  readonly observedResiduals: readonly ReconciliationFinding[];
  readonly outcomes: readonly ReconciliationTargetOutcome[];
  readonly postApply: ReconciliationPostApply | null;
}
```

The aggregate counts distinguish rating and database-stat plans/outcomes, and it also includes
source root, library, database path provenance, optional operation ID, and stable blocker/failure
codes. Database-stat refresh is filesystem-derived inventory maintenance, not a metadata field and
not selected by the winner flag. `success` means the mode completed its promised contract:
ordinary scan drift and a computed preview are successful report data, while an executed apply is
successful only when every requested rating/stat update is freshly verified. A blocked preview has
`status: "preview"`, `success: true`, `exitCode: 0`, and `executable: false`. Declined, blocked
execution, stale evidence, partial execution, failed verification, and acquisition failure use a
non-success status and nonzero exit code.

CSV uses one row per finding or target outcome with a fixed discriminator and fixed columns. It does
not flatten nested objects through implementation-dependent serialization. Every CSV document
starts with a summary row, so an empty successful scan is still a complete machine result.

## Data Flow

### Scan

```text
Commander validation
  -> resolve existing DB path and provider-neutral adapter
  -> immutable read-only SQLite snapshot
  -> query inventory candidates for selected root/operation
  -> enumerate local audio files and bounded metadata projections
  -> drain one complete media-server track snapshot
  -> exact path index with duplicate detection
  -> pure comparison/classification
  -> deterministic human or machine presenter
```

### Apply preview and execution

```text
Commander validation + exactly-one winner flag
  -> run the exact scan pipeline
  -> pure strategy planner
  -> preview result (default; STOP)
  -> fail closed on known blockers unless --allow-partial
  -> --execute authorization + default-No prompt/--yes
  -> reacquire/revalidate record
  -> supported external target writes
  -> optimistic exact SQLite update
  -> fresh post-apply scan
  -> truthful partial/converged result and exit status
```

## Edge Cases

| Scenario                                                        | Required behavior                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Tracking database missing, symlinked, newer, or active sidecars | Fail scan without creating or changing it                                |
| Same destination appears in multiple operations                 | Report ambiguous unless `--operation-id` selects one                     |
| Two server tracks expose the same non-empty file path           | Report ambiguous; never first-row-wins                                   |
| Server track has an empty path                                  | Keep as unavailable/unmatched evidence; do not join by title             |
| Local path escapes the selected root after normalization        | Reject the candidate                                                     |
| Local file is a symlink or non-regular file                     | Report invalid/unavailable; never write through it                       |
| File metadata read or parse fails                               | Abort acquisition; nonzero error envelope, no reconciliation result      |
| Authority value is missing                                      | Report unresolved; do not borrow another plane                           |
| Any known requested-plan blocker without `--allow-partial`      | Preview as non-executable; executed request performs zero writes         |
| `--allow-partial` with actionable and blocked records           | Apply only independent actionable records; retain nonzero partial result |
| Linux MP3 rating target                                         | Require trusted ownership/mode; anchored replacement retains metadata    |
| FLAC rating target                                              | `unsupported-target`; leave file unchanged                               |
| OGG/Opus/M4A/AAC file-rating target                             | `unsupported-target`; leave file unchanged                               |
| Non-rating file/provider target                                 | `unsupported-target`; preserve residual drift                            |
| Database row changes after scan                                 | Optimistic update fails as stale evidence                                |
| Provider update succeeds and DB update fails                    | Report partial; post-scan exposes remaining drift                        |
| Ctrl-C during paging or apply                                   | Stop admissions, close DB, preserve completed outcomes, exit nonzero     |
| Scan finds drift but no operational failure                     | Exit 0 with report data                                                  |
| Machine apply requests execution without `--yes`                | Reject before any write; never prompt                                    |
| Empty successful scan in CSV                                    | Emit headers plus one summary row                                        |

## Technical Integration

### Files to create

- `packages/rfmedia-cli/src/types/reconciliation.ts`
- `packages/rfmedia-cli/src/lib/reconciliation.ts`
- `packages/rfmedia-cli/src/lib/reconciliation.test.ts`
- `packages/rfmedia-cli/src/actions/reconcile.ts`
- `packages/rfmedia-cli/src/actions/reconcile.test.ts`
- `packages/rfmedia-cli/src/commands/reconcile.ts`
- `packages/rfmedia-cli/docs/features/metadata-reconciliation.md`

### Files to modify

- `packages/rfmedia-cli/src/cli.ts` and `src/types/index.ts` for public registration/exports.
- `packages/rfmedia-cli/src/lib/db.ts` and `src/types/db.ts` for bounded inventory queries and exact
  optimistic updates.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and
  `templates.spec.ts` for the complete static command tree.
- `packages/rfmedia-cli/README.md`, `packages/rfmedia-cli/CHANGELOG.md`,
  `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`, and documentation indexes.
- `ROADMAP.md` and `docs/roadmap-archive.md`.

### Existing boundaries to reuse

- `resolveRequiredMediaServerAdapter()` and `MediaServerAdapter`; never private Plex imports.
- `readExtendedMetadata()`, `writeRating()`, `findAudioFiles()`, `processInParallel()`, and
  `advancePaginationOffset()`.
- `openReconciliationDatabaseReadOnly()` for an immutable scan/preview snapshot with reviewed file
  identity, and `withReconciliationDatabaseWritable()` for the explicitly gated,
  identity-checked execution handoff.
- Cancellable provider-neutral query options plus uncached `libraryContentVersion()` and
  `trackById()` freshness reads. An `AbortSignal` is control state, never query-cache identity.
- Root output format reconciliation, `formatOutput()`, prompt helpers, typed error/reporting
  conventions, and machine stdout discipline.

## Critical Test Evidence

Only contract-critical coverage is required:

1. Pure engine tests for exact-path joining, category precedence, value normalization, duplicate
   ambiguity, field capability planning, and deterministic ordering.
2. Database tests for root/operation candidate queries, duplicate preservation, empty input, and
   optimistic update refusal after concurrent change.
3. Action tests proving scan and default apply preview perform zero writes; known blockers fail
   closed before writable dependencies unless `--allow-partial`; one successful rating repair is
   post-verified; and one mid-record failure remains partial.
4. Command tests for exactly-one winner flag, `--execute`/`--yes` non-interactive safety,
   `--allow-partial` inertness without execution, machine envelope/empty CSV shape, and exit
   semantics.
5. Existing shell-template parity tests updated for the complete Bash/Zsh/Fish hierarchy.

Do not add exhaustive cross-products of every strategy, field, format, and output mode when the pure
engine and one integration boundary already prove the contract.

## Success Criteria

- [ ] `rfmedia reconcile scan` reports missing metadata, conflicts, stale database entries,
      ambiguity, unsupported targets, and in-sync evidence without mutation.
- [ ] `rfmedia reconcile apply` requires exactly one winner flag, previews by default, and cannot
      mutate without `--execute` plus approval or `--yes`.
- [ ] File, database, and server evidence is joined only by safe exact path and remains
      provider-neutral above the adapter.
- [ ] Requested rating targets and uniquely selected changed stat evidence can be repaired and are
      freshly verified; non-rating drift remains explicit observation-only residuals.
- [ ] Known requested-plan blockers cause zero writes unless `--allow-partial` is explicit; partial
      execution never reports full success while requested drift remains.
- [ ] JSON, YAML, and CSV output carry stable deterministic data while human progress/errors remain
      off machine stdout.
- [ ] Focused tests cover the actual safety and integration boundaries without redundant matrices.
- [ ] Bash, Zsh, and Fish templates expose identical command/options and parity tests pass.
- [ ] README, feature docs, tracking/database docs, changelog, ROADMAP, and archive are accurate.
- [ ] Typecheck, package tests, architecture/codegen checks, build, format/lint, whitespace checks,
      graph update, formal PR review/fix, green CI, squash merge, issue closure, and cleanup complete.
