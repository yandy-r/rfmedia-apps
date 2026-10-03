# Task Structure Analysis: Issue #302 Copy Conflict Strategy

## Executive Summary

Use two parallel implementation tasks with strict file ownership: one owner repairs
`validateCopyConfig` and adds the compile-time fence in `config.ts`, while another adds focused
public-boundary tests in `config.test.ts`. A sequential verification and completion-parity audit
then gates the ROADMAP closeout and the PR review/CI/merge lifecycle. No task other than the
validator task may edit `config.ts`.

## Recommended Phase Structure

- **Phase 1: Boundary repair and contract tests (parallel)** — No dependencies.
  - **Task 1A: Validate and retain `copy.conflictStrategy`** — Exclusively own
    `packages/rfmedia-cli/src/lib/config.ts`. Accept exactly `skip`, `overwrite`, `rename`, and
    `ask`; preserve omission; throw `ConfigError` with `propertyPath` set to
    `copy.conflictStrategy`; and add an adjacent `keyof CopyConfigOptions` fence covering every
    current copy option. No other task may modify this file.
  - **Task 1B: Prove the configuration boundary** — Exclusively own
    `packages/rfmedia-cli/src/lib/config.test.ts`. Through public APIs, parameterize all four
    valid values through `validateConfig`, add one focused YAML `loadConfig` round trip, and reject
    an invalid string (plus one representative non-string) as `ConfigError` with the exact
    property path. This task may coordinate on the diagnostic contract but must not edit
    `config.ts`.
- **Phase 2: Focused verification and surface audit (sequential)** — Depends on Tasks 1A and 1B.
  - **Task 2A: Verify and audit** — Run only the focused config test file and rfmedia package
    typecheck. The typecheck is the proof for the compile-time fence. Audit Bash, Zsh, and Fish
    completion templates and their parity test for all four unchanged values; make no completion
    edit when parity is already correct. If a real mismatch is found, create a narrowly scoped
    remedial completion task with exclusive ownership of only the affected template(s) and parity
    assertion.
  - **Task 2B: Close ROADMAP tracking** — Depends on successful Task 2A. Exclusively own
    `ROADMAP.md`; remove #302 from open/next-up surfaces, update the affected open-item count, and
    preserve unrelated roadmap content.
- **Phase 3: Review and delivery lifecycle (sequential)** — Depends on Phase 2.
  - **Task 3A: Review, PR, CI, and merge closeout** — Review the focused diff, resolve every
    actionable review thread, use `.github/pull_request_template.md`, record exact verification
    commands and outcomes, monitor required CI to green, merge as requested, verify issue #302 is
    closed, and clean up the feature branch/worktree only after authoritative merge verification.
    Do not add broad action, adapter, command, or completion tests for an unchanged consumer
    surface; repository hooks and required remote CI still run normally.

## Task Granularity

Keep the implementation to one production file and one test file, owned by different tasks.
`config.ts` combines runtime validation and the exhaustiveness fence because both encode the same
interface-to-validator contract and concurrent edits there would create avoidable conflicts.
`config.test.ts` combines accepted-value, invalid-value, and one load round-trip case because they
share mocks and prove one boundary without creating another suite. ROADMAP and lifecycle work stay
separate so tracking is updated only after the focused behavior and type checks pass.

Do not split out changes to `CopyConfigOptions`, `ConflictStrategy`, MCP adapters, copy commands,
plan schemas, examples, or dependencies: those surfaces already declare or consume the four
values. Treat completion files as audit targets, not planned modifications.

## Dependency Analysis

```text
Task 1A (config.ts) ─┐
                     ├─> Task 2A (focused test + typecheck + completion audit)
Task 1B (tests) ─────┘       └─> Task 2B (ROADMAP)
                                  └─> Task 3A (review/PR/CI/merge/cleanup)
```

Tasks 1A and 1B can proceed concurrently because their write sets do not overlap. Task 2A must
wait for both so runtime behavior, load retention, and compile-time coverage are evaluated
together. Task 2B must wait for verification to avoid marking unfinished work complete, and the
delivery lifecycle must use the verified final diff. There are no circular dependencies. Any test
failure caused by production behavior returns to the Task 1A owner; it does not transfer
`config.ts` ownership to the test or verification task.

## File-to-Task Mapping

- `packages/rfmedia-cli/src/lib/config.ts`: Task 1A, exclusive write ownership for validation and
  the `keyof CopyConfigOptions` fence.
- `packages/rfmedia-cli/src/lib/config.test.ts`: Task 1B, exclusive write ownership for focused
  `validateConfig`/`loadConfig` coverage.
- `packages/rfmedia-cli/src/types/config.ts`: Task 1A read-only source of current handled keys.
- `packages/rfmedia-cli/src/types/conflict.ts`: Task 1A and Task 1B read-only source of the four
  valid literals.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Task 2A read-only audit; conditional
  remedial ownership only if parity is actually wrong.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Task 2A read-only audit; conditional
  remedial ownership only if parity is actually wrong.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Task 2A read-only audit; conditional
  remedial ownership only if parity is actually wrong.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Task 2A read-only parity
  audit; update only with a proven template mismatch.
- `ROADMAP.md`: Task 2B, exclusive write ownership after focused verification passes.
- `.github/pull_request_template.md`: Task 3A read-only PR-body baseline.
