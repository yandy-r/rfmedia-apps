# Practices Research: Tiered Verification

## Executive Summary

Implement issue #116 by adding one shared, framework-free per-file verifier and letting the existing
album and filter actions continue to own expected-file discovery, destination layout, extra-file
detection, repair policy, progress, and summaries. The repository already has the required
primitives: `calculateHash()` for SHA-256, `processInParallel()` for bounded file concurrency,
SQLite inventory rows with final-destination `content_hash`, conflict-resolution helpers, real-file
Vitest fixtures, shell-completion generators, and a verification benchmark suite.

The most important engineering correction is not a new algorithm; it is removing policy drift. The
same statuses, counters, baseline rules, and post-repair recheck must be used by album, flat-filter,
preserve-structure, and filter-album verification. Keep their traversal code separate, but route
every existing destination through a shared `verifyFileByTier()` result contract and aggregate that
contract with shared counter helpers.

Do not add a verification service class, pluggable hash algorithms, an ORM, worker threads, Merkle
trees, a destination-artifact migration, or a generalized copy/verify engine. Node 22 built-ins and
the current SQLite/Vitest/benchmark stack are sufficient. The practical risks are false confidence,
unbounded I/O, choosing the wrong ranged/filter baseline, treating unavailable evidence as
corruption, and incrementing “fixed” counters without verifying the repaired bytes.

## Existing Reusable Code

| Existing code                                                                                   | Reuse recommendation                                                                                                                                                                                | Important constraint                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/integrity.ts:calculateHash()`                                                          | Keep as the one SHA-256 implementation for an already-materialized file; extend it with optional `AbortSignal` support rather than creating a second hash helper.                                   | It currently uses `createReadStream()` and `pipeline()`, so memory is bounded, but its public signature does not yet accept cancellation.          |
| `src/lib/parallel.ts:processInParallel()`                                                       | Preserve the existing `workers` bound and pass the callback's signal into tier verification.                                                                                                        | It bounds files in flight, not bytes or open handles within a verifier; each verifier must still close its own handles.                            |
| `src/lib/verify.ts:getExpectedDestFilename()` and `findExtraFiles()`                            | Continue using them for conversion-aware filenames and extra detection.                                                                                                                             | `verifyFileSize()` is too narrow to become the tier dispatcher and should remain a compatibility helper until `--verify-size` is retired.          |
| `src/actions/verify-album.ts:verifyAlbumCopy()`                                                 | Retain directory traversal, suffix layout, missing-directory behavior, and album-relative issue paths. Replace only the existence-success/size branch with the shared verifier.                     | It currently duplicates counters and assumes a successful copy equals a successful repair.                                                         |
| `src/actions/verify-filter.ts:verifyFilteredTrack()` and `verifyAlbumMode()`                    | Retain rating/metadata selection and layout-specific traversal, but use the same verifier and aggregation contract as album mode.                                                                   | The file contains two verification loops with independent size/error behavior; both must be migrated.                                              |
| `src/actions/copy-filter.ts:getUniquePath()` and `src/actions/verify-filter.ts:getUniquePath()` | Extract one small deterministic destination-name allocator and reuse it at copy and verify time. This is already rule-of-three territory when flat verification also reconstructs the expected set. | Do not replace it with filesystem probing; mapping must depend on stable source ordering, not on which destinations happen to exist.               |
| `src/lib/db.ts` prepared statements and `DbInventoryEntry`                                      | Add one narrow, read-only, parameterized fingerprint-candidate query joining `operations.convert_key`; build lookup maps once per source batch.                                                     | Do not call `initializeDatabase()` for quick mode or for a missing baseline file, because initialization creates/migrates state.                   |
| `src/lib/config.ts:resolveUndoDatabasePath()`                                                   | Reuse established explicit/config/default database precedence after adding the explicit verify option.                                                                                              | Check existence before opening so a read-only verification run cannot create an empty tracking database.                                           |
| `src/types/results.ts:VerifiedFile` and `VerifyCommandResult`                                   | Extend these existing public result shapes additively with tier statuses, reason codes, and counters.                                                                                               | Keep `missing`, `sizeMismatch`, `extra`, and existing fix fields for compatibility; do not represent unknown evidence as a failed hash comparison. |
| Existing conflict helpers in both verify actions                                                | Preserve `chooseResolutionsByStrategy()`, `resolveConflictInteractive()`, trash/remove behavior, and `--force` compatibility.                                                                       | Expand the repairable mismatch set, then re-run verification; a copy call returning successfully is not proof of repair.                           |
| `src/lib/shell-completions/{bash,zsh,fish}.ts` and `templates.spec.ts`                          | Add `--quick`, `--deep`, and `--tracking-database` in all three templates and one parity-focused test.                                                                                              | Parser conflict enforcement is authoritative even if a shell cannot dynamically hide the opposite tier flag.                                       |
| `benchmarks/verify.bench.ts` and `benchmarks/helpers.ts`                                        | Replace existence/size-only rows with controlled quick/default/deep cases using the same fixture and inventory baseline.                                                                            | The 10x claim needs representative file bytes and repeated evidence; it must not be a wall-clock CI assertion.                                     |

## Modularity Design

Keep the existing command/action/library split:

1. `src/commands/verify.ts` owns Commander flags, mutually exclusive tier selection, raw-to-typed
   option conversion, machine-output projection, and the final exit-code decision.
2. `src/actions/verify-album.ts` and `src/actions/verify-filter.ts` own what artifacts are expected,
   where they map in the destination, how extras are found, and how authorized repair is executed.
3. A new `src/lib/tiered-verification.ts` owns pure tier policy: baseline resolution from supplied
   candidates, per-file evidence classification, and result aggregation. It must not log, prompt,
   open SQLite, repair, or set `process.exitCode`.
4. `src/lib/integrity.ts` owns byte-reading mechanics: SHA-256 streaming and fixed-buffer direct
   comparison with cancellation and guaranteed handle cleanup.
5. `src/lib/db.ts` owns the read-only SQL that loads fingerprint candidates. It should return typed
   rows and know nothing about CLI tier selection or filesystem paths beyond stored values.

The action should preload candidates once and construct exact-destination and source-identity maps.
Do not execute one SQLite query per file. Better-sqlite3 is synchronous, and an N+1 lookup inside
parallel filesystem work adds event-loop stalls without improving correctness.

Keep expected-file traversal in the actions for this issue. Album mode, flat filter mode,
preserve-structure mode, and filter-album mode have genuinely different selection and destination
layout rules. A new universal traversal engine would combine rating reads, range handling,
conversion filenames, duplicate basenames, and repair paths before a second consumer proves that
abstraction useful.

## KISS and Rule-of-Three Choices

### Extract now

- Extract a single per-file tier verifier because at least three loops need identical tier policy:
  album copies, flat/structured filtered tracks, and filter-album copies.
- Extract a result initializer/aggregator such as `createVerifyResult(source, tier)` and
  `addFileOutcome(result, issue)` because counters currently drift across album/filter and across
  multi-source aggregation.
- Extract the deterministic flat-filter destination-name allocator from copy/verify. The identical
  private `getUniquePath()` already exists twice, while verification separately rebuilds the extra
  set. One pure helper prevents a copied `track-002.flac` from being verified against the wrong
  source.
- Add one database candidate query and one in-memory resolver. This separates data access from the
  policy that prefers exact destination, then a byte-equivalent ranged fallback.
- Add one repairable-status predicate so album and filter modes do not maintain separate status
  lists as new mismatch types are introduced.

### Accept for now

- Keep album and filter traversal functions separate.
- Keep action-specific text summaries if their surrounding context differs, but drive both from the
  same counters and terminology.
- Keep album and filter conflict-context builders. They encode different relative-path ownership and
  are not identical enough to justify a broad repair service refactor in #116.
- Keep `verifyFileSize()` temporarily for the legacy `--verify-size` compatibility path; avoid
  deleting or broadly migrating unrelated callers in the tier implementation.

### Avoid

- Do not create `VerificationService`, repositories, factories, strategy classes, or a plugin API.
  A string discriminant and exhaustive switch are sufficient for three fixed tiers.
- Do not make the verifier discover destination paths or parse rating filters.
- Do not add a schema migration or hash index. Verification filters candidates by source/destination
  identity and compares hashes as values; it does not search by hash.
- Do not backfill a missing baseline during verification. That would bless current bytes rather than
  prove them against copy-time evidence.
- Do not make deep comparison spawn a worker per file or read files into `Buffer` wholesale.

## Interface Design

Use discriminated unions so impossible combinations are difficult to create and all callers must
handle unavailable evidence explicitly:

```typescript
export type VerificationTier = "quick" | "default" | "deep";

export type VerifyFileOutcome =
  | { status: "present"; evidence: "metadata" | "hash" | "bytes" | "bytes-and-hash" }
  | { status: "size-mismatch"; expectedSize: number; actualSize: number }
  | { status: "metadata-mismatch"; reason: "mtime" }
  | { status: "hash-mismatch" }
  | { status: "content-mismatch"; firstDifference?: number }
  | {
      status: "unverified";
      reason: "fingerprint-missing" | "fingerprint-null" | "conversion-unsupported";
    };

export interface VerifyFileInput {
  tier: VerificationTier;
  sourcePath: string;
  destinationPath: string;
  converted: boolean;
  fingerprint?: VerificationFingerprint;
  signal?: AbortSignal;
}
```

The actions should continue classifying a nonexistent destination as `missing`; the shared verifier
operates only after existence is established. This preserves current missing-directory enumeration
and avoids racing a second existence check. A file-read `ENOENT` after that check is an operational
failure, not another clean `missing` verdict, because the file changed during verification.

Keep hashes out of normal result objects. Status, reason, sizes, and optionally a first differing
offset are sufficient. Full expected/actual digests increase accidental disclosure and snapshot
churn without helping normal remediation.

The top-level result should include `tier`, additive mismatch/unverified counters, and existing
fields. Define one `hasUnresolvedVerificationProblems(result)` helper and use it for text status,
machine status, and `process.exitCode`. The current command omits `extra` from its exit condition;
centralizing the predicate prevents another disagreement among summaries, JSON, and exit behavior.

## Database Baseline Lookup

Add a narrow DTO that extends inventory with operation conversion identity, and return newest rows
first:

```typescript
export interface DbInventoryFingerprint extends DbInventoryEntry {
  convert_key: string | null;
}

export function getInventoryFingerprintCandidates(
  db: DbConnection,
  sourcePaths: readonly string[],
): DbInventoryFingerprint[];
```

Implementation practices:

- return `[]` immediately for no sources rather than building `IN ()`;
- parameterize every source path;
- join `operations` by `operation_id` to obtain `convert_key`;
- order by `copied_at DESC, inventory.id DESC` for deterministic newest-wins resolution;
- normalize both stored and requested paths for comparison in the resolver, without modifying the
  database;
- prefer exact normalized `dest_path` plus conversion variant;
- only then reuse the newest matching source/relative-path/conversion fingerprint for ranged
  destinations known to be byte-equivalent;
- distinguish no row from a matching row whose `content_hash` is `NULL`;
- never choose a row by basename or digest alone, and never cross conversion variants.

Use the current `idx_inventory_source` and `idx_inventory_dest` indexes and confirm the query plan if
the final SQL shape changes materially. Do not introduce a repository abstraction around one read.

## Bounded Hash and Byte Comparison

Retain Node built-ins. Extend `calculateHash(filePath, signal?)` so its existing pipeline receives
the abort signal. For deep comparison, add a helper such as:

```typescript
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

The implementation should `stat()` both files first, return unequal immediately when sizes differ,
open both files, reuse fixed-size buffers, and compare only the bytes actually read. Correctly handle
short reads by advancing offsets by bytes consumed rather than assuming one `read()` fills the
buffer. Check cancellation between reads and close both handles in `finally` on match, mismatch,
abort, and error.

Keep memory `O(workers * chunkSize)`. A fixed 64 KiB or similarly modest chunk is sufficient; do
not make chunk size a public option before measurements show a user need. Default verification reads
the destination once for SHA-256. Deep reads source and destination for byte comparison and may hash
the destination as an additional historical check when a fingerprint exists. Do not combine these
into an elaborate multi-sink stream unless profiling demonstrates that the simple sequence is a
problem.

## Repair Practices

Preserve existing confirmation, conflict strategy, trash, conversion, and copy helpers, but change
the success definition:

1. classify the issue;
2. if the status is repairable and `--fix` authorizes mutation, execute the existing copy/convert or
   extra-file removal path;
3. for a recreated/replaced expected file, call `verifyFileByTier()` again with the same baseline;
4. update counters from the post-repair outcome, not from `copiedFiles` alone;
5. retain both repair-operation failure and recheck failure in structured results.

`unverified` is not repairable because absence of evidence does not establish damaged content.
Repair must not write or replace inventory fingerprints. In default mode, a changed source may
successfully copy yet still disagree with the historic destination hash; that remains unresolved and
nonzero. Renaming a mismatched copy also does not repair the expected destination, so the original
issue must remain unless the existing conflict semantics explicitly restore that path.

Avoid arithmetic counter mutation such as “verified += copiedFiles” and “missing -= copiedFiles.”
Rebuild or apply a typed transition from the recheck result; this prevents a hash mismatch from
being reported as repaired merely because copying did not throw.

## Testability

Use three levels of focused evidence:

### Pure/library tests

- `tiered-verification.test.ts`: table-drive all tiers, valid/missing/null fingerprints, conversion
  limitations, hardlink common-mode drift, and exhaustive status aggregation.
- `integrity.test.ts`: prefer real temporary files for equal content, same-size differences,
  different sizes, empty files, multi-chunk files, early difference, later difference, read error,
  and abort. Existing mocked crypto tests may remain for `calculateHash()` wiring, but real bytes are
  stronger evidence for the new comparison algorithm.
- `db.test.ts`: use a temporary real SQLite database for exact destination precedence, newest-row
  ordering, ranged fallback inputs, conversion isolation, `NULL` hashes, empty source lists, quotes
  in paths, and no schema-version change.
- Add a focused test for the extracted duplicate-name allocator proving stable `name`, `name-002`,
  `name-003` mapping with case-insensitive keys and converted extensions.

### Action tests

- Album: quick/default/deep aggregation across two suffixes, missing baseline, extra files, failed
  reads, conversion behavior, cancellation, and post-repair recheck.
- Filter: duplicate basenames, flat and preserve-structure layouts, filter-album with ranges,
  conversion, multiple sources, extra detection, and post-repair recheck.
- Assert that the verifier receives the actual absolute source/destination pair and that result
  counters remain invariant across the two action families for the same outcome matrix.
- Keep conflict-resolution tests focused on authorization and file-operation selection; mock the
  shared verifier there. Keep tier correctness in the library tests to avoid a combinatorial action
  suite.

### Command/contract tests

- default tier selection and `--quick`/`--deep` conflicts;
- explicit tracking database propagation and quick mode not opening SQLite;
- additive JSON fields and stable reason enums;
- exit 1 for missing, extra, every mismatch, unverified coverage, failed reads, and unsuccessful
  rechecks; exit 0 only after all remaining issues are cleared;
- Bash, Zsh, and Fish completion parity for all new verify flags.

Run focused tests first, then rfmedia-cli typecheck/test/build and repo-required documentation or
markdown checks. Do not infer broad correctness from the existing conflict-only action suites.

## Benchmarks, Completions, and Documentation

Benchmark all tiers against one pre-populated, read-only fixture. Use the same file count, bytes per
track, range, workers, and database contents in each row. `RFMEDIA_BENCH_TRACK_BYTES` already provides
the needed representative-media control. Report quick versus default/deep medians over repeated
runs, include the dataset and storage environment, and treat 10x as acceptance evidence rather than
a deterministic CI timing gate.

Add a small non-timing test proving quick does not call hash/byte-read/database helpers. That is a
stable architectural guarantee and explains the expected speed better than a flaky threshold test.

Update Bash, Zsh, and Fish templates together. Add exact template assertions for `--quick`, `--deep`,
and `--tracking-database`; test parser conflict behavior separately. Update the verify command guide,
auto-fix guide, hashing/integrity documentation, README examples/options, and ROADMAP. Documentation
must distinguish metadata freshness, historical hash integrity, byte equality, converted-file
limitations, missing baselines, repair/recheck semantics, machine fields, and exit behavior. Mark
ROADMAP issue #116 complete only with the merged implementation, not when a plan or PR merely exists.

## Build vs Depend

Build the small tier policy and byte comparer in-repo. Reuse:

- `node:crypto`, `node:fs`, streams, and `AbortSignal`;
- current `better-sqlite3` prepared queries;
- existing `p-limit`-backed concurrency;
- current Vitest tests/benchmarks and temp-directory fixtures;
- existing Commander conflict support, formatters, conflict resolution, and completion generators.

Do not add a checksum package, native comparison executable, database ORM, migration framework,
worker-pool library, benchmarking package, or file-observer dependency. New packages would add
platform and security surface without solving identity, evidence classification, or repair
correctness.

## Overengineering and Regression Risks

1. **Traversal rewrite:** combining album and filter traversal while introducing tiers risks rating,
   range, conversion, and extra-file regressions. Share evidence policy, not whole workflows.
2. **Generic strategy hierarchy:** three fixed string tiers do not justify classes or dependency
   injection throughout the actions. Inject narrow functions only where tests need a seam.
3. **N+1 SQLite reads:** per-file queries under parallel verification create synchronous contention;
   preload candidates once.
4. **Unbounded content reads:** `readFile()` or one buffer per file scales with media size and worker
   count. Stream hashes and fixed-buffer comparisons.
5. **Shared mutable name allocation in concurrent callbacks:** compute expected destination paths in
   deterministic source order before launching parallel I/O. Do not mutate `usedNames` according to
   completion timing.
6. **Silent fallback:** default/deep must not degrade to quick when a hash/source is unavailable and
   still increment `verified`.
7. **Baseline mutation:** verify and `--fix` must not adopt current bytes as trusted history.
8. **Conversion false positives:** source and converted destination are intentionally byte-different;
   only the stored final-artifact hash supports the default tier.
9. **Counter patching:** arithmetic updates after repair can report success without evidence. Recheck
   and aggregate typed outcomes.
10. **Benchmark theater:** tiny fixtures or single wall-clock runs cannot substantiate the 10x goal.
11. **Completion drift:** updating only one shell leaves an inconsistent public CLI.
12. **Schema expansion:** one-row-per-artifact tracking may be valuable later, but it is not required
    to implement the documented newest compatible fingerprint fallback for #116.

## Open Questions

1. Should `--verify-size` remain an additive precheck for one compatibility release or become a
   deprecated alias for quick? Recommendation: retain it as an additive compatibility option and
   document `--quick` as the explicit metadata tier.
2. What exact timestamp precision should quick use? Recommendation: compare the integer millisecond
   values preserved by the current copy path and encode the policy in one helper/test rather than
   scatter tolerances through actions.
3. Should deep without a stored fingerprint pass for a byte-identical non-converted artifact?
   Recommendation: yes, report byte evidence explicitly; default remains unverified without the
   historical fingerprint.
4. Should converted quick/deep be `unverified` or successful hash-only coverage? Recommendation for
   this issue's simple contract: make quick/deep explicitly unverified and direct users to default;
   adding “deepest applicable” coverage states can follow if product requirements demand it.
5. Should a repaired file ever establish a new baseline? Recommendation: no. Copy/sync owns baseline
   creation; verification owns comparison to existing evidence.
6. Should first-difference offsets be public machine output? Recommendation: optional for deep
   mismatches and tests, but omit them from the first public result unless a concrete automation use
   case requires the contract.
