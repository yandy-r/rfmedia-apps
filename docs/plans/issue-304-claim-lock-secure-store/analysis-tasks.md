# Issue 304 Implementation Task Analysis

**Status:** Superseded pre-design artifact; retained for historical context and not the
implementation source of truth.
**Canonical design:** [`design.md`](../issue-304-claim-lock-secure-store/design.md)
**Canonical plan:** [`parallel-plan.md`](../issue-304-claim-lock-secure-store/parallel-plan.md)

## Executive Summary

Issue #304 should be delivered as a narrow delete-and-delegate refactor with one behavioral owner
for `plan-engine.ts`. The safest plan has two implementation lanes: a serial core adapter task in
the shared plan engine, and a parallel JSDoc-only task in the secure-store barrel and lock module.
No action module, public type, compatibility test, shell completion, command registration, or public
feature guide should change.

The core task must remain a single-file unit because acquisition translation, ownership assertion,
release behavior, dependency adaptation, and deletion of the legacy helpers are one atomic contract.
Splitting that work between implementers would create overlapping edits in a 4,800-line shared file
and make it possible to test an inconsistent intermediate state. After those two implementation
lanes converge, focused compatibility verification is the gate for documentation, review, CI, and
closeout. The internal deferral record may be updated after the pull request number exists; the live
`ROADMAP.md` reconciliation belongs at the end, immediately before the final CI/merge cycle.

All implementation, verification, commits, review fixes, and PR work should use only the existing
dedicated worktree at `.claude/worktrees/rfmedia-apps-chore-304-claim-lock` on
`chore/304-claim-lock-secure-store`. Do not edit the primary checkout, create another issue-304
worktree, or disturb unrelated worktrees.

## Recommended Phase Structure

### Phase 0 — Isolated baseline and contract capture

**Task 0.1 — Prepare the existing dedicated worktree (no file ownership)**

- Fetch all remotes and verify which remote hosts the GitHub PR before changing state.
- Confirm the dedicated branch starts at the intended current `master`, the worktree is clean, and
  the primary checkout plus unrelated worktrees remain untouched.
- Use the repository's Node 22 runtime through `mise exec -- ...`; do not use a host-default Node.
- Record merge-base copies or hashes for:
  - `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`;
  - the `LidarrPlanClaimDependencies` and `LidarrPlanClaim` declarations;
  - all Bash, Zsh, and Fish completion templates;
  - action-layer claim consumers.
- Run the two focused lock suites before editing when practical. A pre-existing failure is a blocker
  to attributing later results, not permission to alter the compatibility tests.

This phase is serial and precedes every editing task.

### Phase 1 — Core migration and adjacent JSDoc

**Task 1.1 — Migrate the claim adapter (one file, high risk)**

Owned file:

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

Required result:

- Import `acquireExclusiveLock` and `SecureStoreError` through
  `../secure-store/index.js`, using a type-only import if `SecureStoreLock` is named.
- Preserve `LidarrPlanClaimDependencies`, `LidarrPlanClaim`, the claim path, validation order,
  dependency seams, and caller-visible Lidarr errors.
- Adapt the Date-returning clock and injected owner/UUID/liveness sources without changing the
  public dependency interface. Validate owner metadata and the injected ownership UUID before the
  shared lock performs filesystem I/O.
- Delegate once with a fixed subject, `deadlineEpochMs` equal to the injected acquisition time,
  `maxAgeMs: null`, the existing fail-closed liveness probe, and no `binding`.
- Implement distinct acquisition, assertion, and release translation paths. Busy/corrupt acquire
  and busy/corrupt assertion failures become `LidarrPlanAlreadyRunningError`; corrupt release
  resolves without unlinking; path, permission, size, and other I/O failures remain within the
  existing Lidarr artifact taxonomy with fixed path-free messages and the original failure as
  `cause`.
- Return only the existing `{ path, assertOwned, release }` capability. Shared-only fields must not
  cross the adapter boundary.
- Delete only `CLAIM_MAX_BYTES`, `ClaimRecord`, `parseClaimRecord`, `readClaim`, `claimIsOwned`,
  `unlinkClaimIfOwned`, and the bespoke claim acquire loop once they are unused.
- Retain imports and helpers still used by plan/history artifact publication. In particular, do not
  remove the separate artifact-writer `link()` call owned by issue #305.

Do not split this task. One owner must make all changes in `plan-engine.ts`, and every later review
fix to this file must be serialized through that same ownership lane.

**Task 1.2 — Correct secure-store JSDoc (two files, low risk)**

Owned files:

- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`

Required result:

- Update the barrel documentation to say the Lidarr claim lock now delegates to the shared lock,
  while the plan/history bounded readers, safe path walks, directory hardeners, and atomic writers
  remain local for #305.
- Update the exported UUID-pattern documentation so it no longer claims that `plan-engine.ts`
  declares a duplicate pattern.
- Do not change runtime behavior, exports, lock schema, or tests in this task.

Tasks 1.1 and 1.2 can run in parallel because their file sets do not overlap. They should converge
into one focused refactor commit containing at most these three source files, so the behavior change
and the JSDoc made true by it remain one revert unit.

### Phase 2 — Focused compatibility and completion audit

**Task 2.1 — Prove the migrated contract (read-only verification)**

This task starts only after both Phase 1 tasks are complete and the source tree is quiescent. Run,
under Node 22:

```bash
cd packages/rfmedia-cli
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts
umask 022 && env -u FORCE_COLOR npx vitest run src/lib/shell-completions/templates.spec.ts
npm run typecheck
npm run check:architecture
```

The three focused Vitest commands may run in parallel after editing stops. Typecheck and the
architecture gate may also run in parallel with each other, but their generated-client prechecks
must not be launched concurrently with another codegen-related command. Re-run any combined output
serially if it obscures a failure.

The task must also prove these static invariants:

- `plan-engine.test.ts` and its snapshots are byte-identical to the merge base.
- `LidarrPlanClaimDependencies` and `LidarrPlanClaim` are byte-identical to the merge base.
- No action-layer claim consumer changed, and the existing acquisitions still release in outer
  `finally` blocks.
- No Bash, Zsh, or Fish completion template changed, and the exact apply-option parity test passes.
- The claim-private parser/read/ownership/unlink helpers and bespoke claim publication loop are
  absent.
- The plan artifact writer's independent `link()` path is still present; a blanket zero-`link()`
  assertion would be incorrect until #305.
- No `SecureStoreError`, raw errno, shared path, or remediation field escapes the Lidarr adapter.

Editing `plan-engine.test.ts` to make this phase pass is an abort condition. A new test is permitted
only if implementation uncovers a genuinely unproved translator branch; stop, document the exact
gap, and add one focused contract case in that single test file after explicit re-scoping. Do not
add broad action tests or duplicate the secure-store suite.

### Phase 3 — Pull request identity and internal documentation

**Task 3.1 — Create the initial PR identity (no source files)**

- Commit the verified Phase 1 revert unit, push the branch, and open the PR using
  `.github/pull_request_template.md`.
- Keep every required PR section, use `Closes #304`, and list exact commands plus pass/fail results.
- State explicitly that the CLI surface did not change, Bash/Zsh/Fish templates were audited and
  remained unchanged, compatibility suites were not modified, and public operator docs therefore
  require no update.
- Do not bypass the real `lefthook` pre-push path. If Node-native SQLite has an ABI mismatch, rebuild
  it under Node 22 and rerun the hook rather than skipping it.

Opening the PR at this point supplies an authoritative PR number for the internal completion
record. It may be draft until documentation and full verification are complete.

**Task 3.2 — Close the internal deferral record (one file)**

Owned file:

- `docs/internal/plex-jwt-deferrals.md`

Required result:

- Replace the stale “exactly two lock implementations” statement with the shipped single-lock
  architecture while preserving the historical explanation of why #304 was deferred from #288.
- Mark #304 resolved by the actual PR number.
- Keep #305 open and explicitly scoped to remaining plan/history path walks, readers, directory
  hardeners, and writers.
- Do not rewrite the historical issue-288 design or claim #305–#308 are complete.

This task depends on the Phase 2 compatibility gate and Task 3.1's PR number. It does not depend on
ROADMAP editing and can proceed while initial PR review or CI is running, provided no source edits
are in flight.

### Phase 4 — Review, fixes, and live ROADMAP closeout

**Task 4.1 — Review and apply focused fixes (one to three files per fix group)**

- Review the complete diff for correctness, security, scope, and compatibility before treating bot
  or human comments as authoritative.
- Group findings by file. Any finding in `plan-engine.ts` returns to the serial Task 1.1 owner and
  triggers both lock suites plus typecheck. JSDoc-only findings may proceed independently.
- Resolve every actionable thread and verify the PR head SHA after each push. Do not merge while a
  requested change, unresolved thread, or stale-head CI result remains.

**Task 4.2 — Reconcile the living roadmap (one file, last content task)**

Owned file:

- `ROADMAP.md`

Required result:

- Immediately before closeout, query the live open-issue inventory and recalculate total,
  `rfapps-cli`, and `rfmedia-cli` counts rather than copying the values from research.
- Remove #304 from Sprint 2 and the rfmedia medium backlog, renumber #305–#308, and update Current
  Focus plus the Secure artifact I/O row to distinguish shipped #288/#304 from still-open #305–#308.
- Preserve the Sprint 2 narrative because the sprint remains open. Do not edit
  `docs/roadmap-archive.md`; the maintenance policy moves narrative there only when the full sprint
  closes.

This task must be serial and late. ROADMAP is live shared state and can become stale while review is
ongoing. If another issue changes the inventory before merge, refresh this same task, rerun Markdown
gates, push, and wait for CI on the new head.

### Phase 5 — Final gates, merge, and cleanup

**Task 5.1 — Final repository verification (read-only except formatting fixes)**

After all source, internal-doc, review, and ROADMAP changes settle, run from the repository root:

```bash
npm run test:run
npm run lint:md
npm run format:check
git diff --check
```

Also rerun the focused suite associated with every post-review source change. Formatting may be
applied only to the owned changed files; avoid repository-wide format rewrites. Commit internal ADR
and ROADMAP changes as separate documentation commits when practical so each remains an honest
revert unit.

**Task 5.2 — Authoritative PR completion and cleanup (no file ownership)**

- Confirm the PR's active head SHA is the commit that passed registered CI.
- Confirm all required checks are green and all review threads are resolved.
- Reconfirm the live ROADMAP counts, no compatibility/completion/action file drift, and exact PR
  template content.
- Squash-merge only after those gates pass, then verify the merge commit, issue #304 closure, and
  remote feature-branch deletion from authoritative GitHub state.
- Remove only the dedicated issue-304 worktree and its local branch after merge/closure proof.
  Preserve the primary checkout and unrelated worktrees, even if they are dirty.
- Fetch/prune and verify the remote default branch contains the squash merge; do not rewrite or
  clean unrelated local state as part of closeout.

## Task Granularity Recommendations

| Task                        | Files | Why this size is optimal                                                                                        |
| --------------------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| 1.1 core adapter            | 1     | All behavior is coupled inside one shared file; splitting creates overlap and inconsistent intermediate states. |
| 1.2 shared JSDoc            | 2     | Both comments describe one canonical-lock boundary and have no runtime or file overlap with Task 1.1.           |
| 2.1 contract audit          | 0     | Verification must inspect, not rewrite, the compatibility surface.                                              |
| 3.2 internal ADR            | 1     | It needs the actual PR number and has an independent review surface.                                            |
| 4.1 review fix group        | 1–3   | Group only same-file or tightly coupled findings; rerun the smallest affected gate before the full suite.       |
| 4.2 ROADMAP closeout        | 1     | Live counts and queue state are one consistency unit and should not be mixed with architecture edits.           |
| 5.1/5.2 gates and lifecycle | 0     | These tasks validate and publish the existing diff; they should not introduce feature scope.                    |

Do not create separate tasks for action modules, error classes, tests, completions, public feature
guides, or README files. Those are compatibility evidence and explicit no-change surfaces. Treat
the research/design artifacts in this directory as implementation inputs; do not let formatting or
planning-document churn expand the runtime task ownership.

## Dependency Analysis

```text
0.1 isolated baseline
  ├─> 1.1 plan-engine adapter ─┐
  └─> 1.2 secure-store JSDoc ─┴─> 2.1 focused compatibility gate
                                      └─> 3.1 verified initial PR
                                            ├─> 3.2 internal ADR
                                            └─> 4.1 review and fixes
                                                   └─> 4.2 live ROADMAP closeout
                                                          └─> 5.1 final gates
                                                                 └─> 5.2 squash merge and cleanup
```

The only safe source-edit parallelism is Task 1.1 alongside Task 1.2. After an initial PR exists,
Task 3.2 may overlap with CI/review observation, but not with a conflicting edit or commit operation
in the same worktree. ROADMAP must not be parallelized because it depends on the latest issue state
and is intentionally the final content edit.

Within verification, independent focused tests can execute concurrently after all writers stop.
Full repository tests, the real pre-push hook, and final CI are serial convergence gates. Review
fixes invalidate any earlier CI result; the active PR head, not an older green commit, is the unit
that must pass.

Issue #305 is a downstream dependency, not a parallel task. It shares `plan-engine.ts` and depends
on the error taxonomy established here, so it must not begin in this worktree or PR before #304 is
merged.

## File-to-Task Mapping

| File or file set                                                                            | Task     | Intended action                                                                                         |
| ------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`                                        | 1.1      | Replace bespoke claim machinery with a domain adapter and translators; preserve unrelated artifact I/O. |
| `packages/rfmedia-cli/src/lib/secure-store/index.ts`                                        | 1.2      | Correct the canonical-boundary and #305 deferral JSDoc.                                                 |
| `packages/rfmedia-cli/src/lib/secure-store/lock.ts`                                         | 1.2      | Correct stale UUID-pattern JSDoc only.                                                                  |
| `docs/internal/plex-jwt-deferrals.md`                                                       | 3.2      | Record #304 as resolved by the actual PR and retain #305's open scope.                                  |
| `ROADMAP.md`                                                                                | 4.2      | Reconcile live counts, queue order, focus, backlog, and cross-cutting status.                           |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`                                   | 0.1, 2.1 | Baseline and verify byte identity; no planned edit.                                                     |
| `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`                            | 0.1, 2.1 | Run the canonical primitive contract unchanged.                                                         |
| `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and `templates.spec.ts` | 2.1      | Audit no-diff parity and run the existing exact-option test.                                            |
| `packages/rfmedia-cli/src/actions/lidarr/**` claim consumers                                | 0.1, 2.1 | Compile and audit unchanged callback/finally lifecycle.                                                 |
| `packages/rfmedia-cli/src/lib/errors.ts`                                                    | 2.1      | Confirm existing Lidarr errors remain the public boundary; no edit.                                     |
| `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` and READMEs                       | 2.1, 3.1 | Confirm operator contract remains accurate; explain no change in PR.                                    |
| `docs/roadmap-archive.md`                                                                   | 4.2      | Explicit no-change file because Sprint 2 remains open.                                                  |

## Optimization Opportunities

- Reuse the shipped `acquireLidarrPresetApplyLock` adapter structure for explicit policy options,
  exhaustive shared-error translation, idempotent owner-safe release, and fixed local messages.
  Keep plan-specific error meanings separate rather than extracting a premature common translator.
- Delete claim-private code instead of wrapping it. The shared primitive already owns atomic
  publication, full-record-plus-inode checks, stale recovery, corruption handling, and release.
- Keep the Phase 1 source diff to three files. This makes review, rollback, static no-change audits,
  and root-cause isolation substantially cheaper.
- Run focused filesystem suites before typecheck/full tests, so policy regressions fail quickly.
  Once the source tree is stable, parallelize only the independent focused test processes.
- Capture merge-base hashes or blobs once in Phase 0 and reuse them for final byte-identity checks;
  do not depend on visual diff inspection alone.
- Open a verified draft PR before internal-doc closeout so the ADR records the real PR number. Update
  the PR body after final gates rather than guessing future evidence.
- Recompute ROADMAP data with one authoritative live inventory immediately before merge. Avoid
  hardcoded counts from design documents or earlier issue snapshots.
- Use the real pre-push hook as the local full-workflow gate. If it exposes a Node ABI problem,
  repair the native dependency under Node 22; never bypass the hook.

## Implementation Strategy Recommendations

1. Treat behavior preservation as the primary acceptance criterion. The migration succeeds when
   unmodified claim and secure-store suites pass and observable action behavior is unchanged, not
   merely when `plan-engine.ts` imports the shared primitive.
2. Encode lock policy explicitly at the adapter call: zero wait, no cross-host age steal, local
   fail-closed liveness, fixed subject, no binding, and preserved UUID/clock seams. These are safety
   requirements, not optional tuning.
3. Keep acquisition, assertion, and release translation separate. In particular, release corruption
   is foreign ownership and must resolve without unlinking or masking an in-flight apply error.
4. Preserve validation before shared I/O and construct fresh Lidarr errors with fixed messages.
   Retain the original failure only as `cause`; never forward shared path/remediation text or raw
   path-bearing filesystem messages.
5. Use a single owner for every `plan-engine.ts` change, including review fixes. The file is the
   shared boundary with #305, and parallel edits there would defeat the intended dependency order.
6. Keep commit boundaries aligned with rollback: one source refactor commit (Tasks 1.1 and 1.2), one
   internal-ADR commit, and one live-ROADMAP closeout commit. Squash merge remains the publication
   policy, while local commits preserve review and revert clarity.
7. Stop and re-scope if an existing compatibility test must change, action callbacks need new
   parameters, a CLI/config surface appears necessary, a legacy record needs a binding, or remaining
   plan/history I/O must move. Each condition indicates issue #305 or a separate behavior change is
   leaking into #304.
8. Finish the complete lifecycle: focused gates, root gates, real pre-push, PR-template evidence,
   review-thread resolution, active-head green CI, live ROADMAP verification, squash merge, issue
   closure, remote-branch deletion, and dedicated-worktree cleanup. An open PR or green local tree is
   not completion.
