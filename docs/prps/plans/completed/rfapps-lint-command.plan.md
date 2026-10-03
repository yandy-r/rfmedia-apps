# Plan: Production-Readiness Lint Command (`rfapps lint`)

## Summary

Add a `rfapps lint` command to `packages/rfapps-cli` that statically evaluates the resolved Docker
Compose config (compose.yml + extensions + env) against a declarative catalog of
production-readiness rules — resource limits, health checks, log rotation, restart policy, and
security knobs — and emits severity-tagged findings with remediation hints. Default mode is
daemon-free and CI-friendly; an opt-in `--runtime` mode reuses `lib/drift.ts` to report drift
against live containers. Output is a grouped table by default, with `--json` and `--sarif` (SARIF
2.1.0) for tooling, and a `--fail-on` threshold that maps findings to existing `ExitCode` constants
for CI gating.

## User Story

As an operator (and CI pipeline) deploying the 47-service compose stack, I want a fast, daemon-free
`rfapps lint` command that flags production-readiness gaps with severity and remediation hints, so
that misconfigurations are caught at author/CI time before they surface as runtime incidents (OOM
kills, runaway logs, silent restarts).

## Problem → Solution

Operators have no preflight way to catch production-readiness gaps in the resolved compose config,
so misconfigurations surface only as runtime incidents → `rfapps lint` statically analyzes the
resolved compose config per service, returns severity-tagged findings with remediation hints in
table/JSON/SARIF, and resolves a `--fail-on` exit code as a deterministic, daemon-free CI preflight
gate.

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A
- **Source Spec**: `docs/prps/specs/rfapps-lint-command.spec.md`
- **PRD Phase**: N/A
- **Estimated Files**: 13 (5 create source, 4 update source, 3 create tests, 1 update test) + docs

## Batches

Tasks grouped by dependency for parallel execution. Tasks within the same batch run concurrently;
batches run in order.

| Batch | Tasks                   | Depends On | Parallel Width |
| ----- | ----------------------- | ---------- | -------------- |
| B1    | 1.1, 1.2                | —          | 2              |
| B2    | 2.1, 2.2, 2.3, 2.4, 2.5 | B1         | 5              |
| B3    | 3.1, 3.2                | B2         | 2              |
| B4    | 4.1, 4.2, 4.3, 4.4      | B3         | 4              |
| B5    | 5.1                     | B4         | 1              |

- **Total tasks**: 14
- **Total batches**: 5
- **Max parallel width**: 5

> No two tasks in the same batch modify the same file. Cross-cutting type/config foundations are in
> B1; the lib layer in B2; orchestration + barrels in B3; CLI wiring + tests in B4; docs in B5.

---

## UX Design

### Before

- No `lint` verb exists in `src/cli.ts:193-548` (status, health, deploy, plan, drift, …).
- Closest diagnostics read **runtime** state only: `status` parses `docker ps`
  (`src/actions/status.ts:382-446`); `health` does dependency/TCP readiness
  (`src/actions/health.ts:43-211`). Neither flags a compose service that _lacks_ a healthcheck,
  restart policy, resource limits, or security knob.
- Operators discover gaps today by manual inspection of 47 services in `compose.yml`, or by runtime
  incidents.

### After

Default grouped table (service → severity → finding + hint), rendered to stderr in the existing
`status`/`health` style (`colors.*` from `rf-common/src/logger.ts:199-209`):

```
Production Readiness Lint
  Services: 47 | error 0 | warn 8 | info 31

  sonarr
    warn  healthcheck-missing      no healthcheck defined   -> add a healthcheck: block
    info  resource-limits-missing  no mem/cpu limits        -> set deploy.resources.limits
  slskd
    info  cap-drop-missing         no dropped capabilities  -> add cap_drop: [ALL]
```

- `--json` → stable findings JSON to stdout (logs suppressed via `isMachineFormat`).
- `--sarif` → SARIF 2.1.0 log to stdout for GitHub code scanning.
- `--list-rules` → prints rule catalog (`id | default severity | rationale`); no scan.

### Interaction Changes

| Touchpoint         | Before  | After                                          | Notes                                          |
| ------------------ | ------- | ---------------------------------------------- | ---------------------------------------------- |
| `rfapps lint`      | absent  | new command + `src/actions/lint.ts`            | inline registration, lazy import (`cli.ts`)    |
| `-s/--services/-g` | n/a     | scope to service / list / group / all          | mirror `drift detect` flags (`cli.ts:399-405`) |
| `--runtime`        | n/a     | also compare live container drift              | opt-in; only path needing the Docker socket    |
| `--json`           | n/a     | findings JSON to stdout                        | lint-local flag → `formatOutput("json", …)`    |
| `--sarif`          | absent  | SARIF 2.1.0 to stdout                          | NET-NEW serializer (`lib/lint-sarif.ts`)       |
| `--fail-on <sev>`  | absent  | exit-code threshold: `none\|info\|warn\|error` | default `error`; invalid → `UsageError` (2)    |
| `--list-rules`     | absent  | print catalog, skip scan, exit 0               | table style, no compose read                   |
| exit codes         | per-cmd | 0 clean / 1 findings≥threshold / 2 usage error | reuse `ExitCode` (`exit-codes.ts:3-8`)         |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                              | Lines                   | Why                                                                                              |
| -------------- | ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| P0 (critical)  | `packages/rfapps-cli/src/actions/drift.ts`        | 350-465                 | Closest action analog: envTool, loadConfig, target resolution, format dispatch, exit code        |
| P0 (critical)  | `packages/rfapps-cli/src/lib/drift.ts`            | 25-39, 540-622          | Pure engine + `getComposeConfig` sourcing + runtime inspect to reuse for `--runtime`             |
| P0 (critical)  | `packages/rfapps-cli/src/lib/docker.ts`           | 699-769                 | `getComposeConfig` (resolved config source) + narrow `ComposeServiceConfig` (must widen locally) |
| P0 (critical)  | `packages/rfapps-cli/src/lib/exit-codes.ts`       | 1-40                    | `ExitCode` + `resolveDeployExitCode`/`setDeployExitCode` to mirror for lint                      |
| P1 (important) | `packages/rfapps-cli/src/cli.ts`                  | 64-68, 110-115, 377-460 | Choices `Option`, preAction validation, `drift` registration block to mirror                     |
| P1 (important) | `packages/rfapps-cli/src/types/drift.ts`          | 1-90                    | Discriminated-union + `XOptions`/`XResult`/`XSummary` shape to mirror in `types/lint.ts`         |
| P1 (important) | `packages/rfapps-cli/src/types/config.ts`         | 103-143                 | `RfappsConfig`/`PartialRfappsConfig` to extend with `lint.ignore`                                |
| P1 (important) | `packages/rfapps-cli/src/lib/config.ts`           | 109-114, 120, 167       | YAML load + `mergeConfig`/`partialToFull` plumbing (mirror `parallel` block)                     |
| P1 (important) | `packages/rfapps-cli/src/lib/validation.ts`       | 119-157                 | YAML boundary validation + `findClosestMatch`/`ServiceNotFoundError` for suppression refs        |
| P1 (important) | `packages/rfapps-cli/src/actions/history.ts`      | 109-139                 | Frozen `as const` tuple + normalize + `InvalidArgumentError` (mirror for `--fail-on`)            |
| P2 (reference) | `packages/rfapps-cli/src/lib/formatters/index.ts` | 46-98                   | `formatOutput` dispatch + `withFormatOutputCapture` for tests                                    |
| P2 (reference) | `packages/rfapps-cli/src/actions/status.ts`       | 195-211, 382-446        | Grouped/colorized text-render style + severity→color precedent                                   |
| P2 (reference) | `packages/rfapps-cli/src/lib/validation.spec.ts`  | 1-55                    | Vitest `vi.hoisted`/`vi.mock`/partial-mock `@rfmedia/common` test pattern                        |
| P2 (reference) | `compose.yml`                                     | 36-69                   | Merge anchors (`&service-base`, `&logging-default`, `&common-env`) — rules read RESOLVED values  |

## External Documentation

| Topic                    | Source                                                                                                                                               | Key Takeaway                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SARIF 2.1.0 minimal log  | [OASIS sarif-v2.1.0 Appendix K](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)                                                    | `{ $schema, version:"2.1.0", runs:[{ tool.driver.{name,rules[]}, results[] }] }`; one run per tool                                                                  |
| Result required fields   | [GitHub SARIF support](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)        | Each result: `ruleId`, `message.text` (non-empty), `locations[]`; level ∈ `note\|warning\|error`                                                                    |
| Severity → level mapping | same                                                                                                                                                 | error→`error`, warn→`warning`, info→`note`; per-result `level` overrides rule `defaultConfiguration.level`                                                          |
| Location/region          | same                                                                                                                                                 | `artifactLocation.uri` (relative, `uriBaseId` `%SRCROOT%`) + `region.startLine`; compose has no real line → emit synthetic region (startLine 1) per service finding |
| Compose security keys    | [Compose deploy spec](https://docs.docker.com/reference/compose-file/deploy/) / [services](https://docs.docker.com/reference/compose-file/services/) | Correct anchors: `security_opt`, `cap_drop`, `read_only`, `user`, `deploy.resources.limits`, `logging.options`                                                      |

> GAP: No SARIF library in any `package.json`. Hand-build the SARIF object in `lib/lint-sarif.ts`
> (single-run, `results[]` with ruleId/level/message/location). Do NOT add a dependency.
> `yaml@^2.7.0` is already present; no new YAML/Docker lib needed.

---

## Patterns to Mirror

Code patterns discovered in the codebase. Follow these exactly.

### NAMING_CONVENTION

```ts
// SOURCE: src/types/drift.ts:12-17  (string-literal unions, no TS enums)
export type DriftCategory = "image" | "environment" | "ports" | "volumes" | "networks";
export type DriftDirection = "compose_ahead" | "container_ahead" | "diverged";
// SOURCE: src/lib/exit-codes.ts:3-10  (as const object + derived value type)
export const ExitCode = {
  Success: 0,
  OperationalError: 1,
  UsageError: 2,
  PartialSuccess: 3,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
```

Files: kebab-case `.ts` (`exit-codes.ts`, `lint-sarif.ts`). Types: PascalCase interfaces, JSDoc per
field. Functions: camelCase verb-first (`evaluateLint`, `resolveLintExitCode`). ESM `.js` import
suffix; `import type` for type-only.

### ERROR_HANDLING

```ts
// SOURCE: src/cli.ts:110-114  (frozen-tuple option validation in preAction)
if (!isValidOutputFormat(resolvedOutput)) {
  throw new InvalidArgumentError("--output", String(resolvedOutput), "Invalid output format", [...OUTPUT_FORMATS]);
}
// SOURCE: src/lib/validation.ts:119-134  (YAML boundary parse, no interpolation, typed error)
const parsed = YAML.parse(content) as ComposeFile;
if (parsed.services === undefined) {
  /* throw */
}
```

`--fail-on` and suppression severities validate against a frozen `as const` tuple (mirror
`history.ts:109-139`): normalize (`toLowerCase().trim()`), reject unknown with
`InvalidArgumentError` carrying `validValues`. Per-rule evaluation NEVER throws — bad input fails
fast at boundaries; rule predicates return `LintFinding[]`.

### LOGGING_PATTERN

```ts
// SOURCE: src/actions/drift.ts:10-22 / status.ts:388-397
const format = globalOptions.output ?? "text";
if (format !== "text") {
  await formatOutput(format, result);
  return;
}
// human render to stderr via colors.bold / colors.red / colors.yellow
```

### REPOSITORY_PATTERN

```ts
// SOURCE: src/lib/drift.ts:546-555  (resolved compose config source; cast to richer local type)
const composeConfig = await getComposeConfig(options.composePath, { profiles, envTool });
const fullConfig = composeConfig as unknown as ComposeConfig; // narrow ComposeServiceConfig is insufficient
// SOURCE: src/lib/drift.ts:557-587  (--runtime inspection to reuse)
const serviceContainerMap = await getRunningServiceContainerMap(...);
const containerInspects = await inspectContainers(containerNames);
```

### SERVICE_PATTERN

```ts
// SOURCE: src/actions/drift.ts:383-414  (action orchestration: load → override → resolve targets)
const config = await loadConfig();
const finalConfig = applyCliOverrides(config, { composePath, envFile, profile, noSidecars });
const resolved = await resolveServicesWithInteractive(
  { service, services, group, noSidecars, yes },
  finalConfig,
  finalConfig.composePath,
  process.cwd(),
  { envTool },
);
if (resolved === null) return; // user cancelled
```

### TEST_STRUCTURE

```ts
// SOURCE: src/lib/validation.spec.ts:5-28  (co-located *.spec.ts, hoisted mocks, partial-mock common)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const mockFs = vi.hoisted(() => ({ readFile: vi.fn(), stat: vi.fn() }));
vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return { ...actual, ...mockLogger };
});
// beforeEach(() => { vi.clearAllMocks(); });  // clearAllMocks, NOT resetAllMocks
```

---

## Files to Change

| File                                               | Action | Justification                                                                                       |
| -------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/types/lint.ts`            | CREATE | `LintSeverity`, `LintRule`, `LintFinding`, `LintResult`, `LintOptions`, richer `LintComposeService` |
| `packages/rfapps-cli/src/types/config.ts`          | UPDATE | Add `lint?: { ignore?: LintIgnoreEntry[] }` to `RfappsConfig` + `PartialRfappsConfig`               |
| `packages/rfapps-cli/src/lib/lint.ts`              | CREATE | Declarative rule catalog + pure `evaluateLint(config, targets, ignore)`                             |
| `packages/rfapps-cli/src/lib/lint-sarif.ts`        | CREATE | SARIF 2.1.0 serializer (`LintResult` → SARIF log); ~500-line cap, SRP                               |
| `packages/rfapps-cli/src/lib/exit-codes.ts`        | UPDATE | Add `resolveLintExitCode(result, failOn)` + `setLintExitCode`                                       |
| `packages/rfapps-cli/src/lib/config.ts`            | UPDATE | Thread `lint` through `mergeConfig` + `partialToFull` (mirror `parallel`)                           |
| `packages/rfapps-cli/src/types/index.ts`           | UPDATE | Re-export `./lint.js` types                                                                         |
| `packages/rfapps-cli/src/actions/lint.ts`          | CREATE | Orchestration: targets, optional `--runtime` drift, formatter, exit code, `--list-rules`            |
| `packages/rfapps-cli/src/lib/index.ts`             | UPDATE | Re-export `evaluateLint`, `LINT_RULES`, SARIF serializer                                            |
| `packages/rfapps-cli/src/cli.ts`                   | UPDATE | Register `lint` inline (after drift block) with flags + lazy action import                          |
| `packages/rfapps-cli/src/lib/lint.spec.ts`         | CREATE | Vitest: each rule pass/fail, suppression, determinism, anchor-resolved fixtures                     |
| `packages/rfapps-cli/src/actions/lint.spec.ts`     | CREATE | Vitest: target resolution, formatter selection, exit codes, `--runtime`, `--list-rules`             |
| `packages/rfapps-cli/src/lib/exit-codes.spec.ts`   | UPDATE | Add `resolveLintExitCode` ladder cases (incl. `none`, empty findings)                               |
| `packages/rfapps-cli/README.md` + root `CLAUDE.md` | UPDATE | Document command, flags, exit codes, `.rfapps.yaml lint.ignore`, plex exemption                     |

## NOT Building

- **No custom-rule plugin / dynamic rule loading** — rule-of-three; one consumer. Static in-code
  `LINT_RULES` array suffices.
- **No auto-fix / `--fix`** — lint is read-only analysis; mutating compose.yml is the plan/apply +
  `drift import` concern, not this command.
- **No full SARIF tooling** — only single-run `results[]` with ruleId/level/message/location. No
  taxonomies, code-flows, suppressions, multi-run, or artifact embedding.
- **No new global `OutputFormat` member for SARIF** — `OUTPUT_FORMATS`
  (`rf-common/src/output.ts:23`) stays `json|yaml|csv|table|text`. SARIF is a lint-local flag +
  serializer.
- **No extension of `DriftCategory`** — `--runtime` maps drift into `LintFinding` within the lint
  layer; the `drift` command contract stays stable.
- **No new exit codes** — reuse `ExitCode`; `--fail-on` maps to Success/OperationalError/UsageError.
- **No registry/network calls** — never queries image registries (unlike `plan --check-updates`).
- **No rule-result caching / parallel rule executor** — synchronous pure predicates over one
  in-memory config object.

---

## Step-by-Step Tasks

### Task 1.1: Define lint types — Depends on [none]

- **BATCH**: B1
- **ACTION**: Create `src/types/lint.ts` with the discriminated-union type model.
- **IMPLEMENT**: Define `LintSeverity = "error" | "warn" | "info"`; `LintRuleId` union of the 8 rule
  ids; `LintRule { id; severity; title; rationale; remediation }`;
  `LintFinding { ruleId; service; severity; message; remediation }`;
  `LintSummary { error; warn; info; total }`; `LintResult { timestamp; findings; summary; mode }`
  (`mode: "static" | "runtime"`);
  `LintOptions { composePath; services?; profiles?; failOn; runtime; ignore? }`;
  `LintIgnoreEntry { rule: LintRuleId | "*"; service?: string }`. Add a richer `LintComposeService`
  interface covering `deploy?.resources?.limits?.{memory,cpus}`, `healthcheck?`,
  `logging?.options?`, `restart?`, `security_opt?: string[]`, `cap_drop?: string[]`,
  `read_only?: boolean`, `user?: string`, `privileged?: boolean`, and
  `LintComposeConfig { services: Record<string, LintComposeService> }`.
- **MIRROR**: NAMING_CONVENTION — `types/drift.ts:12-90` (`XOptions`/`XResult`/`XSummary` shape).
- **IMPORTS**: none (pure type file). Use `import type` if referencing shared types.
- **GOTCHA**: The narrow `ComposeServiceConfig` (`docker.ts:699-717`) omits every field lint
  inspects — define the richer shape here; the engine casts `getComposeConfig` output to it (mirror
  drift's `as unknown as` at `drift.ts:555`).
- **VALIDATE**: `cd packages/rfapps-cli && npm run typecheck` — file compiles, no `any`.

### Task 1.2: Add `lint.ignore` to config types — Depends on [none]

- **BATCH**: B1
- **ACTION**: Update `src/types/config.ts` to add an optional `lint` section.
- **IMPLEMENT**: Add `lint?: { ignore?: Array<{ rule: string; service?: string }> }` to both
  `RfappsConfig` (around 103-126) and `PartialRfappsConfig` (around 131-143). Keep the `string` rule
  type here (loose) — validation/normalization happens in `lib/lint.ts` against `LintRuleId`. JSDoc
  each field.
- **MIRROR**: the existing `parallel:` config section shape in the same file.
- **IMPORTS**: none new.
- **GOTCHA**: Do NOT import `types/lint.ts` here to avoid a type cycle; keep the config shape
  structural (`string` rule ids), validated downstream.
- **VALIDATE**: `cd packages/rfapps-cli && npm run typecheck`.

### Task 2.1: Rule catalog + evaluation engine — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Create `src/lib/lint.ts` — the declarative catalog and pure evaluator.
- **IMPLEMENT**: Export `const LINT_RULES: LintRule[]` with these 8 rules and default severities:
  `privileged-enabled` (**error**: `privileged === true`), `restart-policy-missing` (**warn**: no
  `restart` and no `deploy.restart_policy`), `healthcheck-missing` (**warn**: no `healthcheck`),
  `log-rotation-missing` (**warn**: no `logging.options["max-size"]`), `resource-limits-missing`
  (**info**: no `deploy.resources.limits.memory`), `no-new-privileges-missing` (**info**:
  `security_opt` lacks `no-new-privileges:true`), `cap-drop-missing` (**info**: no/empty
  `cap_drop`), `read-only-rootfs` (**info**: `read_only !== true`). Each rule is
  `{ id, severity, title, rationale, remediation, evaluate(service): boolean }` (true = finding
  fires). Export
  `evaluateLint(config: LintComposeConfig, targets: string[] | undefined, ignore: LintIgnoreEntry[]): LintResult`:
  iterate target services (or all), run each non-suppressed rule, collect findings, **sort by
  `service` asc then `ruleId` asc** (NF3), compute summary. Normalize/validate ignore entries
  (`toLowerCase().trim()`, check rule id ∈ `LINT_RULES`, throw `InvalidArgumentError` on unknown
  rule id).
- **MIRROR**: REPOSITORY_PATTERN — `drift.ts:546-555`; the KISS catalog `RULES.flatMap(r => …)`
  shape.
- **IMPORTS**:
  `import type { LintComposeConfig, LintFinding, LintResult, LintRule, LintIgnoreEntry } from "../types/lint.js";`
  `import { InvalidArgumentError } from "./errors.js";`
- **GOTCHA**: Evaluate the RESOLVED config (anchor/extension-merged) — `restart` may come from
  `&service-base`, `logging` from `*logging-default`. Do not read raw YAML. Keep predicates pure &
  synchronous; no daemon access here.
- **VALIDATE**: `cd packages/rfapps-cli && npm run typecheck`.

### Task 2.2: Lint exit-code resolver — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Update `src/lib/exit-codes.ts` to add lint exit-code helpers.
- **IMPLEMENT**: Add
  `resolveLintExitCode(result: LintResult, failOn: LintSeverity | "none"): ExitCodeValue` — return
  `ExitCode.Success` when `failOn === "none"` or no finding meets/exceeds the threshold; else
  `ExitCode.OperationalError`. Severity ordering: `info < warn < error`. Add
  `setLintExitCode(result, failOn)`. (Invalid `failOn` is rejected earlier in the CLI
  preAction/parse layer → `UsageError`.)
- **MIRROR**: `resolveDeployExitCode`/`setDeployExitCode` (`exit-codes.ts:16-32`).
- **IMPORTS**: `import type { LintResult, LintSeverity } from "../types/lint.js";`
- **GOTCHA**: Decouple severity from exit (spec): a `warn`-level finding only fails when `failOn` is
  `warn` or `info`. Treat `none` as always-Success.
- **VALIDATE**: `cd packages/rfapps-cli && npm run typecheck`.

### Task 2.3: Thread `lint` config through loader — Depends on [1.2]

- **BATCH**: B2
- **ACTION**: Update `src/lib/config.ts` to merge the `lint` section.
- **IMPLEMENT**: In `mergeConfig` (~120) and `partialToFull` (~167), carry `lint` through (default
  `{ ignore: [] }` in `partialToFull`). Copy the existing `parallel:` handling blocks as the
  template. Optionally extend `loadConfigFromEnv` only if an env override is desired — otherwise
  skip (YAGNI).
- **MIRROR**: the three `parallel:` blocks in `config.ts`.
- **IMPORTS**: none new (config object is structural).
- **GOTCHA**: `.rfapps.yaml` is parsed via `import YAML from "yaml"` already
  (`config.ts:17,109-114`) — no parser change needed.
- **VALIDATE**: `cd packages/rfapps-cli && npm run typecheck`.

### Task 2.4: Re-export lint types from barrel — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Update `src/types/index.ts` to re-export the new types module.
- **IMPLEMENT**: Add `export * from "./lint.js";` (or named type re-exports matching the file's
  existing style, e.g. `export type { LintResult, LintFinding } from "./lint.js";`).
- **MIRROR**: existing `export … from "./drift.js"` line in `types/index.ts:35`.
- **IMPORTS**: n/a.
- **GOTCHA**: Match the file's re-export idiom (named vs `*`) to avoid lint churn.
- **VALIDATE**: `cd packages/rfapps-cli && npm run typecheck`.

### Task 2.5: SARIF 2.1.0 serializer — Depends on [1.1]

- **BATCH**: B2
- **ACTION**: Create `src/lib/lint-sarif.ts`.
- **IMPLEMENT**: Export `toSarif(result: LintResult, rules: LintRule[]): SarifLog`. Build a
  single-run SARIF 2.1.0 object: `$schema`, `version: "2.1.0"`,
  `runs: [{ tool: { driver: { name: "rfapps-lint", rules: rules.map(...) } }, results: [...] }]`.
  Map each `LintFinding` to a result with `ruleId`, `level` (error→`error`, warn→`warning`,
  info→`note`), `message.text` (non-empty), and `locations[]` with
  `physicalLocation.artifactLocation.uri = "compose.yml"`, `uriBaseId: "%SRCROOT%"`,
  `region.startLine: 1`. Define local `SarifLog`/`SarifResult` interfaces (no dep, no `any`).
- **MIRROR**: External Documentation SARIF rows above.
- **IMPORTS**: `import type { LintResult, LintRule } from "../types/lint.js";`
- **GOTCHA**: Resolved compose config carries no source line — emit a synthetic
  `region.startLine: 1`. Use relative `uri` + `uriBaseId` (no absolute host paths). Never embed
  resolved secret/env values in `message.text`.
- **VALIDATE**: `cd packages/rfapps-cli && npm run typecheck`.

### Task 3.1: Lint action orchestration — Depends on [2.1, 2.2, 2.3, 2.5]

- **BATCH**: B3
- **ACTION**: Create `src/actions/lint.ts` — `executeLint(rawOptions, globalOptions)`.
- **IMPLEMENT**: Mirror `actions/drift.ts:350-465`. Derive `envTool` via `getEnvToolExecConfig`;
  resolve `format` precedence: `--sarif` → sarif, `--json` → json, else
  `globalOptions.output ?? "text"`. Handle `--list-rules` first (print `LINT_RULES` as
  `id | severity | rationale`, return, exit 0). Else `loadConfig` + `applyCliOverrides`,
  `resolveServicesWithInteractive` (`null` → return), call `getComposeConfig` and cast to
  `LintComposeConfig`, run `evaluateLint(config, targets, config.lint?.ignore ?? [])`. If
  `--runtime`: reuse `lib/drift.ts` (`getRunningServiceContainerMap` + `inspectContainers`) to
  append runtime-drift findings on lint-relevant knobs (set `mode: "runtime"`). Render: `text` →
  grouped colorized table to stderr (service → severity); `json`/other machine →
  `formatOutput(format, result)`; `sarif` → `toSarif(result, LINT_RULES)` to stdout. Finally
  `setLintExitCode(result, failOn)`.
- **MIRROR**: SERVICE_PATTERN — `drift.ts:383-456`; status text render `status.ts:195-211,388-397`.
- **IMPORTS**: `evaluateLint`, `LINT_RULES` from `../lib/lint.js`; `toSarif` from
  `../lib/lint-sarif.js`; `setLintExitCode` from `../lib/exit-codes.js`; `getComposeConfig`,
  `getRunningServiceContainerMap`, `inspectContainers` from `../lib/docker.js`; `loadConfig`,
  `applyCliOverrides`, `resolveServicesWithInteractive` from `../lib/index.js`; `formatOutput` from
  `../lib/formatters/index.js`; loggers + `isMachineFormat` from `@rfmedia/common`.
- **GOTCHA**: Default path must make NO Docker socket call — `getComposeConfig` shells
  `docker compose config` (binary, not socket) which is acceptable for NF2; only `--runtime` touches
  the socket. If `--runtime` and daemon unreachable, let the `DockerCommandError` propagate (no
  silent fallback to static).
- **VALIDATE**: `cd packages/rfapps-cli && npm run typecheck`.

### Task 3.2: Re-export lint engine from lib barrel — Depends on [2.1, 2.5]

- **BATCH**: B3
- **ACTION**: Update `src/lib/index.ts` to re-export the lint engine + SARIF serializer.
- **IMPLEMENT**: Add `export { evaluateLint, LINT_RULES } from "./lint.js";` and
  `export { toSarif } from "./lint-sarif.js";`, mirroring the existing `drift` re-export line
  (~129).
- **MIRROR**: `export { detectDrift, getDriftForService } from "./drift.js";`
- **IMPORTS**: n/a.
- **GOTCHA**: Keep barrel ordering/style consistent with neighbors.
- **VALIDATE**: `cd packages/rfapps-cli && npm run typecheck`.

### Task 4.1: Register `lint` command in CLI — Depends on [3.1]

- **BATCH**: B4
- **ACTION**: Update `src/cli.ts` to register `lint` inline after the `drift` block.
- **IMPLEMENT**: `program.command("lint")` with description; flags `-s/--service`, `--services`,
  `-g/--group`, `--no-sidecars`, `-f/--compose`, `-e/--env-file`, `-p/--profile` (mirror drift
  detect), plus `--json`, `--sarif`, `--runtime`, `--list-rules`, and `--fail-on <severity>` via
  `new Option("--fail-on <severity>", …).choices(["none","info","warn","error"]).default("error")`.
  `.action(async (options) => { const { executeLint } = await import("./actions/lint.js"); await executeLint(options, program.opts()); })`.
  Add an "Exit codes" help block like `deploy` (`cli.ts:289-297`).
- **MIRROR**: REPOSITORY_PATTERN — drift registration `cli.ts:399-414`; choices Option
  `cli.ts:64-68`.
- **IMPORTS**: `Option` from `commander` (already imported).
- **GOTCHA**: `--fail-on` choices give commander-level validation → invalid value exits with
  `UsageError` automatically. `--no-sidecars` yields `options.sidecars` (commander negation).
- **VALIDATE**: `cd packages/rfapps-cli && npm run dev -- lint --list-rules` prints the catalog;
  `npm run dev -- lint --fail-on bogus` exits non-zero with a usage error.

### Task 4.2: Engine unit tests — Depends on [2.1]

- **BATCH**: B4
- **ACTION**: Create `src/lib/lint.spec.ts`.
- **IMPLEMENT**: Cover each of the 8 rules (a service that fires it and one that passes), using
  inline `LintComposeConfig` fixtures. Assert: severity defaults; suppression via `lint.ignore` (by
  rule, by `service+rule`, and `rule: "*"`); unknown ignore rule id throws `InvalidArgumentError`;
  **determinism** — two `evaluateLint` calls on the same input produce identical finding order
  (service asc, ruleId asc); an anchor-supplied value (e.g. `restart` present) produces NO
  false-positive finding.
- **MIRROR**: TEST_STRUCTURE — `validation.spec.ts:1-55`; `vi.clearAllMocks()` in `beforeEach`.
- **IMPORTS**: vitest; `evaluateLint`, `LINT_RULES` from `./lint.js`.
- **GOTCHA**: No daemon/fs in these tests — pass in-memory config objects directly.
- **VALIDATE**: `cd packages/rfapps-cli && npm run test:run -- lint.spec`.

### Task 4.3: Action unit tests — Depends on [3.1]

- **BATCH**: B4
- **ACTION**: Create `src/actions/lint.spec.ts`.
- **IMPLEMENT**: Mock `@rfmedia/common` (partial), `../lib/docker.js` (`getComposeConfig` returns a
  fixture; assert NOT called with daemon in default mode), `../lib/index.js` (config + target
  resolution). Assert: text path renders without `formatOutput`; `--json` calls
  `formatOutput("json", …)`; `--sarif` emits a SARIF object; `--list-rules` prints catalog and skips
  scan; `--fail-on` threshold sets `process.exitCode`; `--runtime` invokes `inspectContainers`.
  Reuse `withFormatOutputCapture` where helpful.
- **MIRROR**: `actions/drift.spec.ts` / `status.spec.ts:34-196` mock + `process.exitCode`
  assertions.
- **IMPORTS**: vitest; `executeLint` from `./lint.js`.
- **GOTCHA**: Reset `process.exitCode` in `afterEach`; use `vi.clearAllMocks()` not `resetAllMocks`.
- **VALIDATE**: `cd packages/rfapps-cli && npm run test:run -- lint.spec`.

### Task 4.4: Exit-code resolver tests — Depends on [2.2]

- **BATCH**: B4
- **ACTION**: Update `src/lib/exit-codes.spec.ts` with `resolveLintExitCode` cases.
- **IMPLEMENT**: Table-style cases across the ladder: empty findings → Success for every `failOn`;
  `failOn: "none"` → always Success even with errors; `failOn: "error"` with only warn findings →
  Success; with an error finding → OperationalError; `failOn: "warn"` with a warn finding →
  OperationalError; `failOn: "info"` with any finding → OperationalError.
- **MIRROR**: existing `resolveDeployExitCode` test cases in the same file.
- **IMPORTS**: `resolveLintExitCode` from `./exit-codes.js`; build minimal `LintResult` fixtures.
- **GOTCHA**: Keep `LintResult` fixtures minimal but type-complete (no `any`).
- **VALIDATE**: `cd packages/rfapps-cli && npm run test:run -- exit-codes.spec`.

### Task 5.1: Documentation + plex exemption defaults — Depends on [4.1]

- **BATCH**: B5
- **ACTION**: Update `packages/rfapps-cli/README.md` and root `CLAUDE.md`; document the shipped
  `.rfapps.yaml` `lint.ignore` plex/GPU exemption.
- **IMPLEMENT**: Add a `rfapps lint` section to README (synopsis, flags, exit-code table,
  `--list-rules`, `.rfapps.yaml lint.ignore` example exempting `plex`/`plex-ts` from
  `resource-limits-missing`). Add a one-line entry to the CLAUDE.md command/quick-reference table.
  Express the plex exemption as data in `.rfapps.yaml` (auditable, overridable) — NOT hardcoded in
  the engine.
- **MIRROR**: existing command docs in `README.md`; CLAUDE.md "rfapps CLI Quick Reference".
- **IMPORTS**: n/a.
- **GOTCHA**: Run `npm run format` (root) so markdown passes markdownlint before commit.
- **VALIDATE**: `npm run format:check && npm run lint:md` from repo root.

---

## Testing Strategy

### Unit Tests

| Test                         | Input                                                        | Expected Output                                        | Edge Case? |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ | ---------- |
| Each rule fires              | service missing the knob                                     | one finding with rule's default severity + remediation | No         |
| Each rule passes             | service with the knob set                                    | no finding for that rule                               | No         |
| Anchor-supplied value        | service whose `restart`/`logging` comes from a merged anchor | NO false-positive finding                              | Yes        |
| `privileged-enabled`         | `privileged: true`                                           | `error` finding                                        | Yes        |
| Suppression by rule          | `lint.ignore: [{ rule: "resource-limits-missing" }]`         | rule excluded for all services                         | Yes        |
| Suppression by service+rule  | `{ rule: "resource-limits-missing", service: "plex" }`       | excluded only for plex                                 | Yes        |
| Unknown ignore rule id       | `{ rule: "nope" }`                                           | throws `InvalidArgumentError`                          | Yes        |
| Determinism                  | same config twice                                            | byte-identical finding order (service asc, ruleId asc) | Yes        |
| `resolveLintExitCode` ladder | findings × `failOn` matrix                                   | Success / OperationalError per threshold               | Yes        |
| `--fail-on none`             | any findings                                                 | `ExitCode.Success`                                     | Yes        |
| SARIF shape                  | `LintResult`                                                 | valid 2.1.0 log, level mapped, relative uri            | Yes        |
| `--list-rules`               | n/a                                                          | catalog printed, no compose read                       | No         |
| `--runtime`                  | mocked containers                                            | drift findings appended, `inspectContainers` called    | Yes        |
| Default mode                 | no `--runtime`                                               | no `inspectContainers`/socket call                     | Yes        |

### Edge Cases Checklist

- [ ] Empty target set (no services match `-s`/`-g`) → empty findings, exit 0
- [ ] Service with every knob set → zero findings
- [ ] Service with every knob missing → one finding per rule
- [ ] Unknown `--fail-on` value → `UsageError` (2)
- [ ] Unknown ignore rule id → `InvalidArgumentError`
- [ ] `--runtime` with daemon down → `DockerCommandError`, non-zero exit, no silent fallback
- [ ] Malformed compose / env-resolution failure → typed error, not a misleading finding

---

## Validation Commands

### Static Analysis

```bash
cd packages/rfapps-cli && npm run typecheck
```

EXPECT: Zero type errors, no `any`.

### Unit Tests

```bash
cd packages/rfapps-cli && npm run test:run -- lint.spec exit-codes.spec
```

EXPECT: All lint + exit-code tests pass.

### Full Test Suite

```bash
npm run test:run
```

EXPECT: No regressions across the monorepo.

### CLI Smoke

```bash
cd packages/rfapps-cli
npm run dev -- lint --list-rules           # prints catalog, exit 0
npm run dev -- lint                         # static lint of full stack, table output
npm run dev -- lint --json                  # machine output to stdout
npm run dev -- lint --sarif                 # SARIF 2.1.0 to stdout
npm run dev -- lint --fail-on bogus         # usage error, exit 2
time npm run dev -- lint                     # NF1: < 1s for the 47-service stack
```

EXPECT: Catalog lists 8 rules; default table groups by service→severity; `--sarif` validates against
SARIF 2.1.0; invalid `--fail-on` exits 2; full-stack run < 1s.

### Format / Lint

```bash
npm run format:check && npm run lint:md
```

EXPECT: No formatting or markdownlint violations.

### Manual Validation

- [ ] `rfapps lint` runs with the Docker daemon stopped and still produces findings (NF2)
- [ ] Output is byte-identical across two consecutive runs (NF3)
- [ ] `.rfapps.yaml` `lint.ignore` exempting `plex` from resource limits removes those findings
- [ ] `--runtime` reports drift and reuses `lib/drift.ts` inspection

---

## Acceptance Criteria

- [ ] `rfapps lint` (no flags) lints the resolved static compose config without Docker socket access
      (F1, NF2)
- [ ] Detects all 5 check families: resource limits, health checks, log rotation, restart policy,
      security knobs (F2)
- [ ] Every finding carries `severity` (error/warn/info) + non-empty remediation naming the compose
      key/anchor (F3)
- [ ] Scope works via `-s`, `-g`, and default-all, mirroring `deploy`/`drift` flags (F5)
- [ ] Default output is a colorized table grouped by service then severity (F6)
- [ ] `--json` emits a stable machine-readable schema (F7)
- [ ] `--sarif` emits valid SARIF 2.1.0, one result per finding (F8, Should)
- [ ] `--fail-on <severity>` (none/info/warn/error, default error) controls non-zero exit (F9)
- [ ] `.rfapps.yaml` `lint.ignore` suppresses by service/rule; suppressed findings excluded from
      exit calc (F10, Could)
- [ ] `rfapps lint --list-rules` prints the rule catalog (F11, Could)
- [ ] `--runtime` reports container drift, reusing `lib/drift.ts` (F4, Should)
- [ ] Static-mode full 47-service lint completes < 1s (NF1)
- [ ] Output deterministic across runs (NF3)
- [ ] No `any`; findings/rules modeled as discriminated unions (NF4)
- [ ] All validation commands pass; tests written and passing; no type/lint errors

## Completion Checklist

- [ ] Code follows discovered patterns (drift action analog, exit-code resolver, types shape)
- [ ] Error handling matches codebase style (`InvalidArgumentError`, typed boundary errors, no
      silent fallback)
- [ ] Logging follows conventions (stderr human / stdout machine; `colors.*`; `isMachineFormat`
      gating)
- [ ] Tests follow co-located `*.spec.ts` + `vi.clearAllMocks()` pattern
- [ ] Static `rfapps lint` (47 services) completes < 1s, no Docker socket call (verified
      daemon-stopped)
- [ ] Findings sorted by service (asc) then rule id (asc) before rendering
- [ ] SARIF validates against SARIF 2.1.0 (golden-file + relative `uri`)
- [ ] Rules evaluate the RESOLVED compose object — anchor-supplied values do not false-positive
- [ ] `--fail-on` rejects out-of-ladder values with `UsageError` (2)
- [ ] `plex`/GPU resource-limit exemption is data-driven via `.rfapps.yaml`, not hardcoded
- [ ] `resolveLintExitCode` unit-tested across the full ladder incl. `none` and empty findings
- [ ] No hardcoded values; barrels updated; README + CLAUDE.md documented
- [ ] Self-contained — no questions needed during implementation

## Risks

| Risk                                                                                            | Likelihood | Impact | Mitigation                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Lint reads raw YAML instead of resolved config → false negatives where anchors supply the value | M          | H      | Consume `getComposeConfig` resolved JSON; add fixtures where the only source of a passing value is an anchor merge       |
| Non-deterministic finding order breaks NF3 golden tests                                         | M          | M      | Sort by service asc then ruleId asc; stable key order in JSON/SARIF; determinism test                                    |
| `docker compose config` subprocess latency blows NF1 < 1s                                       | M          | M      | Call `getComposeConfig` ONCE for whole stack; evaluate all rules in-memory; never shell per-service                      |
| Over-strict default severities → ~45 findings as errors, gate ignored                           | M          | M      | Only `privileged-enabled` is `error`; security/resource knobs default `info`/`warn`; ship `.rfapps.yaml` ignore examples |
| `--fail-on` accepts arbitrary strings → silent CI mis-gating                                    | L          | M      | commander `.choices([...])` + default; invalid → `UsageError`                                                            |
| `--runtime` false positives from Docker-applied defaults                                        | M          | L      | Compare only declared keys (mirror drift direction logic); keep opt-in and labeled                                       |
| SARIF persists absolute paths / resolved secrets                                                | L          | M      | Relative `uri` + `uriBaseId` `%SRCROOT%`; never embed resolved env values in messages                                    |
| env-resolution failure (unset `${...}`) emits spurious findings                                 | M          | M      | Use same env resolution as deploy; treat resolution failure as `UsageError`, not a finding                               |

## Notes

- **Anchor resolution is already solved — reuse it.** `compose.yml:36-69` defines
  `&logging-default`, `&service-base` (→ `restart: unless-stopped`), `&common-env`,
  `&tailscale-sidecar-base`. `getComposeConfig` (`docker.ts:722-769`) shells
  `docker compose config --format json`, which expands all anchors and interpolates env — the SAME
  resolution the deploy path uses. Rules MUST evaluate this resolved object.
- **NF2 nuance — "no daemon" ≠ "no docker CLI".** `docker compose config` parses/validates locally
  and does NOT require the daemon socket. Default static mode reuses `getComposeConfig` and still
  satisfies NF2; only `--runtime` (`inspect`/`ps`) touches the socket. State NF2 as "no Docker
  socket/API access in default mode".
- **`ComposeServiceConfig` is insufficient.** `docker.ts:699-717` models only
  image/depends_on/ports/expose/network_mode/build. Define the richer `LintComposeService` in
  `types/lint.ts` and cast the resolved JSON to it (mirror drift's `as unknown as` at
  `drift.ts:555`).
- **"Weak vs missing" thresholds pinned for stable golden tests.** This plan checks _presence_ (e.g.
  `resource-limits-missing` fires when `deploy.resources.limits.memory` is absent), not subjective
  "weak" thresholds — avoids unstable predicates. A future pass can add value thresholds.
- **`drift` is a reusable sibling.** `--runtime` calls `detectDrift`/
  `getRunningServiceContainerMap`/`inspectContainers` (`drift.ts:25`) and maps drift into
  `LintFinding` within the lint layer — do not extend `DriftCategory`.
- **Confidence Score: 8/10.** High on architecture reuse (drift analog, exit-code resolver, config
  plumbing) and SARIF mapping. Medium on exact rule-predicate edge semantics and the text-render
  polish for 47-service `info`-heavy output (group + summary counts mitigate).
