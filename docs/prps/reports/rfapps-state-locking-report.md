# Implementation Report: rfapps State Locking

## Summary

Implemented a private cross-process state lock in rfapps' selected state directory for mutating
rfapps CLI and MCP operations. New and XDG-based installations use `~/.config/rfapps/lock`;
installations with an existing legacy state directory use `~/.rfapps/lock` only when the XDG state
directory does not exist. The lock uses atomic directory creation and one private owner-token file,
records operator-readable ownership metadata, fails closed for malformed or stale state, releases
through `finally`, and can be removed only through an explicitly warned, confirmation-gated
`rfapps force-unlock` recovery command.

## Assessment vs Reality

| Metric        | Predicted (Plan) | Actual                              |
| ------------- | ---------------- | ----------------------------------- |
| Complexity    | Medium           | Medium                              |
| Files Changed | 13               | 21 including plan and report        |
| Lock layers   | 2                | Global state + existing lifecycle   |
| Dependencies  | 0 new            | Native Node.js filesystem APIs only |

## Tasks Completed

| #   | Task                                  | Status | Notes                                                    |
| --- | ------------------------------------- | ------ | -------------------------------------------------------- |
| 1   | Atomic state-lock primitive           | Done   | Private path, bounded metadata, stale detection          |
| 2   | Operator recovery command             | Done   | Warns, confirms, and checks lock identity before removal |
| 3   | CLI and MCP mutation-boundary locking | Done   | Dry-run and report-only paths remain lock-free           |
| 4   | Shell completions and operator docs   | Done   | Bash, Zsh, Fish, README, and help text updated           |
| 5   | Roadmap and implementation artifacts  | Done   | Issue counts, shipped archive, plan, and report updated  |

## Design Outcomes

- CLI mutations acquire one global lock in the root pre-action hook and release it from the
  top-level `finally`, including action failures.
- MCP mutation handlers share the same lock path and release contract without changing tool
  schemas or result payloads.
- The default lock path follows the database's XDG/legacy state-directory selection, so lock
  acquisition cannot create the legacy directory and redirect a fresh installation's database.
- Pull, build, deploy, stop, rebuild, delete, prune, apply, rollback, drift import, and explicit
  apply modes are locked. Read-only commands, report-only reconciliation, and global `--dry-run`
  are not.
- Managed update and reconciliation retain the existing project-and-Docker-context lifecycle lock
  as a second, finer-grained safety layer.
- Locks older than ten minutes are reported as stale but never removed automatically.
- Release and force-unlock verify the inspected directory and owner-token identities, unlink only
  that exact token, and remove the directory non-recursively. Acquisition re-verifies its token
  before returning, so recovery cannot leave an untracked active writer.

## Validation Results

| Check          | Result | Evidence                                                          |
| -------------- | ------ | ----------------------------------------------------------------- |
| Focused tests  | Pass   | 5 files, 88 tests                                                 |
| Common tests   | Pass   | `npm run test:run -w packages/rf-common`: 402 passed              |
| Full tests     | Pass   | `npm run test:run -w packages/rfapps-cli`: 1336 passed, 2 skipped |
| Type check     | Pass   | `npm run typecheck -w packages/rfapps-cli`                        |
| Build          | Pass   | `npm run build:rfapps`                                            |
| Markdown       | Pass   | `markdownlint-cli2`: 329 files, 0 errors                          |
| Formatting     | Pass   | Prettier applied to all changed source and documentation files    |
| CLI smoke      | Pass   | `npm run rfapps -- force-unlock --help`                           |
| Plan structure | Pass   | PRP validator: 5 tasks, 0 errors, 0 warnings                      |
| Code graph     | Pass   | `graphify update .`: 7829 nodes, 23449 edges                      |

## Tests Written

| Test file                                                | Coverage                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/state-lock.spec.ts`         | Metadata, permissions, stale boundary, cleanup, races, symlinks |
| `packages/rfapps-cli/src/actions/force-unlock.spec.ts`   | Missing, active, stale/invalid, confirmation, machine output    |
| `packages/rfapps-cli/src/cli.deploy.integration.spec.ts` | Contention, dry-run, and fresh-install XDG path behavior        |
| `packages/rfapps-cli/src/mcp/tools.spec.ts`              | Mutation locking and lock-free report/dry-run paths             |
| `packages/rfapps-cli/src/actions/completion.spec.ts`     | Bash, Zsh, and Fish command parity                              |

## Deviations from Plan

- The implementation added two explicit error codes, `LOCK_CHANGED` and `LOCK_IO_ERROR`, to keep
  replacement races and filesystem failures distinguishable from contention.
- The planned single-file lock was strengthened to a token-directory protocol after review exposed
  an unavoidable canonical-path gap in quarantine-based file replacement.
- The full package suite now contains 1338 tests; two host-dependent Compose integration tests
  remain intentionally skipped.
- No child issue was opened because the primitive, entry-point adoption, recovery command,
  completions, and documentation form one inseparable operator contract.

## Issues Encountered

- One MCP assertion was initially placed in the read-tool test. Moving it to the mutation-tool test
  restored the intended lock-count assertion; all focused and full suites then passed.
- Two review rounds found cleanup races in the initial single-file design. The final token-directory
  protocol keeps the canonical lock continuously exclusive while verified token removal and
  non-recursive directory removal prevent deletion of a successor.
- A late PR review found that creating `~/.rfapps/lock` before database initialization changed a
  fresh install's state path. The lock now reuses the database path selector, and the integration
  harness no longer masks the fresh-home case by pre-creating the XDG directory.
- The plan validator resolves relative paths against the primary checkout. Passing the feature
  worktree plan as an absolute path validated it successfully.

## Next Steps

- [x] Complete formal code review and resolve all findings.
- [ ] Open the issue-closing pull request and wait for required checks.
- [ ] Squash merge and clean up the feature branch and worktree.
