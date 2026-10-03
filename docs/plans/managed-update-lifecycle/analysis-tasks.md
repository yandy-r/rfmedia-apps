# Task Structure Analysis: managed-update-lifecycle

## Executive Summary

Implement issue #148 as five child-issue-sized workstreams: contracts and persistence, safe
detection, exact Docker recovery primitives, lifecycle orchestration, and public CLI validation.
Each task below owns one to three files, including its focused test where practical. Shared barrels
and CLI registration are deferred to integration tasks so parallel owners do not collide.

The critical path is `T01 -> T11 -> T13 -> T14 -> T15 -> T16 -> T18 -> T19 -> T24`. State work
(`T02`-`T05`), secure storage (`T07`), errors/locking (`T06`, `T10`), and compatibility rejection
(`T08`) can proceed in parallel, then join at the coordinator. Runtime updates remain sequential even
though implementation tasks are parallelizable.

## Recommended Phase Structure

| Phase | Child-issue-sized workstream            | Tasks and owner boundary                                                                                                                                                                              | Exit gate                                                                                                                                                                                                                                                                                                                                                           |
| ----- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Contracts, state, and secure plans      | `T01` plan/update contracts; `T02` schema migration; `T03` deployment writes; `T04` queries; `T05` generations; `T06` stable errors; `T07` private plan/report storage; `T08` generic-apply rejection | Focused migration, state, generation, plan-storage, apply, legacy-plan, atomic-mode, symlink/path, size-limit, and secret-canary tests pass. No preview path writes deployment/generation state.                                                                                                                                                                    |
| 2     | Detection and exact recovery primitives | `T09` digest/status detection; `T10` lifecycle lock; `T11` Docker identity/pinned recreate; `T12` manual rollback reuse; `T13` target verification                                                    | Focused plan-generator, Docker argv/identity/platform, lock contention, rollback compatibility, and health tests pass. Tests prove no `--remove-orphans`, no mutable-tag restore, and unknown never becomes current.                                                                                                                                                |
| 3     | Sequential managed lifecycle            | `T14` coordinator and failure matrix; `T15` action/reporting boundary                                                                                                                                 | Coordinator tests cover no-op/cancel/stale-plan zero mutation, pull failure, verified update, verified restore-and-continue, restore-failure stop, interruption cleanup, generation rules, complete service accounting, sanitized `update.v1`, and exit semantics.                                                                                                  |
| 4     | CLI and compatibility integration       | `T16` command registration; `T17` barrels/MCP schema compatibility; `T18` completions                                                                                                                 | CLI help/smoke, command/action, completion, MCP schema, typecheck, and build gates pass; ordinary plan/apply/history/generations/rollback remain compatible.                                                                                                                                                                                                        |
| 5     | End-to-end proof, docs, and closeout    | `T19` disposable Docker fixture; `T20`-`T23` operator/reference/architecture docs; `T24` indexes and ROADMAP                                                                                          | Run `npm run test:rfapps`, `npm run typecheck -w packages/rfapps-cli`, `npm run build:rfapps`, `npm run test:coverage:rfapps`, CLI preview/apply smoke, disposable update/restore integration, `npm run lint:md`, and `graphify update .` when graph artifacts exist. Mark ROADMAP #148 complete only after these gates and named-generation restore evidence pass. |

## Task Granularity

| Task  | Deliverable                                                                                                                                     | Files                                                                                                                  | Depends on                       | Owner                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------- |
| `T01` | Versioned managed plan/result unions, explicit detection states, backward-compatible plan intent                                                | `src/types/update.ts`, `src/types/plan.ts`, `src/types/index.ts`                                                       | —                                | Contract owner         |
| `T02` | Schema v3 nullable image identities and transactional migration                                                                                 | `src/lib/schema.sql`, `src/lib/migrations.ts`, `src/lib/migrations.spec.ts`                                            | —                                | Migration owner        |
| `T03` | `update` action and immutable identity writes; successful update creates a generation only after verification                                   | `src/types/state.ts`, `src/lib/state-storage.ts`, `src/lib/state-storage.spec.ts`                                      | `T02`                            | State-write owner      |
| `T04` | Identity-aware history row mapping and legacy-null reads                                                                                        | `src/lib/state-queries.ts`, `src/lib/state-queries.spec.ts`                                                            | `T02`, `T03`                     | State-query owner      |
| `T05` | Exact recovery-generation eligibility and identity serialization                                                                                | `src/lib/generations.ts`, `src/lib/generations.spec.ts`                                                                | `T02`, `T03`                     | Generation owner       |
| `T06` | Stable sanitized lifecycle/plan-stale/lock/verification/restore errors                                                                          | `src/lib/errors.ts`, `src/lib/errors.spec.ts`                                                                          | `T01`                            | Error-contract owner   |
| `T07` | Strict allowlisted `update-plan.v1` and report persistence with `0700`/`0600`, atomic rename, size/path/symlink checks                          | `src/lib/plan-storage.ts`, `src/lib/plan-storage.spec.ts`                                                              | `T01`, `T06`                     | Secure-storage owner   |
| `T08` | Reject managed intent from generic apply, including `--force`                                                                                   | `src/actions/apply.ts`, `src/actions/apply.spec.ts`                                                                    | `T01`, `T07`                     | Apply-compat owner     |
| `T09` | Repository/platform-correct digest lookup and actionable `update-available`/`up-to-date`/`unsupported`/`local-missing`/`unknown` classification | `src/lib/plan-generator.ts`, `src/lib/plan-generator.spec.ts`                                                          | `T01`, `T06`                     | Detection owner        |
| `T10` | Exclusive project/context lock with private atomic acquisition and reliable release                                                             | `src/lib/lifecycle-lock.ts`, `src/lib/lifecycle-lock.spec.ts`                                                          | `T06`                            | Concurrency owner      |
| `T11` | Typed context/container/image inspection and private pinned `pull`/recreate/restore override with `--pull never`                                | `src/lib/docker.ts`, `src/lib/docker.spec.ts`                                                                          | `T01`, `T06`                     | Docker primitive owner |
| `T12` | Reuse exact-image restore for named modern generations while preserving explicit legacy manual behavior                                         | `src/actions/rollback.ts`, `src/actions/rollback.spec.ts`                                                              | `T05`, `T11`                     | Rollback-compat owner  |
| `T13` | Fresh expected-image, target state/health, stable-running fallback, and dependency evidence                                                     | `src/types/health.ts`, `src/lib/health.ts`, `src/lib/health.spec.ts`                                                   | `T01`, `T11`                     | Verification owner     |
| `T14` | Injected sequential state machine, revalidation, snapshots, apply/restore, interruption, result aggregation                                     | `src/lib/managed-update.ts`, `src/lib/managed-update.spec.ts`, `src/lib/index.ts`                                      | `T03`-`T07`, `T09`-`T11`, `T13`  | Coordinator owner      |
| `T15` | Scope/config resolution, preview, approval, one machine result, report persistence, and exit mapping                                            | `src/actions/update.ts`, `src/actions/update.spec.ts`                                                                  | `T08`, `T14`                     | Action/UX owner        |
| `T16` | Commander options and root registration                                                                                                         | `src/commands/update.ts`, `src/cli.ts`                                                                                 | `T15`                            | CLI owner              |
| `T17` | Optional shared MCP history/plan fields; no managed mutation tool                                                                               | `src/mcp/schema.ts`, `src/mcp/schema.spec.ts`                                                                          | `T01`, `T03`-`T05`               | Compatibility owner    |
| `T18` | Bash/Zsh/Fish command and option completion                                                                                                     | `src/actions/completion.ts`, `src/actions/completion.spec.ts`                                                          | `T16`                            | Completion owner       |
| `T19` | Opt-in disposable Compose test proving digest update, unhealthy rollback, and restored image identity                                           | `src/lib/managed-update.integration.spec.ts`                                                                           | `T14`-`T18`                      | Integration-test owner |
| `T20` | Canonical operator guide and CLI reference; distinguish advisory plan checks from managed intent                                                | `docs/features/managed-update-lifecycle.md`, `packages/rfapps-cli/README.md`, `docs/features/quick-reference.md`       | `T16`, `T19`                     | Operator-doc owner     |
| `T21` | Saved-plan security, completion, and generic-apply boundaries                                                                                   | `docs/features/plan-apply-workflow.md`, `docs/features/secrets-management.md`, `docs/features/shell-completion.md`     | `T07`, `T08`, `T18`, `T19`       | Workflow-doc owner     |
| `T22` | Verified generation, exact-image/manual rollback, and target-health semantics                                                                   | `docs/features/deployment-history.md`, `docs/features/deployment-rollback.md`, `docs/features/service-healthchecks.md` | `T03`-`T05`, `T12`, `T13`, `T19` | Recovery-doc owner     |
| `T23` | `update.v1`, stdout/stderr, stable codes, and exit semantics                                                                                    | `docs/features/json-output.md`, `docs/features/error-handling.md`                                                      | `T06`, `T15`, `T19`              | Automation-doc owner   |
| `T24` | Command indexes, architecture overview, and ROADMAP completion/closing PR evidence                                                              | `README.md`, `docs/README.md`, `ROADMAP.md`                                                                            | `T20`-`T23`, all release gates   | Closeout-doc owner     |
| `T25` | Coordinator architecture and secret-free lifecycle data flow                                                                                    | `docs/architecture/overview.md`, `docs/architecture/data-flow.md`, `packages/rfapps-cli/CLAUDE.md`                     | `T14`, `T19`                     | Architecture-doc owner |

Every implementation task is independently reviewable and suitable for a child issue. If a task
needs more than its listed files, split it before assignment rather than creating cross-owner edits.
Specs remain with the production-file owner; barrels converge only in `T01` and `T14`.

## Dependency Analysis

The dependency graph is a DAG:

```text
T01 -> T06 -> T07 -> T08 ------------------------\
  |      |      \                                |
  |      +-> T10 \                               |
  +-> T09 --------+------------------------------+-> T14 -> T15 -> T16 -> T18 --\
  +-> T11 -> T13 -+                              |          |                    |
          \-> T12 -+                              |          +-> T17 ------------+-> T19 -> T20-T23/T25 -> T24
T02 -> T03 -> T04/T05 ---------------------------/                 ^
                 \-> T12 -----------------------------------------/
```

- Phase 1 locks DTO and database field names before downstream work; nullable migration fields keep
  old rows readable.
- `T09`, `T10`, and `T11` can run concurrently because they own disjoint files. `T12` waits for both
  generation identity and the exact restore primitive; `T13` waits for fresh Docker observations.
- `T14` is the convergence point and must not begin against unstable contracts. It calls libraries,
  never action-level `execute*` functions.
- `T15` owns prompts, streams, database lifetime, persisted final report, and process exit state;
  `T14` remains data-only.
- Documentation is last so ROADMAP status reports proven behavior, not intent. Reference docs may be
  drafted earlier, but `T24` alone owns the final ROADMAP update after release gates pass.

No task depends on a later phase, and no pair of parallel tasks owns the same file, preventing
circular dependencies and merge hotspots.

## File-to-Task Mapping

| Area                          | Task                       | Files                                                                                                                                  |
| ----------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts/errors              | `T01`, `T06`, `T13`, `T17` | `types/update.ts`, `types/plan.ts`, `types/health.ts`, `errors.ts`, `types/index.ts`, `mcp/schema.ts` and focused specs                |
| SQLite/history/generations    | `T02`-`T05`                | `schema.sql`, `migrations.ts`, `types/state.ts`, `state-storage.ts`, `state-queries.ts`, `generations.ts` and focused specs            |
| Plans/detection               | `T07`-`T09`                | `plan-storage.ts`, `plan-generator.ts`, `actions/apply.ts` and focused specs                                                           |
| Docker/recovery/verification  | `T10`-`T13`                | `lifecycle-lock.ts`, `docker.ts`, `actions/rollback.ts`, `health.ts` and focused specs                                                 |
| Lifecycle and CLI             | `T14`-`T18`                | `managed-update.ts`, `actions/update.ts`, `commands/update.ts`, `cli.ts`, `lib/index.ts`, `actions/completion.ts` and focused specs    |
| Integration and documentation | `T19`-`T25`                | Integration spec, canonical guide, feature/reference docs, architecture docs, command indexes, package README/CLAUDE, and `ROADMAP.md` |

The mapping deliberately excludes new runtime dependencies, MCP mutation tools, parallel service
mutation, scheduling, notifications, volume/data rollback, signature scanning, and image retention;
those remain separate follow-up issues.
