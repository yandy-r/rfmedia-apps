# Parallel Plan: Issue 68 Exit Code Standardization

## Overview

Standardize `rfapps-cli` process exit codes around a shared helper, classify
usage errors as exit code `2`, preserve operational failures as `1`, and add
deploy-only `--allow-partial` behavior that returns `3` when grouped or
multi-service deploys partially succeed.

## Requirements

- Exit codes: `0` success, `1` operational error, `2` usage error, `3` partial success.
- `rfapps deploy -g media-stack` exits `1` if any service fails by default.
- `rfapps deploy -g media-stack --allow-partial` exits `3` when at least one
  targeted service succeeds and at least one fails.
- Usage errors from Commander and rfapps validation errors use code `2`.
- Help text and README document exit codes and the deploy `--allow-partial` flag.

## Architecture Changes

- Create `packages/rfapps-cli/src/lib/exit-codes.ts`.
- Modify `packages/rfapps-cli/src/lib/error-formatters.ts` for usage-error exit codes.
- Modify `packages/rfapps-cli/src/cli.ts` for deploy flag and exit-code help text.
- Modify `packages/rfapps-cli/src/types/options.ts` for `DeployOptions.allowPartial`.
- Modify `packages/rfapps-cli/src/actions/deploy.ts` to resolve deploy exit codes.
- Add/update focused tests and docs.

## Batches

Steps grouped by dependency for parallel execution. Steps within the same batch
run concurrently; batches run in order.

| Batch | Steps         | Depends On | Parallel Width |
| ----- | ------------- | ---------- | -------------- |
| B1    | 1.1, 1.2      | -          | 2              |
| B2    | 2.1, 2.2, 2.3 | B1         | 3              |
| B3    | 3.1, 3.2      | B2         | 2              |
| B4    | 4.1, 4.2      | B3         | 2              |

- **Total steps**: 9
- **Total batches**: 4
- **Max parallel width**: 3

## Implementation Steps

### 1.1 Create Shared Exit Code Module

- **Depends on**: `[none]`
- **Files to create**: `packages/rfapps-cli/src/lib/exit-codes.ts`
- **Read these before task**:
  - `packages/rfapps-cli/src/types/results.ts`
- **Instructions**:
  - Define `ExitCode` constants for success, operational error, usage error,
    and partial success.
  - Export a type for exit code values.
  - Add helpers for setting `process.exitCode` and resolving deploy exit code
    from a `DeployResult` plus `allowPartial`.
  - Return partial success only when at least one service succeeded and at
    least one service failed.

### 1.2 Add Exit Code Helper Tests

- **Depends on**: `[none]`
- **Files to create**: `packages/rfapps-cli/src/lib/exit-codes.spec.ts`
- **Read these before task**:
  - `packages/rfapps-cli/src/types/results.ts`
- **Instructions**:
  - Test all numeric constants.
  - Test success, total failure, mixed failure without `allowPartial`, and
    mixed failure with `allowPartial`.

### 2.1 Wire Commander Usage Help

- **Depends on**: `[1.1]`
- **Files to modify**: `packages/rfapps-cli/src/cli.ts`
- **Read these before task**:
  - `packages/rfapps-cli/src/cli.ts`
  - `packages/rfapps-cli/src/lib/exit-codes.ts`
- **Instructions**:
  - Add global help text documenting exit codes.
  - Ensure Commander usage errors are mapped to usage error code `2` without
    breaking help/version success behavior.

### 2.2 Add Deploy Allow-Partial CLI Option

- **Depends on**: `[1.1]`
- **Files to modify**: `packages/rfapps-cli/src/cli.ts`
- **Read these before task**:
  - `packages/rfapps-cli/src/cli.ts`
- **Instructions**:
  - Add `--allow-partial` to the deploy command.
  - Help text should state that mixed grouped or multi-service deploy outcomes
    exit `3` instead of `1`.

### 2.3 Classify Formatted Usage Errors

- **Depends on**: `[1.1]`
- **Files to modify**: `packages/rfapps-cli/src/lib/error-formatters.ts`
- **Read these before task**:
  - `packages/rfapps-cli/src/lib/error-formatters.ts`
  - `packages/rfapps-cli/src/lib/exit-codes.ts`
- **Instructions**:
  - Use `ExitCode.UsageError` for service, group, profile, invalid argument,
    and missing env-file formatters.
  - Leave Docker/runtime/config parse failures as operational errors.

### 3.1 Extend Deploy Option Types

- **Depends on**: `[2.2]`
- **Files to modify**: `packages/rfapps-cli/src/types/options.ts`
- **Read these before task**:
  - `packages/rfapps-cli/src/types/options.ts`
- **Instructions**:
  - Add `allowPartial?: boolean` to `DeployOptions`.

### 3.2 Apply Partial-Success Exit Logic

- **Depends on**: `[1.1, 3.1]`
- **Files to modify**: `packages/rfapps-cli/src/actions/deploy.ts`
- **Read these before task**:
  - `packages/rfapps-cli/src/actions/deploy.ts`
  - `packages/rfapps-cli/src/lib/exit-codes.ts`
  - `packages/rfapps-cli/src/types/options.ts`
- **Instructions**:
  - Parse `rawOptions.allowPartial`.
  - Use shared helpers instead of literal partial-failure exit codes for
    aggregated deploy results.
  - Keep hard failures as operational error `1`.

### 4.1 Add Focused Behavior Tests

- **Depends on**: `[2.1, 2.2, 2.3, 3.2]`
- **Files to modify**:
  - `packages/rfapps-cli/src/actions/deploy.spec.ts`
  - `packages/rfapps-cli/src/lib/error-formatters.spec.ts`
- **Files to create**:
  - `packages/rfapps-cli/src/cli.spec.ts`
- **Read these before task**:
  - `packages/rfapps-cli/src/actions/deploy.spec.ts`
  - `packages/rfapps-cli/src/lib/error-formatters.spec.ts`
  - `packages/rfapps-cli/src/cli.ts`
- **Instructions**:
  - Add deploy tests for default mixed failure `1`, allow-partial mixed
    failure `3`, and all-failed `1`.
  - Update formatter tests to assert usage errors return `2`.
  - Add CLI help/usage tests if the CLI module supports safe import or command
    spawning in this test suite.

### 4.2 Document User-Facing Contract

- **Depends on**: `[2.2, 3.2]`
- **Files to modify**:
  - `packages/rfapps-cli/README.md`
  - `docs/features/error-handling.md`
- **Read these before task**:
  - `packages/rfapps-cli/README.md`
  - `docs/features/error-handling.md`
- **Instructions**:
  - Add an exit-code table.
  - Add `--allow-partial` to deploy options.
  - Document default grouped deploy partial failure `1` and
    `--allow-partial` partial success `3`.

## Testing Strategy

- `npm --workspace packages/rfapps-cli run test:run -- src/lib/exit-codes.spec.ts`
- `npm --workspace packages/rfapps-cli run test:run -- src/lib/error-formatters.spec.ts`
- `npm --workspace packages/rfapps-cli run test:run -- src/actions/deploy.spec.ts`
- `npm --workspace packages/rfapps-cli run typecheck`

## Success Criteria

- Shared exit code constants exist.
- Usage-class errors use exit code `2`.
- Default grouped deploy partial failure exits `1`.
- Grouped or multi-service deploy with `--allow-partial` exits `3` only for
  mixed success/failure.
- Help text and README document all four exit codes.
- Focused tests and typecheck pass.
