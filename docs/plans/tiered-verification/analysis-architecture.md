# Architecture Analysis: Tiered Verification

## Executive Summary

Issue #116 should add an evidence-policy layer to the existing `rfmedia verify` pipeline, not replace
its album/filter traversal. The target architecture keeps source selection, destination mapping,
extra detection, repair authorization, and progress in the two current actions while routing every
expected artifact through one framework-free verifier.

```text
commands/verify.ts
  -> resolve mode + tier + database path + output contract
  -> actions/verify-album.ts | actions/verify-filter.ts
       -> existing expected-artifact mapping and bounded scheduling
       -> preload exact destination-bound inventory evidence when required
       -> lib/tiered-verification.ts
            -> quick: metadata only
            -> default: destination SHA-256 vs stored final-artifact SHA-256
            -> deep: default + applicable source/destination byte comparison
       -> shared aggregation, repair/recheck, unresolved-state predicate
  -> human/machine output and one consistent exit decision
```

The accepted contract is conservative and monotonic:

- `--quick` reads metadata only; no SQLite open and no file-content reads.
- No tier flag selects `default`, which hashes each destination once against the issue #111
  fingerprint.
- `--deep` first requires default evidence, then directly compares bytes only when source and
  destination are contractually independent byte-identical artifacts.
- Converted output and same-inode hardlinks may pass deep at the strongest applicable stored-hash
  guarantee, but direct comparison is explicitly `not-applicable` or redundant in coverage.
- Missing, null, malformed, ambiguous, or historically unrepresented evidence is `unverifiable`,
  never a silent fallback or corruption verdict.
- Ordinary verification is read-only. Repair must prove reproducibility, preserve the original,
  stage and verify a replacement, commit safely, then re-run the selected tier.

No schema change, new dependency, traversal rewrite, baseline backfill, or blocking child issue is
required. Historical ranged destinations without an exact represented artifact remain visibly
uncovered; a one-row-per-destination ledger is a follow-up rather than hidden scope in #116.

## Architecture Context

### Current system

`packages/rfmedia-cli/src/commands/verify.ts` parses album/filter options, builds `VerifyOptions`,
dispatches lazily to the corresponding action, projects a small machine result, and sets exit status.
It currently exposes optional `--verify-size`; without that flag verification is primarily
existence-oriented.

`packages/rfmedia-cli/src/actions/verify-album.ts` contains album/suffix traversal,
`verifyAlbumCopy()`, extra detection, conflict handling, repair, summaries, and multi-source
aggregation. `packages/rfmedia-cli/src/actions/verify-filter.ts` separately implements flat,
preserved-structure, and album-filter traversal. It also privately reconstructs duplicate destination
names. Both actions duplicate size-only classification and currently infer repair success by adjusting
counters from copy/remove counts rather than re-verifying final bytes.

`packages/rfmedia-cli/src/lib/integrity.ts` already provides streaming SHA-256 but lacks cancellation,
file-stability checks, and direct byte comparison. `packages/rfmedia-cli/src/lib/db.ts` stores nullable
final-artifact hashes in schema-version-9 inventory and has operation-scoped reads, but normal
`initializeDatabase()` can create schema, set WAL pragmas, and migrate. It is therefore not a valid
read-only verification entry point.

The inventory key is `(operation_id, source_path, relative_path)` and a row carries one `dest_path`.
An operation also carries `convert_key`. This can truthfully verify an exact represented destination,
including converted output, but cannot prove every historical ranged destination. Baseline resolution
must bind normalized source identity, conversion variant, and exact derived destination; newest-row
ordering only breaks ties after identity is established.

### Target component responsibilities

| Component                                             | Responsibility                                                                                   | Must not own                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `packages/rfmedia-cli/src/commands/verify.ts`         | Commander conflicts, effective tier, explicit/configured DB path, machine projection, final exit | File reads, SQL, repair policy                                  |
| `packages/rfmedia-cli/src/actions/verify-album.ts`    | Album/range expected set, extra discovery, progress, authorized repair orchestration             | Tier algorithms, digest comparison policy                       |
| `packages/rfmedia-cli/src/actions/verify-filter.ts`   | Filter evaluation, flat/structured/album layouts, duplicate mapping, repair orchestration        | Independent tier/status semantics                               |
| `packages/rfmedia-cli/src/lib/tiered-verification.ts` | Baseline resolution, exhaustive tier dispatch, per-file outcomes, aggregate/unresolved helpers   | Logging, prompting, DB opening, traversal, mutation, exit state |
| `packages/rfmedia-cli/src/lib/integrity.ts`           | Abort-aware SHA-256, bounded direct comparison, before/after handle stability                    | Domain classification and output                                |
| `packages/rfmedia-cli/src/lib/db.ts`                  | Existing-file read-only opener, runtime validation, parameterized candidate query                | Destination derivation and tier selection                       |

The shared verifier consumes already-derived source/destination pairs. This is the correct seam
because album, flat-filter, structured-filter, and filter-album paths have different selection and
layout rules, while evidence gathering and result classification must be identical.

### Data and control contracts

- Add `VerificationTier = "quick" | "default" | "deep"` to
  `packages/rfmedia-cli/src/types/options.ts`; tier is orthogonal to existing `CopyMode`.
- Extend `packages/rfmedia-cli/src/types/results.ts` additively with stable mismatch, coverage,
  instability, and evidence enums. Preserve existing counters and fix fields.
- Model per-file results as a discriminated union so mismatches, unavailable evidence,
  not-applicable checks, instability, and operational failure cannot be conflated.
- Keep full expected/actual hashes out of public results and routine/debug logging.
- Use one `hasUnresolvedVerificationProblems()` helper for text status, machine status, and
  `process.exitCode`; missing, extra, mismatch, unverifiable, unstable, failed repair, and read error
  are nonzero after the repair pass.
- Quick uses regular-file metadata and a documented integer-millisecond mtime policy. Converted
  quick coverage is unavailable because schema v9 records source rather than destination metadata.
- Default validates a runtime-checked 64-character lowercase SHA-256 and streams the final
  destination once.
- Deep performs default first. For independent byte-identical paths it uses fixed buffers,
  short-read-safe offset handling, abort checkpoints, and pre/post open-handle stats. Conversion and
  same-inode paths report hash-only coverage rather than fake independent byte evidence.

## Critical Files Reference

| Path                                                                           | Current role                                          | Architectural change                                                                                               |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/rfmedia-cli/src/commands/verify.ts`                                  | CLI options, mode dispatch, machine output, exit code | Add `--quick`, `--deep`, `--tracking-database`; reject conflicts; project tier/coverage; centralize exit predicate |
| `packages/rfmedia-cli/src/actions/verify-album.ts`                             | Album/suffix traversal, verification, repair, summary | Replace size branch with shared verifier; preload evidence; stage safe repair; recheck outcomes                    |
| `packages/rfmedia-cli/src/actions/verify-filter.ts`                            | Flat/structured/album filter verification and repair  | Route all three loops through shared verifier; preserve deterministic destination mapping                          |
| `packages/rfmedia-cli/src/lib/tiered-verification.ts`                          | New file                                              | Pure tier policy, exact baseline resolver, outcome/aggregate helpers                                               |
| `packages/rfmedia-cli/src/lib/tiered-verification.test.ts`                     | New file                                              | Tier matrix, conversion/hardlink/range/legacy/unstable/cancellation coverage                                       |
| `packages/rfmedia-cli/src/lib/integrity.ts`                                    | Streaming hash and two-hash comparison                | Add optional signal, direct compare, regular-file and stability evidence; stop logging full digests                |
| `packages/rfmedia-cli/src/lib/integrity.test.ts`                               | Integrity unit tests                                  | Real-file short-read/EOF/difference/abort/mutation/cleanup coverage                                                |
| `packages/rfmedia-cli/src/lib/db.ts`                                           | Mutable DB initialization and inventory CRUD          | Add purpose-built read-only opener and exact destination-bound fingerprint query                                   |
| `packages/rfmedia-cli/src/lib/db.test.ts`                                      | Schema/CRUD/migration tests                           | Prove no writes/WAL/migration, deterministic identity, null/malformed/ambiguous handling                           |
| `packages/rfmedia-cli/src/lib/config.ts`                                       | `resolveUndoDatabasePath()` precedence                | Reuse explicit/config/default resolution; do not alter general config loading                                      |
| `packages/rfmedia-cli/src/lib/verify.ts`                                       | Expected converted names, extras, size helper         | Retain expected-set utilities; keep size helper only for compatibility                                             |
| `packages/rfmedia-cli/src/lib/parallel.ts`                                     | Bounded file scheduling and signal propagation        | Reuse unchanged as the outer concurrency boundary                                                                  |
| `packages/rfmedia-cli/src/types/options.ts`                                    | `VerifyOptions`                                       | Add tier and optional tracking database                                                                            |
| `packages/rfmedia-cli/src/types/results.ts`                                    | `VerifiedFile`, statuses, command/fix result          | Add evidence-aware discriminated statuses and aggregate coverage fields                                            |
| `packages/rfmedia-cli/src/types/db.ts`                                         | `DbInventoryEntry`                                    | Add typed joined fingerprint candidate DTO if not kept private to `db.ts`                                          |
| `packages/rfmedia-cli/src/types/index.ts`                                      | Public type barrel                                    | Export new tier/result contracts                                                                                   |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`                       | Bash template                                         | Add all three new verify options                                                                                   |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`                        | Zsh template                                          | Add options, descriptions, and tier conflict-aware metadata where practical                                        |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`                       | Fish template                                         | Add all three new verify options                                                                                   |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`             | Completion parity tests                               | Assert Bash/Zsh/Fish expose the same verify surface                                                                |
| `packages/rfmedia-cli/benchmarks/verify.bench.ts`                              | Existence/size microbenchmarks                        | Compare identical quick/default/deep workloads and representative media bytes                                      |
| `packages/rfmedia-cli/benchmarks/helpers.ts`                                   | Benchmark fixture/options helpers                     | Create inventory-backed tier fixtures and controlled media sizes                                                   |
| `packages/rfmedia-cli/src/actions/verify-album.test.ts`                        | Album repair/conflict tests                           | Add action aggregation, exact baseline, safe repair, and post-recheck tests                                        |
| `packages/rfmedia-cli/src/actions/verify-filter.test.ts`                       | Filter repair/conflict tests                          | Add duplicate/layout/range/conversion coverage with the shared contract                                            |
| `packages/rfmedia-cli/src/cli.test.ts`                                         | CLI contract tests                                    | Add default/conflict/path/output/exit tests                                                                        |
| `packages/rfmedia-cli/docs/features/verify-command.doc.md`                     | Verify user guide                                     | Document promises, coverage, examples, and output                                                                  |
| `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`                    | Repair guide                                          | Document evidence-aware staged repair and refusal cases                                                            |
| `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md` | Baseline producer contract                            | Link stored fingerprints to the default/deep consumer semantics                                                    |
| `docs/features/file-integrity-verification.md`                                 | Repository-level integrity guide                      | Align copy-time and read-time terminology                                                                          |
| `packages/rfmedia-cli/README.md`                                               | Main CLI reference                                    | Add tier flags, limitations, machine fields, and examples                                                          |
| `ROADMAP.md`                                                                   | Project status                                        | Mark #116 shipped only with final PR/merge evidence                                                                |

`packages/rfmedia-cli/src/lib/schema.sql` and `packages/rfmedia-cli/src/lib/migrations.ts` are explicit
non-touch files for this feature.

## Cross-Cutting Concerns

### Evidence identity and trust

- Baselines are local write-time integrity evidence, not authenticity. An actor able to rewrite both
  media and inventory remains outside the guarantee.
- Open the configured database with `fileMustExist`, read-only/query-only behavior, and schema
  validation only. Do not call `initializeDatabase()` from ordinary verification.
- Validate external DB values at runtime: regular paths, contained relative paths, supported
  conversion key, integer metadata, and `/^[a-f0-9]{64}$/` hashes.
- Derive expected paths from command scope. Inventory paths may confirm an exact identity but may
  never redirect reads or repairs outside the selected destination.
- Exact destination plus source/conversion identity is mandatory. Ambiguity and unrepresented ranged
  outputs produce coverage failure, not newest-row guessing.

### Filesystem safety and concurrency

- Reject non-regular or unsafe symlinked artifacts where stable identity cannot be proven. Use open
  handles and compare pre/post stats to detect replacement or mutation during reads.
- Treat observed change as `unstable`, optionally after one bounded retry; never report a match from
  mixed generations.
- Reuse `processInParallel()` and the existing worker cap. Memory remains
  `O(workers * compareChunkSize)`; descriptor use is similarly bounded.
- Hash streams receive `AbortSignal`; manual compare loops check cancellation between short-read-safe
  chunks and close both handles in `finally`.
- More workers can reduce throughput on HDD/NAS/FUSE. Preserve user control and benchmark rather than
  deriving content-tier concurrency solely from CPU count.

### Repair authority and atomicity

- Diagnosis and repair are separate stages. Tier selection does not broaden `--fix`, `--force`,
  `--trash`, or conflict-strategy authority.
- For hash/content mismatch, prove the source (or regenerated conversion) can reproduce the stored
  baseline before replacing the destination.
- Write a private sibling temporary artifact, verify it, revalidate destination containment/identity,
  atomically replace where supported, and re-run the selected tier on the final path.
- Preserve the original on every pre-commit error. Changed hardlinks and non-reproducible conversions
  are safe refusal cases, not opportunities to rebaseline.
- Update aggregates from post-repair outcomes; remove the current copied/removed counter arithmetic.

### Result, output, and compatibility

- Keep album/filter mode and verification tier as separate machine fields.
- Preserve current result fields additively; add stable reason/evidence/coverage enums and deterministic
  problem ordering.
- `not-applicable` is visible coverage and can coexist with success when the stored-hash guarantee
  passes; `unverifiable` cannot.
- Human progress stays on stderr and machine stdout remains prose-free. Quick progress is file-based;
  content tiers can be byte-based.
- Full hashes are never emitted. Bound and sanitize OS error text; detailed paths remain privacy-
  sensitive operational data.
- Retain `--verify-size` temporarily as an additive compatibility precheck. It must not select or
  weaken a tier or create a hidden fourth evidence mode.

### Performance and validation

- Extend the existing benchmark harness; do not add a dependency or flaky 10x timing assertion to CI.
- Compare identical expected sets, destination fixtures, inventory state, workers, filesystem/cache
  state, and media-sized byte volume. Report files/s for quick and MiB/s for default/deep.
- Validate library primitives first, then album/filter integration, CLI/machine contracts,
  completions, docs, and the full package/repository gates.
- After implementation, run `graphify update .` as required by repository policy.

## Parallelization Opportunities

Parallel work is safe only after the tier/outcome/baseline contracts are frozen.

| Batch | Parallel lane             | Scope                                                                | Dependency / collision note                                                    |
| ----- | ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1     | Types and pure policy     | `types/{options,results,index}.ts`, new `lib/tiered-verification.ts` | Contract owner lands first; other lanes consume it                             |
| 1     | Integrity primitives      | `lib/integrity.ts`, `lib/integrity.test.ts`                          | Independent of SQL and traversal after input/output signature is fixed         |
| 1     | Read-only evidence access | `lib/db.ts`, `lib/db.test.ts`                                        | Independent of filesystem algorithms; coordinate DTO ownership with types lane |
| 2     | Album integration         | `actions/verify-album.ts`, matching tests                            | Depends on all Batch 1 contracts; no filter-file overlap                       |
| 2     | Filter integration        | `actions/verify-filter.ts`, matching tests                           | Depends on all Batch 1 contracts; owns duplicate/layout behavior               |
| 2     | CLI/output integration    | `commands/verify.ts`, `cli.test.ts`                                  | Depends on aggregate/unresolved helper; avoid result-type edits here           |
| 3     | Completion surface        | three shell templates and `templates.spec.ts`                        | Independent after flags are final; keep all shells in one lane                 |
| 3     | Benchmarks                | `benchmarks/{verify.bench,helpers}.ts` and evidence artifact         | Depends on implemented tier APIs and DB fixtures                               |
| 3     | Documentation/ROADMAP     | README, feature docs, integrity docs, ROADMAP                        | Depends on final behavior/output names; one owner prevents terminology drift   |

Album and filter integration should not edit the shared policy concurrently. DB and integrity lanes
must not independently invent duplicate status types. Repair changes should stay with their owning
action lane because conflict helpers and relative-path context differ.

## Implementation Constraints

1. Target Node.js 22+, TypeScript ESM/NodeNext, and `.js` import suffixes. Use built-in crypto,
   streams, file handles, buffers, and abort APIs; add no runtime dependency.
2. Preserve the command/action/library split and existing album/filter expected-set algorithms.
   Tier changes evidence, not selection or layout.
3. `--quick` and `--deep` conflict at Commander parse time. Omission means default; do not add
   `--default`.
4. Quick performs no SQLite open and no content read. Its metadata result is freshness evidence, not
   integrity proof; converted quick coverage is unavailable under schema v9.
5. Default requires an exact, runtime-valid, destination-bound stored final-artifact SHA-256 and one
   destination read. Missing evidence never triggers a source-hash fallback.
6. Deep is monotonic with default. Direct comparison is bounded, short-read/EOF correct, abort-aware,
   and stability checked. Converted and same-inode paths expose hash-only/not-applicable coverage.
7. Verification must not create, migrate, journal, backfill, refresh, or otherwise mutate the
   evidence store. Missing/newer/malformed databases produce typed coverage or operational errors.
8. No schema bump, hash index, artifact ledger, algorithm agility, signatures, verification history,
   worker threads, external comparator, or baseline-adoption command belongs in #116.
9. Ranged artifacts without exact inventory identity remain `unverifiable`. Do not borrow a sibling
   destination's fingerprint unless a future artifact model proves independent byte identity.
10. Repair never implicitly rebaselines. It must prove source reproducibility, preserve the original,
    stage and verify, commit safely, and reverify final state.
11. Extra files, missing files, mismatch, unavailable evidence, instability, failures, and failed
    repair are unresolved and nonzero. One predicate drives text, machine status, and exit code.
12. Output additions are backward-compatible and deterministic; no full hashes appear in text,
    debug, JSON, YAML, CSV, or tables.
13. Bash, Zsh, and Fish templates are one public surface and must change together with parity tests.
14. The benchmark's 10x target must identify comparator, fixture sizes, filesystem, cache state, and
    workers. CI runs correctness/smoke coverage, not timing enforcement.
15. Completion requires focused and full tests, typecheck, build, formatting/lint, benchmark evidence,
    docs/ROADMAP, graph refresh, formal review/fix, green CI, squash merge, and branch/worktree cleanup.
