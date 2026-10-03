# Implementation Report: Unified Doctor Command

## Summary

Implemented `rfapps doctor` as a read-only diagnostic command that aggregates
configuration/security lint findings, runtime status, dependency readiness, optional
image freshness checks, and existing rfapps state history into a stable
`doctor.v1` result.

## Assessment vs Reality

| Metric        | Predicted (Plan)        | Actual                                        |
| ------------- | ----------------------- | --------------------------------------------- |
| Complexity    | Large                   | Large                                         |
| Confidence    | 8/10                    | 8/10                                          |
| Files Changed | 18 source/test + 5 docs | 22 source/test/docs plus report and plan move |

## Tasks Completed

| #   | Task                         | Status | Notes                                      |
| --- | ---------------------------- | ------ | ------------------------------------------ |
| 1.1 | Define doctor contracts      | Done   | Added `types/doctor.ts` and type exports   |
| 1.2 | Severity and summary helpers | Done   | Added pure helpers and threshold parsing   |
| 1.3 | Text formatter contract      | Done   | Formatter returns stderr-ready lines       |
| 2.1 | Config/security checker      | Done   | Maps existing lint findings                |
| 2.2 | Runtime/readiness checker    | Done   | Uses status map and snapshot readiness     |
| 2.3 | Update freshness checker     | Done   | Skipped unless `--check-updates`           |
| 2.4 | State health checker         | Done   | Skips missing DB without creating one      |
| 3.1 | Checker registry             | Done   | Sequential deterministic aggregation       |
| 3.2 | Doctor action                | Done   | Resolves scope and emits text/machine data |
| 3.3 | Re-exports                   | Done   | Type and selected lib exports added        |
| 4.1 | Command module               | Done   | Lazy imports `actions/doctor.ts`           |
| 4.2 | CLI registration             | Done   | `doctor` appears in top-level help         |
| 4.3 | Shell completions            | Done   | Bash, zsh, and fish updated                |
| 4.4 | Feature documentation        | Done   | Added focused doctor feature doc           |
| 5.1 | Doctor lib tests             | Done   | Severity, checkers, formatter covered      |
| 5.2 | Doctor action tests          | Done   | Output, targeting, thresholds covered      |
| 5.3 | Documentation surfaces       | Done   | README and feature docs updated            |
| 5.4 | Completion tests             | Done   | Shell-specific doctor assertions added     |
| 6.1 | Validation and polish        | Done   | All required automated checks passed       |

## Validation Results

| Level           | Status | Notes                                                       |
| --------------- | ------ | ----------------------------------------------------------- |
| Static Analysis | Pass   | `npm run typecheck -w packages/rfapps-cli`                  |
| Unit Tests      | Pass   | Targeted doctor/completion suite: 47 tests passed           |
| Full Tests      | Pass   | `npm run test:run -w packages/rfapps-cli`: 803 tests passed |
| Build           | Pass   | `npm run build:rfapps`                                      |
| Markdown        | Pass   | `npm run lint:md`: 102 files, 0 errors                      |
| Repository Lint | Pass   | `npm run lint`                                              |
| CLI Smoke       | Pass   | Help and root `tsx` doctor JSON/threshold smokes passed     |

Manual smoke note: `npm run rfapps -- doctor --json --no-sidecars` and
`npm run rfapps -- doctor --fail-on warn --no-sidecars` fail before command
execution because the workspace dev script runs from `packages/rfapps-cli` and
cannot locate the root `rfapps.config.yaml`. Running the same CLI entrypoint from
the repo root with `npx tsx packages/rfapps-cli/src/cli.ts ...` validates doctor
behavior against the root config. `--fail-on warn` exits `1` as expected because
warn findings exist.

## Files Changed

| File                                                    | Action  |
| ------------------------------------------------------- | ------- |
| `packages/rfapps-cli/src/types/doctor.ts`               | Created |
| `packages/rfapps-cli/src/types/index.ts`                | Updated |
| `packages/rfapps-cli/src/lib/doctor/severity.ts`        | Created |
| `packages/rfapps-cli/src/lib/doctor/checkers.ts`        | Created |
| `packages/rfapps-cli/src/lib/doctor/formatters.ts`      | Created |
| `packages/rfapps-cli/src/lib/doctor/index.ts`           | Created |
| `packages/rfapps-cli/src/lib/index.ts`                  | Updated |
| `packages/rfapps-cli/src/actions/doctor.ts`             | Created |
| `packages/rfapps-cli/src/commands/doctor.ts`            | Created |
| `packages/rfapps-cli/src/cli.ts`                        | Updated |
| `packages/rfapps-cli/src/actions/completion.ts`         | Updated |
| `packages/rfapps-cli/src/lib/doctor/severity.spec.ts`   | Created |
| `packages/rfapps-cli/src/lib/doctor/checkers.spec.ts`   | Created |
| `packages/rfapps-cli/src/lib/doctor/formatters.spec.ts` | Created |
| `packages/rfapps-cli/src/actions/doctor.spec.ts`        | Created |
| `packages/rfapps-cli/src/actions/completion.spec.ts`    | Updated |
| `packages/rfapps-cli/README.md`                         | Updated |
| `docs/features/rfapps-doctor-command.md`                | Created |
| `docs/features/quick-reference.md`                      | Updated |
| `docs/features/output-formats.md`                       | Updated |
| `docs/features/json-output.md`                          | Updated |
| `docs/features/shell-completion.md`                     | Updated |

## Deviations from Plan

- Checker imports use direct helper modules instead of the lib barrel. This keeps
  checker tests isolated and avoids circular/mock ambiguity.
- The exact `npm run rfapps -- doctor ...` smoke commands are documented as a
  workspace-cwd configuration lookup issue; root `tsx` smoke commands validate the
  same CLI behavior.

## Issues Encountered

- Initial checker tests mocked the lib barrel but the checker implementation was
  importing through that same barrel. Switching to direct helper imports fixed the
  isolation issue and better matched local module boundaries.

## Tests Written

| Test File                                               | Tests   | Coverage                                                        |
| ------------------------------------------------------- | ------- | --------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/doctor/severity.spec.ts`   | 4       | Threshold parsing, sorting, summary, skipped checks             |
| `packages/rfapps-cli/src/lib/doctor/checkers.spec.ts`   | 4       | Lint mapping, update skip/opt-in, state skip, failure isolation |
| `packages/rfapps-cli/src/lib/doctor/formatters.spec.ts` | 2       | Human grouping, evidence, skipped checks                        |
| `packages/rfapps-cli/src/actions/doctor.spec.ts`        | 6       | Text/JSON output, cancellation, threshold behavior              |
| `packages/rfapps-cli/src/actions/completion.spec.ts`    | Updated | Bash/zsh/fish doctor command and flag completions               |

## Next Steps

- [ ] Code review via `$code-review`
- [ ] Create PR via `$prp-pr`
