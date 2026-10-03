# Pattern & Code Analysis: Tiered Verification

## Executive Summary

Tiered verification fits the repository's existing command/action/library architecture without a
new command family or a traversal rewrite. The accepted implementation pattern is:

```text
commands/verify.ts
  -> parse one VerificationTier and public options
  -> actions/verify-album.ts or actions/verify-filter.ts
       -> retain current expected-artifact mapping
       -> preload exact, read-only inventory evidence
       -> call lib/tiered-verification.ts for every existing artifact
       -> aggregate typed outcomes
       -> optionally stage, verify, commit, and reverify repairs
  -> emit human or machine output from one aggregate result
  -> set exit status from one unresolved-state predicate
```

The repository already supplies most mechanics: conversion-aware filenames in
`packages/rfmedia-cli/src/lib/verify.ts`, bounded file concurrency in
`packages/rfmedia-cli/src/lib/parallel.ts`, streaming SHA-256 in
`packages/rfmedia-cli/src/lib/integrity.ts`, copy-time fingerprints in schema-version-9 inventory,
conflict-resolution helpers in both verify actions, shared cancellation in
`packages/rfmedia-cli/src/lib/signal-handler.ts`, completion generators, and real-filesystem
benchmarks.

The implementation should extract only the policy that is already duplicated across three
verification loops: per-file evidence classification, deterministic aggregation, the unresolved
predicate, and flat-filter destination naming. Album and filter traversal remain separate because
their source selection and destination layouts differ substantially. The accepted feature spec is
authoritative where earlier research explored broader fallbacks: default and deep require an exact
destination-bound historical fingerprint, deep is cumulative with default, and schema-v9 ranged
destinations that lack their own represented inventory row are `unverifiable` rather than borrowing
another output's baseline.

## Implementation Patterns

### 1. Model tier and outcome as discriminated unions

Follow the existing `CopyMode` convention in
`packages/rfmedia-cli/src/types/options.ts`: represent the selected verification strength as one
value, not independent booleans below the command layer.

```ts
export type VerificationTier = "quick" | "default" | "deep";

export interface VerifyOptions {
  // Existing fields remain additive.
  tier: VerificationTier;
  trackingDatabase?: string;
}
```

Use an exhaustive per-file outcome union in
`packages/rfmedia-cli/src/types/results.ts`. Do not overload the current `present` status for extras
inside the new verifier and do not collapse missing evidence or I/O errors into mismatches.

```ts
export type FileVerifyStatus =
  | "present"
  | "missing"
  | "size-mismatch"
  | "metadata-mismatch"
  | "hash-mismatch"
  | "content-mismatch"
  | "unverifiable"
  | "not-applicable"
  | "unstable";

export type VerificationReason =
  | "mtime"
  | "fingerprint-missing"
  | "fingerprint-null"
  | "fingerprint-invalid"
  | "fingerprint-ambiguous"
  | "conversion-metadata-unavailable"
  | "conversion-byte-compare"
  | "same-inode-byte-compare"
  | "changed-during-read";
```

Keep operational failures in the existing `FailedOperation[]`. A mismatch means comparable
evidence was obtained and differed; `unverifiable` means required evidence was absent or unusable;
`unstable` means no trustworthy verdict could be reached.

### 2. Add one framework-free tier dispatcher

Create `packages/rfmedia-cli/src/lib/tiered-verification.ts` with a narrow public boundary:

```ts
export interface VerifyFileInput {
  tier: VerificationTier;
  sourcePath: string;
  destinationPath: string;
  converted: boolean;
  fingerprint?: DbInventoryFingerprint;
  signal?: AbortSignal;
}

export async function verifyFileByTier(input: VerifyFileInput): Promise<VerifyFileOutcome>;
```

The function must not log, prompt, open SQLite, mutate files, or set `process.exitCode`. The actions
already check expected-path existence and own missing-path reporting, so the dispatcher should
classify only an artifact that existed when traversal reached it.

Use an exhaustive `switch (input.tier)`:

- `quick`: open/stat regular source and destination files, compare size then the accepted integer
  millisecond mtime policy, and perform no hashing or database access;
- `default`: require a validated exact fingerprint, stream the destination once through SHA-256,
  then return `present`, `hash-mismatch`, `unverifiable`, or `unstable`;
- `deep`: perform the default check first, then compare source/destination bytes for byte-identical
  artifacts; converted outputs and same-inode hardlinks retain successful hash evidence while the
  redundant direct check is `not-applicable` coverage.

Non-audio companion files remain byte-comparable even when `options.convertFormat` is set. Determine
`converted` per artifact with the established `shouldConvert()`/filename logic rather than treating
the whole invocation as converted.

### 3. Keep content I/O bounded and stability-aware

Extend `calculateHash()` in `packages/rfmedia-cli/src/lib/integrity.ts` to accept an optional
`AbortSignal`. Its current `createReadStream()` plus `pipeline()` pattern already provides bounded
memory; pass the signal to both the stream and pipeline.

Add a `compareFileBytes()` helper using two `FileHandle`s and two reusable buffers:

```ts
export interface ByteCompareResult {
  equal: boolean;
  firstDifference?: number;
}

export async function compareFileBytes(
  sourcePath: string,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<ByteCompareResult>;
```

Open each file once, require regular files, capture `dev`, `ino`, size, and modification/change
metadata from the open handle, and re-stat after reading. Different initial sizes can return a typed
mismatch without reading content. The manual loop must advance by actual `bytesRead`, fill or
reconcile short reads, compare only populated buffer slices, confirm EOF on both handles, check
`signal.throwIfAborted()` between syscalls, and close both handles in `finally`.

Do not use `readFile()`, `Buffer.concat()`, or event-for-event stream comparison. Memory should be
`O(workers * chunkSize)`, not proportional to media size. Reuse
`processInParallel()` from `packages/rfmedia-cli/src/lib/parallel.ts` as the only file-level worker
limit and pass its callback signal through to the verifier.

### 4. Resolve baselines once, exactly, and read-only

Schema version 9 in `packages/rfmedia-cli/src/lib/schema.sql` stores `inventory.content_hash`,
`dest_path`, source identity, and a unique key on `(operation_id, source_path, relative_path)`.
`operations.convert_key` supplies conversion identity. Add a narrow DTO and query in
`packages/rfmedia-cli/src/lib/db.ts`:

```ts
export interface DbInventoryFingerprint extends DbInventoryEntry {
  convert_key: string | null;
}

export function getInventoryFingerprintCandidates(
  db: DbConnection,
  sourcePaths: readonly string[],
): DbInventoryFingerprint[];
```

The SQL should use positional bindings, return `[]` for empty source input, join `operations`, and
order deterministically by `copied_at DESC, inventory.id DESC`. Load candidates once per top-level
verification batch and build in-memory keys from normalized source identity, conversion identity,
and exact derived destination path. Validate every externally editable row at read time, including
field types, finite sizes/times, relative-path shape, destination containment, and lowercase
64-character SHA-256.

Exact destination binding is mandatory. Treat inventory paths as claims that may confirm an
artifact derived from the current command scope; never use them to choose a path to read or repair.
Do not select by basename, digest, latest operation alone, or source-relative identity alone. If an
expected ranged output is not represented by its own `dest_path`, return `unverifiable`. Do not add a
schema migration or a hash index for this consumer.

`initializeDatabase()` is not reusable for verification reads. It creates parent directories,
changes journal mode to WAL, executes schema, and runs migrations. Add a purpose-built
`openDatabaseReadOnly()` using `fileMustExist`, schema/version validation, and `query_only`, with no
schema execution, migration, journal change, database creation, WAL, or SHM side effects. Resolve
the path using explicit `--tracking-database` followed by the existing configured/default precedence,
check existence before opening, and close in `finally`.

### 5. Precompute expected paths before parallel I/O

`packages/rfmedia-cli/src/actions/copy-filter.ts` and
`packages/rfmedia-cli/src/actions/verify-filter.ts` contain equivalent private `getUniquePath()`
implementations. Flat verification also reconstructs the set again for extra detection. Extract one
pure deterministic destination-name allocator and reuse it for copy and verify.

Build the complete ordered task list before calling `processInParallel()`:

```ts
interface VerificationTask {
  sourcePath: string;
  destinationPath: string;
  relativeDisplayPath: string;
  converted: boolean;
  fingerprint?: DbInventoryFingerprint;
}
```

This keeps duplicate mapping (`track.flac`, `track-002.flac`, `track-003.flac`) tied to stable source
order rather than worker completion timing. Use the same precomputed destination paths to build the
expected-name set for `findExtraFiles()`. Keep absolute paths internally for evidence and repair;
derive a separate relative path for public output instead of reconstructing an absolute source from
the current album action's basename-only `VerifiedFile.sourcePath`.

### 6. Aggregate with one transition function

The album action's private `AlbumVerifyResult`, filter action's `VerifyCommandResult`, and both
multi-source wrappers currently initialize and sum counters independently. Add small shared helpers
in `tiered-verification.ts` or a result-focused module:

```ts
export function createVerifyResult(source: string, tier: VerificationTier): VerifyCommandResult;
export function addVerifyOutcome(result: VerifyCommandResult, issue: VerifiedFile): void;
export function mergeVerifyResults(target: VerifyCommandResult, source: VerifyCommandResult): void;
export function hasUnresolvedVerificationProblems(result: VerifyCommandResult): boolean;
```

All human summaries, machine `status`, and `process.exitCode` should use the same unresolved
predicate. The current actions omit extras from their `COMPLETE` calculations, and
`packages/rfmedia-cli/src/commands/verify.ts` omits extras from its exit condition. The new predicate
must include missing, extra, every mismatch, unverifiable evidence, instability, and operational or
repair failures. `not-applicable` alone is coverage information, not failure when the required
stored hash passed.

Preserve existing aggregate fields additively for compatibility and add `tier`,
`metadataMismatch`, `hashMismatch`, `contentMismatch`, `unverifiable`, `notApplicable`, and
`unstable`. Sort machine issue details by normalized relative path after parallel processing for
deterministic output. Do not emit full expected or actual digests.

### 7. Treat repair as an evidence-preserving transaction

Reuse the existing conflict-decision helpers in `verify-album.ts` and `verify-filter.ts`, but do not
reuse their current remove-then-copy success accounting for integrity mismatches.

The safe pattern is:

1. require `--fix` plus the established force/interactive/conflict authorization;
2. prove that the current source can reproduce the stored baseline;
3. create a private temporary output in the final destination directory;
4. copy or convert into that temporary path;
5. verify the completed temporary artifact against the original baseline;
6. revalidate destination-root containment and parent identity;
7. atomically replace the expected path;
8. run `verifyFileByTier()` again against the final path;
9. update counters from the post-repair result and clean the temporary path in every failure/abort
   branch.

For byte-identical files, source SHA-256 must match the stored destination baseline before
replacement. For converted output, safe repair requires staged reproduction that matches the stored
final-output hash; otherwise leave the existing destination intact. A changed hardlink cannot be
repaired from its equally changed source. Rename does not resolve the original expected path.
`unverifiable` is not repairable, and verification never backfills or changes the baseline.

## Existing Code Structure

| Layer/file                                                          | Existing responsibility                                                                                                                                                                                                            | Tiered-verification change                                                                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/rfmedia-cli/src/commands/verify.ts`                       | Defines raw Commander options, chooses album/filter mode, builds `VerifyOptions`, lazy-loads actions, projects machine output, and sets exit status.                                                                               | Add conflicting `--quick`/`--deep`, `--tracking-database`, effective tier help/output, additive counters, and the shared unresolved predicate.                                                         |
| `packages/rfmedia-cli/src/actions/verify-album.ts`                  | `verifyAlbumCopy()` maps one album directory; `processAlbumVerification()` handles suffixes in parallel; `fixAlbumCopy()` applies repair; top-level functions handle album-only/artist/multiple-source flows.                      | Preserve layout and range precedence, replace per-file size policy with shared tasks/verifier, preload exact evidence, and reverify staged repairs.                                                    |
| `packages/rfmedia-cli/src/actions/verify-filter.ts`                 | `preScanForExpectedFiles()` applies ratings/metadata; `verifyFilteredTrack()` handles flat names; `verifyAlbumMode()` handles liked tracks in album/range layout; `fixFilteredTracks()` repairs; wrapper handles multiple sources. | Precompute deterministic tasks, reuse one name allocator, call the same verifier in flat/structured/album paths, and use shared aggregation/repair transitions.                                        |
| `packages/rfmedia-cli/src/lib/verify.ts`                            | `getExpectedDestFilename()`, `findExtraFiles()`, legacy completeness and size helpers.                                                                                                                                             | Reuse filename/extra helpers. Keep legacy `verifyFileSize()` only for temporary `--verify-size` compatibility; do not turn this file into the tier orchestrator.                                       |
| `packages/rfmedia-cli/src/lib/integrity.ts`                         | Streaming `calculateHash()` and two-path `verifyFileIntegrity()`.                                                                                                                                                                  | Make hashing abort-aware and add stable fixed-buffer comparison. Do not reuse `verifyFileIntegrity()` for default: it hashes both paths and currently debug-logs full digests.                         |
| `packages/rfmedia-cli/src/lib/db.ts`                                | Writable initialization/migration, operation tracking, inventory writes/reads, history.                                                                                                                                            | Add a separate read-only opener and exact candidate query. Leave writable initialization and schema version unchanged.                                                                                 |
| `packages/rfmedia-cli/src/lib/schema.sql`                           | Schema-v9 inventory and indexes on source/destination.                                                                                                                                                                             | No DDL change. Its unique key explains why some ranged destinations are explicitly uncovered.                                                                                                          |
| `packages/rfmedia-cli/src/lib/filesystem.ts`                        | Copy/hardlink, timestamp preservation, hash-during-copy, retry, cleanup, remove/trash.                                                                                                                                             | Reuse copy primitives where safe; use a new staged-replacement helper or narrowly composed primitives for repair. `copyOrLink()` preserves timestamps, which supports quick for byte-identical copies. |
| `packages/rfmedia-cli/src/lib/parallel.ts`                          | Caps workers at eight, returns index-stable `ParallelResult`s, stops queued work after abort.                                                                                                                                      | Reuse as the sole scheduler; forward its signal into active hashes/comparisons and aggregate by original task index.                                                                                   |
| `packages/rfmedia-cli/src/lib/signal-handler.ts`                    | Global `AbortSignal` and named cleanup callbacks.                                                                                                                                                                                  | Keep wrapper registration, but ensure every active content read and staged repair observes the linked signal and closes resources.                                                                     |
| `packages/rfmedia-cli/src/types/{options,results,db,index}.ts`      | Public option/result/database contracts and barrel exports.                                                                                                                                                                        | Add tier/outcome/evidence/candidate types additively and export them through `types/index.ts`.                                                                                                         |
| `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` | Static command option templates.                                                                                                                                                                                                   | Add every new verify option in all three files and assert parity in `templates.spec.ts`.                                                                                                               |
| `packages/rfmedia-cli/benchmarks/{verify.bench,helpers}.ts`         | Real temporary artist libraries and existence/size verification rows controlled by scale/track-byte environment variables.                                                                                                         | Build one fingerprinted fixture and compare quick/default/deep with identical files, bytes, database, range, and workers.                                                                              |

## Code Conventions

- **ESM/NodeNext:** use `.js` extensions in TypeScript imports, matching all rfmedia-cli source.
- **Command/action separation:** Commander parsing and global output stay in `src/commands`; business
  behavior stays in `src/actions`; reusable I/O/policy stays in `src/lib`.
- **Typed options:** convert raw Commander camelCase fields into a complete `VerifyOptions` once in
  `buildVerifyOptions()`. Downstream code reads `tier`, not `quick`/`deep` booleans.
- **Parser conflicts:** follow existing `.conflicts()` use in `commands/copy.ts`, `delete.ts`, and
  `playlist.ts`; reject `--quick --deep` before action dispatch.
- **Prepared SQL:** follow `db.ts`'s positional binding and concrete row DTO pattern. Dynamic source
  placeholders may be generated from list length, but path/hash values are never interpolated.
- **Async filesystem APIs:** use `node:fs/promises`, streams, `pipeline()`, `AbortSignal`, and
  `try/finally` cleanup. Avoid synchronous content reads in actions.
- **Bounded parallelism:** use `processInParallel()` and its original-index results; do not add a
  second `p-limit` pool inside the verifier.
- **Logging/output:** human logs use logger functions and machine data flows through
  `isMachineFormat()`/`formatOutput()`. Progress and prose must not contaminate machine stdout.
- **Additive public contracts:** retain existing `VerifyCommandResult` and `VerifiedFile` fields where
  meanings still hold; add stable lowercase enum fields and numeric counters.
- **Error taxonomy:** retain path/message/code in `FailedOperation`; preserve abort/read errors as
  errors or unstable results rather than content mismatches.
- **Tests:** colocate Vitest files beside source. Use real temporary files for hash/compare semantics,
  real temporary SQLite for evidence lookup, and hoisted mocks only at action/command boundaries.
- **Formatting:** repository Markdown headings are surrounded by blank lines; TypeScript/Markdown
  are formatted with Prettier and imports follow the existing grouped style.

## Integration Points

### CLI and output

In `packages/rfmedia-cli/src/commands/verify.ts`:

- extend `RawVerifyOptions` with `quick`, `deep`, and `trackingDatabase`;
- declare reciprocal Commander conflicts and describe the no-flag SHA-256 default;
- set `tier` in `buildVerifyOptions()` and propagate the database path;
- retain lazy action imports;
- add top-level `tier` and result counters/status to JSON/YAML/table/CSV-compatible data;
- drive `process.exitCode` from `hasUnresolvedVerificationProblems()`.

Add focused command registration/contract coverage. The current
`packages/rfmedia-cli/src/cli.test.ts` is small, so command tests may either extend it through the
registered program or add a colocated `commands/verify.test.ts` consistent with other command
suites.

### Album action

In `verifyAlbumCopy()`, retain source normalization, `readdir()`,
`getExpectedDestFilename()`, missing enumeration, and `findExtraFiles()`. Build absolute
`VerificationTask`s, resolve exact fingerprints, then replace the optional `verifyFileSize()` branch
with `verifyFileByTier()`. Extend `AlbumVerifyResult` only if it remains private; preferably use the
public aggregate initializer so album and filter counters cannot drift.

In `processAlbumVerification()`, keep suffix task construction and the existing `workers`/signal
call. Baseline lookup should happen before per-file work and should not open SQLite inside each
suffix callback. In `executeAlbumVerifyWithFileInput()`, preserve CLI-range > per-path-range > config
precedence and the registered `verify-album-abort` cleanup.

### Filter action

Preserve `preScanForExpectedFiles()` and `verifyAlbumMode()` selection semantics. Extract the
copy-time `getUniquePath()` algorithm so flat verification, its expected extra-file set, and
`copy-filter.ts` share the same ordered mapping. Build mappings before parallel calls; the current
shared `usedNames` map is otherwise coupled to callback start order.

Apply the verifier in both `verifyFilteredTrack()` and the inner loop of `verifyAlbumMode()`.
Preserve filter range precedence in `executeFilterVerifyWithFileInput()` and merge all new counters,
coverage, failures, and repair results through one helper.

### Database and identity

Add `openDatabaseReadOnly()` and candidate queries beside existing database utilities, but do not
route through `initializeDatabase()`. Reuse `resolveUndoDatabasePath()` for config/default
precedence after explicit CLI selection. Close the connection even on abort or action failure.

The candidate resolver must compare the command-derived destination with stored `dest_path`, never
join or open a path solely because the database supplied it. Existing `idx_inventory_source` and
`idx_inventory_dest` are adequate; `content_hash` is compared after identity resolution and needs
no lookup index.

### Repair

Keep `chooseResolutionsByStrategy()`, `resolveConflictInteractive()`, `moveToTrash()`, and current
dry-run/force behavior. Introduce staging only for repairable expected artifacts; extra removal stays
under existing trash/remove authorization. Ensure the temporary path is in the final directory so
the commit is an atomic same-filesystem rename, and ensure all pre-commit errors leave the original
file untouched.

Post-repair aggregation must replace the original issue with the recheck outcome. Do not perform the
current arithmetic updates (`verified += copiedFiles`, `missing -= copiedFiles`) for tiered results.

### Completions, benchmarks, and documentation

- Update Bash `verify_opts`, the Zsh `verify)` `_arguments` block, and Fish verify completions.
- Extend `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` with exact assertions for
  `--quick`, `--deep`, and `--tracking-database` in all three generated scripts.
- Extend `makeVerifyOptions()` in `benchmarks/helpers.ts` with a default tier and baseline path.
- Change `verify.bench.ts` from existence/size rows to quick/default/deep against one pre-populated
  inventory and representative `RFMEDIA_BENCH_TRACK_BYTES`; record filesystem/cache/workers and use
  no wall-clock assertion in CI.
- Update `packages/rfmedia-cli/README.md`, verify/fix/content-hashing docs,
  `docs/features/file-integrity-verification.md`, and `ROADMAP.md` together. Document quick as
  metadata freshness, default/deep baseline requirements, conversion/hardlink coverage,
  unverifiable historical ranges, stable machine fields, safe repair, and the measured 10x result.

## Gotchas and Warnings

1. **The accepted spec supersedes exploratory fallbacks.** Do not let older research text that
   allowed deep without a fingerprint or source-relative ranged fallback weaken the final contract.
   Deep requires default evidence; unrepresented ranged artifacts are `unverifiable`.
2. **`initializeDatabase()` is mutating.** It can create directories/files, enable WAL, execute
   schema, and migrate. Ordinary default/deep verification needs a separate existing-file,
   read-only opener; quick opens no database at all.
3. **Inventory identity is incomplete for ranges.** `UNIQUE(operation_id, source_path,
relative_path)` retains only one represented destination per operation/source artifact. Do not
   claim historical coverage for sibling suffixes without exact `dest_path` evidence.
4. **Converted outputs differ intentionally.** Default/deep validate their final destination hash;
   direct byte comparison is `not-applicable`. Quick lacks trustworthy destination metadata in
   schema v9 and is `unverifiable` for converted artifacts. Non-converted companion files remain
   eligible for direct checks.
5. **Hardlink equality is redundant evidence.** Detect equal `dev`/`ino`; a stored-hash mismatch
   still fails deep even though both pathnames expose the same current bytes.
6. **Path checks race.** Current actions combine `pathExists()`/`stat()` with later path-based
   remove/copy. Derive paths from selected roots, reject unsafe symlinks/special files, compare open
   handle identity, and revalidate containment immediately before repair commit.
7. **Files can mutate during reads.** A hash or byte comparison is not successful if pre/post open
   handle metadata changes. Return `unstable`; never relabel it as mismatch or success.
8. **Current filter duplicate allocation is mutable shared state.** Precompute names sequentially
   before parallel I/O and use the same tasks for extra detection.
9. **Current repair can destroy evidence.** Both actions remove a mismatched destination before
   replacement and count successful copy calls as fixed. Stage and verify first, commit atomically,
   then reverify the final path.
10. **Rename is not repair.** Creating a sibling path does not restore the expected artifact and
    must not clear its issue.
11. **No implicit rebaseline.** Missing/null/invalid/ambiguous hashes are not corruption and cannot
    be repaired by hashing current bytes. Copy/sync or a future explicit adoption workflow owns new
    baselines.
12. **`verifyFileIntegrity()` is the wrong default-tier helper.** It hashes both source and
    destination and debug-logs full digests. Default hashes only the destination against stored
    evidence, and routine/debug output must omit full hashes.
13. **Extras currently do not fail consistently.** Include unresolved extras in shared status and
    exit semantics, including extras explicitly kept by conflict resolution.
14. **Cancellation must reach active I/O.** `processInParallel()` stops queued work but waits for
    running processors. Pass the linked signal into hash streams, manual compare loops, and staged
    repairs; close handles/temp files in `finally`.
15. **Storage throughput is not CPU throughput.** More workers can make HDD, NAS, FUSE, or sparse
    file workloads slower. Preserve the cap, benchmark worker counts, and report logical bytes.
16. **The 10x claim needs representative evidence.** Tiny 1 KiB benchmark fixtures mainly measure
    syscall overhead. Use media-sized files, identical workloads, disclosed cache state, repeated
    medians, and a non-timing test proving quick never calls hash/byte/database helpers.
17. **Machine results must be deterministic and bounded.** Sort issue details after parallel work,
    keep full hashes out, sanitize/bound OS text, and keep human progress off stdout.
18. **Dependency advisories are adjacent, not a reason to add packages.** Filter selection reaches
    media-parsing dependencies with known availability advisories. Track upgrades separately if
    they expand scope; tier primitives remain on Node built-ins.
