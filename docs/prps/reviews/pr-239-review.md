# PR Review #239 — feat(rfapps): add managed update lifecycle

**Reviewed**: 2026-07-17T23:09:22Z
**Mode**: PR
**Author**: @yandy-r
**Branch**: feat/148-managed-update-lifecycle → master
**Decision**: REQUEST CHANGES

## Worktree Setup

- **Parent**: `/home/yandy/.codex-worktrees/rfmedia-apps-issue-148/` (branch: `feat/148-managed-update-lifecycle`)

## Summary

The lifecycle design, documentation, and test surface are substantial, and all executed validation gates pass. However, ten high-severity correctness, migration, concurrency, and authority-binding defects block merge; six medium-severity contract, reliability, diagnostics, and resource-bounding findings should be fixed in the same pass.

## Findings

### CRITICAL

_(none)_

### HIGH

- **[F001]** `packages/rfapps-cli/src/actions/update.ts:147` — Docker authority fingerprinting hashes only the context name, runs outside the selected secrets environment, and does not bind the plan to the actual daemon endpoint or daemon identity. A context endpoint or `DOCKER_HOST` can change while revalidation still succeeds. [correctness, security]
  - **Status**: Fixed
  - **Category**: Security / Correctness
  - **Suggested fix**: Run fingerprinting through the same execution environment as Docker operations and hash a stable, non-secret inspected context plus daemon identity; add revalidation tests for context and daemon changes.

- **[F002]** `packages/rfapps-cli/src/actions/update.ts:494` — Loaded plans accept a self-consistent arbitrary `composePath` without binding it to the currently approved project path/root. A crafted plan can redirect privileged Docker operations to another Compose file. [security]
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Canonicalize and persist the approved project root and Compose path, require loaded plans to match the current configuration, and reject symlinks, traversal, outside-root paths, and path changes before hashing or execution.

- **[F003]** `packages/rfapps-cli/src/actions/update.ts:629` — Lifecycle locking uses `process.cwd()` instead of the canonical Compose project identity, while readiness can derive a different project prefix. Applying one saved plan from different directories can evade mutual exclusion and misclassify recreated containers. [correctness, security, quality]
  - **Status**: Fixed
  - **Category**: Concurrency / Architecture
  - **Suggested fix**: Derive one stable project identity from the canonical reviewed Compose directory and project name, then pass it to lock acquisition and all readiness checks; test cross-directory saved-plan contention and apply.

- **[F004]** `packages/rfapps-cli/src/lib/docker.ts:1432` — Local update detection uses `RepoDigests[0]` rather than the digest whose normalized repository matches the configured image. Multiple aliases can produce false current/update results based on array ordering. [correctness]
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Reuse repository-aware digest selection and add swapped-order and mismatched-alias tests for `checkImageUpdate()`.

- **[F005]** `packages/rfapps-cli/src/lib/docker.ts:1498` — Registry detection returns a bare `sha256:...`, but apply requires a canonical `repository@sha256:...` immutable reference. Real actionable plans therefore fail `INVALID_IMAGE_IDENTITY`; fixtures hide the mismatch by supplying qualified digests. [correctness, quality]
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Canonicalize the selected remote digest with the configured repository end to end, validate that shape in managed artifacts, and add an integration test from real manifest parsing through plan generation and recreation.

- **[F006]** `packages/rfapps-cli/src/lib/managed-update.ts:865` — All recreation exceptions are classified as pre-mutation pull failures. The helper can throw after a successful `compose up` during cleanup, leaving the new image running unverified while reporting a pull failure and skipping restore. [correctness]
  - **Status**: Fixed
  - **Category**: Error Handling
  - **Suggested fix**: Preserve typed stage and mutation evidence, prevent temporary-file cleanup from erasing successful mutation, and conservatively stabilize or restore whenever mutation may have begun.

- **[F007]** `packages/rfapps-cli/src/lib/managed-update.ts:983` — Target verifier rejections escape without failed evidence, exact-image recovery, or a final report; restore verification has the same uncaught path. [correctness]
  - **Status**: Fixed
  - **Category**: Error Handling
  - **Suggested fix**: Catch verifier rejections in update and restore phases, map them to bounded lifecycle errors, route update failures through exact recovery, and test rejection injection for both phases.

- **[F008]** `packages/rfapps-cli/src/lib/managed-update.ts:1267` — All services are revalidated once before the sequential execution loop, so later services have a TOCTOU window after earlier pulls, checks, or restores. [security]
  - **Status**: Fixed
  - **Category**: Security / Correctness
  - **Suggested fix**: Revalidate service identity, proposed digest, platform, and recovery generation immediately before each service mutation and fail that service closed if any evidence changed.

- **[F009]** `packages/rfapps-cli/src/lib/migrations.ts:150` — `initializeDatabase()` applies the current schema before upgrading a v1 database, then the v3 migration unconditionally adds columns already created by the schema and fails with duplicate-column errors. [correctness]
  - **Status**: Fixed
  - **Category**: Database Migration
  - **Suggested fix**: Make the v3 column additions idempotent or run legacy migrations before schema bootstrap, and add an on-disk v1 `initializeDatabase()` integration test.

- **[F010]** `packages/rfapps-cli/src/lib/plan-generator.ts:820` — Compose platform is cached and recorded but not passed to `checkImageUpdate()`, so multi-platform registry inspection selects the first manifest entry rather than the reviewed architecture. [correctness, security, quality]
  - **Status**: Fixed
  - **Category**: Correctness / Security
  - **Suggested fix**: Thread normalized platform through update checking, require an exact platform descriptor match, and test distinct AMD64/ARM manifest results end to end.

### MEDIUM

- **[F011]** `packages/rfapps-cli/src/actions/update.ts:180` — Recovery lookup loads up to 10,000 generations per service and filters in JavaScript, causing avoidable database work and memory growth during concurrent plan generation. [security]
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Add a direct indexed query for `(service, image_id, generation)` and use it for exact recovery lookup.

- **[F012]** `packages/rfapps-cli/src/actions/update.ts:324` — Preview emits `outcome: "cancelled"` even though no approval was requested or declined, making the versioned machine result misleading. [correctness]
  - **Status**: Fixed
  - **Category**: Output Contract
  - **Suggested fix**: Add a planned/preview outcome or emit the plan DTO for preview, reserve cancelled for actual decline, and cover JSON/YAML contracts.

- **[F013]** `packages/rfapps-cli/src/actions/update.ts:593` — `--out` preflight writes a terminal cancelled result before mutation and overwrites it only after completion. A crash after mutation starts can leave an authoritative-looking cancellation report. [quality]
  - **Status**: Fixed
  - **Category**: Reliability
  - **Suggested fix**: Reserve the path without a terminal DTO or atomically write an explicit in-progress journal, ensuring interruption and error paths cannot leave a false terminal result.

- **[F014]** `packages/rfapps-cli/src/lib/docker.ts:166` — Docker subprocess stdout/stderr buffers are unbounded; registry-controlled manifest output can exhaust memory and violates the bounded-error contract. [security]
  - **Status**: Fixed
  - **Category**: Security / Performance
  - **Suggested fix**: Enforce per-stream byte caps, terminate or drain-and-truncate at the cap, and return a classified bounded error without retaining raw output.

- **[F015]** `packages/rfapps-cli/src/lib/managed-update.ts:455` — A ready target with an unready dependency reports `VERIFY_READY` and “failed: ready,” losing the actual dependency failure and producing contradictory machine evidence. [quality]
  - **Status**: Fixed
  - **Category**: Error Handling
  - **Suggested fix**: Add dependency-specific verification classification and bounded failed/pending dependency evidence; test target-ready/dependency-failed behavior.

- **[F016]** `packages/rfapps-cli/src/lib/plan-generator.ts:797` — Registry detection uses an unbounded `Promise.all` over selected services, allowing large Compose models to spawn excessive Docker subprocesses. [security]
  - **Status**: Fixed
  - **Category**: Performance / Availability
  - **Suggested fix**: Use a bounded worker pool for unique image/platform checks, cap concurrency, and retain cache deduplication.

### LOW

_(none)_

## Validation Results

| Check      | Result                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Type check | Pass — `npm run typecheck --workspace packages/rfapps-cli`                                                                                      |
| Lint       | Pass — `npm run format:check`; scoped markdownlint passed (repository-wide markdownlint has four pre-existing MD034 errors outside this change) |
| Tests      | Pass — 1,037 rfapps tests plus opt-in live Docker Compose smoke test                                                                            |
| Build      | Pass — `npm run build:rfapps`                                                                                                                   |

## Files Reviewed

- `README.md` (Modified)
- `ROADMAP.md` (Modified)
- `docs/README.md` (Modified)
- `docs/architecture/data-flow.md` (Modified)
- `docs/architecture/overview.md` (Modified)
- `docs/features/deployment-history.md` (Modified)
- `docs/features/deployment-rollback.md` (Modified)
- `docs/features/error-handling.md` (Modified)
- `docs/features/json-output.md` (Modified)
- `docs/features/plan-apply-workflow.md` (Modified)
- `docs/features/quick-reference.md` (Modified)
- `docs/features/secrets-management.md` (Modified)
- `docs/features/service-healthchecks.md` (Modified)
- `docs/features/shell-completion.md` (Modified)
- `docs/plans/managed-update-lifecycle/analysis-architecture.md` (Added)
- `docs/plans/managed-update-lifecycle/analysis-docs.md` (Added)
- `docs/plans/managed-update-lifecycle/analysis-integration.md` (Added)
- `docs/plans/managed-update-lifecycle/analysis-patterns.md` (Added)
- `docs/plans/managed-update-lifecycle/analysis-tasks.md` (Added)
- `docs/plans/managed-update-lifecycle/feature-spec.md` (Added)
- `docs/plans/managed-update-lifecycle/parallel-plan.md` (Added)
- `docs/plans/managed-update-lifecycle/research-business.md` (Added)
- `docs/plans/managed-update-lifecycle/research-external.md` (Added)
- `docs/plans/managed-update-lifecycle/research-practices.md` (Added)
- `docs/plans/managed-update-lifecycle/research-recommendations.md` (Added)
- `docs/plans/managed-update-lifecycle/research-security.md` (Added)
- `docs/plans/managed-update-lifecycle/research-technical.md` (Added)
- `docs/plans/managed-update-lifecycle/research-ux.md` (Added)
- `docs/plans/managed-update-lifecycle/shared.md` (Added)
- `packages/rfapps-cli/CLAUDE.md` (Modified)
- `packages/rfapps-cli/README.md` (Modified)
- `packages/rfapps-cli/src/actions/apply.spec.ts` (Modified)
- `packages/rfapps-cli/src/actions/apply.ts` (Modified)
- `packages/rfapps-cli/src/actions/completion.spec.ts` (Modified)
- `packages/rfapps-cli/src/actions/completion.ts` (Modified)
- `packages/rfapps-cli/src/actions/rollback.spec.ts` (Modified)
- `packages/rfapps-cli/src/actions/rollback.ts` (Modified)
- `packages/rfapps-cli/src/actions/update.spec.ts` (Added)
- `packages/rfapps-cli/src/actions/update.ts` (Added)
- `packages/rfapps-cli/src/cli.ts` (Modified)
- `packages/rfapps-cli/src/commands/update.ts` (Added)
- `packages/rfapps-cli/src/lib/docker.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/docker.ts` (Modified)
- `packages/rfapps-cli/src/lib/generations.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/generations.ts` (Modified)
- `packages/rfapps-cli/src/lib/health.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/health.ts` (Modified)
- `packages/rfapps-cli/src/lib/index.ts` (Modified)
- `packages/rfapps-cli/src/lib/lifecycle-lock.spec.ts` (Added)
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts` (Added)
- `packages/rfapps-cli/src/lib/managed-update.spec.ts` (Added)
- `packages/rfapps-cli/src/lib/managed-update.ts` (Added)
- `packages/rfapps-cli/src/lib/migrations.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/migrations.ts` (Modified)
- `packages/rfapps-cli/src/lib/plan-generator.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/plan-generator.ts` (Modified)
- `packages/rfapps-cli/src/lib/plan-storage.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/plan-storage.ts` (Modified)
- `packages/rfapps-cli/src/lib/schema.sql` (Modified)
- `packages/rfapps-cli/src/lib/state-queries.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/state-queries.ts` (Modified)
- `packages/rfapps-cli/src/lib/state-storage.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/state-storage.ts` (Modified)
- `packages/rfapps-cli/src/managed-update.compose.integration.spec.ts` (Added)
- `packages/rfapps-cli/src/managed-update.integration.spec.ts` (Added)
- `packages/rfapps-cli/src/mcp/schema.spec.ts` (Modified)
- `packages/rfapps-cli/src/mcp/schema.ts` (Modified)
- `packages/rfapps-cli/src/types/health.ts` (Modified)
- `packages/rfapps-cli/src/types/index.ts` (Modified)
- `packages/rfapps-cli/src/types/plan.ts` (Modified)
- `packages/rfapps-cli/src/types/state.ts` (Modified)
- `packages/rfapps-cli/src/types/update.ts` (Added)
- `packages/rfapps-cli/test/fixtures/managed-update/Dockerfile` (Added)
- `packages/rfapps-cli/test/fixtures/managed-update/compose.yml` (Added)
