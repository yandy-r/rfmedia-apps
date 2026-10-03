/**
 * Shared readiness and health-check contracts for rfapps CLI.
 */

/**
 * Probe types used when evaluating dependency readiness.
 */
export type ReadinessProbeType = "container-state" | "container-health" | "tcp-port";

/**
 * Status for a single readiness probe.
 */
export type ReadinessProbeStatus = "ready" | "pending" | "failed";

/**
 * Aggregate status for a dependency across all probes.
 */
export type DependencyReadinessStatus = "ready" | "pending" | "failed";

/**
 * Internal readiness signal types used by polling.
 */
export type ReadinessSignalType = "service-container-map" | "container-inspect";

/**
 * Availability status for readiness signals.
 */
export interface ReadinessSignalAvailability {
  /** True when all readiness signals needed for full fidelity are available. */
  available: boolean;
  /** Signals that were unavailable during evaluation. */
  unavailableSignals: ReadinessSignalType[];
}

/**
 * Polling configuration for readiness checks.
 */
export interface ReadinessPollSettings {
  /** Maximum time to wait for readiness (seconds). */
  timeoutSeconds: number;
  /** Delay between poll attempts (seconds). */
  intervalSeconds: number;
  /** Maximum number of poll attempts before failing. */
  retries: number;
}

/**
 * Result of a single readiness probe.
 */
export interface DependencyProbeResult {
  /** Which probe produced this result. */
  type: ReadinessProbeType;
  /** Probe status at evaluation time. */
  status: ReadinessProbeStatus;
  /** Optional machine-readable probe target (port, container, etc.). */
  target?: string;
  /** Human-readable details. */
  message?: string;
}

/**
 * Readiness result for one dependency service.
 */
export interface DependencyReadinessResult {
  /** Dependency service name from compose config. */
  dependency: string;
  /** Backing container name when available. */
  containerName?: string;
  /** Aggregated dependency readiness status. */
  status: DependencyReadinessStatus;
  /** Probe-level evidence used for status classification. */
  probes: DependencyProbeResult[];
}

/**
 * Readiness result grouped by target service.
 */
export interface ServiceReadinessResult {
  /** Target service that depends on `dependencies`. */
  service: string;
  /** Readiness results for each direct dependency. */
  dependencies: DependencyReadinessResult[];
}

/**
 * Summary produced by readiness polling.
 */
export interface DependencyReadinessSummary {
  /** True when all evaluated dependencies are ready. */
  ready: boolean;
  /** True when polling exhausted timeout/retries without full readiness. */
  timedOut: boolean;
  /** Number of unique dependencies evaluated. */
  totalDependencies: number;
  /** Dependencies currently classified as ready. */
  readyDependencies: string[];
  /** Dependencies still pending readiness. */
  pendingDependencies: string[];
  /** Dependencies currently classified as failed/unhealthy. */
  failedDependencies: string[];
  /** Total elapsed polling time in milliseconds. */
  elapsedMs: number;
  /** Number of polling attempts executed. */
  attempts: number;
  /** Result set grouped by target service. */
  services: ServiceReadinessResult[];
  /** Availability of readiness telemetry signals. */
  signalAvailability: ReadinessSignalAvailability;
  /** Non-fatal warnings encountered while evaluating readiness. */
  warnings?: string[];
}

/** Assurance provided by target-service verification. */
export type TargetVerificationAssurance = "healthcheck" | "running-only";

/** Runtime states retained as target-service verification evidence. */
export type TargetRuntimeState =
  | "running"
  | "restarting"
  | "exited"
  | "paused"
  | "dead"
  | "created"
  | "missing"
  | "unknown";

/** Docker health states retained as target-service verification evidence. */
export type TargetDockerHealth = "healthy" | "unhealthy" | "starting" | "none" | "unknown";

/** A single observation of the target container. */
export interface TargetServiceObservation {
  /** Daemon-local image ID used by the observed container. */
  imageId?: string;
  /** Current target runtime state. */
  state: TargetRuntimeState;
  /** Last/current container exit code when inspect telemetry is available. */
  exitCode?: number;
  /** Docker health state, or `none` when no healthcheck is configured. */
  health: TargetDockerHealth;
}

/** Classification for the latest target observation. */
export type TargetVerificationStatus = "ready" | "pending" | "failed";

/** Target-level evidence from one verification attempt. */
export interface TargetVerificationResult extends TargetServiceObservation {
  /** Classification for the latest observation. */
  status: TargetVerificationStatus;
  /** Whether the observed daemon-local image matches the reviewed image. */
  imageMatches: boolean;
  /** Assurance policy selected from Docker healthcheck availability. */
  assurance: TargetVerificationAssurance;
  /** Consecutive time the running-only target has satisfied target checks. */
  stableForMs: number;
  /** Stable machine-readable explanation for the current classification. */
  reason:
    | "ready"
    | "stabilizing"
    | "image-mismatch"
    | "telemetry-unavailable"
    | "not-running"
    | "restarting"
    | "exited"
    | "exit-code-nonzero"
    | "health-starting"
    | "health-unhealthy"
    | "health-unknown";
}

/** Combined target and dependency verification summary. */
export interface ServiceVerificationSummary {
  /** Target Compose service name. */
  service: string;
  /** Exact daemon-local image ID required for success. */
  expectedImageId: string;
  /** True only when target and dependency checks both pass. */
  ready: boolean;
  /** True when polling exhausted its timeout or retry bound. */
  timedOut: boolean;
  /** Assurance provided by the target verification policy. */
  assurance: TargetVerificationAssurance;
  /** Latest target-level evidence. */
  target: TargetVerificationResult;
  /** Latest supplementary direct-dependency evidence. */
  dependencies: DependencyReadinessSummary;
  /** Total elapsed polling time in milliseconds. */
  elapsedMs: number;
  /** Number of polling attempts executed. */
  attempts: number;
}
