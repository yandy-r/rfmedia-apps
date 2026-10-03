# Implementation Report: Production-Readiness Lint Command (`rfapps lint`)

## Summary

Added `rfapps lint` to `packages/rfapps-cli` — a daemon-free, CI-friendly command that
statically evaluates the resolved Docker Compose configuration against eight
production-readiness rules (resource limits, health checks, log rotation, restart policy,
security knobs). Supports grouped table output, `--json`, `--sarif` (SARIF 2.1.0),
`--list-rules`, `--fail-on` exit gating, `.rfapps.yaml` `lint.ignore` suppressions, and
opt-in `--runtime` drift enrichment via existing `lib/drift.ts`.

## Assessment vs Reality

| Metric        | Predicted (Plan) | Actual              |
| ------------- | ---------------- | ------------------- |
| Complexity    | Large            | Large               |
| Confidence    | 8/10             | 8/10                |
| Files Changed | 13 + docs        | 16 files (6 create) |

## Tasks Completed

| #   | Task                              | Status   | Notes                                                        |
| --- | --------------------------------- | -------- | ------------------------------------------------------------ |
| 1.1 | Define lint types                 | Complete |                                                              |
| 1.2 | Add lint.ignore to config types   | Complete |                                                              |
| 2.1 | Rule catalog + evaluation engine  | Complete |                                                              |
| 2.2 | Lint exit-code resolver           | Complete |                                                              |
| 2.3 | Thread lint config through loader | Complete |                                                              |
| 2.4 | Re-export lint types              | Complete |                                                              |
| 2.5 | SARIF 2.1.0 serializer            | Complete |                                                              |
| 3.1 | Lint action orchestration         | Complete |                                                              |
| 3.2 | Re-export lint engine from barrel | Complete |                                                              |
| 4.1 | Register lint command in CLI      | Complete | Deviated — `--fail-on` validated in action, not `.choices()` |
| 4.2 | Engine unit tests                 | Complete | 32 tests                                                     |
| 4.3 | Action unit tests                 | Complete | 9 tests                                                      |
| 4.4 | Exit-code resolver tests          | Complete | 9 new cases                                                  |
| 5.1 | Documentation + plex exemption    | Complete |                                                              |

## Validation Results

| Level           | Status | Notes                                     |
| --------------- | ------ | ----------------------------------------- |
| Static Analysis | Pass   | `npm run typecheck` — zero errors         |
| Unit Tests      | Pass   | 62 lint-related tests; 757 monorepo total |
| Build           | Pass   | `npm run build:rfapps`                    |
| Integration     | N/A    | CLI smoke via `--list-rules`, `--fail-on` |
| Edge Cases      | Pass   | Invalid `--fail-on` exits 2 (UsageError)  |

## Files Changed

| File                                             | Action  | Lines           |
| ------------------------------------------------ | ------- | --------------- |
| `packages/rfapps-cli/src/types/lint.ts`          | CREATED | +~150           |
| `packages/rfapps-cli/src/lib/lint.ts`            | CREATED | +~200           |
| `packages/rfapps-cli/src/lib/lint-sarif.ts`      | CREATED | +~120           |
| `packages/rfapps-cli/src/actions/lint.ts`        | CREATED | +~380           |
| `packages/rfapps-cli/src/lib/lint.spec.ts`       | CREATED | +~380           |
| `packages/rfapps-cli/src/actions/lint.spec.ts`   | CREATED | +~250           |
| `packages/rfapps-cli/src/types/config.ts`        | UPDATED | +23             |
| `packages/rfapps-cli/src/types/index.ts`         | UPDATED | +23             |
| `packages/rfapps-cli/src/lib/config.ts`          | UPDATED | +6              |
| `packages/rfapps-cli/src/lib/exit-codes.ts`      | UPDATED | +28             |
| `packages/rfapps-cli/src/lib/exit-codes.spec.ts` | UPDATED | +75             |
| `packages/rfapps-cli/src/lib/index.ts`           | UPDATED | +4              |
| `packages/rfapps-cli/src/cli.ts`                 | UPDATED | +33             |
| `packages/rfapps-cli/README.md`                  | UPDATED | +84             |
| `CLAUDE.md`                                      | UPDATED | +1 line         |
| `.rfapps.yaml`                                   | UPDATED | plex exemptions |

## Deviations from Plan

1. **`--fail-on` validation**: Removed Commander `.choices()` on the subcommand option;
   validation moved to `parseFailOn()` in `actions/lint.ts` via `InvalidArgumentError`.
   Subcommand `.choices()` exited with code 1; action-level validation correctly exits 2
   (UsageError) per acceptance criteria.

2. **`lint.spec.ts` type fix**: Added explicit `[unknown]` tuple type in action test mock
   callback to satisfy strict `noImplicitAny`.

## Issues Encountered

- Batch 4 between-batch typecheck failed on implicit `any` in `lint.spec.ts` — fixed
  inline before proceeding.
- Commander subcommand `.choices()` for `--fail-on` produced exit code 1 instead of 2 —
  fixed by action-level validation (global `--output` behaves differently).

## Tests Written

| Test File                            | Tests | Coverage                        |
| ------------------------------------ | ----- | ------------------------------- |
| `src/lib/lint.spec.ts`               | 32    | All 8 rules, suppression, order |
| `src/actions/lint.spec.ts`           | 9     | Format dispatch, runtime, exit  |
| `src/lib/exit-codes.spec.ts` (added) | 9     | `resolveLintExitCode` ladder    |

## Next Steps

- [ ] Code review via `/code-review`
- [ ] Create PR via `/prp-pr`
