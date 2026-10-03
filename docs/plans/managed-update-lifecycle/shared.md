# Shared Context: Managed Update Lifecycle

Issue #148 adds a safe, CLI-only `rfapps update` workflow that detects image changes, previews a versioned plan, applies updates sequentially, verifies the updated target, and restores the exact prior daemon-local image when verification fails. The implementation should orchestrate existing plan, Docker, health, state, generation, and rollback libraries through a new data-oriented coordinator rather than call action handlers. Safety invariants are central: preview is non-mutating, unknown registry results are never treated as current, reviewed identities are revalidated immediately before mutation, managed artifacts never persist resolved secrets, and automatic restore never falls back to a mutable tag. The first release remains deliberately narrow: one service at a time, image-only recovery, no scheduling, no parallel mutation, and no MCP mutation endpoint.

## Relevant Files

### Command and action boundaries

- `packages/rfapps-cli/src/cli.ts` - Registers dedicated commands; add `registerUpdateCommand()` beside existing command modules.
- `packages/rfapps-cli/src/commands/doctor.ts` - Registration pattern for a dedicated Commander command with dynamic action import.
- `packages/rfapps-cli/src/actions/plan.ts` - Config overrides, target resolution, plan rendering, output formatting, and exit behavior to mirror.
- `packages/rfapps-cli/src/actions/apply.ts` - Existing saved-plan confirmation/apply path; must reject managed-update intent and preserve ordinary plan behavior.
- `packages/rfapps-cli/src/actions/rollback.ts` - Existing generation restore UX; extract or reuse exact-image recreation while retaining legacy manual rollback semantics.
- `packages/rfapps-cli/src/actions/completion.ts` - Bash, Zsh, and Fish command/option completion tables.
- `packages/rfapps-cli/src/actions/completion.spec.ts` - Exact completion snapshots/expectations that must include `update` and its options.

### Planning, persistence, and update detection

- `packages/rfapps-cli/src/types/plan.ts` - Existing deployment-plan and image-update shapes; extend compatibly with managed intent and discriminated detection status.
- `packages/rfapps-cli/src/lib/plan-generator.ts` - Current `--check-updates` detection path and Compose plan generation.
- `packages/rfapps-cli/src/lib/plan-generator.spec.ts` - Detection and plan-generation fixtures; add explicit available/current/unsupported/missing/unknown cases.
- `packages/rfapps-cli/src/lib/plan-storage.ts` - Existing JSON plan persistence; managed plans require a strict secret-free allowlist, atomic/private writes, and guarded reads.
- `packages/rfapps-cli/src/lib/plan-storage.spec.ts` - Persistence compatibility, secret-redaction, permission, symlink, size, and malformed-plan coverage.

### Docker, health, and recovery primitives

- `packages/rfapps-cli/src/lib/docker.ts` - Compose/Docker execution, inspection, update lookup, pull, and start helpers; add repository/platform-aware identity and targeted immutable recreation without `--remove-orphans`.
- `packages/rfapps-cli/src/lib/docker.spec.ts` - Assert exact argv, repository digest matching, container image IDs, and safe recreation behavior.
- `packages/rfapps-cli/src/types/health.ts` - Add target-verification contracts and stable-running fallback evidence.
- `packages/rfapps-cli/src/lib/health.ts` - Existing dependency readiness polling; add target image/state/health verification as the success gate.
- `packages/rfapps-cli/src/lib/health.spec.ts` - Cover expected image ID, Docker health, exit/restart states, timeouts, and running-only fallback.
- `packages/rfapps-cli/src/lib/services.ts` - Existing service/group/profile/sidecar resolution reused by the update action.
- `packages/rfapps-cli/src/lib/env-tools.ts` - Environment-tool execution configuration that must be threaded through every Docker call.

### State, generations, and migration

- `packages/rfapps-cli/src/lib/schema.sql` - Current SQLite schema version 2 with `metadata`, `deployments`, and `generations`.
- `packages/rfapps-cli/src/lib/migrations.ts` - Versioned migration runner and CLI/schema compatibility map; add schema version 3.
- `packages/rfapps-cli/src/lib/migrations.spec.ts` - Migration and compatibility tests for nullable immutable-image fields.
- `packages/rfapps-cli/src/types/state.ts` - Deployment/generation actions and public records; add `update`, `imageId`, and `imageDigest`.
- `packages/rfapps-cli/src/lib/state-storage.ts` - Transactional deployment writes and automatic generation creation.
- `packages/rfapps-cli/src/lib/state-storage.spec.ts` - Transaction and row-mapping coverage for update identity fields.
- `packages/rfapps-cli/src/lib/state-queries.ts` - History/read mappers that must return new nullable identity fields.
- `packages/rfapps-cli/src/lib/state-queries.spec.ts` - Backward-compatible query coverage.
- `packages/rfapps-cli/src/lib/generations.ts` - Generation row mapping, insertion, and action allowlist.
- `packages/rfapps-cli/src/lib/generations.spec.ts` - Exact-image generation persistence and legacy-null coverage.

### Public contracts and documentation

- `packages/rfapps-cli/src/types/index.ts` - Public type barrel for managed-update contracts.
- `packages/rfapps-cli/src/lib/index.ts` - Library barrel for coordinator and helpers.
- `packages/rfapps-cli/src/mcp/schema.ts` - Read-side compatibility for optional intent, update status, update action, and immutable image fields; no new mutation tool.
- `packages/rfapps-cli/src/mcp/schema.spec.ts` - Legacy and extended schema compatibility.
- `packages/rfapps-cli/README.md` - Primary CLI reference and safety/exit-code contract.
- `docs/features/quick-reference.md` - User-facing command synopsis and examples.
- `docs/features/plan-apply-workflow.md` - Saved-plan compatibility and managed-plan routing.
- `docs/features/deployment-history.md` - Update action and immutable identity history fields.
- `docs/features/deployment-rollback.md` - Exact automatic restore versus best-effort legacy manual rollback.
- `docs/features/service-healthchecks.md` - Target verification and dependency-readiness distinction.
- `docs/features/json-output.md` - Versioned `update.v1` machine result.
- `docs/features/error-handling.md` - Usage versus lifecycle failure exit codes.
- `docs/features/secrets-management.md` - Secret-free managed artifacts and env-tool boundary.
- `docs/features/shell-completion.md` - Completion coverage for the new command.
- `docs/architecture/overview.md` - CLI-only orchestration placement.
- `docs/architecture/data-flow.md` - Preview, revalidation, mutation, verification, and restore flow.
- `packages/rfapps-cli/CLAUDE.md` - Package-specific command and architecture guidance.
- `README.md` - Root command overview.
- `docs/README.md` - Documentation navigation.
- `ROADMAP.md` - Mark issue #148 and the managed-update Sprint 1 exit criterion complete once shipped.

## Relevant Tables

### `metadata`

- Stores `schema_version`; migration v3 must update it transactionally.
- `SCHEMA_VERSION_CLI_MAP` must map v3 to the release that introduces immutable update identities.

### `deployments`

- Existing append-only operation history.
- Add nullable `image_id TEXT` and `image_digest TEXT` columns for observed immutable identity and portable audit evidence.
- Add `update` to `DeploymentAction`.
- Failed update/verification/restore attempts remain history rows but must not create successful generations.

### `generations`

- Existing append-only snapshots used by history and rollback.
- Add nullable `image_id TEXT` and `image_digest TEXT` columns without backfilling legacy rows.
- Add `update` to `GenerationAction` and the generation action allowlist.
- Persist a durable pre-update recovery generation before the first pull; only verified update or verified restore states become later successful generations.
- Legacy rows without `image_id` remain readable but are ineligible for automatic exact restore.

## Relevant Patterns

**Thin command, interactive action, data-oriented library**: Follow the dedicated command/action/library split in [`packages/rfapps-cli/src/commands/doctor.ts`](../../../packages/rfapps-cli/src/commands/doctor.ts).

- Follow `commands/doctor.ts` for registration and lazy action loading.
- Keep config loading, service selection, confirmation, progress, output formatting, database lifetime, and `process.exitCode` in `actions/update.ts`.
- Keep `lib/managed-update.ts` free of prompts, printing, and global exit state. It should accept injected dependencies and return a typed `ManagedUpdateResult`.
- Use strict ESM imports with explicit `.js` suffixes, type-only imports, and discriminated unions rather than optional status booleans.

**Safe preview and apply contract**: Mirror the ordinary preview and approval boundary in [`packages/rfapps-cli/src/actions/plan.ts`](../../../packages/rfapps-cli/src/actions/plan.ts) while keeping managed apply distinct.

- Bare `rfapps update` is preview-only. Mutation requires `--apply` and approval; machine/non-interactive mutation requires `--apply --yes`.
- A managed plan is identified by `schemaVersion: "update-plan.v1"` and `intent: "managed-update"`; ordinary plans remain backward compatible.
- Before mutation, lock by project plus Docker context and revalidate the Compose hash, context, current local image ID, platform, and proposed repository digest. Drift is a hard failure with no force bypass.
- Process services sequentially. Continue after a failed update that was successfully restored, but return exit 1; stop immediately after a restore failure.

**Image identity and Docker execution**: Extend argument-array execution and typed inspection in [`packages/rfapps-cli/src/lib/docker.ts`](../../../packages/rfapps-cli/src/lib/docker.ts).

- Treat configured tag, canonical repository digest, manifest/index digest, config digest, and daemon-local image ID as distinct values.
- Match `RepoDigests` to the normalized configured repository and selected platform; never select entry zero blindly.
- Automatic restore must recreate from the captured same-daemon local image ID using a private Compose override and verify that exact ID afterward.
- Use argument-array `execDocker()`/`execDockerCompose()` only. Managed update and restore use targeted `up -d --force-recreate --pull never SERVICE` and never `--remove-orphans`.

**Health and readiness**: Build target-aware verification beside dependency polling in [`packages/rfapps-cli/src/lib/health.ts`](../../../packages/rfapps-cli/src/lib/health.ts).

- Verification requires the target container to use the expected local image ID, be running with a successful state, and report Docker `healthy` when a healthcheck exists.
- If no healthcheck exists, require a bounded stable-running window and label the evidence `running-only`.
- Existing dependency readiness is supplementary evidence; it cannot establish success for a leaf target.

**Persistence and secrets**: Preserve ordinary plan compatibility in [`packages/rfapps-cli/src/lib/plan-storage.ts`](../../../packages/rfapps-cli/src/lib/plan-storage.ts) while adding a separate allowlisted managed DTO.

- Managed plans/reports use a strict runtime-validated allowlisted DTO. Never serialize resolved environment current/desired values, credentials, Docker connection secrets, or unbounded subprocess output.
- Write atomically with private parent directories and files, reject symlinks and unsafe paths, cap input size, and keep ordinary plan behavior compatible.
- Temporary immutable-image overrides are private and removed in `finally`; locks and database handles are also released in `finally`.

**Tests and validation**: Follow the colocated Vitest patterns in [`packages/rfapps-cli/src/lib/docker.spec.ts`](../../../packages/rfapps-cli/src/lib/docker.spec.ts) and assert exact state transitions.

- Co-locate Vitest specs, mock module boundaries with `vi.mock()`/`vi.mocked()`, clear mocks in `beforeEach`, and assert exact Docker argv and lifecycle transitions.
- Add an integration spec for success, no-op, unknown detection, drift rejection, failed verification with verified restore, restore failure stop, and interruption stabilization.
- Run package typecheck and coverage plus repository formatting/markdown gates. Baseline is 60 files and 920 passing tests at 81.93% statement coverage.

## Relevant Docs

**docs/plans/managed-update-lifecycle/feature-spec.md**: You _must_ read this for the source-of-truth acceptance criteria, safety invariants, output schemas, and non-goals.

**docs/plans/managed-update-lifecycle/research-recommendations.md**: You _must_ read this for the consolidated design choices and risk decisions.

**docs/plans/managed-update-lifecycle/research-security.md**: You _must_ read this when implementing image identity, persistence, paths, locks, or plan loading.

**docs/plans/managed-update-lifecycle/analysis-architecture.md**: You _must_ read this when changing package boundaries or lifecycle ownership.

**docs/plans/managed-update-lifecycle/analysis-patterns.md**: You _must_ read this before implementing command, action, library, Docker, or test code.

**docs/plans/managed-update-lifecycle/analysis-integration.md**: You _must_ read this before integrating Docker, registries, SQLite, config, health, rollback, or MCP schemas.

**docs/plans/managed-update-lifecycle/analysis-docs.md**: You _must_ read this before updating user or architecture documentation.

**docs/plans/managed-update-lifecycle/analysis-tasks.md**: You _must_ read this for task dependencies and child-issue workstream boundaries.

**docs/features/rfapps-cli.md**: You _must_ read this when changing the public CLI contract.

**docs/features/deployment-generations.md**: You _must_ read this when changing generation or rollback semantics.

**.github/workflows/rfapps-cli.yml**: You _must_ read this before final validation because it defines the CI gates.

**.github/pull_request_template.md**: You _must_ read this before preparing the pull request.
