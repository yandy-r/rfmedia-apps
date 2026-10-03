/**
 * Public contracts for the managed image-update lifecycle.
 */

import type { DeploymentPlan, ImageUpdateStatus } from "./plan.js";

/** Schema discriminator for persisted managed-update plans. */
export const MANAGED_UPDATE_PLAN_SCHEMA_VERSION = "update-plan.v1" as const;

/** Schema discriminator for managed-update results. */
export const MANAGED_UPDATE_RESULT_SCHEMA_VERSION = "update.v1" as const;

/** Managed updates mutate one service at a time in the first release. */
export type ManagedUpdateApplyPolicy = "sequential";

/** Explicit recovery policy approved with a managed-update plan. */
export type ManagedUpdateRestorePolicy = "restore-on-failure" | "no-restore-on-failure";

/** Verification assurance promised for an updated or restored service. */
export type ManagedUpdateVerificationPolicy = "healthcheck" | "running-only";

/** Identity values reviewed before any mutation is approved. */
export interface ManagedUpdateReviewedIdentity {
  /** Image reference from the resolved Compose service. */
  configuredImage: string;
  /** Platform selected for the service image. */
  platform?: string;
  /** Immutable image ID used by the running container on this Docker daemon. */
  currentImageId?: string;
  /** Canonical repository digest used by the running image, when available. */
  currentDigest?: string;
  /** Immutable repository digest proposed by the reviewed plan. */
  proposedDigest?: string;
}

/** One selected service in a secret-free managed-update plan. */
export interface ManagedUpdatePlanService extends ManagedUpdateReviewedIdentity {
  /** Compose service name. */
  service: string;
  /** Secret-free fingerprint of the fully resolved mutation-relevant service model. */
  resolvedConfigFingerprint: string;
  /** Detection outcome; only `update-available` is actionable. */
  status: ImageUpdateStatus;
  /** Named per-service generation selected as the recovery anchor. */
  recoveryGeneration?: number;
  /** Whether an exact same-daemon recovery image is available. */
  recoveryEligible: boolean;
  /** Target verification method reviewed with the plan. */
  verification: ManagedUpdateVerificationPolicy;
  /** Stable sanitized reason code for unsupported or indeterminate services. */
  errorCode?: string;
  /** Sanitized operator-facing context for a non-actionable status. */
  message?: string;
}

/** Secret-free, immutable-identity-bound managed-update plan. */
export interface ManagedUpdatePlan extends Pick<
  DeploymentPlan,
  "id" | "createdAt" | "composeHash" | "composePath" | "profiles"
> {
  /** Managed-plan schema discriminator. */
  schemaVersion: typeof MANAGED_UPDATE_PLAN_SCHEMA_VERSION;
  /** Routes this plan away from ordinary deployment apply. */
  intent: "managed-update";
  /** Non-secret fingerprint of the reviewed Docker context/daemon authority. */
  dockerContextFingerprint: string;
  /** Non-secret fingerprint of the selected environment provider and source. */
  envSourceFingerprint: string;
  /** Exact effective Compose project name approved for every project-scoped command. */
  composeProjectName: string;
  /** Explicit reviewed scope; managed plans never use an implicit all-services scope. */
  targetServices: string[];
  /** Managed updates are always applied sequentially. */
  applyPolicy: ManagedUpdateApplyPolicy;
  /** Recovery behavior approved with this plan. */
  restorePolicy: ManagedUpdateRestorePolicy;
  /** Complete per-service accounting for the reviewed scope. */
  services: ManagedUpdatePlanService[];
}

/** Stable lifecycle stage used by progress and error evidence. */
export type ManagedUpdateStage =
  | "detect"
  | "validate"
  | "snapshot"
  | "pull"
  | "recreate"
  | "verify_update"
  | "restore"
  | "verify_restore"
  | "record"
  | "complete"
  | "interrupted";

/** Immutable identity observed at a lifecycle boundary. */
export interface ManagedUpdateObservedIdentity {
  /** Configured or pinned image reference. */
  configuredImage: string;
  /** Docker container ID, when a container was observed. */
  containerId?: string;
  /** Same-daemon immutable image ID. */
  imageId?: string;
  /** Canonical repository digest, when available. */
  digest?: string;
  /** Observed platform. */
  platform?: string;
}

/** Identity assumption that changed after plan review. */
export type ManagedUpdateDriftKind =
  | "compose"
  | "compose-project"
  | "docker-context"
  | "env-source"
  | "resolved-config"
  | "scope"
  | "platform"
  | "current-image"
  | "proposed-digest"
  | "recovery-generation";

/** Evidence for a fail-closed reviewed-identity drift rejection. */
export interface ManagedUpdateDriftEvidence {
  kind: ManagedUpdateDriftKind;
  expected?: string;
  observed?: string;
}

/** Stable, sanitized lifecycle error returned to callers and persisted reports. */
export type ManagedUpdateError =
  | {
      kind: "lifecycle";
      stage: ManagedUpdateStage;
      code: string;
      message: string;
    }
  | {
      kind: "drift";
      stage: "validate";
      code: string;
      message: string;
      drift: ManagedUpdateDriftEvidence;
    };

/** Container state retained as target-verification evidence. */
export type ManagedUpdateRuntimeState = "running" | "restarting" | "exited" | "missing" | "unknown";

/** Docker health state retained as target-verification evidence. */
export type ManagedUpdateDockerHealth =
  | "healthy"
  | "unhealthy"
  | "starting"
  | "not-configured"
  | "unknown";

/** Verification was not applicable or did not start. */
export interface ManagedUpdateVerificationNotRun {
  status: "not-run";
  assurance: "none";
  reasonCode: string;
}

/** Successful target and dependency verification evidence. */
export interface ManagedUpdateVerificationPassed {
  status: "passed";
  assurance: ManagedUpdateVerificationPolicy;
  expectedImageId: string;
  observedImageId: string;
  runtimeState: "running";
  dockerHealth: "healthy" | "not-configured";
  dependenciesReady: true;
  elapsedMs: number;
}

/** Failed target or dependency verification evidence. */
export interface ManagedUpdateVerificationFailed {
  status: "failed";
  assurance: ManagedUpdateVerificationPolicy;
  expectedImageId?: string;
  observedImageId?: string;
  runtimeState: ManagedUpdateRuntimeState;
  dockerHealth: ManagedUpdateDockerHealth;
  dependenciesReady: boolean;
  elapsedMs: number;
  error: ManagedUpdateError;
}

/** Target verification evidence, discriminated by `status`. */
export type ManagedUpdateVerificationEvidence =
  | ManagedUpdateVerificationNotRun
  | ManagedUpdateVerificationPassed
  | ManagedUpdateVerificationFailed;

/** Generation transition evidence for one service. */
export interface ManagedUpdateGenerationEvidence {
  before?: number;
  after?: number;
  restored?: number;
}

/** Exact-image recovery evidence, discriminated by `status`. */
export type ManagedUpdateRestoreEvidence =
  | { status: "not-required" }
  | { status: "disabled"; reasonCode: string }
  | { status: "unavailable"; reasonCode: string; message?: string }
  | {
      status: "succeeded";
      imageId: string;
      generation: number;
      verification: ManagedUpdateVerificationPassed;
      elapsedMs: number;
    }
  | {
      status: "failed";
      imageId?: string;
      generation?: number;
      verification?: ManagedUpdateVerificationFailed;
      elapsedMs: number;
      error: ManagedUpdateError;
    };

/** Terminal result for one requested service. */
export type ManagedUpdateOutcome =
  | "up_to_date"
  | "unsupported"
  | "detection_unknown"
  | "blocked"
  | "planned"
  | "cancelled"
  | "updated"
  | "restored"
  | "update_failed"
  | "restore_failed"
  | "interrupted";

/** Per-service lifecycle result with final-state and recovery evidence. */
export interface ManagedUpdateServiceResult {
  service: string;
  outcome: ManagedUpdateOutcome;
  stage: ManagedUpdateStage;
  reviewedIdentity: ManagedUpdateReviewedIdentity;
  observedIdentity?: ManagedUpdateObservedIdentity;
  verification: ManagedUpdateVerificationEvidence;
  restore: ManagedUpdateRestoreEvidence;
  generations: ManagedUpdateGenerationEvidence;
  durationMs: number;
  error?: ManagedUpdateError;
}

/** Aggregate lifecycle classification. */
export type ManagedUpdateResultStatus =
  | "no_updates"
  | "succeeded"
  | "recovered_failure"
  | "partial"
  | "failed"
  | "interrupted";

/** Process semantics derived from a managed-update result. */
export type ManagedUpdateExitCode = 0 | 1 | 2;

/** Complete aggregate counts for the requested service scope. */
export interface ManagedUpdateSummary {
  selected: number;
  actionable: number;
  updated: number;
  restored: number;
  upToDate: number;
  unsupported: number;
  unknown: number;
  blocked: number;
  failed: number;
  interrupted: number;
}

/** Signal evidence retained when a run is interrupted during mutation. */
export interface ManagedUpdateInterruptionEvidence {
  signal: "SIGINT" | "SIGTERM";
  stage: ManagedUpdateStage;
  service?: string;
  /** Whether the active recovery unit reached a verified stable terminal state. */
  stabilized: boolean;
}

/** Non-secret evidence that terminal resource cleanup did not complete. */
export interface ManagedUpdateCleanupFailure {
  operation: "lock-release" | "state-close" | "filesystem-cleanup";
  code: "CLEANUP_FAILED";
  message: string;
}

/** Versioned final document emitted by the managed-update workflow. */
export interface ManagedUpdateResult {
  schemaVersion: typeof MANAGED_UPDATE_RESULT_SCHEMA_VERSION;
  runId: string;
  planId: string;
  startedAt: string;
  completedAt: string;
  status: ManagedUpdateResultStatus;
  success: boolean;
  exitCode: ManagedUpdateExitCode;
  applied: boolean;
  restoreOnFailure: boolean;
  summary: ManagedUpdateSummary;
  services: ManagedUpdateServiceResult[];
  interruption?: ManagedUpdateInterruptionEvidence;
  cleanupFailures?: ManagedUpdateCleanupFailure[];
}
