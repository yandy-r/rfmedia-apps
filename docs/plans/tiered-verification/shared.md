# Tiered Verification

Issue #116 adds an evidence-policy layer to the existing `rfmedia verify` album and filter traversals. The command resolves quick, default, or deep verification; the actions retain expected-path mapping, extra detection, progress, and repair orchestration; and a new framework-free verifier owns exact baseline resolution, per-file classification, aggregation, and the final unresolved predicate. Quick compares regular-file size and integer-millisecond mtime without SQLite or content reads, default hashes the destination against an exact schema-v9 final-artifact fingerprint, and deep adds bounded direct comparison only for independent byte-identical files. Verification is read-only and fail-closed: unavailable or ambiguous historical evidence remains `unverifiable`, schema version 9 is unchanged, and repair must reproduce the original baseline, stage safely, and reverify the committed destination.

## Relevant Files

- `packages/rfmedia-cli/src/commands/verify.ts`: Resolves tier, database path, machine output, and exit status.
- `packages/rfmedia-cli/src/actions/verify-album.ts`: Owns album/range traversal and evidence-safe repair orchestration.
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: Owns flat, structured, and album-filter traversal and repair.
- `packages/rfmedia-cli/src/lib/integrity.ts`: Streaming SHA-256 and bounded stable byte-comparison primitives.
- `packages/rfmedia-cli/src/lib/db.ts`: Adds an existing-file read-only opener and prepared candidate query.
- `packages/rfmedia-cli/src/lib/filesystem.ts`: Provides safe staged replacement for integrity repair.
- `packages/rfmedia-cli/src/lib/verify.ts`: Holds shared deterministic destination-name and extra-file helpers.
- `packages/rfmedia-cli/src/types/options.ts`: Defines the effective verification tier and database option.
- `packages/rfmedia-cli/src/types/results.ts`: Defines additive evidence-aware file and aggregate outcomes.
- `packages/rfmedia-cli/src/types/db.ts`: Defines the joined inventory fingerprint candidate DTO.
- `packages/rfmedia-cli/benchmarks/verify.bench.ts`: Measures identical quick, default, and deep workloads.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Enforces Bash, Zsh, and Fish option parity.
- `ROADMAP.md`: Records issue #116 delivery only after implementation and PR evidence exist.

## Relevant Tables

- `metadata`: Supplies the schema version validated without mutation before content-tier reads.
- `operations`: Supplies producer and `convert_key` identity joined through `inventory.operation_id`.
- `inventory`: Supplies source identity, exact `dest_path`, nullable final-output hash, and ordering data.

The unique inventory key is `(operation_id, source_path, relative_path)`, so one row cannot prove every historical ranged destination. Exact normalized destination, source, relative-path, and conversion identity are mandatory; missing, null, malformed, duplicate, or unrepresented evidence fails as `unverifiable` rather than falling back to a related row.

## Relevant Patterns

**Command/action/library separation**: Commander parsing and global output remain in the command, traversal and authorization remain in actions, and reusable evidence policy stays in `packages/rfmedia-cli/src/lib/tiered-verification.ts`. See [`packages/rfmedia-cli/src/commands/verify.ts`](../../../packages/rfmedia-cli/src/commands/verify.ts) and [`packages/rfmedia-cli/src/actions/verify-album.ts`](../../../packages/rfmedia-cli/src/actions/verify-album.ts).

**Prepared read-only database access**: Verification uses positional SQL and an existing-file read-only connection rather than the mutating initializer. See [`packages/rfmedia-cli/src/lib/db.ts`](../../../packages/rfmedia-cli/src/lib/db.ts).

**Bounded cancellable I/O**: Hash streams and fixed-buffer comparison receive `AbortSignal`, use open-handle before/after stats, and close in `finally`. See [`packages/rfmedia-cli/src/lib/integrity.ts`](../../../packages/rfmedia-cli/src/lib/integrity.ts) and [`packages/rfmedia-cli/src/lib/parallel.ts`](../../../packages/rfmedia-cli/src/lib/parallel.ts).

**Additive typed results**: Existing counters and fix fields remain while tier, mismatch, coverage, and instability fields are added. One helper drives human completion, machine status, and process exit. See [`packages/rfmedia-cli/src/types/results.ts`](../../../packages/rfmedia-cli/src/types/results.ts).

**Evidence-preserving repair**: Existing prompt and conflict authority is retained, but content repair proves reproducibility, writes a private sibling artifact, validates it, atomically commits, and re-runs the selected tier. See [`packages/rfmedia-cli/src/actions/verify-filter.ts`](../../../packages/rfmedia-cli/src/actions/verify-filter.ts) and [`packages/rfmedia-cli/src/lib/filesystem.ts`](../../../packages/rfmedia-cli/src/lib/filesystem.ts).

## Relevant Docs

**`docs/plans/tiered-verification/feature-spec.md`**: You _must_ read this for accepted tier, coverage, repair, output, privacy, and benchmark behavior.

**`docs/plans/tiered-verification/research-recommendations.md`**: You _must_ read this for adopted decisions and explicitly deferred artifact-ledger work.

**`docs/plans/tiered-verification/research-security.md`**: You _must_ read this for database, path, concurrent-mutation, hash-privacy, and repair trust boundaries.

**`docs/plans/tiered-verification/analysis-architecture.md`**: You _must_ read this for component ownership, integration order, and non-touch files.

**`packages/rfmedia-cli/docs/features/verify-command.doc.md`**: You _must_ read this when changing command behavior, human output, machine fields, or exit status.

**`packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`**: You _must_ read this when changing repair authorization, refusal, staging, or recheck behavior.

**`packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`**: You _must_ read this for the issue #111 final-artifact fingerprint producer contract.

**`packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`**: You _must_ read this for schema-v9 inventory semantics and configured database paths.

**`docs/features/file-integrity-verification.md`**: You _must_ read this when distinguishing copy-time read-back verification from later tiered verification.

**`packages/rfmedia-cli/docs/features/performance-benchmarks.md`**: You _must_ read this before recording the quick/default/deep benchmark methodology and evidence.
