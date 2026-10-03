/**
 * Types for staged (batched) rollout of a parallel deploy.
 *
 * A staged rollout splits the dependency-phased execution plan into blast-radius
 * ordered batches, starts one batch at a time, and gates each batch on container
 * readiness before the next batch starts. The same contracts describe the
 * non-staged parallel path, which runs as a single batch with no gate.
 *
 * `src/types/*` never imports from `src/lib/*`, so the Docker Compose execution
 * options consumed by the staged modules are declared structurally here rather
 * than imported from `lib/docker.ts`.
 */

import type { TargetVerificationResult } from "./health.js";
import type { EnvToolExecConfig } from "./options.js";
import type { ExecutionPhase } from "./parallel.js";
import type { FailedOperation } from "./results.js";

/** What a staged rollout does when a batch fails its start or its gate. */
export type StagedFailurePolicy = "halt" | "continue";

/**
 * Runtime guard for {@link StagedFailurePolicy}, used to validate CLI and MCP input.
 *
 * @param value - Unvalidated candidate value
 * @returns True when the value is a legal failure policy
 */
export function isStagedFailurePolicy(value: unknown): value is StagedFailurePolicy {
  return value === "halt" || value === "continue";
}

/**
 * Docker Compose execution options forwarded by staged modules.
 *
 * Structural mirror of the exec-option subset of `DockerComposeExecOptions`
 * (`src/lib/docker.ts`); declared here to keep `src/types/*` free of lib imports.
 */
export interface StagedExecOptions {
  /** Working directory for the Compose invocation */
  cwd?: string;
  /** Extra environment variables for the Compose invocation */
  env?: Record<string, string>;
  /** Replace the inherited environment instead of extending it */
  replaceEnv?: boolean;
  /** Path to the environment file passed to Compose */
  envFile?: string;
  /** Compose project name */
  projectName?: string;
  /** Secrets injection tool wrapping the Compose invocation */
  envTool?: EnvToolExecConfig;
}

/**
 * Everything the staged modules need to talk to Docker Compose.
 *
 * `projectDir` and `profiles` are REQUIRED on purpose -- spreading the deploy
 * action's exec options alone would silently drop `cwd` and omit `profiles`,
 * scoping every observation to the wrong project.
 */
export interface StagedExecutionContext {
  /** Path to the compose file */
  composePath: string;
  /** Project directory used to resolve relative compose paths */
  projectDir: string;
  /** Compose profiles that must be active for the batch services */
  profiles: string[];
  /** Compose execution options */
  exec: StagedExecOptions;
}

/** One rollout batch: the services started and gated together. */
export interface StagedBatch {
  /** 1-based index across the whole rollout */
  index: number;
  /** Members in blast-radius order (least critical first) */
  services: string[];
  /** Phase-preserving slice for executeParallelPhases; original phase numbers + dependsOn */
  phases: ExecutionPhase[];
}

/** Immutable plan describing how a rollout will be batched. */
export interface StagedPlan {
  /** Batches in execution order */
  batches: StagedBatch[];
  /** Maximum number of services per batch */
  batchSize: number;
  /** Policy applied when a batch fails */
  onFailure: StagedFailurePolicy;
  /** Total services across all batches */
  totalServices: number;
}

/**
 * Machine-readable explanation for a staged verdict.
 *
 * Reuses the target verification reasons and adds `completed` for one-shot
 * containers that exited successfully by design.
 */
export type StagedGateReason = TargetVerificationResult["reason"] | "completed";

/** Gate verdict for a single service in a batch. */
export interface StagedServiceVerdict {
  /** Compose service name */
  service: string;
  /** Classification for the latest observation */
  status: "ready" | "pending" | "failed";
  /** Stable machine-readable explanation for the classification */
  reason: StagedGateReason;
  /** Assurance policy selected from Docker healthcheck availability */
  assurance: "healthcheck" | "running-only";
  /** Consecutive time a running-only service has satisfied its checks */
  stableForMs: number;
}

/** Aggregate result of gating one batch. */
export interface StagedGateReport {
  /** True when every service in the batch reached `ready` */
  ready: boolean;
  /** True when the gate exhausted its time or attempt bound without a terminal failure */
  timedOut: boolean;
  /** True when a readiness signal was unavailable, so the evidence is incomplete */
  degraded: boolean;
  /** Wall time consumed by the gate */
  elapsedMs: number;
  /** Number of observation attempts made */
  attempts: number;
  /** Per-service verdicts, one per gated service */
  services: StagedServiceVerdict[];
}

/** Why a batch was recorded as failed. */
export type StagedBatchFailureCause =
  | "dependency-skipped"
  | "start-failed"
  | "gate-unready"
  | "gate-timeout";

interface StagedBatchOutcomeBase {
  /** The batch this outcome describes */
  batch: StagedBatch;
  /**
   * Every failure attributable to this batch, INCLUDING pull failures, which never
   * set `cause` but must still reach `DeployResult.failed`. Declared on the base so
   * a `passed` batch can carry pull failures without being demoted to `failed`.
   */
  failed: FailedOperation[];
}

/** A batch whose services started and satisfied the gate. */
export interface StagedBatchPassed extends StagedBatchOutcomeBase {
  /** Discriminant */
  status: "passed";
  /** Services that started successfully */
  started: string[];
  /** Undefined when gating is disabled via --no-wait-for-ready or on the non-staged path */
  gate?: StagedGateReport;
}

/** A batch that failed to start or failed its gate. */
export interface StagedBatchFailed extends StagedBatchOutcomeBase {
  /** Discriminant */
  status: "failed";
  /** Services that started successfully */
  started: string[];
  /** Started but not ready at the gate bound. ALWAYS [] when no gate ran. */
  unhealthy: string[];
  /** Why this batch failed */
  cause: StagedBatchFailureCause;
  /** Gate evidence, when a gate ran */
  gate?: StagedGateReport;
}

/** A batch that was never attempted because the rollout halted first. */
export interface StagedBatchSkipped extends StagedBatchOutcomeBase {
  /** Discriminant */
  status: "skipped";
  /** Why this batch was skipped */
  reason: "rollout-halted";
}

/** Discriminated union of every possible batch outcome. */
export type StagedBatchOutcome = StagedBatchPassed | StagedBatchFailed | StagedBatchSkipped;

/** Terminal status of a staged rollout. */
export type StagedRolloutStatus = "completed" | "halted" | "degraded";

/** Full evidence produced by one staged rollout. */
export interface StagedRolloutReport {
  /** Terminal rollout status */
  status: StagedRolloutStatus;
  /** Maximum number of services per batch */
  batchSize: number;
  /** Policy applied when a batch fails */
  onFailure: StagedFailurePolicy;
  /** Number of planned batches */
  totalBatches: number;
  /** Number of batches that passed */
  completedBatches: number;
  /** 1-based index of the batch that triggered the halt, when halted */
  haltedAtBatch?: number;
  /** Per-batch outcomes in execution order */
  batches: StagedBatchOutcome[];
  /** Services a start was ISSUED for: succeeded union failed. */
  attempted: string[];
  /** Sum of started counts across non-skipped batches. */
  started: number;
  /** attempted minus unhealthy. */
  healthy: string[];
  /** Started but not ready at a gate bound; [] when no gate ran anywhere. */
  unhealthy: string[];
  /** Sum of outcome.failed plus one STAGE_NOT_ATTEMPTED entry per member of every skipped batch. */
  failed: FailedOperation[];
}

/** Compact projection of a rollout report, embedded in `DeployResult.staged`. */
export interface StagedRolloutSummary {
  /** Terminal rollout status */
  status: StagedRolloutStatus;
  /** Maximum number of services per batch */
  batchSize: number;
  /** Policy applied when a batch fails */
  onFailure: StagedFailurePolicy;
  /** Number of planned batches */
  totalBatches: number;
  /** Number of batches that passed */
  completedBatches: number;
  /** 1-based index of the batch that triggered the halt, when halted */
  haltedAtBatch?: number;
}

/** Progress events emitted while a staged rollout runs. */
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
