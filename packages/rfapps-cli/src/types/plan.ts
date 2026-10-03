/**
 * Plan types for rfapps CLI
 *
 * Types for the plan/apply workflow, similar to Terraform's plan/apply pattern.
 */

import type { PlanIntelligence, PlanIntelligenceInput } from "./plan-intelligence.js";

/**
 * Type of change for a service
 */
export type ChangeType = "create" | "update" | "recreate" | "delete" | "unchanged";

/** Intent associated with a saved plan. An absent intent is a legacy deployment plan. */
export type PlanIntent = "deployment" | "managed-update";

/** Explicit result of checking a service image for registry updates. */
export type ImageUpdateStatus =
  | "update-available"
  | "up-to-date"
  | "unsupported"
  | "local-missing"
  | "unknown";

/** Identity and sanitized diagnostic evidence shared by image update outcomes. */
export interface ImageUpdateEvidence {
  /** Normalized registry image reference used for detection and deduplication. */
  canonicalImage?: string;
  /** Selected OCI platform (`os/architecture[/variant]`), when explicitly known. */
  platform?: string;
  /** Local canonical repository digest, when available. */
  localDigest?: string;
  /** Remote canonical repository digest, when available. */
  remoteDigest?: string;
  /** Stable, bounded classification for non-actionable detection results. */
  errorCode?: string;
  /** Sanitized operator-facing context; never raw registry or subprocess output. */
  error?: string;
}

/**
 * Result of an image update check.
 *
 * `updateAvailable` is retained for compatibility with existing consumers. New
 * code should discriminate on `status` so unsupported and indeterminate checks
 * cannot be mistaken for an up-to-date image.
 */
export type ImageUpdateCheck =
  | (ImageUpdateEvidence & {
      status: "update-available";
      updateAvailable?: true;
      localDigest: string;
      remoteDigest: string;
    })
  | (ImageUpdateEvidence & {
      status: "up-to-date";
      updateAvailable?: false;
      localDigest: string;
      remoteDigest: string;
    })
  | (ImageUpdateEvidence & {
      status: "unsupported";
      updateAvailable?: false;
    })
  | (ImageUpdateEvidence & {
      status: "local-missing";
      updateAvailable?: false;
    })
  | (ImageUpdateEvidence & {
      status: "unknown";
      updateAvailable?: false;
      error: string;
    });

/**
 * Generic diff structure for comparing values
 */
export interface ConfigDiff<T> {
  /** Current value (may be undefined if not running) */
  current?: T;
  /** Desired value from compose config */
  desired?: T;
  /** Whether the value has changed */
  changed: boolean;
}

/**
 * Image diff with update detection
 */
export interface ImageDiff extends ConfigDiff<string> {
  /** Explicit registry-update classification */
  updateStatus?: ImageUpdateStatus;
  /** Normalized registry image reference used for detection and deduplication */
  canonicalImage?: string;
  /** Selected OCI platform (`os/architecture[/variant]`), when explicitly known */
  platform?: string;
  /** Whether a newer version is available on the registry */
  updateAvailable?: boolean;
  /** Local image digest */
  localDigest?: string;
  /** Remote image digest */
  remoteDigest?: string;
  /** Sanitized reason when update detection was not conclusive */
  updateError?: string;
  /** Stable, bounded classification for non-actionable detection results */
  errorCode?: string;
}

/**
 * Port mapping configuration
 */
export interface PortMapping {
  /** Host port */
  host?: string;
  /** Container port */
  container: string;
  /** Protocol (tcp/udp) */
  protocol: string;
}

/**
 * Volume mapping configuration
 */
export interface VolumeMapping {
  /** Source path or volume name */
  source: string;
  /** Target path in container */
  target: string;
  /** Whether the volume is read-only */
  readonly?: boolean;
}

/**
 * Environment variable change
 */
export interface EnvChange {
  /** Variable name */
  name: string;
  /** Current value */
  current?: string;
  /** Desired value */
  desired?: string;
  /** Type of change */
  changeType: "added" | "removed" | "modified" | "unchanged";
  /** Whether this is a secret variable (value will be masked) */
  isSecret: boolean;
}

/**
 * Change details for a single service
 */
export interface ServiceChange {
  /** Service name */
  service: string;
  /** Secret-free fingerprint of the fully resolved Compose service model. */
  resolvedConfigFingerprint?: string;
  /** Type of change required */
  changeType: ChangeType;
  /** Image change (with optional update detection) */
  image: ImageDiff;
  /** Environment variable changes */
  environment: EnvChange[];
  /** Port mapping changes */
  ports: ConfigDiff<PortMapping[]>;
  /** Volume mapping changes */
  volumes: ConfigDiff<VolumeMapping[]>;
  /** Network changes */
  networks: ConfigDiff<string[]>;
}

/**
 * Summary of planned changes
 */
export interface PlanSummary {
  /** Number of services to create */
  toCreate: number;
  /** Number of services to update */
  toUpdate: number;
  /** Number of services to recreate */
  toRecreate: number;
  /** Number of services to delete */
  toDelete: number;
  /** Number of unchanged services */
  unchanged: number;
  /** Number of services with available image updates */
  updatesAvailable: number;
  /** Total number of services */
  total: number;
}

/**
 * Full deployment plan
 */
export interface DeploymentPlan {
  /** Plan intent. Absent means a legacy deployment plan. */
  intent?: PlanIntent;
  /** Unique plan ID */
  id: string;
  /** Timestamp when plan was created */
  createdAt: string;
  /** Hash of compose file when plan was created */
  composeHash: string;
  /** Path to compose file */
  composePath: string;
  /** Target services (undefined means all) */
  targetServices?: string[];
  /** Profiles used */
  profiles?: string[];
  /** Service changes */
  services: ServiceChange[];
  /** Summary of changes */
  summary: PlanSummary;
  /** Contextual annotations. Absent unless `--explain` was requested. */
  intelligence?: PlanIntelligence;
}

/**
 * Plan validation result
 */
export interface PlanValidation {
  /** Whether the plan is valid */
  valid: boolean;
  /** Validation errors (plan cannot be applied) */
  errors: string[];
  /** Validation warnings (plan can still be applied) */
  warnings: string[];
}

/**
 * Options for generating a plan
 */
export interface PlanOptions {
  /** Path to compose file */
  composePath: string;
  /** Explicit Compose project name used to pin project-scoped commands. */
  projectName?: string;
  /** Target services (undefined means all) */
  services?: string[];
  /** Profiles to use */
  profiles?: string[];
  /** Check registry for image updates */
  checkUpdates?: boolean;
  /** Enrichment for contextual annotations. Absent => no annotation is computed. */
  intelligence?: PlanIntelligenceInput;
}

/**
 * Failed service operation
 */
export interface ApplyFailure {
  /** Service name */
  service: string;
  /** Error message */
  error: string;
}

/**
 * Result of applying a plan
 */
export interface ApplyResult {
  /** Plan ID that was applied */
  planId: string;
  /** Services that were successfully applied */
  applied: string[];
  /** Services that failed */
  failed: ApplyFailure[];
  /** Total number of services */
  total: number;
  /** Overall success */
  success: boolean;
}
