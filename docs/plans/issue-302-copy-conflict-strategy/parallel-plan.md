# Copy Conflict Strategy Validation (#302) Implementation Plan

Repair the `rfmedia` configuration trust boundary so `copy.conflictStrategy` is validated and
retained instead of silently dropped. The production change will mirror existing enum-validation
and validator-fence patterns, while focused tests prove every supported literal and the exact
typed error path for invalid input. After the code contract passes, audit all three completion
templates without editing their unchanged command surface, then close the live ROADMAP entry and
add a narrowly worded release note.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-issue-302-copy-conflict-strategy/ (branch: feat/issue-302-copy-conflict-strategy)

## Critically Relevant Files and Documentation

- `packages/rfmedia-cli/src/types/config.ts`: Source of all handled copy option keys.
- `packages/rfmedia-cli/src/types/conflict.ts`: Canonical conflict-strategy union.
- `packages/rfmedia-cli/src/lib/config.ts`: Validation branch and exhaustiveness fence owner.
- `packages/rfmedia-cli/src/lib/config.test.ts`: Focused runtime contract coverage.
- `packages/rfmedia-cli/src/mcp/adapters.ts`: Existing configured-value consumer.
- `packages/rfmedia-cli/src/commands/copy.ts`: Unchanged CLI precedence and plan-freezing context.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Bash completion audit.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Zsh completion audit.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Fish completion audit.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Completion parity gate.
- `packages/rfmedia-cli/CHANGELOG.md`: Scoped release note.
- `ROADMAP.md`: Live issue tracking.
- `docs/plans/plex-config-validation-289/analysis-code.md`: Closest implementation precedent.

## Implementation Plan

### Phase 1: Validation Contract

#### Task 1.1: Validate, Retain, and Fence the Copy Strategy Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/types/conflict.ts`
- `packages/rfmedia-cli/src/lib/config.ts`
- `docs/plans/plex-config-validation-289/analysis-code.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/config.ts`

Add a presence-preserving `conflictStrategy` branch to `validateCopyConfig`. Accept exactly
`skip`, `overwrite`, `rename`, and `ask` using an allowlist typed against `ConflictStrategy`;
reject unsupported strings and non-string values with `ConfigError` whose property path is
`copy.conflictStrategy`; retain the narrowed literal without applying a default. Immediately after
the validator, add a handled-key union and conditional-`never` fence covering every current
`keyof CopyConfigOptions`, following the existing Plex validator fence. Do not change unknown-key
behavior, consumer defaults, Commander options, plan semantics, or conflict actions.

#### Task 1.2: Add Focused Accepted and Rejected Coverage Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/types/conflict.ts`
- `packages/rfmedia-cli/src/lib/config.test.ts`
- `docs/plans/issue-302-copy-conflict-strategy/shared.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/config.test.ts`

Through exported `validateConfig`, add one parameterized test proving all four supported strategy
literals survive validation. Add one parameterized rejection test covering an unsupported string
and a representative non-string value, asserting both `ConfigError` and exact
`propertyPath === "copy.conflictStrategy"`. Do not add adapter, command, action, completion, or
compile-failure tests for unchanged surfaces; package typecheck is the required proof for the
coverage fence.

### Phase 2: Verification and Project Closeout

#### Task 2.1: Run Focused Verification and Audit Completion Parity Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/package.json`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

From the repository root, run `npm run typecheck -w packages/rfmedia-cli`. From
`packages/rfmedia-cli`, run
`env -u FORCE_COLOR npx vitest run src/lib/config.test.ts`. Audit Bash, Zsh, and Fish completion
templates plus the parity test read-only to confirm the unchanged `--conflict-strategy` surface
already exposes the same four values. Do not edit completions merely because configuration
validation changed. If the audit proves an existing mismatch, stop this task and add a separately
scoped remedial task with explicit ownership of only the affected completion files.

#### Task 2.2: Update Release and ROADMAP Records Depends on [2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/CHANGELOG.md`
- `ROADMAP.md`
- `docs/plans/issue-302-copy-conflict-strategy/analysis-docs.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/CHANGELOG.md`
- `ROADMAP.md`

Add an `[Unreleased]` fix note that promises only strict validation and retention for existing
configured-value consumers; do not claim that ordinary `rfmedia copy` now uses the setting as a
CLI default. Remove #302 from the `Next Up` table and the medium-priority open backlog table.
Adjust only the now-#288-specific post-JWT narrative and exit criteria, preserving unrelated issue
ordering and counts.

### Phase 3: Delivery and Authoritative Closeout

#### Task 3.1: Create, Review, Merge, and Clean Up the Pull Request Depends on [2.2]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/issue-302-copy-conflict-strategy/parallel-plan.md`
- `docs/plans/issue-302-copy-conflict-strategy/shared.md`

**Instructions**

Files to Create

- `docs/prps/reviews/pr-<number>-review.md`
- `docs/prps/reviews/fixes/pr-<number>-fixes.md` only when review findings require fixes.

Files to Modify

- None.

Run the required repository gates, commit through the repository hooks, push the feature branch,
and create a GitHub pull request against `master` using every section of the required template.
Perform a structured correctness, security, and maintainability review; publish the review
artifact; apply every actionable finding through separately scoped review-fix tasks that name
their exact 1–3-file ownership; and re-review the final head. Monitor CI for the active PR head SHA
until all required checks are green, resolve every review thread, then squash merge with branch
deletion. Authoritatively verify the PR is merged and issue #302 is closed before pruning refs and
removing the local feature branch and worktree. Do not clean up early if merge or issue-closure
evidence is missing.

## Advice

- Keep `config.ts` and `config.test.ts` under separate Phase 1 owners so implementation can proceed
  in parallel without write conflicts.
- `ask` is valid at the shared configuration boundary even though non-interactive MCP execution
  rejects it later; do not move that consumer-specific rule into validation.
- Do not add a validator-level default. Existing consumers intentionally resolve defaults in
  different execution contexts.
- The coverage fence is compile-time interface-to-validator drift protection, not runtime
  rejection of unknown raw keys.
- Public configuration examples currently omit the field. Leave them unchanged because #302 does
  not repair the ordinary CLI precedence and plan-freezing caveat.
- Treat completion sources as audited and unchanged unless the parity check finds concrete
  evidence to the contrary.
- Run repository-wide required gates after the focused workflow, then use the PR template, perform
  a structured review, fix all actionable findings, monitor the active head SHA to green, squash
  merge, verify issue closure, and only then remove the branch and worktree.
