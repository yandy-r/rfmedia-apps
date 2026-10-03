/**
 * Result types for rfapps CLI operations
 */
import type { ReadinessSignalAvailability, ServiceReadinessResult } from "./health.js";
import type { ScanReport } from "./security-scan.js";
import type { StagedRolloutSummary } from "./staged.js";
import type { ConflictValidationResult } from "./validation.js";

/**
 * Container health status
 */
export type HealthStatus = "healthy" | "unhealthy" | "starting" | "none";

/**
 * Container state
 */
export type ContainerState = "running" | "exited" | "paused" | "restarting" | "dead" | "created";

/**
 * Service status information
 */
export interface ServiceStatus {
  /** Service name */
  name: string;
  /** Container ID (short) */
  containerId?: string;
  /** Current state */
  state: ContainerState;
  /** Health status */
  health: HealthStatus;
  /** Uptime or exit info */
  status: string;
  /** Port mappings */
  ports: string[];
  /** Image name */
  image: string;
  /** Image tag */
  tag: string;
}

/**
 * Resource usage statistics
 */
export interface ResourceStats {
  /** Service name */
  name: string;
  /** CPU usage percentage */
  cpuPercent: number;
  /** Memory usage in bytes */
  memoryUsage: number;
  /** Memory limit in bytes */
  memoryLimit: number;
  /** Memory usage percentage */
  memoryPercent: number;
  /** Network I/O */
  netIO: string;
  /** Block I/O */
  blockIO: string;
}

/**
 * Result of status command
 */
export interface StatusResult {
  /** Timestamp of the status check */
  timestamp: string;
  /** List of service statuses */
  services: ServiceStatus[];
  /** Resource stats (if requested) */
  stats?: ResourceStats[];
  /** Total service count */
  total: number;
  /** Running service count */
  running: number;
  /** Healthy service count */
  healthy: number;
}

/**
 * Result of pull operation
 */
export interface PullResult {
  /** Services that were pulled */
  services: string[];
  /** Services that were skipped (already up to date) */
  skipped: string[];
  /** Services that failed to pull */
  failed: FailedOperation[];
  /** Total images pulled */
  pulled: number;
}

/**
 * Result of build operation
 */
export interface BuildResult {
  /** Services that were built */
  services: string[];
  /** Services that failed to build */
  failed: FailedOperation[];
  /** Total containers built */
  built: number;
}

/**
 * Result of deploy operation
 */
export interface DeployResult {
  /** Services that were started */
  services: string[];
  /** Services that failed to start */
  failed: FailedOperation[];
  /** Services that passed health checks */
  healthy: string[];
  /** Services that failed health checks */
  unhealthy: string[];
  /** Total containers started */
  started: number;
  /** Pre-deploy conflict validation evidence, when explicitly requested */
  validation?: ConflictValidationResult;
  /** Staged rollout summary, present only when --staged was used */
  staged?: StagedRolloutSummary;
  /**
   * Image vulnerability scan report, present only when `--scan` was passed.
   *
   * MCP invariant: `deployResultSchema` (`src/mcp/schema.ts:297-304`) is a
   * closed object and deliberately does not mirror this field. The key must
   * never be *created* on the result — assign it only inside `if (options.scan)`,
   * never `result.scan = undefined` and never via a `{ ...result, scan }`
   * spread. `schemaObject`'s strict-key check iterates `Object.keys(input)`
   * (`packages/rf-common/src/mcp/schema.ts:422-436`) and the MCP path passes the
   * raw object by reference without a JSON round-trip, so a present-but-
   * `undefined` key throws "Unexpected properties at $: scan" at runtime while
   * typechecking clean. `scan`/`scanner`/`scanFailOn` are absent from
   * `deployInputSchema` and are not forwarded by `invokeDeploy`
   * (`src/mcp/adapters.ts:276-303`), which is what keeps this branch unreachable
   * from MCP.
   */
  scan?: ScanReport;
}

/**
 * Result of stop operation
 */
export interface StopResult {
  /** Services that were stopped */
  services: string[];
  /** Services that failed to stop */
  failed: FailedOperation[];
  /** Total containers stopped */
  stopped: number;
}

/**
 * Result of delete operation
 */
export interface DeleteResult {
  /** Services that were deleted */
  services: string[];
  /** Services that failed to delete */
  failed: FailedOperation[];
  /** Total containers deleted */
  deleted: number;
  /** Volumes removed (if requested) */
  volumesRemoved?: number;
  /** Images removed (if requested) */
  imagesRemoved?: number;
}

/**
 * Result of prune operation
 */
export interface PruneResult {
  /** Services that were pruned */
  services: string[];
  /** Services that failed to prune */
  failed: FailedOperation[];
  /** Total containers pruned */
  containers: number;
  /** Images removed */
  images: number;
  /** Images skipped (shared or in use) */
  imagesSkipped: number;
  /** Volumes pruned (if requested) */
  volumes?: number;
  /** Space reclaimed in bytes */
  spaceReclaimed: number;
  /** Phases completed (stop/remove/images/volumes/prune) */
  completedPhases: string[];
}

/**
 * Result of rebuild operation
 */
export interface RebuildResult {
  /** Services that were rebuilt */
  services: string[];
  /** Services that failed */
  failed: FailedOperation[];
  /** Services that passed health checks */
  healthy: string[];
  /** Services that failed health checks */
  unhealthy: string[];
  /** Phases completed (stop/pull/build/start) */
  completedPhases: string[];
  /** Total containers rebuilt */
  rebuilt: number;
}

/**
 * Failed operation details
 */
export interface FailedOperation {
  /** Service or resource name */
  name: string;
  /** Error message */
  error: string;
  /** Error code (if available) */
  code?: string;
}

/**
 * Result of health command
 */
export interface HealthCommandResult {
  /** Target services evaluated by the command */
  services: string[];
  /** True when all dependency checks are ready */
  ready: boolean;
  /** True when wait mode timed out */
  timedOut: boolean;
  /** Number of dependencies evaluated */
  totalDependencies: number;
  /** Dependencies classified as ready */
  readyDependencies: string[];
  /** Dependencies still pending readiness */
  pendingDependencies: string[];
  /** Dependencies classified as failed */
  failedDependencies: string[];
  /** Polling attempts performed */
  attempts: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Per-service readiness details */
  details: ServiceReadinessResult[];
  /** Availability of readiness telemetry signals */
  signalAvailability?: ReadinessSignalAvailability;
  /** Non-fatal warnings encountered during checks */
  warnings?: string[];
}
