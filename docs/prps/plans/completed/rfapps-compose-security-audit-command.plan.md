# Plan: Compose Security Audit Command (`rfapps audit`)

## Summary

Add a dedicated `rfapps audit` command that evaluates resolved Docker Compose configuration for
container security posture risks. The implementation should reuse the existing rfapps
command/action/type split, resolved compose helpers, service targeting conventions, machine-output
formatter path, and doctor diagnostic integration while keeping the command read-only and
advisory-only.

## User Story

As an operator of the `rfapps` compose stack, I want a dedicated read-only `rfapps audit` command
that evaluates resolved Docker Compose security posture, so that I can identify risky privileges,
host access, and missing resource guardrails before deployment or recurring maintenance.

## Problem -> Solution

Today security-relevant gaps are split across lint-style production-readiness checks and broader
doctor diagnostics, making security posture hard to answer directly. -> `rfapps audit` provides a
dedicated read-only security posture audit over resolved compose configuration with severity/service
findings, stable machine output, existing targeting conventions, and shared doctor integration.

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A
- **Source Spec**: `docs/prps/specs/rfapps-compose-security-audit-command.spec.md`
- **PRD Phase**: standalone
- **Estimated Files**: 20
- **Research Dispatch**: Enhanced parallel sub-agents
- **Worktree Mode**: Disabled via `--no-worktree`

## Batches

Tasks grouped by dependency for parallel execution. Tasks within the same batch run concurrently;
batches run in order.

| Batch | Tasks         | Depends On | Parallel Width |
| ----- | ------------- | ---------- | -------------- |
| B1    | 1.1, 1.2      | -          | 2              |
| B2    | 2.1, 2.2, 2.3 | B1         | 3              |
| B3    | 3.1, 3.2, 3.3 | B2         | 3              |
| B4    | 4.1, 4.2, 4.3 | B3         | 3              |
| B5    | 5.1, 5.2, 5.3 | B4         | 3              |
| B6    | 6.1, 6.2      | B5         | 2              |

- **Total tasks**: 16
- **Total batches**: 6
- **Max parallel width**: 3

---

## UX Design

### Before

- `rfapps doctor` is the read-only diagnostic surface for config, security, runtime, updates, and
  state.
- `rfapps lint` is the resolved-compose production-readiness path for restart, health, logs,
  resource limits, and hardening hints.
- Security-specific findings are not available through a dedicated operator command; doctor
  currently maps only selected lint findings into security.

### After

- `rfapps audit` is a dedicated read-only command for compose security posture.
- Human output groups audit findings by severity and affected service.
- Machine output exposes a versioned `audit.v1` result with stable rule IDs, severity, service,
  bounded evidence, remediation, summary, and scope.
- `rfapps doctor` consumes the shared audit engine under its security category.

### Interaction Changes

| Touchpoint           | Before                                                                                 | After                                                                                          | Notes                                   |
| -------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- | ---- | ---- | ----- | --------- |
| CLI command surface  | Security posture is split across `doctor` and `lint`                                   | Adds `rfapps audit`                                                                            | Dedicated security mental model         |
| Audit scope          | Production-readiness and security hardening are mixed in lint                          | Audit focuses on root users, capabilities, socket mounts, host networking, and resource limits | Do not replace lint                     |
| Compose resolution   | Lint/doctor use resolved compose config                                                | Audit uses the same resolved config path                                                       | Findings reflect resolved profiles/env  |
| Service targeting    | Doctor/lint support `-s`, `--services`, `-g`, `--no-sidecars`, `-f`, `-e`, `-p`        | Audit reuses the same flags                                                                    | Preserve familiar behavior              |
| Human output         | Lint groups recommended vs optional hardening; doctor groups severity/category/service | Audit groups by severity and service                                                           | Highest-risk services should be obvious |
| Machine output       | Existing `--json` / `--output` formats exist for diagnostics                           | Audit adds stable `audit.v1` schema                                                            | CI-facing UX                            |
| Exit behavior        | Doctor and lint have `--fail-on` threshold patterns                                    | Audit supports threshold-based failure                                                         | Use `none                               | info | warn | error | critical` |
| Remediation behavior | Lint prints remediation hints                                                          | Audit prints remediation hints only                                                            | No compose writes or container mutation |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                                            | Lines           | Why                                                                                   |
| -------------- | --------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| P0 (critical)  | `docs/prps/specs/rfapps-compose-security-audit-command.spec.md` | all             | Source requirements, scope boundaries, and open questions                             |
| P0 (critical)  | `packages/rfapps-cli/src/commands/doctor.ts`                    | all             | Dedicated command module and lazy action import pattern                               |
| P0 (critical)  | `packages/rfapps-cli/src/actions/doctor.ts`                     | 56-166          | Config loading, targeting, result construction, threshold exit, and output dispatch   |
| P0 (critical)  | `packages/rfapps-cli/src/actions/lint.ts`                       | 391-455         | Resolved compose config access, compose failure handling, and formatter/exit behavior |
| P0 (critical)  | `packages/rfapps-cli/src/lib/lint.ts`                           | 1-143, 266-329  | Pure rule catalog/evaluator pattern for resolved compose config                       |
| P0 (critical)  | `packages/rfapps-cli/src/lib/doctor/checkers.ts`                | 67-101, 347-389 | Current doctor security mapping and checker registry/failure isolation                |
| P1 (important) | `packages/rfapps-cli/src/types/doctor.ts`                       | all             | Versioned diagnostic schema and severity/category contracts                           |
| P1 (important) | `packages/rfapps-cli/src/types/lint.ts`                         | 69-130, 224-259 | Finding/result contracts and existing compose service fields                          |
| P1 (important) | `packages/rfapps-cli/src/lib/docker.ts`                         | 722-761         | `getComposeConfig()` resolved compose JSON helper                                     |
| P1 (important) | `packages/rfapps-cli/src/lib/interactive-selection.ts`          | 95-180          | Shared service/group/sidecar/profile targeting behavior                               |
| P1 (important) | `packages/rfapps-cli/src/lib/config.ts`                         | 495-530         | CLI compose/env/profile override resolution                                           |
| P1 (important) | `packages/rfapps-cli/src/lib/formatters/index.ts`               | 68-98           | Shared machine-output dispatch                                                        |
| P2 (reference) | `packages/rfapps-cli/src/actions/completion.ts`                 | 40-101          | Completion command and option lists                                                   |
| P2 (reference) | `packages/rfapps-cli/src/lib/lint-context.ts`                   | 58-120          | Existing hardening/context helper predicates                                          |
| P2 (reference) | `packages/rfapps-cli/src/lib/lint.spec.ts`                      | 12-107, 421-449 | Pure engine fixture, rule, sorting, and summary tests                                 |
| P2 (reference) | `packages/rfapps-cli/src/actions/doctor.spec.ts`                | 82-168          | Action output and threshold test pattern                                              |
| P2 (reference) | `packages/rfapps-cli/src/actions/completion.spec.ts`            | 103-180         | Command completion test pattern                                                       |

## External Documentation

| Topic                           | Source                                                                             | Key Takeaway                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Compose `config`         | <https://docs.docker.com/reference/cli/docker/compose/config/>                     | `docker compose config` parses, resolves, and renders the actual model; use existing helper rather than parsing raw YAML               |
| Docker Compose CLI options      | <https://docs.docker.com/reference/cli/docker/compose/>                            | `--env-file`, `-f`, and `--profile` are Compose options already modeled by rfapps overrides                                            |
| Compose service security fields | <https://compose-spec.github.io/compose-spec/05-services.html>                     | Relevant resolved keys include `user`, `privileged`, `cap_add`, `cap_drop`, `network_mode`, `security_opt`, `read_only`, and `volumes` |
| Compose `network_mode`          | <https://compose-spec.github.io/compose-spec/05-services.html#network_mode>        | `network_mode: host` gives raw host network access; `network_mode` and `networks` are mutually exclusive                               |
| Compose resource limits         | <https://compose-spec.github.io/compose-spec/deploy.html#resources>                | `deploy.resources.limits` supports `cpus`, `memory`, and `pids`; define exact v1 audit semantics                                       |
| Node.js `child_process.spawn`   | <https://nodejs.org/api/child_process.html#child_processspawncommand-args-options> | `spawn(command, args)` runs without a shell by default; do not introduce shell-string execution                                        |
| Commander command/options API   | <https://raw.githubusercontent.com/tj/commander.js/master/Readme.md>               | `.command()` defines subcommands and `.option()` maps kebab-case flags into camelCase options                                          |

---

## Patterns to Mirror

Code patterns discovered in the codebase. Follow these exactly.

### NAMING_CONVENTION

```ts
// SOURCE: packages/rfapps-cli/src/commands/doctor.ts:3-6
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run read-only diagnostics across runtime, config, updates, and state")
```

```ts
// SOURCE: packages/rfapps-cli/src/actions/doctor.ts:28-56
interface RawDoctorOptions {
  service?: string;
  services?: string;
  group?: string;
}
```

```ts
// SOURCE: packages/rfapps-cli/src/types/doctor.ts:15-19
export const DOCTOR_SCHEMA_VERSION = "doctor.v1" as const;
export type DoctorSeverity = "critical" | "error" | "warn" | "info";
export type DoctorFailOn = DoctorSeverity | "none";
export type DoctorCategory = "config" | "security" | "runtime" | "updates" | "state";
```

### ERROR_HANDLING

```ts
// SOURCE: packages/rfapps-cli/src/actions/doctor.ts:93-97
if (options.profile !== undefined && !isValidProfile(options.profile, config)) {
  throw new InvalidArgumentError("--profile", options.profile, "Invalid profile", [
    ...config.profiles.validProfiles,
  ]);
```

```ts
// SOURCE: packages/rfapps-cli/src/actions/lint.ts:396-406
const error = new DockerCommandError("config", "Failed to get compose config", 1);
```

```ts
// SOURCE: packages/rfapps-cli/src/lib/state-storage.ts:36-46
const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /password/i,
  /secret/i,
  /key$/i,
```

### LOGGING_PATTERN

```ts
// SOURCE: packages/rfapps-cli/src/actions/doctor.ts:91-91
logDebug(`Doctor options: ${JSON.stringify(options)}`);
```

```ts
// SOURCE: packages/rfapps-cli/src/actions/doctor.ts:158-165
if (options.output !== "text") {
  await formatOutput(options.output ?? "json", result);
  return;
}
```

### REPOSITORY_PATTERN

```ts
// SOURCE: packages/rfapps-cli/src/lib/docker.ts:722-741
export async function getComposeConfig(
  composePath: string,
  options?: { profiles?: string[]; envTool?: EnvToolExecConfig },
): Promise<{ services: Record<string, ComposeServiceConfig> } | undefined> {
```

```ts
// SOURCE: packages/rfapps-cli/src/lib/interactive-selection.ts:95-180
export async function resolveServicesWithInteractive(
  rawOptions: ResolveOptions,
  config: RfappsConfig,
  composePath: string,
```

### SERVICE_PATTERN

```ts
// SOURCE: packages/rfapps-cli/src/actions/doctor.ts:69-89
const envTool = getEnvToolExecConfig(globalOptions);
const failOn = parseDoctorFailOn(rawOptions.failOn);
const options: DoctorOptions = {
  dryRun: globalOptions.dryRun ?? false,
```

```ts
// SOURCE: packages/rfapps-cli/src/lib/lint.ts:63-74
export const LINT_RULES: EvaluableLintRule[] = [
  {
    id: "privileged-enabled",
    severity: "error",
```

```ts
// SOURCE: packages/rfapps-cli/src/lib/doctor/checkers.ts:347-389
export const DOCTOR_CHECKERS: readonly DoctorChecker[] = [
  runConfigDoctorCheck,
  runRuntimeDoctorCheck,
  runUpdatesDoctorCheck,
```

### TEST_STRUCTURE

```ts
// SOURCE: packages/rfapps-cli/vitest.config.ts:3-12
test: {
  globals: true,
  environment: "node",
  include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
}
```

```ts
// SOURCE: packages/rfapps-cli/src/lib/lint.spec.ts:12-33
function compliantService(): LintComposeService {
  return {
    restart: "unless-stopped",
```

```ts
// SOURCE: packages/rfapps-cli/src/actions/doctor.spec.ts:56-80
let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});
```

---

## Files to Change

| File                                                  | Action | Justification                                                                                           |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/commands/audit.ts`           | CREATE | Dedicated command should mirror `commands/doctor.ts` for options, help text, and lazy action import     |
| `packages/rfapps-cli/src/cli.ts`                      | UPDATE | Import and call `registerAuditCommand(program)` with other split command modules                        |
| `packages/rfapps-cli/src/actions/audit.ts`            | CREATE | Orchestrate config loading, targeting, compose resolution, engine execution, output, and exit threshold |
| `packages/rfapps-cli/src/lib/security-audit.ts`       | CREATE | Pure security rule catalog and evaluator for resolved compose services                                  |
| `packages/rfapps-cli/src/types/audit.ts`              | CREATE | Versioned `audit.v1` schema, severities, rule IDs, findings, results, and options                       |
| `packages/rfapps-cli/src/lib/index.ts`                | UPDATE | Export audit engine helpers through the internal lib barrel                                             |
| `packages/rfapps-cli/src/types/index.ts`              | UPDATE | Export audit schema constants and public audit types                                                    |
| `packages/rfapps-cli/src/lib/doctor/checkers.ts`      | UPDATE | Consume shared audit findings under the existing doctor security category                               |
| `packages/rfapps-cli/src/lib/doctor/index.ts`         | UPDATE | Export any new doctor checker helper if introduced for audit integration                                |
| `packages/rfapps-cli/src/lib/exit-codes.ts`           | UPDATE | Add centralized audit fail-threshold exit helper if not kept inside `security-audit.ts`                 |
| `packages/rfapps-cli/src/actions/completion.ts`       | UPDATE | Add audit command and per-command option completions                                                    |
| `packages/rfapps-cli/src/lib/security-audit.spec.ts`  | CREATE | Cover pure audit rules, sorting, summaries, target filtering, and evidence bounds                       |
| `packages/rfapps-cli/src/actions/audit.spec.ts`       | CREATE | Cover action flow, output dispatch, compose failures, target cancellation, and fail thresholds          |
| `packages/rfapps-cli/src/lib/doctor/checkers.spec.ts` | UPDATE | Assert doctor consumes shared audit-derived security findings                                           |
| `packages/rfapps-cli/src/actions/completion.spec.ts`  | UPDATE | Assert audit appears in shell completions with flags and threshold values                               |
| `packages/rfapps-cli/README.md`                       | UPDATE | Add command usage, options, examples, JSON schema, and exit behavior                                    |
| `README.md`                                           | UPDATE | Surface `rfapps audit` in the root CLI command list                                                     |
| `docs/features/rfapps-audit-command.md`               | CREATE | Feature documentation for audit usage, schema, and known limitations                                    |
| `docs/features/quick-reference.md`                    | UPDATE | Add audit to operator diagnostics quick reference                                                       |
| `docs/features/shell-completion.md`                   | UPDATE | Document audit shell completion support                                                                 |
| `docs/features/json-output.md`                        | UPDATE | Document stable `audit.v1` machine output                                                               |
| `docs/features/output-formats.md`                     | UPDATE | Document audit support for global output formats if implemented                                         |

## NOT Building

- No generic policy/plugin framework or base-class hierarchy for audit rules.
- No raw YAML source-location tracing for v1; resolved compose JSON does not carry source metadata.
- No runtime container inspection, registry checks, image freshness, drift, health, or state-history
  diagnostics.
- No auto-remediation, compose edits, plan saves, state writes, or container lifecycle commands.
- No SARIF/code-scanning output in v1; lint already owns `--sarif`.
- No new Docker SDK, HTTP client, or API wrapper; use existing Docker Compose CLI helpers.
- No audit-specific suppression DSL until intentional-exception noise is observed and a follow-up
  scope is approved.
- No MCP tool exposure for audit in this plan; lint and doctor are not exposed through MCP today.

---

## Step-by-Step Tasks

### Task 1.1: Define Audit Contracts - Depends on none

- **BATCH**: B1
- **ACTION**: Create `packages/rfapps-cli/src/types/audit.ts`.
- **IMPLEMENT**: Define `AUDIT_SCHEMA_VERSION = "audit.v1"`, `AuditSeverity`, `AuditFailOn`,
  `AuditCategory`, stable `AuditRuleId` values, `AuditFinding`, `AuditSummary`, `AuditScope`,
  `AuditResult`, `AuditOptions`, and minimal resolved-compose service/config types. Reuse severity
  names compatible with doctor: `critical`, `error`, `warn`, `info`, plus `none` for thresholds.
- **MIRROR**: `types/doctor.ts` schema/version pattern and `types/lint.ts` compose service fields.
- **IMPORTS**: `OutputFormat`, `GlobalOptions`, `ServiceTargetOptions`, `ComposeOptions`, and
  `EnvToolExecConfig` types as needed.
- **GOTCHA**: Keep evidence bounded to strings and do not model raw resolved service objects in
  public output.
- **VALIDATE**: `npm run typecheck -w packages/rfapps-cli` should recognize the new type module
  without `any`.

### Task 1.2: Document Scope Boundaries Early - Depends on none

- **BATCH**: B1
- **ACTION**: Draft the new feature doc skeleton at `docs/features/rfapps-audit-command.md`.
- **IMPLEMENT**: Capture the read-only, resolved-config, advisory-only, no-runtime-inspection scope
  before code details drift. Include a short note that doctor aggregates audit findings and lint
  remains the production-readiness/SARIF command.
- **MIRROR**: Existing feature docs such as `docs/features/rfapps-doctor-command.md` and command
  docs in `packages/rfapps-cli/README.md`.
- **IMPORTS**: None.
- **GOTCHA**: Do not document suppressions or SARIF as v1 behavior.
- **VALIDATE**: `npm run lint:md` should not report markdown structure issues after later docs are
  complete.

### Task 2.1: Build Pure Security Audit Engine - Depends on 1.1

- **BATCH**: B2
- **ACTION**: Create `packages/rfapps-cli/src/lib/security-audit.ts`.
- **IMPLEMENT**: Implement a declarative rule catalog and `evaluateSecurityAudit(config, targets)`
  over resolved compose services. Cover root-equivalent users, privileged mode, capability risks,
  Docker socket mounts, host networking, and missing memory/CPU resource limits with deterministic
  ordering and summary counts.
- **MIRROR**: `lib/lint.ts` rule catalog and `evaluateLint()` pure evaluator.
- **IMPORTS**: Audit types from `../types/audit.js` and `InvalidArgumentError` if target validation
  is handled in the engine.
- **GOTCHA**: Treat missing `user`, empty `user`, `root`, `0`, `0:0`, and UID prefix `0:` as
  root-equivalent, but keep messaging clear that omitted `user` is compose-level evidence only.
- **VALIDATE**: Add temporary compile coverage via `npm run typecheck -w packages/rfapps-cli` once
  imports are wired.

### Task 2.2: Add Audit Summary, Sorting, and Threshold Helpers - Depends on 1.1

- **BATCH**: B2
- **ACTION**: Add helper functions for audit summary construction, severity comparison, sorting, and
  fail-threshold parsing.
- **IMPLEMENT**: Support `none|info|warn|error|critical` and sort findings by severity rank,
  category/rule, then service for deterministic output. Keep helpers in `security-audit.ts` unless
  the implementation needs a shared exit-code helper in `lib/exit-codes.ts`.
- **MIRROR**: `lib/doctor/severity.ts` and `lib/exit-codes.ts` lint threshold pattern.
- **IMPORTS**: `InvalidArgumentError` for bad fail-on values.
- **GOTCHA**: Do not call `process.exit()`; return booleans or set `process.exitCode` from the
  action.
- **VALIDATE**: Unit tests should prove each threshold value and severity rank behavior.

### Task 2.3: Add Audit Text Formatter - Depends on 1.1

- **BATCH**: B2
- **ACTION**: Implement text formatting for audit findings.
- **IMPLEMENT**: Add a formatter in `security-audit.ts` or a focused submodule that renders a
  compact header, summary counts, and findings grouped by severity then service. Keep machine
  formats on the `formatOutput()` path and text output on stderr.
- **MIRROR**: `lib/doctor/formatters.ts` grouping pattern and `actions/lint.ts` human output style.
- **IMPORTS**: `colors` from `@rfmedia/common` only if colorized output is needed.
- **GOTCHA**: Evidence must not include raw env values or full resolved compose service JSON.
- **VALIDATE**: Formatter tests should mock colors as passthrough and assert grouping order.

### Task 3.1: Implement Audit Action - Depends on 2.1, 2.2, 2.3

- **BATCH**: B3
- **ACTION**: Create `packages/rfapps-cli/src/actions/audit.ts`.
- **IMPLEMENT**: Normalize raw/global options, get env tool config, parse `--fail-on`, load config,
  validate profile, apply CLI overrides, resolve services, call `getComposeConfig()`, evaluate audit
  findings, build `AuditResult`, set exit threshold, and dispatch text or machine output. Convert
  compose resolution failure into the same formatted error style used by lint.
- **MIRROR**: `actions/doctor.ts` action flow and `actions/lint.ts` compose resolution handling.
- **IMPORTS**: `formatOutput`, `loadConfig`, `applyCliOverrides`, `resolveServicesWithInteractive`,
  `isValidProfile`, `getComposeConfig`, audit helpers, `getEnvToolExecConfig`, and error classes.
- **GOTCHA**: `--json` and global `--output` precedence must match existing commands.
- **VALIDATE**: `npm run typecheck -w packages/rfapps-cli` should pass after command registration is
  wired.

### Task 3.2: Register Audit Command - Depends on 3.1

- **BATCH**: B3
- **ACTION**: Create `packages/rfapps-cli/src/commands/audit.ts` and update
  `packages/rfapps-cli/src/cli.ts`.
- **IMPLEMENT**: Add `registerAuditCommand(program)` with service targeting, compose/env/profile,
  `--fail-on`, and help text that calls out read-only advisory behavior. Import and invoke the
  registrar from `cli.ts` next to `registerDoctorCommand(program)`.
- **MIRROR**: `commands/doctor.ts` and `cli.ts` dedicated command registration.
- **IMPORTS**: `Command` type from `commander` in the command module.
- **GOTCHA**: Use lazy import `../actions/audit.js` and keep ESM `.js` extensions.
- **VALIDATE**: `npm run rfapps -- audit --help` should show the new command after implementation.

### Task 3.3: Export Audit APIs - Depends on 2.1, 2.2, 2.3

- **BATCH**: B3
- **ACTION**: Update `packages/rfapps-cli/src/lib/index.ts` and
  `packages/rfapps-cli/src/types/index.ts`.
- **IMPLEMENT**: Export the audit engine, formatter/summary/severity helpers needed by the action
  and doctor integration. Export `AUDIT_SCHEMA_VERSION` and public audit types with the same barrel
  style used for lint and doctor.
- **MIRROR**: `lib/index.ts` lint/doctor export blocks and `types/index.ts` lint/doctor type
  exports.
- **IMPORTS**: None beyond export statements.
- **GOTCHA**: Avoid exporting internal rule predicate helpers unless tests or doctor integration
  require them.
- **VALIDATE**: Typecheck should catch any missing barrel exports used by actions/tests.

### Task 4.1: Integrate Audit Findings into Doctor - Depends on 3.3

- **BATCH**: B4
- **ACTION**: Update `packages/rfapps-cli/src/lib/doctor/checkers.ts`.
- **IMPLEMENT**: Replace or narrow the current lint-to-security mapping so doctor consumes shared
  audit findings under category `security`. Map audit findings into `DoctorFinding` with stable IDs,
  severity, service, message, evidence, and suggested next command where useful.
- **MIRROR**: Existing `runConfigDoctorCheck()` mapping and `DOCTOR_CHECKERS` registry/failure
  isolation.
- **IMPORTS**: Audit engine/types from the lib/type barrels or direct modules.
- **GOTCHA**: Do not duplicate independent security rule logic in doctor; the rule catalog must live
  in one place.
- **VALIDATE**: Existing doctor tests plus new audit-security doctor tests should pass.

### Task 4.2: Update Shell Completions - Depends on 3.2

- **BATCH**: B4
- **ACTION**: Update `packages/rfapps-cli/src/actions/completion.ts`.
- **IMPLEMENT**: Add `audit` to command lists and add audit-specific option completions for
  service/group/profile/compose/env, `--json`, and `--fail-on`. Include threshold values
  `none info warn error critical` wherever doctor/lint threshold completions are provided.
- **MIRROR**: `completion.ts` lint and doctor option lists.
- **IMPORTS**: None.
- **GOTCHA**: Keep bash, zsh, and fish output in sync.
- **VALIDATE**: Completion tests should assert command presence and options for all shells.

### Task 4.3: Add Pure Engine Tests - Depends on 2.1, 2.2, 2.3

- **BATCH**: B4
- **ACTION**: Create `packages/rfapps-cli/src/lib/security-audit.spec.ts`.
- **IMPLEMENT**: Add local fixture builders for compliant services and targeted risky services.
  Cover root-equivalent users, privileged mode, cap additions, weak/missing cap drops, Docker socket
  mounts in short and long volume syntax, host networking, missing memory/CPU limits, target
  filtering, deterministic sorting, bounded evidence, and summary counts.
- **MIRROR**: `lib/lint.spec.ts` fixture, `it.each`, and summary/sorting test style.
- **IMPORTS**: Vitest helpers and audit engine/types.
- **GOTCHA**: Include known intentional compose patterns such as `network_mode: service:*` and
  `cap_add: NET_ADMIN` as review findings rather than treating every host-access-like field
  identically.
- **VALIDATE**: `npm run test:run -w packages/rfapps-cli -- src/lib/security-audit.spec.ts` should
  pass.

### Task 5.1: Add Audit Action Tests - Depends on 3.1, 3.2, 3.3

- **BATCH**: B5
- **ACTION**: Create `packages/rfapps-cli/src/actions/audit.spec.ts`.
- **IMPLEMENT**: Mock config, compose, targeting, formatters, and audit engine helpers. Cover text
  output, JSON/global output dispatch, bad `--fail-on`, invalid profile, compose config failure,
  interactive cancellation, threshold exit behavior, and no lifecycle/state/remediation calls.
- **MIRROR**: `actions/doctor.spec.ts` and `actions/lint.spec.ts` action mocking patterns.
- **IMPORTS**: Vitest helpers and mocked modules.
- **GOTCHA**: Preserve and restore `process.exitCode` and console spies in each test.
- **VALIDATE**: `npm run test:run -w packages/rfapps-cli -- src/actions/audit.spec.ts` should pass.

### Task 5.2: Update Doctor and Completion Tests - Depends on 4.1, 4.2

- **BATCH**: B5
- **ACTION**: Update `packages/rfapps-cli/src/lib/doctor/checkers.spec.ts` and
  `packages/rfapps-cli/src/actions/completion.spec.ts`.
- **IMPLEMENT**: Add assertions that doctor security findings come from the shared audit engine and
  that checker failures remain isolated. Add completion assertions that `audit` appears and exposes
  targeting/profile/fail-on options in generated scripts.
- **MIRROR**: Existing doctor checker mapping tests and completion command tests.
- **IMPORTS**: Existing test imports and mocks only.
- **GOTCHA**: Keep lint config diagnostics working; audit integration should not remove non-security
  config findings from doctor.
- **VALIDATE**:
  `npm run test:run -w packages/rfapps-cli -- src/lib/doctor/checkers.spec.ts src/actions/completion.spec.ts`
  should pass.

### Task 5.3: Update CLI Documentation - Depends on 3.2, 4.1, 4.2

- **BATCH**: B5
- **ACTION**: Update `packages/rfapps-cli/README.md`, `README.md`, and
  `docs/features/rfapps-audit-command.md`.
- **IMPLEMENT**: Document audit usage, options, examples, read-only behavior, doctor relationship,
  machine output, and exit thresholds. Keep audit as security posture, lint as production-readiness,
  and doctor as aggregator.
- **MIRROR**: Existing doctor and lint README sections and `docs/features/rfapps-doctor-command.md`
  structure.
- **IMPORTS**: None.
- **GOTCHA**: Do not promise suppressions, SARIF, runtime inspection, or remediation.
- **VALIDATE**: `npm run lint:md` should pass after all docs are updated.

### Task 6.1: Update Output and Completion Docs - Depends on 5.3

- **BATCH**: B6
- **ACTION**: Update `docs/features/quick-reference.md`, `docs/features/shell-completion.md`,
  `docs/features/json-output.md`, and `docs/features/output-formats.md`.
- **IMPLEMENT**: Add audit to diagnostics quick reference, shell completion docs, `audit.v1` JSON
  examples, and global output format examples if the action supports all machine formats through
  `formatOutput()`. Keep examples stdout-clean and avoid raw resolved config dumps.
- **MIRROR**: Existing doctor entries in those docs.
- **IMPORTS**: None.
- **GOTCHA**: If implementation only supports text/json, do not document YAML/CSV/table until
  confirmed.
- **VALIDATE**: `npm run lint:md` should pass.

### Task 6.2: Run Full Validation and Smoke Checks - Depends on 5.1, 5.2, 6.1

- **BATCH**: B6
- **ACTION**: Run focused tests, typecheck, build, lint, and CLI smoke commands.
- **IMPLEMENT**: Validate the new command from the workspace root and package workspace. Include
  smoke checks for `rfapps audit --help`, JSON output, targeted service output, and invalid argument
  handling.
- **MIRROR**: Existing package scripts in root `package.json` and
  `packages/rfapps-cli/package.json`.
- **IMPORTS**: None.
- **GOTCHA**: The compose command may require env files/secrets in real smoke runs; use safe
  fixtures or commands that do not expose secrets.
- **VALIDATE**: All validation commands in the section below should pass or have documented
  environment blockers.

---

## Testing Strategy

### Unit Tests

| Test                | Input                                                   | Expected Output                                               | Edge Case? |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------- | ---------- | ----- | --------- | -------------------------------- | --- |
| Root user rule      | `user` missing, empty, `root`, `0`, `0:0`, `0:1000`     | Root-equivalent findings with bounded evidence                | Yes        |
| Non-root user rule  | `${PUID}:${PGID}`, `1000:1000`, `node`                  | No root-equivalent finding                                    | Yes        |
| Privileged rule     | `privileged: true`                                      | Critical or error finding with service and evidence           | No         |
| Capability rule     | `cap_add: [NET_ADMIN]`, missing/weak `cap_drop`         | Capability findings in deterministic order                    | Yes        |
| Docker socket mount | Short and long volume syntax for `/var/run/docker.sock` | Socket mount finding without raw env values                   | Yes        |
| Host networking     | `network_mode: host`                                    | Host networking finding                                       | No         |
| Service networking  | `network_mode: service:traefik-ts`                      | Contextual finding or no host finding per chosen v1 semantics | Yes        |
| Resource limits     | Missing memory/cpu limits                               | Resource guardrail finding                                    | Yes        |
| Target filtering    | `targets = ["plex"]`                                    | Only target service findings                                  | Yes        |
| Sorting             | Mixed services/severities/rules                         | Stable severity/service/rule ordering                         | Yes        |
| Thresholds          | `--fail-on none                                         | info                                                          | warn       | error | critical` | Non-zero only at/above threshold | Yes |
| Output secrecy      | Resolved config with env values                         | Findings exclude raw env values                               | Yes        |

### Edge Cases Checklist

- [ ] Empty compose services object
- [ ] Missing targeted service
- [ ] Invalid `--profile`
- [ ] Invalid `--fail-on`
- [ ] Docker Compose config command failure
- [ ] Docker Compose outputs tool-wrapper noise before JSON
- [ ] Short syntax and long-form volumes
- [ ] `network_mode: host` vs `network_mode: service:*`
- [ ] Env-tool interpolation is passed through existing helper but not printed
- [ ] JSON/YAML/CSV/table output stays stdout-clean if supported
- [ ] Human output stays on stderr
- [ ] Doctor checker failure isolation still works

---

## Validation Commands

### Static Analysis

```bash
npm run typecheck -w packages/rfapps-cli
```

EXPECT: Zero type errors in the rfapps workspace.

### Focused Unit Tests

```bash
npm run test:run -w packages/rfapps-cli -- src/lib/security-audit.spec.ts src/actions/audit.spec.ts src/lib/doctor/checkers.spec.ts src/actions/completion.spec.ts
```

EXPECT: Audit engine, action, doctor integration, and completion tests pass.

### Full rfapps Test Suite

```bash
npm run test:run -w packages/rfapps-cli
```

EXPECT: No rfapps CLI regressions.

### Build Validation

```bash
npm run build:rfapps
```

EXPECT: `rf-common` and `rfapps-cli` build successfully.

### Repository Lint

```bash
npm run lint
```

EXPECT: Typecheck and markdown lint pass.

### CLI Smoke Validation

```bash
npm run rfapps -- audit --help
npm run rfapps -- audit --json --fail-on none
npm run rfapps -- audit -s traefik --fail-on none
npm run rfapps -- audit --fail-on invalid
```

EXPECT: Help renders, JSON is stdout-clean, targeted service resolution works, and invalid threshold
reports a usage error without running audit evaluation.

### Manual Validation

- [ ] Confirm audit command is read-only by checking it only calls config/compose helpers and pure
      evaluation code.
- [ ] Confirm no raw environment values appear in text or machine output.
- [ ] Confirm doctor security output includes audit-derived findings.
- [ ] Confirm docs explain audit vs lint vs doctor responsibilities.
- [ ] Confirm shell completions include audit options for bash, zsh, and fish.

---

## Acceptance Criteria

- [ ] `rfapps audit` is registered as a dedicated CLI command and help exposes targeting,
      compose/env/profile overrides, machine output, and configurable fail behavior.
- [ ] Audit execution is read-only: it does not write compose/config files, mutate containers, save
      plans, or create deployment history.
- [ ] Audit evaluates resolved Docker Compose config output, not raw YAML, including profiles and
      environment-tool interpolation used by existing compose resolution.
- [ ] Audit reuses existing `-s`, `--services`, `-g`, `--no-sidecars`, `-f`, `-e`, and `-p` behavior
      for service resolution, sidecar expansion, profile detection, and config overrides.
- [ ] Audit emits findings for root users, privileged containers, Linux capability risks, Docker
      socket mounts, host networking, and missing resource limits when those patterns appear in
      resolved services.
- [ ] Every audit finding includes a stable rule identifier, severity, affected service, human
      message, evidence, and remediation guidance.
- [ ] Human audit output groups findings by severity and affected service so the highest-risk
      services are visible without JSON processing.
- [ ] Machine audit output is stable and versioned, with deterministic finding order and summary
      counts suitable for CI comparisons.
- [ ] `--fail-on` supports `none`, `info`, `warn`, `error`, and `critical`, and sets a non-zero exit
      code only when findings meet or exceed the selected threshold.
- [ ] `rfapps doctor` consumes or summarizes shared audit security findings under its existing
      `security` category without duplicating security rule logic.
- [ ] Audit output does not include raw environment variable values from resolved compose config.
- [ ] Docker socket mount detection covers both short syntax and long-form volume syntax.

## Completion Checklist

- [ ] Code follows discovered command/action/lib/type patterns.
- [ ] Error handling matches `InvalidArgumentError` and `DockerCommandError` conventions.
- [ ] Logging/output follows stdout-clean machine output and stderr human output.
- [ ] Tests follow co-located Vitest patterns.
- [ ] No hardcoded secrets or raw env values in findings.
- [ ] No unnecessary runtime dependencies or Docker SDK added.
- [ ] Documentation updated for command usage, JSON output, output formats, shell completion, and
      quick reference.
- [ ] `audit.v1` schema is distinct from `doctor.v1` and lint result shapes.
- [ ] Fixtures cover explicit root users, missing `user`, `${PUID}:${PGID}`, `user: "0"`, and
      `user: "0:0"`.
- [ ] Fixtures cover Docker socket mounts, `network_mode: host`, `network_mode: service:*`,
      `cap_add: NET_ADMIN`, and missing resource limits.
- [ ] Root-cwd CLI smoke commands are run because prior doctor smoke found workspace-cwd config
      lookup differences.
- [ ] Self-contained plan remains aligned with issue #145 and the source spec.

## Risks

| Risk                                                                                   | Likelihood | Impact | Mitigation                                                                               |
| -------------------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------- |
| Audit duplicates existing lint hardening checks                                        | Medium     | Medium | Define audit as security posture and share helpers where overlap exists                  |
| Resolved compose output may include interpolated secrets                               | Medium     | High   | Evidence should report field paths, booleans, service names, and mount targets only      |
| Root-user findings may be noisy because omitted `user` is not definitive runtime proof | Medium     | Medium | Phrase as compose-level risk and cover explicit/missing cases in tests                   |
| Resource limit semantics are ambiguous                                                 | Medium     | Medium | Pin v1 rule IDs and fixtures to memory and CPU limit behavior                            |
| Intentional host-access patterns create advisory noise                                 | High       | Medium | Separate high-confidence risks from contextual review findings                           |
| Doctor and audit severity models drift apart                                           | Medium     | High   | Use a shared audit engine and explicit mapping tests                                     |
| Machine output stability is undermined by non-deterministic ordering                   | Medium     | Medium | Test deterministic sorting separately from timestamp freshness                           |
| Command overlap confuses users                                                         | High       | Medium | Docs must describe audit as security, lint as production-readiness, doctor as aggregator |

## Notes

- No external HTTP API, pagination, rate-limit, or SDK initialization is needed. The external
  surface is Docker Compose CLI/spec behavior plus Node process execution through existing helpers.
- The plan intentionally uses resolved compose config, so source-file line attribution is out of
  scope for v1.
- If implementation discovers audit suppressions are necessary, defer them to a follow-up issue
  rather than expanding this first-pass command.
- Confidence score: 8/10. The main uncertainty is exact severity assignment for contextual findings
  such as missing `user`, `cap_add: NET_ADMIN`, and `network_mode: service:*`; the plan mitigates
  that with explicit fixtures and docs language.
