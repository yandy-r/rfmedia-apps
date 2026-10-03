# Issue 56 Action Test Coverage

Issue #56 strengthens four exported `rfmedia-cli` action boundaries: album verification, filter
verification, incremental sync, and legacy-state migration. Commander and MCP layers translate
inputs, actions own orchestration/results/resource cleanup, and existing libraries own tiered
verification, inventory diffs, filesystem mutation, and SQLite persistence. Implementation should
extend the mature action test harnesses, reuse library-owned migration code, and derive final truth
from re-observation or durable database proof rather than attempted work. No new CLI option,
database schema, dependency, MCP shape, or completion template is required.

## Relevant Files

- `packages/rfmedia-cli/src/actions/verify-album.ts`: Album/range verification, repair, recheck,
  evidence, and abort lifecycle.
- `packages/rfmedia-cli/src/actions/verify-album.test.ts`: Existing conflict/tier harness; add only
  missing-artifact contracts.
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: Eligibility, destination mapping, repair,
  recheck, and aggregation.
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`: Existing layout/conflict harness; add
  eligible missing mappings.
- `packages/rfmedia-cli/src/actions/sync.ts`: Diff application, materialize/hash/persist ordering,
  downgrade cleanup, lifecycle, and scan gating.
- `packages/rfmedia-cli/src/actions/sync.test.ts`: Existing fingerprint-order harness; extend for
  classification and lifecycle.
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts`: Legacy discovery/import/cleanup
  orchestration and current count-only defect.
- `packages/rfmedia-cli/src/lib/completed-tracker.ts`: Existing completed/failed sidecar parser and
  database importer to reuse.
- `packages/rfmedia-cli/src/lib/completed-tracker.test.ts`: Existing automatic-import persistence
  examples and real database fixtures.
- `packages/rfmedia-cli/src/lib/history.ts`: Legacy JSONL validation/import and history-directory
  ownership.
- `packages/rfmedia-cli/src/lib/inventory.ts`: Authoritative sync diff and inventory contracts.
- `packages/rfmedia-cli/src/lib/db.ts`: Operation, completed/failed, history, and inventory database
  APIs.
- `packages/rfmedia-cli/src/lib/filesystem.ts`: Copy/link, staging, cleanup, and removal adapters.
- `packages/rfmedia-cli/src/lib/tiered-verification.ts`: Verification outcome semantics; mock at the
  action boundary.
- `packages/rfmedia-cli/src/types/results.ts`: Public `VerifyCommandResult`, `SyncResult`, and
  `MigrateResult` fields.
- `packages/rfmedia-cli/src/types/options.ts`: Stable action option contracts.
- `packages/rfmedia-cli/README.md`: Manual migration promises and required proof/cleanup update.
- `packages/rfmedia-cli/docs/features/undo-history-system.md`: History migration/path semantics.
- `ROADMAP.md`: Three live #56 entries requiring completion parity.

## Relevant Tables

- `operations`: Command/mode/input/options identity and final status/counts; manual migration must
  preserve input plus options hash.
- `completed_sources`: Durable completed legacy paths keyed by operation.
- `failed_sources`: Durable failed legacy paths and error data keyed by operation.
- `history_sessions`: Session headers and identity for legacy JSONL import.
- `history_operations`: Operations linked to imported history sessions.
- `inventory`: Sync source/destination fingerprints and downgrade destinations.

No schema migration is planned; the existing tables express every required contract.

## Relevant Patterns

**Exported action as integration seam**: Drive public action functions, mock lower-level adapters,
and assert typed results plus observable mutation. See
[`verify-album.test.ts`](../../../packages/rfmedia-cli/src/actions/verify-album.test.ts).

**Hoisted ESM mock ownership**: Create factory-visible mocks with `vi.hoisted()`, clear calls while
restoring deliberate defaults, and avoid same-file private-helper mocks. See
[`sync.test.ts`](../../../packages/rfmedia-cli/src/actions/sync.test.ts).

**Verify after repair**: Staged materialization does not establish success; re-run the selected tier
and derive final counters from the observed destination. See
[`verify-filter.ts`](../../../packages/rfmedia-cli/src/actions/verify-filter.ts).

**Classification-aware sync mutation**: Preserve inventory diff classification into the write
decision so updated entries replace their represented destination while new collisions retain
force policy. See [`sync.ts`](../../../packages/rfmedia-cli/src/actions/sync.ts).

**Materialize, hash, persist, count**: A sync file becomes successful only after final bytes are
hashed and inventory is persisted; use semantic event ordering in tests. See
[`sync.test.ts`](../../../packages/rfmedia-cli/src/actions/sync.test.ts).

**Library-owned migration proof**: Reuse completed-tracker/history importers, validate before
mutation, and return enough success/equivalence proof for cleanup eligibility. See
[`completed-tracker.ts`](../../../packages/rfmedia-cli/src/lib/completed-tracker.ts) and
[`history.ts`](../../../packages/rfmedia-cli/src/lib/history.ts).

**Proof-gated destructive cleanup**: Discovery counts never authorize unlink. `--delete-old`
operates only on individually proven files; force bypasses confirmation, not proof. See
[`migrate-tracking.ts`](../../../packages/rfmedia-cli/src/actions/migrate-tracking.ts).

**Result-oriented failure containment**: Per-file/per-source failures retain stable paths, messages,
and codes while safe independent work continues. Action-wide resource acquisition is released in
`finally`. See [`sync.ts`](../../../packages/rfmedia-cli/src/actions/sync.ts).

**Hybrid fixture fidelity**: Use narrow virtual filesystem mocks for destructive action tests and a
temporary SQLite database only where durable read-back is the contract. Do not add a generic fake
filesystem or shared verify harness. See
[`completed-tracker.test.ts`](../../../packages/rfmedia-cli/src/lib/completed-tracker.test.ts).

## Relevant Docs

**`docs/plans/issue-56-action-tests/feature-spec.md`**: You _must_ read this for accepted scope,
success criteria, production-fix decisions, and coverage interpretation.

**`docs/plans/issue-56-action-tests/research-technical.md`**: You _must_ read this for the critical
scenario matrix, exact mock seams, focused coverage command, and completion impacts.

**`docs/plans/issue-56-action-tests/research-security.md`**: You _must_ read this before migration or
sync cleanup changes; it classifies deletion, path, malformed-input, and durability risks.

**`docs/plans/issue-56-action-tests/research-practices.md`**: You _must_ read this before adding tests
or helpers; it defines reuse/KISS rules and filler-test anti-patterns.

**`packages/rfmedia-cli/docs/features/verify-command.doc.md`** and
**`verify-auto-fix.doc.md`**: You _must_ read these for missing/mismatch/extra truth, repair
authorization, staged validation, and final recheck.

**`packages/rfmedia-cli/docs/features/sync-command.doc.md`**: You _must_ read this for diff
classification, write/hash/persist ordering, continuation, dry-run, and scan gating.

**`packages/rfmedia-cli/README.md`**, **`tracking-system.md`**, and
**`undo-history-system.md`**: You _must_ read these for manual/automatic legacy import, custom
history location, persistence, and cleanup promises.

**`packages/rfmedia-cli/docs/testing/troubleshooting.md`**: You _must_ read this before editing
Vitest mocks; it documents clear/reset/restore behavior and suite-order failures.

**`.github/workflows/rfmedia-cli.yml`**, **`lefthook.yml`**, and
**`.github/pull_request_template.md`**: Reference for registered CI, real pre-push validation, and
required PR evidence.

**`packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts`**: Audit all three as unchanged
because no command surface changes; run completion parity tests and report the result.
