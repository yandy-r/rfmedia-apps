# Plan: Unified Doctor Command (`rfapps doctor`)

## Summary

Add a read-only `rfapps doctor` command that aggregates operational, configuration, security,
update, and state-health findings into one operator-friendly diagnostic surface. The implementation
should be an orchestration layer over existing `status`, `health`, `plan`, `lint`, `drift`, and
state helpers, with a versioned JSON contract and deterministic finding ordering for automation.

## User Story

As an rfapps operator or CI automation, I want a single read-only diagnostic command, so that I can
understand deployment health, configuration hygiene, image freshness, security posture, and
persisted state issues without combining several commands manually.

## Problem → Solution

Operators currently stitch together `status`, `health`, `plan --check-updates`, `lint`, `drift`, and
state/history checks by hand, which makes recurring platform issues slower to diagnose ->
`rfapps doctor` resolves the same target scope once, runs bounded read-only checks, returns stable
actionable findings, and exits non-zero only when findings meet the configured threshold.

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A
- **Source Spec**: `docs/prps/specs/rfapps-unified-doctor-command.spec.md`
- **PRD Phase**: standalone
- **Estimated Files**: 18 source/test files + 5 documentation files
- **Worktree Mode**: Disabled via `--no-worktree`

## Research Dispatch

Enhanced parallel research was synthesized directly in this plan, equivalent to the seven
`--enhanced` roles:

| Researcher            | Coverage                                      | Synthesized Findings                                                                                                                 |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| api-researcher        | External APIs, libraries, integration surface | No external research needed; feature composes existing internal Docker, config, lint, plan, health, and SQLite helpers.              |
| business-analyzer     | Requirements and acceptance criteria          | Command must be read-only by default, actionable, deterministic, and automation-safe with a critical-only default failure threshold. |
| tech-designer         | Architecture, data models, task layout        | Use command/action separation: `commands/doctor.ts` registers CLI; `actions/doctor.ts` orchestrates checkers under `lib/doctor/`.    |
| ux-researcher         | CLI UX and output shape                       | Human output groups findings by severity, category, and service; JSON output is versioned and stable.                                |
| security-researcher   | Threat model and validation                   | Avoid remediation, writes, Docker mutations, unmasked secrets, and command suggestions that execute unsafe actions by default.       |
| practices-researcher  | Naming, tests, KISS, reuse                    | Mirror `lint`, `health`, `plan`, and `completion` patterns; keep checkers small, typed, deterministic, and Vitest-covered.           |
| recommendations-agent | Cross-cutting risks and confidence            | The highest risk is duplicating diagnostic logic; mitigate by mapping existing result contracts into doctor findings.                |

Codebase intelligence coverage:

- **Similar Implementations**: `actions/lint.ts`, `actions/health.ts`, `actions/plan.ts`,
  `actions/status.ts`, `lib/lint.ts`, `lib/health.ts`, `lib/plan-generator.ts`,
  `lib/service-status.ts`.
- **Naming Conventions**: kebab-case files, `executeX` action functions, `RawXOptions`, PascalCase
  interfaces, string-literal unions, `.js` ESM import suffixes.
- **Error Handling**: validate CLI boundary values with `InvalidArgumentError`; format operational
  failures with `formatError()` and `outputFormattedError()`; set `process.exitCode`, do not call
  `process.exit()`.
- **Logging Patterns**: use `logDebug`, `logInfo`, `logSuccess`, `logWarn`; human rendering writes
  to stderr; machine formats use `formatOutput()` to stdout.
- **Type Definitions**: add dedicated `types/doctor.ts`; re-export from `types/index.ts`; do not use
  `any`.
- **Test Patterns**: Vitest co-located `*.spec.ts`; use `vi.mock`, `vi.hoisted`,
  `vi.clearAllMocks()`, restore `process.exitCode`, and spy on `console.error` or
  `process.stdout.write` as needed.
- **Configuration**: reuse `loadConfig()`, `applyCliOverrides()`, `isValidProfile()`,
  `resolveServicesWithInteractive()`, and `getEnvToolExecConfig()`.
- **Dependencies**: no new runtime or dev dependencies required.

Trace coverage:

- **Entry Points**: `src/cli.ts` imports `registerDoctorCommand()` from `src/commands/doctor.ts`;
  that command lazy-imports `executeDoctor()` from `src/actions/doctor.ts`.
- **Data Flow**: CLI flags -> raw options -> normalized `DoctorOptions` -> config overrides and
  target resolution -> checker registry -> `DoctorResult` -> text or machine formatter ->
  threshold-based `process.exitCode`.
- **State Changes**: none by default. Doctor may read Docker state, resolved compose config,
  registry metadata when `--check-updates` is set, and SQLite state; it must not write plans, mutate
  containers, modify compose/config files, or record deployments.
- **Contracts**: stable `DoctorResult` schema with `schemaVersion`, `timestamp`, `scope`, `checks`,
  `summary`, `findings`, and optional signal availability/warnings.
- **Patterns**: action orchestration, read-only lib checkers, deterministic sort helpers,
  machine-format stdout separation, and shell completion updates.

## Batches

Tasks grouped by dependency for parallel execution. Tasks within the same batch run concurrently;
batches run in order.

| Batch | Tasks              | Depends On | Parallel Width |
| ----- | ------------------ | ---------- | -------------- |
| B1    | 1.1, 1.2, 1.3      | —          | 3              |
| B2    | 2.1, 2.2, 2.3, 2.4 | B1         | 4              |
| B3    | 3.1, 3.2, 3.3      | B2         | 3              |
| B4    | 4.1, 4.2, 4.3, 4.4 | B3         | 4              |
| B5    | 5.1, 5.2, 5.3      | B4         | 3              |
| B6    | 6.1                | B5         | 1              |

- **Total tasks**: 18
- **Total batches**: 6
- **Max parallel width**: 4

No two tasks in the same batch modify the same file. Foundational contracts land in B1, checker
engines in B2, orchestration in B3, CLI/completion wiring in B4, tests/docs in B5, and final
validation in B6.

---

## UX Design

### Before

- No `doctor` command exists in `packages/rfapps-cli/src/cli.ts`; operators use separate commands
  for status, health, plan, lint, drift, and history.
- `status` reads `docker ps` and reports runtime state only.
- `health` evaluates dependency readiness only.
- `lint` reports compose hygiene and optional runtime drift only.
- `plan --check-updates` can check registry freshness but also saves a plan artifact.

### After

Human text output should be concise, grouped, and actionable:

```text
rfapps doctor

Doctor Summary
  Scope: all services | Checks: 4 run, 1 skipped | Findings: critical 0, error 1, warn 3, info 4

  error  runtime  plex
    container is unhealthy
    evidence: health=unhealthy, state=running
    next: rfapps health -s plex --no-wait-for-ready

  warn   config   sonarr
    health check missing
    evidence: lint rule healthcheck-missing
    next: rfapps lint -s sonarr
```

JSON output should remain stdout-clean and stable:

```json
{
  "schemaVersion": "doctor.v1",
  "timestamp": "2026-06-10T02:00:00.000Z",
  "scope": {
    "services": ["plex"],
    "profiles": ["media"],
    "composePath": "compose.yml",
    "checkUpdates": false
  },
  "summary": {
    "critical": 0,
    "error": 1,
    "warn": 0,
    "info": 0,
    "total": 1
  },
  "checks": [
    {
      "id": "runtime-status",
      "category": "runtime",
      "status": "run"
    }
  ],
  "findings": [
    {
      "id": "runtime.unhealthy",
      "severity": "error",
      "category": "runtime",
      "service": "plex",
      "message": "Container is unhealthy",
      "evidence": ["state=running", "health=unhealthy"],
      "suggestedCommand": "rfapps health -s plex --no-wait-for-ready"
    }
  ]
}
```

### Interaction Changes

| Touchpoint                 | Before                              | After                                                                    | Notes                                                                |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `rfapps doctor`            | absent                              | new read-only diagnostic command                                         | Registered via `commands/doctor.ts`, not inline-only registration.   |
| `-s`, `--services`, `-g`   | spread across existing commands     | reused for doctor scope                                                  | Mirror service targeting behavior from `plan`, `health`, and `lint`. |
| `--check-updates`          | only `plan` checks registry updates | doctor can opt into update findings                                      | Must not save a plan file.                                           |
| `--fail-on <severity>`     | lint has `--fail-on`                | doctor has threshold with default `critical`                             | Valid values: `none`, `info`, `warn`, `error`, `critical`.           |
| `--json` / `--output json` | existing global contract            | stable `DoctorResult` to stdout                                          | Keep logs on stderr or suppressed by machine mode.                   |
| shell completion           | no doctor command                   | bash, zsh, fish complete command and flags                               | Include service/group/profile/value completions.                     |
| docs                       | no doctor docs                      | README, quick reference, output docs, JSON docs, completion docs updated | Add a doctor command section and examples.                           |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                                    | Lines                                | Why                                                                                                 |
| -------------- | ------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| P0 (critical)  | `docs/prps/specs/rfapps-unified-doctor-command.spec.md` | all                                  | Source requirements and explicit architecture decisions.                                            |
| P0 (critical)  | `packages/rfapps-cli/src/cli.ts`                        | 53-189, 377-490, 566-606             | Global output contract, command registration, lazy imports, and error handling.                     |
| P0 (critical)  | `packages/rfapps-cli/src/actions/lint.ts`               | 71-145, 161-220, 323-456             | Severity parsing, grouped findings, config load, target resolution, output, exit code pattern.      |
| P0 (critical)  | `packages/rfapps-cli/src/actions/health.ts`             | 43-211                               | Health action orchestration, readiness summary mapping, warnings, and non-fatal telemetry behavior. |
| P0 (critical)  | `packages/rfapps-cli/src/actions/plan.ts`               | 274-406                              | `--check-updates`, plan generation, format dispatch, and plan failure handling.                     |
| P0 (critical)  | `packages/rfapps-cli/src/lib/service-status.ts`         | 81-130, 216-260                      | Existing cached service status map for runtime status findings.                                     |
| P0 (critical)  | `packages/rfapps-cli/src/lib/plan-generator.ts`         | 319-367                              | Existing image freshness and diff generation behavior to reuse without saving plans.                |
| P0 (critical)  | `packages/rfapps-cli/src/lib/lint.ts`                   | 63-143, 266-323                      | Pure lint catalog and deterministic evaluation engine to map into doctor findings.                  |
| P0 (critical)  | `packages/rfapps-cli/src/lib/index.ts`                  | 117-182                              | Existing barrel exports for plan, lint, status, health, db, and state helpers.                      |
| P1 (important) | `packages/rfapps-cli/src/types/options.ts`              | 13-66, 174-189                       | Global, target, compose, output, and env-tool option contracts.                                     |
| P1 (important) | `packages/rfapps-cli/src/types/lint.ts`                 | 8-130                                | Existing severity, finding, summary, and options style to mirror for doctor types.                  |
| P1 (important) | `packages/rfapps-cli/src/types/health.ts`               | 8-111                                | Readiness signal availability and warning contracts for doctor result metadata.                     |
| P1 (important) | `packages/rfapps-cli/src/types/index.ts`                | 15-158                               | Type barrel export pattern.                                                                         |
| P1 (important) | `packages/rfapps-cli/src/lib/state-queries.ts`          | 1-132, 215-239                       | Read-only SQLite query style and parameterized SQL convention.                                      |
| P1 (important) | `packages/rfapps-cli/src/lib/db.ts`                     | 82-185                               | Database initialization and close pattern.                                                          |
| P1 (important) | `packages/rfapps-cli/src/actions/completion.ts`         | 27-99, 112-318, 328-603, 691-956     | Bash, zsh, and fish completion surfaces that must include doctor.                                   |
| P1 (important) | `packages/rfapps-cli/src/actions/completion.spec.ts`    | 65-131, 192-340                      | Completion test pattern and command-list assertions.                                                |
| P2 (reference) | `packages/rfapps-cli/src/actions/plan.spec.ts`          | 125-226                              | Action tests with mocked config, formatter, generated plan, and exit code restoration.              |
| P2 (reference) | `packages/rfapps-cli/src/actions/lint.spec.ts`          | 37-231                               | Lint action test setup, formatter assertions, text output spies, and threshold tests.               |
| P2 (reference) | `packages/rfapps-cli/README.md`                         | 181-224, 477-554, 905-950, 1297-1422 | Command docs placement and examples.                                                                |
| P2 (reference) | `docs/features/shell-completion.md`                     | all                                  | Shell completion documentation surface.                                                             |
| P2 (reference) | `docs/features/quick-reference.md`                      | all                                  | Quick command card surface.                                                                         |
| P2 (reference) | `docs/features/output-formats.md`                       | 1-71                                 | Global output-format behavior documentation.                                                        |
| P2 (reference) | `docs/features/json-output.md`                          | 1-23, 195-216                        | Legacy JSON output documentation.                                                                   |

## External Documentation

No external research is needed for this feature. It uses existing in-repository dependencies:
Commander, Vitest, better-sqlite3, Docker helper wrappers, and `@rfmedia/common` formatters are
already present and have established local patterns to mirror.

---

## Patterns to Mirror

Code patterns discovered in the codebase. Follow these exactly.

### NAMING_CONVENTION

```ts
// SOURCE: packages/rfapps-cli/src/types/lint.ts:8-16
export type LintSeverity = "error" | "warn" | "info";
export type LintFailOn = LintSeverity | "none";
```

- Use string-literal unions, not TypeScript enums.
- Use `DoctorSeverity`, `DoctorCategory`, `DoctorCheckStatus`, `DoctorFailOn`, `DoctorFinding`,
  `DoctorSummary`, `DoctorCheckResult`, `DoctorResult`, and `DoctorOptions`.
- Use file names `doctor.ts`, `severity.ts`, `checkers.ts`, `formatters.ts`, and `*.spec.ts`.
- Use ESM imports with `.js` suffixes, and use `import type` for type-only imports.

### ERROR_HANDLING

```ts
// SOURCE: packages/rfapps-cli/src/actions/lint.ts:78-90
const normalized = value.toLowerCase().trim();
if (VALID_FAIL_ON.includes(normalized as LintFailOn)) {
  return normalized as LintFailOn;
}
throw new InvalidArgumentError("--fail-on", value, "Invalid fail-on severity", [...VALID_FAIL_ON]);
```

- Validate `--fail-on` at the action/lib boundary with `InvalidArgumentError`, not Commander
  `.choices()`, to preserve repository usage-error handling.
- For Docker/config failures that prevent a checker from running, record a failed
  `DoctorCheckResult` and an error-level finding where practical.
- Use `process.exitCode = 1` for threshold failures. Do not call `process.exit()`.

### LOGGING_PATTERN

```ts
// SOURCE: packages/rfapps-cli/src/actions/health.ts:208-210
if (format !== "text") {
  await formatOutput(format, result);
}
```

- For machine formats, call `formatOutput(format, result)` and return before human rendering.
- For text format, render via `console.error()` and `colors.*`, keeping stdout clean.
- Use `logDebug()` for normalized options and checker timing details.

### REPOSITORY_PATTERN

```ts
// SOURCE: packages/rfapps-cli/src/lib/state-queries.ts:115-131
const stmt = db.prepare(query);
const rows = stmt.all(...params) as StateEntryRow[];
return rows.map(rowToStateEntry);
```

- State health checks must be read-only and parameterized.
- Initialize and close the database in the checker or action using `initializeDatabase()` and
  `closeDatabase()` in a `finally` block.
- Query a small bounded sample, such as recent failed deployments and total deployment count, rather
  than scanning unbounded history.

### SERVICE_PATTERN

```ts
// SOURCE: packages/rfapps-cli/src/actions/health.ts:80-110
const config = await loadConfig();
const finalConfig = applyCliOverrides(config, { composePath, envFile, profile, noSidecars });
const resolved = await resolveServicesWithInteractive(
  { service, services, group, noSidecars, sidecars, yes },
  finalConfig,
  finalConfig.composePath,
  process.cwd(),
  { envTool },
);
```

- `actions/doctor.ts` should normalize options, load config, apply overrides, resolve services once,
  then pass a `DoctorCheckContext` to lib checkers.
- Keep checker functions pure or read-only where possible, returning data instead of writing output.
- Prefer mapping existing diagnostics into doctor findings over re-implementing the lower-level
  diagnostics.

### TEST_STRUCTURE

```ts
// SOURCE: packages/rfapps-cli/src/actions/plan.spec.ts:125-142
beforeEach(() => {
  vi.clearAllMocks();
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});
```

- Co-locate Vitest tests beside source files.
- Use `vi.clearAllMocks()`, not `vi.resetAllMocks()`, unless a test explicitly needs to replace
  module implementations.
- Restore `process.exitCode` in `afterEach()`.
- Mock `../lib/index.js`, `../lib/formatters/index.js`, and specific doctor checker modules in
  action tests.

### COMPLETION_PATTERN

```ts
// SOURCE: packages/rfapps-cli/src/actions/completion.ts:97-99
local lint_opts="--service --services --group --no-sidecars --compose --env-file --profile --json --sarif --runtime --list-rules --fail-on"
```

- Add `doctor` to every command list in bash, zsh, and fish sections.
- Add `doctor_opts` for bash and a `doctor)` branch in bash/zsh.
- Add fish command and option completion lines for service/group/profile and threshold values.
- Add tests that assert command presence and doctor-specific flags for all three shells.

---

## Files to Change

| File                                                    | Action | Justification                                                                                              |
| ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/types/doctor.ts`               | CREATE | Define versioned doctor result, finding, checker, summary, scope, and option contracts.                    |
| `packages/rfapps-cli/src/types/index.ts`                | UPDATE | Re-export doctor contracts from the public type barrel.                                                    |
| `packages/rfapps-cli/src/lib/doctor/severity.ts`        | CREATE | Severity ranking, threshold parsing, summary building, deterministic sort helpers.                         |
| `packages/rfapps-cli/src/lib/doctor/checkers.ts`        | CREATE | Read-only checker implementations mapping lint, status, health, plan/update, and state data into findings. |
| `packages/rfapps-cli/src/lib/doctor/formatters.ts`      | CREATE | Text renderer for grouped human output and helper labels/colors.                                           |
| `packages/rfapps-cli/src/lib/doctor/index.ts`           | CREATE | Doctor lib barrel for checkers, severity helpers, and formatter helpers.                                   |
| `packages/rfapps-cli/src/lib/index.ts`                  | UPDATE | Re-export doctor helpers only if actions/tests need the shared barrel; keep imports direct otherwise.      |
| `packages/rfapps-cli/src/actions/doctor.ts`             | CREATE | Normalize options, resolve scope, run checkers, emit output, set threshold exit code.                      |
| `packages/rfapps-cli/src/commands/doctor.ts`            | CREATE | Define Commander command, flags, help text, and lazy-import the action.                                    |
| `packages/rfapps-cli/src/cli.ts`                        | UPDATE | Import and register `registerDoctorCommand(program)` from `commands/doctor.ts`.                            |
| `packages/rfapps-cli/src/actions/completion.ts`         | UPDATE | Add bash, zsh, and fish completions for `doctor` and all doctor flags.                                     |
| `packages/rfapps-cli/src/lib/doctor/severity.spec.ts`   | CREATE | Unit tests for threshold parsing, ordering, summary counts, and exit decisions.                            |
| `packages/rfapps-cli/src/lib/doctor/checkers.spec.ts`   | CREATE | Unit tests for mapped findings from lint/status/updates/state and skipped checks.                          |
| `packages/rfapps-cli/src/lib/doctor/formatters.spec.ts` | CREATE | Unit tests for grouped text rendering and stable category/severity grouping.                               |
| `packages/rfapps-cli/src/actions/doctor.spec.ts`        | CREATE | Action tests for targeting, formats, checker failures, update opt-in, and exit threshold.                  |
| `packages/rfapps-cli/src/actions/completion.spec.ts`    | UPDATE | Add doctor command and flag completion assertions for bash, zsh, and fish.                                 |
| `packages/rfapps-cli/README.md`                         | UPDATE | Add doctor to key features, command reference, examples, exit policy, and JSON examples.                   |
| `docs/features/quick-reference.md`                      | UPDATE | Add doctor to status/monitoring and JSON scripting examples.                                               |
| `docs/features/output-formats.md`                       | UPDATE | Add doctor JSON/output example and note stable `schemaVersion`.                                            |
| `docs/features/json-output.md`                          | UPDATE | Add doctor JSON schema example and jq snippets.                                                            |
| `docs/features/shell-completion.md`                     | UPDATE | Include doctor in command list and command-specific completion examples.                                   |
| `docs/features/rfapps-doctor-command.md`                | CREATE | Focused feature documentation for checks, flags, output schema, examples, and read-only guarantees.        |

## NOT Building

- No auto-fix, remediation execution, compose edits, container start/stop/recreate, plan saving,
  state writes, or deployment history writes.
- No broad category include/exclude flags in v1. Run core fast checks by default and use only
  `--check-updates` for opt-in registry checks.
- No new third-party dependencies.
- No SARIF output for doctor in v1. `lint --sarif` already owns SARIF.
- No MCP tool for doctor unless a separate feature requests MCP exposure.
- No generic plugin system for checkers. Use a typed in-code checker registry.
- No worktree setup or worktree annotations because `--no-worktree` was requested for this plan.

---

## Step-by-Step Tasks

### Task 1.1: Define Doctor Contracts — Depends on [none]

- **BATCH**: B1
- **ACTION**: Create `packages/rfapps-cli/src/types/doctor.ts`.
- **IMPLEMENT**: Define `DOCTOR_SCHEMA_VERSION = "doctor.v1"` as const, plus
  `DoctorSeverity = "critical" | "error" | "warn" | "info"`,
  `DoctorFailOn = DoctorSeverity | "none"`, `DoctorCategory`,
  `DoctorCheckStatus = "run" | "skipped" | "failed"`, `DoctorScope`, `DoctorFinding`,
  `DoctorCheckResult`, `DoctorSummary`, `DoctorResult`, `DoctorOptions`, and `DoctorCheckContext`.
  Include `suggestedCommand?: string`, `evidence: string[]`, and optional `service?: string`.
- **MIRROR**: `types/lint.ts` for string unions and JSDoc field descriptions.
- **IMPORTS**: `import type { OutputFormat } from "@rfmedia/common";`,
  `import type { RfappsConfig, EnvToolExecConfig } from "./index.js";`, and
  `import type { ReadinessSignalAvailability } from "./health.js";` only if needed.
- **GOTCHA**: Do not import from `./index.js` if it creates a circular type-only problem; prefer
  direct files such as `./config.js` and `./options.js`.
- **VALIDATE**: `npm run typecheck -w packages/rfapps-cli` after type exports are wired.

### Task 1.2: Add Severity and Summary Helpers — Depends on [none]

- **BATCH**: B1
- **ACTION**: Create `packages/rfapps-cli/src/lib/doctor/severity.ts`.
- **IMPLEMENT**: Add immutable helpers: `parseDoctorFailOn(value?: string): DoctorFailOn`,
  `compareDoctorSeverity(left, right)`, `shouldFailDoctor(result, failOn)`,
  `sortDoctorFindings(findings)`, `buildDoctorSummary(findings)`, and
  `createSkippedCheck(id, category, reason)`. Severity order is `critical > error > warn > info`;
  default `failOn` is `critical`; `none` always exits 0.
- **MIRROR**: `actions/lint.ts` `parseFailOn()` and `buildSummary()` patterns.
- **IMPORTS**: `import { InvalidArgumentError } from "../errors.js";` and doctor types.
- **GOTCHA**: Keep helpers pure and immutable; return new arrays and objects.
- **VALIDATE**: Unit tests in Task 5.1 must cover invalid threshold, default threshold, `none`, and
  deterministic sorting by severity, category, service, then id.

### Task 1.3: Create Text Formatter Contract — Depends on [none]

- **BATCH**: B1
- **ACTION**: Create `packages/rfapps-cli/src/lib/doctor/formatters.ts`.
- **IMPLEMENT**: Add `formatDoctorText(result: DoctorResult): string[]` or
  `displayDoctorResult(result): void`. Prefer returning lines for testability, then let the action
  write lines to stderr. Group by severity, then category, then service, and include evidence and
  suggested next command when present.
- **MIRROR**: `actions/lint.ts` `displayFindingsForGroup()` and `actions/plan.ts` `displayPlan()`
  stderr/color style.
- **IMPORTS**: `colors` from `@rfmedia/common`, doctor types.
- **GOTCHA**: Do not write JSON here; machine formats are handled by `formatOutput()`.
- **VALIDATE**: Formatter tests must assert stable grouping and no stdout writes.

### Task 2.1: Implement Config and Security Checker — Depends on [1.1, 1.2]

- **BATCH**: B2
- **ACTION**: Add config/security checker functions in
  `packages/rfapps-cli/src/lib/doctor/checkers.ts`.
- **IMPLEMENT**: Implement `runConfigDoctorCheck(context)` that calls `getComposeConfig()`, casts to
  `LintComposeConfig`, reads `context.config.lint?.ignore ?? []`, calls `evaluateLint()`, and maps
  each `LintFinding` to a `DoctorFinding`. Use stable ids such as `config.${ruleId}`. Map
  `privileged-enabled` to `critical`, lint `error` to `error`, lint `warn` to `warn`, and lint
  `info` to `info`. Suggested command: `rfapps lint -s <service>` or `rfapps lint`.
- **MIRROR**: `actions/lint.ts` compose config load, `evaluateLint()` call, and runtime drift
  mapping pattern.
- **IMPORTS**: `getComposeConfig` from `../docker.js`, `evaluateLint` from `../lint.js`,
  `type LintComposeConfig`, `type LintFinding`.
- **GOTCHA**: `getComposeConfig()` returns a narrow compose type; cast through `unknown` before
  `LintComposeConfig`, as lint already does.
- **VALIDATE**: Tests must cover no findings, ignored findings, missing compose config, and severity
  mapping.

### Task 2.2: Implement Runtime Status and Readiness Checker — Depends on [1.1, 1.2]

- **BATCH**: B2
- **ACTION**: Add runtime checker functions in `packages/rfapps-cli/src/lib/doctor/checkers.ts`.
- **IMPLEMENT**: Implement `runRuntimeDoctorCheck(context)` using `getServiceStatusMap()` with
  `cacheTtlMs: 0`, `forceRefresh: true`, and preloaded service scope when available. Create findings
  for `unhealthy` (`error`), `dead`/`restarting` (`error`), `exited` or `created` for targeted
  services (`warn`), and readiness failures from `waitForDependencyReadiness()` in snapshot mode
  (`waitForReady: false`). Preserve readiness `signalAvailability` on the check result.
- **MIRROR**: `actions/health.ts` readiness summary mapping and `lib/service-status.ts` status map
  helper.
- **IMPORTS**: `getServiceStatusMap` from `../service-status.js`, `waitForDependencyReadiness` from
  `../health.js`, doctor and health types.
- **GOTCHA**: Runtime telemetry can be unavailable. Record a warning/skipped check rather than
  failing the whole command when Docker signals are incomplete.
- **VALIDATE**: Tests must cover healthy status, unhealthy status, missing telemetry, and dependency
  pending/failed mapping.

### Task 2.3: Implement Update Freshness Checker — Depends on [1.1, 1.2]

- **BATCH**: B2
- **ACTION**: Add update checker functions in `packages/rfapps-cli/src/lib/doctor/checkers.ts`.
- **IMPLEMENT**: Implement `runUpdateDoctorCheck(context)`. If `checkUpdates` is false, return a
  skipped check with reason `registry update checks require --check-updates`. If true, call
  `generatePlan({ composePath, services, profiles, checkUpdates: true }, envTool)` and map services
  with `image.updateAvailable === true` to `warn` findings with suggested command
  `rfapps plan -s <service> --check-updates`.
- **MIRROR**: `actions/plan.ts` passes `checkUpdates` into `generatePlan()` and handles `undefined`
  as an operational failure.
- **IMPORTS**: `generatePlan` from `../plan-generator.js`, `DockerCommandError` only if the checker
  needs a typed failure for formatting.
- **GOTCHA**: Do not call `savePlan()` and do not expose plan ids. Doctor is diagnostic.
- **VALIDATE**: Tests must assert skipped-by-default behavior, update findings when opt-in, and
  failed check when plan generation returns `undefined`.

### Task 2.4: Implement State Health Checker — Depends on [1.1, 1.2]

- **BATCH**: B2
- **ACTION**: Add state checker functions in `packages/rfapps-cli/src/lib/doctor/checkers.ts`.
- **IMPLEMENT**: Implement `runStateDoctorCheck(context)` that respects
  `context.config.state.enabled === false` by returning skipped. Otherwise initialize the database,
  query bounded recent history for targeted services or all services, and emit findings for recent
  failed deployments (`warn`) and empty history for targeted services (`info`). Always close the DB
  in `finally`.
- **MIRROR**: `lib/db.ts` initialization/close pattern and `lib/state-queries.ts` read-only
  parameterized query style.
- **IMPORTS**: `initializeDatabase`, `closeDatabase`, `getDeploymentHistory`, `getDeploymentCount`
  from existing libs, plus state types.
- **GOTCHA**: Initializing the DB may create state directories/files in current behavior. To
  preserve doctor read-only semantics, first check whether a configured/default DB file exists using
  existing helpers if available; if not, record skipped `state database not found` instead of
  creating it. If the current public helper cannot avoid creation, add a narrow read-only helper in
  `lib/db.ts` in a later task or keep state checker skipped when absent.
- **VALIDATE**: Tests must cover disabled state, missing state DB, recent failed deployment, and DB
  close on thrown query.

### Task 3.1: Build Doctor Checker Registry and Aggregator — Depends on [2.1, 2.2, 2.3, 2.4]

- **BATCH**: B3
- **ACTION**: Complete `packages/rfapps-cli/src/lib/doctor/checkers.ts` and create
  `packages/rfapps-cli/src/lib/doctor/index.ts`.
- **IMPLEMENT**: Add a typed `DOCTOR_CHECKERS` registry of checker functions and
  `runDoctorChecks(context): Promise<{ checks: DoctorCheckResult[]; findings: DoctorFinding[]; warnings: string[]; }>`
  that runs checks sequentially for deterministic output. Catch checker-local errors into failed
  check entries and error findings without aborting unrelated checks.
- **MIRROR**: `actions/lint.ts` maps runtime findings into a result without mixing output rendering
  into lib logic.
- **IMPORTS**: doctor types and helpers from `./severity.js`.
- **GOTCHA**: Sequential execution is intentional here despite parallel implementation planning;
  bounded deterministic output matters more than checker concurrency in v1.
- **VALIDATE**: Tests must assert all check ids are present, skipped update check appears by
  default, and a checker failure does not drop findings from successful checks.

### Task 3.2: Implement Doctor Action — Depends on [3.1, 1.3]

- **BATCH**: B3
- **ACTION**: Create `packages/rfapps-cli/src/actions/doctor.ts`.
- **IMPLEMENT**: Normalize `RawDoctorOptions` into `DoctorOptions`; parse `--fail-on`; load config;
  apply compose/env/profile/no-sidecars overrides; resolve services with
  `resolveServicesWithInteractive()`; build `DoctorScope`; run checkers; build sorted findings and
  summary; emit with `formatOutput()` for non-text formats or `formatDoctorText()` for text; set
  `process.exitCode = 1` when threshold is met.
- **MIRROR**: `actions/health.ts` and `actions/lint.ts` orchestration and output dispatch.
- **IMPORTS**: `logDebug`, `formatError`, `outputFormattedError`, `formatOutput`, config/service
  helpers, `getEnvToolExecConfig`, doctor helpers and types.
- **GOTCHA**: Honor global `--output`; `--json` is handled globally, but command-local
  `json?: boolean` should still force JSON if added by Commander. Avoid double-emitting.
- **VALIDATE**: Action tests must verify text output, JSON output, cancellation return, invalid
  threshold, checker failures, and default critical threshold.

### Task 3.3: Re-export Doctor Types and Helpers — Depends on [1.1, 3.1]

- **BATCH**: B3
- **ACTION**: Update `packages/rfapps-cli/src/types/index.ts` and, only if needed,
  `packages/rfapps-cli/src/lib/index.ts`.
- **IMPLEMENT**: Re-export all doctor types from `./doctor.js`. For lib exports, prefer direct
  imports in `actions/doctor.ts`; if tests or future callers benefit, export `runDoctorChecks`,
  `formatDoctorText`, and severity helpers from `lib/index.ts`.
- **MIRROR**: Existing `types/index.ts` categories and `lib/index.ts` lint/health exports.
- **IMPORTS**: No new imports should be needed in type barrel.
- **GOTCHA**: Avoid broad `export *` from a folder if it creates unclear public surface.
- **VALIDATE**: `npm run typecheck -w packages/rfapps-cli`.

### Task 4.1: Add Doctor Command Module — Depends on [3.2]

- **BATCH**: B4
- **ACTION**: Create `packages/rfapps-cli/src/commands/doctor.ts`.
- **IMPLEMENT**: Export `registerDoctorCommand(program: Command): void`. Register
  `.command("doctor")`, description, service targeting flags, `--no-sidecars`, `--check-updates`,
  `--fail-on <severity>` defaulting to `critical`, `-f/--compose`, `-e/--env-file`, `-p/--profile`,
  and help text explaining read-only behavior and exit threshold. Lazy-import `../actions/doctor.js`
  inside `.action()`.
- **MIRROR**: `commands/init.ts` dedicated command module shape and `cli.ts` inline command option
  descriptions.
- **IMPORTS**: `import type { Command } from "commander";`
- **GOTCHA**: Do not duplicate global options in the subcommand; globals stay on `program`.
- **VALIDATE**: `npm run rfapps -- doctor --help` after implementation should show the command.

### Task 4.2: Register Doctor in CLI — Depends on [4.1]

- **BATCH**: B4
- **ACTION**: Update `packages/rfapps-cli/src/cli.ts`.
- **IMPLEMENT**: Add `import { registerDoctorCommand } from "./commands/doctor.js";` near other
  local imports. Call `registerDoctorCommand(program);` near adjacent diagnostic commands,
  preferably after `lint` or before `completion`, without changing existing command behavior.
- **MIRROR**: Dedicated command-module decision from the feature spec and existing ESM import style.
- **IMPORTS**: `registerDoctorCommand` with `.js` suffix.
- **GOTCHA**: Do not leave an inline duplicate `doctor` registration in `cli.ts`.
- **VALIDATE**: `npm run rfapps -- --help` should list `doctor`.

### Task 4.3: Update Shell Completion Generation — Depends on [4.1]

- **BATCH**: B4
- **ACTION**: Update `packages/rfapps-cli/src/actions/completion.ts`.
- **IMPLEMENT**: Add `doctor` to bash command lists and command detection cases. Add
  `local doctor_opts="--service --services --group --no-sidecars --check-updates --fail-on --compose --env-file --profile"`.
  Add `--fail-on` value completion for `none info warn error critical`, file completion for
  compose/env flags, and service/group/profile completion. Add zsh command entry and `doctor)`
  branch. Add fish command entry and option lines.
- **MIRROR**: Existing `lint` and `plan` completion patterns.
- **IMPORTS**: None.
- **GOTCHA**: Bash `-s` must continue to mean `--shell` only for the `completion` command; for
  doctor it should complete services like other service-targeted commands.
- **VALIDATE**: Completion tests in Task 5.4 must cover bash, zsh, and fish.

### Task 4.4: Add Focused Feature Documentation — Depends on [3.2]

- **BATCH**: B4
- **ACTION**: Create `docs/features/rfapps-doctor-command.md`.
- **IMPLEMENT**: Document purpose, read-only guarantees, default checks, opt-in `--check-updates`,
  supported target flags, JSON schema overview, severity taxonomy, `--fail-on` behavior, suggested
  next commands, and examples for human and JSON output.
- **MIRROR**: `docs/features/deployment-history.md`, `docs/features/output-formats.md`, and
  `docs/features/shell-completion.md` documentation style.
- **IMPORTS**: N/A.
- **GOTCHA**: Do not promise auto-fix or checker category include/exclude flags.
- **VALIDATE**: `npm run lint:md -- docs/features/rfapps-doctor-command.md` if supported; otherwise
  run `npm run lint:md`.

### Task 5.1: Add Doctor Lib Unit Tests — Depends on [3.1, 1.3]

- **BATCH**: B5
- **ACTION**: Create `packages/rfapps-cli/src/lib/doctor/severity.spec.ts`,
  `packages/rfapps-cli/src/lib/doctor/checkers.spec.ts`, and
  `packages/rfapps-cli/src/lib/doctor/formatters.spec.ts`.
- **IMPLEMENT**: Test threshold parsing, invalid threshold errors, severity sorting, summary counts,
  lint finding mapping, runtime status mapping, update skipped/opt-in behavior, state checker
  skipped/missing/failure behavior, checker failure isolation, and text grouping.
- **MIRROR**: `lib/plan-generator.spec.ts`, `lib/lint.spec.ts`, and `actions/lint.spec.ts`
  mock/assertion patterns.
- **IMPORTS**: Vitest imports and direct checker/helper imports.
- **GOTCHA**: Avoid `any` in mocks. Use `unknown as Type` only when mocking third-party shapes that
  are intentionally partial.
- **VALIDATE**:
  `npm run test:run -w packages/rfapps-cli -- src/lib/doctor/severity.spec.ts src/lib/doctor/checkers.spec.ts src/lib/doctor/formatters.spec.ts`.

### Task 5.2: Add Doctor Action Tests — Depends on [3.2, 4.1]

- **BATCH**: B5
- **ACTION**: Create `packages/rfapps-cli/src/actions/doctor.spec.ts`.
- **IMPLEMENT**: Mock config loading, service resolution, doctor check runner, formatter, and
  `formatOutput()`. Test text output path, JSON/global output path, `--json` alias path if
  command-local option exists, cancelled interactive resolution, invalid `--fail-on`, default
  critical threshold, `--fail-on warn`, update opt-in, and checker failure result handling.
- **MIRROR**: `actions/plan.spec.ts` and `actions/lint.spec.ts`.
- **IMPORTS**: Vitest, `@rfmedia/common` mocked, `executeDoctor`.
- **GOTCHA**: Restore `process.exitCode` and console spies in `afterEach()`.
- **VALIDATE**: `npm run test:run -w packages/rfapps-cli -- src/actions/doctor.spec.ts`.

### Task 5.3: Update Documentation Surfaces — Depends on [4.4]

- **BATCH**: B5
- **ACTION**: Update `packages/rfapps-cli/README.md`, `docs/features/quick-reference.md`,
  `docs/features/output-formats.md`, `docs/features/json-output.md`, and
  `docs/features/shell-completion.md`.
- **IMPLEMENT**: Add doctor to README key features and command reference; add examples for
  `rfapps doctor`, `rfapps doctor -g media-stack`, `rfapps doctor --check-updates`,
  `rfapps doctor --json`, and `rfapps doctor --fail-on warn`; document exit codes and threshold
  semantics. Add quick reference monitoring examples. Add JSON/output docs with
  `schemaVersion: "doctor.v1"`. Add shell completion docs showing doctor flags.
- **MIRROR**: Existing README `lint`, `plan`, and `health` sections.
- **IMPORTS**: N/A.
- **GOTCHA**: Keep examples read-only and avoid suggesting destructive commands as the first
  remediation.
- **VALIDATE**: `npm run lint:md`.

### Task 5.4: Update Completion Tests — Depends on [4.3]

- **BATCH**: B5
- **ACTION**: Update `packages/rfapps-cli/src/actions/completion.spec.ts`.
- **IMPLEMENT**: Add an `it.each(["bash", "zsh", "fish"] as const)` test that generated scripts
  contain `doctor`, `check-updates`, `fail-on`, and `critical`. Add shell-specific assertions: bash
  has `local doctor_opts`, zsh has a `doctor)` branch with `__rfapps_get_services`, and fish has
  `__fish_seen_subcommand_from doctor` service, group, profile, `check-updates`, and `fail-on`
  completions.
- **MIRROR**: Existing lint completion and service-completion tests.
- **IMPORTS**: None beyond existing test imports.
- **GOTCHA**: Existing command-list tests may need expected command lists updated to include doctor.
- **VALIDATE**: `npm run test:run -w packages/rfapps-cli -- src/actions/completion.spec.ts`.

### Task 6.1: Run Full Validation and Polish — Depends on [5.1, 5.2, 5.3, 5.4]

- **BATCH**: B6
- **ACTION**: Run validation commands and make any focused fixes.
- **IMPLEMENT**: Run the static, targeted test, full rfapps test, build, and markdown validation
  commands listed below. Fix only issues introduced by this feature. Confirm no secrets or mutating
  doctor behavior were added.
- **MIRROR**: Repository validation workflow in root `package.json` and
  `packages/rfapps-cli/package.json`.
- **IMPORTS**: N/A.
- **GOTCHA**: Do not commit changes. Do not run docker mutation commands as validation.
- **VALIDATE**: All commands in the Validation Commands section pass or have documented
  environment-only failures.

---

## Testing Strategy

### Unit Tests

| Test                                  | Input                                | Expected Output                                           | Edge Case? |
| ------------------------------------- | ------------------------------------ | --------------------------------------------------------- | ---------- |
| `parseDoctorFailOn` default           | `undefined`                          | `critical`                                                | Yes        |
| `parseDoctorFailOn` invalid           | `"bad"`                              | throws `InvalidArgumentError`                             | Yes        |
| `shouldFailDoctor` none               | error finding + `none`               | false                                                     | Yes        |
| `sortDoctorFindings`                  | mixed services/severities/categories | stable severity/category/service/id order                 | No         |
| `buildDoctorSummary`                  | mixed findings                       | counts by severity/category/service                       | No         |
| Config checker                        | lint error finding                   | doctor finding with mapped severity and suggested command | No         |
| Runtime checker                       | service unhealthy                    | `runtime.unhealthy` error finding                         | No         |
| Runtime checker telemetry unavailable | missing Docker signal                | warning/skipped check, no hard failure                    | Yes        |
| Update checker default                | `checkUpdates: false`                | skipped check, no registry call                           | Yes        |
| Update checker opt-in                 | update available plan                | warn finding with plan suggestion                         | No         |
| State checker disabled                | `state.enabled: false`               | skipped check                                             | Yes        |
| State checker missing DB              | absent state db                      | skipped check, no DB creation                             | Yes        |
| Formatter                             | mixed findings                       | grouped summary and findings lines                        | No         |
| Action JSON output                    | `output: "json"`                     | calls `formatOutput("json", DoctorResult)`                | No         |
| Action threshold                      | critical finding + default           | `process.exitCode = 1`                                    | No         |
| Action low severity default           | warn finding + default               | success exit                                              | Yes        |
| Completion generation                 | bash/zsh/fish                        | doctor command and flags included                         | No         |

### Edge Cases Checklist

- [ ] No findings returns success with empty findings and zeroed summary.
- [ ] No targeted services means all services, matching existing command behavior.
- [ ] Targeted service with sidecar expands unless `--no-sidecars` is passed.
- [ ] Invalid profile is ignored the same way existing commands currently apply overrides.
- [ ] Missing Docker or compose config produces a failed check/finding without masking other checks.
- [ ] Registry lookup is skipped unless `--check-updates` is explicitly passed.
- [ ] State DB missing or disabled does not create or mutate state.
- [ ] JSON output remains stable and stdout-clean.
- [ ] Suggested commands never include destructive flags by default.
- [ ] Secret-looking environment values are not included in evidence.

---

## Validation Commands

### Static Analysis

```bash
npm run typecheck -w packages/rfapps-cli
```

EXPECT: Zero TypeScript errors.

### Targeted Unit Tests

```bash
npm run test:run -w packages/rfapps-cli -- src/lib/doctor/severity.spec.ts src/lib/doctor/checkers.spec.ts src/lib/doctor/formatters.spec.ts src/actions/doctor.spec.ts src/actions/completion.spec.ts
```

EXPECT: Doctor and completion tests pass.

### Full rfapps Test Suite

```bash
npm run test:run -w packages/rfapps-cli
```

EXPECT: No rfapps-cli regressions.

### Build

```bash
npm run build:rfapps
```

EXPECT: `rf-common` and `rfapps-cli` build successfully.

### Markdown Lint

```bash
npm run lint:md
```

EXPECT: Documentation changes pass markdownlint.

### Full Repository Check

```bash
npm run lint
```

EXPECT: Typecheck and markdown lint pass.

### Manual CLI Smoke

```bash
npm run rfapps -- doctor --help
npm run rfapps -- doctor --json --no-sidecars
npm run rfapps -- doctor --fail-on warn --no-sidecars
```

EXPECT: Help includes doctor flags; JSON output has `schemaVersion: "doctor.v1"`; threshold exit
behavior matches findings. If Docker is unavailable in the environment, document that runtime checks
were not smoke-tested.

---

## Acceptance Criteria

- [ ] `rfapps doctor` is registered and visible in `rfapps --help`.
- [ ] `packages/rfapps-cli/src/commands/doctor.ts` defines the command and lazy-imports
      `actions/doctor.ts`.
- [ ] `doctor` supports `-s`, `--services`, `-g`, `--no-sidecars`, `-f`, `-e`, `-p`,
      `--check-updates`, and `--fail-on <severity>`.
- [ ] Doctor is read-only by default and does not save plans, mutate Docker resources, write
      compose/config files, or write deployment state.
- [ ] Default diagnostics run without registry access.
- [ ] Registry image freshness findings run only with `--check-updates`.
- [ ] Human output groups findings by severity, category, and affected service.
- [ ] JSON output is versioned with `schemaVersion: "doctor.v1"` and stable top-level fields.
- [ ] Findings include stable ids, severity, category, optional service, evidence, message, and
      suggested next command.
- [ ] Default `--fail-on` behavior exits non-zero only for critical findings.
- [ ] `--fail-on none|info|warn|error|critical` works deterministically.
- [ ] Bash, zsh, and fish completions include the `doctor` command and doctor flags.
- [ ] README and relevant docs cover usage, JSON output, completion, and read-only guarantees.
- [ ] Vitest tests cover helper logic, checker mapping, action behavior, and completions.
- [ ] All validation commands pass or environment-only failures are documented.

## Completion Checklist

- [ ] Code follows command/action separation.
- [ ] TypeScript imports include `.js` suffixes.
- [ ] No `any` types are introduced.
- [ ] Checkers return new objects/arrays and avoid mutation of inputs.
- [ ] Errors are handled explicitly and surfaced as formatted errors or failed checks.
- [ ] Machine output uses `formatOutput()` and stays stdout-clean.
- [ ] Human output uses stderr.
- [ ] State checker does not create a state DB when none exists.
- [ ] Suggested commands are read-only or require explicit operator action.
- [ ] Shell completions updated for bash, zsh, and fish.
- [ ] Documentation updated in README and feature docs.
- [ ] Tests added for new behavior and edge cases.
- [ ] No unrelated refactors or metadata churn.

## Risks

| Risk                                                                        | Likelihood | Impact | Mitigation                                                                                            |
| --------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------- |
| Doctor duplicates logic from `plan`, `status`, `health`, `lint`, or `drift` | Medium     | High   | Map existing helper outputs into doctor findings; do not re-implement lower-level checks.             |
| State checker accidentally creates or mutates SQLite state                  | Medium     | High   | Check DB existence before initialization or add a read-only DB open helper; test missing DB behavior. |
| JSON schema becomes too rigid too early                                     | Medium     | Medium | Version schema as `doctor.v1`; use extensible arrays for checks, findings, evidence, and warnings.    |
| Registry checks slow default command                                        | Medium     | Medium | Keep update checker skipped unless `--check-updates` is passed.                                       |
| Suggested commands become stale or unsafe                                   | Low        | Medium | Suggest existing read-only diagnostics first; cover key suggestions in tests.                         |
| Completion generator misses one shell                                       | Medium     | Low    | Add shell-specific assertions for bash, zsh, and fish.                                                |
| Threshold semantics differ from lint                                        | Medium     | Medium | Centralize doctor severity ranking and threshold parsing in `lib/doctor/severity.ts`.                 |

## Notes

- Execution mode for this plan is parallel-capable: 6 batches, 18 tasks, max width 4.
- Worktree mode is disabled by request; do not add `## Worktree Setup` or per-task worktree
  annotations during implementation.
- External research was intentionally skipped because no new external APIs, SDKs, or dependencies
  are needed.
- Confidence score: 8/10. The architecture is well supported by existing patterns; the main
  uncertainty is the safest read-only path for state DB inspection without creating a new DB file.
