# Shared Context: Issue 68 Exit Code Standardization

## Issue

GitHub issue #68 requires consistent `rfapps-cli` exit codes:

- `0`: success
- `1`: operational error
- `2`: usage error
- `3`: partial success

It also requires grouped deploy behavior where `rfapps deploy -g media-stack`
exits `1` if any service fails by default, but exits `3` with
`--allow-partial` when some services succeed and some fail.

## Relevant Existing Patterns

- CLI entrypoint: `packages/rfapps-cli/src/cli.ts`
- Deploy action: `packages/rfapps-cli/src/actions/deploy.ts`
- Deploy tests: `packages/rfapps-cli/src/actions/deploy.spec.ts`
- Error formatter registration: `packages/rfapps-cli/src/lib/error-formatters.ts`
- Error formatter tests: `packages/rfapps-cli/src/lib/error-formatters.spec.ts`
- Option types: `packages/rfapps-cli/src/types/options.ts`
- README command docs: `packages/rfapps-cli/README.md`
- Error handling docs: `docs/features/error-handling.md`

Existing action code sets `process.exitCode` directly and formats operational
errors locally. Existing formatter tests assert exit code `1` for all formatter
classes, so usage-class errors need explicit test updates.

## Execution Constraints

- Use the current checkout and branch; do not create a worktree.
- Preserve unrelated untracked files under `docs/prps/`.
- Keep writes scoped to the issue 68 files listed in the plan.
- Prefer shared constants over new magic numbers.
