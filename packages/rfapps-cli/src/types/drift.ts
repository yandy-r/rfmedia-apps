/**
 * Drift detection types for rfapps CLI
 *
 * Used for detecting configuration differences between compose.yml and running containers.
 */

import type { ConfigDiff, EnvChange, ImageDiff, PortMapping, VolumeMapping } from "./plan.js";
import type { ReconcileServiceObservation } from "./reconcile.js";
import type { ContainerState, HealthStatus } from "./results.js";

export const DRIFT_SCHEMA_VERSION = "1.0.0";

/**
 * Drift category for a service
 */
export type DriftCategory =
  | "image"
  | "environment"
  | "ports"
  | "volumes"
  | "networks"
  | "runtime-status";

/**
 * Direction of drift between compose and running containers
 */
export type DriftDirection = "compose_ahead" | "container_ahead" | "diverged";

/**
 * Options for detecting drift
 */
export interface DriftOptions {
  /** Path to compose file */
  composePath: string;
  /** Target services (undefined means all) */
  services?: string[];
  /** Compose profiles to use */
  profiles?: string[];
}

/**
 * Complete, explicitly-scoped observation options used by reconciliation.
 *
 * Unlike legacy drift detection, reconciliation requires the caller to freeze
 * the selected service scope before observing it so failures can never make a
 * selected service disappear from the result.
 */
export interface ReconcileDriftOptions extends DriftOptions {
  /** Frozen selected service scope. */
  services: string[];
  /** Explicit effective Compose project name. */
  projectName?: string;
  /** Explicit environment file used while resolving Compose intent. */
  envFile?: string;
  /** Working directory for Compose and Docker commands. */
  cwd?: string;
  /** Bounded command timeout in milliseconds. */
  timeout?: number;
  /** In-memory effective execution environment captured under the lifecycle lock. */
  env?: Record<string, string>;
  /** Do not inherit mutable parent-process environment values. */
  replaceEnv?: boolean;
}

/**
 * Options that control drift command exit behavior.
 */
export interface DriftCommandOptions {
  /** Keep exit code successful when drift is found */
  reportOnly?: boolean;
}

/**
 * Runtime state and health drift for a compose service.
 */
export interface RuntimeStatusDrift {
  /** Current container state/health */
  current: {
    state: ContainerState;
    health: HealthStatus;
  };
  /** Desired runtime state/health for a healthy compose service */
  desired: {
    state: "running";
    health: "healthy" | "none";
  };
  /** Whether runtime state or health differs from desired */
  changed: boolean;
}

/**
 * Drift details for a single service
 */
export interface ServiceDrift {
  /** Service name */
  service: string;
  /** Whether drift exists */
  hasDrift: boolean;
  /** Direction of drift */
  direction: DriftDirection;
  /** Drifted categories */
  categories: DriftCategory[];
  /** Image diff */
  image: ImageDiff;
  /** Environment variable changes */
  environment: EnvChange[];
  /** Port mapping changes */
  ports: ConfigDiff<PortMapping[]>;
  /** Volume mapping changes */
  volumes: ConfigDiff<VolumeMapping[]>;
  /** Network changes */
  networks: ConfigDiff<string[]>;
  /** Runtime state/health changes */
  runtimeStatus: RuntimeStatusDrift;
}

/**
 * Summary of drift results
 */
export interface DriftSummary {
  /** Total services inspected */
  total: number;
  /** Services with drift */
  drifted: number;
  /** Services without drift */
  unchanged: number;
  /** Drift direction counts */
  directions: {
    composeAhead: number;
    containerAhead: number;
    diverged: number;
  };
}

/**
 * Full drift detection result
 */
export interface DriftResult {
  /** Version of the drift result schema */
  schemaVersion: string;
  /** Timestamp of detection */
  timestamp: string;
  /** Compose file path */
  composePath: string;
  /** Service drift details */
  services: ServiceDrift[];
  /** Summary of drift */
  summary: DriftSummary;
}

/**
 * Process-local evidence for the pure reconciliation planner.
 *
 * `drift` intentionally retains the existing comparator shape, which may hold
 * desired/current values. Callers must project it through the value-free
 * reconciliation boundary before producing public output or fingerprints.
 */
export interface ReconcileDriftEvidence {
  readonly service: string;
  readonly observation: ReconcileServiceObservation;
  readonly drift?: ServiceDrift;
}
