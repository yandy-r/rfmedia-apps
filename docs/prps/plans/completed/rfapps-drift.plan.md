# Plan: Configuration Drift Detection (`rfapps drift`)

## Summary

Complete `rfapps drift` as a standalone day-2 diagnostic command that reports configuration and
runtime drift between resolved compose declarations and live Docker state. The implementation
extends the existing drift detector with runtime status/health findings, versioned machine output,
secret-safe payloads, scheduler-friendly exit behavior, command-module registration, shell
completion updates, and documentation across the CLI docs surface.

## User Story

As a self-hosting operator, I want `rfapps drift` to detect when running containers differ from
compose declarations, so that I can catch unsafe or surprising runtime changes before they break
update, reconcile, or restore workflows.

## Problem → Solution

Current drift support exists but is incomplete: command registration is inline, runtime
status/health is not a drift category, JSON output can expose raw secret env values, and scheduled
checks do not have a drift-found exit contract. The solution is to finish the drift contract in
place, extract command registration, add runtime-status drift using existing service-status parsing,
sanitize all output formats, update MCP/schema/completion surfaces, and document read-only versus
mutating drift behavior.

## Metadata

- **Complexity**: Large
- **Source PRD**: `docs/prps/specs/rfapps-drift.spec.md`
- **PRD Phase**: standalone
- **Estimated Files**: 20

## Batches

Tasks grouped by dependency for parallel execution. Tasks within the same batch run concurrently;
batches run in order.

| Batch | Tasks              | Depends On | Parallel Width |
| ----- | ------------------ | ---------- | -------------- |
| B1    | 1.1, 1.2           | —          | 2              |
| B2    | 2.1, 2.2, 2.3      | B1         | 3              |
| B3    | 3.1, 3.2, 3.3, 3.4 | B2         | 4              |
| B4    | 4.1, 4.2, 4.3      | B3         | 3              |
| B5    | 5.1                | B4         | 1              |

- **Total tasks**: 13
- **Total batches**: 5
- **Max parallel width**: 4

---

## UX Design

### Before

```text
operator
  ├─ rfapps drift detect     -> config drift only, exit code does not signal drift found
  ├─ rfapps drift show       -> existing detail view
  ├─ rfapps drift reconcile  -> mutates containers
  └─ rfapps drift import     -> mutates compose files
```

### After

```text
operator / cron / MCP
  ├─ rfapps drift detect --json
  │    ├─ schemaVersion
  │    ├─ image/env/ports/volumes/networks/runtime-status findings
  │    ├─ masked secret values
  │    └─ non-zero when drift exists unless report-only override is set
  ├─ rfapps drift show
  ├─ rfapps drift reconcile  -> explicit opt-in mutation path
  └─ rfapps drift import     -> explicit opt-in mutation path
```

### Interaction Changes

| Touchpoint       | Before                                                       | After                                                                                              | Notes                                        |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Human CLI        | Drift output omits runtime status as a first-class category  | Drift output groups runtime-status with other categories                                           | Keep text output on stderr                   |
| Automation       | JSON has no `schemaVersion` and no drift-found exit contract | JSON has `schemaVersion`, `runtime-status`, and non-zero drift-found exit                          | Add report-only override                     |
| MCP              | Drift schemas mirror old categories                          | Drift schemas include schema version and runtime-status category                                   | Keep read tools separate from mutation tools |
| Shell completion | Existing drift subcommand completion omits new drift flags   | Bash/zsh/fish expose new drift options                                                             | Update generator and tests                   |
| Docs             | Drift has no dedicated feature doc                           | Drift docs cover categories, scheduler examples, exit behavior, JSON, MCP, and mutation boundaries | Link from README/index/quick-reference       |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                                 | Lines   | Why                                                                                      |
| -------------- | ---------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| P0 (critical)  | `docs/prps/specs/rfapps-drift.spec.md`               | 1-96    | Locked requirements and decisions                                                        |
| P0 (critical)  | `packages/rfapps-cli/src/actions/drift.ts`           | 1-900   | Existing drift action orchestration, display, exit behavior, reconcile/import boundaries |
| P0 (critical)  | `packages/rfapps-cli/src/lib/drift.ts`               | 1-621   | Desired/actual drift comparison pipeline                                                 |
| P0 (critical)  | `packages/rfapps-cli/src/types/drift.ts`             | 1-120   | Current drift categories and result contracts                                            |
| P0 (critical)  | `packages/rfapps-cli/src/lib/service-status.ts`      | 1-260   | Existing runtime state/health parsing                                                    |
| P1 (important) | `packages/rfapps-cli/src/commands/doctor.ts`         | 1-80    | Dedicated command-module and read-only help text pattern                                 |
| P1 (important) | `packages/rfapps-cli/src/commands/audit.ts`          | 1-80    | Dedicated command-module pattern                                                         |
| P1 (important) | `packages/rfapps-cli/src/actions/completion.ts`      | 1-1050  | Bash/zsh/fish completion generation                                                      |
| P1 (important) | `packages/rfapps-cli/src/actions/completion.spec.ts` | 1-500   | Completion test expectations                                                             |
| P1 (important) | `packages/rfapps-cli/src/mcp/schema.ts`              | 425-715 | Drift schemas and tool names                                                             |
| P1 (important) | `packages/rfapps-cli/src/mcp/adapters.ts`            | 476-517 | Drift MCP adapter output capture                                                         |
| P1 (important) | `packages/rfapps-cli/src/mcp/tools-read.ts`          | 43-56   | Read-only drift MCP tools                                                                |
| P1 (important) | `packages/rfapps-cli/src/mcp/tools-mutate.ts`        | 74-86   | Mutating drift MCP tools                                                                 |
| P2 (reference) | `docs/features/rfapps-doctor-command.md`             | 1-120   | Read-only guarantees, exit behavior, JSON schema doc pattern                             |
| P2 (reference) | `docs/features/shell-completion.md`                  | 112-365 | Completion examples and update workflow                                                  |
| P2 (reference) | `docs/features/json-output.md`                       | 175-226 | Versioned command JSON schema docs                                                       |
| P2 (reference) | `docs/features/plan-apply-workflow.md`               | all     | Update/lifecycle context to link drift into                                              |

## External Documentation

| Topic                    | Source     | Key Takeaway                                                       |
| ------------------------ | ---------- | ------------------------------------------------------------------ |
| External scheduler usage | Not needed | Use local cron/systemd examples; no external API research required |

---

## Patterns to Mirror

Code patterns discovered in the codebase. Follow these exactly.

### COMMAND_MODULE

```ts
// SOURCE: packages/rfapps-cli/src/commands/audit.ts:3-33
export function registerAuditCommand(program: Command): void {
  program
    .command("audit")
    .addHelpText("after", `...`)
    .action(async (options) => {
      const { executeAudit } = await import("../actions/audit.js");
      await executeAudit(options, program.opts());
    });
}
```

### DRIFT_ACTION_FLOW

```ts
// SOURCE: packages/rfapps-cli/src/actions/drift.ts:430-437
const result = await detectDrift(
  {
    composePath: finalConfig.composePath,
    services: services.length > 0 ? services : undefined,
    profiles,
  },
  envTool,
);
```

### DRIFT_COMPARISON_PIPELINE

```ts
// SOURCE: packages/rfapps-cli/src/lib/drift.ts:540-570
const composeConfig = await getComposeConfig(options.composePath, {
  profiles: options.profiles,
  envTool,
});
const serviceContainerMap = await getRunningServiceContainerMap(options.composePath, {
  profiles: options.profiles,
  envTool,
});
const containerInspects = await inspectContainers(containerNames);
```

### RUNTIME_STATUS_PARSING

```ts
// SOURCE: packages/rfapps-cli/src/lib/service-status.ts:239-256
const services = preloadedServices ?? (await getComposeServices(composePath, { profiles, envTool }));
statusMap.set(service, { state: "created", health: "none" });
const result = await listContainers(true, "json", composePath, { profiles, envTool });
```

### FINDING_EXIT_BEHAVIOR

```ts
// SOURCE: packages/rfapps-cli/src/actions/audit.ts:158-164
if (shouldFailAudit(result, failOn)) {
  process.exitCode = 1;
}
await formatOutput(options.output ?? "json", result);
```

### SECRET_MASKING_BOUNDARY

```ts
// SOURCE: packages/rfapps-cli/src/actions/drift.ts:115-124
const value = env.isSecret ? formatDiffValue("********", "********") : formatDiffValue(env.current, env.desired);
```

### COMPLETION_METADATA

```bash
# SOURCE: packages/rfapps-cli/src/actions/completion.ts:91-95
local drift_detect_opts="--service --services --group --no-sidecars --show-unchanged --compose --env-file --profile"
local drift_show_opts="--service --compose --env-file --profile"
local drift_reconcile_opts="--service --services --group --no-sidecars --compose --env-file --profile"
```

### TEST_STRUCTURE

```ts
// SOURCE: packages/rfapps-cli/src/actions/drift.spec.ts:14-30
vi.mock("../lib/drift.js");
vi.mock("../lib/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  formatOutput: vi.fn(),
}));
```

---

## Files to Change

| File                                                 | Action | Justification                                                                                |
| ---------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/commands/drift.ts`          | CREATE | Extract drift command registration and help text                                             |
| `packages/rfapps-cli/src/cli.ts`                     | UPDATE | Import/register dedicated drift command module and remove inline registration                |
| `packages/rfapps-cli/src/types/drift.ts`             | UPDATE | Add `schemaVersion`, `runtime-status`, runtime finding/result contracts, report-only options |
| `packages/rfapps-cli/src/lib/drift.ts`               | UPDATE | Add runtime status/health drift and secret-safe result sanitization                          |
| `packages/rfapps-cli/src/actions/drift.ts`           | UPDATE | Add exit behavior, report-only override, runtime display, and read-only safeguards           |
| `packages/rfapps-cli/src/mcp/schema.ts`              | UPDATE | Add `schemaVersion` and `runtime-status` category to drift schemas                           |
| `packages/rfapps-cli/src/mcp/adapters.ts`            | UPDATE | Preserve JSON capture while passing new drift options/results                                |
| `packages/rfapps-cli/src/actions/completion.ts`      | UPDATE | Add new drift flags to bash/zsh/fish completions                                             |
| `packages/rfapps-cli/src/lib/drift.spec.ts`          | UPDATE | Cover runtime-status drift and machine-safe secret masking                                   |
| `packages/rfapps-cli/src/actions/drift.spec.ts`      | UPDATE | Cover exit behavior, report-only override, read-only boundaries, and output routing          |
| `packages/rfapps-cli/src/actions/completion.spec.ts` | UPDATE | Cover new drift completion flags across shells                                               |
| `packages/rfapps-cli/src/mcp/schema.spec.ts`         | UPDATE | Cover drift schema version and runtime-status category                                       |
| `packages/rfapps-cli/src/mcp/adapters.spec.ts`       | UPDATE | Cover new drift output/option adapter behavior if adapter shape changes                      |
| `docs/features/rfapps-drift-command.md`              | CREATE | Dedicated drift feature documentation                                                        |
| `docs/features/shell-completion.md`                  | UPDATE | Add drift completion examples and update guidance                                            |
| `docs/features/json-output.md`                       | UPDATE | Add drift JSON schema and `jq` examples                                                      |
| `docs/features/output-formats.md`                    | UPDATE | Add drift to structured output examples                                                      |
| `docs/features/rfapps-mcp-server.md`                 | UPDATE | Align read/mutation drift tool docs with schema changes                                      |
| `docs/features/plan-apply-workflow.md`               | UPDATE | Explain how drift informs update/reconcile workflows without becoming a daemon               |
| `docs/features/quick-reference.md`                   | UPDATE | Add common drift commands near diagnostics/status                                            |
| `docs/README.md`                                     | UPDATE | Link new drift feature doc and note missing CLI reference gap only if touched                |
| `README.md`                                          | UPDATE | Add drift to root management command list                                                    |
| `packages/rfapps-cli/README.md`                      | UPDATE | Add drift to package feature/command reference                                               |

## Shell Completion, Update, And Documentation Coverage

The implementation must include explicit coverage for three non-code surfaces:

| Surface                | Required Plan Coverage                                                                                                                           | Primary Files                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell completions      | Update bash, zsh, and fish drift subcommand option metadata; add tests for new flags and service completion preservation                         | `packages/rfapps-cli/src/actions/completion.ts`, `packages/rfapps-cli/src/actions/completion.spec.ts`, `docs/features/shell-completion.md` |
| Update workflows       | Document how scheduled drift checks feed plan/apply, reconcile, and future update lifecycle decisions; do not add a daemon or automatic mutation | `docs/features/rfapps-drift-command.md`, `docs/features/plan-apply-workflow.md`, `docs/features/quick-reference.md`                        |
| Relevant documentation | Add a dedicated drift feature doc and update JSON, output formats, MCP, root README, package README, and docs index references                   | `docs/features/*.md`, `README.md`, `packages/rfapps-cli/README.md`, `docs/README.md`                                                       |

## NOT Building

- No always-on daemon, background service, or built-in scheduler.
- No automatic reconciliation when drift is detected.
- No broad command-registration refactor beyond extracting `drift`.
- No persisted state writes for detect/show.
- No interpretation of `depends_on` or profile membership as runtime drift in v1.
- No new runtime dependency unless an existing helper cannot safely support the required behavior.

---

## Step-by-Step Tasks

### Task 1.1: Extract Drift Command Registration — Depends on none

- **BATCH**: B1
- **ACTION**: Create `packages/rfapps-cli/src/commands/drift.ts` and wire it from
  `packages/rfapps-cli/src/cli.ts`.
- **IMPLEMENT**: Move the current inline `program.command("drift")` subcommand definitions into
  `registerDriftCommand(program)`. Preserve lazy imports to `../actions/drift.js`, existing options,
  global `program.opts()` behavior, and add help text that distinguishes read-only detect/show from
  explicit reconcile/import mutation paths.
- **MIRROR**: `COMMAND_MODULE`
- **IMPORTS**: `Command` from `commander`; action imports remain lazy inside handlers.
- **GOTCHA**: Do not change existing command names or option spellings while extracting.
- **VALIDATE**: `npm run build:rfapps` and targeted CLI help smoke check once built.

### Task 1.2: Define Drift Result And Schema Contracts — Depends on none

- **BATCH**: B1
- **ACTION**: Update drift TypeScript contracts and MCP schemas before implementation code uses
  them.
- **IMPLEMENT**: Add a `schemaVersion` field, add `runtime-status` to `DriftCategory`, model runtime
  state/health using existing `ContainerState` and `HealthStatus` unions, and add any option type
  needed for report-only behavior. Update `packages/rfapps-cli/src/mcp/schema.ts` to mirror the
  TypeScript contract.
- **MIRROR**: `DRIFT_COMPARISON_PIPELINE`, `RUNTIME_STATUS_PARSING`
- **IMPORTS**: Existing runtime unions from `packages/rfapps-cli/src/types/results.ts` where
  practical.
- **GOTCHA**: MCP schema and TypeScript drift category union must stay in lockstep.
- **VALIDATE**: `npm run typecheck -w packages/rfapps-cli`

### Task 2.1: Implement Runtime-Status Drift And Secret-Safe Results — Depends on 1.2

- **BATCH**: B2
- **ACTION**: Extend `packages/rfapps-cli/src/lib/drift.ts` with runtime state/health drift and
  sanitized output payloads.
- **IMPLEMENT**: Reuse or call `getServiceStatusMap()` for selected services so
  missing/exited/unhealthy services become `runtime-status` findings. Add `schemaVersion` to the
  result and ensure secret env values are masked before any result reaches `formatOutput`, not just
  during human text rendering.
- **MIRROR**: `DRIFT_COMPARISON_PIPELINE`, `RUNTIME_STATUS_PARSING`, `SECRET_MASKING_BOUNDARY`
- **IMPORTS**: Runtime status helper from `lib/service-status.ts`; drift/result types from
  `types/drift.ts`.
- **GOTCHA**: `getRunningServiceContainerMap()` only sees running containers, so do not use it as
  the only source for missing/exited runtime-status drift.
- **VALIDATE**: `npm run test:rfapps -- --run packages/rfapps-cli/src/lib/drift.spec.ts`

### Task 2.2: Add Drift Exit Behavior And Report-Only Override — Depends on 1.1, 1.2

- **BATCH**: B2
- **ACTION**: Update `packages/rfapps-cli/src/actions/drift.ts` to make scheduled checks alertable
  without changing command failure handling.
- **IMPLEMENT**: Set exit code non-zero when detect/show finds drift by default, keep command
  execution failures on the existing formatted error path, and add a report-only override option
  that forces success when the command completes. Ensure human text stays on stderr and machine
  output still goes through `formatOutput`.
- **MIRROR**: `FINDING_EXIT_BEHAVIOR`, `DRIFT_ACTION_FLOW`
- **IMPORTS**: Drift result helpers/types from `types/drift.ts`; existing formatter/logging
  utilities.
- **GOTCHA**: Do not set a drift-found exit code before structured output is emitted.
- **VALIDATE**: `npm run test:rfapps -- --run packages/rfapps-cli/src/actions/drift.spec.ts`

### Task 2.3: Align MCP Drift Adapters With The Versioned Result — Depends on 1.2

- **BATCH**: B2
- **ACTION**: Update MCP drift schemas/adapters only as needed for new options and result fields.
- **IMPLEMENT**: Keep `rfapps.drift.detect` and `rfapps.drift.show` in read tools, keep
  reconcile/import in mutation tools, and preserve adapter thinness by relying on the action JSON
  result. Add adapter handling for the report-only option only if exposed to MCP.
- **MIRROR**: `DRIFT_ACTION_FLOW`
- **IMPORTS**: Existing `rfappsMcpSchemas`, `rfappsActionAdapters`, and `toServicesOption` helpers.
- **GOTCHA**: Do not accidentally reclassify reconcile/import as read tools.
- **VALIDATE**:
  `npm run test:rfapps -- --run packages/rfapps-cli/src/mcp/schema.spec.ts packages/rfapps-cli/src/mcp/adapters.spec.ts`

### Task 3.1: Add Library Tests For Runtime Drift And Sanitization — Depends on 2.1

- **BATCH**: B3
- **ACTION**: Extend `packages/rfapps-cli/src/lib/drift.spec.ts`.
- **IMPLEMENT**: Add tests for running, missing, exited, unhealthy, and healthy services; verify
  `runtime-status` appears only when selected service runtime state should be considered drift. Add
  JSON-safe secret assertions so raw secret values never appear in serialized drift results.
- **MIRROR**: `TEST_STRUCTURE`
- **IMPORTS**: Existing drift helpers and mocked Docker/service-status boundaries.
- **GOTCHA**: Keep Docker-normalized defaults from becoming false-positive drift unless the field
  was declared or runtime state is explicitly selected.
- **VALIDATE**: `npm run test:rfapps -- --run packages/rfapps-cli/src/lib/drift.spec.ts`

### Task 3.2: Add Action Tests For Exit Codes, Output, And Read-Only Boundaries — Depends on 2.1, 2.2

- **BATCH**: B3
- **ACTION**: Extend `packages/rfapps-cli/src/actions/drift.spec.ts`.
- **IMPLEMENT**: Cover no-drift success, drift-found non-zero exit, report-only success, execution
  failure formatted error, JSON/YAML/CSV formatter dispatch, text rendering, and negative assertions
  that detect/show do not call `startServices`, `writeFile`, or `copyFile`.
- **MIRROR**: `TEST_STRUCTURE`, `FINDING_EXIT_BEHAVIOR`
- **IMPORTS**: Existing mocks for `../lib/drift.js`, `../lib/index.js`, and `@rfmedia/common`.
- **GOTCHA**: Reset `process.exitCode` between tests.
- **VALIDATE**: `npm run test:rfapps -- --run packages/rfapps-cli/src/actions/drift.spec.ts`

### Task 3.3: Add MCP Contract Tests — Depends on 2.3

- **BATCH**: B3
- **ACTION**: Extend MCP schema/adapter tests for drift.
- **IMPLEMENT**: Assert drift result schema includes `schemaVersion` and accepts `runtime-status` in
  categories. If adapter options change, assert `rfapps.drift.detect` passes them through while
  preserving service array to comma-string translation.
- **MIRROR**: `DRIFT_ACTION_FLOW`
- **IMPORTS**: Existing MCP test helpers in `packages/rfapps-cli/src/mcp/*.spec.ts`.
- **GOTCHA**: Avoid coupling tests to exact human text; test structured contracts.
- **VALIDATE**:
  `npm run test:rfapps -- --run packages/rfapps-cli/src/mcp/schema.spec.ts packages/rfapps-cli/src/mcp/adapters.spec.ts`

### Task 3.4: Update Shell Completion Generation And Tests — Depends on 1.1, 2.2

- **BATCH**: B3
- **ACTION**: Update drift completion metadata and tests for bash, zsh, and fish.
- **IMPLEMENT**: Add new drift flags such as the report-only override to the appropriate `detect`
  and `show` completion branches. Preserve service/group/profile/env/compose completions and add
  assertions that generated scripts include new options for all supported shells.
- **MIRROR**: `COMPLETION_METADATA`
- **IMPORTS**: No new imports expected.
- **GOTCHA**: Completion metadata is manually duplicated per shell, so update bash, zsh, and fish
  together.
- **VALIDATE**: `npm run test:rfapps -- --run packages/rfapps-cli/src/actions/completion.spec.ts`

### Task 4.1: Add Dedicated Drift Feature Documentation — Depends on 3.1, 3.2, 3.3

- **BATCH**: B4
- **ACTION**: Create `docs/features/rfapps-drift-command.md`.
- **IMPLEMENT**: Document read-only guarantees, detect/show usage, runtime-status semantics,
  categories, secret masking, JSON schema version, exit behavior, report-only override, scheduler
  examples for cron/systemd, and explicit reconcile/import mutation boundaries.
- **MIRROR**: Documentation structure from `docs/features/rfapps-doctor-command.md`.
- **IMPORTS**: Documentation only.
- **GOTCHA**: Do not imply drift automatically reconciles or schedules itself.
- **VALIDATE**: `npm run lint:md`

### Task 4.2: Update Shell Completion And Structured Output Docs — Depends on 3.4

- **BATCH**: B4
- **ACTION**: Update `docs/features/shell-completion.md`, `docs/features/json-output.md`,
  `docs/features/output-formats.md`, and `docs/features/rfapps-mcp-server.md`.
- **IMPLEMENT**: Add drift completion examples, note how to refresh installed completions after the
  new flags, add drift JSON examples with `schemaVersion` and `runtime-status`, add `jq` snippets
  for drift counts, and keep MCP read/mutation tool docs aligned.
- **MIRROR**: `COMPLETION_METADATA`
- **IMPORTS**: Documentation only.
- **GOTCHA**: Keep machine-output examples on stdout and human/log output examples on stderr when
  describing behavior.
- **VALIDATE**: `npm run lint:md`

### Task 4.3: Update Lifecycle And Command Reference Docs — Depends on 3.1, 3.2

- **BATCH**: B4
- **ACTION**: Update docs and READMEs that should surface `rfapps drift`.
- **IMPLEMENT**: Add drift to `docs/features/plan-apply-workflow.md` as a pre/post-update signal for
  plan/apply and reconcile workflows, add quick-reference examples, link the new feature doc from
  `docs/README.md`, add root README command list entries, and update
  `packages/rfapps-cli/README.md`.
- **MIRROR**: Documentation structure from existing doctor/audit docs.
- **IMPORTS**: Documentation only.
- **GOTCHA**: `docs/README.md` links `docs/reference/rfapps-cli-reference.md`, which is currently
  absent; do not create or depend on that reference file unless the implementation intentionally
  addresses that docs gap.
- **VALIDATE**: `npm run lint:md`

### Task 5.1: Final Integration Validation — Depends on 4.1, 4.2, 4.3

- **BATCH**: B5
- **ACTION**: Run final focused and full validation after all code, completion, MCP, and docs
  changes land.
- **IMPLEMENT**: Run targeted drift/completion/MCP tests first, then workspace
  typecheck/build/lint/test commands. Fix failures in the smallest affected area without broad
  refactors.
- **MIRROR**: Existing npm validation scripts from root `package.json` and
  `packages/rfapps-cli/package.json`.
- **IMPORTS**: None.
- **GOTCHA**: Do not claim drift output is secret-safe until JSON serialization has been explicitly
  tested.
- **VALIDATE**: `npm run test:rfapps && npm run build:rfapps && npm run lint`

---

## Testing Strategy

### Unit Tests

| Test                                              | Input                                                | Expected Output                                             | Edge Case? |
| ------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| Runtime status drift for missing selected service | Service in compose but no live container             | `runtime-status` drift finding                              | Yes        |
| Runtime status drift for exited selected service  | Docker state `exited`                                | Drift finding with typed state                              | Yes        |
| Runtime health drift                              | Docker health `unhealthy`                            | Drift finding includes health                               | Yes        |
| Healthy running service                           | Docker state `running`, health `healthy` or `none`   | No runtime-status drift                                     | No         |
| Secret env drift JSON                             | Env key like `DB_PASSWORD` differs                   | Serialized result contains mask, not raw value              | Yes        |
| Detect drift exit code                            | Drift result has findings                            | `process.exitCode = 1` after output                         | No         |
| Report-only override                              | Drift result has findings and report-only option set | Exit code remains success                                   | No         |
| Detect execution failure                          | `detectDrift` returns `undefined`                    | Formatted stderr error and non-zero exit                    | Yes        |
| Detect/read-only boundary                         | Detect/show execution                                | No `startServices`, `writeFile`, or `copyFile` calls        | Yes        |
| Completion generation                             | New drift flags                                      | Bash/zsh/fish scripts include flags and service completions | No         |
| MCP schema                                        | Drift categories include `runtime-status`            | Schema accepts versioned drift result                       | No         |

### Edge Cases Checklist

- [ ] No matching services after target selection.
- [ ] Compose service exists but container is missing.
- [ ] Container is exited, created, restarting, dead, or paused.
- [ ] Container health is `healthy`, `unhealthy`, `starting`, or absent.
- [ ] Secret env values differ and machine output is requested.
- [ ] `--json` output with non-zero drift-found exit.
- [ ] Report-only override with drift found.
- [ ] `reconcile` and `import` still mutate only through explicit subcommands.
- [ ] Bash, zsh, and fish completions include new drift flags.
- [ ] MCP read tools stay read-only while mutation tools remain separate.

---

## Validation Commands

### Static Analysis

```bash
npm run typecheck -w packages/rfapps-cli
```

EXPECT: Zero type errors.

### Focused Unit Tests

```bash
npm run test:rfapps -- --run packages/rfapps-cli/src/lib/drift.spec.ts packages/rfapps-cli/src/actions/drift.spec.ts packages/rfapps-cli/src/actions/completion.spec.ts packages/rfapps-cli/src/mcp/schema.spec.ts packages/rfapps-cli/src/mcp/adapters.spec.ts
```

EXPECT: Drift, completion, and MCP tests pass.

### Build

```bash
npm run build:rfapps
```

EXPECT: rfapps CLI and shared package build successfully.

### Documentation Lint

```bash
npm run lint:md
```

EXPECT: Markdown docs pass linting.

### Full Test Suite

```bash
npm run test:rfapps
```

EXPECT: No rfapps regressions.

### Repository Lint

```bash
npm run lint
```

EXPECT: Typecheck and markdown lint pass.

### Manual Validation

- [ ] `rfapps drift detect --json` emits `schemaVersion` and masks secret env values.
- [ ] `rfapps drift detect --json` exits non-zero when drift exists.
- [ ] `rfapps drift detect --report-only --json` exits zero when drift exists.
- [ ] `rfapps drift detect --show-unchanged` still includes unchanged services in human output.
- [ ] `rfapps completion bash`, `zsh`, and `fish` include the new drift options.
- [ ] `rfapps drift --help` clearly separates read-only and mutating paths.

---

## Acceptance Criteria

- [ ] `rfapps drift` registration is extracted to `packages/rfapps-cli/src/commands/drift.ts` with
      behavior preserved.
- [ ] Drift results include `schemaVersion` and `runtime-status` as a first-class category.
- [ ] Runtime-status drift covers selected services' missing/exited/problem states and Docker health
      when present.
- [ ] Secret env values are masked in human and machine output.
- [ ] Detect/show are read-only by default and tested against mutation calls.
- [ ] Drift-found exit behavior is non-zero by default with a report-only override.
- [ ] MCP drift schemas and adapters align with the versioned result contract.
- [ ] Bash, zsh, and fish completions include new drift options.
- [ ] Drift documentation covers scheduler examples, update workflow usage, JSON output, MCP,
      completions, and explicit mutation boundaries.
- [ ] Focused tests, build, typecheck, docs lint, and rfapps test suite pass.

## Completion Checklist

- [ ] Code follows discovered command/action/lib/type separation.
- [ ] Error handling matches formatted stderr plus exit-code conventions.
- [ ] Logging keeps human text on stderr and structured output on stdout.
- [ ] Tests follow existing Vitest mock patterns.
- [ ] No hardcoded secrets or raw secret drift payloads.
- [ ] Documentation updated across feature docs, shell completion docs, JSON/output docs, MCP docs,
      READMEs, and quick reference.
- [ ] No daemon, automatic reconciliation, or unrelated command-registry refactor added.
- [ ] Self-contained — no questions needed during implementation.

## Risks

| Risk                                             | Likelihood | Impact | Mitigation                                                                        |
| ------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------- |
| Machine output leaks secret env values           | M          | H      | Sanitize before all renderers and add serialized JSON assertions                  |
| Runtime-status drift is noisy during deployments | M          | M      | Limit v1 to selected-service live state/health and document transient states      |
| Completion updates drift across bash/zsh/fish    | M          | M      | Update all shell sections in one task and add generated-script tests              |
| MCP schema diverges from TypeScript drift types  | M          | H      | Update `types/drift.ts` and `mcp/schema.ts` in the same batch with tests          |
| Command extraction changes behavior accidentally | M          | M      | Preserve lazy imports/options and add help/build validation                       |
| Docs overstate update automation                 | L          | M      | Phrase drift as a signal for update/reconcile workflows, not an automatic updater |

## Notes

- Research dispatch: parallel sub-agents covering patterns, quality, and infrastructure.
- Execution mode: parallel with 5 batches and max width 4.
- Worktree mode: disabled via `--no-worktree`; this plan intentionally omits a `## Worktree Setup`
  section.
- Existing drift mutating subcommands should remain explicit opt-in paths under `rfapps drift` for
  this plan.
- No external docs are required; the feature is built from internal CLI, Docker helper, MCP,
  completion, and docs patterns.
