# Plex Config Validation (#289) Implementation Plan

Repair the `rfmedia-cli` configuration trust boundary so all declared top-level
`PlexConfigOptions` fields are validated and retained. The production change stays inside
`config.ts`, reuses the shared 1,000-item Plex page ceiling and existing leaf validators, and adds a
compile-time handled-key fence modeled on `plan.ts`. Focused config-boundary tests prove the
runtime contract, while documentation communicates the upgrade activation risk and closes the
live planning records. Child issue #302 remains outside this branch.

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-plex-config-validation-289/` (branch: `feat/plex-config-validation-289`)

## Critically Relevant Files and Documentation

- `docs/plans/plex-config-validation-289/shared.md`: Authoritative resolved contract and scope
  guardrails.
- `docs/plans/plex-config-validation-289/feature-spec.md`: Validated design, risks, and acceptance
  criteria.
- `packages/rfmedia-cli/src/lib/config.ts`: Explicit config validators and the silent-drop site.
- `packages/rfmedia-cli/src/lib/config.test.ts`: Public `validateConfig` contract tests.
- `packages/rfmedia-cli/src/types/config.ts`: `PlexConfigOptions` and
  `PlexSyncOnCopyDefaults` source interfaces.
- `packages/rfmedia-cli/src/types/media-server.ts`: Shared
  `MEDIA_IDENTITY_MAX_PAGE_SIZE = 1_000`.
- `packages/rfmedia-cli/src/lib/plan.ts`: Existing conditional-`never` drift-fence pattern.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts`: Downstream regression fixture
  proving `pageSize: 250` is valid.
- `packages/rfmedia-cli/docs/features/plex-configuration.md`: Canonical Plex configuration
  behavior and precedence guide.
- `packages/rfmedia-cli/CHANGELOG.md`: Unreleased package change record.
- `ROADMAP.md`: Live open-work lists and issue totals.
- `docs/roadmap-archive.md`: Completed issue and pull-request history.
- `docs/internal/plex-jwt-deferrals.md`: Source record for the #289 JWT follow-up.

## Implementation Plan

### Phase 1: Parallel Boundary, Tests, and User Documentation

#### Task 1.1: Restore Plex Config Validation and Add Drift Fence Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/plex-config-validation-289/shared.md`
- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/types/media-server.ts`
- `packages/rfmedia-cli/src/lib/config.ts`
- `packages/rfmedia-cli/src/lib/plan.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/config.ts`

Import `PlexSyncOnCopyDefaults` as a type and `MEDIA_IDENTITY_MAX_PAGE_SIZE` as the runtime source
of truth. Add `validatePlexSyncOnCopyDefaults` beside the existing Plex sync validators: accept an
empty object; validate present `popmEmail` through `validateString`; validate present
`vorbisScale` against `VALID_VORBIS_SCALE_VALUES`; preserve the established unknown-key policy.

In `validatePlexConfigOptions`, use the existing present-and-not-`undefined` pattern to:

- validate `pageSize` with `validateBoundedInteger(value, 1,
MEDIA_IDENTITY_MAX_PAGE_SIZE, "plex.pageSize", configPath)`;
- validate and retain literal booleans for `syncRatingsOnCopy`;
- reject non-object/null/array `syncOnCopyDefaults` at the outer path, then call the nested
  validator.

Add an adjacent handled-key union and `Exclude<keyof PlexConfigOptions, ...>` conditional-`never`
constant that covers every current top-level Plex option. Mirror the `plan.ts` pattern without raw
spreads, broad casts, runtime defaults, or new strictness. Run package typecheck before returning.

#### Task 1.2: Add Critical Config-Boundary Regression Coverage Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/plex-config-validation-289/shared.md`
- `docs/plans/plex-config-validation-289/feature-spec.md`
- `packages/rfmedia-cli/src/lib/config.test.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/config.test.ts`

Add one combined success case through public `validateConfig` proving `pageSize: 250`,
`syncRatingsOnCopy`, and both nested sync defaults survive unchanged. Ensure explicit
`syncRatingsOnCopy: false` and an empty nested object are proven either in that test or one compact
companion assertion.

Add compact parameterized rejection coverage for representative page-size type, fraction, lower,
and upper failures; a non-boolean sync flag; invalid nested container shapes; empty/wrong-type
`popmEmail`; and invalid `vorbisScale`. Assert `ConfigError` and the exact dotted `propertyPath`.
Include inclusive boundary acceptance for 1 and 1,000. Do not add consumer/action duplicates or a
runtime test for the type-only fence. Draft the test changes in parallel with Task 1.1; Task 3.1
owns execution after both production and test changes are complete.

#### Task 1.3: Document the Behavior-Changing Fix Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/plex-config-validation-289/shared.md`
- `packages/rfmedia-cli/docs/features/plex-configuration.md`
- `packages/rfmedia-cli/CHANGELOG.md`
- `packages/rfmedia-cli/src/actions/plex-copy.ts`
- `packages/rfmedia-cli/src/actions/plex-playlist.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/docs/features/plex-configuration.md`
- `packages/rfmedia-cli/CHANGELOG.md`

Document the inclusive 1–1,000 Plex `pageSize` range and clarify that valid
`syncRatingsOnCopy` / `syncOnCopyDefaults` values that were previously ignored become active after
upgrade. Retain the existing CLI-over-config precedence and consumption defaults. Call out rating
metadata writes and the existing hardlink/source-inode consequence without duplicating the
long-form workflow or cleaning unrelated stale examples. Add an Unreleased `Fixed` entry. Run
Markdown formatting/lint for the two files before returning.

### Phase 2: Live Planning Record Reconciliation

#### Task 2.1: Reconcile #289 ROADMAP and Deferral Records Depends on [1.1, 1.2, 1.3]

**READ THESE BEFORE TASK**

- `docs/plans/plex-config-validation-289/shared.md`
- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `docs/internal/plex-jwt-deferrals.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `docs/internal/plex-jwt-deferrals.md`

Query live GitHub issue state and totals immediately before editing. Remove #289 from the open
“Next Up” and medium-priority lists, adjust counts without assuming #288's state, archive #289 in
the existing format, and mark its JWT deferral resolved. Keep child issue #302 open and linked as
the audit disposition. If the closing PR number does not yet exist, write an issue-complete archive
entry that can receive the authoritative PR link in the post-PR closeout; do not invent a number.
Avoid unrelated ROADMAP churn and run Markdown formatting/lint.

### Phase 3: Verification

#### Task 3.1: Run Focused and Repository Validation Depends on [1.1, 1.2, 1.3, 2.1]

**READ THESE BEFORE TASK**

- `docs/plans/plex-config-validation-289/shared.md`
- `package.json`
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

Run focused validation first, then all repository gates required by current scripts:

1. `npm run build:common`
2. `npm run typecheck -w packages/rfmedia-cli`
3. From `packages/rfmedia-cli`, `env -u FORCE_COLOR npx vitest run src/lib/config.test.ts`
4. From `packages/rfmedia-cli`,
   `env -u FORCE_COLOR npx vitest run src/lib/adapters/plex-adapter.test.ts`
5. `env -u FORCE_COLOR npm run test:run -w packages/rfmedia-cli`
6. `npm run build:all`
7. `npm run lint`
8. `npm run lint:md`
9. `npm run format:check`
10. `git diff --check`

Audit Bash, Zsh, Fish, and completion parity sources. Record **no change required** because the
feature introduces no CLI command or option. Verify no child-issue #302 implementation, generated
code, dependencies, adapter/action behavior, or completion-source edits entered the diff.

## Advice

- The apparently generic `validatePageSize` is an interactive UI helper with a 5–100 range; using
  it here would reject the valid adapter fixture value 250. Use the shared identity ceiling.
- Explicit `false` and `{}` are part of the contract. Preserve the current
  present-and-not-`undefined` pattern and never materialize consumer defaults during validation.
- The compile-time fence classifies source-interface keys; it does not justify changing runtime
  unknown-key compatibility.
- Existing adapter and playlist tests prove downstream behavior. New tests belong at the config
  boundary that masked the defect.
- Treat live issue totals and PR linkage as drift-prone external facts. Refresh them again before
  the final PR update and before merge.
- After PR creation, the root delivery orchestrator owns backfilling the authoritative PR link into
  any issue-only archive entry, rerunning Markdown/whitespace gates, and pushing that closeout
  update before merge.
- Keep issue #302 separate even though the audit found it during this work.
