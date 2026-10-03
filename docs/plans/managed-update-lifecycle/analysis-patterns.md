# Pattern & Code Analysis: managed-update-lifecycle

## Executive Summary

Issue #148 should add a thin `rfapps update` vertical slice: Commander registration in a dedicated command module, interaction/output in an action, and a data-returning sequential coordinator in `lib/`. Existing plan, Docker, health, and generation code provides useful seams, but it is not yet safe enough for managed updates: update detection collapses errors into `hasUpdate: false`, saved plans persist full environment diffs, `startServices()` always uses `--remove-orphans`, readiness checks dependencies rather than the updated target, and rollback restores a mutable tag.

## Implementation Patterns

- **Create** `packages/rfapps-cli/src/commands/update.ts`: follow `registerDoctorCommand()` in `src/commands/doctor.ts`; declare options with Commander, add compatibility/help text, dynamically import `executeUpdate()`, and pass `program.opts()`.
- **Create** `packages/rfapps-cli/src/actions/update.ts`: follow `executePlan()`/`executeApply()` for config overrides, target resolution, preview, one confirmation, machine-format output, and exit mapping. Keep prompts, `console.error`, `formatOutput()`, and `process.exitCode` here.
- **Create** `packages/rfapps-cli/src/lib/managed-update.ts`: expose the sequential state machine and return a typed result. Inject plain Docker/state/clock/lock dependencies in tests; do not call `executeApply()`, `executeHealth()`, or `executeRollback()` because actions own output, confirmation, database lifetime, and global exit state.
- **Create** `packages/rfapps-cli/src/types/update.ts`: use discriminated unions for detection status and lifecycle outcomes instead of optional booleans/errors.
- Reuse `loadConfig()`, `applyCliOverrides()`, `resolveServicesWithInteractive()`, `getEnvToolExecConfig()`, and argument-array Docker execution through `execDocker()`/`execDockerCompose()`.
- Preserve preview-only behavior: generation, pull, recreate, restore, and long-held locking occur only after `--apply` and approval. Mutate one service at a time; continue after a verified restore, stop after `restore_failed`.

## Existing Code Structure

### Files to create

- `packages/rfapps-cli/src/commands/update.ts`
- `packages/rfapps-cli/src/actions/update.ts`
- `packages/rfapps-cli/src/lib/managed-update.ts`
- `packages/rfapps-cli/src/types/update.ts`
- `packages/rfapps-cli/src/lib/managed-update.spec.ts` and `packages/rfapps-cli/src/actions/update.spec.ts`

### Files to modify

- `packages/rfapps-cli/src/cli.ts`: import/call `registerUpdateCommand(program)` beside the existing dedicated command registrations.
- `src/types/plan.ts`, `src/lib/plan-generator.ts`, `src/lib/docker.ts`: add managed-plan intent/schema fields, discriminated registry results, repository/platform-correct digests, immutable container/image inspection, and targeted multi-file Compose recreation.
- `src/lib/plan-storage.ts`: replace the managed path's `JSON.stringify(plan)`/plain `writeFile()` flow with an allowlisted DTO, runtime validation, private directories/files, atomic rename, size/path/symlink checks; retain ordinary-plan compatibility.
- `src/types/state.ts`, `src/lib/state-storage.ts`, `src/lib/state-queries.ts`, `src/lib/generations.ts`, `src/lib/schema.sql`, `src/lib/migrations.ts`: add `update`, `imageId`, and `imageDigest`; bump `CURRENT_SCHEMA_VERSION` from 2 to 3 and extend every row mapper/select/insert. Keep deployment plus generation writes transactional.
- `src/types/health.ts`, `src/lib/health.ts`: add target image/state/health verification; `waitForDependencyReadiness()` currently evaluates only dependencies and reports ready when a target has none.
- `src/actions/apply.ts`: reject `intent: "managed-update"`; its `--force` behavior must never bypass managed identity drift.
- `src/actions/rollback.ts`: extract/reuse an exact-image restore primitive while preserving manual rollback UX. Current `executeRollback()` derives `targetImage` from a snapshot/tag, calls `pullImages()`, then `startServices()`.
- `src/lib/index.ts`, `src/types/index.ts`, `src/actions/completion.ts`, `src/actions/completion.spec.ts`, `packages/rfapps-cli/README.md`, and `ROADMAP.md`: exports, registration/completion, and documented contract.

## Code Conventions

- TypeScript is strict ESM: type-only imports where applicable, explicit `.js` import suffixes, and no `any`.
- Normalize raw Commander values in the action (`services.split(",")`, numeric parsing, `rawOptions.sidecars === false`); reject incompatible options with `InvalidArgumentError`.
- Use `PlanValidationError`/`InvalidArgumentError` for invalid inputs and `DockerCommandError` or a new typed lifecycle error for operational failures. Register formatters through `registerRfappsErrorFormatters()`; usage failures map to exit 2 and Docker/registry/health/state/restore failures to exit 1.
- Human progress/logging stays on stderr via `logInfo()`, `logWarn()`, `logSuccess()`, `logDebug()`, or `console.error`; emit exactly one final machine document through `formatOutput()` and suppress prompts with `isMachineFormat()`.
- Keep library functions data-oriented: no printing and no `process.exitCode`. The action maps `ManagedUpdateResult` to the process outcome.
- Vitest tests are colocated, mock module boundaries with `vi.mock()`/`vi.mocked()`, and use `vi.clearAllMocks()` in `beforeEach`. Assert exact Docker argv and state transitions, not only success booleans.

## Integration Points

- `generatePlan()` and `checkImageUpdate()` are the current detection path. Replace `ImageUpdateCheck.hasUpdate` ambiguity: local missing, registry/auth/parse failure, unsupported/build service, current, and update available must remain distinct.
- `getLocalImageDigest()` currently selects `RepoDigests[0]`; match the normalized configured repository and platform instead. Keep local image ID, repository digest, index digest, and config digest as distinct fields.
- Add a lifecycle-specific helper instead of reusing `startServices()` unchanged: it currently builds `up -d --remove-orphans`; managed apply/restore requires validated single-service scope, `--force-recreate --pull never`, and no orphan cleanup.
- Extend `inspectContainers()`/Docker types to capture `ContainerInspect.Image`, configured image, platform, state, and health for preflight and post-recreate verification.
- `recordDeployment()` automatically calls `createGeneration()` for successful actions. Add `update` to `DeploymentAction`, `GenerationAction`, and `GENERATION_ACTIONS`, while ensuring only verified updated/restored states are recorded as successful generations.
- Use `initializeDatabase()`/`closeDatabase()` and existing SQLite transactions. Pre-update recovery identity must be durably recorded before pull; cleanup temporary override files and release the project/context lock in `finally`.
- Extend completion fixtures and command lists for every update option; retain the global `--dry-run`, `--yes`, output-format, and env-tool behavior.

## Gotchas and Warnings

- `savePlan()` currently serializes `EnvChange.current`/`desired`; display masking is not a persistence boundary. Managed plan/report DTOs must contain no resolved environment values.
- A mutable tag is not a recovery identity. Automatic restore must pin the captured daemon-local image ID and verify the restored container uses it; never fall back to a tag.
- Pulling by service after preview can follow a moved tag. Revalidate Compose hash, Docker context, current image ID, selected platform, and proposed remote digest before any mutation, then apply the reviewed digest through a private override.
- Dependency readiness cannot establish target health. Verify expected image, running state, configured Docker health, and a bounded stable-running fallback before dependency readiness.
- Restore is image-only under current Compose configuration; it cannot reverse volumes, databases, or migrations. Repeat that boundary in preview and results.
- Unknown detection excludes the service and makes the aggregate result non-successful; a verified restore still exits 1. Restore failure stops later services.
- Preserve `spawn(command, args)` without a shell. Validate saved-plan service/profile/path operands against freshly rendered Compose data, cap/redact subprocess errors, and reject unsafe state/override paths and symlinks.
- `graphify query` could not run in this worktree because `graphify-out/graph.json` is absent; update the graph after implementation from an environment containing the graph artifacts.
