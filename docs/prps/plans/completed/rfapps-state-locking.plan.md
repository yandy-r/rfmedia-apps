# Plan: rfapps State Locking

## Summary

Add a coarse, cross-process state lock for every mutating rfapps CLI and MCP operation, backed by
an atomic private lock directory with an operator-owned metadata token. Preserve the existing
project/Docker-context lifecycle lock used by managed update and reconciliation as a second,
fine-grained safety boundary, and add an explicit warned `rfapps force-unlock` recovery command.

## User Story

As an rfapps operator, I want concurrent state-changing operations to be rejected with actionable
lock-owner information, so that Docker and deployment state cannot be corrupted by overlapping
commands.

## Problem → Solution

Only managed update and auto-reconciliation currently share a project/context lifecycle lock; other
CLI and MCP mutations can overlap → acquire one operator-visible lock in the selected rfapps state
directory at every mutation entry point, release it in `finally`, classify locks older than ten
minutes as stale without auto-deleting them, and require explicit `force-unlock` authorization for
removal.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A — GitHub issue #65
- **PRD Phase**: N/A
- **Estimated Files**: 13

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-rfapps-state-locking/ (branch: feat/rfapps-state-locking)

---

## UX Design

### Before

```text
CLI mutation ───────────────┐
MCP mutation ───────────────┼──> action ──> Docker/state
update/reconcile --apply ───┴──> project/context lifecycle lock ──> Docker/state
```

Most mutation paths have no cross-process exclusion, and there is no supported recovery command
for an abandoned top-level operation lock.

### After

```text
CLI mutation ──┐
MCP mutation ──┴──> <state-dir>/lock/<lockId> ──> action ──> Docker/state
Managed update/reconcile additionally retain the project/context lifecycle lock.

force-unlock ──> inspect ──> warn + confirm/--yes ──> verify token + unlink + rmdir
```

### Interaction Changes

| Touchpoint           | Before                                      | After                                                                   | Notes                                      |
| -------------------- | ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| Mutating CLI command | Starts even when another mutation is active | Fails before action execution with operation, owner, and timestamp      | Global `--dry-run` stays lock-free         |
| Mutating MCP tool    | Can overlap an external CLI mutation        | Shares the same filesystem lock                                         | Report-only reconciliation stays lock-free |
| Stale lock           | Manual filesystem deletion only             | Distinct stale error after ten minutes with recovery guidance           | Never auto-delete                          |
| Recovery             | No supported command                        | `rfapps force-unlock` warns and requires confirmation or global `--yes` | Dangerous by design                        |

## Design Decisions

- Use an atomic private `<state-dir>/lock` directory with exactly one `O_EXCL | O_NOFOLLOW`
  owner-token file named by `lockId`, rather than adding a dependency. Select the state directory
  with the database's existing XDG/legacy policy so lock acquisition does not create a legacy
  sentinel on fresh installations. Directory creation serializes acquisition, while token-scoped
  unlink plus non-recursive `rmdir` prevents one owner from deleting a successor.
- Keep the coarse state lock separate from the existing hashed project/context locks. The coarse
  lock protects all mutation surfaces before they have resolved project identity, while the
  current lifecycle lock continues to protect revalidation-sensitive update/reconcile
  coordinators.
- Acquire at the CLI/MCP entry boundaries rather than duplicating wrappers in every action. This
  covers the supported execution surfaces and preserves framework-agnostic action tests.
- Treat age greater than ten minutes as stale and fail closed. Automatic takeover is out of scope
  because valid multi-service operations may exceed ten minutes.
- Make release and force-unlock replacement-safe by verifying the directory and exact owner-token
  identities, deleting only the inspected token, and removing the directory non-recursively.
  Acquisition re-verifies its published token before returning, so concurrent recovery cannot
  produce an untracked active writer.
- Do not split issue #65 into child issues: the lock primitive, mutation-boundary adoption,
  recovery command, completions, and docs form one atomic operator contract.

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                                 | Lines   | Why                                                                                                      |
| -------------- | ---------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| P0 (critical)  | `packages/rfapps-cli/src/lib/lifecycle-lock.ts`      | 1-507   | Atomic acquisition, private paths, bounded metadata, stale signaling, and ownership-safe release pattern |
| P0 (critical)  | `packages/rfapps-cli/src/cli.ts`                     | 75-564  | Global pre-action validation, command registration, and top-level error lifetime                         |
| P0 (critical)  | `packages/rfapps-cli/src/mcp/tools-mutate.ts`        | 1-110   | Complete MCP mutation entry-point registry                                                               |
| P1 (important) | `packages/rfapps-cli/src/testing/cli-harness.ts`     | 80-235  | Fake-HOME subprocess isolation for critical CLI tests                                                    |
| P1 (important) | `packages/rfapps-cli/src/actions/completion.ts`      | 24-1106 | Static Bash, Zsh, and Fish command templates                                                             |
| P1 (important) | `packages/rfapps-cli/src/actions/completion.spec.ts` | 520-690 | Existing cross-shell completion assertions                                                               |
| P1 (important) | `packages/rfapps-cli/src/commands/reconcile.ts`      | 1-105   | Lazy command-to-action registration and global option pattern                                            |
| P2 (reference) | `packages/rfapps-cli/README.md`                      | all     | Operator command and safety documentation                                                                |
| P2 (reference) | `ROADMAP.md`                                         | 1-150   | Living issue counts, sprint order, and backlog entry                                                     |
| P2 (reference) | `docs/roadmap-archive.md`                            | 1-70    | Shipped-work archive format                                                                              |

## External Documentation

No external research is required. The feature uses Node.js filesystem primitives already proven by
`lifecycle-lock.ts`; no new library or protocol is introduced.

---

## Patterns to Mirror

Code patterns discovered in the current codebase. Follow these exactly.

### NAMING_CONVENTION

```typescript
// SOURCE: packages/rfapps-cli/src/lib/lifecycle-lock.ts:16-21
export type LifecycleLockErrorCode = "LOCK_HELD" | "LOCK_STALE" | "LOCK_METADATA_INVALID" | "LOCK_PATH_UNSAFE";
```

Use a typed error-code union and readonly metadata contracts for the new coarse state lock.

### ERROR_HANDLING

```typescript
// SOURCE: packages/rfapps-cli/src/lib/lifecycle-lock.ts:437-445
if (hasCode(error, "EEXIST")) {
  throw await contentionError(lockPath, projectPath, options.dockerContext, isProcessAlive);
}
if (hasCode(error, "ELOOP")) {
  throw unsafePath("Lifecycle lock path resolves through a symbolic link", lockPath, error);
}
```

Translate filesystem error codes into stable typed errors and fail closed on unsafe or malformed
lock state.

### LOGGING_PATTERN

```typescript
// SOURCE: packages/rfapps-cli/src/actions/drift.ts:753-758
if (!options.yes && !isMachineFormat(format)) {
  const confirmed = await confirm(
    `Import drift into compose.yml for ${driftedServices.map((s) => s.service).join(", ")}?`,
  );
```

Warn before destructive recovery and use the existing confirmation/global `--yes` convention.

### COMMAND_ACTION_PATTERN

```typescript
// SOURCE: packages/rfapps-cli/src/commands/reconcile.ts:90-94
.action(async (options: RawReconcileOptions) => {
  validateReconcileOptions(options);
  const { executeReconcile } = await dependencies.loadAction();
  await executeReconcile(options, program.opts());
});
```

Register `force-unlock` as a lazy command/action boundary; keep filesystem logic in `lib/`.

### ATOMIC_LOCK_PATTERN

```typescript
// SOURCE: packages/rfapps-cli/src/lib/lifecycle-lock.ts:448-452
handle = await open(
  lockPath,
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
  PRIVATE_FILE_MODE,
);
```

Use exclusive creation and no-follow semantics; do not implement check-then-create.

### CLEANUP_PATTERN

```typescript
// SOURCE: packages/rfapps-cli/src/lib/lifecycle-lock.ts:497-506
const lock = await acquireLifecycleLock(options);
try {
  return await operation(lock);
} finally {
  await lock.release();
}
```

Every acquired state lock must release through `finally`, including action errors.

### MCP_ENTRY_PATTERN

```typescript
// SOURCE: packages/rfapps-cli/src/mcp/tools-mutate.ts:18-25
{
  name: RFAPPS_MCP_TOOL_NAMES.pull,
  description: "Pull Docker images for targeted services.",
  inputSchema: rfappsMcpSchemas.pull.input,
  outputSchema: rfappsMcpSchemas.pull.output,
}
```

Wrap each mutation handler without changing its schema, adapter contract, or returned result.

### TEST_STRUCTURE

```typescript
// SOURCE: packages/rfapps-cli/src/lib/lifecycle-lock.spec.ts:21-29
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "rfapps-lifecycle-lock-"));
  projectA = join(tempDir, "project-a");
  stateDir = join(tempDir, "state");
});
```

Use temporary lock paths and deterministic clock/identity seams; never touch the developer's real
home directory from unit tests.

---

## Files to Change

| File                                                   | Action | Justification                                                                                                                  |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/rfapps-cli/src/lib/state-lock.ts`            | CREATE | Atomic coarse lock, metadata parsing, stale classification, replacement-safe release, and force-unlock primitive               |
| `packages/rfapps-cli/src/lib/state-lock.spec.ts`       | CREATE | Critical contention, staleness, cleanup, malformed-state, and replacement-race tests                                           |
| `packages/rfapps-cli/src/actions/force-unlock.ts`      | CREATE | Warning, confirmation/`--yes`, no-lock behavior, and operator output                                                           |
| `packages/rfapps-cli/src/actions/force-unlock.spec.ts` | CREATE | Critical authorization and race-safe delegation tests                                                                          |
| `packages/rfapps-cli/src/commands/force-unlock.ts`     | CREATE | Lazy Commander registration for the dangerous recovery surface                                                                 |
| `packages/rfapps-cli/src/cli.ts`                       | UPDATE | Classify mutating commands, acquire before action execution, release from the top-level `finally`, and register `force-unlock` |
| `packages/rf-common/src/errors.ts`                     | UPDATE | Add a typed prompt interruption with shell-standard exit code 130                                                              |
| `packages/rf-common/src/errors.test.ts`                | UPDATE | Prove prompt interruptions preserve exit code 130                                                                              |
| `packages/rf-common/src/index.ts`                      | UPDATE | Export the prompt interruption contract                                                                                        |
| `packages/rf-common/src/prompt.ts`                     | UPDATE | Unwind Ctrl+C through caller cleanup instead of exiting immediately                                                            |
| `packages/rfapps-cli/src/mcp/tools-mutate.ts`          | UPDATE | Apply the same cross-process lock to MCP mutations while skipping dry-run/report-only paths                                    |
| `packages/rfapps-cli/src/mcp/tools-read.ts`            | UPDATE | Conditionally lock the existing `plan --apply` MCP surface                                                                     |
| `packages/rfapps-cli/src/mcp/tools.spec.ts`            | UPDATE | Prove MCP mutation handlers use the lock without changing schemas/results                                                      |
| `packages/rfapps-cli/src/actions/completion.ts`        | UPDATE | Add `force-unlock` to Bash, Zsh, and Fish templates                                                                            |
| `packages/rfapps-cli/src/actions/completion.spec.ts`   | UPDATE | One parameterized parity test across all completion templates                                                                  |
| `packages/rfapps-cli/README.md`                        | UPDATE | Document contention, metadata, staleness, force-unlock warnings, and covered operations                                        |
| `ROADMAP.md`                                           | UPDATE | Mark #65 shipped, advance Sprint 3, remove the open backlog row, and update issue counts                                       |
| `docs/roadmap-archive.md`                              | UPDATE | Archive #65 under rfapps lifecycle/state hardening                                                                             |

## NOT Building

- Distributed/network locking or a remote lock service.
- Automatic stale-lock takeover or deletion.
- Per-service locks, lock queues, waiting/retry flags, or concurrent disjoint-operation scheduling.
- Replacement of the existing project/Docker-context lifecycle lock.
- Locking read-only commands, previews, dry runs, completion generation, or config validation.
- A public MCP `force-unlock` tool; recovery remains an explicit local operator command.
- New third-party lockfile dependencies.

---

## Step-by-Step Tasks

### Task 1: Implement the coarse state-lock primitive

- **ACTION**: Create `state-lock.ts` and its focused unit test.
- **IMPLEMENT**: Store `{ operation, who, when, lockId }` in
  `<state-dir>/lock` by default, with injectable path/clock/identity/UUID seams. Reuse the database
  state-directory selector, acquire atomically with private permissions, bound and validate
  metadata, distinguish active, stale (>10 minutes), invalid, unsafe-path, and I/O errors, and
  expose inspection, `withStateLock`, release, and replacement-safe force-unlock operations.
- **MIRROR**: `lifecycle-lock.ts` atomic creation, typed errors, bounded metadata, no-follow path
  handling, idempotent release, and inode/identity ownership checks.
- **IMPORTS**: `randomUUID` from `node:crypto`; filesystem constants and promise APIs from
  `node:fs` / `node:fs/promises`; `hostname` and `userInfo` from `node:os`; path helpers from
  `node:path`; `getDefaultDatabasePath` from `db.ts`.
- **GOTCHA**: Never check existence before exclusive create, never auto-unlink stale/invalid locks,
  never let release or force-unlock remove a replacement file, and never use the real home path in
  tests.
- **VALIDATE**: `npm test -w packages/rfapps-cli -- --run src/lib/state-lock.spec.ts` and
  `npm run typecheck -w packages/rfapps-cli`.

### Task 2: Add the warned force-unlock command

- **ACTION**: Add the action and command modules, then register `rfapps force-unlock`.
- **IMPLEMENT**: Inspect the current lock, report no-lock as a successful no-op, show a prominent
  warning with valid metadata (or a bounded invalid-metadata warning), require confirmation unless
  global `--yes` is set, and pass the inspected identity into replacement-safe removal. Keep lazy
  command/action loading and return cleanly on cancellation. Honor global `--dry-run` by reporting
  without prompting or removing the lock.
- **MIRROR**: `commands/reconcile.ts` for lazy registration and `actions/drift.ts` for
  confirmation/`--yes` behavior.
- **IMPORTS**: Common logging and `confirm`; state-lock inspection and force-unlock APIs.
- **GOTCHA**: The recovery command itself must bypass acquisition, machine/non-interactive use must
  require explicit `--yes`, and invalid metadata must not be echoed unbounded.
- **VALIDATE**: `npm test -w packages/rfapps-cli -- --run src/actions/force-unlock.spec.ts` and
  `npm run typecheck -w packages/rfapps-cli`.

### Task 3: Enforce locking at CLI and MCP mutation boundaries

- **ACTION**: Add shared mutation classification to `cli.ts` and wrap MCP mutation handlers.
- **IMPLEMENT**: In the CLI pre-action lifetime, acquire for `pull`, `build`, `deploy`, `stop`,
  `rebuild`, `delete`, `prune`, `apply`, and `rollback`; acquire conditionally for `plan --apply`,
  `update --apply`, and `reconcile --auto-apply`; acquire for `drift reconcile` and `drift import`.
  Skip every global dry-run and `force-unlock`. Release from a top-level `finally` without
  immediate `process.exit` bypasses. Apply equivalent conditional locking to MCP mutation handlers,
  preserving schemas and results, including the existing `plan --apply` MCP surface. Make prompt
  Ctrl+C unwind as a typed exit-130 error so the same `finally` runs.
- **MIRROR**: `cli.ts` pre-action hook and `tools-mutate.ts` handler registry; keep the current
  lifecycle-lock calls inside managed update/reconcile unchanged.
- **IMPORTS**: State-lock acquire/release/wrapper types and functions.
- **GOTCHA**: Commander nested drift commands expose parent/child names; report-only reconcile and
  all dry-run paths remain lock-free. Avoid double-acquiring the coarse lock when one action calls
  another. MCP schema parsing must happen before deciding whether reconciliation mutates.
- **VALIDATE**: Add one fake-HOME CLI integration case proving a held lock prevents deploy before
  Docker invocation, and extend MCP tool tests to prove locked delegation plus dry-run/report-only
  bypass. Run those focused files and package typecheck.

### Task 4: Update completions and operator documentation

- **ACTION**: Add the new command to all three completion templates and document the lock contract.
- **IMPLEMENT**: Add `force-unlock` to Bash command discovery/dispatch, the Zsh command array and
  finder/case, and Fish command definitions. Document covered mutation surfaces, metadata fields,
  ten-minute stale classification, fail-closed behavior, normal automatic release, and dangerous
  manual recovery in the rfapps README.
- **MIRROR**: Existing `completion`/`mcp` no-option command template entries and README safety
  sections for managed update/reconciliation.
- **IMPORTS**: None.
- **GOTCHA**: Shell template parity is mandatory; do not add unrelated options or expose
  `force-unlock` through MCP.
- **VALIDATE**: One parameterized completion test must assert `force-unlock` for Bash, Zsh, and Fish;
  run `npm test -w packages/rfapps-cli -- --run src/actions/completion.spec.ts` and markdown lint on
  the changed docs.

### Task 5: Update roadmap status and implementation artifacts

- **ACTION**: Mark issue #65 shipped in the living roadmap and archive it.
- **IMPLEMENT**: Remove #65 from open sprint/backlog rows, advance Sprint 3 sequencing, decrement
  total/rfapps/medium counts once, and add the shipped issue (plus closing PR number once known) to
  `docs/roadmap-archive.md`. Complete the PRP implementation report and archive this plan under
  `docs/prps/plans/completed/`.
- **MIRROR**: Existing shipped rows in `ROADMAP.md` and the `rfapps lifecycle` row/operator-note
  style in `docs/roadmap-archive.md`.
- **IMPORTS**: None.
- **GOTCHA**: Counts must match live issue closure exactly; do not invent a PR number before GitHub
  assigns it.
- **VALIDATE**: `npm run lint:md -- ROADMAP.md docs/roadmap-archive.md docs/prps` plus direct search
  proving #65 remains only in shipped/archive context.

---

## Testing Strategy

Only critical contract tests are added. Existing action suites continue to prove action behavior and
must not be duplicated per command.

### Unit Tests

| Test                       | Input                                               | Expected Output                                           | Edge Case? |
| -------------------------- | --------------------------------------------------- | --------------------------------------------------------- | ---------- |
| Atomic acquire + metadata  | Deterministic operation/who/time/UUID and temp path | Private lock containing the exact four metadata fields    | No         |
| Contention classification  | Second acquire against active lock                  | Typed held error with bounded owner details               | Yes        |
| Stale classification       | Existing lock older than ten minutes                | Typed stale error; file remains present                   | Yes        |
| Finally cleanup            | Wrapped operation throws                            | Original failure propagates and lock is removed           | Yes        |
| Replacement safety         | Lock path replaced before release/unlock            | Replacement remains and unsafe/replaced error is reported | Yes        |
| Invalid metadata           | Malformed/oversized lock                            | Fail closed; explicit force-unlock remains possible       | Yes        |
| Force-unlock authorization | Present lock with confirm false / `--yes` true      | Cancel leaves lock; explicit authorization removes it     | Yes        |
| Mutation boundary          | Pre-held fake-HOME lock + CLI deploy                | Nonzero exit before any Docker invocation                 | Yes        |
| MCP boundary               | Mutation, dry-run, report-only reconciliation       | Mutations wrap once; non-mutations bypass                 | Yes        |
| Completion parity          | Bash/Zsh/Fish generation                            | Every template contains `force-unlock`                    | No         |

### Edge Cases Checklist

- [ ] Exactly ten minutes old is not stale; greater than ten minutes is stale.
- [ ] Future timestamps and malformed metadata fail closed.
- [ ] `--dry-run` and report-only reconciliation never acquire.
- [ ] Action failure still releases.
- [ ] Release and force-unlock cannot delete a replacement lock.
- [ ] No-lock force-unlock is idempotent and successful.
- [ ] Cancellation leaves the inspected lock untouched.
- [ ] Existing update/reconcile lifecycle-lock tests still pass.

---

## Validation Commands

### Static Analysis

```bash
npm run typecheck -w packages/rfapps-cli
npx prettier --check \
  packages/rfapps-cli/src/lib/state-lock.ts \
  packages/rfapps-cli/src/lib/state-lock.spec.ts \
  packages/rfapps-cli/src/actions/force-unlock.ts \
  packages/rfapps-cli/src/actions/force-unlock.spec.ts \
  packages/rfapps-cli/src/commands/force-unlock.ts \
  packages/rfapps-cli/src/cli.ts \
  packages/rfapps-cli/src/mcp/tools-mutate.ts \
  packages/rfapps-cli/src/mcp/tools.spec.ts \
  packages/rfapps-cli/src/actions/completion.ts \
  packages/rfapps-cli/src/actions/completion.spec.ts
npm run lint:md -- packages/rfapps-cli/README.md ROADMAP.md docs/roadmap-archive.md docs/prps
git diff --check
```

EXPECT: Zero type, formatting, markdown, or whitespace errors.

### Unit Tests

```bash
npm test -w packages/rfapps-cli -- --run \
  src/lib/state-lock.spec.ts \
  src/actions/force-unlock.spec.ts \
  src/actions/completion.spec.ts \
  src/mcp/tools.spec.ts
```

EXPECT: All focused contract tests pass.

### Integration Tests

```bash
npm test -w packages/rfapps-cli -- --run src/cli.deploy.integration.spec.ts
```

EXPECT: A pre-held lock blocks before Docker, dry-run remains lock-free, and the existing deploy
integration suite remains green.

### Full Test Suite

```bash
npm run test:run -w packages/rfapps-cli
```

EXPECT: No rfapps regressions.

### Build Check

```bash
npm run build:rfapps
```

EXPECT: rf-common and rfapps build successfully.

### Graph Update

```bash
graphify update .
```

EXPECT: The repository graph includes the new lock and command surfaces without health warnings.

### Manual Validation

- [ ] `npm run rfapps -- force-unlock --help` shows the dangerous recovery command.
- [ ] A held temp/fake-HOME lock reports operation, owner, and time without running Docker.
- [ ] `force-unlock` cancellation preserves the lock.
- [ ] `force-unlock --yes` removes the inspected lock and reports success.

---

## Acceptance Criteria

- [ ] Every supported mutating CLI and MCP entry point shares one atomic coarse lock.
- [ ] Read-only, preview, report-only, and dry-run execution stays lock-free.
- [ ] The default lock is `<selected-state-dir>/lock` with `{ operation, who, when, lockId }`
      metadata, without changing fresh-install database path selection.
- [ ] Lock contention fails before mutation with actionable, bounded holder information.
- [ ] Locks older than ten minutes are identified as stale and never auto-removed.
- [ ] Locks release after success and failure without deleting replacement locks.
- [ ] `rfapps force-unlock` warns, confirms unless `--yes`, handles missing/invalid locks, and
      removes only the inspected lock identity.
- [ ] Managed update and reconciliation retain their existing project/context lifecycle lock.
- [ ] Bash, Zsh, and Fish completions include `force-unlock`.
- [ ] README and roadmap/archive documentation are current.
- [ ] Only the critical tests listed above are added; action behavior is not redundantly retested.
- [ ] Issue #65 is closed by the PR and no child issue is required.

## Completion Checklist

- [ ] Code follows discovered atomic-lock and command/action patterns.
- [ ] Errors and warnings are bounded and follow existing output conventions.
- [ ] Tests use deterministic seams and fake/temp homes.
- [ ] No hardcoded developer paths or lock IDs.
- [ ] No dependency added.
- [ ] No unrelated action or completion changes.
- [ ] Focused tests, full rfapps tests, typecheck, build, markdown lint, Prettier, and diff check pass.
- [ ] Formal code review has no unresolved findings.
- [ ] GitHub CI is green before squash merge.
- [ ] Roadmap counts match the closed issue state.
- [ ] Feature branch and worktree are removed after merge.

## Risks

| Risk                                                               | Likelihood          | Impact | Mitigation                                                                                                                               |
| ------------------------------------------------------------------ | ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Coarse global lock reduces concurrency across independent projects | Medium              | Low    | Intentional first-version safety tradeoff from issue #65; document it and leave per-service/distributed locking out of scope             |
| Valid operation exceeds ten minutes and appears stale              | Medium              | High   | Stale is diagnostic only; never auto-delete and make force-unlock warnings explicit                                                      |
| CLI error path bypasses cleanup                                    | Low                 | High   | Replace immediate exits in the locked lifetime with exit-code assignment and release in top-level `finally`; integration-test contention |
| MCP mutation bypasses CLI hook                                     | High without change | High   | Wrap every mutation handler with the same filesystem lock                                                                                |
| Force-unlock races a new owner                                     | Low                 | High   | Remove only the verified owner token, use non-recursive `rmdir`, and require acquisition to re-verify its token before returning         |
| Existing managed update/reconcile lock behavior regresses          | Low                 | High   | Do not replace or refactor the lifecycle lock; run its existing tests in the full package suite                                          |

## Notes

- GitHub issue #65 has no child issues or comments as of 2026-07-24.
- The issue's original `src/lib/lock.ts` estimate predates the lifecycle lock added by PR #239.
  This plan integrates with current architecture rather than copying the older proposal literally.
- Graph traversal identified `cli.ts`, `actions/deploy.ts`, `actions/apply.ts`,
  `actions/reconcile.ts`, `actions/update.ts`, and `lifecycle-lock.ts` as the relevant operation
  boundary; direct inspection confirmed the complete CLI/MCP/completion surfaces.
- The requested sequential PRP researcher did not return a usable report through the available
  collaborator runtime after one narrowed retry. No findings were invented; all Patterns to Mirror
  entries above cite directly inspected repository sources.
- No external research is needed and no child issue split is warranted.
