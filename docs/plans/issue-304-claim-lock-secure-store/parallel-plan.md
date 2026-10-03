# Issue 304 Claim-Lock Secure-Store Implementation Plan

Replace the last bespoke Lidarr plan claim lock with a narrow domain adapter over
`secure-store/acquireExclusiveLock()` while preserving the complete public and on-disk contract.
The implementation first adds strict record-shape and separate staging-UUID seams to the shared lock,
then keeps `plan-engine.ts` under one owner for the domain adapter while independent JSDoc and ADR
drafting proceed in parallel. The existing plan-engine suite remains unmodified; one critical shared
lock test proves the compatibility surface missing from that suite. Live ROADMAP closeout follows
only after the source contract is proven, and the lifecycle ends with final-delta review,
active-head green CI, squash merge, issue closure, and removal of only the dedicated worktree and
branch.

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-chore-304-claim-lock/` (branch: `chore/304-claim-lock-secure-store`)

## Critically Relevant Files and Documentation

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Claim adapter seam and duplicate lock implementation.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: Supported barrel and stale boundary JSDoc.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`: Canonical lock API and stale UUID JSDoc.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`: Shared error codes and path-bearing metadata.
- `packages/rfmedia-cli/src/lib/errors.ts`: Existing Lidarr plan error taxonomy.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`: Shipped adapter precedent.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: Unmodified compatibility contract.
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`: Shared primitive contract.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Exact Bash/Zsh/Fish parity gate.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Bash template that must remain unchanged.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Zsh template that must remain unchanged.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Fish template that must remain unchanged.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Main claim lifecycle and `finally` release.
- `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.ts`: Independent claim lifecycle.
- `docs/plans/issue-304-claim-lock-secure-store/design.md`: Approved migration decisions and abort criteria.
- `docs/plans/issue-288-secure-store-migration/design.md`: Original deferral rationale and #305 boundary.
- `docs/internal/plex-jwt-deferrals.md`: Internal secure-store follow-up inventory.
- `ROADMAP.md`: Live issue inventory and secure-artifact milestone state.
- `.github/pull_request_template.md`: Required PR content and verification structure.

## Implementation Plan

### Phase 0: Establish the Isolated Baseline

#### Task 0.1: Prepare the Existing Worktree and Capture Compatibility Evidence Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-304-claim-lock-secure-store/design.md`
- `docs/plans/issue-304-claim-lock-secure-store/shared.md`
- `docs/plans/issue-288-secure-store-migration/design.md`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `docs/plans/issue-304-claim-lock-secure-store/` (move the entire planning directory as one
  worktree handoff; do not copy or partially select artifacts).

- First move the complete planning directory from the primary checkout into the dedicated worktree,
  then read and operate on the moved files there. Verify the source path is gone and the destination
  contains every research, analysis, design, shared-context, and plan artifact.
- Verify both remotes, fetch/prune, confirm the GitHub PR host, and prove the dedicated worktree is
  clean apart from that attributable planning handoff and based on the current `master`. If any
  other diff appears, attribute and preserve it before proceeding; never overwrite or discard it.
- Enforce Node 22 through `mise exec -- ...` and rebuild `better-sqlite3` only if its ABI is stale.
- Capture merge-base hashes/blobs for `plan-engine.test.ts`, the unrelated
  `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`, the two public claim interface declarations,
  action-layer claim consumers, and the exact `shell-completions/{bash,zsh,fish}.ts` templates.
- Run the two focused lock suites before editing when practical. Treat a baseline failure as an
  attribution problem to diagnose, never as permission to modify the compatibility tests.

### Phase 1: Replace the Duplicate Lock

#### Task 1.0: Add the Missing Shared-Lock Compatibility Seams Depends on [0.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `docs/plans/issue-304-claim-lock-secure-store/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`

- Add optional `strictRecordShape` and `temporaryUUID` lock options with defaults that preserve all
  existing consumers. Strict mode must reject any key outside the exact unbound or expected-bound
  record shape on acquisition, assertion, stale recovery, and release; it must never ignore an
  extra key when deciding ownership or deletion.
- Keep ownership UUID generation and staging-name UUID generation separate when `temporaryUUID` is
  supplied. Default the latter to the existing `randomUUID` source so current tests/consumers do not
  change.
- Add exactly one critical test block proving the distinct UUID sources and that an extra-key
  same-host dead-owner record is rejected during acquisition and left byte-identical, then that an
  extra-key mutation under strict mode makes `assertOwned()` fail closed while `release()` preserves
  the replacement bytes. Do not add broad or duplicate lock tests.
- Update the stale UUID-pattern JSDoc in `lock.ts`; make no unrelated lock behavior or schema change.

#### Task 1.1: Implement the Lidarr Claim Adapter Depends on [1.0]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`
- `packages/rfmedia-cli/src/lib/errors.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

- Import shared lock/error APIs through `../secure-store/index.js` and preserve
  `LidarrPlanClaimDependencies`, `LidarrPlanClaim`, validation order, claim path, record shape, and
  all dependency seams.
- Validate plan ID, claim directory, host/pid, and the injected ownership UUID before shared I/O.
  Sample the `() => Date` seam once, validate that epoch, and expose the cached value to the shared
  lock so `createdAt` and the zero-wait deadline retain legacy single-sample semantics.
- Delegate with a fixed subject, `deadlineEpochMs` equal to the injected acquisition time,
  `maxAgeMs: null`, `strictRecordShape: true`, the local fail-closed liveness probe, the validated
  ownership UUID source, `temporaryUUID: nodeRandomUUID`, and no `binding`.
- Keep acquisition, assertion, and release translation distinct. Busy/corrupt acquisition and
  assertion map to `LidarrPlanAlreadyRunningError`; corrupt release resolves without unlinking;
  unsafe-path/permission failures map to `LIDARR_PLAN_UNSAFE_PATH`, size failures map to
  `LIDARR_PLAN_TOO_LARGE`, and all remaining shared/raw I/O failures map to `LIDARR_PLAN_IO` using
  fixed, path-free messages. Already-built Lidarr errors pass through unchanged.
- Return only `{ path, assertOwned, release }`, then delete only `CLAIM_MAX_BYTES`, `ClaimRecord`,
  claim parsing/reading/ownership/unlink helpers, and the bespoke claim publication loop.
- Retain all artifact/history filesystem code and the independent artifact writer `link()` owned by
  #305. Do not edit tests or action modules.

#### Task 1.2: Correct the Canonical Lock Boundary JSDoc Depends on [0.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `docs/plans/issue-288-secure-store-migration/design.md`
- `docs/plans/issue-304-claim-lock-secure-store/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/secure-store/index.ts`

- State that the Lidarr plan claim delegates to the shared lock while its remaining path walks,
  readers, directory hardeners, and writers stay local for #305.
- Make no runtime, schema, export, or test changes. This task may run in parallel with Task 1.0.

#### Task 1.3: Draft the Internal Deferral Closeout Depends on [0.1]

**READ THESE BEFORE TASK**

- `docs/internal/plex-jwt-deferrals.md`
- `docs/plans/issue-288-secure-store-migration/design.md`
- `docs/plans/issue-304-claim-lock-secure-store/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `docs/internal/plex-jwt-deferrals.md`

- Draft the single-shared-lock architecture and preserve the historical reason #304 was split from
  #288. Keep #305–#308 open and leave the resolved PR number for Task 3.2.
- This documentation-only task may run in parallel with Tasks 1.0 and 1.2. Do not commit, stage, or
  push independently; the integrator owns shared-branch Git operations.

### Phase 2: Prove Compatibility and Scope

#### Task 2.1: Run Focused Contract Gates and Static Audits Depends on [1.0, 1.1, 1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/package.json`
- `package.json`

**Instructions**

Files to Create

- None.

Files to Modify

- None. The sole planned new test belongs to Task 1.0 in
  `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`.

- Run the unmodified plan-engine suite, the secure-store suite containing exactly Task 1.0's new
  critical block, and the unmodified shell-completion parity suite under `umask 022` with
  `FORCE_COLOR` unset, followed by package typecheck and architecture gates. Run generated
  Lidarr/codegen-related checks serially.
- Prove byte identity for the claim test, the unrelated plan snapshot, public claim interfaces,
  action consumers, and all three completion templates.
- Prove the claim-private helpers and publication loop are gone while the unrelated artifact writer
  remains.
- Confirm no shared error class/code/path/remediation or raw path-bearing errno escapes the adapter.
- Stop and re-scope rather than editing the plan-engine compatibility tests, action callbacks, CLI
  surface, or #305-owned persistence code. Do not add a second test for the strict-record gap.

### Phase 3: Publish the Verified Change and Close Internal Debt

#### Task 3.1: Commit, Push, and Open the Template-Compliant PR Depends on [1.3, 2.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `lefthook.yml`
- `docs/plans/issue-304-claim-lock-secure-store/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

- Commit the verified source/design/plan revert unit intentionally, push to the configured GitHub
  upstream without bypassing the real pre-push hook, and open the PR with every required template
  section and `Closes #304`.
- Record exact pass/fail commands, the unmodified-test contract, no CLI/completion surface change,
  and the public-docs rationale. Open as draft if internal closeout edits are still pending.
- Use the authoritative PR number in Task 3.2; never guess or hardcode it before creation.

#### Task 3.2: Finalize the Secure-Store Deferral ADR Depends on [1.3, 3.1]

**READ THESE BEFORE TASK**

- `docs/internal/plex-jwt-deferrals.md`
- `docs/plans/issue-288-secure-store-migration/design.md`
- `docs/plans/issue-304-claim-lock-secure-store/design.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `docs/internal/plex-jwt-deferrals.md`

- Finalize the drafted single-lock architecture and mark #304 resolved by the actual PR, preserving
  the historical reason it was split from #288.
- Keep #305 explicitly open for the remaining path walks/readers/directory hardeners/writers and do
  not claim #306–#308 are complete.
- Format and lint the changed Markdown, commit, push, and update the PR body/tests as needed.

### Phase 4: Review, Fix, and Reconcile Live State

#### Task 4.1: Perform Adversarial PR Review and Apply Actionable Fixes Depends on [3.2]

**READ THESE BEFORE TASK**

- `docs/plans/issue-304-claim-lock-secure-store/design.md`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts`
- `.github/pull_request_template.md`

**Instructions**

Files to Create

- `docs/prps/reviews/issue-304-claim-lock-secure-store-review.md`

Files to Modify

- Only files directly implicated by validated findings, grouped into 1–3-file fix units.

- Review the full PR for correctness, security, error compatibility, legacy filesystem behavior,
  scope, tests, docs, and completion parity. Validate findings against current code before fixing.
- Send any `plan-engine.ts` fix back through its single-owner lane and rerun both focused lock suites
  plus typecheck; keep JSDoc-only fixes independent.
- Inspect all human/bot review comments and threads, resolve every actionable item, push through the
  real hook, and run focused local validation on the new head. The authoritative registered-CI wait
  belongs to Task 5.2 after the late ROADMAP commit.

#### Task 4.2: Reconcile ROADMAP Against Live GitHub Issues Depends on [4.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/roadmap-archive.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`

- Query the authoritative open-issue inventory immediately before closeout and compute the projected
  post-merge inventory as `live open issues - #304`, recomputing every affected total/category count.
- Remove #304 from Sprint 2 and the rfmedia medium backlog, renumber #305–#308, and update Current
  Focus plus Secure artifact I/O to distinguish shipped #288/#304 from open #305–#308.
- Preserve the Sprint 2 narrative and leave `docs/roadmap-archive.md` unchanged until the whole
  sprint closes. Format/lint, commit, run the real pre-push hook, and push this projected closeout.

### Phase 5: Complete the PR Lifecycle

#### Task 5.1: Run Final Repository Gates Depends on [4.2]

**READ THESE BEFORE TASK**

- `package.json`
- `scripts/test-run.sh`
- `lefthook.yml`

**Instructions**

Files to Create

- None.

Files to Modify

- None. This task is read-only; return any formatting failure to the file's owning task.

- Run the root test suite, Markdown lint, format check, whitespace check, and the real pre-push hook
  under Node 22. Rerun every focused suite invalidated by review or closeout edits.
- Review the final ROADMAP/ADR delta and re-check any approval dismissed by the late push. Verify a
  clean intended diff, completion/interface/action no-change evidence, current PR head SHA, PR body,
  and resolved review threads before accepting CI.
- If any gate requires a file edit, route it to the owning implementation/documentation lane,
  commit, run the real hook, push, and restart final-delta review plus Tasks 5.1–5.2.

#### Task 5.2: Monitor CI, Squash Merge, Close, and Clean Up Depends on [5.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-304-claim-lock-secure-store/parallel-plan.md`
- `.github/pull_request_template.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

- Monitor registered GitHub CI for the active head until every required check is green; diagnose and
  fix real failures through the owning implementation lane (Task 1.1 owns every later
  `plan-engine.ts` fix), then require fresh final-delta review and green evidence on each new head.
- Verify every review thread resolved, ROADMAP still matches live issues, and the PR is mergeable.
- Squash merge, then verify the authoritative merge commit, issue #304 closure, and remote feature
  branch absence; explicitly delete the remote feature branch if automation did not.
- Remove only the dedicated issue-304 worktree and local branch after merge proof. Fetch/prune and
  confirm default-branch alignment while preserving the primary checkout and unrelated worktrees.
- Treat drift as a retry edge: a ROADMAP mismatch returns to Task 4.2, and a CI/review fix returns to
  its owning implementation lane; both then repeat Tasks 5.1 and 5.2 on the new head.
- Only authoritative merge and #304 closure proof unlocks #305 implementation. Read-only #305
  research may proceed earlier, but no #305 worktree may edit `plan-engine.ts` before this task ends.

## Advice

- `deadlineEpochMs: now()` and `maxAgeMs: null` are safety policies, not performance tuning; keep
  their rationale beside the call.
- Do not pass a binding: the validated plan ID already namespaces the filename, and binding would
  strand a recoverable claim written by an older build.
- Keep three translation contexts. Treating release like acquisition can mask the real apply
  failure; treating corrupt acquisition as repairable can destroy forensic bytes.
- Cache the injected clock sample and keep ownership versus staging UUID sources distinct; these
  preserve legacy seam semantics while the shared primitive performs the filesystem work.
- Strict record shape is mandatory. Ignoring an extra key could let a foreign/mutated claim be
  stolen, asserted, or deleted.
- A blanket `link()` zero-hit check is wrong until #305. Audit only the removed claim block and keep
  artifact publication intact.
- Add exactly the one Task 1.0 secure-store contract test; add no filler or duplicate coverage.
- Keep ROADMAP last and live. Counts copied from this plan are evidence-free by merge time.
- Issue #305 must start only after #304 is merged; it shares `plan-engine.ts` and depends on this
  adapter/error boundary.
