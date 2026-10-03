/**
 * Public, secret-safe contracts for desired-versus-actual reconciliation.
 */

import type { DriftCategory, DriftDirection } from "./drift.js";
import type { ContainerState, HealthStatus } from "./results.js";

/** Schema discriminator for reconciliation results. */
export const RECONCILE_SCHEMA_VERSION = "reconcile.v1" as const;

/** Conservative bounds shared by CLI, library, and MCP reconciliation entry points. */
export const RECONCILE_MAX_SERVICES = 256;
export const RECONCILE_MAX_SERVICE_NAME_LENGTH = 128;

export type ReconcileMode = "report" | "auto-apply";
export type ReconcileComparison = "in_sync" | "drifted" | "observation_failed";
export type ReconcileActionKind = "none" | "create" | "start" | "recreate" | "blocked";
export type ReconcileActionableKind = Exclude<ReconcileActionKind, "none" | "blocked">;
export type ReconcileEligibility = "not_requested" | "allowed" | "blocked";

/** Stable terminal states. Later lifecycle phases refine the initial report outcome. */
export type ReconcileOutcome =
  | "reported"
  | "no_action"
  | "became_in_sync"
  | "converged"
  | "blocked_policy"
  | "blocked_stale"
  | "observation_failed"
  | "action_failed"
  | "not_converged"
  | "cancelled_before_action"
  | "cancelled_during_action"
  | "skipped_after_unsafe_failure";

export type ReconcileStatus =
  | "reported"
  | "planned"
  | "converged"
  | "partial"
  | "failed"
  | "cancelled";

export type ReconcileExitCode = 0 | 1 | 2 | 3;
export type ReconcileRuntimeState = ContainerState | "missing" | "unknown";
export type ReconcileRuntimeHealth = HealthStatus | "unknown";

/** A stable machine reason. Messages are deliberately not part of the wire contract. */
export interface ReconcileReason {
  code: string;
  category?: DriftCategory;
}

/** Environment drift is public by variable name and change kind only. */
export interface ReconcileEnvironmentDrift {
  name: string;
  changeType: "added" | "removed" | "modified" | "unchanged";
}

/**
 * Value-free public drift evidence. Desired/current values and hashes never cross this boundary.
 */
export interface ReconcileDriftProjection {
  hasDrift: boolean;
  direction: DriftDirection;
  categories: DriftCategory[];
  image: { changed: boolean };
  environment: ReconcileEnvironmentDrift[];
  ports: { changed: boolean };
  volumes: { changed: boolean };
  networks: { changed: boolean };
  runtimeStatus: {
    changed: boolean;
    currentState: ReconcileRuntimeState;
    currentHealth: ReconcileRuntimeHealth;
    desiredState: "running";
    desiredHealth: "healthy" | "none";
  };
}

/** Non-secret exact container identity used to bind reviewed observations. */
export interface ReconcileContainerEvidence {
  id: string;
  name: string;
  state: ReconcileRuntimeState;
  health: ReconcileRuntimeHealth;
}

/** Complete observation shape supplied by the drift/inspection adapter. */
export type ReconcileServiceObservation =
  | { kind: "missing"; containers?: readonly ReconcileContainerEvidence[] }
  | { kind: "present"; containers: readonly ReconcileContainerEvidence[] }
  | { kind: "ambiguous"; containers: readonly ReconcileContainerEvidence[] }
  | { kind: "failed"; containers?: readonly ReconcileContainerEvidence[]; reasonCode?: string };

export interface ReconcileAutomationDecision {
  status: "not_requested" | "allowed" | "blocked";
  reasonCode?: string;
  nextEligibleAt?: string;
}

export interface ReconcileScope {
  composePath: string;
  project: string;
  profiles: string[];
  services: string[];
}

export interface ReconcilePolicyContext {
  mode: ReconcileMode;
  dryRun: boolean;
  scope: ReconcileScope;
  actionableServices: string[];
}

export interface ReconcileAutomationPolicy {
  evaluate(
    context: ReconcilePolicyContext,
  ): ReconcileAutomationDecision | Promise<ReconcileAutomationDecision>;
}

export interface ReconcileAction {
  kind: ReconcileActionKind;
  /** The action that policy or evidence blocked, when one was safely derivable. */
  proposedKind?: ReconcileActionableKind;
  categories: DriftCategory[];
  eligibility: ReconcileEligibility;
  reasons: ReconcileReason[];
}

export interface ReconcileServiceResult {
  service: string;
  comparison: ReconcileComparison;
  drift: ReconcileDriftProjection;
  action: ReconcileAction;
  outcome: ReconcileOutcome;
  finalDrift?: ReconcileDriftProjection;
}

export interface ReconcileSummary {
  selected: number;
  inSync: number;
  drifted: number;
  actionable: number;
  blocked: number;
  converged: number;
  failed: number;
}

export interface ReconcileResult {
  schemaVersion: typeof RECONCILE_SCHEMA_VERSION;
  operation: "reconcile";
  mode: ReconcileMode;
  dryRun: boolean;
  status: ReconcileStatus;
  scope: ReconcileScope;
  actionFingerprint: string;
  automation: ReconcileAutomationDecision;
  services: ReconcileServiceResult[];
  summary: ReconcileSummary;
  success: boolean;
  exitCode: ReconcileExitCode;
}
