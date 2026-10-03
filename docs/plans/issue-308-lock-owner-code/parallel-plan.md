# Issue 308 Lock Owner Metadata Error Plan

Correct the machine-readable Lidarr preset lock taxonomy without changing lock behavior, journal
behavior, or command grammar. Two disjoint implementation lanes update the runtime/test contract and
the release note, then converge on focused and repository verification. Delivery creates a
template-compliant PR, records its final identity in the live trackers, performs independent review
and fixes, waits for registered green CI, squash-merges, verifies closure, and cleans only this
feature worktree and branch.

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-308/` (branch:
  `fix/308-lock-owner-code`)

All implementation, tests, commits, and PR updates run in this one dedicated worktree. The primary
checkout and the unrelated #307 worktree remain untouched.

## Critically Relevant Files and Documentation

- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`: Error union and both invalid
  owner-metadata throw sites.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts`: Focused lock contract
  suite.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Existing structural `.code` forwarding contract.
- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.test.ts`: Preset apply integration
  regression boundary.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Bash/Zsh/Fish exact-parity
  gate.
- `packages/rfmedia-cli/CHANGELOG.md`: Required public release note.
- `ROADMAP.md`: Live issue counts, Sprint 2, backlog, and cross-cutting status.
- `docs/internal/plex-jwt-deferrals.md`: Live secure-store follow-up tracker.
- `docs/plans/issue-308-lock-owner-code/design.md`: Canonical decisions and exclusions.
- `.github/pull_request_template.md`: Required PR body and verification sections.

## Implementation Plan

### Phase 0: Freeze the Isolated Baseline

#### Task 0.1: Verify Authoritative State Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-308-lock-owner-code/design.md`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- None beyond the planning artifacts attributable to this workflow.

- Confirm the branch starts at current GitHub `origin/master`, the primary checkout is clean, and
  the unrelated #307 worktree remains untouched.
- Confirm #308 is open with no parent/children and no existing PR or branch for this work.
- Enforce Node 22 with `mise exec`, install locked dependencies in this worktree, build
  `@rfmedia/common`, and run the untouched persistence suite under umask `022`.
- Record live issue counts for later ROADMAP reconciliation.

### Phase 1: Correct the Contract and Release Note

#### Task 1.1: Add the Lock-Metadata Code and Critical Test Depends on [0.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-308-lock-owner-code/design.md`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts`

- Add `LIDARR_PRESET_LOCK_METADATA_INVALID` to the persistence error union.
- Change only the hostname/PID and ownership UUID validation throws to the new code. Preserve the
  current message and translator behavior.
- Add one parameterized test with empty-host, zero-PID, and invalid-token rows. Assert only the
  stable code; avoid message, filesystem, or command-layer filler.
- Run the focused persistence suite under Node 22 and umask `022`.

#### Task 1.2: Record the Machine-Contract Correction Depends on [0.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-308-lock-owner-code/design.md`
- `packages/rfmedia-cli/CHANGELOG.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/CHANGELOG.md`

- Add one `Unreleased` / `Fixed` bullet stating that invalid preset lock-owner metadata now emits
  `LIDARR_PRESET_LOCK_METADATA_INVALID` instead of `LIDARR_PRESET_JOURNAL_INVALID` in machine
  failure output.
- Do not create a new error-code reference or alter quality-preset usage documentation.

Tasks 1.1 and 1.2 own disjoint files and may run in parallel. Neither lane may stage, format the
whole tree, or perform Git operations before rendezvous.

### Phase 2: Verify the Integrated Change

#### Task 2.1: Run Focused and Repository Gates Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts`
- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.test.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- None unless a gate exposes a defect within issue scope.

- Run the persistence suite; then run the preset action, shared command-envelope, and shell
  completion parity suites under umask `022`.
- Run package typecheck, root formatting check, Markdown lint, and whitespace checks through
  `mise exec`.
- Audit the exact code literals and confirm only the two owner-metadata sites use the new code.
- Confirm Bash/Zsh/Fish template files have no diff.
- Run the real `lefthook` pre-push path without bypassing it; repair Node 22 native modules only if
  the actual ABI proves stale.

### Phase 3: Publish and Reconcile Live Trackers

#### Task 3.1: Commit, Push, and Open the PR Depends on [2.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/issue-308-lock-owner-code/design.md`
- `docs/plans/issue-308-lock-owner-code/parallel-plan.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

- Review the complete diff, commit intentionally with a `fix(rfmedia): ...` subject, and push the
  configured upstream through the real pre-push hook.
- Open a GitHub PR against `master` using the repository template, exact passing commands, explicit
  compatibility risk, rollback, and `Closes #308`.

#### Task 3.2: Update ROADMAP and Follow-up Parity Depends on [3.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/internal/plex-jwt-deferrals.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`
- `docs/internal/plex-jwt-deferrals.md`

- Refresh live issue counts immediately before editing. Reflect the post-merge #308 count while
  preserving any concurrent issue changes.
- Remove #308 from the open Sprint 2 and low-priority inventories, mark the lock-taxonomy edge
  shipped in the cross-cutting row, and keep Sprint 2 live because #307 remains open.
- Mark #308 resolved in the internal follow-up table using the actual PR link.
- Re-run Markdown lint and whitespace checks, commit, and push the closeout update.

### Phase 4: Review, CI, Merge, and Cleanup

#### Task 4.1: Review and Fix the Active PR Depends on [3.2]

**READ THESE BEFORE TASK**

- The complete active PR diff and review threads.
- `docs/plans/issue-308-lock-owner-code/design.md`

**Instructions**

Files to Create

- A repository review artifact only if the selected review workflow requires it.

Files to Modify

- Only files required by validated findings.

- Run an independent code review against the design and public contract, including adversarial
  taxonomy and test-sufficiency checks.
- Fix every validated finding in bounded changes, rerun affected focused gates, push, and resolve
  all actionable review threads.

#### Task 4.2: Require Green CI and Complete Delivery Depends on [4.1]

**READ THESE BEFORE TASK**

- The active PR check rollup, review decision, and merge state.
- The live #308 issue state.

**Instructions**

Files to Create

- None.

Files to Modify

- None unless a registered CI failure requires an in-scope fix.

- Monitor every registered check on the current head until green. Diagnose and fix failures rather
  than rerunning blindly or bypassing gates.
- Squash-merge the PR and verify the authoritative merge commit, closed PR, and closed #308.
- From the neutral primary checkout, fetch/prune, verify `origin/master` contains the squash merge,
  remove only `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-308`, delete the local
  feature branch, and verify the remote feature branch is gone. Preserve the primary checkout and
  unrelated #307 worktree.

## Advice

- Treat the new literal as a compatibility correction, not a refactor; the changelog is
  load-bearing.
- Change both owner-metadata throws. The UUID path runs inside shared acquisition and is easy to
  miss.
- Do not broaden the issue's grep criterion into reclassifying origin validation or corrupt stored
  locks.
- Completion templates are an audited non-change: prove parity and byte-identical files instead of
  editing generated surfaces gratuitously.
- ROADMAP counts and PR links are live data; refresh them at the closeout boundary rather than
  trusting the planning snapshot.
