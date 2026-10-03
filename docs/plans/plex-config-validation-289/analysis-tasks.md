# Task Analysis: Plex Config Validation (#289)

## Executive Summary

Plan the work as one trust-boundary implementation, one focused contract-test task, one user-facing
documentation task, one late live-state closeout task, and final verification. File ownership is
nonoverlapping within each parallel batch. The implementation remains Plex-only: issue #302 owns
`copy.conflictStrategy`, and shell completion files are audited without edits.

## Recommended Phase Structure

### Phase 1: Boundary Repair and User Communication

#### Task 1.1 — Restore Plex config validation `[sequential foundation]`

**Files:** `packages/rfmedia-cli/src/lib/config.ts`

- Import `PlexSyncOnCopyDefaults` and `MEDIA_IDENTITY_MAX_PAGE_SIZE`.
- Add `validatePlexSyncOnCopyDefaults` beside the existing Plex sync validator.
- Retain `pageSize`, `syncRatingsOnCopy`, and `syncOnCopyDefaults` through guarded validation.
- Add an adjacent handled-key/conditional-`never` fence for every `keyof PlexConfigOptions`.
- Preserve fresh-object allowlisting, omission, exact paths, and current unknown-key behavior.

**Acceptance:** Package typecheck passes; explicit `false` is retained; no consumer/default logic
changes.

#### Task 1.2 — Document behavior activation `[parallel with Task 1.1]`

**Files:** `packages/rfmedia-cli/docs/features/plex-configuration.md`,
`packages/rfmedia-cli/CHANGELOG.md`

- State the inclusive 1–1,000 Plex page-size contract.
- Explain that previously ignored valid settings become active after upgrade.
- Call out rating metadata writes and the existing hardlink/source-inode consequence.
- Preserve documented CLI-over-config precedence; avoid unrelated legacy-doc cleanup.

**Acceptance:** Markdown lint passes and the Unreleased section describes a behavior-changing fix.

### Phase 2: Contract Proof

#### Task 2.1 — Add config-boundary regressions `[depends on Task 1.1]`

**Files:** `packages/rfmedia-cli/src/lib/config.test.ts`

- Add one combined success case that round-trips all three fields through `validateConfig`.
- Include explicit `syncRatingsOnCopy: false` in the accepted proof or an equally compact companion
  assertion.
- Parameterize page-size acceptance at 1 and 1,000 and representative rejection of wrong type,
  fraction, below range, and above range.
- Cover non-boolean sync, invalid nested container, invalid/empty `popmEmail`, and invalid
  `vorbisScale`; assert exact `ConfigError.propertyPath`.
- Do not add a runtime test for the type fence or duplicate consumer/action tests.

**Acceptance:** Focused config tests pass and fail before any adapter/action is invoked.

### Phase 3: Live-State Documentation Closeout

#### Task 3.1 — Reconcile #289 planning records `[sequential late task]`

**Files:** `ROADMAP.md`, `docs/roadmap-archive.md`,
`docs/internal/plex-jwt-deferrals.md`

- Refresh issue totals and sequencing from live GitHub state immediately before editing.
- Remove #289 from “Next Up” and the relevant open backlog without assuming #288's state.
- Archive #289 using the actual closing PR identifier and mark its JWT deferral resolved.
- Keep child issue #302 open and separate; avoid unrelated counter or archive churn.

**Acceptance:** Counts, links, open-work lists, and resolution narrative agree with live state.

### Phase 4: Verification and Delivery

#### Task 4.1 — Run critical gates `[depends on Tasks 1.1, 1.2, 2.1]`

**Files:** none; read-only verification

1. `npm run build:common`
2. `npm run typecheck -w packages/rfmedia-cli`
3. From `packages/rfmedia-cli`, run
   `env -u FORCE_COLOR npx vitest run src/lib/config.test.ts`.
4. From `packages/rfmedia-cli`, run
   `env -u FORCE_COLOR npx vitest run src/lib/adapters/plex-adapter.test.ts`.
5. `env -u FORCE_COLOR npm run test:run -w packages/rfmedia-cli`
6. `npm run build:all`
7. `npm run lint`
8. `npm run lint:md`
9. `npm run format:check`
10. `git diff --check`

Audit `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`, `zsh.ts`, `fish.ts`, and
`templates.spec.ts`; record “no change required” because there is no CLI-surface change.

#### Task 4.2 — Finalize delivery records `[depends on Task 4.1 and live PR identifier]`

**Files:** the three Task 3.1 planning files only if final identifiers changed

- Recheck live issue/PR state, resolve any final identifier placeholders, and rerun Markdown plus
  whitespace gates.
- Confirm #302 exists as the audit disposition and that no completion-source edits landed.

## Task Granularity Recommendations

- Keep the runtime validator and type fence together: both classify the same source interface, and
  splitting them invites transient drift.
- Keep all new runtime tests in one task/file; the small parameter table is one contract, not
  separate page-size and rating-sync features.
- Pair the feature guide with the changelog because both describe upgrade activation, but isolate
  live ROADMAP/archive work until identifiers and counts are authoritative.
- Treat completion parity as a verification note, not an implementation task.
- Limit each modifying task to one to three files and avoid adapter/action/type edits unless a
  focused test demonstrates the config-only repair is insufficient.

## Dependency Analysis

```text
Task 1.1 runtime repair ──> Task 2.1 contract tests ──┐
                                                     ├─> Task 4.1 gates
Task 1.2 guide/changelog ────────────────────────────┘

live issue counts + closing PR ──> Task 3.1 closeout ──> Task 4.2 final records
Task 4.1 gates ────────────────────────────────────────> Task 4.2 final records
```

- Task 1.2 can run in parallel with Task 1.1 because the contract is already resolved and ownership
  does not overlap.
- Task 2.1 should follow Task 1.1 for execution, though test drafting may begin earlier.
- Task 3.1 is intentionally late; ROADMAP totals and archive links are drift-prone external facts.
- Full package/repository gates follow focused proof to shorten feedback loops.

## File-to-Task Mapping

| Task    | Owned files                                   | Ownership rule                              |
| ------- | --------------------------------------------- | ------------------------------------------- |
| 1.1     | `packages/rfmedia-cli/src/lib/config.ts`      | Sole production-code owner                  |
| 1.2     | Plex feature guide; package changelog         | Sole user-doc owner in Phase 1              |
| 2.1     | `packages/rfmedia-cli/src/lib/config.test.ts` | Sole test owner                             |
| 3.1/4.2 | ROADMAP, roadmap archive, JWT deferrals       | Same late owner; never parallel with itself |
| 4.1     | No writes                                     | Read-only validation and completion audit   |

Read-only references include `src/types/config.ts`, `src/types/media-server.ts`, `src/lib/plan.ts`,
adapter/action consumers, and shell completion templates.

## Optimization Opportunities

- Use one accepted fixture to prove all three dropped fields, reducing setup and making the defect
  obvious.
- Use a compact table of `{value, propertyPath}` invalid cases rather than many near-identical
  tests.
- Run typecheck and focused config tests before full tests/build/lint.
- Run focused config and adapter regressions independently once changes settle.
- Reuse the shared maximum and Vorbis tuple to eliminate parallel constants and future drift.
- Perform a single live GitHub inventory pass immediately before Task 3.1/4.2 rather than repeatedly
  editing ROADMAP counts during implementation.

## Implementation Strategy Recommendations

1. Start with the smallest production diff in `config.ts`; do not touch consumers or public types.
2. Preserve the established presence checks so `false` and `{}` are distinguishable from omission.
3. Keep exact dotted paths central to tests because loader recovery depends on actionable errors.
4. Reject the conflicting security-research proposals for 5–100 paging, unknown-key rejection, and
   new POPM byte/NUL rules; the resolved authoritative contract retains current compatibility.
5. Do not change Bash, Zsh, Fish, or parity-test sources; audit and record parity only.
6. Treat live ROADMAP/archive reconciliation and actual PR linking as delivery work after green
   implementation gates, not speculative implementation edits.
