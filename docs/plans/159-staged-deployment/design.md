# Staged Deployment Mode for `rfapps deploy` (#159)

Authoritative design. Every path, line anchor, signature, and type referenced below was
verified against the worktree at commit `e05098b1`.

---

## 1. Problem and goals

### Problem

`rfapps deploy -g media-stack` deploys 13 services at once. In parallel mode
(`packages/rfapps-cli/src/actions/deploy.ts:474-739`) it issues one pull sweep across every
dependency phase, then one start sweep across every dependency phase, then checks readiness
exactly once at the end. There is no point at which the operator learns "the first service came
up broken" before the other twelve have already been recreated. The blast radius of a bad image
or a bad config is the entire group.

### Goals

1. Deploy a group in dependency-ordered batches, smallest-blast-radius first.
2. Gate each batch on the health of the services that batch just deployed, then continue.
3. Halt by default when a batch fails, and report the untouched services truthfully so the exit
   code, the JSON document, and `rfapps history` all agree.
4. Reuse the existing dependency-phase computation, the existing parallel executor, and the
   existing target-classification rules. Introduce no new topological algorithm, no new health
   vocabulary, and no new exit code.
5. Keep the non-staged path byte-identical in behaviour by making it the same code path with a
   single batch.

### Non-goals

- **No new exit code.** The 0/1/2/3 contract in `packages/rfapps-cli/src/lib/exit-codes.ts:6-11`,
  `packages/rfapps-cli/src/cli.ts:126-133`, and `packages/rfapps-cli/README.md:764-771` is fixed.
  A halted rollout maps onto 1 (or 3 with `--allow-partial`).
- **No state-DB schema change.** No `run_id`, no `batch_index`, no overloading of `plan_id`.
- **No `--resume` command and no persisted rollout state.** Batches are idempotent; re-running
  the printed resume command is the resume.
- **No `staged:` config block.** Every knob is a flag with a constant default. This avoids
  editing 22 spec fixtures (verified: 22 files under `packages/rfapps-cli/src` match
  `parallel: {`, 13 of them annotate `: RfappsConfig`) and avoids the MCP trap described in §7.
- **No inter-batch interactive prompt and no inter-batch soak delay.** The state lock is acquired
  in the Commander `preAction` hook (`packages/rfapps-cli/src/cli.ts:260-263`) and released in
  `main()`'s `finally` (`packages/rfapps-cli/src/cli.ts:637-653`). Blocking on a human would hold
  a process-global mutation lock.
- **No changes to the sequential deploy path.** `--staged` implies phased execution.
- **No staged mode for `rebuild`.** The coordinator is deploy-agnostic so `rebuild` can adopt it
  later; that is a follow-up.

### Correction to the issue's file list

The issue names `packages/rfapps-cli/src/lib/deploy-groups.ts` and
`packages/rfapps-cli/src/commands/deploy.ts`. **Neither exists.** Group expansion is
`expandServiceGroup` at `packages/rfapps-cli/src/lib/services.ts:60`, reached from
`resolveServicesWithInteractive` at `packages/rfapps-cli/src/lib/interactive-selection.ts:95`, and
the deploy command is registered inline at `packages/rfapps-cli/src/cli.ts:347-385`. Groups are
flattened to `services: string[]` before `executeDeploy` runs, so staging keys off the resolved
service list plus the dependency graph, never off group identity.

---

## 2. CLI surface

### New flags

Registered in the existing inline deploy chain at `packages/rfapps-cli/src/cli.ts:347-385`,
inserted after `--workers` (line 363) and before `--wait-for-ready` (line 364). `Option` is
already imported at `packages/rfapps-cli/src/cli.ts:28`.

```ts
  .option("--staged", "Roll out services in dependency-ordered batches with a health gate")
  .option("--batch-size <count>", "Services per staged batch")
  .addOption(
    new Option("--on-failure <policy>", "Staged batch failure policy").choices([
      "halt",
      "continue",
    ]),
  )
```

| Flag                    | Type                   | Commander default | Resolved default | Notes                                                                            |
| ----------------------- | ---------------------- | ----------------- | ---------------- | -------------------------------------------------------------------------------- |
| `--staged`              | tri-state boolean      | _none_            | `false`          | Omits an explicit `false` default, matching `--parallel` at `cli.ts:362`         |
| `--batch-size <count>`  | string to int          | _none_            | `1`              | Matches `--workers` at `cli.ts:363`; validated as a positive integer             |
| `--on-failure <policy>` | `"halt" \| "continue"` | _none_            | `"halt"`         | `.choices()` for fail-fast; no `.default()` so an unset value is distinguishable |

**Description constraint honoured.** `getLongOptionNames`
(`packages/rfapps-cli/src/actions/completion.spec.ts:144-146`) regex-extracts `--([a-z][a-z-]*)`,
and the `/^\s+-/` help-line filter that feeds it is at
`packages/rfapps-cli/src/actions/completion.spec.ts:159`, inside `getCommanderCommandOptions`
(`:148-164`), which spawns the real CLI at `:151`. None of the three descriptions contains a
`--flag` token, so no phantom expected option is manufactured. Empirically verified: the expected
option set becomes exactly 19 = 16 existing + `batch-size` + `on-failure` + `staged`.

### Help text

Appended to the existing `addHelpText("after", …)` block at
`packages/rfapps-cli/src/cli.ts:373-381`. No line begins with a dash and no `--` token appears,
so option extraction is unaffected.

```text
Exit codes:
  0  Success
  1  Operational error
  2  Usage error
  3  Partial success with --allow-partial

Staged rollout:
  Batches are gated on the health of the services they just deployed. A failed
  batch halts the rollout by default; services in later batches are reported as
  not attempted and keep running their previous containers. Staged mode always
  uses dependency-phased execution, even when parallel execution is disabled in
  config.
```

### Interaction with existing flags

| Flag                                                                                                 | Interaction                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--parallel`                                                                                         | `--staged` **implies** phased execution: `useParallel = staged \|\| (options.parallel ?? finalConfig.parallel.enabled)`. The sequential path (`actions/deploy.ts:740-1022`) issues one `docker compose up -d` for the whole set and has no per-service seam. There is no `--no-parallel` flag, so no expressible conflict exists. Emitted once in text mode when config had it off: `logInfo("--staged uses dependency-phased execution")`. |
| `--workers`                                                                                          | Unchanged. Caps concurrency _within_ a batch; effective concurrency is `min(workers, batch.services.length)`.                                                                                                                                                                                                                                                                                                                               |
| `--dry-run`                                                                                          | Stays lock-free (`cli.ts:79-81` short-circuits lock acquisition), Docker-mutation-free, and DB-free. Prints the batch plan instead of `formatExecutionPlan`. Reuses the single `docker compose config` shell-out the existing `--parallel --dry-run` branch already performs.                                                                                                                                                               |
| `--yes`                                                                                              | Unchanged. The confirm prompt at `actions/deploy.ts:423-431` is pre-rollout and asks once for the whole rollout. There is no per-batch prompt.                                                                                                                                                                                                                                                                                              |
| `-s` / `--services` / `-g`                                                                           | Unchanged. Staging operates on the resolved `services: string[]`, so `-s one-service --staged` degenerates to a single-batch rollout with a target gate (`logDebug` only, not an error).                                                                                                                                                                                                                                                    |
| `--validate-first`                                                                                   | Composes. Batching is computed from the post-validation `effectiveServices` closure (which replaces `services` at `actions/deploy.ts:331`) and from `preparedValidationGraph` (`actions/deploy.ts:433-456`), which uses `validationDependencyGraph()` rather than a second `docker compose config`. `revalidateDeployBinding` still runs exactly once (§6).                                                                                 |
| `--allow-partial`                                                                                    | Unchanged semantics. A halted rollout with at least one healthy service exits 3; otherwise 1.                                                                                                                                                                                                                                                                                                                                               |
| `--skip-pull` / `--force-recreate` / `--health-timeout` / `--no-wait-for-ready` / `-f` / `-e` / `-p` | Threaded per batch unchanged.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--output csv`                                                                                       | Legal (the csv guard at `cli.ts:174-185` is `--validate-first`-specific). `staged` is stripped for **both** `table` and `csv` in `deployResultForOutput`.                                                                                                                                                                                                                                                                                   |

### Usage errors (exit 2)

Duplicated in the `preAction` hook and the action, matching the existing `--validate-first` +
`--output csv` precedent (`cli.ts:174-185` and `actions/deploy.ts:227-234`). `InvalidArgumentError`
is registered with `exitCode: ExitCode.UsageError` at
`packages/rfapps-cli/src/lib/error-formatters.ts:239-256`.

```ts
// packages/rfapps-cli/src/cli.ts — new sibling block after line 185
if (commandName === "deploy") {
  const opts = actionCommand.opts();
  const rawBatchSize: unknown = opts["batchSize"];
  const staged = opts["staged"] === true;

  if (!staged && (rawBatchSize !== undefined || opts["onFailure"] !== undefined)) {
    throw new InvalidArgumentError(
      "--batch-size",
      String(rawBatchSize ?? opts["onFailure"]),
      "Staged rollout options require --staged",
    );
  }
  if (rawBatchSize !== undefined && !/^[1-9][0-9]*$/.test(String(rawBatchSize))) {
    throw new InvalidArgumentError("--batch-size", String(rawBatchSize), "Batch size must be a positive integer");
  }
}
```

An invalid `--on-failure` value is rejected by Commander `.choices()` before the action runs.

### MCP surface — deliberately asymmetric

**Input flags are NOT mirrored.** `DeployToolArgs` (`packages/rfapps-cli/src/mcp/schema.ts:76-83`)
and `deployInputSchema` (`packages/rfapps-cli/src/mcp/schema.ts:754-764`) already omit
`validateFirst` and `allowPartial`; no test enforces CLI/MCP deploy parity. `--staged` follows
that precedent.

**The output field IS declared.** This is mandatory insurance, not optional. Verified chain:

- `packages/rf-common/src/mcp/core.ts:82` runs `return tool.outputSchema.parse(rawResult);` on
  every tool call.
- `packages/rfapps-cli/src/mcp/tools-mutate.ts` wires `outputSchema` from
  `rfappsMcpSchemas.deploy.output`, which is `withDryRun(deployResultSchema)`
  (`packages/rfapps-cli/src/mcp/schema.ts:919`).
- `deployResultSchema` (`packages/rfapps-cli/src/mcp/schema.ts:280-286`) is built with
  `schemaObject` and no `allowUnknownProperties`, so its jsonSchema sets
  `additionalProperties: false` (`packages/rf-common/src/mcp/schema.ts:397`) and its parser calls
  `fail(path, "no additional properties", …)` (`packages/rf-common/src/mcp/schema.ts:423-436` —
  the guard opens at `:423` and the `fail(` call closes at `:436`). It **throws**; it does not
  strip. Empirically verified: parsing a valid `DeployResult` carrying an extra `staged` key throws
  `McpSchemaValidationError` whose `issues[0]` is
  `{ expected: "no additional properties", message: "Unexpected properties at $: staged" }`.
  Because `withDryRun` wraps the object schema in `schemaUnion`, the surfaced `Error.message` is
  `"No union variant matched at $"` — any assertion must target `.issues`, not `.message`.

So the moment `DeployResult.staged` is present on the MCP path, the deploy fails validation after
successfully mutating the fleet. Because we do not mirror the input flag, `result.staged` can
never be set there today — but that safety is invisible and one careless future commit away from
breaking. Declaring the field costs eight lines and removes the trap permanently:

```ts
// packages/rfapps-cli/src/mcp/schema.ts — beside deployResultSchema
const stagedSummarySchema = schemaObject({
  status: schemaEnum(["completed", "halted", "degraded"] as const),
  batchSize: schemaNumber({ integer: true, minimum: 1 }),
  onFailure: schemaEnum(["halt", "continue"] as const),
  totalBatches: schemaNumber({ integer: true, minimum: 0 }),
  completedBatches: schemaNumber({ integer: true, minimum: 0 }),
  haltedAtBatch: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
});

const deployResultSchema = schemaObject({
  services: schemaArray(schemaString()),
  failed: schemaArray(failedOperationSchema),
  healthy: schemaArray(schemaString()),
  unhealthy: schemaArray(schemaString()),
  started: schemaNumber({ integer: true, minimum: 0 }),
  staged: schemaOptional(stagedSummarySchema),
});
```

`schemaEnum` is already imported at `packages/rfapps-cli/src/mcp/schema.ts:4`; `schemaArray`,
`schemaNumber`, `schemaObject`, `schemaOptional`, `schemaString` and `type McpSchema` are all
already present at `:1-11`, so **no new schema helper import is needed**. What _is_ needed and is
easy to miss: `StagedRolloutSummary` must be added to the
`import type { … } from "../types/index.js";` block at
`packages/rfapps-cli/src/mcp/schema.ts:13-34`, or the file will not typecheck.

Add `stagedSummary: McpSchema<StagedRolloutSummary>` to the `_typeCheck` anchor
(`packages/rfapps-cli/src/mcp/schema.ts:1017-1035`) so schema/type drift becomes a compile error.
That block is a type-annotated const with a parallel value literal, so **two** lines are required:
`stagedSummary: McpSchema<StagedRolloutSummary>;` in the type literal and
`stagedSummary: stagedSummarySchema,` in the value literal. Note `deployResult` is _not_ currently
anchored there, which is exactly why an undeclared field would compile cleanly and fail at runtime.
Anchoring `deployResult: McpSchema<DeployResult>` is **not** possible today because
`DeployResult.validation?: ConflictValidationResult` (`packages/rfapps-cli/src/types/results.ts:118`)
is itself undeclared in `deployResultSchema`; closing that residual trap is filed as follow-up
work, not part of #159.

---

## 3. Type model

### `packages/rfapps-cli/src/types/staged.ts` (new)

```ts
import type { EnvToolExecConfig } from "./options.js";
import type { ExecutionPhase } from "./parallel.js";
import type { FailedOperation } from "./results.js";
import type { TargetVerificationResult } from "./health.js";

/** How a staged rollout reacts to a batch that does not fully succeed. */
export type StagedFailurePolicy = "halt" | "continue";

/** Runtime narrowing for the raw Commander value. */
export function isStagedFailurePolicy(value: unknown): value is StagedFailurePolicy {
  return value === "halt" || value === "continue";
}

/**
 * Docker execution options threaded through every batch call.
 *
 * Structurally identical to
 * `Pick<DockerComposeExecOptions, "cwd" | "env" | "replaceEnv" | "envFile" | "projectName">
 *  & { envTool?: EnvToolExecConfig }`, declared inline so `src/types/` keeps its
 * zero-dependency rule on `src/lib/`. Both shapes `actions/deploy.ts` produces for
 * `deployExecution` assign to it: `{ envTool }` and `composeExecutionOptions(binding)`.
 */
export interface StagedExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  replaceEnv?: boolean;
  envFile?: string;
  projectName?: string;
  envTool?: EnvToolExecConfig;
}

/**
 * Everything a batch needs to reach Docker.
 *
 * `projectDir` and `profiles` are REQUIRED on purpose. `composeExecutionOptions`
 * (`lib/deploy-validation.ts:775-785`) returns neither, and TypeScript does not
 * excess-property-check spread expressions — so spreading `deployExecution` alone
 * into `getServiceStatusMap(composePath, projectDir, {...})` would silently drop
 * `cwd` (that function takes `projectDir` as a required 2nd positional,
 * `lib/service-status.ts:199-203`, and `GetServiceStatusMapOptions` has no `cwd`
 * key, `:149-170`) and silently omit `profiles` (consumed for both
 * `getComposeServices` at `:231` and the `--profile` argv at `:253`). Making them
 * required converts two silent divergences into compile errors.
 */
export interface StagedExecutionContext {
  composePath: string;
  projectDir: string;
  profiles: string[];
  exec: StagedExecOptions;
}

/**
 * One planned rollout batch.
 *
 * `phases` is a slice of the source `DependencyGraph.phases` restricted to this
 * batch's members, with the ORIGINAL phase numbers and `dependsOn` preserved.
 * Passing it to `executeParallelPhases` therefore keeps dependency ordering
 * inside the batch, because that function iterates phases sequentially
 * (packages/rfapps-cli/src/lib/parallel-executor.ts:78).
 */
export interface StagedBatch {
  /** 1-based index across the whole rollout */
  index: number;
  /** Members in blast-radius order (least critical first) */
  services: string[];
  /** Phase-preserving slice for executeParallelPhases */
  phases: ExecutionPhase[];
}

/** The batch plan derived from a DependencyGraph. */
export interface StagedPlan {
  batches: StagedBatch[];
  batchSize: number;
  onFailure: StagedFailurePolicy;
  totalServices: number;
}

/**
 * Gate verdict reasons.
 *
 * Reuses `TargetVerificationResult["reason"]` verbatim (types/health.ts:156-167)
 * and adds exactly one staged-only value for a completed one-shot container.
 */
export type StagedGateReason = TargetVerificationResult["reason"] | "completed";

/** Per-service verdict from one batch gate. */
export interface StagedServiceVerdict {
  service: string;
  status: "ready" | "pending" | "failed";
  reason: StagedGateReason;
  /** "healthcheck" when the container declares one, else "running-only" */
  assurance: "healthcheck" | "running-only";
  stableForMs: number;
}

/** Outcome of one batch's health gate. */
export interface StagedGateReport {
  ready: boolean;
  timedOut: boolean;
  /** True when container telemetry was unavailable; the gate degrades to a warning */
  degraded: boolean;
  elapsedMs: number;
  attempts: number;
  services: StagedServiceVerdict[];
}

/** Stable machine-readable reason a batch is terminal-failed. */
export type StagedBatchFailureCause = "dependency-skipped" | "start-failed" | "gate-unready" | "gate-timeout";

interface StagedBatchOutcomeBase {
  batch: StagedBatch;
  /**
   * Every failure attributable to this batch, including PULL failures — which
   * never set `cause` but must still reach `DeployResult.failed`, because
   * `actions/deploy.ts:518-522` pushes them today and `resolveDeployExitCode`
   * turns a non-empty `failed[]` into exit 1. `failed[]` lives on the BASE, not
   * on `StagedBatchFailed`, precisely so a `passed` batch can carry pull
   * failures without losing them.
   */
  failed: FailedOperation[];
}

export interface StagedBatchPassed extends StagedBatchOutcomeBase {
  status: "passed";
  started: string[];
  /** Undefined when gating is disabled via --no-wait-for-ready */
  gate?: StagedGateReport;
}

export interface StagedBatchFailed extends StagedBatchOutcomeBase {
  status: "failed";
  /** Services whose `up` succeeded; may be non-empty when only the gate failed */
  started: string[];
  /** Started but not ready at the gate bound. Empty when no gate ran. */
  unhealthy: string[];
  cause: StagedBatchFailureCause;
  /** Undefined when the batch failed before a gate could run */
  gate?: StagedGateReport;
}

export interface StagedBatchSkipped extends StagedBatchOutcomeBase {
  status: "skipped";
  reason: "rollout-halted";
}

export type StagedBatchOutcome = StagedBatchPassed | StagedBatchFailed | StagedBatchSkipped;

/** completed = every batch passed; halted = a batch failed under "halt"; degraded = a batch failed under "continue". */
export type StagedRolloutStatus = "completed" | "halted" | "degraded";

/**
 * Full internal evidence PLUS the flat projection `actions/deploy.ts` copies into
 * `DeployResult`. The projection lives here rather than in a separate pure
 * function because `actions/deploy.spec.ts:14` bare-automocks `../lib/index.js`:
 * a separate projector would return `undefined` in the action-level tests and the
 * `STAGE_NOT_ATTEMPTED` synthesis would go untested.
 */
export interface StagedRolloutReport {
  status: StagedRolloutStatus;
  batchSize: number;
  onFailure: StagedFailurePolicy;
  totalBatches: number;
  completedBatches: number;
  haltedAtBatch?: number;
  batches: StagedBatchOutcome[];
  /** Services a Docker start was ISSUED for (succeeded ∪ failed). Scopes orphan cleanup and the DB inspect. */
  attempted: string[];
  /** Sum of started counts across non-skipped batches. */
  started: number;
  /** Started services minus `unhealthy`. */
  healthy: string[];
  /** Started but not ready at a gate bound. Empty when no gate ran anywhere. */
  unhealthy: string[];
  /** Σ batch.failed + one STAGE_NOT_ATTEMPTED entry per member of every skipped batch. */
  failed: FailedOperation[];
}

/** Flat projection embedded in DeployResult for machine output and MCP. */
export interface StagedRolloutSummary {
  status: StagedRolloutStatus;
  batchSize: number;
  onFailure: StagedFailurePolicy;
  totalBatches: number;
  completedBatches: number;
  haltedAtBatch?: number;
}

/** Human-facing progress events. The coordinator never prints. */
export type StagedRolloutEvent =
  | { kind: "batch-start"; batch: StagedBatch; totalBatches: number }
  | { kind: "gate-progress"; batch: StagedBatch; pending: string[] }
  | { kind: "batch-passed"; batch: StagedBatch; started: string[] }
  | {
      kind: "batch-failed";
      batch: StagedBatch;
      cause: StagedBatchFailureCause;
      failed: string[];
      unhealthy: string[];
    }
  | { kind: "gate-degraded"; batch: StagedBatch }
  | { kind: "rollout-halted"; haltedAtBatch: number; skipped: string[] };
```

Re-exported from `packages/rfapps-cli/src/types/index.ts` in a new `// Staged rollout types` block
beside the parallel block.

### `packages/rfapps-cli/src/types/results.ts` — one added field

`DeployResult` currently ends at line 118 with `validation?: ConflictValidationResult;`. Add:

```ts
  /** Staged rollout summary, present only when --staged was used */
  staged?: StagedRolloutSummary;
```

**Why the flat summary and not the full report.** `DeployResult` is consumed by
`resolveDeployExitCode` (`lib/exit-codes.ts:46`), the strict MCP output schema, and `renderTable`.
Every per-service staged fact is already expressible through the existing `healthy` / `unhealthy` /
`failed` arrays (a never-attempted service lands in `failed` with `code: "STAGE_NOT_ATTEMPTED"`).
Serializing `batches[]` would force a large hand-rolled nested MCP schema and a table projection
for zero new information.

### `packages/rfapps-cli/src/types/options.ts` — `DeployOptions` (lines 86-103)

```ts
  /** Roll out services in dependency-ordered batches with a health gate */
  staged?: boolean;
  /** Services per staged batch */
  batchSize?: number;
  /** Staged batch failure policy */
  onFailure?: StagedFailurePolicy;
```

### `packages/rfapps-cli/src/actions/deploy.ts` — `RawDeployOptions` (lines 84-100)

```ts
  staged?: boolean;
  batchSize?: number | string;
  onFailure?: string;
```

### Staged gate observation type (`packages/rfapps-cli/src/lib/staged-gate.ts`)

`TargetServiceObservation` (`types/health.ts:131-140`) carries `imageId`, `state`, `exitCode`,
`health` but not the restart policy, which the one-shot exemption needs. Rather than widen a type
that `managed-update` and `reconcile` depend on, the staged gate extends it locally:

```ts
import type { TargetServiceObservation } from "../types/health.js";

/**
 * A batch-gate observation. Superset of TargetServiceObservation with the
 * container restart policy, needed to exempt completed one-shot jobs.
 *
 * `restartPolicy` mirrors ContainerInspect.HostConfig.RestartPolicy.Name
 * (packages/rfapps-cli/src/lib/docker.ts:2036-2039). Docker emits "", "no",
 * "always", "unless-stopped", or "on-failure".
 */
export interface StagedServiceObservation extends TargetServiceObservation {
  restartPolicy?: string;
}
```

---

## 4. Batching algorithm

### Inputs

`planStagedBatches` is pure — no Docker, no I/O, no logging. It consumes the `DependencyGraph`
that `computeExecutionPhases` (`packages/rfapps-cli/src/lib/dependency-graph.ts:510`) already
produces, which is Kahn's algorithm with explicit phase grouping, sidecar co-phasing, and cycle
detection (`packages/rfapps-cli/src/lib/dependency-graph.ts:297-383`). **No new topological logic
is written.**

```ts
export function planStagedBatches(input: {
  graph: DependencyGraph;
  batchSize: number;
  onFailure: StagedFailurePolicy;
  /** RfappsConfig.profiles.mapping — service to profile name */
  profileMapping: Readonly<Record<string, string>>;
}): StagedPlan;
```

### Steps

1. **Reverse fan-in.** From `graph.dependencyMap` (present whenever `!hasCycles`,
   `types/parallel.ts:80-81`), for each `[service, deps]` increment `fanIn[dep]` for every dep. If
   `dependencyMap` is `undefined`, every service gets fan-in 0 and the plan degrades gracefully to
   phase order — see "Missing dependency map" below.
2. **Order within each phase** by the composite key `[criticalityTier, fanIn, name]` ascending,
   where `criticalityTier = profileMapping[service] === "core" ? 1 : 0`.
3. **Flatten** phases in phase order, concatenating each phase's ordered services.
4. **Chunk** the flat list into slices of at most `batchSize`.
5. **Slice phases per batch.** For each batch, walk the source `graph.phases`, filter each phase's
   `services` to the batch members, drop now-empty phases, and **preserve the original `phase`
   number and `dependsOn`**. The result is a valid `ExecutionPhase[]` that `executeParallelPhases`
   consumes unmodified.

### Why criticality tier is load-bearing

Verified against `rfapps.config.yaml`: `profiles.mapping` assigns `core` to exactly `docktail`,
`traefik`, `cloudflared`, `authentik-server`, `authentik-media`, `authentik-worker`,
`authentik-db`, and `authentik-redis`. Fan-in alone is insufficient because Traefik is depended on
through **Traefik routing labels**, not `depends_on`, so its `depends_on` fan-in is 0. Verified
compose totals: **49 services, only 14 `depends_on` blocks**, so most services land in phase 0 and
`topologicalSort` sorts them alphabetically. Without the tier, `rfapps deploy -g infra-stack
--staged --batch-size 1` would canary `cloudflared` — the external tunnel — and recreate `traefik`
mid-rollout while later batches are still pending. With the tier, the entire ingress path is
deployed last.

### Why batches may span a phase boundary

A batch that spans phases is safe **because the phase slice preserves phase numbers**.
`executeParallelPhases` iterates `phases` in a sequential `for` loop
(`packages/rfapps-cli/src/lib/parallel-executor.ts:78`) and only parallelises _within_ a phase, so
a service and its dependency inside the same batch still start in the correct order — exactly the
guarantee today's non-staged parallel deploy provides.

This is worth stating explicitly because a plausible objection is that flat chunking can co-locate
a service with its dependency. That objection only holds if the batch is collapsed into a single
synthetic `ExecutionPhase`, which this design does not do. The alternative — forbidding batches
from spanning phases — produces ragged undersized batches at every phase boundary and buys nothing
on a graph this flat.

### Missing dependency map

`computeExecutionPhases` returns a graph with **no** `dependencyMap` when `getComposeConfig`
returns `undefined` — it falls back to a single phase 0 containing every target
(`packages/rfapps-cli/src/lib/dependency-graph.ts:521-533`). This is reachable in practice (a
dotenvx decryption hiccup leaves `${DOCKER_DIR}` unresolved). Staging must **degrade, not
hard-fail**: fan-in becomes uniformly 0, ordering falls back to `[tier, name]`, and the
coordinator's cross-batch dependency skip falls back to the phase-level `dependsOn` rule that
`filterByDependencyFailures` already implements
(`packages/rfapps-cli/src/lib/parallel-executor.ts:380-382`). A safety flag that turns a working
deploy into a total no-op would be a regression, not a safety property.

### Worked example — `infra-stack`, `--batch-size 3`

From `rfapps.config.yaml`, `infra-stack` is: `docktail, traefik, cloudflared, homarr, uptime-kuma,
stirling-pdf, speedtest-tracker, ofelia, forgejo, forgejo-postgres, forgejo-runner,
forgejo-runner-2, forgejo-runner-3, forgejo-itcn-runner`.

Verified `depends_on` edges inside this target set: `forgejo` depends on `forgejo-postgres`; the
four runners depend on `forgejo`. `topologicalSort` therefore yields:

- Phase 0: `cloudflared, docktail, forgejo-postgres, homarr, ofelia, speedtest-tracker,
stirling-pdf, traefik, uptime-kuma`
- Phase 1: `forgejo`
- Phase 2: `forgejo-itcn-runner, forgejo-runner, forgejo-runner-2, forgejo-runner-3`

Ordering key per phase 0 member:

| Service           | tier | fanIn | key                       |
| ----------------- | ---- | ----- | ------------------------- |
| homarr            | 0    | 0     | (0, 0, homarr)            |
| ofelia            | 0    | 0     | (0, 0, ofelia)            |
| speedtest-tracker | 0    | 0     | (0, 0, speedtest-tracker) |
| stirling-pdf      | 0    | 0     | (0, 0, stirling-pdf)      |
| uptime-kuma       | 0    | 0     | (0, 0, uptime-kuma)       |
| forgejo-postgres  | 0    | 1     | (0, 1, forgejo-postgres)  |
| cloudflared       | 1    | 0     | (1, 0, cloudflared)       |
| docktail          | 1    | 0     | (1, 0, docktail)          |
| traefik           | 1    | 0     | (1, 0, traefik)           |

Flattening phases in phase order (step 3) gives this 14-element list:

```text
homarr, ofelia, speedtest-tracker, stirling-pdf, uptime-kuma, forgejo-postgres,
cloudflared, docktail, traefik, forgejo,
forgejo-itcn-runner, forgejo-runner, forgejo-runner-2, forgejo-runner-3
```

Chunking it flat into slices of 3 (step 4) gives `ceil(14 / 3) = 5` batches. Batches DO span phase
boundaries — that is the design's own rule, see "Why batches may span a phase boundary" above:

```text
Staged rollout: 5 batches (batch size 3, on failure: halt)
  Batch 1 [canary]  phase 0    homarr, ofelia, speedtest-tracker
  Batch 2           phase 0    stirling-pdf, uptime-kuma, forgejo-postgres
  Batch 3           phase 0    cloudflared, docktail, traefik
  Batch 4           phase 1-2  forgejo, forgejo-itcn-runner, forgejo-runner
  Batch 5           phase 2    forgejo-runner-2, forgejo-runner-3
```

The canary is three disposable infrastructure services. Reverse-proxy and tunnel land in batch 3,
after two successful gates. `forgejo-postgres` precedes `forgejo`, which precedes its runners, by
construction.

Batch 4 is the clearest illustration of why phase-number preservation matters: `forgejo` and two of
its own dependents share a batch, and they start in the correct order only because the batch's
phase slice keeps them in phases 1 and 2 and `executeParallelPhases` iterates phases in a
sequential `for` loop (`packages/rfapps-cli/src/lib/parallel-executor.ts:78`). Batch 5's runners
depend on batch 4's `forgejo` — the cross-batch dependency case T3 exercises.

### Second worked example — `media-stack`, single phase

`media-stack` is 12 services. `sonarr`, `radarr`, and `lidarr` declare `depends_on`,
but on `sabnzbd` / `nzbget`, which are **not** in `media-stack` —
`buildServiceDependencyGraph` filters dependencies to the target set
(`packages/rfapps-cli/src/lib/dependency-graph.ts:209-215`), so those edges vanish. The whole group
is therefore one phase, all tier 0, all fan-in 0, ordered alphabetically:

```text
bazarr, jellyfin, jellyseerr, kometa, lidarr, plex, plex-ratings-sync,
plexseerr, radarr, sonarr, tautulli, watchstate
```

With `--batch-size 1` that is 12 batches. Note `plex-ratings-sync` at position 7 — it is the
verified one-shot container that motivates the exemption rule in §5.

---

## 5. Health gate

### Primitive choice

The gate polls the **batch's own services**, classified by the _existing_
`classifyTargetObservation` (`packages/rfapps-cli/src/lib/health.ts:162-210`). It does **not** call
`waitForDependencyReadiness` per batch. Three verified reasons:

1. **A dependency-only gate is decorative.** `packages/rfapps-cli/src/lib/health.ts:735` computes
   `const allReady = totalDependencies === 0 || readyDependencies.length === totalDependencies;`.
   `buildDependencyMap` (`health.ts:424-439`) builds the work set from the `depends_on` edges of
   the targets. A canary of dependency-free services — the common case here, given 14 `depends_on`
   blocks across 49 services — yields `totalDependencies === 0` and passes **instantly**, before
   the container has started.
2. **The TCP probe would convert a probe weakness into a hard stop.** `waitForDependencyReadiness`
   resolves `probeHost = extractContainerIp(inspectData)` — the container's bridge IP — and dials
   it from the CLI host (`packages/rfapps-cli/src/lib/health.ts:623-690`). On a remote
   `DOCKER_HOST`, Docker Desktop, or a containerised CLI that connection can never succeed, so the
   probe stays `pending`. Critically, the `"container IP not available for probe"` branch at
   `packages/rfapps-cli/src/lib/health.ts:651-657` does **not** add to `unavailableSignals`, so the
   documented "signals unavailable, warn and continue" escape at `actions/deploy.ts:654-656` would
   never fire and the first batch would halt. `managed-update` already distrusts this probe enough
   to hard-pin `tcpProbeMode: "state-and-health-only"`. A target gate that never probes TCP avoids
   the class entirely.
3. **Cost.** `waitForDependencyReadiness` performs one `getComposeConfig` call with a 30-second
   timeout per invocation (`packages/rfapps-cli/src/lib/health.ts:767-779`). Calling it per batch
   per attempt is expensive; the batch-scoped observation below makes three Docker calls per
   attempt regardless of batch size and no compose-config call at all.

`verifyServiceReadiness` is also rejected: it mandates a non-optional `expectedImageId`
(`packages/rfapps-cli/src/lib/health.ts:74`) and nests a full dependency probe per service per
attempt.

### Batch-scoped observation

Three Docker calls per attempt, independent of batch size — a batched generalisation of the
per-service `inspectTargetService` (`packages/rfapps-cli/src/lib/health.ts:114-160`). The observer
takes a `StagedExecutionContext` (§3), so `projectDir` and `profiles` are supplied explicitly
rather than hoped for in a spread:

1. `getServiceStatusMap(ctx.composePath, ctx.projectDir, { ...ctx.exec, profiles: ctx.profiles,
preloadedServices: [...services], cacheTtlMs: 0, forceRefresh: true, timeoutMs: 15_000 })`.
   - `preloadedServices` is **mandatory**, not an optimisation. Without it `getServiceStatusMap`
     makes a second Docker call of its own for `getComposeServices`
     (`packages/rfapps-cli/src/lib/service-status.ts:229-238`) on top of its
     `docker compose ps -a --format json` (`:253-267`), making the real cost **four** calls per
     attempt, and it scopes the status map to the whole compose file instead of the batch. The
     field is declared at `packages/rfapps-cli/src/lib/service-status.ts:169` with the doc comment
     "Pre-fetched service list to skip redundant getComposeServices() call".
   - `cacheTtlMs: 0, forceRefresh: true` are **mandatory** or the gate reads pre-batch state from
     the 10-second module cache in `packages/rfapps-cli/src/lib/service-status.ts`.
   - `ctx.projectDir` is positional — spreading `ctx.exec` cannot supply it, because
     `GetServiceStatusMapOptions` has no `cwd` key.
2. `getRunningServiceContainerMap(ctx.composePath, { ...ctx.exec, profiles: ctx.profiles,
timeout: 15_000 })` — the field is `timeout`, **not** `timeoutMs`
   (`packages/rfapps-cli/src/lib/docker.ts:1001-1008`).
3. `inspectContainers(containerNames, { ...ctx.exec, timeout: 15_000 })`, skipped when (2) yields
   no names. Results are indexed by `Name` with the leading `/` stripped, because
   `inspectContainers` builds `["inspect", ...containerNames]`
   (`packages/rfapps-cli/src/lib/docker.ts:2071`) and returns the raw parsed docker output
   (`:2081`) with no re-association to the requested names. It also returns `undefined` for the
   **entire batch** if any single name fails to inspect (`:2075-2078`) — an all-or-nothing signal,
   not a partial list.

Per service:

```ts
{
  imageId: inspected?.Image,
  state: normalizeTargetState(statusMap.get(service)?.state),
  exitCode: inspected?.State.ExitCode,
  health: statusMap.get(service)?.health ?? "unknown",
  restartPolicy: inspected?.HostConfig.RestartPolicy?.Name,
}
```

`signalAvailability` records `"service-container-map"` when (2) is `undefined` and
`"container-inspect"` when (3) is `undefined`.

### Classification

A **projection step is mandatory**. `classifyTargetObservation` returns `TargetVerificationResult`,
which `extends TargetServiceObservation` (`packages/rfapps-cli/src/types/health.ts:146`) and so
carries `state` / `health` / `imageId` / `exitCode` / `imageMatches` but **not** `service`, which
`StagedServiceVerdict` requires. A bare ternary between the synthetic completed literal and the
classifier result does not assign to `StagedServiceVerdict` and will not compile. Map explicitly:

```ts
const verdict: StagedServiceVerdict = isCompletedOneShot(obs)
  ? { service, status: "ready", reason: "completed", assurance: "running-only", stableForMs: 0 }
  : (() => {
      const t = classifyTargetObservation(obs, obs.imageId ?? "", stableForMs, stableRunningMs);
      return {
        service,
        status: t.status,
        reason: t.reason,
        assurance: t.assurance,
        stableForMs: t.stableForMs,
      };
    })();
```

**`obs.imageId ?? ""` is verified safe and requires no signature change.** The branch order in
`classifyTargetObservation` places `if (observation.imageId === undefined) return { status:
"pending", reason: "telemetry-unavailable" }` (`health.ts:182-184`) **before**
`if (!imageMatches)` (`health.ts:185-187`). So when inspect telemetry exists the image assertion is
a tautology, and when it does not the result is a bounded `telemetry-unavailable` pending. Widening
`VerifyServiceReadinessOptions.expectedImageId` to optional was rejected — that field flows into
`managed-update` and a versioned on-disk plan schema.

### The one-shot exemption

```ts
/**
 * True for a container that ran to completion by design.
 *
 * Docker reports RestartPolicy.Name as "", "no", "always", "unless-stopped", or
 * "on-failure". A container with an always-restart policy that is `exited` is
 * genuinely broken and must still fail the gate.
 */
function isCompletedOneShot(obs: StagedServiceObservation): boolean {
  if (obs.state !== "exited" || obs.exitCode !== 0) return false;
  const policy = obs.restartPolicy ?? "";
  return policy === "" || policy === "no" || policy === "on-failure";
}
```

**This rule is required, not defensive.** Verified: `compose.yml:1326-1340` defines
`plex-ratings-sync` with `command: sync`, `restart: on-failure:10`, and no healthcheck; it is
driven by an Ofelia label `ofelia.job-run.plex-ratings-sync.schedule: "@every 6h"`
(`compose.yml:1360`), and it is a member of `media-stack` in `rfapps.config.yaml`. Once its sync
job finishes it sits at `exited (0)`. Without the exemption, `classifyTargetObservation` returns
`{ status: "failed", reason: "exited" }` (`health.ts:176-178`) — and so would the dependency
`container-state` probe (`health.ts:547-553`) — so `rfapps deploy -g media-stack --staged` would
halt at batch 7 and abandon six services because a scheduled job did exactly what it was
configured to do. Nothing depends on `plex-ratings-sync` and it is never a dependency of a target,
so today's deploy never gates on it; staging is what newly exposes it.

### Services with no docker healthcheck

Verified: **49 services, 38 `healthcheck:` blocks — 11 services have none**, including `docktail`
and all four Forgejo runners in `infra-stack`. Handled by the **existing** rule, adopted verbatim:

`classifyTargetObservation` sets `assurance = observation.health === "none" ? "running-only" :
"healthcheck"` (`health.ts:168-169`) and its terminal branch (`health.ts:206-209`) requires a
bounded stable-running soak:

```ts
if (stableForMs < stableRunningMs) return { ...base, status: "pending", reason: "stabilizing" };
return { ...base, status: "ready", reason: "ready" };
```

The gate accumulates `stableSince` per service and resets it on any deviation, through a newly
extracted predicate that single-sources the rule with `verifyServiceReadiness`:

```ts
// packages/rfapps-cli/src/lib/health.ts — extracted from the inline predicate at lines 903-907
/**
 * True when a healthcheck-less target satisfies every non-health precondition
 * and may therefore accumulate its bounded stable-running window.
 */
export function canAccumulateStableRunning(
  observation: TargetServiceObservation,
  expectedImageId: string | undefined,
): boolean {
  return (
    observation.health === "none" &&
    observation.state === "running" &&
    (expectedImageId === undefined || observation.imageId === expectedImageId) &&
    observation.exitCode === 0
  );
}
```

`verifyServiceReadiness` is refactored to call it — semantically identical, since
`options.expectedImageId` is a required `string` there.

Soak window: **5 seconds**, a module constant matching `stableRunningSeconds ?? 5` at
`packages/rfapps-cli/src/lib/health.ts:894`. Not exposed as a flag.

So a healthcheck-less service can neither hang nor pass instantly: it must stay `running` with
`exitCode 0` for 5 continuous seconds across at least two independent observations, within the
poll bounds.

Note the deliberate asymmetry with dependency probing, which classifies `health: "none"` as
immediately ready with `"no container health check configured"` (`health.ts:587-594`). That is
correct for a _dependency_ you did not touch and too weak for a service you just recreated. Both
existing behaviours are preserved in their existing roles; no third policy is invented.

### Poll loop

Bounded by **both** wall clock and attempt count, whichever fires first — identical semantics to
`packages/rfapps-cli/src/lib/health.ts:815-816` and `:924`. Fixed interval, **no backoff**.

`waitForBatchReady(options, injected)` takes `{ now, sleep, observe }` as an injected dependency
object, resolving `const pollSleep = injected.sleep ?? sleep;` against a module-private three-line
`sleep` — exactly the pattern `verifyServiceReadiness` already uses
(`packages/rfapps-cli/src/lib/health.ts:865-889`, private default at `:94-96`). No shared
`lib/timing.ts` module is introduced. **Accepted DRY cost:** the same three-line `sleep` helper now
exists in three files (`health.ts`, `action-helpers.ts`, `staged-gate.ts`) instead of two;
refactoring it out of two heavily-tested modules is unrelated to #159 and buys nothing functional.

```text
timeoutMs      = poll.timeoutSeconds * 1000
intervalMs     = poll.intervalSeconds * 1000
maxAttempts    = waitForReady ? Math.max(1, poll.retries) : 1
stableRunningMs = 5000
startedAt      = now()

for (attempt = 1; ; attempt++):
  observation = await observe(services)     // 3 docker calls
  observedAt  = now()

  per service:
    canAccumulateStableRunning(obs, undefined) ? (stableSince ??= observedAt)
                                               : stableSince.delete(service)
    stableForMs = stableSince.has(s) ? observedAt - stableSince.get(s)! : 0
    verdict     = <projection above>

  ready     = every verdict.status === "ready"
  anyFailed = some verdict.status === "failed"
  degraded  = observation.signalAvailability.available === false
  elapsed   = observedAt - startedAt
  timedOut  = !ready && !anyFailed && (elapsed >= timeoutMs || attempt >= maxAttempts)

  emit gate-progress when the pending signature changes
  if (ready || anyFailed || timedOut) return report
  await pollSleep(intervalMs)
```

**The `anyFailed` short-circuit is load-bearing**, not an optimisation. §6 distinguishes
`gate-unready` from `gate-timeout`, which is only coherent if a terminal `failed` classification
exits the loop immediately: any verdict `status === "failed"` returns
`{ ready: false, timedOut: false }` → coordinator cause `"gate-unready"`, while exhausting the
bound with only `pending` verdicts returns `{ ready: false, timedOut: true }` → cause
`"gate-timeout"`. Without it a crashed canary burns the full `--health-timeout` (60 s default)
while holding the state lock.

`poll` is the shared `ReadinessPollSettings` (`packages/rfapps-cli/src/types/health.ts:38-45`),
resolved from the exact CLI-flag-to-config chain deploy already uses
(`packages/rfapps-cli/src/actions/deploy.ts:253-257` and `:607-611`):

```ts
poll: {
  timeoutSeconds: healthTimeout,                     // --health-timeout ?? healthCheck.timeout (60)
  intervalSeconds: finalConfig.healthCheck.interval,  // 5
  retries: finalConfig.healthCheck.retries,           // 12
}
```

So `--health-timeout` and `healthCheck.*` keep uniform meaning across deploy / rebuild / apply /
health. The budget is **per batch**: worst case per batch is
`min(healthTimeout, retries × interval)` seconds. Before the first Docker call the action prints
the worst-case rollout duration and warns when it exceeds `STATE_LOCK_STALE_AFTER_MS`
(10 minutes, `packages/rfapps-cli/src/lib/state-lock.ts:24`).

### Degraded telemetry never halts

When `signalAvailability.available === false` **and** no service in the batch is classified
`failed`, the batch gate returns `degraded`, emits `gate-degraded`, counts the batch's started
services healthy, and the rollout continues. This mirrors the established behaviour at
`packages/rfapps-cli/src/actions/deploy.ts:654-656` and `:883-885`. A `docker inspect` hiccup must
not abandon a fleet rollout half-deployed. Any service classified `failed` is a real failure and
fails the batch regardless.

**Verified not to mask real failures.** If any container in the batch fails to inspect,
`inspectContainers` returns `undefined` for the whole batch
(`packages/rfapps-cli/src/lib/docker.ts:2075-2078`), making every `imageId` undefined. But `state`
comes from `getServiceStatusMap` independently, and `classifyTargetObservation` tests
`state === "exited"` at `health.ts:176` **before** `imageId === undefined` at `:182`, so a
genuinely crashed service still classifies `failed` and still fails the batch regardless of the
degraded flag. This reasoning belongs in the `staged-gate.ts` file doc comment.

**Known uncovered gap (accepted, documented, not fixed in #159).** A failed
`docker compose ps -a --format json` is invisible to this rule: `getServiceStatusMap` logs an error
and returns the map with every service defaulted to `{ state: "created", health: "none" }`
(`packages/rfapps-cli/src/lib/service-status.ts:247-249`, `:268-271`), and `ReadinessSignalType`
has only `"service-container-map" | "container-inspect"`
(`packages/rfapps-cli/src/types/health.ts:23`), so nothing sets `degraded`. Every batch member then
classifies `pending`/`not-running` and the gate burns its full bound before halting on a transient
daemon hiccup. Recorded in the `staged-gate.ts` doc comment as a known limitation.

### Empty-batch guard

The gate is skipped entirely when `started.length === 0`. This is not cosmetic:
`resolveTargetServices` returns `Object.keys(composeServices)` — **every service in the compose
file** — when the requested array is empty (`packages/rfapps-cli/src/lib/health.ts:407-419`). Any
future reordering that let a gate run on an empty set would silently turn the batch gate into a
whole-compose-file poll.

### `--no-wait-for-ready`

The per-batch gate is disabled entirely (`runPerBatchGate = staged && waitForReady`). Batching and
start-failure halting still apply; `gate` is `undefined` on each outcome, and the coordinator
therefore computes `unhealthy = []` for that batch rather than treating every started service as
unready. Emitted once:
`logWarn("Staged health gating is disabled (--no-wait-for-ready or healthCheck.waitForReady: false); batches will not halt on unhealthy services")`.

**The warning MUST key on the RESOLVED `waitForReady`, not on `rawOptions.waitForReady === false`.**
`packages/rfapps-cli/src/actions/deploy.ts:257` resolves
`rawOptions.waitForReady ?? finalConfig.healthCheck.waitForReady`, and Commander supplies
`waitForReady: undefined` when neither `--wait-for-ready` nor `--no-wait-for-ready` is passed. A
repo with `healthCheck.waitForReady: false` would otherwise get
`rfapps deploy -g media-stack --staged` with no gate, no halt, no warning and exit 0 — the entire
safety property of the feature silently absent.

### Tail dependency gate

The existing `waitForDependencyReadiness` block at
`packages/rfapps-cli/src/actions/deploy.ts:590-660` still runs **once** after the rollout, guarded
by `if (!halted && healthyServices.length > 0)`. This preserves the current contract exactly (the
per-batch target gate answers "did what I just deployed come up"; the tail gate answers "are the
declared dependencies ready"). On a halt it is skipped so a halted rollout does not pay a second
full `healthTimeout` while holding the state lock.

---

## 6. Failure policy

### What fails a batch

| Situation                                           | Outcome                                         | `cause`              | Gate runs?                 | Docker calls        |
| --------------------------------------------------- | ----------------------------------------------- | -------------------- | -------------------------- | ------------------- |
| All started, gate ready                             | `passed`                                        | —                    | yes                        | pull + start + gate |
| Pull failed for some, start succeeded, gate ready   | `passed` (pull failures recorded in `failed[]`) | —                    | yes                        | full                |
| Some failed `up`, some started                      | `failed`                                        | `start-failed`       | yes, on the started subset | full                |
| No service started                                  | `failed`                                        | `start-failed`       | **no**                     | pull + start        |
| Every member filtered by an earlier batch's failure | `failed`                                        | `dependency-skipped` | no                         | **none**            |
| Started, gate not ready before the bound            | `failed`                                        | `gate-unready`       | yes                        | full                |
| Started, gate exhausted its bound                   | `failed`                                        | `gate-timeout`       | yes                        | full                |
| Telemetry unavailable, nothing classified failed    | `passed`, `gate.degraded: true`                 | —                    | yes                        | full                |
| Rollout already halted                              | `skipped`                                       | —                    | no                         | **none**            |

**Pull failures never fail a batch.** They are recorded in `failed[]` for reporting but never set
`cause` — byte-for-byte the existing behaviour at
`packages/rfapps-cli/src/actions/deploy.ts:518-522`, where `docker compose up` may still succeed
from a locally cached image and a pull failure that actually matters resurfaces as a start failure.
This is why `"pull-failed"` is absent from `StagedBatchFailureCause`.

### `--on-failure halt` (default)

The first `failed` batch sets `halted`; every remaining batch becomes `skipped` with **zero Docker
calls**. `report.status = "halted"`, `haltedAtBatch` set.

### `--on-failure continue`

Every batch is attempted, but cross-batch dependency skipping still applies. Because
`executeParallelPhases` resets its internal `allFailedServices` set on **every call**
(`packages/rfapps-cli/src/lib/parallel-executor.ts:76`), the coordinator owns a
`rolloutFailed: Set<string>` across batches and applies the _existing_
`filterByDependencyFailures` (`packages/rfapps-cli/src/lib/parallel-executor.ts:367-392`), which
must gain an `export` keyword. Skipped services are recorded as
`{ name, code: "STAGE_DEPENDENCY_SKIPPED", error: "Skipped: dependency failed in an earlier batch" }`
and joined to `rolloutFailed` so the skip cascades — identical semantics to
`packages/rfapps-cli/src/lib/parallel-executor.ts:96-99`. `report.status = "degraded"`.

This policy is also the escape hatch for the one-shot / unusual-container class described in §5,
alongside `--no-wait-for-ready`.

### Projection into `DeployResult`

```ts
result.services  = services;                     // full requested set — contract unchanged
result.started   = Σ over non-skipped batches of batch.started.length;
result.unhealthy = Σ over failed batches of batch.unhealthy;   // [] when no gate ran
result.healthy   = (Σ started) filtered to exclude result.unhealthy;
result.failed   += Σ over ALL batches of batch.failed          // includes pull failures on passed batches
                 + one entry per service in every skipped batch:
                   { name, code: "STAGE_NOT_ATTEMPTED",
                     error: `Not attempted: staged rollout halted after batch ${n} of ${total}` };
result.staged    = summarizeStagedRollout(report);
```

Two aggregation rules that look cosmetic and are not:

- **`batch.failed` is summed over `passed` batches too.** Pull failures land there and never set
  `cause` (§6 table). Dropping them would regress the non-staged path from exit 1 to exit 0,
  because `actions/deploy.ts:518-522` pushes them into `result.failed` today.
- **`unhealthy` is `[]` when the batch ran no gate.** With `gate === undefined` — every non-staged
  deploy and every `--staged --no-wait-for-ready` deploy — a naive
  `started.filter(s => gate?.services.find(...)?.status !== "ready")` marks every started service
  unhealthy, which empties `result.healthy`, makes `hasDeploySuccess` false
  (`lib/exit-codes.ts:121-123`) and silently breaks `--allow-partial`.

**Never-attempted services MUST land in `failed`.** This is the single most dangerous failure mode
of the feature. `resolveDeployExitCode` computes
`const hasFailure = result.failed.length > 0 || result.unhealthy.length > 0;` and returns
`ExitCode.Success` when `!hasFailure` (`packages/rfapps-cli/src/lib/exit-codes.ts:46-51`). Without
these entries a halted rollout would **exit 0** while abandoning most of the group. The
`STAGE_NOT_ATTEMPTED` entry follows the existing skip convention and the existing optional `code`
field that `validationFailureEntry` already uses (`packages/rfapps-cli/src/actions/deploy.ts:102-118`).

### Exit codes — contract unchanged

`resolveDeployExitCode` and `setDeployExitCode` (`packages/rfapps-cli/src/lib/exit-codes.ts:46-62`)
are **not modified**. `hasDeploySuccess` keys off `result.healthy.length > 0`
(`packages/rfapps-cli/src/lib/exit-codes.ts:121-123`).

| Rollout                                                       | `--allow-partial` | Exit                                                                        |
| ------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `completed`, nothing unhealthy                                | either            | 0                                                                           |
| `halted`, at least one healthy                                | no                | 1                                                                           |
| `halted`, at least one healthy                                | yes               | 3                                                                           |
| `halted` on the canary, zero healthy                          | either            | 1                                                                           |
| `degraded`, at least one healthy                              | no / yes          | 1 / 3                                                                       |
| Bad `--batch-size` / `--on-failure` / used without `--staged` | either            | 2                                                                           |
| Dependency cycle                                              | either            | 1 (existing check at `actions/deploy.ts:484-501`, before the staged branch) |

### Error rendering

One `DockerCommandError("staged-deploy", …)` per **failed batch**, formatted locally via
`formatError` + `outputFormattedError` and **never thrown** — throwing would abort the surrounding
`try` and skip state recording, the anti-pattern the package `CLAUDE.md` forbids for multi-service
loops.

The existing per-failure render loop **body** at `packages/rfapps-cli/src/actions/deploy.ts:577-587`
additionally **skips entries whose `code` is `"STAGE_NOT_ATTEMPTED"`**. Eleven full error blocks
for services nobody touched is noise; they get one summary line instead.

**Only the loop body changes.** `if (result.failed.length > 0)` at `:575` and
`setDeployExitCode(result, options.allowPartial ?? false)` at `:576` are preserved verbatim.
Deleting them would mean no parallel-path deploy ever sets a non-zero exit code — precisely the
"exits 0 despite halting" catastrophe this feature exists to prevent.

### What the operator sees (text format)

Scenario: batch 3 fails because `traefik` is unhealthy, while `cloudflared` and `docktail` started
fine. Membership follows the corrected 5-batch plan in §4, so `cloudflared` and `docktail` were
**attempted** and count toward `healthy` (8) — they must not appear under "not attempted" (5).

```text
Staged rollout: 5 batches (batch size 3, on failure: halt)
Worst case 5 batches x 60s gate = up to 5m0s holding the state lock.

  Batch 1/5  phase 0    homarr, ofelia, speedtest-tracker            OK      11s
  Batch 2/5  phase 0    stirling-pdf, uptime-kuma, forgejo-postgres  OK       9s
  Batch 3/5  phase 0    cloudflared, docktail, traefik               FAILED  62s
                        traefik: health-unhealthy

HALTED after batch 3 of 5
  healthy:        8  (homarr, ofelia, speedtest-tracker, stirling-pdf, uptime-kuma,
                      forgejo-postgres, cloudflared, docktail)
  unhealthy:      1  (traefik)
  not attempted:  5  (forgejo, forgejo-itcn-runner, forgejo-runner, forgejo-runner-2,
                      forgejo-runner-3)
  Services that were not attempted are still running their previous containers.

  Investigate:  rfapps logs -s traefik
  Resume:       rfapps deploy --services traefik,forgejo,forgejo-itcn-runner,forgejo-runner,forgejo-runner-2,forgejo-runner-3 --staged --batch-size 3
```

Failure reasons are `StagedGateReason` values, so the identical string appears in
`result.staged` consumers' sibling `failed[].error` entries. The `Resume:` line deliberately omits
`--force-recreate` (which is auto-enabled when sidecars expand,
`packages/rfapps-cli/src/actions/deploy.ts:355`) so a resume does not widen the blast radius.

### Structured output — exactly one emission

Unchanged. The single `DeployResult` envelope created at
`packages/rfapps-cli/src/actions/deploy.ts:313-319` is emitted once at `:1024-1027`. The
coordinator never calls `formatOutput`. Existing call-count assertions
(`packages/rfapps-cli/src/actions/deploy.spec.ts:511, 597, 603, 622, 740`) stay green.

`deployResultForOutput` (`packages/rfapps-cli/src/actions/deploy.ts:145-152`) strips `staged` for
**both** `table` and `csv` — the current guard only covers `table`, and `--staged --output csv` is
legal because the csv rejection at `cli.ts:174-185` is `--validate-first`-specific:

```ts
function deployResultForOutput(format: OutputFormat, result: DeployResult): DeployResult | object {
  const flattens = format === "table" || format === "csv";
  if (!flattens || (result.validation === undefined && result.staged === undefined)) {
    return result;
  }
  const { validation: _validation, staged: _staged, ...deployResult } = result;
  return deployResult;
}
```

### Orphan cleanup — belt and braces

`packages/rfapps-cli/src/actions/deploy.ts:562-567` currently re-`up`s the **full** target set.
Verified: `startServices` unconditionally emits `args.push("up", "-d", "--remove-orphans")`
(`packages/rfapps-cli/src/lib/docker.ts:711-736`) followed by the positional service list, so
running it after a halt would start exactly the services the halt was meant to protect.

Two guards, both applied:

```ts
// report.attempted = services a runPhase("start") was ISSUED for (succeeded ∪ failed),
// re-filtered through `services` so the caller's argv order is preserved.
const attempted = services.filter((service) => report.attempted.includes(service));
if (report.status !== "halted" && attempted.length > 0) {
  await startServices(deployComposePath, attempted, {
    streamOutput: false,
    profiles,
    ...deployExecution,
  });
}
```

- **Scoped to `attempted`** — services a start was _issued_ for, which is deliberately
  `start.succeeded ∪ start.failed`, **not** just the successes. A dependency-skipped member or a
  never-attempted batch member was never started and must not be resurrected here; a member whose
  `up` failed was attempted and keeps today's cleanup scope.
- **Skipped entirely on halt** — the only thing lost is orphan reaping, which the next complete
  deploy performs. Logged as `logDebug("Orphan cleanup skipped: staged rollout halted")`.

Non-staged behaviour: on the success path this is byte-identical, because a single batch with no
skips yields `attempted === services`. On a partial failure the non-staged path must still run the
cleanup pass and the tail readiness gate exactly as it does today, so the coordinator is called
with `onFailure: "continue"` when `!staged` — otherwise the single batch would set `halted` on any
start failure and silently skip both.

### State DB implications

The existing block at `packages/rfapps-cli/src/actions/deploy.ts:662-703` is reused **verbatim**:
one `initializeDatabase()`, one `inspectContainersWithRetry`, one `recordDeployments` transaction,
one timestamp, after the rollout terminates. Because skipped services are already in
`result.failed`, the `services.map(...)` loop at `:674-694` derives
`status: "failed"` with `errorMessage: "Not attempted: staged rollout halted after batch 3 of 5"`
for them automatically — truthful history with **no schema migration, no `plan_id` overloading, and
no per-batch DB writes**. `GENERATION_ACTIONS` requires `status === "success"`, so skipped services
produce no generation row.

One narrow change: `inspectContainersWithRetry(services, …)` at `:667-672` becomes
`inspectContainersWithRetry(staged ? attempted : services, …)`, so a halted rollout does not burn
the full retry loop inspecting containers that were never created. The `staged` guard is
deliberate: on the non-staged path, narrowing to `attempted` would drop the `imageTag` /
`configSnapshot` of a service whose `up` failed but whose previous container is still inspectable,
changing recorded history for a path #159 is not meant to touch. Identical when nothing is skipped,
so the "exactly one `inspect-db` invocation" assertions in integration tests D1
(`cli.deploy.integration.spec.ts:141-142`) and D7 (`:588-589`) stay green.

DB write failures remain non-fatal (`logWarn` only, `packages/rfapps-cli/src/actions/deploy.ts:698-702`).

**Accepted limitation:** `rfapps history` cannot say which batch a service belonged to. Adding a
`run_id` column would require bumping `schema_version` past 3 plus edits to both `rowToStateEntry`
copies and every SELECT/INSERT column list. The `error_message` preserves the information in text
form. Filed as future work.

### Locking and conflict validation — explicitly unchanged

- **State lock**: acquired once in the `preAction` hook
  (`packages/rfapps-cli/src/cli.ts:260-263`; `"deploy"` is in `ALWAYS_MUTATING_COMMANDS` at
  `:63-73`) and released once in `main()`'s `finally` (`:637-653`). No per-batch acquire/release.
  A halted rollout releases the lock at exit; a resume re-acquires a fresh one, and the unprotected
  window between them is documented in the README.
- **`lifecycle-lock.ts` is not wired in.** It stays exclusive to `reconcile` and `update`.
- **`revalidateDeployBinding`** (`packages/rfapps-cli/src/lib/deploy-validation.ts:727`) keeps
  running **exactly once**, immediately before the first mutation
  (`packages/rfapps-cli/src/actions/deploy.ts:458-472`). Explicit decision: (1) the state lock
  excludes concurrent `rfapps` mutation for the whole rollout; (2) per-batch revalidation would
  re-shell-out `docker compose config` per batch and introduces a new spurious-halt mode on a
  transient authority-fingerprint blip, with no escape hatch short of dropping `--validate-first`;
  (3) it is a _pre-mutation_ gate, and after batch 1 the rollout owns the ports and volumes it just
  claimed. The point-in-time limitation documented at
  `packages/rfapps-cli/src/lib/deploy-validation.ts:370-376` is widened by the rollout's duration;
  that widening is stated as a known limitation of `--staged --validate-first`.
- **`composeExecutionOptions(binding)`** (cwd / env / replaceEnv / envFile / projectName,
  `packages/rfapps-cli/src/lib/deploy-validation.ts:775-785`) is threaded into every batch call
  through `StagedExecutionContext.exec`. **Correction to an earlier claim in this design:** a
  `Pick<DockerComposeExecOptions, …>` parameter enforces nothing, because every picked key is
  optional and `deployExecution` is `{ envTool }` whenever `--validate-first` is absent
  (`actions/deploy.ts:350-351`) — an all-optional `Pick` is satisfied by `{}`. Dropping the spread
  would silently change the Compose project identity and no compiler and no test would catch it.
  The compile-time safety net that _does_ exist is `StagedExecutionContext` declaring `composePath`,
  `projectDir` and `profiles` as **required** (§3), which converts the two genuinely reachable
  silent divergences into type errors.

---

## 7. Files to change

### New files

| Path                                                 | Contents                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/types/staged.ts`            | All types from §3 plus `isStagedFailurePolicy`                                                                                                                      |
| `packages/rfapps-cli/src/lib/staged-rollout.ts`      | `planStagedBatches`, `executeStagedRollout`, `summarizeStagedRollout`, `formatStagedPlan`, `formatStagedEvent`, `formatStagedSummary`, `stagedExceedsLockStaleness` |
| `packages/rfapps-cli/src/lib/staged-gate.ts`         | `StagedServiceObservation`, `waitForBatchReady`, `createBatchObserver`, `isCompletedOneShot`, module-private `sleep` (~200 lines)                                   |
| `packages/rfapps-cli/src/lib/staged-rollout.spec.ts` | Tests T1-T4                                                                                                                                                         |
| `packages/rfapps-cli/src/lib/staged-gate.spec.ts`    | Test T5                                                                                                                                                             |

No `packages/rfapps-cli/src/lib/timing.ts`. `staged-gate.ts` declares its own three-line private
`sleep` and accepts an override through its injected dependency object, mirroring
`verifyServiceReadiness` (`packages/rfapps-cli/src/lib/health.ts:865-889`). The accepted DRY cost
is noted in §5.

### Modified files

| Path                                 | Anchor            | Change                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/health.ts`                  | `:98`             | Add `export` to `normalizeTargetState`                                                                                                                                                                                                                                                                                                                                             |
| `src/lib/health.ts`                  | `:162`            | Add `export` to `classifyTargetObservation` (signature unchanged)                                                                                                                                                                                                                                                                                                                  |
| `src/lib/health.ts`                  | `:903-907`        | Extract inline predicate into exported `canAccumulateStableRunning`; call it from `verifyServiceReadiness`. The private `sleep` at `:94-96` is **not** touched                                                                                                                                                                                                                     |
| `src/lib/parallel-executor.ts`       | `:367`            | Add `export` to `filterByDependencyFailures`                                                                                                                                                                                                                                                                                                                                       |
| `src/lib/index.ts`                   | beside `:312`     | Export `planStagedBatches`, `executeStagedRollout`, `summarizeStagedRollout`, `formatStagedPlan`, `formatStagedSummary`, `waitForBatchReady`, `filterByDependencyFailures` and their option types. **Load-bearing**: `deploy.spec.ts:14` does `vi.mock("../lib/index.js")`, so anything the action imports deep would execute for real                                             |
| `src/types/staged.ts`                | —                 | (new, above)                                                                                                                                                                                                                                                                                                                                                                       |
| `src/types/index.ts`                 | beside `:354-361` | New `// Staged rollout types` block. The barrel uses **explicit named exports**, not `export *`; `isStagedFailurePolicy` is a value and needs a value export beside `:39`                                                                                                                                                                                                          |
| `src/types/results.ts`               | `:106-119`        | `DeployResult.staged?: StagedRolloutSummary`                                                                                                                                                                                                                                                                                                                                       |
| `src/types/options.ts`               | `:86-103`         | `DeployOptions` += `staged?`, `batchSize?`, `onFailure?`                                                                                                                                                                                                                                                                                                                           |
| `src/actions/deploy.ts`              | `:84-100`         | `RawDeployOptions` += 3 fields                                                                                                                                                                                                                                                                                                                                                     |
| `src/actions/deploy.ts`              | `:145-152`        | `deployResultForOutput` strips `staged` for `table` **and** `csv`                                                                                                                                                                                                                                                                                                                  |
| `src/actions/deploy.ts`              | `:197-224`        | Normalize `staged` / `batchSize` (string to int, matching `:220-223`) / `onFailure` (via `isStagedFailurePolicy`)                                                                                                                                                                                                                                                                  |
| `src/actions/deploy.ts`              | after `:234`      | Usage guard (`--batch-size` / `--on-failure` without `--staged`; non-positive batch size)                                                                                                                                                                                                                                                                                          |
| `src/actions/deploy.ts`              | `:259-264`        | `useParallel = staged \|\| (options.parallel ?? finalConfig.parallel.enabled)`; resolve `batchSize` (default 1) and `onFailure` (default `"halt"`)                                                                                                                                                                                                                                 |
| `src/actions/deploy.ts`              | `:370-419`        | Dry-run: `formatStagedPlan` instead of `formatExecutionPlan`; machine payload += `staged: { batchSize, onFailure, batches }`                                                                                                                                                                                                                                                       |
| `src/actions/deploy.ts`              | `:505-572`        | Replace the pull sweep, start sweep, failure merge, orphan pass and aggregation with a single `executeStagedRollout` call. **Non-staged takes the same call with `batchSize = services.length` and `onFailure: "continue"`**, so it is one batch that never halts. The six legacy log lines (`:507`, `:520`, `:525`, `:528`, `:532`, `:557`) are re-emitted on the non-staged path |
| `src/actions/deploy.ts`              | `:577-587`        | Skip `outputFormattedError` for `code === "STAGE_NOT_ATTEMPTED"`. `:575` guard and `:576` `setDeployExitCode` preserved verbatim                                                                                                                                                                                                                                                   |
| `src/actions/deploy.ts`              | `:590-660`        | Guard the tail dependency gate with `!halted`; `healthyServices = report.healthy`                                                                                                                                                                                                                                                                                                  |
| `src/actions/deploy.ts`              | `:667-672`        | `inspectContainersWithRetry(staged ? attempted : services, …)`                                                                                                                                                                                                                                                                                                                     |
| `src/cli.ts`                         | after `:363`      | Three new options (§2)                                                                                                                                                                                                                                                                                                                                                             |
| `src/cli.ts`                         | after `:185`      | Deploy `preAction` usage guard                                                                                                                                                                                                                                                                                                                                                     |
| `src/cli.ts`                         | `:373-381`        | Extend `addHelpText` with the staged-rollout paragraph                                                                                                                                                                                                                                                                                                                             |
| `src/actions/completion.ts`          | `:53`             | Append `--staged --batch-size --on-failure` to the end of `deploy_opts`                                                                                                                                                                                                                                                                                                            |
| `src/actions/completion.ts`          | after `:233`      | Two new `case "$prev"` arms: `--batch-size)` with `compgen -W "1 2 3 5 10"` (pattern at `:218-221`), `--on-failure)` with `compgen -W "halt continue"` (pattern at `:206-209`). A dedicated `--batch-size` arm is used rather than widening the `--steps)` arm at `:230`, which belongs to `rollback`                                                                              |
| `src/actions/completion.ts`          | `:552-571`        | Zsh `deploy)` arm: `'--staged[Roll out in dependency-ordered batches]'`, `'--batch-size[Services per staged batch]:count:(1 2 3 5 10)'`, `'--on-failure[Staged batch failure policy]:policy:(halt continue)'`. **Indentation is load-bearing** — the arm must stay literally `\n        deploy)\n` closed by `\n          ;;` for the extractor at `completion.spec.ts:177-179`    |
| `src/actions/completion.ts`          | `:1033-1048`      | Three fish lines before the `-s f -l compose` line at `:1046`, using `-xa "1 2 3 5 10"` and `-xa "halt continue"`. No `and not __fish_seen_subcommand_from …` guard is needed: neither `halt` nor `continue` collides with a registered subcommand                                                                                                                                 |
| `src/mcp/schema.ts`                  | `:13-34`          | Add `StagedRolloutSummary` to the `import type { … } from "../types/index.js"` block (hard typecheck blocker)                                                                                                                                                                                                                                                                      |
| `src/mcp/schema.ts`                  | `:280-286`        | Add `stagedSummarySchema` and `staged: schemaOptional(stagedSummarySchema)` to `deployResultSchema`                                                                                                                                                                                                                                                                                |
| `src/mcp/schema.ts`                  | `:1017-1035`      | Add `stagedSummary: McpSchema<StagedRolloutSummary>` to `_typeCheck` (two lines: type literal + value literal)                                                                                                                                                                                                                                                                     |
| `src/actions/completion.spec.ts`     | `:315`            | Optional hardening: `deployOnlyOptions` += `"staged"`, `"batch-size"`, `"on-failure"`                                                                                                                                                                                                                                                                                              |
| `src/actions/completion.spec.ts`     | `:408-419`        | Optional hardening: `required` += `"staged"`, `"batch-size"`. **Not** `"on-failure"` — the generated script already contains `no-restore-on-failure` (`completion.ts:74`, `:648`, `:1126`), so that token is a permanently-green no-op                                                                                                                                             |
| `src/actions/deploy.spec.ts`         | new `describe`    | Tests T6-T7, plus driving default mocks for the new `lib/index.ts` exports in the existing `describe("parallel mode")` `beforeEach` (`:996-1018`)                                                                                                                                                                                                                                  |
| `src/cli.deploy.integration.spec.ts` | new case          | Test T8                                                                                                                                                                                                                                                                                                                                                                            |

`src/mcp/schema.spec.ts` is **not** modified. Declaring `staged` in `deployResultSchema` and
anchoring `stagedSummary` in `_typeCheck` closes the `additionalProperties: false` trap at compile
time; a runtime test pinning a deliberate input/output asymmetry that cannot currently be reached
adds nothing.

**No config file is touched.** `types/config.ts`, `lib/config.ts`, and `rfapps.config.yaml` are
unchanged, so the 22 spec fixtures that build `parallel: { … }` config literals and the 13 that
annotate `: RfappsConfig` need no edits.

**Where the batch loop lives.** In `packages/rfapps-cli/src/lib/staged-rollout.ts`, as
`executeStagedRollout`, which `actions/deploy.ts` calls on **every** parallel-path deploy — staged
with N batches, non-staged with exactly one. An earlier draft of this section said the loop stays
inline in `actions/deploy.ts`; that contradicted the test plan (T3 and T4 unit-test
`executeStagedRollout` with an injected `runPhase`, which is unauthorable against an inline loop)
and is **overridden**. The regression defence the inline version was reaching for is preserved and
strengthened: staged and non-staged still execute one code path, and that path is now unit-tested.

**`actions/deploy.ts` growth:** roughly +55 net lines. The batching, gating and rendering logic
lives in the two new lib modules. Decomposing `executeDeploy` into preflight / execute / report
modules is the right follow-up and is explicitly out of scope for #159.

**`deploy.spec.ts` is not optional collateral.** `vi.mock("../lib/index.js")` at
`packages/rfapps-cli/src/actions/deploy.spec.ts:14` is a bare **automock with no factory**, so
every new `lib/index.ts` export becomes a `vi.fn()` returning `undefined`. Eight of the twelve
tests in `describe("parallel mode")` assert directly on `lib.executeParallelPhases`
(`:1024`, `:1033`, `:1049`, `:1063-1075`, `:1078-1102`, `:1104-1130`, `:1132-1165`, `:1211-1227`),
so a flat `mockResolvedValue` on `executeStagedRollout` breaks all eight — the mocked coordinator
never invokes the injected `runPhase`. The default must be a **driving `mockImplementation`** that
calls `deps.runPhase({ operation: "pull", … })` then `deps.runPhase({ operation: "start", … })` and
derives its report from the two results. This lands in the same change as the `deploy.ts` edit.

---

## 8. Test plan

Eight tests: T1-T4 in `staged-rollout.spec.ts`, T5 in `staged-gate.spec.ts`, T6-T7 in
`deploy.spec.ts`, T8 in `cli.deploy.integration.spec.ts`. Each guards a failure mode that is
silent, dangerous, or structurally regression-prone. Conventions follow the repo:
`vi.clearAllMocks()` in `beforeEach` (never `resetAllMocks`), `process.exitCode` saved and restored
per test, module-level factory helpers for fixtures.

### `packages/rfapps-cli/src/lib/staged-rollout.spec.ts` (pure, injected dependencies)

**T1 — "never places a service in an earlier batch than its dependency"**
(`it.each` over phase shapes x batch sizes 1/2/3/99).
_Required because:_ this is the one correctness invariant; getting it wrong starts a service before
its database in a mutating command, and it is invisible from action-level tests that stub the
planner. Also asserts each `StagedBatch.phases` preserves the original phase numbers.

**T2 — "orders core-profile services last within a phase"**.
_Required because:_ without it, `--staged --batch-size 1` on `infra-stack` canaries `cloudflared`
and recreates `traefik` mid-rollout — the exact regression that locks the operator out. Asserts
`profileMapping = { traefik: "core", "uptime-kuma": "infrastructure" }` with `batchSize: 1` puts
`uptime-kuma` in batch 1 and `traefik` last, and that fan-in then name break remaining ties.

**T3 — "halts remaining batches without Docker calls; `continue` attempts every batch"**
(`it.each` over `["halt", "continue"]`).
_Required because:_ this is the feature. For `halt`: later outcomes are `skipped`, `runPhase` is
never called with a skipped batch's services, `haltedAtBatch` is correct. For `continue`: every
batch runs, and a service whose dependency failed in batch 0 is recorded
`STAGE_DEPENDENCY_SKIPPED` — which exercises the carried `rolloutFailed` set that
`executeParallelPhases` resets on every call (`parallel-executor.ts:76`), the subtlest bug surface
in the design.

**T4 — "degraded telemetry never halts"**.
_Required because:_ it inverts the obvious "not ready means fail" logic and is therefore highly
regression-prone, while the consequence of getting it wrong is a transient `docker inspect` failure
aborting a rollout half-deployed. Asserts `signalAvailability.available === false` with targets
ready yields `passed` with `gate.degraded === true` and no halt.

### `packages/rfapps-cli/src/lib/staged-gate.spec.ts`

**T5 — "gates on the batch's own services with a bounded soak, and exempts completed one-shots"**.
_Required because:_ three verified traps in one behaviour, none caught elsewhere. (a) A
dependency-free batch must **not** pass instantly — feeds a target observed as `state: "created"`
and asserts the gate is not ready (the `health.ts:735` short-circuit trap). (b) A `health: "none"`
target must be `pending`/`stabilizing` before 5s and `ready` after, with
`assurance: "running-only"`, driven by a virtual clock advanced only by the mocked `sleep`
(mirroring `health.spec.ts:742-763`). (c) `{ state: "exited", exitCode: 0, restartPolicy:
"on-failure" }` must be `ready`/`completed`, while `{ state: "exited", exitCode: 0, restartPolicy:
"always" }` must be `failed` — without this, `rfapps deploy -g media-stack --staged` halts on
`plex-ratings-sync` doing its scheduled job. Also asserts `timedOut` fires on the attempt bound
even when wall-clock time has not elapsed.

### `packages/rfapps-cli/src/actions/deploy.spec.ts` — new `describe("staged mode")`

**T6 — "a halted rollout records never-attempted services and maps to the right exit code"**
(`it.each` over `[false, OperationalError]` and `[true, PartialSuccess]`, plus a zero-healthy case).
_Required because:_ this is the most dangerous silent failure. If skipped services do not reach
`result.failed`, `resolveDeployExitCode` sees `!hasFailure` and the CLI **exits 0 despite halting**
— and CI, deploy scripts, and MCP all trust that code. Also asserts a canary failure with zero
healthy is exit 1 even with `--allow-partial`.

**T7 — "scopes orphan cleanup to attempted services and skips it entirely on halt"**.
_Required because:_ the second dangerous silent failure. `startServices` is
`up -d --remove-orphans <list>` (`docker.ts:736`); an unscoped pass would start every service the
rollout just refused to deploy, silently defeating the feature with no error. Asserts
`lib.startServices` is not called on halt, and is called with only the attempted names on success.

### `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`

**T8 — "D8: `--staged --batch-size 1` halts before the second batch and records the untouched service"**.
_Required because:_ it is the only place that proves, against the argv the CLI actually emits, that
a halt prevents Docker work on the remaining services — and the only test that would catch a
dropped `...deployExecution` spread or a broken flag-to-default resolution.

Four fixture constraints, all verified:

1. **`--wait-for-ready` MUST be on the argv.** `DEFAULT_FIXTURE_CONFIG_YAML` pins
   `healthCheck.waitForReady: false` (`packages/rfapps-cli/src/testing/cli-harness.ts:80`) and
   Commander supplies `waitForReady: undefined` when neither flag is passed, so `deploy.ts:257`
   resolves `false`, `runPerBatchGate` is `false`, nothing halts and the run exits 0. This cannot
   be fixed by appending a second `healthCheck:` block — the `yaml` package rejects duplicate
   top-level keys.
2. **The `envTool: none` pin is NOT mandatory.** `deploy.ts:195` calls `getEnvToolExecConfig`
   with one argument, which returns `undefined` when `config === undefined`
   (`packages/rfapps-cli/src/types/options.ts:195-197`); only the six two-arg call sites can
   resolve `dotenvx` from config. All ten existing tests in this file run unpinned and pass in CI.
   Cheap insurance, not the requirement.
3. **`ps-a-json` must be hand-overridden.** `deployReadinessRules` hard-codes it to both services
   `running` (`packages/rfapps-cli/src/testing/deploy-scenarios.ts:311-320`) with no state override,
   so the returned array must be spread and that one rule replaced.
4. **`dbInspectServices` must exactly equal the attempted list** (`deploy-scenarios.ts:285-295`),
   which on a halt is one service — otherwise `inspectContainersWithRetry`'s
   `size === services.length` early return misses and the full ~3 s retry loop burns.

Membership: the fixture compose has no `depends_on` and neither service is `core`, so both are
tier 0 / fan-in 0 and the flat order is alphabetical — **batch 1 = `db`, batch 2 = `web`**.
Arrange `ps-a-json` to report `db` `exited`; `state === "exited"` hits `health.ts:176-178` before
the `imageId === undefined` check at `:182-184`, and `isCompletedOneShot` returns `false` because
`exitCode !== 0`, so the gate returns `failed` on attempt 1.

Assert exit 1; `expectInvocationOrder(result.invocations, ["pull", "up"])` (that helper matches on
`matchedRuleId`, not argv, `cli-harness.ts:295-312`); per-service argv checked separately via
`argvLines(...)`; `expectNoInvocationMatching` proves no `up` argv contains `web` and that no
`--remove-orphans` invocation exists (the parallel `start` operation strips it,
`parallel-executor.ts:236-238`, so the orphan pass is the only possible source); the `deployments`
table has a `failed` row for `web` whose `error_message` starts with `Not attempted:`; `generations`
gains no row. Explicit 30 000 ms per-test timeout (the harness budget defaults to 12 s at
`cli-harness.ts:210` and this run polls).

### Deliberately not written

- **An `src/mcp/schema.spec.ts` test.** Once `staged` is declared in `deployResultSchema` and
  `stagedSummary` is anchored in `_typeCheck`, the `additionalProperties: false` trap is closed at
  compile time. A runtime test pinning a deliberate input/output asymmetry that cannot currently be
  reached (no input gate accepts `staged`, exactly as none accepts `validateFirst`) is padding. The
  schema declaration and the `_typeCheck` anchor are the actual fix and are both kept.
- **Shell completion tests.** `completion.spec.ts:312` already compares the live
  `rfapps deploy --help` surface against all three generated scripts and fails once per shell for
  any un-mirrored flag. The two token-array edits are hardening, not requirements: verified that
  with `cli.ts` and all four `completion.ts` edits applied and the spec untouched, all 11 tests
  pass. The assertion that actually fails on an un-mirrored flag is the parity
  `.toEqual(deployOptions)` at `completion.spec.ts:319-322`, which aborts on the first shell
  (bash) — so `cli.ts` and all `completion.ts` edits must land in one change.
- **Formatter output strings.** Cosmetic; a wrong line renders visibly wrong on first use.
- **`--batch-size 0` / `--on-failure bogus` rejection.** Commander `.choices()` and the preAction
  `InvalidArgumentError` are one-liners on well-trodden paths.

### Verification commands

```bash
npm run build -w packages/rf-common      # precondition for the tsx integration child
npm run typecheck -w packages/rfapps-cli
npm run test:run -w packages/rfapps-cli
npm run format:all                       # NOT `npm run format` — that is bare `prettier --write`
npm run lint:md
```

`npm run format` is defined as `prettier --write` with no path argument, so it exits with
`[error] No parser and no file path given` and writes nothing. Use `format:all` (or
`format:rfapps` + `format:md`), and run `lint:md` for markdownlint, which `format` never invokes.

---

## 9. Documentation and completion updates

**Locate every section by its heading, not by the line anchors below** — README and docs line
numbers drift and these were not re-verified at the same rigour as the source anchors.

| Path                                                              | Anchor                                                   | Change                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/README.md`                                   | `:701` `### deploy` option table `:709-726`              | Add the three flags                                                                                                                                                                                                                                                                                           |
| `packages/rfapps-cli/README.md`                                   | after `:732-762` (`#### Pre-Deploy Conflict Validation`) | New `#### Staged Rollout` section: batching, criticality ordering, the per-batch gate, the running-only assurance caveat for the 11 healthcheck-less services, the one-shot exemption, per-batch health budget and state-lock hold time, `--on-failure continue` as the escape hatch, and the resume workflow |
| `packages/rfapps-cli/README.md`                                   | `### Exit Codes` `:764-771`                              | Note that a halted rollout maps onto 1 / 3 and that never-attempted services count as failures                                                                                                                                                                                                                |
| `docs/features/shell-completion.md`                               | `:145-151`                                               | Add the three flags to the shown-flags block                                                                                                                                                                                                                                                                  |
| `docs/features/shell-completion.md`                               | `:202-217`                                               | Update the `### Deploy Completion Parity` fenced block and the deploy-only sentence                                                                                                                                                                                                                           |
| `docs/features/quick-reference.md`                                | `:38-49`, `:105-115`                                     | Add a staged deploy example beside the parallel-ops block                                                                                                                                                                                                                                                     |
| `docs/features/dry-run-mode.md`                                   | deploy section                                           | Document the staged dry-run batch plan projection                                                                                                                                                                                                                                                             |
| `docs/features/json-output.md`, `docs/features/output-formats.md` | deploy shape                                             | Document the optional `staged` object and that it is stripped for `table` and `csv`                                                                                                                                                                                                                           |
| `docs/features/service-conflict-detection.md`                     | limitations                                              | Note that `--staged --validate-first` widens the point-in-time validation window                                                                                                                                                                                                                              |
| `ROADMAP.md`                                                      | `:33`, `:45-52`, `:94`, `:121`                           | Update #159 entries; move the sprint to `docs/roadmap-archive.md` on ship                                                                                                                                                                                                                                     |

MCP docs (`docs/features/rfapps-mcp-server.md`) need **no** argument-table change, since the input
flags are not mirrored.

---

## 10. Risks and mitigations

| Risk                                                                                                                                                                                                                                                                                                                                                               | Mitigation                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **State-lock hold time scales with the rollout.** Worst case `ceil(N / batchSize) x healthTimeout`. A stalled 13-service group at `--batch-size 1` and the default 60 s timeout holds the `deploy` lock ~13 minutes, past `STATE_LOCK_STALE_AFTER_MS` (10 min, `state-lock.ts:24`), so another operator's `force-unlock` could see a live rollout's lock as stale. | The worst case is computed before the first Docker call and printed, with an explicit warning when it crosses the staleness threshold. Documented in the README with guidance to raise `--batch-size` or lower `--health-timeout`. No per-batch lock churn (that would be worse).                                        |
| **Unusual containers halt the rollout.** The verified case (`plex-ratings-sync`, `exited (0)`, `restart: on-failure:10`) is handled by `isCompletedOneShot`, but other shapes may exist.                                                                                                                                                                           | The exemption covers the verified class exactly. `--on-failure continue` and `--no-wait-for-ready` are documented escape hatches, and `StagedBatchFailureCause` + `StagedGateReason` make the cause machine-readable so a mis-gate is diagnosable in one line.                                                           |
| **Per-batch gate cost.** Three Docker calls per poll attempt per batch. A 5-batch rollout needing 3 attempts each is ~45 extra invocations, and on a remote Docker context that is measurable.                                                                                                                                                                     | The observation is batched (one `inspect` for the whole batch) and makes **no** `docker compose config` call, which is the expensive part of `waitForDependencyReadiness`. README recommends `--batch-size 3` or higher for groups over ~6 services.                                                                     |
| **`profiles.mapping`-derived criticality is only as good as the mapping.** A service missing from the mapping gets tier 0 and could be canaried even if critical.                                                                                                                                                                                                  | `validateConfigAgainstCompose` already warns on unmapped services and deploy hard-fails on mapping errors (`actions/deploy.ts:267-286`). Documented; the fallback ordering (fan-in, then name) is still deterministic.                                                                                                   |
| **Halting leaves the fleet in a mixed state by design.** If an earlier batch updated something a later batch's services depend on at runtime via an undeclared edge (for example Traefik routing), the halted state can be worse than either endpoint.                                                                                                             | Core-last ordering is the mitigation: the ingress path is deployed last, so a halt before it leaves ingress untouched. Cannot see undeclared runtime dependencies; documented.                                                                                                                                           |
| **Running-only assurance is weaker than a healthcheck.** For the 11 healthcheck-less services, the gate proves only 5 s of continuous `running` with exit code 0.                                                                                                                                                                                                  | Documented in the README with a recommendation to add compose `healthcheck` blocks to services you intend to canary. The 5 s soak is the same bound `verifyServiceReadiness` already relies on for managed updates.                                                                                                      |
| **`--staged` silently forces phased execution** even when `rfapps.config.yaml` sets `parallel.enabled: false`.                                                                                                                                                                                                                                                     | Intentional and unambiguous (there is no `--no-parallel`). Announced once with `logInfo`, stated in the flag help text, and documented in the README.                                                                                                                                                                    |
| **`--validate-first` widens the point-in-time window.** `revalidateDeployBinding` runs once; an out-of-band `docker` command during a long rollout is undetected.                                                                                                                                                                                                  | The state lock excludes concurrent `rfapps` mutation for the whole run. Per-batch revalidation was rejected because it adds a spurious-halt mode on a transient fingerprint blip. Stated as a known limitation.                                                                                                          |
| **`result.staged` is a new key in the deploy JSON document.** A downstream consumer that assumed a closed 5-field result sees an unexpected key.                                                                                                                                                                                                                   | Optional field; stripped for `table` and `csv`; declared in the MCP output schema and anchored in `_typeCheck` so drift is a compile error.                                                                                                                                                                              |
| **`actions/deploy.ts` grows to ~1110 lines**, further past the ~500-line soft cap.                                                                                                                                                                                                                                                                                 | The planning, gating, batch loop and rendering logic is extracted to two lib modules (`staged-rollout.ts`, `staged-gate.ts`); the action keeps only the wiring. Non-staged and staged still share one code path, and it is now unit-tested. Decomposing `executeDeploy` is filed as a follow-up issue, not bundled here. |
| **Sidecar cohesion is exercised only by unit tests.** This repo sets `sidecars.enabled: false` with an empty mapping.                                                                                                                                                                                                                                              | Sidecar pairs are co-phased upstream by `enforceSidecarPhaseAlignment` (`dependency-graph.ts:398`), and phase slicing preserves phase numbers, so a pair split across batches still starts in phase order. Covered by T1's phase-preservation assertion.                                                                 |
| **`rfapps history` cannot report which batch a service belonged to.**                                                                                                                                                                                                                                                                                              | Accepted for v1. The `error_message` preserves it in text form. A `run_id` column requires a `schema_version` bump past 3; filed as future work.                                                                                                                                                                         |

---

## Appendix — judge findings that were verified as incorrect

**"Proposal 3 is right that a flat chunk can co-locate a service with its dependency."**
Only when the batch is collapsed into a single synthetic `ExecutionPhase`. This design's phase
slice preserves the original phase numbers, and `executeParallelPhases` iterates phases
sequentially (`packages/rfapps-cli/src/lib/parallel-executor.ts:78`), so intra-batch ordering is
enforced by the executor. The "batches must never span a phase" constraint was therefore dropped;
it only produces ragged undersized batches.

**"`priorFailedServices` carry-forward is dead code under a halt-only policy."**
True for halt-only, but this design ships `--on-failure continue`, under which a later batch can
contain a dependent of an earlier batch's failure. `executeParallelPhases` resets
`allFailedServices` on every call (`parallel-executor.ts:76`), so the coordinator must own the set.
The carry-forward is live code here.

**"`maxAttempts = Math.max(1, poll.retries)` matches `waitForDependencyReadiness` exactly."**
It does not. `waitForDependencyReadiness` uses `const maxAttempts = options.poll.retries;` with no
clamp, so `retries: 0` degrades to wall-clock-only. The staged gate deliberately clamps; the
difference is documented rather than described as byte-identical.

**"`DeployResult.validation` is already an undeclared field on the MCP path, so `staged` is
equally safe."**
`validation` is only populated under `--validate-first`, which is not mirrored to MCP, so it can
never appear there. Any staged field that _can_ be reached from MCP would throw at
`packages/rf-common/src/mcp/core.ts:82`. The precedent does not transfer, which is why the output
schema is declared here even though the input flag is not mirrored.
