# PR Review #265 — feat(rfapps): add global state locking

**Reviewed**: 2026-07-24T17:05:44Z
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/rfapps-state-locking → master
**Decision**: APPROVE

## Worktree Setup

- **Parent**:
  `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-rfapps-state-locking/.codex/worktrees/rfmedia-apps-pr-265/`
  (branch: feat/rfapps-state-locking)

## Summary

The global state-lock implementation is complete, fails closed, and preserves mutual exclusion
across acquisition, release, forced recovery, and replacement races. A follow-up review found and
resolved a fresh-install path-selection regression: the global lock now uses the same XDG/legacy
state directory as the database without creating the legacy sentinel. The CLI/MCP adoption,
operator recovery UX, tests, completions, and documentation are consistent with the issue and
repository conventions; no actionable findings remain.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

None.

## Validation Results

| Check      | Result                        |
| ---------- | ----------------------------- |
| Type check | Pass                          |
| Lint       | Pass                          |
| Tests      | Pass — 1336 passed, 2 skipped |
| Build      | Pass                          |

## Follow-up Review

- The default global lock path now derives from `getDefaultDatabasePath()`, matching the existing
  XDG-first, legacy-second policy without changing a fresh installation's database location.
- The deploy integration harness now starts from a genuinely fresh fake home and asserts that a
  successful mutation does not create `~/.rfapps`.
- An independent review found one low-severity documentation precision issue about XDG precedence;
  the README and implementation report were corrected and the finding was verified resolved.

## Files Reviewed

- `ROADMAP.md` (Modified)
- `docs/prps/plans/completed/rfapps-state-locking.plan.md` (Added)
- `docs/prps/reports/rfapps-state-locking-report.md` (Added)
- `docs/roadmap-archive.md` (Modified)
- `packages/rf-common/src/errors.test.ts` (Modified)
- `packages/rf-common/src/errors.ts` (Modified)
- `packages/rf-common/src/index.ts` (Modified)
- `packages/rf-common/src/prompt.ts` (Modified)
- `packages/rfapps-cli/README.md` (Modified)
- `packages/rfapps-cli/src/actions/completion.spec.ts` (Modified)
- `packages/rfapps-cli/src/actions/completion.ts` (Modified)
- `packages/rfapps-cli/src/actions/force-unlock.spec.ts` (Added)
- `packages/rfapps-cli/src/actions/force-unlock.ts` (Added)
- `packages/rfapps-cli/src/cli.deploy.integration.spec.ts` (Modified)
- `packages/rfapps-cli/src/cli.ts` (Modified)
- `packages/rfapps-cli/src/commands/force-unlock.ts` (Added)
- `packages/rfapps-cli/src/lib/state-lock.spec.ts` (Added)
- `packages/rfapps-cli/src/lib/state-lock.ts` (Added)
- `packages/rfapps-cli/src/mcp/tools-mutate.ts` (Modified)
- `packages/rfapps-cli/src/mcp/tools-read.ts` (Modified)
- `packages/rfapps-cli/src/mcp/tools.spec.ts` (Modified)
- `packages/rfapps-cli/src/testing/cli-harness.ts` (Modified)
