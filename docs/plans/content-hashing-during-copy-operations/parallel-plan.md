# Content Hashing During Copy Operations Implementation Plan

Close issue #111 by hardening and proving the schema-version-9 content-fingerprint vertical slice
initially shipped in PR #233. Preserve the existing album/filter/sync inventory architecture while
adding pre-DDL future-schema rejection, shared digest validation, signal-aware one-pass hashing with
ownership-bounded cleanup, and focused ordering tests. Then produce honest performance evidence,
correct stale user/database documentation, update every roadmap entry, and finish the complete
PR-review-CI-squash-merge-cleanup lifecycle without adding a CLI/MCP/completion surface or a new
schema/artifact model.

## Worktree Setup

- **Parent**: ~/.claude-worktrees/rfmedia-apps-content-hashing-during-copy-operations/ (branch: feat/content-hashing-during-copy-operations)

## Critically Relevant Files and Documentation

- `docs/plans/content-hashing-during-copy-operations/feature-spec.md`: Authoritative scope and acceptance contract.
- `docs/plans/content-hashing-during-copy-operations/shared.md`: Verified architecture, patterns, tables, and required reading.
- `packages/rfmedia-cli/src/lib/db.ts`: Database initialization and shared inventory persistence trust boundary.
- `packages/rfmedia-cli/src/lib/db.test.ts`: Real SQLite migration, compatibility, validation, and rollback tests.
- `packages/rfmedia-cli/src/lib/migrations.ts`: Version-9 constant and guarded v8 migration to preserve.
- `packages/rfmedia-cli/src/lib/schema.sql`: Existing nullable `content_hash` schema; no planned edit.
- `packages/rfmedia-cli/src/lib/filesystem.ts`: Stream hashing, retry state, hardlinks, aborts, and cleanup.
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`: Real-file digest and deterministic failure coverage.
- `packages/rfmedia-cli/src/lib/integrity.ts`: Final-file SHA-256 and distinct `--verify` behavior.
- `packages/rfmedia-cli/src/actions/copy-album.ts`: Batch inventory and completion ordering.
- `packages/rfmedia-cli/src/actions/copy-filter.ts`: Final-destination hash and per-file inventory ordering.
- `packages/rfmedia-cli/src/actions/sync.ts`: Incremental hash persistence for the represented destination.
- `packages/rfmedia-cli/benchmarks/copy.bench.ts`: Like-for-like tracked-copy benchmark seam.
- `packages/rfmedia-cli/README.md`: Canonical CLI guide with stale sync-only inventory claims.
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`: Stale schema/tracking architecture guide.
- `packages/rfmedia-cli/docs/features/graceful-interruption.md`: Abort and partial-output cleanup contract.
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`: Benchmark methodology contract.
- `docs/features/file-integrity-verification.md`: Existing `--verify` semantics to distinguish.
- `ROADMAP.md`: Three pending #111 references that must become shipped.
- `.github/pull_request_template.md`: Required final PR body structure.

## Implementation Plan

### Phase 1: Shared Safety Boundaries

#### Task 1.1: Preflight Database Compatibility and Validate Digests Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/content-hashing-during-copy-operations/feature-spec.md`
- `packages/rfmedia-cli/src/lib/db.ts`
- `packages/rfmedia-cli/src/lib/db.test.ts`
- `packages/rfmedia-cli/src/lib/migrations.ts`
- `packages/rfmedia-cli/src/lib/schema.sql`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/db.ts`
- `packages/rfmedia-cli/src/lib/db.test.ts`

Add a strict, read-only compatibility preflight for existing SQLite databases before WAL-changing
pragmas, `schema.sql`, or other mutating initialization runs. Allow a genuinely new/empty database, reject malformed
version metadata, reject versions above `CURRENT_SCHEMA_VERSION`, close on every initialization
failure, and leave the guarded v8-to-v9 migration unchanged; avoid a runtime import cycle between
`db.ts` and `migrations.ts`. Snapshot relevant `sqlite_schema` and metadata before/after a rejected
future-version open to prove immutability.

Add one private `/^[a-f0-9]{64}$/` validator used by both `recordInventoryFile()` and
`recordInventoryFiles()`. Preserve omitted/`null` legacy values, positional parameters, and the
synchronous batch transaction. Test valid single/batch persistence; uppercase, wrong-length, and
non-hex rejection; and a mixed invalid batch that commits zero rows. Run the focused DB suite and
package typecheck.

#### Task 1.2: Propagate Stream Cancellation and Bound Partial Cleanup Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/content-hashing-during-copy-operations/feature-spec.md`
- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`
- `packages/rfmedia-cli/src/lib/integrity.ts`
- `packages/rfmedia-cli/docs/features/graceful-interruption.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/filesystem.test.ts`

Pass the action `AbortSignal` into `pipeline()`. Keep the hash, transform, and streams inside each
retry callback so failed attempts never contaminate the next digest. Establish whether the
destination existed before this helper invocation and, after cancellation or exhausted failure,
remove only a newly created path this invocation may have partially written. Never recursively
remove a pre-existing user path; preserve timestamp restoration and the primary abort/filesystem
error even if best-effort cleanup fails.

Use deterministic tests where possible: known regular-copy and hardlink digests, abort/error
propagation after destination creation, terminal cleanup of a new target, preservation of an
existing target, and retry-local hash state. Do not add atomic temp-file replacement, new
dependencies, or a hash toggle.

### Phase 2: Action and Adapter Contract Proof

#### Task 2.1: Prove Album Inventory-Before-Completion Ordering Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/copy-album.ts`
- `packages/rfmedia-cli/src/actions/copy-album.test.ts`
- `packages/rfmedia-cli/src/lib/filesystem.ts`
- `packages/rfmedia-cli/src/lib/db.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/copy-album.ts`
- `packages/rfmedia-cli/src/actions/copy-album.test.ts`

Audit regular copy, hardlink, conversion, accepted-destination, and ranged/parallel suffix branches
against `write/convert -> finalize hash -> batch inventory -> suffix/source completion`. Add focused
failure tests proving copy/hash/DB failure and dry-run cannot mark completion. Change production
ordering only where a failing test demonstrates a gap; preserve the worker model, inventory identity,
plugins, output, and benchmark-only hash-disable seam. Ensure wrapper-created abort state is passed
through if current code drops it.

#### Task 2.2: Prove Filter Final-Destination Persistence Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/copy-filter.ts`
- `packages/rfmedia-cli/src/actions/copy-filter.test.ts`
- `packages/rfmedia-cli/src/lib/integrity.ts`
- `packages/rfmedia-cli/src/lib/db.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/copy-filter.ts`
- `packages/rfmedia-cli/src/actions/copy-filter.test.ts`

Audit copied, hardlinked, converted, overwritten, renamed, and explicitly adopted destination paths.
Prove the finalized destination is hashed and persisted before granular/source completion, and that
dry-run, hash failure, or DB validation failure remains non-success. Make no production edit if
existing ordering already satisfies the spec; do not consolidate filter branches or change conflict,
hook, progress, result, or output behavior.

#### Task 2.3: Add Focused Sync Fingerprint Coverage Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/sync.ts`
- `packages/rfmedia-cli/src/lib/inventory.ts`
- `packages/rfmedia-cli/src/lib/inventory.test.ts`
- `packages/rfmedia-cli/docs/features/sync-command.doc.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/sync.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/sync.ts` only if tests demonstrate an ordering/cancellation gap.
- `packages/rfmedia-cli/src/lib/inventory.test.ts` only if present/null/omitted mapping coverage is missing.

Create a focused sync action suite using the existing filesystem/inventory module mock pattern so
hash and inventory failures are deterministic. Prove ordinary copy, hardlink, and conversion persist the SHA-256 for the destination represented by
sync's existing one-row-per-source model. Cover dry-run plus hash/inventory failure as non-success,
and verify portable database/JSONL mapping never fabricates or loses present, `null`, or omitted
hashes. Do not redesign range identity, diff/deletion behavior, or legacy storage.

#### Task 2.4: Run Delegation and Completion Regressions Depends on [2.1, 2.2, 2.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/queue.test.ts`
- `packages/rfmedia-cli/src/actions/queue-adapter.test.ts`
- `packages/rfmedia-cli/src/mcp/adapters.spec.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- None expected; modify only an existing regression test if it fails to assert current delegation.

Run queue and MCP adapter tests to prove copy/sync work still delegates to the shared actions. Do not add
hashes to queue serialization, MCP inputs/results, command output, or completions.

### Phase 3: Performance and Documentation Evidence

#### Task 3.1: Capture Repeated Like-for-Like Benchmark Evidence Depends on [1.2, 2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/benchmarks/copy.bench.ts`
- `packages/rfmedia-cli/benchmarks/helpers.ts`
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`
- `docs/prps/reports/content-hashing-during-copy-operations-report.md`

**Instructions**

Files to Create

- `docs/plans/content-hashing-during-copy-operations/benchmark-results.md`

Files to Modify

- `packages/rfmedia-cli/benchmarks/copy.bench.ts` only if repeatability or representative-size evidence needs a small benchmark-only change.
- `packages/rfmedia-cli/benchmarks/helpers.ts` only if shared fixture configuration is required.

Run identical SQLite-tracked direct-copy cases with benchmark-only hashing disabled and enabled.
Capture raw repeated samples, median/spread, throughput, environment/filesystem assumptions, and
peak memory where available; report hardlink/conversion separately if measured. Evaluate the issue's
`<5%` target only for direct byte copies and label high-variance evidence inconclusive instead of
claiming success from a faster noisy sample. Add no runtime option or CI wall-clock assertion.

#### Task 3.2: Correct Tracking, Schema, and Sync Documentation Depends on [2.1, 2.2, 2.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- `packages/rfmedia-cli/docs/features/tracking-system.md`
- `packages/rfmedia-cli/docs/features/sync-command.doc.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- `packages/rfmedia-cli/docs/features/sync-command.doc.md`

Remove stale claims that inventory is sync-only or schema version 1. Document schema version 9,
current album/filter/sync producers, nullable legacy hashes, no automatic backfill, tracking-disabled
and legacy behavior, dry-run, final-conversion hashing, hardlink snapshot semantics, and failure
ordering. Preserve the current operation/range model and avoid implying deferred Plex/playlist/watch
surfaces are inventoried.

#### Task 3.3: Document Fingerprinting, Verification, and Interruption Depends on [1.2, 2.1, 2.2, 2.3]

**READ THESE BEFORE TASK**

- `docs/features/file-integrity-verification.md`
- `docs/features/file-integrity-quick-reference.md`
- `packages/rfmedia-cli/docs/features/graceful-interruption.md`
- `docs/plans/content-hashing-during-copy-operations/feature-spec.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`

Files to Modify

- `docs/features/file-integrity-verification.md`
- `packages/rfmedia-cli/docs/features/graceful-interruption.md`

Create the focused canonical fingerprint document. Define lowercase final-artifact SHA-256,
streamed copy versus post-conversion/hardlink capture, legacy `NULL`, tracking prerequisites,
failure behavior, explicit scope exclusions, and the distinction from later read-back verification.
Cross-link the existing verification guide and document signal-aware, new-path-only partial cleanup.
Leave `docs/features/file-integrity-quick-reference.md` unchanged in this task to preserve the
three-file boundary; the canonical guide and new feature document provide discoverability.

#### Task 3.4: Record Performance Method and Mark Roadmap Shipped Depends on [3.1, 3.2, 3.3]

**READ THESE BEFORE TASK**

- `docs/plans/content-hashing-during-copy-operations/benchmark-results.md`
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`
- `ROADMAP.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/docs/features/performance-benchmarks.md`
- `ROADMAP.md`

Document the paired benchmark method and current pass/inconclusive result without a CI timing gate.
Prepare all three #111 roadmap references as implemented by PR #233 and completed by this closeout,
while keeping #116 as downstream read-time verification. Do not insert a placeholder PR number:
describe the closeout change initially, add the actual PR link immediately after PR creation, and
verify the final shipped wording only after merge.

### Phase 4: Validation and Delivery

#### Task 4.1: Run Full Validation and Write Current Evidence Report Depends on [2.4, 3.1, 3.2, 3.3, 3.4]

**READ THESE BEFORE TASK**

- `package.json`
- `packages/rfmedia-cli/package.json`
- `docs/plans/content-hashing-during-copy-operations/feature-spec.md`
- `docs/plans/content-hashing-during-copy-operations/benchmark-results.md`

**Instructions**

Files to Create

- `docs/plans/content-hashing-during-copy-operations/report.md`

Files to Modify

- None unless validation exposes a scoped regression.

Run the focused Vitest files from Tasks 1-2, including
`src/lib/shell-completions/templates.spec.ts`, then run
`npm run typecheck -w packages/rfmedia-cli`,
`npm run test:run -w packages/rfmedia-cli`, `npm run build:rfmedia`, `npm run lint:md`,
`npm run format:check`, the benchmark/report validation, and `git diff --check`. Record exact
commands, pass/fail counts, benchmark conclusion, files changed, intentional no-op surfaces, and any
current dependency-audit output after inspecting whether it is related. Fix only failures caused by
this change and rerun proportional/full validation.

#### Task 4.2: Open and Review the Issue-Closing Pull Request Depends on [4.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/content-hashing-during-copy-operations/report.md`
- `ROADMAP.md`

**Instructions**

Files to Create

- A structured review artifact under `docs/prps/reviews/` if required by the selected review workflow.

Files to Modify

- `ROADMAP.md` to add the actual closeout PR link after creation.
- Scoped source/test/docs files required by actionable findings, handled in separate 1-3-file fix batches.

Commit intentional scope, push the feature branch, and open a GitHub PR using every required template
section, exact validation outcomes, and `Closes #111`. Add its real link to `ROADMAP.md`, commit/push
that follow-up, then perform a structured code review focused on future-schema immutability, digest
validation, cleanup ownership, action ordering, and benchmark claims. Fix every actionable finding,
update finding statuses, rerun affected/full gates, push, resolve threads, and post the review
summary. This is the sole dynamic-scope lifecycle task; each review-fix batch must remain bounded to
one to three related files and rerun its focused validation before the full gate.

#### Task 4.3: Monitor CI, Squash Merge, and Clean Up Depends on [4.2]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `.github/workflows/rfmedia-cli.yml`
- `.github/workflows/pr-title.yml`
- `.github/workflows/pr-title-autofix.yml`

**Instructions**

Files to Create

- None.

Files to Modify

- None unless a required CI failure is caused by this change.

Monitor every required GitHub check through green, distinguishing external review-bot latency from a
code failure. Fix and push any scoped CI regression, rerun review/validation as needed, then squash
merge. Verify the merged PR, issue #111 closed state, roadmap link/state, and default-branch commit.
Delete the remote/local feature branch and safely remove the dedicated worktree; confirm the main
checkout is clean and no task worktree remains.

## Advice

- `schema.sql` is idempotent but still mutating; future-version rejection must precede it and should
  preferably precede WAL-changing pragmas that can create sidecar files.
- `getCurrentSchemaVersion()` uses permissive `parseInt()` and maps missing metadata to zero; do not
  reuse it as the strict empty-versus-malformed preflight without tightening its contract.
- `cleanupPartialFile()` removes recursively through `fs-extra`; call cleanup only after proving the
  destination did not exist before this helper invocation.
- A streamed digest identifies bytes submitted to the writer, not a later destination read-back.
  Use “fingerprint” consistently and leave stored-hash comparison to #116.
- Keep async file/hash work outside `better-sqlite3` transactions; validate and bind only synchronous
  data inside the batch transaction.
- Hardlink hashing changes a metadata-only operation into a full read and can become stale after
  linked-inode mutation. Do not average that cost into the direct-copy `<5%` conclusion.
- Audit action code before refactoring: PR #233 already has the correct architecture and most
  ordering. A no-op production audit with stronger tests is preferable to manufacturing churn.
- Queue, MCP, and completions are delegation/regression surfaces only. Their unchanged public
  contracts are an acceptance result, not missing implementation work.
- The current worktree lacks `graphify-out/graph.json`; do not copy graph artifacts into it. Run
  `graphify update .` only from a checkout where the graph exists after the merged code lands.
- ROADMAP needs the actual closing PR link, so use a placeholder-free initial edit and one small
  follow-up commit immediately after PR creation.
