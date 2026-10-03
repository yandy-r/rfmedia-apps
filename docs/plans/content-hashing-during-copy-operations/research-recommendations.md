# Content Hashing During Copy Operations: Recommendations

## Executive Summary

Treat issue [#111](https://github.com/yandy-r/rfmedia-apps/issues/111) as an audit-and-close feature,
not a greenfield implementation. PR [#233](https://github.com/yandy-r/rfmedia-apps/pull/233) already
merged the correct foundation: schema version 9, nullable `inventory.content_hash`, prepared
single/batch writes, typed retrieval, one-pass SHA-256 for regular album copies, final-destination
hashing for conversions/filter/sync, action tests, and a benchmark seam. The issue remains open
because that PR used `N/A` instead of `Closes #111`, and `ROADMAP.md` still lists hashing as pending.

The closing change should preserve the existing architecture and make only bounded, evidence-driven
hardening changes:

1. reject a newer SQLite schema before executing schema SQL;
2. clean partial outputs on exhausted copy/hash retries and propagate cancellation through hashing;
3. validate every non-null digest at the shared inventory write boundary;
4. prove copy/hash/DB/completion ordering with focused failure tests;
5. rerun a like-for-like benchmark with repeated representative samples and report the result
   honestly rather than relying on the prior noisy “hashing was faster” sample;
6. document that the stored value is a write-time SHA-256 fingerprint, not destination read-back
   verification;
7. update user documentation and every #111 location in `ROADMAP.md`;
8. open a template-compliant PR carrying `Closes #111`, review/fix it, obtain green CI, squash merge,
   and clean up the worktree/branch.

Bound the release to the inventory-backed copy foundation already implemented: direct album/filter
`rfmedia copy` and `rfmedia sync`, plus queue/MCP routes that delegate to those top-level actions.
Do not turn the closeout into a new artifact-ledger project, a Plex/playlist rewrite, tiered
verification, deduplication, conversion caching, or full-library backfill. `rfmedia watch`,
`rfmedia plex copy`, playlist export/sync, repair writes, and video linking need an explicit durable
operation identity before they can store equivalent rows; create a child/follow-up only if the issue
owner requires those surfaces in the literal “every copy call” interpretation.

No CLI flag, output field, MCP schema, or shell completion changes are needed. Hash persistence stays
quiet and internal. `--verify` remains the opt-in immediate source/destination check; issue #116 owns
read-time comparison against stored hashes.

## Implementation Recommendations

### 1. Freeze the release contract

Use the following acceptance contract for #111:

- every successful, non-dry-run file represented by an in-scope SQLite inventory row has a non-null
  lowercase SHA-256 matching `/^[a-f0-9]{64}$/`;
- the digest represents final destination bytes after conversion, not the source encoding;
- plain-copy streaming fingerprints the bytes submitted to the destination writer; it is not called
  “verified” until a later destination read compares with the stored value;
- hardlinks store a snapshot fingerprint and may become stale if any linked path is modified later;
- existing v8/v9 databases and omitted/`NULL` legacy hashes remain readable; no automatic backfill;
- copy, conversion, hash, database, or cancellation failure does not mark the affected item/source
  completed;
- dry-run performs no hash read, file write, migration, or inventory write;
- normal text and machine output remain backward-compatible and do not print digests.

Document two intentional exceptions: disabling database/completed tracking or selecting legacy
tracking provides no SQLite inventory row, and separate copy-like command families without an
inventory operation are not retrofitted in this release. This is preferable to silently opening a
second database lifecycle or inventing provenance.

### 2. Keep the existing technology and schema

- Retain `node:crypto::createHash("sha256")`, `Transform`, and `pipeline()`; add no hashing package,
  worker pool, external command, or algorithm option.
- Retain schema version 9 and nullable `inventory.content_hash`. Do not create schema version 10 just
  to rename or restate an existing column.
- Retain lowercase 64-character hex `TEXT`, not a BLOB or `sha256:` prefix. Treat the algorithm as a
  fixed v9 contract.
- Retain `recordInventoryFile()`, transactional `recordInventoryFiles()`, `getInventory()`, and
  `getInventoryForSource()` as the storage/retrieval boundary.
- Do not add a hash index yet. No current #111 query filters on `content_hash`; issue #38/#120 should
  add a measured partial index with the first real lookup.
- Prefer `INSERT ... ON CONFLICT DO UPDATE` over `INSERT OR REPLACE` only if a focused audit shows row
  identity/trigger behavior matters now. Otherwise avoid unrelated database churn in this closeout.

The existing `inventory` uniqueness and `Map<relativePath, entry>` model retain one logical inventory
record per source-relative item/operation rather than a durable row for every ranged destination.
Changing that is a one-to-many domain migration, not a hash-column hardening. Do not smuggle it into
issue #111. If later verification must enumerate every range/Plex/playlist artifact, create a dedicated
destination-artifact child issue with its own schema, migration, retention, and consumer design.

### 3. Apply minimal code hardening

#### Filesystem/hash boundary

In `packages/rfmedia-cli/src/lib/filesystem.ts`:

- pass the action `AbortSignal` to `pipeline()`;
- create fresh streams, `Transform`, and `Hash` for every retry attempt;
- ensure a failed final attempt removes only the newly created/partial destination before rethrowing;
- preserve the original error code/stage where possible rather than converting abort into an
  undifferentiated filesystem error;
- keep timestamp restoration after a successful pipeline;
- add a signal-aware final-file hash helper only if required by hardlink/conversion callers.

Do not introduce atomic temp-file replacement in this issue unless tests show the current overwrite
path can safely adopt it without ownership/mode/history regressions. Deterministic partial cleanup is
the bounded fix; symlink-resistant transactional file replacement deserves a separate filesystem
hardening change.

#### Database compatibility and validation

In `packages/rfmedia-cli/src/lib/db.ts` / `migrations.ts`:

- for an existing database, read `metadata.schema_version` before executing `schema.sql`; close and
  reject versions greater than `CURRENT_SCHEMA_VERSION` without changing tables/indexes;
- distinguish a new/unversioned database from a malformed versioned database;
- validate non-null `contentHash` at both shared inventory write APIs; reject wrong length,
  non-lowercase, and non-hex values rather than storing ambiguous integrity data;
- keep all values positionally bound and all batch writes in the existing synchronous transaction;
- never downgrade a hash/DB failure into `NULL` for a newly successful tracked copy.

The earlier v8-to-v9 migration remains correct: inspect `PRAGMA table_info(inventory)`, add the
nullable column only if absent, then set version 9. Existing rows stay `NULL`.

#### Action ordering

Audit `copy-album.ts`, `copy-filter.ts`, and `sync.ts` for the ordering:

`write/convert -> finalize digest -> inventory write -> completion marker/result success`.

Move only statements that violate this order. Do not refactor all duplicated copy branches into a
new service during closeout. Plugin `afterCopy` hooks should be documented as observational for this
contract; if plugins are allowed to mutate destination bytes, capture that as a child issue because
post-hook rehashing changes performance and hook failure semantics across every copy action.

### 4. Add proof-oriented tests

Required focused coverage:

- `lib/filesystem.test.ts`: known streamed digest, bounded memory behavior, cancellation, retry with
  fresh hash state, final failure cleanup, hardlink digest;
- `lib/integrity.test.ts`: known lowercase digest and read-error/abort propagation;
- `lib/db.test.ts`: new schema version 9, v8 migration, existing v9 open, newer-version rejection
  without `sqlite_schema` mutation, present/`NULL` retrieval, malformed hash rejection, batch write;
- `lib/inventory.test.ts`: DB and JSONL present/null/omitted hash mapping;
- `actions/copy-album.test.ts`: regular, hardlink, conversion, dry-run, hash failure before completion,
  and DB failure before completion;
- `actions/copy-filter.test.ts`: final destination hash for copy/conversion, accepted existing path,
  dry-run, hash/DB failure;
- sync coverage in its existing test location: final destination hash and no row on failure/dry-run.

Queue and MCP need delegation assertions only; do not duplicate the entire action matrix. Watch,
Plex copy, playlists, verify repair, and link-videos should appear in a documented scope audit, not
in release-blocking hash tests unless explicitly pulled into #111.

### 5. Produce meaningful performance evidence

Retain the benchmark-only `benchmarkDisableContentHashing` escape hatch; never expose it in CLI or
config. Compare the identical database-tracked copy path with hashing disabled/enabled using:

- the same source corpus, destination filesystem, database mode, worker count, overwrite policy,
  warmup, and iteration count;
- representative small-file and media-sized-file cases;
- repeated samples with median, spread, throughput, and peak RSS;
- direct copies as the issue's `<5%` acceptance workload;
- hardlinks and conversions reported separately because hashing turns a hardlink into a full read
  and conversion requires a final output read.

Do not add a flaky timing assertion to CI. Record raw command/configuration and results in the
implementation report. If the direct-copy median is above 5%, profile before changing buffers or
concurrency. If variance crosses the threshold, report the result as inconclusive and rerun on a
controlled local filesystem; never claim success because one hash-enabled sample happened to be
faster.

### 6. Complete documentation and repository surfaces

- Update `packages/rfmedia-cli/README.md` or the canonical integrity/tracking feature guide with the
  write-time fingerprint contract, tracking prerequisites, legacy `NULL`, hardlink snapshot
  semantics, conversion behavior, failure behavior, and distinction from `--verify`.
- Update all three current #111 references in `ROADMAP.md`: “What's unblocked,” Sprint 2 order, and
  high-priority backlog. Mark shipped and link the closing PR, while crediting PR #233 as the initial
  implementation.
- Update the implementation report/plan artifacts only if the planning workflow requires current
  validation evidence; do not rewrite historical PR #233 results as though they were produced now.
- Use `.github/pull_request_template.md` exactly and include the precise test/benchmark commands plus
  `Closes #111` under `## Related Issues`.
- Do not edit Bash, Zsh, or Fish completion templates. No command or option changes. Run completion
  template tests through the normal suite as regression evidence.
- Run `graphify update .` after code changes when `graphify-out/graph.json` is available. The feature
  worktree currently lacks that graph file, so this should not block implementation or cause files
  to be copied from another checkout.

## Improvement Ideas (Deferred)

- A destination-artifact table keyed per final path, supporting multiple range outputs from one
  source and explicit method/provenance.
- Hash persistence for watch, Plex query copy, playlist export/sync, verify repair, and link-videos
  after those surfaces have a shared durable operation identity.
- Read-time quick/default/deep verification, unknown-hash UX, stale hardlink detection, repair policy,
  and verification timestamps under issue #116.
- Content-hash dedup queries/indexes and advisory duplicate reporting under issues #38/#120.
- Conversion cache keys based on source hash + format + quality.
- Full-library or legacy-row backfill/adoption command.
- Algorithm agility, signed manifests, keyed hashes, or authenticity guarantees.
- Atomic same-directory temporary writes, symlink-resistant path traversal, and stable file-handle
  identity checks as general filesystem-hardening work.
- Worker-thread hashing, custom stream buffers, or hash reuse across range copies only after profiling
  proves the existing streaming path is the bottleneck.
- New hash output fields, MCP inventory tools, or user-facing `--hash`/`--no-hash` controls.

## Risk Assessment

| Risk                                                      | Likelihood | Impact | Release mitigation                                                               |
| --------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------- |
| Existing PR #233 behavior is reimplemented inconsistently | Medium     | High   | Audit current master; retain schema/API; make surgical changes only              |
| Partial file remains after copy/hash failure              | Medium     | High   | Helper-owned cleanup, retry-state tests, no completion/inventory success         |
| Newer database is mutated before rejection                | Low        | High   | Preflight schema version before schema execution; immutability regression test   |
| Stored digest is malformed or ambiguous                   | Low        | Medium | Shared `/^[a-f0-9]{64}$/` validation; nullable only for legacy rows              |
| Hash is described as read-back verification               | Medium     | High   | Precise docs/types; issue #116 owns destination comparison                       |
| Converted file stores source/pre-final hash               | Low        | High   | Hash final output; focused conversion test                                       |
| DB write succeeds/fails out of order with completion      | Medium     | High   | Enforce and test write -> hash -> inventory -> completion ordering               |
| Benchmark gives false confidence                          | High       | Medium | Repeated like-for-like representative samples; report variance/raw setup         |
| Hardlink overhead violates a global 5% claim              | High       | Medium | Separate hardlink results; scope 5% acceptance to byte-copy workload             |
| Full hashes/paths leak through logs                       | Low        | Medium | No routine digest output; bounded diagnostics; document debug path exposure      |
| Broader copy surfaces remain unhashed                     | High       | Medium | Explicit scope statement; child issue only if required, no false universal claim |
| Scope expands into artifact ledger/downstream consumers   | Medium     | High   | Defer one-to-many schema, indexing, verification, dedupe, and backfill           |
| Shell completion drift is introduced unnecessarily        | Low        | Low    | No template edits; run existing parity/snapshot tests                            |

## Alternative Approaches

| Approach                                              | Advantages                                                  | Drawbacks                                                                      | Recommendation                                       |
| ----------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Audit and harden current PR #233 implementation       | Small diff, preserves compatibility, fastest credible close | Requires disciplined scope language and current evidence                       | **Choose**                                           |
| Close #111 with docs/ROADMAP only                     | Minimal code                                                | Leaves known cleanup/future-schema/validation gaps unaddressed                 | Reject unless focused audit proves no actionable gap |
| Reimplement from the original issue's suggested files | Matches stale issue prose                                   | Paths do not exist; duplicates working modules and migration                   | Reject                                               |
| Add a new generic hasher service/package              | Central API                                                 | Unnecessary abstraction/dependency for one fixed algorithm                     | Reject                                               |
| Always hash destination after every copy              | Stronger final-path semantics                               | Adds full reread and jeopardizes <5% target                                    | Use only for conversion/hardlink/verification        |
| Build destination-artifact ledger in #111             | Literal one-row-per-output model; supports future consumers | New schema/read model, migration, retention, many copy surfaces                | Defer to focused child issue                         |
| Patch every `copyOrLink()` caller now                 | Broad literal coverage                                      | Plex/playlist/watch/repair lack common DB provenance; large regression surface | Defer until operation identity is designed           |
| Add `--no-hash` performance escape hatch              | Operator control                                            | Breaks downstream invariant and multiplies unknown states                      | Reject                                               |
| Add `content_hash` index now                          | Future dedup speed                                          | Current queries do not use it; write cost consumes performance budget          | Defer to first consumer                              |
| Enforce <5% with CI timing gate                       | Automatic regression detection                              | Filesystem/runtime variance makes it flaky and gameable                        | Record benchmark evidence; no hard gate yet          |

## Task Breakdown Preview

### Phase 1: Current-state audit and contract

- Confirm issue #111 body, no current sub-issues, PR #233 merge, schema version, actual copy entry
  graph, and current `ROADMAP.md` references.
- Freeze the bounded acceptance contract and downstream exclusions in the plan.
- Run existing focused tests before edits to establish current behavior.

### Phase 2: Minimal hardening

- Fix `copyOrLinkWithHash()` abort/retry/partial cleanup behavior.
- Preflight newer database schemas before executing `schema.sql`.
- Validate inventory digest format at shared write boundaries.
- Correct only proven action ordering violations in album/filter/sync.

### Phase 3: Tests and performance

- Add focused filesystem, migration, DB validation, inventory, album/filter/sync success/failure tests.
- Run package typecheck, targeted tests, full rfmedia tests, build, root gates, and `git diff --check`.
- Run repeated like-for-like copy benchmarks; capture setup, raw samples, medians, variance, RSS, and
  separate hardlink/conversion observations.

### Phase 4: Documentation and closeout PR

- Update canonical user docs and `ROADMAP.md`; state the exact scope and downstream boundaries.
- Confirm no shell completion template changes are necessary; run existing completion tests.
- Commit intentionally, push the worktree branch, and open a template-compliant PR with
  `Closes #111` and exact validation outcomes.

### Phase 5: Review, CI, merge, and cleanup

- Perform a proper PR review focused on copy/hash/DB ordering, migration safety, cleanup, and
  benchmark claims.
- Fix every actionable review finding, rerun affected/full validation, update the PR, and resolve
  review threads.
- Monitor all required CI until green; distinguish external review latency from code failure.
- Squash merge, verify issue #111 closed and `ROADMAP.md` shipped state landed, remove remote/local
  feature branches, and remove the worktree safely.

## Key Decisions Needed

| Decision                | Recommended choice                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Delivery model          | Audit/harden/close PR #233's current implementation; no rewrite                                   |
| In-scope workflows      | Inventory-backed album/filter `rfmedia copy` and sync; delegated queue/MCP behavior               |
| Broader copy surfaces   | Explicitly deferred unless owner requires a child issue with operation-identity design            |
| Stored meaning          | Expected SHA-256 of final artifact bytes captured at write/finalization time, not read-back proof |
| Algorithm/encoding      | Fixed SHA-256, 64 lowercase hexadecimal characters                                                |
| Schema                  | Keep version 9 nullable `inventory.content_hash`; no backfill or hash index                       |
| New-success nullability | Forbidden for a successful in-scope inventory row; `NULL` is legacy/unknown only                  |
| Copy method             | One-pass streaming for regular copy; final-file read for conversion/hardlink where necessary      |
| Failure ordering        | File finalization -> digest -> inventory -> completion; failure is non-success                    |
| User control            | No hash enable/disable or algorithm flag                                                          |
| Verification            | Existing `copy --verify` stays separate; stored-hash verification belongs to #116                 |
| Performance gate        | Repeated direct-copy median <5% target with honest variance; no flaky CI timing assertion         |
| Logging                 | No full hashes in routine output; keep machine schemas unchanged                                  |
| Completions             | No changes; regression tests only                                                                 |
| Documentation           | Update canonical guide, all ROADMAP references, and use `Closes #111`                             |

## Open Questions

1. Does the issue owner require literal coverage of watch, Plex copy, playlist export/sync, verify
   repair, and link-videos before closing #111? Recommended answer: no; require a separately designed
   destination-artifact child issue if that broader promise is desired.
2. Is one logical inventory row per source-relative file sufficient for the downstream #116
   baseline, or must every ranged destination be queryable? Recommended answer for #111: preserve
   current inventory semantics; design one-to-many artifacts separately if consumers need them.
3. Are `afterCopy` hooks guaranteed observational? If they may mutate destination bytes, decide
   whether to rehash after hooks now or explicitly prohibit mutation in the #111 contract.
4. Should failed database persistence remove a newly created file or leave it for deterministic
   recovery? Recommended answer: remove only when ownership/newness is certain; otherwise report a
   partial failure and rehash/reconcile on retry.
5. Which controlled filesystem and representative fixture define the direct-copy <5% acceptance
   evidence? Record this before claiming the target is met.
6. Is older-code rejection before WAL pragma configuration required to be fully mutation-free, or is
   preventing schema/table/index mutation sufficient? Prefer the strongest practical preflight and
   test the exact guarantee.
