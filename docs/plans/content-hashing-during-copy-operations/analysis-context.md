# Context Analysis: Content Hashing During Copy Operations

## Executive Summary

Issue #111 is a bounded hardening and closeout of the content-fingerprint pipeline shipped in PR
number 233, not a greenfield hashing feature. Preserve schema version 9 and the current album/filter/sync
inventory architecture while adding pre-DDL future-schema rejection, shared digest validation,
signal-aware one-pass copy hashing with ownership-bounded cleanup, proof-oriented tests, credible
performance evidence, corrected documentation, and a PR that closes the issue.

The authoritative scope is `feature-spec.md` and `shared.md`. Broader research proposals for a new
artifact ledger, per-range destination rows, watch/Plex/playlist coverage, hash indexes, backfill, or
read-time verification are explicitly deferred and must not enter the implementation plan.

## Architecture Context

- **System Structure**: CLI (`commands/copy.ts`), queue (`actions/queue.ts`), and MCP
  (`mcp/adapters.ts`) delegate to the inventory-owning actions in `copy-album.ts`, `copy-filter.ts`,
  and `sync.ts`. Those actions coordinate filesystem/conversion work, inventory persistence,
  completion tracking, hooks, bounded parallelism, and cancellation.
- **Hashing Boundaries**: `lib/filesystem.ts:copyOrLinkWithHash()` hashes ordinary copy bytes through
  a transparent `Transform`; hardlinks and already-materialized outputs require a full-file read.
  `lib/integrity.ts:calculateHash()` hashes final conversion/filter/sync artifacts, while
  `verifyFileIntegrity()` remains the separate opt-in `--verify` read-back comparison.
- **Data Flow**: Enforce `write or convert -> finalize SHA-256 -> persist inventory -> mark
suffix/source complete`. Async filesystem/hash work stays outside synchronous SQLite transactions;
  failures at any stage remain failed/partial operations and cannot silently store `NULL` or advance
  completion.
- **Persistence Model**: `inventory.content_hash TEXT` stays nullable for legacy/unknown rows.
  New successful in-scope SQLite inventory writes require lowercase 64-character SHA-256. Preserve
  the existing operation/source/relative-path identity, one-row-per-source sync semantics, prepared
  single writes, and transactional batch writes.
- **Migration Model**: New databases load `schema.sql`; version 8 databases use the guarded
  `PRAGMA table_info(inventory)` migration; version 9 reopens without churn. Existing future-version
  databases must be inspected and rejected before schema DDL changes them.
- **Public Surface**: Hash persistence is quiet and automatic only when the workflow owns a SQLite
  inventory row. No CLI flag, MCP field, output field, routine hash log, algorithm selector, or shell
  completion edit is required.

## Critical Files Reference

- `docs/plans/content-hashing-during-copy-operations/feature-spec.md`: Authoritative scope,
  invariants, exclusions, acceptance tests, documentation, and delivery contract.
- `packages/rfmedia-cli/src/lib/filesystem.ts`: One-pass copy hash, hardlink fallback, retry state,
  abort propagation, timestamp restoration, and partial-output cleanup.
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`: Deterministic digest, retry, abort, ownership,
  cleanup, and hardlink proof.
- `packages/rfmedia-cli/src/lib/integrity.ts`: Final-file SHA-256 and distinct immediate verification.
- `packages/rfmedia-cli/src/lib/db.ts`: Database initialization plus the shared single/batch inventory
  trust boundary.
- `packages/rfmedia-cli/src/lib/db.test.ts`: Real SQLite schema, v8/v9/future-version behavior,
  digest validation, retrieval, and batch rollback.
- `packages/rfmedia-cli/src/lib/migrations.ts`: `CURRENT_SCHEMA_VERSION = 9` and guarded v8-to-v9
  upgrade.
- `packages/rfmedia-cli/src/lib/schema.sql`: Canonical nullable `content_hash` schema copied into the
  package build.
- `packages/rfmedia-cli/src/lib/inventory.ts`: Database/JSONL mapping of present, `NULL`, and omitted
  `contentHash` values.
- `packages/rfmedia-cli/src/actions/copy-album.ts`: Streaming/conversion/hardlink hashes, batch
  inventory, and suffix completion ordering.
- `packages/rfmedia-cli/src/actions/copy-filter.ts`: Final-destination hashing and single-row
  persistence across accepted copy branches.
- `packages/rfmedia-cli/src/actions/sync.ts`: Incremental final-destination hash for the existing
  one-row-per-source inventory model.
- `packages/rfmedia-cli/src/actions/queue.ts` and `packages/rfmedia-cli/src/mcp/adapters.ts`: Delegated
  entry points requiring regression coverage only.
- `packages/rfmedia-cli/benchmarks/copy.bench.ts`: Hash-disabled tracked baseline versus identical
  tracked copy with hashing enabled.
- `packages/rfmedia-cli/README.md` and
  `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`: Canonical but stale user and
  database documentation requiring correction.
- `packages/rfmedia-cli/docs/features/graceful-interruption.md` and
  `packages/rfmedia-cli/docs/features/performance-benchmarks.md`: Cancellation/cleanup and benchmark
  contracts affected by hardening.
- `docs/features/file-integrity-verification.md` and
  `docs/features/file-integrity-quick-reference.md`: Preserve the distinction between fingerprints
  and `--verify`.
- `ROADMAP.md` and `.github/pull_request_template.md`: Required shipped-state and issue-closing PR
  surfaces.

## Patterns to Follow

- **Surgical vertical-slice hardening**: Extend the existing command -> action -> filesystem ->
  inventory -> SQLite -> completion path; do not add a hasher service or second copy pipeline.
- **Transparent one-pass hashing**: Create fresh streams, `Hash`, and pass-through `Transform` inside
  each retry callback; await `pipeline(..., { signal })` before calling `digest("hex")`.
- **Final-artifact hashing**: Hash converted outputs after FFmpeg succeeds and hardlinks after link
  creation. Never substitute a source digest for bytes that may differ at the destination.
- **Layer discipline**: Filesystem helpers materialize/hash, inventory helpers map metadata, DB
  helpers validate/persist, and actions own orchestration and completion order. Do not hide file I/O
  in inventory/DB APIs or database work in filesystem helpers.
- **Prepared synchronous writes**: Keep positional SQL binding and short `better-sqlite3`
  transactions. Validate each batch entry inside the transaction so a later malformed digest rolls
  back earlier inserts.
- **Nullable legacy mapping**: Preserve snake_case `content_hash` in DB types and optional/nullable
  camelCase `contentHash` in portable inventory; `NULL` means unknown, never mismatch or empty file.
- **Guarded migration**: Inspect existing metadata/schema before mutation, close the connection on
  initialization failure, and retain the idempotent v8 column check.
- **Real-resource tests**: Use temporary files for stream/hash behavior and temporary SQLite databases
  for migration/transaction behavior; use focused mocks only for deterministic failure ordering.
- **Delegation tests**: Prove queue/MCP route to shared actions without duplicating the filesystem
  test matrix.
- **Like-for-like benchmarks**: Hold fixture, filesystem, tracking mode, worker count, overwrite
  policy, warmup, and iterations constant; keep the hash-disable seam benchmark-only.

## Cross-Cutting Concerns

- **Failure and recovery**: Cancellation, exhausted retries, hash errors, and DB errors must leave no
  inventory or completion success. Cleanup may remove only a destination proven newly created by the
  helper; preserve the primary error if best-effort cleanup also fails.
- **Database safety**: Future-schema rejection must be demonstrably mutation-free before DDL.
  Malformed non-null hashes must be rejected at both public inventory write APIs, with atomic batch
  rollback.
- **Concurrency**: Hash work remains inside existing bounded copy workers. SHA-256 updates are
  synchronous CPU work, SQLite permits one writer, and no separate worker/hash pool is authorized.
- **Semantics**: Stored hashes are expected write/finalization-time fingerprints, not authenticity or
  destination read-back proof. Hardlink fingerprints are snapshots and can become stale.
- **Compatibility**: Dry-run performs no copy, hash, migration, or inventory write. Legacy/disabled
  tracking opens no hidden hash database. Historical rows remain `NULL`; there is no automatic
  backfill.
- **Performance**: Evaluate the `<5%` target on repeated direct byte-copy samples. Report hardlink
  and conversion costs separately, include variance/throughput/peak memory, and add no timing gate to
  CI.
- **UX and security**: Preserve normal text/machine output and exit conventions; do not expose full
  digests in routine logs. Continue using built-in crypto, streams, prepared SQL, and existing
  unprivileged filesystem authority.
- **Documentation consistency**: Correct stale sync-only/schema-v1 claims and use “fingerprint” for
  persistence versus “verification” for read-back. Preserve #116 as the downstream verification
  feature.

## Parallelization Opportunities

- **Independent core tracks**: Database preflight/digest validation and filesystem abort/retry/cleanup
  can be implemented and unit-tested in parallel because they touch separate modules.
- **Independent evidence track**: Documentation inventory and draft updates can proceed alongside
  core code once terminology and scope are frozen; final behavior claims wait for validation.
- **After core helpers land**: Album/filter/sync ordering audits and focused action tests can run in
  parallel by action file, each consuming the shared DB/filesystem contracts.
- **Delegation/completion regression**: Queue/MCP and shell-completion tests are independent of action
  implementation and can run alongside documentation closeout.
- **Sequential gates**: Benchmark evidence depends on the finalized filesystem path; comprehensive
  validation depends on merged code/tests; ROADMAP closeout PR links, review/CI, squash merge, issue
  closure, and worktree cleanup are necessarily sequential delivery steps.

## Implementation Constraints

- Keep Node.js 22 built-ins and pinned `better-sqlite3`; add no runtime dependency, external hashing
  command, SQLite extension, ORM, migration framework, or worker pool.
- Keep `CURRENT_SCHEMA_VERSION = 9`, nullable `inventory.content_hash TEXT`, existing unique keys,
  and existing read APIs. Add no table, constraint rebuild, hash index, backfill, or schema version.
- Do not implement one-to-many destination storage, Plex/playlist/repair/video-link provenance,
  tracking-disabled watch persistence, read-time tiers, dedupe, cache keys, algorithm agility,
  authenticity, or atomic replacement.
- Do not add `--hash`, `--no-hash`, an algorithm selector, machine-output fields, MCP schema fields,
  or completion content changes.
- Keep async file work outside synchronous transactions and do not convert current action branches
  into a new service abstraction unless a focused test proves a required gap.
- Preserve exact final destination semantics for conversion, hardlink, conflict rename/overwrite,
  accepted existing files, and sync's represented destination.
- Use deterministic cancellation/failure seams rather than flaky timer races or CI wall-clock
  thresholds.
- Run focused tests first, then rfmedia typecheck/tests/build, shell-completion parity, repository
  gates, benchmark evidence, and `git diff --check`.
- Final delivery must use the repository PR template, include exact command outcomes and
  `Closes #111`, pass review and CI, squash merge, verify issue closure, and clean the branch/worktree.

## Key Recommendations

1. Freeze the bounded feature-spec contract and audit PR #233's implementation before editing.
2. Implement database preflight and shared digest validation with real SQLite immutability/rollback
   tests.
3. Harden `copyOrLinkWithHash()` for active abort, fresh retry state, and helper-owned partial cleanup
   with deterministic stream/file tests.
4. Audit album, filter, and sync ordering after the shared boundaries are stable; change only proven
   violations and add failure-before-completion tests.
5. Run paired repeated benchmarks and state pass/inconclusive honestly; do not optimize buffers,
   concurrency, or hash reuse without profiling.
6. Update canonical hash/tracking/interruption/performance/verification docs and all #111 ROADMAP
   references without rewriting PR #233's historical artifacts.
7. Validate the full repository contract, open a template-compliant issue-closing PR, address review
   findings, wait for green CI, squash merge, and clean up.
