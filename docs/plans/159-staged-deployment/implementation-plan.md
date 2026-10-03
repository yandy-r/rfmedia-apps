# Implementation Plan — #159 Staged Deployment Mode for `rfapps deploy`

Authoritative design: `docs/plans/159-staged-deployment/design.md` (already amended for D1-D5 and
every corrected anchor). **This plan supersedes the design wherever they conflict.**

Worktree root: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-feat-staged-deploy`.
All paths in ownership tables are repo-relative from that root; prose abbreviates the
`packages/rfapps-cli/` prefix to `src/…` where unambiguous.

---

## 0. Binding amendments (read before starting any task)

These are decisions an implementing agent would otherwise have to make. They are final.

### A1 — No `lib/timing.ts` (D1)

`src/lib/health.ts:94-96` and `src/lib/action-helpers.ts:16-18` keep their private `sleep`
untouched. `staged-gate.ts` declares its own three-line private `sleep` and accepts an override via
its injected dependency object, exactly as `verifyServiceReadiness` does
(`src/lib/health.ts:865-889`, `const pollSleep = injected.sleep ?? sleep;`).
**Accepted DRY cost: one three-line `sleep` now exists in three files instead of two.**

### A2 — `executeStagedRollout` lives in `lib/staged-rollout.ts` and runs for BOTH paths

Design §7's former "the batch loop stays inline" claim is overridden (already corrected in the
design). `src/actions/deploy.ts` calls `executeStagedRollout` on every parallel-path deploy: staged
with N batches, non-staged with exactly one batch.

### A3 — Non-staged uses `onFailure: "continue"` (blocker)

**`planStagedBatches` receives `onFailure: staged ? onFailure : "continue"`.** With `"halt"`, any
start failure on the single non-staged batch sets `halted`, which would skip the orphan-cleanup
`startServices` pass (`deploy.ts:562-567` runs it unconditionally today) and the entire tail
`waitForDependencyReadiness` block (`:590-660`). The draft claim "non-staged is byte-identical
because `halted` is always false" is only true when nothing fails. Corrected claim: **byte-identical
on the success path; on partial failure non-staged keeps running the orphan pass and the tail gate.**

### A4 — `failed[]` lives on `StagedBatchOutcomeBase`, not on `StagedBatchFailed` (blocker)

A batch that pulls badly but starts and gates fine is `passed` and still carries pull failures.
Today `deploy.ts:518-522` pushes them into `result.failed`, so `resolveDeployExitCode` returns 1
(`lib/exit-codes.ts:47`). If `passed` outcomes have nowhere to put them, that becomes exit 0 — a
silent regression on the **default non-staged path**. Pull failures never set `cause` but always
reach `report.failed`.

### A5 — `unhealthy` is `[]` when no gate ran (blocker)

`unhealthy = started.filter(s => gateReport?.services.find(v => v.service === s)?.status !== "ready")`
marks **every** started service unhealthy when `gateReport === undefined`, which is every non-staged
deploy and every `--staged --no-wait-for-ready` deploy. `report.healthy` empties,
`hasDeploySuccess` (`lib/exit-codes.ts:121-123`) goes false, and `--allow-partial` stops returning
`ExitCode.PartialSuccess` — the contract `deploy.spec.ts:1104` pins today. Required guard:

```ts
const unhealthy =
  gateReport === undefined
    ? []
    : started.filter((s) => gateReport.services.find((v) => v.service === s)?.status !== "ready");
```

### A6 — `attempted` = services a start was ISSUED for (`succeeded ∪ failed`)

Not just successes. `attempted` scopes the orphan pass, which today covers the full `services` list;
narrowing it to successes silently changes non-staged behaviour for a service whose `up` failed.
Excluding never-attempted batch members on a halt is the only property T7 needs.
`inspectContainersWithRetry` takes `staged ? attempted : services` so recorded history on the
non-staged path is unchanged.

### A7 — Gate short-circuits on a terminal `failed` verdict

Any verdict `status === "failed"` returns immediately with `{ ready: false, timedOut: false }` →
coordinator cause `"gate-unready"`. Exhausting the bound with only `pending` verdicts returns
`{ ready: false, timedOut: true }` → `"gate-timeout"`. Without this a crashed canary burns the full
60 s `--health-timeout` while holding the state lock, and §6's two causes are indistinguishable.

### A8 — `gate-progress` is wired end to end, or it is dead code

`ExecuteStagedRolloutDeps.gate` takes an `onProgress` callback and forwards it to
`waitForBatchReady`. Without this, `StagedRolloutEvent`'s `gate-progress` variant and
`WaitForBatchReadyOptions.onProgress` are both unreachable, and a 60 s batch gate prints nothing.
Precedent: `lastReadinessSignature` at `deploy.ts:599`.

### A9 — `onEvent` is guarded by `staged`, and the six legacy log lines are preserved

`deploy.ts:505-572` currently emits `logInfo("Pulling images in parallel...")` (`:507`),
`logWarn("Some images failed to pull: …")` (`:520`), `logSuccess("Successfully pulled images for N services")`
(`:525`), `logInfo("Skipping image pull (--skip-pull)")` (`:528`),
`logInfo("Starting Docker services in parallel…")` (`:532`), and
`logSuccess("Successfully started N services")` (`:557`). Deleting the block while wiring `onEvent`
unconditionally makes plain `rfapps deploy --parallel` print staged batch chatter instead. Required:
`onEvent: staged && !isMachineFormat(format) ? renderer : undefined`, and re-emit the six lines on
the `!staged` path (five inside the `runPhase` closure, the `--skip-pull` one before the call).

### A10 — Whole-package gates are not disjoint even when files are (major)

`npm run typecheck -w packages/rfapps-cli` compiles the whole package, so two tasks running in
parallel in one worktree cross-contaminate each other's acceptance checks. **Per-task gates are
scoped** (own spec file, or `npx tsc --noEmit` only where the task owns every file it touches), and
each batch closes with an explicit orchestrator-run **batch-close verification** step before the
next batch starts.

### A11 — `npm run format` is a no-op (major)

Root `format` is `prettier --write` with **no path argument**; it exits with
`[error] No parser and no file path given, couldn't infer a parser.` and writes nothing. Use
`npm run format:all` (or `format:rfapps` + `format:md`) and `npm run lint:md` for markdownlint,
which `format` never invokes. **All formatting is centralised in S12** (Batch 6, sole occupant) so a
repo-wide prettier run cannot rewrite files another task in the same batch owns.

### A12 — `setDeployExitCode` is preserved (blocker)

The edit at `deploy.ts` is anchored at **`:577-587`** (the loop body only). `:575`
`if (result.failed.length > 0) {` and `:576`
`setDeployExitCode(result, options.allowPartial ?? false);` are preserved **verbatim**. Deleting
them means no parallel-path deploy ever sets a non-zero exit code — the exact "exits 0 despite
halting" catastrophe this feature exists to prevent.

### A13 — `deploy.ts:259-264` — only line 260 is replaced (major)

`:261-264` declares `workerCount`, consumed at `:374`, `:399`, `:413`, `:503` and inside the new
`runPhase` closure. Replacing the whole `:259-264` range produces `Cannot find name 'workerCount'`
in five places and breaks `deploy.spec.ts:1033`, `:1049`, `:1171`. Replace **only**
`const useParallel = options.parallel ?? finalConfig.parallel.enabled;` at `:260` and insert the
staged resolution above it.

### A14 — Corrected line anchors (authoritative; supersedes both design and draft)

| Subject                                               | Correct anchor                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `classifyTargetObservation` `restarting`              | `src/lib/health.ts:173-175`                                                          |
| `exited` / `dead` branch                              | `src/lib/health.ts:176-178`                                                          |
| `state !== "running"` branch (T5a lands here)         | `src/lib/health.ts:179-181`                                                          |
| `imageId === undefined` branch                        | `src/lib/health.ts:182-184`                                                          |
| `!imageMatches` branch                                | `src/lib/health.ts:185-187`                                                          |
| terminal `stabilizing` / `ready`                      | `src/lib/health.ts:206-209`                                                          |
| `buildDependencyMap`                                  | `src/lib/health.ts:424-439`                                                          |
| inline stable-running predicate                       | `src/lib/health.ts:903-907` (`:908` is blank)                                        |
| `inspectTargetService`                                | `src/lib/health.ts:114-160`                                                          |
| `parallel-executor` skip-entry construction           | `src/lib/parallel-executor.ts:96-99`, string at `:98`                                |
| `parallel` start strips `--remove-orphans`            | `src/lib/parallel-executor.ts:236-240`                                               |
| `inspectContainers` argv build                        | `src/lib/docker.ts:2071`                                                             |
| `inspectContainers` parse                             | `src/lib/docker.ts:2081`                                                             |
| `inspectContainers` all-or-nothing `undefined`        | `src/lib/docker.ts:2075-2078`                                                        |
| `mcp/schema.ts` `import type … "../types/index.js"`   | `src/mcp/schema.ts:13-34`                                                            |
| `lib/index.ts` parallel-executor barrel block         | `src/lib/index.ts:311-313`                                                           |
| `types/index.ts` parallel block                       | `src/types/index.ts:354-361`; value-export precedent at `:39`                        |
| rf-common `fail(path, "no additional properties", …)` | `packages/rf-common/src/mcp/schema.ts:423-436`                                       |
| `/^\s+-/` help-line filter                            | `src/actions/completion.spec.ts:159`, inside `getCommanderCommandOptions` `:148-164` |
| `getLongOptionNames`                                  | `src/actions/completion.spec.ts:144-146`                                             |
| `cli.ts` `--workers` / `--wait-for-ready`             | `:363` / `:364-367` (insert the three staged options between them)                   |

### A15 — Items reported, NOT fixed, NOT tested (D5)

1. **`DeployResult` drift trap is only half closed.** `stagedSummary: McpSchema<StagedRolloutSummary>`
   anchors the summary shape only. `deployResult: McpSchema<DeployResult>` **cannot** be added today
   because `DeployResult.validation?: ConflictValidationResult` (`src/types/results.ts:118`) is
   undeclared in `deployResultSchema`. `validation` remains the latent trap, unreachable only
   because `validateFirst` is absent from all three input gates (`DeployToolArgs`
   `src/mcp/schema.ts:76-83`, `deployInputSchema` `:754-764`, `invokeDeploy`
   `src/mcp/adapters.ts:277-299`). File as follow-up.
2. **`deployInputSchema.parse({ staged: true })` throws only by `schemaObject`'s default
   `additionalProperties: false`**, untested for deploy input — symmetrical with the pre-existing
   `validateFirst` / `allowPartial` situation.
3. **A failed `docker compose ps` does not set `degraded`.** `getServiceStatusMap` logs an error and
   returns every service defaulted to `{ state: "created", health: "none" }`
   (`src/lib/service-status.ts:247-249`, `:268-271`), and `ReadinessSignalType` has only
   `"service-container-map" | "container-inspect"` (`src/types/health.ts:23`). Every batch member
   then classifies `pending`/`not-running` and the gate burns its full bound before halting on a
   transient daemon hiccup — the opposite of "degraded telemetry never halts". **Record this in the
   `staged-gate.ts` doc comment.** No test added.
4. **Degraded telemetry does NOT mask real failures** (verified, document in the same doc comment):
   `state` comes from `getServiceStatusMap` independently of `inspectContainers`, and
   `classifyTargetObservation` tests `state === "exited"` at `:176` **before**
   `imageId === undefined` at `:182`.
5. **Machine output carries no per-batch `cause`.** The per-service `"parallel-deploy"` render loop
   is retained rather than the design's one-`DockerCommandError`-per-batch sketch (the design
   contradicted itself; the §7 table row is authoritative). Consequence: `StagedBatchFailureCause`
   reaches the operator through `formatStagedSummary`, which is text-only. Mitigation without a new
   test: the coordinator embeds the cause in the per-service `failed[].error` strings it produces.

---

## 1. Contended files and how batching avoids collisions

Every file below is owned by **exactly one** task. Tasks inside a batch never share a file.

| Contended file                                               | Sole owner | Why contended                                                                             | Resolution                                                                                            |
| ------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/types/index.ts`                     | **S1**     | Barrel; three type tasks would all want it                                                | S1 owns all four `src/types/*` edits in one task                                                      |
| `packages/rfapps-cli/src/lib/index.ts`                       | **S7**     | Barrel; S4 and S5 both need exports through it                                            | S7 is a dedicated Batch 3 task, after S4/S5 exist. S4/S5 do **not** touch the barrel                  |
| `packages/rfapps-cli/src/actions/deploy.ts`                  | **S8**     | Largest change surface                                                                    | S8 alone owns it, Batch 4                                                                             |
| `packages/rfapps-cli/src/actions/deploy.spec.ts`             | **S8**     | `vi.mock("../lib/index.js")` at `:14` is a bare automock; 8 parallel-mode tests break     | Bundled into S8 (see A2 / S8 spec section). Not separable                                             |
| `packages/rfapps-cli/src/cli.ts`                             | **S9**     | Flag registration + `preAction` guard                                                     | S9 owns it, Batch 4, disjoint from S8                                                                 |
| `packages/rfapps-cli/src/actions/completion.ts` + `.spec.ts` | **S9**     | Parity assertion at `completion.spec.ts:319-322` fails hard and aborts on the first shell | Bundled into S9; all four `completion.ts` edits + `cli.ts` land together                              |
| `packages/rfapps-cli/src/lib/health.ts`                      | **S2**     | Two `export` keywords + one predicate extraction                                          | S2 owns it, Batch 1. D1 removes the `sleep` deletion, so this is a small change to a well-tested file |
| `packages/rfapps-cli/src/lib/parallel-executor.ts`           | **S3**     | One `export` keyword                                                                      | S3 owns it, Batch 1                                                                                   |
| `packages/rfapps-cli/src/mcp/schema.ts`                      | **S6**     | Needs `StagedRolloutSummary` in scope                                                     | S6 is Batch 2, strictly after S1 (**build-order blocker**)                                            |
| `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`     | **S10**    | Needs both `deploy.ts` and `cli.ts` complete                                              | S10 is Batch 5                                                                                        |
| Repo-wide prettier / markdownlint                            | **S12**    | A repo-wide `--write` rewrites other tasks' files                                         | All formatting centralised in S12, Batch 6, sole occupant (A11)                                       |

### Batch / task table

| Batch | Task | Owns (exclusive)                                                                                  | Depends on | Scoped acceptance gate                                                 |
| ----- | ---- | ------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------- |
| 1     | S1   | `src/types/staged.ts` (new), `src/types/index.ts`, `src/types/results.ts`, `src/types/options.ts` | —          | `npx tsc --noEmit -p .` (S1 is the only in-flight task touching types) |
| 1     | S2   | `src/lib/health.ts`                                                                               | —          | `npx vitest run src/lib/health.spec.ts`                                |
| 1     | S3   | `src/lib/parallel-executor.ts`                                                                    | —          | `npx vitest run src/lib/parallel-executor.spec.ts`                     |
| —     | B1   | _batch close_                                                                                     | S1-S3      | `npm run typecheck -w packages/rfapps-cli`                             |
| 2     | S4   | `src/lib/staged-gate.ts` (new), `src/lib/staged-gate.spec.ts` (new)                               | S1, S2     | `npx vitest run src/lib/staged-gate.spec.ts`                           |
| 2     | S5   | `src/lib/staged-rollout.ts` (new), `src/lib/staged-rollout.spec.ts` (new)                         | S1, S3     | `npx vitest run src/lib/staged-rollout.spec.ts`                        |
| 2     | S6   | `src/mcp/schema.ts`                                                                               | S1         | `npx vitest run src/mcp/schema.spec.ts`                                |
| —     | B2   | _batch close_                                                                                     | S4-S6      | `npm run typecheck -w packages/rfapps-cli`                             |
| 3     | S7   | `src/lib/index.ts`                                                                                | S4, S5     | `npm run typecheck -w packages/rfapps-cli` + unit specs (see S7)       |
| 4     | S8   | `src/actions/deploy.ts`, `src/actions/deploy.spec.ts`                                             | S1, S7     | `npx vitest run src/actions/deploy.spec.ts`                            |
| 4     | S9   | `src/cli.ts`, `src/actions/completion.ts`, `src/actions/completion.spec.ts`                       | —          | `npx vitest run src/actions/completion.spec.ts`                        |
| —     | B4   | _batch close_                                                                                     | S8, S9     | `npm run typecheck -w packages/rfapps-cli`                             |
| 5     | S10  | `src/cli.deploy.integration.spec.ts`                                                              | S8, S9     | `npx vitest run src/cli.deploy.integration.spec.ts`                    |
| 5     | S11  | `packages/rfapps-cli/README.md`, 6 `docs/features/*.md`, `ROADMAP.md`                             | S9         | `npm run lint:md`                                                      |
| 6     | S12  | _none (read + run + format)_                                                                      | S1-S11     | full verification suite (§S12)                                         |

All `npx` commands run from `packages/rfapps-cli/`; `npm run` commands from the worktree root.

---

## Batch 1 — Foundations (3 tasks, fully parallel)

### S1 — Staged type model

**Files owned (exclusive):** `packages/rfapps-cli/src/types/staged.ts` (NEW),
`packages/rfapps-cli/src/types/index.ts`, `packages/rfapps-cli/src/types/results.ts`,
`packages/rfapps-cli/src/types/options.ts`

**Depends on:** nothing.

#### `src/types/staged.ts` (new)

`src/types/*` never imports from `src/lib/*` (verified: zero matches for `from "../lib/` under
`src/types/`), so `StagedExecOptions` is declared **structurally**, not by importing
`DockerComposeExecOptions`.

```ts
import type { EnvToolExecConfig } from "./options.js";
import type { ExecutionPhase } from "./parallel.js";
import type { FailedOperation } from "./results.js";
import type { TargetVerificationResult } from "./health.js";

export type StagedFailurePolicy = "halt" | "continue";

export function isStagedFailurePolicy(value: unknown): value is StagedFailurePolicy {
  return value === "halt" || value === "continue";
}

export interface StagedExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  replaceEnv?: boolean;
  envFile?: string;
  projectName?: string;
  envTool?: EnvToolExecConfig;
}

/**
 * `projectDir` and `profiles` are REQUIRED on purpose — see design §3.
 * Spreading `deployExecution` alone would silently drop `cwd` and omit `profiles`.
 */
export interface StagedExecutionContext {
  composePath: string;
  projectDir: string;
  profiles: string[];
  exec: StagedExecOptions;
}

export interface StagedBatch {
  /** 1-based index across the whole rollout */
  index: number;
  /** Members in blast-radius order (least critical first) */
  services: string[];
  /** Phase-preserving slice for executeParallelPhases; original phase numbers + dependsOn */
  phases: ExecutionPhase[];
}

export interface StagedPlan {
  batches: StagedBatch[];
  batchSize: number;
  onFailure: StagedFailurePolicy;
  totalServices: number;
}

export type StagedGateReason = TargetVerificationResult["reason"] | "completed";

export interface StagedServiceVerdict {
  service: string;
  status: "ready" | "pending" | "failed";
  reason: StagedGateReason;
  assurance: "healthcheck" | "running-only";
  stableForMs: number;
}

export interface StagedGateReport {
  ready: boolean;
  timedOut: boolean;
  degraded: boolean;
  elapsedMs: number;
  attempts: number;
  services: StagedServiceVerdict[];
}

export type StagedBatchFailureCause = "dependency-skipped" | "start-failed" | "gate-unready" | "gate-timeout";

interface StagedBatchOutcomeBase {
  batch: StagedBatch;
  /**
   * Every failure attributable to this batch, INCLUDING pull failures, which never
   * set `cause` but must still reach DeployResult.failed (see A4). On the base, not
   * on StagedBatchFailed, so a `passed` batch can carry them.
   */
  failed: FailedOperation[];
}

export interface StagedBatchPassed extends StagedBatchOutcomeBase {
  status: "passed";
  started: string[];
  /** Undefined when gating is disabled via --no-wait-for-ready or on the non-staged path */
  gate?: StagedGateReport;
}

export interface StagedBatchFailed extends StagedBatchOutcomeBase {
  status: "failed";
  started: string[];
  /** Started but not ready at the gate bound. ALWAYS [] when no gate ran (see A5). */
  unhealthy: string[];
  cause: StagedBatchFailureCause;
  gate?: StagedGateReport;
}

export interface StagedBatchSkipped extends StagedBatchOutcomeBase {
  status: "skipped";
  reason: "rollout-halted";
}

export type StagedBatchOutcome = StagedBatchPassed | StagedBatchFailed | StagedBatchSkipped;

export type StagedRolloutStatus = "completed" | "halted" | "degraded";

export interface StagedRolloutReport {
  status: StagedRolloutStatus;
  batchSize: number;
  onFailure: StagedFailurePolicy;
  totalBatches: number;
  completedBatches: number;
  haltedAtBatch?: number;
  batches: StagedBatchOutcome[];
  /** Services a runPhase("start") was ISSUED for: succeeded ∪ failed (see A6). */
  attempted: string[];
  /** Sum of started counts across non-skipped batches. */
  started: number;
  /** attempted minus unhealthy. */
  healthy: string[];
  /** Started but not ready at a gate bound; [] when no gate ran anywhere. */
  unhealthy: string[];
  /** Σ outcome.failed + one STAGE_NOT_ATTEMPTED entry per member of every skipped batch. */
  failed: FailedOperation[];
}

export interface StagedRolloutSummary {
  status: StagedRolloutStatus;
  batchSize: number;
  onFailure: StagedFailurePolicy;
  totalBatches: number;
  completedBatches: number;
  haltedAtBatch?: number;
}

export type StagedRolloutEvent =
  | { kind: "batch-start"; batch: StagedBatch; totalBatches: number }
  | { kind: "gate-progress"; batch: StagedBatch; pending: string[] }
  | { kind: "batch-passed"; batch: StagedBatch; started: string[]; elapsedMs: number }
  | {
      kind: "batch-failed";
      batch: StagedBatch;
      cause: StagedBatchFailureCause;
      failed: string[];
      unhealthy: string[];
      elapsedMs: number;
    }
  | { kind: "gate-degraded"; batch: StagedBatch }
  | { kind: "rollout-halted"; haltedAtBatch: number; totalBatches: number; skipped: string[] };
```

#### `src/types/index.ts`

Insert a new block immediately after the parallel block that closes at `:361`. The barrel uses
**explicit named exports**, not `export *`. `isStagedFailurePolicy` is a value, so it needs a value
export alongside the precedent at `:39`.

```ts
// Staged rollout types
export type {
  StagedFailurePolicy,
  StagedExecOptions,
  StagedExecutionContext,
  StagedBatch,
  StagedPlan,
  StagedGateReason,
  StagedServiceVerdict,
  StagedGateReport,
  StagedBatchFailureCause,
  StagedBatchPassed,
  StagedBatchFailed,
  StagedBatchSkipped,
  StagedBatchOutcome,
  StagedRolloutStatus,
  StagedRolloutReport,
  StagedRolloutSummary,
  StagedRolloutEvent,
} from "./staged.js";
export { isStagedFailurePolicy } from "./staged.js";
```

#### `src/types/results.ts`

`DeployResult` (`:106-119`) ends at `:118` with `validation?: ConflictValidationResult;`. Add as
last member, plus `import type { StagedRolloutSummary } from "./staged.js";`:

```ts
  /** Staged rollout summary, present only when --staged was used */
  staged?: StagedRolloutSummary;
```

`staged.ts` imports `FailedOperation` from `./results.js` — a **type-only** cycle, erased at
compile time. Both sides MUST use `import type`.

#### `src/types/options.ts`

`DeployOptions` (`:86-103`) ends with `workers?: number;`. Add after it, plus
`import type { StagedFailurePolicy } from "./staged.js";`:

```ts
  /** Roll out services in dependency-ordered batches with a health gate */
  staged?: boolean;
  /** Services per staged batch */
  batchSize?: number;
  /** Staged batch failure policy */
  onFailure?: StagedFailurePolicy;
```

**Scoped acceptance:** from `packages/rfapps-cli/`, `npx tsc --noEmit -p .` — zero errors. No
behaviour change, so no test change.

---

### S2 — Export two health primitives; extract the stable-running predicate

**Files owned (exclusive):** `packages/rfapps-cli/src/lib/health.ts`

**Depends on:** nothing. **Do NOT delete the private `sleep` at `:94-96` (A1).**

1. `:98` — add `export` to `normalizeTargetState`. Signature unchanged.
2. `:162` — add `export` to `classifyTargetObservation`. Signature unchanged and **must stay**
   `(observation: TargetServiceObservation, expectedImageId: string, stableForMs: number, stableRunningMs: number): TargetVerificationResult`.
   Do not widen `expectedImageId` — it flows into `managed-update` and a versioned on-disk plan
   schema.
3. `:903-907` — extract the inline predicate into a new exported function placed beside
   `classifyTargetObservation`:

```ts
/**
 * True when a healthcheck-less target satisfies every non-health precondition and
 * may therefore accumulate its bounded stable-running window.
 *
 * `expectedImageId === undefined` skips the image assertion; the staged batch gate
 * has no reviewed image to compare against, whereas verifyServiceReadiness always
 * has one (VerifyServiceReadinessOptions.expectedImageId is a required string,
 * lib/health.ts:74), so passing it through is semantically identical.
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

Then replace the inline object at `:903-907` with:

```ts
const canAccumulateStability = canAccumulateStableRunning(observation, options.expectedImageId);
```

Do **not** add either symbol to `src/lib/index.ts` — `staged-gate.ts` imports them deep from
`./health.js` (lib→lib, automocked nowhere).

**Scoped acceptance:** `npx vitest run src/lib/health.spec.ts` — all green, in particular
`"requires a bounded stable-running window when no healthcheck exists"` (`:742`).

---

### S3 — Export `filterByDependencyFailures`

**Files owned (exclusive):** `packages/rfapps-cli/src/lib/parallel-executor.ts`

**Depends on:** nothing.

Single change at `:367`: add `export`. Signature, body and doc comment unchanged:

```ts
export function filterByDependencyFailures(
  phase: ExecutionPhase,
  failedServices: Set<string>,
  dependencyMap?: Map<string, string[]>,
): { executable: string[]; skipped: string[] };
```

Do **not** add it to `src/lib/index.ts` — `staged-rollout.ts` imports it deep from
`./parallel-executor.js`; a barrel re-export would only add automock noise to `deploy.spec.ts`.

**Scoped acceptance:** `npx vitest run src/lib/parallel-executor.spec.ts`.

**Batch 1 close (B1):** `npm run typecheck -w packages/rfapps-cli` — zero errors.

---

## Batch 2 — Feature modules (3 tasks, fully parallel)

### S4 — `lib/staged-gate.ts` + T5

**Files owned (exclusive):** `packages/rfapps-cli/src/lib/staged-gate.ts` (NEW, ~210 lines),
`packages/rfapps-cli/src/lib/staged-gate.spec.ts` (NEW)

**Depends on:** S1 (types), S2 (health exports).

#### Public surface (exact)

```ts
import type { ReadinessPollSettings, ReadinessSignalAvailability, TargetServiceObservation } from "../types/health.js";
import type { StagedExecutionContext, StagedGateReport, StagedServiceVerdict } from "../types/staged.js";

/**
 * Batch-gate observation. Superset of TargetServiceObservation with the container
 * restart policy, needed to exempt completed one-shot jobs.
 *
 * `restartPolicy` mirrors ContainerInspect.HostConfig.RestartPolicy.Name
 * (lib/docker.ts:2036-2039). Docker emits "", "no", "always", "unless-stopped",
 * or "on-failure". TargetServiceObservation is deliberately NOT widened —
 * managed-update and reconcile depend on it.
 */
export interface StagedServiceObservation extends TargetServiceObservation {
  restartPolicy?: string;
}

export interface StagedBatchObservation {
  services: Map<string, StagedServiceObservation>;
  signalAvailability: ReadinessSignalAvailability;
}

export type StagedBatchObserver = (services: string[]) => Promise<StagedBatchObservation>;

/** Builds the default 3-Docker-call batched observer. */
export function createBatchObserver(ctx: StagedExecutionContext): StagedBatchObserver;

/** True for a container that ran to completion by design. */
export function isCompletedOneShot(observation: StagedServiceObservation): boolean;

export interface WaitForBatchReadyOptions {
  /** The batch's own started services. MUST be non-empty (empty-batch guard throws). */
  services: string[];
  poll: ReadinessPollSettings;
  /** false collapses maxAttempts to 1 (snapshot mode) */
  waitForReady: boolean;
  onProgress?: (pending: string[]) => void;
}

export interface WaitForBatchReadyDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  observe: StagedBatchObserver;
}

export async function waitForBatchReady(
  options: WaitForBatchReadyOptions,
  injected: Partial<WaitForBatchReadyDeps> & Pick<WaitForBatchReadyDeps, "observe">,
): Promise<StagedGateReport>;
```

Resolve `const now = injected.now ?? Date.now;` and `const pollSleep = injected.sleep ?? sleep;`
where `sleep` is a module-private three-liner (A1). `observe` is required — there is no sensible
default without a context.

#### File doc comment — three required statements

1. Degraded telemetry does **not** mask real failures (A15 item 4).
2. A failed `docker compose ps` does **not** set `degraded` (A15 item 3) — known limitation.
3. `waitForBatchReady` throws on an empty `services` array, because `resolveTargetServices` returns
   `Object.keys(composeServices)` — every service in the compose file — on an empty request
   (`src/lib/health.ts:407-419`), so any future reordering that let a gate run on an empty set would
   silently turn the batch gate into a whole-compose-file poll.

#### `createBatchObserver` — implementation contract

Three Docker calls per attempt, independent of batch size.

1. `getServiceStatusMap(ctx.composePath, ctx.projectDir, { ...ctx.exec, profiles: ctx.profiles, preloadedServices: [...services], cacheTtlMs: 0, forceRefresh: true, timeoutMs: 15_000 })`
   - `preloadedServices` **mandatory**: without it `getServiceStatusMap` makes a second Docker call
     for `getComposeServices` (`src/lib/service-status.ts:229-238`) on top of
     `docker compose ps -a --format json` (`:253-267`) — four calls, not three — and scopes the map
     to the whole compose file. Declared at `src/lib/service-status.ts:169`.
   - `cacheTtlMs: 0, forceRefresh: true` **mandatory** or the gate reads pre-batch state from the
     10-second module cache.
   - `ctx.projectDir` positional; `ctx.profiles` explicit. Neither is in `ctx.exec`.
2. `getRunningServiceContainerMap(ctx.composePath, { ...ctx.exec, profiles: ctx.profiles, timeout: 15_000 })`
   — the field is `timeout`, **not** `timeoutMs` (`src/lib/docker.ts:1001-1008`). `undefined` →
   push `"service-container-map"` onto `unavailableSignals`.
3. Names = `services.map((s) => map?.get(s)).filter((n): n is string => n !== undefined)`. **Skip
   the call entirely when empty.** Otherwise
   `inspectContainers(names, { ...ctx.exec, timeout: 15_000 })`; `undefined` → push
   `"container-inspect"`. Index by `Name` with the leading `/` stripped:
   `new Map(raw.map((c) => [c.Name.replace(/^\//, ""), c]))`.

`ReadinessSignalType` has exactly two members (`src/types/health.ts:23`) — those are the only legal
values. `signalAvailability = { available: unavailableSignals.length === 0, unavailableSignals }`.

Per-service observation:

```ts
{
  imageId: inspected?.Image,
  state: normalizeTargetState(statusMap.get(service)?.state),
  exitCode: inspected?.State.ExitCode,
  health: statusMap.get(service)?.health ?? "unknown",
  restartPolicy: inspected?.HostConfig.RestartPolicy?.Name,
}
```

`ContainerInspect` exposes `Name: string` (`:2013`), `Image: string` (`:2015`),
`State.ExitCode: number` (`:2053`), and required `HostConfig` with optional
`RestartPolicy?: { Name: string }` (`:2036-2039`), so the optional chain typechecks.

#### `isCompletedOneShot`

```ts
/**
 * True for a container that ran to completion by design.
 *
 * Required, not defensive: compose.yml:1326-1340 defines plex-ratings-sync with
 * `command: sync`, `restart: on-failure:10` and no healthcheck, driven by the
 * Ofelia schedule label at compose.yml:1360, and it is a member of media-stack.
 * Once its sync job finishes it sits at exited(0) and classifyTargetObservation
 * would return { status: "failed", reason: "exited" } (lib/health.ts:176-178).
 *
 * A container with an always-restart policy that is `exited` is genuinely broken
 * and must still fail the gate.
 */
export function isCompletedOneShot(obs: StagedServiceObservation): boolean {
  if (obs.state !== "exited" || obs.exitCode !== 0) return false;
  const policy = obs.restartPolicy ?? "";
  return policy === "" || policy === "no" || policy === "on-failure";
}
```

#### Poll loop

Module constant `const STABLE_RUNNING_MS = 5000;` (matches `stableRunningSeconds ?? 5` at
`src/lib/health.ts:894`). Not exposed as a flag.

```text
timeoutMs   = options.poll.timeoutSeconds * 1000
intervalMs  = options.poll.intervalSeconds * 1000
maxAttempts = options.waitForReady ? Math.max(1, options.poll.retries) : 1
startedAt   = now()
stableSince = new Map<string, number>()

for (attempt = 1; ; attempt++):
  observation = await observe(options.services)
  observedAt  = now()

  verdicts = options.services.map(service => {
    obs = observation.services.get(service) ?? { state: "missing", health: "unknown" }
    if (canAccumulateStableRunning(obs, undefined)) { stableSince.has(service) || stableSince.set(service, observedAt) }
    else stableSince.delete(service)
    stableForMs = stableSince.has(service) ? observedAt - stableSince.get(service)! : 0

    if (isCompletedOneShot(obs))
      return { service, status: "ready", reason: "completed", assurance: "running-only", stableForMs: 0 }

    const t = classifyTargetObservation(obs, obs.imageId ?? "", stableForMs, STABLE_RUNNING_MS)
    return { service, status: t.status, reason: t.reason, assurance: t.assurance, stableForMs: t.stableForMs }
  })

  ready     = verdicts.every(v => v.status === "ready")
  anyFailed = verdicts.some(v => v.status === "failed")
  degraded  = observation.signalAvailability.available === false
  elapsedMs = observedAt - startedAt
  timedOut  = !ready && !anyFailed && (elapsedMs >= timeoutMs || attempt >= maxAttempts)

  emit options.onProgress(pending) when the pending signature changes
  if (ready || anyFailed || timedOut)
    return { ready, timedOut, degraded, elapsedMs, attempts: attempt, services: verdicts }
  await pollSleep(intervalMs)
```

**The projection step is mandatory.** `classifyTargetObservation` returns
`TargetVerificationResult`, which `extends TargetServiceObservation` (`src/types/health.ts:146`)
and carries `state`/`health`/`imageId`/`exitCode`/`imageMatches` but **not** `service`, which
`StagedServiceVerdict` requires. A bare ternary does not compile.

`obs.imageId ?? ""` is safe: the `imageId === undefined` branch (`src/lib/health.ts:182-184`)
precedes `if (!imageMatches)` (`:185-187`).

The `anyFailed` short-circuit is A7 — load-bearing, not an optimisation.

#### T5 — `src/lib/staged-gate.spec.ts`

Exactly one `it`, imported directly from `./staged-gate.js` (no barrel, no `vi.mock`).

**`it("gates on the batch's own services with a bounded soak, and exempts completed one-shots")`**

Mirror the virtual-clock factory at `src/lib/health.spec.ts:571-593` — time advances **only** inside
the mocked `sleep`, `now()` is a closure read, **no `vi.useFakeTimers()`**. The frame helper must
**hold the last frame**, not drain to `undefined` (a bare `frames.shift() ?? frames.at(-1)!` lies
once the array empties and throws a `TypeError` instead of repeating):

```ts
function createGateDeps(frames: StagedBatchObservation[]) {
  let currentTime = 0;
  let last: StagedBatchObservation | undefined;
  const observe = vi.fn(async () => {
    const next = frames.shift();
    if (next !== undefined) last = next;
    if (last === undefined) throw new Error("no observation frames");
    return last;
  });
  const sleep = vi.fn(async (ms: number) => {
    currentTime += ms;
  });
  return { deps: { now: () => currentTime, sleep, observe }, observe, sleep };
}
```

Sub-assertions:

- **(a) a dependency-free batch does not pass instantly.** Target observed
  `{ state: "created", health: "unknown" }` lands on `src/lib/health.ts:179-181` →
  `pending`/`not-running`. With `poll: { timeoutSeconds: 600, intervalSeconds: 1, retries: 2 }` the
  report is `{ ready: false, timedOut: true, attempts: 2, elapsedMs: 1000 }` — which also proves the
  attempt bound fires before the wall clock. This is the `health.ts:735` short-circuit trap.
- **(b) bounded soak for a healthcheck-less service.**
  `{ state: "running", health: "none", exitCode: 0, imageId: "sha256:a" }` repeated,
  `poll: { timeoutSeconds: 30, intervalSeconds: 1, retries: 12 }` → attempts 1-5 are
  `pending`/`stabilizing`, report is `{ ready: true, attempts: 6, elapsedMs: 5000 }`, verdict is
  `{ assurance: "running-only", reason: "ready", stableForMs: 5000 }`.
- **(c) one-shot exemption.** `{ state: "exited", exitCode: 0, restartPolicy: "on-failure" }` →
  `{ status: "ready", reason: "completed", assurance: "running-only" }`.
  `{ state: "exited", exitCode: 0, restartPolicy: "always" }` → `{ status: "failed", reason: "exited" }`
  and the report returns immediately (`ready: false, timedOut: false, attempts: 1`) per A7.

**Scoped acceptance:** `npx vitest run src/lib/staged-gate.spec.ts`. `src/**/*.spec.ts` is
auto-globbed (`packages/rfapps-cli/vitest.config.ts:8`) — no config change.

---

### S5 — `lib/staged-rollout.ts` + T1-T4

**Files owned (exclusive):** `packages/rfapps-cli/src/lib/staged-rollout.ts` (NEW, ~350 lines),
`packages/rfapps-cli/src/lib/staged-rollout.spec.ts` (NEW)

**Depends on:** S1 (types), S3 (`filterByDependencyFailures` export).

#### Public surface (exact)

```ts
import { filterByDependencyFailures } from "./parallel-executor.js";
import { STATE_LOCK_STALE_AFTER_MS } from "./state-lock.js";
import type { DependencyGraph, ExecutionPhase } from "../types/parallel.js";
import type { FailedOperation } from "../types/results.js";
import type {
  StagedBatch,
  StagedBatchOutcome,
  StagedFailurePolicy,
  StagedGateReport,
  StagedPlan,
  StagedRolloutEvent,
  StagedRolloutReport,
  StagedRolloutSummary,
} from "../types/staged.js";

/** Pure. No Docker, no I/O, no logging. */
export function planStagedBatches(input: {
  graph: DependencyGraph;
  batchSize: number;
  onFailure: StagedFailurePolicy;
  /** RfappsConfig.profiles.mapping — service to profile name */
  profileMapping: Readonly<Record<string, string>>;
}): StagedPlan;

export type StagedPhaseOperation = "pull" | "start";

export interface StagedRunPhaseResult {
  succeeded: string[];
  failed: FailedOperation[];
}

export interface ExecuteStagedRolloutOptions {
  plan: StagedPlan;
  /** graph.dependencyMap; undefined degrades to the phase-level dependsOn rule */
  dependencyMap?: Map<string, string[]>;
  skipPull: boolean;
  onEvent?: (event: StagedRolloutEvent) => void;
}

export interface ExecuteStagedRolloutDeps {
  runPhase: (input: {
    operation: StagedPhaseOperation;
    batch: StagedBatch;
    /** batch.phases re-sliced to the executable members only */
    phases: ExecutionPhase[];
  }) => Promise<StagedRunPhaseResult>;
  /** undefined disables per-batch gating (--no-wait-for-ready or non-staged) */
  gate?: (input: {
    batch: StagedBatch;
    started: string[];
    onProgress: (pending: string[]) => void;
  }) => Promise<StagedGateReport>;
}

export async function executeStagedRollout(
  options: ExecuteStagedRolloutOptions,
  deps: ExecuteStagedRolloutDeps,
): Promise<StagedRolloutReport>;

export function summarizeStagedRollout(report: StagedRolloutReport): StagedRolloutSummary;

export function formatStagedPlan(plan: StagedPlan, options: { perBatchGateSeconds: number }): string;

export function stagedExceedsLockStaleness(plan: StagedPlan, perBatchGateSeconds: number): boolean;

export interface StagedEventRender {
  level: "info" | "warn";
  message: string;
}
export function formatStagedEvent(event: StagedRolloutEvent): StagedEventRender;

export function formatStagedSummary(report: StagedRolloutReport): string[];
```

The `onProgress` parameter on `gate` is A8 — without it `gate-progress` is unreachable dead code.

#### `planStagedBatches` — algorithm

1. **Reverse fan-in.** From `graph.dependencyMap` (present whenever `!hasCycles`,
   `src/types/parallel.ts:80-81`), for each `[service, deps]` increment `fanIn[dep]` per dep.
   `undefined` map → every fan-in 0.
2. **Order within each phase** by `[criticalityTier, fanIn, name]` ascending,
   `criticalityTier = profileMapping[service] === "core" ? 1 : 0`. Criticality is load-bearing:
   `traefik` is depended on through routing labels, not `depends_on`, so its fan-in is 0; without
   the tier, `--batch-size 1` on `infra-stack` canaries `cloudflared`.
3. **Flatten** phases in phase order.
4. **Chunk** into slices of at most `batchSize`. Batches MAY span a phase boundary.
5. **Slice phases per batch:** walk `graph.phases`, filter each `phase.services` to the batch
   members **preserving source order**, drop now-empty phases, preserve the original `phase` number
   and `dependsOn` (`ExecutionPhase = { phase; services; dependsOn }`, all required,
   `src/types/parallel.ts:30-37`).

Missing-`dependencyMap` degrades, never hard-fails: `computeExecutionPhases`
(`src/lib/dependency-graph.ts:510`) falls back to a single phase 0 when `getComposeConfig` returns
`undefined` (`:521-533`) — reachable from a dotenvx hiccup. Ordering falls back to `[tier, name]`.

**Non-staged compatibility requirement:** with `batchSize >= totalServices`, step 5 must reproduce
`graph.phases` **exactly** (same phase numbers, same per-phase service order).

Reference output — `infra-stack --batch-size 3`, 14 services, `ceil(14/3) = 5` batches:

```text
  Batch 1 [canary]  phase 0    homarr, ofelia, speedtest-tracker
  Batch 2           phase 0    stirling-pdf, uptime-kuma, forgejo-postgres
  Batch 3           phase 0    cloudflared, docktail, traefik
  Batch 4           phase 1-2  forgejo, forgejo-itcn-runner, forgejo-runner
  Batch 5           phase 2    forgejo-runner-2, forgejo-runner-3
```

#### `executeStagedRollout` — loop contract

`skippedEntries` is a **per-batch local**, not a rollout accumulator: `STAGE_DEPENDENCY_SKIPPED`
entries are recorded **only** on the batch outcome's `failed[]`, so the rollout-level `failed`
derives purely from `Σ outcome.failed` plus the `STAGE_NOT_ATTEMPTED` synthesis. Recording them in
both places duplicates; recording them in neither drops them (T3's `continue` arm asserts on them).

```text
rolloutFailed = new Set<string>()   // owned here: executeParallelPhases resets its own
                                    // allFailedServices on EVERY call (parallel-executor.ts:76)
halted = false
haltedAtBatch: number | undefined
attempted: string[] = []
outcomes: StagedBatchOutcome[] = []

for (batch of plan.batches):
  if (halted):
    outcomes.push({ batch, status: "skipped", reason: "rollout-halted", failed: [] })
    continue                                    // ZERO Docker calls

  emit { kind: "batch-start", batch, totalBatches: plan.batches.length }
  batchStartedAt = Date.now()

  executable = [], skipped = [], batchFailed: FailedOperation[] = []
  for (phase of batch.phases):
    r = filterByDependencyFailures(phase, rolloutFailed, options.dependencyMap)
    executable.push(...r.executable); skipped.push(...r.skipped)

  for (s of skipped):
    rolloutFailed.add(s)
    batchFailed.push({ name: s, code: "STAGE_DEPENDENCY_SKIPPED",
                       error: "Skipped: dependency failed in an earlier batch" })

  if (executable.length === 0):
    outcome = { batch, status: "failed", started: [], failed: batchFailed,
                unhealthy: [], cause: "dependency-skipped" }
    // NO runPhase call at all — T3 asserts this
    → apply the failure policy; continue

  phases = sliceToServices(batch.phases, executable)

  if (!options.skipPull):
    pull = await deps.runPhase({ operation: "pull", batch, phases })
    batchFailed.push(...pull.failed)            // NEVER sets `cause` (A4)

  start = await deps.runPhase({ operation: "start", batch, phases })
  started = start.succeeded
  attempted.push(...started, ...start.failed.map(f => f.name))   // A6
  for (f of start.failed) { rolloutFailed.add(f.name)
                            if (!batchFailed.some(e => e.name === f.name)) batchFailed.push(f) }

  if (started.length === 0):
    outcome = { batch, status: "failed", started: [], failed: batchFailed,
                unhealthy: [], cause: "start-failed" }        // empty-batch guard: no gate call
  else:
    gateReport = deps.gate
      ? await deps.gate({ batch, started,
                          onProgress: (pending) => emit({ kind: "gate-progress", batch, pending }) })
      : undefined
    anyGateFailed = gateReport?.services.some(v => v.status === "failed") ?? false
    passes = gateReport === undefined
          || gateReport.ready
          || (gateReport.degraded && !anyGateFailed)           // "degraded never halts"
    if (gateReport?.degraded) emit { kind: "gate-degraded", batch }

    unhealthy = gateReport === undefined ? []                  // A5 — MUST guard
      : started.filter(s => gateReport.services.find(v => v.service === s)?.status !== "ready")

    if (passes && start.failed.length === 0):
      outcome = { batch, status: "passed", started, failed: batchFailed, gate: gateReport }
    else:
      cause = start.failed.length > 0 ? "start-failed"
            : gateReport?.timedOut ? "gate-timeout" : "gate-unready"
      for (s of unhealthy):
        rolloutFailed.add(s)
        if (!batchFailed.some(e => e.name === s))
          batchFailed.push({ name: s, code: "STAGE_GATE_FAILED",
                             error: `Batch ${batch.index} failed (${cause}): ${verdictReason(s)}` })
      outcome = { batch, status: "failed", started, failed: batchFailed, unhealthy, cause,
                  gate: gateReport }

  if outcome.status === "failed":
    emit { kind: "batch-failed", batch, cause, failed, unhealthy, elapsedMs }
    if (plan.onFailure === "halt") { halted = true; haltedAtBatch = batch.index }
  else emit { kind: "batch-passed", batch, started, elapsedMs }

after the loop:
  if (halted) emit { kind: "rollout-halted", haltedAtBatch, totalBatches,
                     skipped: <all members of skipped batches> }
```

Embedding `cause` in the `STAGE_GATE_FAILED` error string is what carries the batch cause into
machine output (A15 item 5).

Projection into the returned `StagedRolloutReport`:

```text
status           = halted ? "halted" : (any batch failed ? "degraded" : "completed")
completedBatches = count of outcomes with status "passed"
attempted        = accumulated issued-start services (succeeded ∪ failed)
started          = Σ over non-skipped outcomes of outcome.started.length
unhealthy        = Σ over failed outcomes of outcome.unhealthy
healthy          = attempted, minus unhealthy
failed           = Σ over ALL outcomes of outcome.failed     // includes pull failures on passed
                 + ONE entry per service in EVERY skipped batch:
                   { name, code: "STAGE_NOT_ATTEMPTED",
                     error: `Not attempted: staged rollout halted after batch ${haltedAtBatch} of ${totalBatches}` }
```

**The `STAGE_NOT_ATTEMPTED` entries are the single most dangerous failure mode of the feature.**
`resolveDeployExitCode` computes `hasFailure = result.failed.length > 0 || result.unhealthy.length > 0`
and returns `ExitCode.Success` when `!hasFailure` (`src/lib/exit-codes.ts:46-51`). Without them a
halted rollout **exits 0** while abandoning most of the group. `code` is optional on
`FailedOperation` (`src/types/results.ts:198`) and already used by `validationFailureEntry`
(`src/actions/deploy.ts:102-118`). `STAGE_DEPENDENCY_SKIPPED` mirrors the executor's own skip
entries at `src/lib/parallel-executor.ts:96-99` (string at `:98`).

#### Formatters

- `formatStagedPlan(plan, { perBatchGateSeconds })` → the multi-line plan block. Phase label is
  `phase N` for a single-phase batch, `phase N-M` when spanning. Batch 1 gets a `[canary]` marker,
  space-separated after the batch label.
  **When `perBatchGateSeconds === 0` the worst-case line is omitted entirely** — otherwise every
  `--staged --dry-run` renders "Worst case 5 batches x 0s gate = up to 0s holding the state lock."
- `stagedExceedsLockStaleness(plan, perBatchGateSeconds)` →
  `plan.batches.length * perBatchGateSeconds * 1000 > STATE_LOCK_STALE_AFTER_MS`
  (`src/lib/state-lock.ts:24`, `10 * 60 * 1000`).
- `formatStagedEvent(event)` → `{ level: "warn" }` for `batch-failed`, `gate-degraded`,
  `rollout-halted`; `{ level: "info" }` otherwise.
- `formatStagedSummary(report)` → the `HALTED after batch N of M` block including `Investigate:`
  and `Resume:`. The resume list is `report.unhealthy` followed by every `STAGE_NOT_ATTEMPTED` name.
  The `Resume:` line deliberately omits `--force-recreate` (auto-enabled when sidecars expand,
  `src/actions/deploy.ts:355`) so a resume does not widen the blast radius.

#### T1-T4 — `src/lib/staged-rollout.spec.ts`

Pure module, real imports, **no `vi.mock` anywhere**. No `DependencyGraph`/`ExecutionPhase` fixture
factory exists in the repo (`parallel-executor.spec.ts` uses inline literals at `:116/:160/:189`;
`deploy.spec.ts` uses an inline `mockPhases`/`mockGraph` pair at `:977-985`), so define a
module-level builder:

```ts
function graph(phases: ExecutionPhase[], dependencyMap?: Record<string, string[]>): DependencyGraph {
  return {
    phases,
    hasCycles: false,
    ...(dependencyMap === undefined ? {} : { dependencyMap: new Map(Object.entries(dependencyMap)) }),
  };
}
```

Import types as `import type { DependencyGraph, ExecutionPhase } from "../types/parallel.js";`
(matching `parallel-executor.spec.ts:4`). `vi.clearAllMocks()` in `beforeEach` — never
`resetAllMocks`.

**T1 — `it.each` over phase shapes × batch sizes `1 | 2 | 3 | 99`:
`"never places a service in an earlier batch than its dependency"`.**
For every `[service, deps]` in the source map assert `batchIndexOf(dep) <= batchIndexOf(service)`,
and when equal assert `dep`'s phase number `<` `service`'s phase number within that batch's
`phases`. Also assert every `StagedBatch.phases[i].phase` equals the source phase number and
`dependsOn` is carried through unchanged.
_Required because:_ this is the one correctness invariant; getting it wrong starts a service before
its database in a mutating command, and it is invisible from action-level tests that stub the
planner. It also covers sidecar cohesion (`enforceSidecarPhaseAlignment`,
`src/lib/dependency-graph.ts:398`), since a split pair still starts in phase order.

**T2 — `it("orders core-profile services last within a phase")`.**
`profileMapping = { traefik: "core", "uptime-kuma": "infrastructure" }`, `batchSize: 1` →
`uptime-kuma` in batch 1, `traefik` last. Assert fan-in then name break the remaining ties.
_Required because:_ without it, `--staged --batch-size 1` on `infra-stack` canaries `cloudflared`
and recreates `traefik` mid-rollout — the exact regression that locks the operator out.

**T3 — `it.each(["halt", "continue"])("halts remaining batches without Docker calls; continue attempts every batch")`.**
Inject `runPhase` and `gate` as `vi.fn()`s.
For `"halt"`: later outcomes are `status: "skipped"`, `runPhase` is **never** called with a skipped
batch's services (assert over `runPhase.mock.calls`), `haltedAtBatch` is correct, and `report.failed`
contains **one `STAGE_NOT_ATTEMPTED` entry per service in every skipped batch** with `error` starting
`"Not attempted: staged rollout halted after batch "`.
For `"continue"`: every batch runs, and a service whose dependency failed in batch 1 is recorded
`STAGE_DEPENDENCY_SKIPPED`, exercising the carried `rolloutFailed` set that `executeParallelPhases`
resets on every call (`src/lib/parallel-executor.ts:76`).
_Required because:_ this is the feature, and the `STAGE_NOT_ATTEMPTED` assertion is what keeps
`resolveDeployExitCode` honest.

**T4 — `it("degraded telemetry never halts")`.**
Inject a `gate` returning
`{ ready: false, timedOut: true, degraded: true, elapsedMs: 1000, attempts: 2, services: [{ service: "a", status: "pending", reason: "telemetry-unavailable", assurance: "healthcheck", stableForMs: 0 }] }`.
Assert the outcome is `status: "passed"` with `gate.degraded === true`,
`report.status === "completed"`, no halt, and every subsequent batch still runs.
_Required because:_ it inverts the obvious "not ready means fail" logic and is therefore highly
regression-prone, while the cost of getting it wrong is a transient `docker inspect` failure
aborting a rollout half-deployed.

**Scoped acceptance:** `npx vitest run src/lib/staged-rollout.spec.ts`.

---

### S6 — MCP output schema

**Files owned (exclusive):** `packages/rfapps-cli/src/mcp/schema.ts`

**Depends on:** S1 — **build-order blocker**: this file cannot compile until `types/staged.ts`
exists AND `types/index.ts` re-exports `StagedRolloutSummary`.

Four edits, in file order:

1. **`:13-34`** — add `StagedRolloutSummary,` to the `import type { … } from "../types/index.js";`
   block (between `ServiceStatus,` and `StatusResult,`). **Absent from the design's original file
   table; a hard typecheck blocker.** Zero `schema*` helper imports are needed — `schemaArray`,
   `schemaBoolean`, `schemaEnum`, `schemaNumber`, `schemaObject`, `schemaOptional`, `schemaString`,
   `schemaUnion`, `type McpSchema` are all already imported at `:1-11`.
2. **Immediately before `:280`** (`const deployResultSchema = schemaObject({`), insert:

```ts
const stagedSummarySchema = schemaObject({
  status: schemaEnum(["completed", "halted", "degraded"] as const),
  batchSize: schemaNumber({ integer: true, minimum: 1 }),
  onFailure: schemaEnum(["halt", "continue"] as const),
  totalBatches: schemaNumber({ integer: true, minimum: 0 }),
  completedBatches: schemaNumber({ integer: true, minimum: 0 }),
  haltedAtBatch: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
});
```

The `as const` on both enums is required and matches the existing idiom at `:213-214`, `:241-242`,
`:250` — `schemaEnum<TValues>(values: TValues): McpSchema<TValues[number]>` needs it to produce the
literal unions the `_typeCheck` anchor demands.

3. **`:285` → `:286`** — add `staged: schemaOptional(stagedSummarySchema),` (indented two spaces,
   matching its siblings) as the last property
   of `deployResultSchema`, before the closing `});`.
4. **`:1017-1035`** — the `_typeCheck` block is a type-annotated const with a parallel value
   literal, so **two** lines are needed (each indented two spaces):
   `stagedSummary: McpSchema<StagedRolloutSummary>;` after
   `:1025`, and `stagedSummary: stagedSummarySchema,` after `:1034`. `void _typeCheck;` at `:1037`
   is unchanged.

Why this is mandatory insurance: `packages/rf-common/src/mcp/core.ts:82` runs
`return tool.outputSchema.parse(rawResult);` on every tool call; `rfappsMcpSchemas.deploy.output` is
`withDryRun(deployResultSchema)` (`:917-920`); `deployResultSchema` is built with `schemaObject` and
no `allowUnknownProperties`, so `additionalProperties: false`
(`packages/rf-common/src/mcp/schema.ts:397`) and the parser calls
`fail(path, "no additional properties", …)` (`packages/rf-common/src/mcp/schema.ts:423-436`). It
**throws**; it does not strip.

**NO CHANGE** to `deployInputSchema` (`:754-764`), `DeployToolArgs` (`:76-83`),
`rfappsMcpSchemas.deploy` (`:917-920`), `src/mcp/adapters.ts` `invokeDeploy` (`:277-299`), or
`packages/rf-common/**`. The input asymmetry is deliberate and unenforced by any test.

**No test is added here (D2).** See A15 item 1 for what this does **not** close.

**Scoped acceptance:** `npx vitest run src/mcp/schema.spec.ts` (must stay green, unmodified).

**Batch 2 close (B2):** `npm run typecheck -w packages/rfapps-cli` — zero errors.

---

## Batch 3 — Barrel (1 task)

### S7 — `lib/index.ts` staged exports

**Files owned (exclusive):** `packages/rfapps-cli/src/lib/index.ts`

**Depends on:** S4, S5.

**Hard build/test ordering constraint, not a footnote.** `src/actions/deploy.spec.ts:14` does a bare
`vi.mock("../lib/index.js")`. Anything `deploy.ts` imports **deep** from
`../lib/staged-rollout.js` would execute the real module — and its real Docker calls — inside the
existing deploy unit tests. Every staged symbol `deploy.ts` uses MUST be reachable through
`../lib/index.js`.

Insert beside the parallel-executor block at `:311-313`:

```ts
// Staged rollout coordinator
export {
  planStagedBatches,
  executeStagedRollout,
  summarizeStagedRollout,
  formatStagedPlan,
  formatStagedEvent,
  formatStagedSummary,
  stagedExceedsLockStaleness,
} from "./staged-rollout.js";
export type {
  ExecuteStagedRolloutOptions,
  ExecuteStagedRolloutDeps,
  StagedPhaseOperation,
  StagedRunPhaseResult,
  StagedEventRender,
} from "./staged-rollout.js";

// Staged batch health gate
export { waitForBatchReady, createBatchObserver, isCompletedOneShot } from "./staged-gate.js";
export type {
  StagedServiceObservation,
  StagedBatchObservation,
  StagedBatchObserver,
  WaitForBatchReadyOptions,
  WaitForBatchReadyDeps,
} from "./staged-gate.js";
```

Do **not** export `filterByDependencyFailures` or `canAccumulateStableRunning` — they are imported
deep and a barrel entry would only add automock noise to `deploy.spec.ts`.

**Scoped acceptance** (deliberately excludes the integration suite, which needs a `rf-common` build
the earlier batches never performed):

```bash
npm run typecheck -w packages/rfapps-cli
npx vitest run --dir src --exclude "src/cli.*.integration.spec.ts"
```

Everything green — nothing consumes the new exports yet.

---

## Batch 4 — Wiring (2 tasks, parallel; disjoint files)

### S8 — `actions/deploy.ts` + T6/T7

**Files owned (exclusive):** `packages/rfapps-cli/src/actions/deploy.ts`,
`packages/rfapps-cli/src/actions/deploy.spec.ts`

**Depends on:** S1, S7.

Both files are one task: the moment `deploy.ts` calls a new `lib/index.ts` export on the
**non-staged** path, the twelve tests in `describe("parallel mode")` (`:976-1235`) receive
`undefined` from the bare automock.

#### `deploy.ts` edits, in file order

**1. `:84-100` `RawDeployOptions`** — add after `validateFirst?: boolean;`:

```ts
  staged?: boolean;
  batchSize?: number | string;
  onFailure?: string;
```

**2. `:145-152` `deployResultForOutput`** — replace wholesale (the current guard only covers
`table`, and `--staged --output csv` is legal because the csv rejection at `src/cli.ts:174-185` is
`--validate-first`-specific):

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

**3. `:197-224` `DeployOptions` literal** — add after `workers:` (string-to-int precedent at
`:220-223`):

```ts
    staged: rawOptions.staged ?? false,
    batchSize:
      typeof rawOptions.batchSize === "string"
        ? Number.parseInt(rawOptions.batchSize, 10)
        : rawOptions.batchSize,
    onFailure: isStagedFailurePolicy(rawOptions.onFailure) ? rawOptions.onFailure : undefined,
```

`isStagedFailurePolicy` comes from `../types/index.js` (already imported for
`getEnvToolExecConfig` at `:42`).

**4. After `:234`** (the existing `--validate-first` + csv guard) — the usage guard.
`InvalidArgumentError`'s ctor is `(argument, value, reason, validValues?)` (`src/lib/errors.ts:400`)
and it is registered with `exitCode: ExitCode.UsageError` (`src/lib/error-formatters.ts:255`):

```ts
if (!options.staged && (rawOptions.batchSize !== undefined || rawOptions.onFailure !== undefined)) {
  throw new InvalidArgumentError(
    "--batch-size",
    String(rawOptions.batchSize ?? rawOptions.onFailure),
    "Staged rollout options require --staged",
  );
}
if (
  rawOptions.batchSize !== undefined &&
  (options.batchSize === undefined || !Number.isInteger(options.batchSize) || options.batchSize < 1)
) {
  throw new InvalidArgumentError("--batch-size", String(rawOptions.batchSize), "Batch size must be a positive integer");
}
```

**5. `:260` ONLY** (A13 — leave `:261-264` `workerCount` untouched). Replace
`const useParallel = options.parallel ?? finalConfig.parallel.enabled;` with:

```ts
const staged = options.staged ?? false;
const batchSize =
  options.batchSize !== undefined && Number.isFinite(options.batchSize) && options.batchSize > 0
    ? options.batchSize
    : 1;
const onFailure = options.onFailure ?? "halt";
const configParallel = options.parallel ?? finalConfig.parallel.enabled;
const useParallel = staged || configParallel;
if (staged && !configParallel) {
  logInfo("--staged uses dependency-phased execution");
}
if (staged && !waitForReady) {
  logWarn(
    "Staged health gating is disabled (--no-wait-for-ready or healthCheck.waitForReady: false); batches will not halt on unhealthy services",
  );
}
```

The second guard **must** key on the resolved `waitForReady` (`:257`), not on
`rawOptions.waitForReady === false`. Commander supplies `waitForReady: undefined` when neither flag
is passed, so a repo with `healthCheck.waitForReady: false` would otherwise get
`rfapps deploy -g media-stack --staged` with no gate, no halt, no warning and exit 0.

**6. `:370-419` dry-run block** — hoist the plan **explicitly** so both branches can narrow it:

```ts
const stagedDryRunPlan = staged
  ? planStagedBatches({
      graph,
      batchSize,
      onFailure,
      profileMapping: finalConfig.profiles.mapping,
    })
  : undefined;

if (stagedDryRunPlan !== undefined) {
  logInfo(formatStagedPlan(stagedDryRunPlan, { perBatchGateSeconds: 0 }));
} else {
  logInfo(formatExecutionPlan(graph.phases, workerCount));
}
```

and in the machine payload at `:403-417`, after `workers: workerCount,`:

```ts
        ...(stagedDryRunPlan === undefined
          ? {}
          : {
              staged: {
                batchSize,
                onFailure,
                batches: stagedDryRunPlan.batches.map((b) => ({
                  index: b.index,
                  services: b.services,
                })),
              },
            }),
```

Dry-run stays lock-free (`src/cli.ts:79-81`), Docker-mutation-free and DB-free, and reuses the
single `docker compose config` shell-out the branch already performs. `formatStagedPlan` omits the
worst-case line at `perBatchGateSeconds: 0`.

**7. `:505-572`** — replace the pull sweep, start sweep, failure merge, orphan pass and aggregation:

```ts
const stagedContext: StagedExecutionContext = {
  composePath: deployComposePath,
  projectDir: validationPass?.binding.projectDir ?? process.cwd(),
  profiles,
  exec: deployExecution,
};

const plan = planStagedBatches({
  graph,
  batchSize: staged ? batchSize : Math.max(1, services.length),
  onFailure: staged ? onFailure : "continue", // A3 — non-staged must never halt
  profileMapping: finalConfig.profiles.mapping,
});

const runPerBatchGate = staged && waitForReady;
const perBatchGateSeconds = runPerBatchGate
  ? Math.min(healthTimeout, finalConfig.healthCheck.retries * finalConfig.healthCheck.interval)
  : 0;

if (staged) {
  logInfo(formatStagedPlan(plan, { perBatchGateSeconds }));
  if (stagedExceedsLockStaleness(plan, perBatchGateSeconds)) {
    logWarn(
      "Worst-case staged rollout exceeds the 10-minute state-lock staleness threshold; another operator's force-unlock could see this live rollout as stale. Raise --batch-size or lower --health-timeout.",
    );
  }
} else if (options.skipPull) {
  logInfo("Skipping image pull (--skip-pull)"); // legacy line, A9
}

const report = await executeStagedRollout(
  {
    plan,
    dependencyMap: graph.dependencyMap,
    skipPull: options.skipPull === true,
    // A9: staged-only. The non-staged path keeps its legacy log lines instead.
    onEvent:
      staged && !isMachineFormat(format)
        ? (event) => {
            const render = formatStagedEvent(event);
            if (render.level === "warn") logWarn(render.message);
            else logInfo(render.message);
          }
        : undefined,
  },
  {
    runPhase: async ({ operation, phases }) => {
      if (!staged) {
        if (operation === "pull") logInfo("Pulling images in parallel...");
        else logInfo(`Starting Docker services in parallel...${forceRecreate ? " (force-recreate)" : ""}`);
      }
      const phaseResult = await executeParallelPhases({
        phases,
        composePath: deployComposePath,
        operation,
        workers: workerCount,
        dependencyMap: graph.dependencyMap,
        ...(operation === "start" ? { noPull: !options.skipPull, forceRecreate } : {}),
        profiles,
        ...deployExecution,
      });
      if (!staged) {
        if (phaseResult.failed.length > 0) {
          const names = phaseResult.failed.map((f) => f.name).join(", ");
          logWarn(
            operation === "pull" ? `Some images failed to pull: ${names}` : `Some services failed to start: ${names}`,
          );
        }
        if (phaseResult.succeeded.length > 0) {
          logSuccess(
            operation === "pull"
              ? `Successfully pulled images for ${phaseResult.succeeded.length} services`
              : `Successfully started ${phaseResult.succeeded.length} services`,
          );
        }
      }
      return { succeeded: phaseResult.succeeded, failed: phaseResult.failed };
    },
    gate: runPerBatchGate
      ? ({ started, onProgress }) =>
          waitForBatchReady(
            {
              services: started,
              waitForReady,
              onProgress,
              poll: {
                timeoutSeconds: healthTimeout,
                intervalSeconds: finalConfig.healthCheck.interval,
                retries: finalConfig.healthCheck.retries,
              },
            },
            { observe: createBatchObserver(stagedContext) },
          )
      : undefined,
  },
);

const halted = report.status === "halted";
// Preserve the caller's service order so non-staged argv is byte-identical.
const attempted = services.filter((service) => report.attempted.includes(service));

// Cleanup pass: scoped to services a start was ISSUED for, and skipped entirely
// on a halt. startServices unconditionally emits `up -d --remove-orphans`
// (lib/docker.ts:736), so an unscoped pass would start exactly the services the
// halt was meant to protect.
if (!halted && attempted.length > 0) {
  logDebug("Running orphan cleanup pass...");
  await startServices(deployComposePath, attempted, {
    streamOutput: false,
    profiles,
    ...deployExecution,
  });
} else if (halted) {
  logDebug("Orphan cleanup skipped: staged rollout halted");
}

result.services = services;
result.started = report.started;
result.healthy = [...report.healthy];
result.unhealthy.push(...report.unhealthy);
for (const failure of report.failed) {
  if (!result.failed.some((f) => f.name === failure.name)) {
    result.failed.push(failure);
  }
}
if (staged) {
  result.staged = summarizeStagedRollout(report);
}
if (staged && report.status !== "completed" && format === "text") {
  for (const line of formatStagedSummary(report)) logInfo(line);
}
```

Non-staged behaviour: one batch (`batchSize = services.length`), `onFailure: "continue"` so `halted`
is always `false`, `attempted === services` on success, the six legacy log lines preserved, and the
phase slice reproduces `graph.phases` exactly.

**8. `:577-587` — loop body ONLY (A12).** `:575` guard and `:576` `setDeployExitCode` preserved
verbatim:

```ts
for (const failure of result.failed) {
  if (failure.code === "STAGE_NOT_ATTEMPTED") continue;
  const error = new DockerCommandError(
    "parallel-deploy",
    `Service '${failure.name}' failed: ${failure.error}`,
    1,
    [failure.name],
    false,
  );
  outputFormattedError(formatError(error));
}
```

**9. `:590-660`** — the tail dependency gate. Change `const healthyServices = startResult.succeeded;`
to `const healthyServices = report.healthy;` and the guard to
`if (!halted && healthyServices.length > 0) {`. Everything inside is unchanged, including
`projectDir: validationPass?.binding.projectDir ?? process.cwd()` (`:603`), the `poll` block
(`:607-611`), and the "signals unavailable, warn and continue" escape (`:654-656`). The final
`result.healthy = healthyServices.filter((s) => !result.unhealthy.includes(s));` stays. On a halt
the tail gate is skipped so a halted rollout does not pay a second full `healthTimeout` while
holding the state lock.

**10. `:667-672`** — `inspectContainersWithRetry(staged ? attempted : services, 3, 1000, deployExecution)`
(A6). The `services.map(...)` loop at `:674-694` is unchanged and stays over the **full** `services`
set, so `STAGE_NOT_ATTEMPTED` entries automatically become `status: "failed"` rows with
`errorMessage: "Not attempted: staged rollout halted after batch N of M"` — truthful history with no
schema migration. `GENERATION_ACTIONS` requires `status === "success"`, so skipped services produce
no generation row. DB write failures remain non-fatal (`logWarn` only, `:698-702`).

**11. Imports** — add `planStagedBatches, executeStagedRollout, summarizeStagedRollout,
formatStagedPlan, formatStagedEvent, formatStagedSummary, stagedExceedsLockStaleness,
waitForBatchReady, createBatchObserver` to the existing `from "../lib/index.js"` block, and
`StagedExecutionContext` (type) + `isStagedFailurePolicy` (value) to the `../types/index.js`
imports. **Never** import from `../lib/staged-rollout.js` or `../lib/staged-gate.js` directly.

**Not modified:** `src/lib/exit-codes.ts`, the confirm prompt (`:423-431`),
`preparedValidationGraph` (`:433-456`), `revalidateDeployBinding` (`:458-472`, still exactly once
immediately before the first mutation), the dependency-cycle check (`:484-501`), the single
structured emission (`:1024-1027`), and the sequential path (`:739-1022`).

#### `deploy.spec.ts` edits

**A. `describe("parallel mode")` `beforeEach` at `:996-1018` — a DRIVING default, not a flat one.**

`vi.mock("../lib/index.js")` at `:14` has **no factory**; every export is a `vi.fn()` returning
`undefined`. A `mockResolvedValue` on `executeStagedRollout` means the mocked coordinator never
invokes the injected `runPhase`, so `lib.executeParallelPhases` is never called and **eight**
existing tests fail: `:1024` (`toHaveBeenCalled`), `:1033` (`{workers: 8}`), `:1049`
(`{workers: 6}`), `:1063-1075` (`callOrder` + `phases: mockGraph.phases`), `:1078-1102`,
`:1104-1130`, `:1132-1165` (all three drive failures via `executeParallelPhases.mockResolvedValueOnce`),
and `:1211-1227` (`forceRecreate` propagation, which does
`mock.calls.find((c) => c[0].operation === "start")`).

```ts
vi.mocked(lib.planStagedBatches).mockReturnValue({
  batches: [{ index: 1, services: ["svc-a", "svc-b", "svc-c"], phases: mockPhases }],
  batchSize: 3,
  onFailure: "continue",
  totalServices: 3,
});
// Drives deps.runPhase so every executeParallelPhases assertion above still holds.
vi.mocked(lib.executeStagedRollout).mockImplementation(async (options, deps) => {
  const batch = options.plan.batches[0]!;
  const failed = [];
  if (!options.skipPull) {
    const pull = await deps.runPhase({ operation: "pull", batch, phases: batch.phases });
    failed.push(...pull.failed);
  }
  const start = await deps.runPhase({ operation: "start", batch, phases: batch.phases });
  for (const f of start.failed) if (!failed.some((e) => e.name === f.name)) failed.push(f);
  const attempted = [...start.succeeded, ...start.failed.map((f) => f.name)];
  return {
    status: failed.length > 0 ? "degraded" : "completed",
    batchSize: batch.services.length,
    onFailure: "continue",
    totalBatches: 1,
    completedBatches: failed.length > 0 ? 0 : 1,
    batches: [],
    attempted,
    started: start.succeeded.length,
    healthy: [...start.succeeded],
    unhealthy: [],
    failed,
  };
});
vi.mocked(lib.formatStagedPlan).mockReturnValue("Staged rollout: 1 batch");
vi.mocked(lib.formatStagedEvent).mockReturnValue({ level: "info", message: "" });
vi.mocked(lib.formatStagedSummary).mockReturnValue([]);
vi.mocked(lib.summarizeStagedRollout).mockReturnValue({
  status: "completed",
  batchSize: 3,
  onFailure: "halt",
  totalBatches: 1,
  completedBatches: 1,
});
vi.mocked(lib.stagedExceedsLockStaleness).mockReturnValue(false);
```

`planStagedBatches`'s batch must carry `phases: mockPhases` so `objectContaining({ phases: mockGraph.phases })`
at `:1064`/`:1070` still matches.

The top-level `mockConfig` sets `parallel: { enabled: false, workers: 4 }` (`:142-145`), so all
top-level tests take the sequential path (`deploy.ts:739-1022`) and are untouched. Existing
`formatOutput` call-count assertions at `:511, 597, 603, 622, 740` must stay green — the
coordinator never calls `formatOutput` and the single envelope (`deploy.ts:313-319`) is still
emitted once at `:1024-1027`.

**B. New `describe("staged mode")`** — replicate the parallel-mode fixture mocks
(`computeExecutionPhases`, `executeParallelPhases`, `inspectContainersWithRetry`,
`formatExecutionPlan`) plus the staged defaults, then override `executeStagedRollout` per test.
`startServices` is already mocked at the top level (`:187-192`). Use the existing `originalExitCode`
save/restore at `:148-153`/`:259-261`; do not add your own. `mockGraph` (`:981-984`) carries no
`dependencyMap` — the "missing dependency map" degrade path — so reuse that shape.

**T6 — `it.each([[false, ExitCode.OperationalError], [true, ExitCode.PartialSuccess]])("a halted rollout records never-attempted services and maps to the right exit code")`
plus a zero-healthy case.**
Mock `executeStagedRollout` to resolve a halted report: `status: "halted"`, `haltedAtBatch: 1`,
`attempted: ["svc-a"]`, `started: 1`, `healthy: []`, `unhealthy: ["svc-a"]`,
`failed: [{ name: "svc-b", code: "STAGE_NOT_ATTEMPTED", error: "Not attempted: staged rollout halted after batch 1 of 2" }, { name: "svc-c", code: "STAGE_NOT_ATTEMPTED", error: "…" }]`.
Assert `result.failed` (via the `formatOutput` payload) carries both `STAGE_NOT_ATTEMPTED` entries
and that `process.exitCode` matches. Third case: halted on the canary with `healthy: []` → exit 1
**even with** `--allow-partial`, because `hasDeploySuccess` keys off `result.healthy.length > 0`
(`src/lib/exit-codes.ts:121-123`).
_Required because:_ this is the most dangerous silent failure. If skipped services do not reach
`result.failed`, `resolveDeployExitCode` sees `!hasFailure` and the CLI **exits 0 despite halting**
— and CI, deploy scripts and MCP all trust that code.

**T7 — `it("scopes orphan cleanup to attempted services and skips it entirely on halt")`.**
Two arrangements against mocked report shapes: (a) `status: "halted"` →
`expect(lib.startServices).not.toHaveBeenCalled()`; (b) `status: "completed"` with
`attempted: ["svc-a", "svc-b"]` out of three requested services →
`expect(lib.startServices).toHaveBeenCalledWith(expect.any(String), ["svc-a", "svc-b"], expect.objectContaining({ streamOutput: false }))`.
_Required because:_ `startServices` is `up -d --remove-orphans <list>` (`src/lib/docker.ts:711` /
exact push at `:736`); an unscoped pass would start every service the rollout just refused to
deploy, silently defeating the feature with no error.

**Scoped acceptance:** `npx vitest run src/actions/deploy.spec.ts` — every pre-existing test still
passes, including all five `formatOutput` call-count assertions and all eight
`executeParallelPhases` assertions.

---

### S9 — CLI flags + shell completion (must land as one change)

**Files owned (exclusive):** `packages/rfapps-cli/src/cli.ts`,
`packages/rfapps-cli/src/actions/completion.ts`, `packages/rfapps-cli/src/actions/completion.spec.ts`

**Depends on:** nothing (Commander's `.action(async (options) => …)` callback is untyped, so there
is no compile coupling to S8).

**Why one task:** the parity assertion at `completion.spec.ts:319-322` (`.toEqual(deployOptions)`,
driven by `getCommanderCommandOptions` spawning the real CLI at `:151`) fails hard the instant
`cli.ts` carries the flags without `completion.ts`, and it **aborts on the first shell (bash)** —
zsh and fish edits cannot be validated incrementally. Verified failure mode:
`AssertionError: bash: expected [ … 16 items ] to deeply equal [ Array(19) ]`, missing `batch-size`,
`on-failure`, `staged`.

#### `src/cli.ts`

**1. Options — insert between `:363` (`--workers`) and `:364` (`--wait-for-ready`).** `Option` is
already imported at `:28`.

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

`--staged` omits an explicit `false` default, matching `--parallel` at `:362`. `--batch-size` is
string-to-int, matching `--workers` at `:363`. `--on-failure` uses `.choices()` for fail-fast with
no `.default()`, so an unset value stays distinguishable.

**Description constraint:** `getLongOptionNames` regex-extracts `--([a-z][a-z-]*)`
(`completion.spec.ts:144-146`) from help lines matching `/^\s+-/` (filter at `:159`, inside
`getCommanderCommandOptions` `:148-164`). None of the three descriptions contains a `--flag` token,
so no phantom expected option is manufactured. Verified: the expected set becomes exactly 19.

**2. `addHelpText` at `:373-381`** — append to the existing template literal. No line begins with a
dash and no `--` token appears:

```text

Staged rollout:
  Batches are gated on the health of the services they just deployed. A failed
  batch halts the rollout by default; services in later batches are reported as
  not attempted and keep running their previous containers. Staged mode always
  uses dependency-phased execution, even when parallel execution is disabled in
  config.
```

The last sentence is required by design §10's "`--staged` silently forces phased execution" risk
row, which asks for the `logInfo`, the flag help text and the README all to say it.

**3. `preAction` guard — new sibling block after `:185`**, matching the `--validate-first` + csv
precedent at `:174-185`:

```ts
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
`--staged --output csv` stays **legal** — the csv guard at `:174-185` is `--validate-first`-specific.
`"deploy"` is already in `ALWAYS_MUTATING_COMMANDS` (`:63-73`); the state lock is acquired once in
`preAction` (`:260-263`) and released once in `main()`'s `finally` (`:637-653`). No per-batch lock
churn.

#### `src/actions/completion.ts` — four edits (all empirically verified: 11/11 tests pass)

**1. `:53`** — append a space then `--staged --batch-size --on-failure` inside the closing quote of
`deploy_opts`. Position within the string is irrelevant; the extractor sorts and de-dupes.

**2. After `:233`** — two new bash `case "$prev"` arms. Model them on `--health-timeout)` at
`:218-221` and `--mode)` at `:206-209`, **not** on `--steps)` at `:230-233`, which belongs to
`rollback`. Source indentation is 4 spaces for `--flag)`, 6 for the body and `;;`. The `\$` escapes
are literal source text inside a TS template literal:

```text
    --batch-size)
      COMPREPLY=(\$(compgen -W "1 2 3 5 10" -- "\$cur"))
      return
      ;;
    --on-failure)
      COMPREPLY=(\$(compgen -W "halt continue" -- "\$cur"))
      return
      ;;
```

**3. After `:564`** (`'--workers[Maximum concurrent workers for parallel execution]:count:' \\`) —
three zsh lines at **twelve** spaces, each ending with a space followed by `\\`:

```text
            '--staged[Roll out in dependency-ordered batches]' \\
            '--batch-size[Services per staged batch]:count:(1 2 3 5 10)' \\
            '--on-failure[Staged batch failure policy]:policy:(halt continue)' \\
```

**Indentation is load-bearing.** The extractor at `completion.spec.ts:177-179` builds
``new RegExp(`\\n        ${command}\\)\\n([\\s\\S]*?)\\n          ;;`)``, so `:552` must stay exactly
**eight** spaces + `deploy)` and `:571` exactly **ten** spaces + `;;`. Verified byte-exact with
`cat -A`; inserting three 12-space lines preserves the framing.

**4. Between `:1045` and `:1046`** (after the `-l health-timeout` line, before `-s f -l compose`) —
three fish lines, **no** `; and not __fish_seen_subcommand_from …` guard (the whole deploy fish
block uses a bare `__fish_seen_subcommand_from deploy`; only `rebuild` at `:1051-1063` needs a
guard, because `state rebuild` exists):

```text
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l staged -d "Roll out in dependency-ordered batches"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l batch-size -d "Services per staged batch" -xa "1 2 3 5 10"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l on-failure -d "Staged batch failure policy" -xa "halt continue"
```

One flag per line is **mandatory** — the fish extractor at `completion.spec.ts:190` takes only the
first `-l` match per line.

#### `src/actions/completion.spec.ts` — optional hardening, both verified green

Neither array is load-bearing (verified: with `cli.ts` + all four `completion.ts` edits applied and
the spec untouched, all 11 tests pass). `deployOnlyOptions` is a negative `.not.toContain` list and
`required` is a raw substring smoke check; neither can fail from an omission.

- **`:315`** — `deployOnlyOptions` += `"batch-size"`, `"on-failure"`, `"staged"`.
- **`:408-419`** — `required` += `"staged"`, `"batch-size"`. **Do NOT add `"on-failure"`**: that
  assertion is `expect(script, …).toContain(token)` over the whole generated script, which already
  contains `no-restore-on-failure` at `completion.ts:74`, `:648` and `:1126` — a permanently-green
  no-op.

**No shell-completion test is added.** `completion.spec.ts:312` already compares the live
`rfapps deploy --help` surface against all three generated scripts and fails once per shell for any
un-mirrored flag.

**Scoped acceptance:** `npx vitest run src/actions/completion.spec.ts` — all 11 tests, including zsh
and fish (proving the framing and the guard-free fish lines).

**Batch 4 close (B4):** `npm run typecheck -w packages/rfapps-cli` — zero errors.

---

## Batch 5 — Integration test and docs (2 tasks, parallel)

### S10 — T8 integration test

**Files owned (exclusive):** `packages/rfapps-cli/src/cli.deploy.integration.spec.ts`

**Depends on:** S8, S9.

**`it("D8: --staged --batch-size 1 halts before the second batch and records the untouched service", async () => { … }, 30_000)`**

Explicit `30_000` third argument (the `runCli` harness budget defaults to `12_000` at
`src/testing/cli-harness.ts:210`, deliberately below vitest's `testTimeout: 15000` at
`packages/rfapps-cli/vitest.config.ts:7`; precedent for the explicit override is D2a `:217` and V1
`:283`).

_Required because:_ it is the only place that proves, against the argv the CLI actually emits, that
a halt prevents Docker work on the remaining services — and the only test that would catch a dropped
`...deployExecution` spread or a broken flag-to-default resolution.

#### Four fixture constraints

1. **`--wait-for-ready` MUST be on the argv (BLOCKER).** `DEFAULT_FIXTURE_CONFIG_YAML` pins
   `healthCheck.waitForReady: false` (`src/testing/cli-harness.ts:80`), and Commander supplies
   `waitForReady: undefined` when neither flag is passed (verified against commander@14), so
   `deploy.ts:257` resolves `false`, `runPerBatchGate` is `false`, the gate never runs, nothing
   halts and the run exits 0. You **cannot** fix this by appending a second `healthCheck:` block —
   the `yaml` package rejects duplicate top-level keys, so string concatenation onto
   `DEFAULT_FIXTURE_CONFIG_YAML` only works for keys the default omits (`envTool`, `parallel`).
2. **The `envTool: none` pin is NOT mandatory.** `deploy.ts:195` calls
   `getEnvToolExecConfig(globalOptions)` with **one** argument, and `src/types/options.ts:195-197`
   returns `undefined` when `config === undefined`; only the six two-arg call sites can resolve
   `dotenvx` from config. All 10 existing tests in this file use the unpinned default and pass in
   CI, which installs no dotenvx. Keep the pin as cheap insurance if you like.
3. **`ps-a-json` must be hand-overridden.** `deployReadinessRules` hard-codes it to
   `[{Service:"web",State:"running"},{Service:"db",State:"running"}]`
   (`src/testing/deploy-scenarios.ts:311-320`) with no state override.
4. **`dbInspectServices` must equal the ATTEMPTED list exactly.** On a halt, `attempted` is
   `["db"]`, so pass `[{ name: "db", image: "postgres:16" }]` only. Its doc comment
   (`deploy-scenarios.ts:285-295`) is the constraint: canned entries must exactly equal the
   deployed-service list or `inspectContainersWithRetry`'s `size === services.length` early return
   misses and the full ~3 s retry loop burns.

#### Batch membership arithmetic

The default fixture compose is `web: nginx:1.27` / `db: postgres:16` with **no** `depends_on`, and
`profiles.mapping` is `web: all, db: all` — neither is `core`. Both are tier 0, fan-in 0, so the
flat order is alphabetical: **batch 1 = `db`, batch 2 = `web`.**

Arrange `ps-a-json` to report `{ Service: "db", State: "exited" }` and
`{ Service: "web", State: "running" }`. `ps-service-map` returns only `web → fixture-web-1`
(`deploy-scenarios.ts:328`), so `db` has no container, the observer skips `inspectContainers`, and
`db.exitCode` is `undefined`. Classification order guarantees the halt: `state === "exited"` hits
`src/lib/health.ts:176-178` (`failed`/`exited`) **before** the `imageId === undefined` check at
`:182-184`, and `isCompletedOneShot` returns `false` because `exitCode !== 0`. Per A7 the gate
returns immediately on attempt 1.

#### Fixture construction — name the helpers explicitly

Build the rule array from the same helpers the existing D1-D7 cases use, then replace exactly one
rule:

```ts
const rules = deployReadinessRules({
  runningNames: ["fixture-web-1"],
  dbInspectServices: [{ name: "db", image: "postgres:16" }],
}).map((rule) =>
  rule.id === "ps-a-json"
    ? {
        ...rule,
        response: {
          stdout: composePsStatusJson([
            { Service: "db", State: "exited" },
            { Service: "web", State: "running" },
          ]),
          exitCode: 0,
        },
      }
    : rule,
);
```

Reuse the same `pull` / `up` rule constants the neighbouring cases already declare in this file; do
not invent new rule ids, because `expectInvocationOrder` matches on `matchedRuleId`.

#### Argv and assertions

```ts
const result = await runCli(
  ["deploy", "--services", "web,db", "--staged", "--batch-size", "1", "--wait-for-ready", "--yes"],
  { project, scenario: { rules } },
);
```

- `expect(result.exitCode).toBe(1);`
- `expectInvocationOrder(result.invocations, ["pull", "up"]);` — this helper matches on
  `matchedRuleId`, **not** argv (`src/testing/cli-harness.ts:295-312`).
- Per-service argv separately, as D1 does at `:128-137`:
  `const upLines = argvLines(result.invocations).filter((l) => l.includes(" up -d "));` →
  `toHaveLength(1)` and `upLines[0].endsWith(" db")`.
- `expectNoInvocationMatching(result.invocations, { contains: ["up", "-d", "web"] });` — `contains`
  is unordered set membership (`src/testing/mock-docker.ts:195`), and `"web"` appears in argv only
  as a positional service name (the tmp `composePath` has no `web` token), so the matcher is safe.
- `expectNoInvocationMatching(result.invocations, { contains: ["--remove-orphans"] });` — the
  parallel `start` operation deliberately strips `--remove-orphans`
  (`src/lib/parallel-executor.ts:236-240`), so the orphan pass is the only possible source and
  skipping it on halt is observable.
- `const dbInspects = result.invocations.filter((i) => i.matchedRuleId === "inspect-db"); expect(dbInspects).toHaveLength(1);`
- State DB: the `deployments` table has a `failed` row for `web` whose `error_message` starts with
  `"Not attempted:"`, and the `generations` table gains no row for `web`.

**Do not touch** the existing D1 (`:141-142`) and D7 (`:588-589`) `dbInspects` assertions — they
stay green under the `attempted` narrowing because nothing is skipped in those scenarios.

**Scoped acceptance:**

```bash
npm run build -w packages/rf-common      # precondition: the tsx child resolves @rfmedia/common from dist/
npx vitest run src/cli.deploy.integration.spec.ts --root packages/rfapps-cli
```

All 11 tests (10 existing + D8) green.

---

### S11 — Documentation

**Files owned (exclusive):** `packages/rfapps-cli/README.md`, `docs/features/shell-completion.md`,
`docs/features/quick-reference.md`, `docs/features/dry-run-mode.md`, `docs/features/json-output.md`,
`docs/features/output-formats.md`, `docs/features/service-conflict-detection.md`, `ROADMAP.md`

**Depends on:** S9 (final flag text).

**Locate every section by its heading, not by the design's §9 line numbers** — those anchors were
not re-verified and README line numbers drift.

| File                                                              | Section                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/README.md`                                   | `### deploy` option table                         | Add `--staged`, `--batch-size <count>`, `--on-failure <policy>` with the exact descriptions from S9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/rfapps-cli/README.md`                                   | after `#### Pre-Deploy Conflict Validation`       | New `#### Staged Rollout`: batching and criticality ordering (core-profile last), the per-batch gate, the running-only assurance caveat for the **11 healthcheck-less services** (verified: 49 services, 38 `healthcheck:` blocks in `compose.yml`), the one-shot exemption, per-batch health budget and state-lock hold time with `--batch-size` / `--health-timeout` guidance, `--on-failure continue` and `--no-wait-for-ready` as escape hatches, the resume workflow (with the unprotected lock window between halt and resume), and that `--staged` always forces dependency-phased execution |
| `packages/rfapps-cli/README.md`                                   | `### Exit Codes`                                  | A halted rollout maps onto 1 (or 3 with `--allow-partial`); never-attempted services count as failures; a canary halt with zero healthy is 1 even with `--allow-partial`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `docs/features/shell-completion.md`                               | shown-flags block; `### Deploy Completion Parity` | Add the three flags; update the fenced block and the deploy-only sentence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/features/quick-reference.md`                                | parallel-ops block                                | Add `rfapps deploy -g infra-stack --staged --batch-size 3 --yes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `docs/features/dry-run-mode.md`                                   | deploy section                                    | Document the staged dry-run batch-plan projection and the `staged: { batchSize, onFailure, batches }` machine payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docs/features/json-output.md`, `docs/features/output-formats.md` | deploy shape                                      | Document the optional `staged` object (`status`, `batchSize`, `onFailure`, `totalBatches`, `completedBatches`, `haltedAtBatch?`) and that it is stripped for **both** `table` and `csv`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `docs/features/service-conflict-detection.md`                     | limitations                                       | `--staged --validate-first` widens the point-in-time window (`src/lib/deploy-validation.ts:370-376`) by the rollout's duration; `revalidateDeployBinding` still runs exactly once                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ROADMAP.md`                                                      | #159 entries                                      | Update; move the sprint to `docs/roadmap-archive.md` on ship                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`docs/features/rfapps-mcp-server.md` needs **no** argument-table change — the input flags are
deliberately not mirrored.

Also record the accepted limitations: `rfapps history` cannot say which batch a service belonged to
(the `error_message` preserves it in text form; a `run_id` column needs a `schema_version` bump past
3 — file as future work), and machine output carries `result.staged.status` but no per-batch
`cause` (the cause is embedded in each `failed[].error` string).

**Scoped acceptance:** `npm run lint:md` — clean. **Do not run any prettier command here**; a
repo-wide `--write` would rewrite `src/cli.deploy.integration.spec.ts`, which S10 owns and is
editing in the same batch (A11). Formatting is S12's job.

---

## Batch 6 — Verification (1 task)

### S12 — Full verification and formatting

**Files owned:** none for authoring; **sole owner of every repo-wide formatting command**.

**Depends on:** S1-S11.

Run from the worktree root in this order:

```bash
npm run build -w packages/rf-common
npm run typecheck -w packages/rfapps-cli
npm run test:run -w packages/rfapps-cli
npm run format:all
npm run lint:md
git diff --stat
```

`npm run build -w packages/rf-common` is a hard precondition, not hygiene: `@rfmedia/common`'s
package exports point at `dist/*.js`, so the tsx integration child cannot resolve it otherwise
(`src/testing/cli-harness.ts:102-105`). `npm run format:all` — **not** `npm run format`, which is
bare `prettier --write` with no path and writes nothing (A11).

**Pass criteria:**

1. `typecheck` — zero errors.
2. `test:run` — zero failures. Spot-confirm these pre-existing assertions are still green:
   `deploy.spec.ts:511, 597, 603, 622, 740` (`formatOutput` call counts); `deploy.spec.ts:1024,
1033, 1049, 1063-1075, 1078-1102, 1104-1130, 1132-1165, 1211-1227` (the eight
   `executeParallelPhases` assertions); `cli.deploy.integration.spec.ts:141-142` and `:588-589`
   (`dbInspects` toHaveLength(1)); `health.spec.ts:742` (bounded stable-running window); all 11
   `completion.spec.ts` tests.
3. Eight new tests present and passing: T1-T4 in `src/lib/staged-rollout.spec.ts`, T5 in
   `src/lib/staged-gate.spec.ts`, T6-T7 in `src/actions/deploy.spec.ts`, T8 in
   `src/cli.deploy.integration.spec.ts`. **No ninth test** (D5).
4. `git diff --stat` shows **no** `src/lib/timing.ts`, **no** change to `src/lib/action-helpers.ts`,
   **no** change to `src/mcp/schema.spec.ts`, and **no** change to `src/types/config.ts`,
   `src/lib/config.ts` or `rfapps.config.yaml` (so the 22 spec fixtures building `parallel: { … }`
   literals and the 13 annotating `: RfappsConfig` need no edits).
5. `npm run format:all` produces no further diff on a second run; `npm run lint:md` is clean.

There is no `check:architecture` / `test:contracts` gate in `rfapps-cli` — those live only in
`rfmedia-cli`. CI for this package (`.github/workflows/rfapps-cli.yml`) runs exactly `npm ci`,
`npm run build -w packages/rf-common`, `npm run typecheck --workspace packages/rfapps-cli`,
`npm run test:coverage --workspace packages/rfapps-cli`.

Manual smoke (optional, dry-run only, no Docker mutation):

```bash
npm run rfapps -- deploy -g infra-stack --staged --batch-size 3 --dry-run
```

Expect exactly the five-batch plan from S5.

---

## The eight tests

| #   | Exact `it` name                                                                               | File                                                     |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| T1  | `never places a service in an earlier batch than its dependency`                              | `packages/rfapps-cli/src/lib/staged-rollout.spec.ts`     |
| T2  | `orders core-profile services last within a phase`                                            | `packages/rfapps-cli/src/lib/staged-rollout.spec.ts`     |
| T3  | `halts remaining batches without Docker calls; continue attempts every batch`                 | `packages/rfapps-cli/src/lib/staged-rollout.spec.ts`     |
| T4  | `degraded telemetry never halts`                                                              | `packages/rfapps-cli/src/lib/staged-rollout.spec.ts`     |
| T5  | `gates on the batch's own services with a bounded soak, and exempts completed one-shots`      | `packages/rfapps-cli/src/lib/staged-gate.spec.ts`        |
| T6  | `a halted rollout records never-attempted services and maps to the right exit code`           | `packages/rfapps-cli/src/actions/deploy.spec.ts`         |
| T7  | `scopes orphan cleanup to attempted services and skips it entirely on halt`                   | `packages/rfapps-cli/src/actions/deploy.spec.ts`         |
| T8  | `D8: --staged --batch-size 1 halts before the second batch and records the untouched service` | `packages/rfapps-cli/src/cli.deploy.integration.spec.ts` |

T1 and T3 are `it.each`; T6 is `it.each` plus a third standalone zero-healthy case.

---

## Dependency graph

```text
Batch 1:  S1 (types)          S2 (health)        S3 (parallel-executor)
             |    \              |                  |
          ---+-----+-------------+------------------+---  B1 close: typecheck
             |      \
Batch 2:  S6 (mcp)   S4 (staged-gate + T5)     S5 (staged-rollout + T1-T4)
             |        \                        /
          ---+---------+----------------------+-----------  B2 close: typecheck
                        \                    /
Batch 3:                   S7 (lib/index.ts barrel)
                                    |
Batch 4:          S8 (deploy.ts + deploy.spec.ts, T6-T7)     S9 (cli.ts + completion)
                            \                                  /
                          ---+----------------------------------+--  B4 close: typecheck
                             \                                /
Batch 5:              S10 (integration T8)          S11 (docs)
                                    \                  /
Batch 6:                        S12 (verification + all formatting)
```
