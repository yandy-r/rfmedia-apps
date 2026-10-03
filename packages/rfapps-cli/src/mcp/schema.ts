import {
  schemaArray,
  schemaBoolean,
  schemaEnum,
  schemaNumber,
  schemaObject,
  schemaOptional,
  schemaRecord,
  schemaString,
  schemaUnion,
  type McpSchema,
} from "@rfmedia/common";

import type {
  ApplyResult,
  DeploymentPlan,
  DeleteResult,
  DeployResult,
  DriftResult,
  FailedOperation,
  HealthCommandResult,
  HistoryResult,
  PlanIntelligence,
  PlanSummary,
  PruneResult,
  PullResult,
  ReconcileResult,
  RebuildResult,
  ResourceStats,
  RollbackResult,
  ServiceChange,
  ServiceDrift,
  ServiceStatus,
  StagedRolloutSummary,
  StatusResult,
  StopResult,
} from "../types/index.js";
import {
  RECONCILE_MAX_SERVICES,
  RECONCILE_MAX_SERVICE_NAME_LENGTH,
  RECONCILE_SCHEMA_VERSION,
} from "../types/index.js";
import {
  CHANGE_REASON_CODES,
  PLAN_INTELLIGENCE_SCHEMA_VERSION,
} from "../types/plan-intelligence.js";

export interface McpExecutionArgs {
  dryRun?: boolean;
  debug?: boolean;
  verbose?: boolean;
  yes?: boolean;
  useDotenvx?: string;
  useOp?: string;
}

export interface McpTargetArgs {
  service?: string;
  services?: string[];
  group?: string;
  noSidecars?: boolean;
}

export interface McpComposeArgs {
  compose?: string;
  envFile?: string;
  profile?: string;
}

export interface StatusToolArgs extends McpExecutionArgs {
  service?: string;
  services?: string[];
  compose?: string;
  envFile?: string;
  all?: boolean;
  health?: boolean;
  stats?: boolean;
  logs?: boolean;
}

export interface PullToolArgs extends McpExecutionArgs, McpTargetArgs, McpComposeArgs {}

export interface DeployToolArgs extends McpExecutionArgs, McpTargetArgs, McpComposeArgs {
  skipPull?: boolean;
  forceRecreate?: boolean;
  parallel?: boolean;
  workers?: number;
  waitForReady?: boolean;
  healthTimeout?: number;
}

export interface RebuildToolArgs extends McpExecutionArgs, McpTargetArgs, McpComposeArgs {
  skipPull?: boolean;
  parallel?: boolean;
  workers?: number;
  waitForReady?: boolean;
  healthTimeout?: number;
}

export interface HealthToolArgs extends McpExecutionArgs, McpTargetArgs, McpComposeArgs {
  waitForReady?: boolean;
  healthTimeout?: number;
}

export interface DeleteToolArgs extends McpExecutionArgs, McpTargetArgs, McpComposeArgs {
  volumes?: boolean;
  images?: boolean;
}

export interface PruneToolArgs extends McpExecutionArgs, McpTargetArgs, McpComposeArgs {
  volumes?: boolean;
  images?: boolean;
}

export interface PlanToolArgs extends McpExecutionArgs, McpTargetArgs, McpComposeArgs {
  apply?: boolean;
  out?: string;
  showUnchanged?: boolean;
  checkUpdates?: boolean;
  explain?: boolean;
}

export interface ApplyToolArgs extends McpExecutionArgs {
  planFile: string;
  force?: boolean;
}

export interface HistoryToolArgs extends McpExecutionArgs {
  service?: string;
  limit?: number;
  since?: string;
  action?: "deploy" | "rebuild" | "delete" | "rollback" | "apply" | "prune" | "update" | "import";
}

export interface RollbackToolArgs extends McpExecutionArgs {
  service: string;
  steps?: number;
  toDeployment?: number;
  toGeneration?: number;
  toTime?: string;
  force?: boolean;
}

export interface DriftDetectToolArgs extends McpExecutionArgs, McpTargetArgs, McpComposeArgs {
  showUnchanged?: boolean;
  reportOnly?: boolean;
}

export interface DriftShowToolArgs extends McpExecutionArgs, McpComposeArgs {
  service: string;
  reportOnly?: boolean;
}

export interface DriftImportToolArgs extends McpExecutionArgs, McpTargetArgs, McpComposeArgs {
  backup?: boolean;
}

export interface ReconcileToolBaseArgs
  extends Omit<McpExecutionArgs, "yes">, McpTargetArgs, McpComposeArgs {
  showUnchanged?: boolean;
  healthTimeout?: number;
}

/** MCP auto-apply requires both explicit mutation intent and confirmation suppression. */
export type ReconcileToolArgs =
  | (ReconcileToolBaseArgs & { autoApply?: false; yes?: boolean })
  | (ReconcileToolBaseArgs & { autoApply: true; yes: true });

const dryRunResultSchema = schemaObject(
  {
    dryRun: schemaBoolean(),
  },
  { allowUnknownProperties: true },
);

function withDryRun<TResult>(schema: McpSchema<TResult>): McpSchema<TResult | { dryRun: boolean }> {
  return schemaUnion([schema, dryRunResultSchema]);
}

const executionArgShape = {
  dryRun: schemaOptional(schemaBoolean()),
  debug: schemaOptional(schemaBoolean()),
  verbose: schemaOptional(schemaBoolean()),
  yes: schemaOptional(schemaBoolean()),
  useDotenvx: schemaOptional(schemaString()),
  useOp: schemaOptional(schemaString()),
};

const targetArgShape = {
  service: schemaOptional(schemaString()),
  services: schemaOptional(schemaArray(schemaString())),
  group: schemaOptional(schemaString()),
  noSidecars: schemaOptional(schemaBoolean()),
};

const composeArgShape = {
  compose: schemaOptional(schemaString()),
  envFile: schemaOptional(schemaString()),
  profile: schemaOptional(schemaString()),
};

const statusTargetArgShape = {
  service: schemaOptional(schemaString()),
  services: schemaOptional(schemaArray(schemaString())),
};

const statusComposeArgShape = {
  compose: schemaOptional(schemaString()),
  envFile: schemaOptional(schemaString()),
};

const failedOperationSchema = schemaObject({
  name: schemaString(),
  error: schemaString(),
  code: schemaOptional(schemaString()),
});

const serviceStatusSchema = schemaObject({
  name: schemaString(),
  containerId: schemaOptional(schemaString()),
  state: schemaEnum(["running", "exited", "paused", "restarting", "dead", "created"] as const),
  health: schemaEnum(["healthy", "unhealthy", "starting", "none"] as const),
  status: schemaString(),
  ports: schemaArray(schemaString()),
  image: schemaString(),
  tag: schemaString(),
});

const resourceStatsSchema = schemaObject({
  name: schemaString(),
  cpuPercent: schemaNumber(),
  memoryUsage: schemaNumber(),
  memoryLimit: schemaNumber(),
  memoryPercent: schemaNumber(),
  netIO: schemaString(),
  blockIO: schemaString(),
});

const statusResultSchema = schemaObject({
  timestamp: schemaString(),
  services: schemaArray(serviceStatusSchema),
  stats: schemaOptional(schemaArray(resourceStatsSchema)),
  total: schemaNumber({ integer: true, minimum: 0 }),
  running: schemaNumber({ integer: true, minimum: 0 }),
  healthy: schemaNumber({ integer: true, minimum: 0 }),
});

const readinessProbeSchema = schemaObject({
  type: schemaEnum(["container-state", "container-health", "tcp-port"] as const),
  status: schemaEnum(["ready", "pending", "failed"] as const),
  target: schemaOptional(schemaString()),
  message: schemaOptional(schemaString()),
});

const dependencyReadinessSchema = schemaObject({
  dependency: schemaString(),
  containerName: schemaOptional(schemaString()),
  status: schemaEnum(["ready", "pending", "failed"] as const),
  probes: schemaArray(readinessProbeSchema),
});

const serviceReadinessSchema = schemaObject({
  service: schemaString(),
  dependencies: schemaArray(dependencyReadinessSchema),
});

const healthResultSchema = schemaObject({
  services: schemaArray(schemaString()),
  ready: schemaBoolean(),
  timedOut: schemaBoolean(),
  totalDependencies: schemaNumber({ integer: true, minimum: 0 }),
  readyDependencies: schemaArray(schemaString()),
  pendingDependencies: schemaArray(schemaString()),
  failedDependencies: schemaArray(schemaString()),
  attempts: schemaNumber({ integer: true, minimum: 0 }),
  elapsedMs: schemaNumber({ minimum: 0 }),
  details: schemaArray(serviceReadinessSchema),
  warnings: schemaOptional(schemaArray(schemaString())),
});

const pullResultSchema = schemaObject({
  services: schemaArray(schemaString()),
  skipped: schemaArray(schemaString()),
  failed: schemaArray(failedOperationSchema),
  pulled: schemaNumber({ integer: true, minimum: 0 }),
});

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

const rebuildResultSchema = schemaObject({
  services: schemaArray(schemaString()),
  failed: schemaArray(failedOperationSchema),
  healthy: schemaArray(schemaString()),
  unhealthy: schemaArray(schemaString()),
  completedPhases: schemaArray(schemaString()),
  rebuilt: schemaNumber({ integer: true, minimum: 0 }),
});

const stopResultSchema = schemaObject({
  services: schemaArray(schemaString()),
  failed: schemaArray(failedOperationSchema),
  stopped: schemaNumber({ integer: true, minimum: 0 }),
});

const deleteResultSchema = schemaObject({
  services: schemaArray(schemaString()),
  failed: schemaArray(failedOperationSchema),
  deleted: schemaNumber({ integer: true, minimum: 0 }),
  volumesRemoved: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  imagesRemoved: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
});

const pruneResultSchema = schemaObject({
  services: schemaArray(schemaString()),
  failed: schemaArray(failedOperationSchema),
  containers: schemaNumber({ integer: true, minimum: 0 }),
  images: schemaNumber({ integer: true, minimum: 0 }),
  imagesSkipped: schemaNumber({ integer: true, minimum: 0 }),
  volumes: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  spaceReclaimed: schemaNumber({ minimum: 0 }),
  completedPhases: schemaArray(schemaString()),
});

const envChangeSchema = schemaObject({
  name: schemaString(),
  current: schemaOptional(schemaString()),
  desired: schemaOptional(schemaString()),
  changeType: schemaEnum(["added", "removed", "modified", "unchanged"] as const),
  isSecret: schemaBoolean(),
});

const portMappingSchema = schemaObject({
  host: schemaOptional(schemaString()),
  container: schemaString(),
  protocol: schemaString(),
});

const volumeMappingSchema = schemaObject({
  source: schemaString(),
  target: schemaString(),
  readonly: schemaOptional(schemaBoolean()),
});

const imageDiffBaseShape = {
  current: schemaOptional(schemaString()),
  desired: schemaOptional(schemaString()),
  changed: schemaBoolean(),
  canonicalImage: schemaOptional(schemaString()),
  platform: schemaOptional(schemaString()),
};

const imageDiffEvidenceShape = {
  localDigest: schemaOptional(schemaString()),
  remoteDigest: schemaOptional(schemaString()),
  updateError: schemaOptional(schemaString()),
  errorCode: schemaOptional(schemaString()),
};

const legacyImageDiffSchema = schemaObject({
  ...imageDiffBaseShape,
  updateAvailable: schemaOptional(schemaBoolean()),
  ...imageDiffEvidenceShape,
});

const imageDiffSchema = schemaUnion([
  legacyImageDiffSchema,
  schemaObject({
    ...imageDiffBaseShape,
    updateStatus: schemaEnum(["update-available"] as const),
    updateAvailable: schemaOptional(schemaEnum([true] as const)),
    localDigest: schemaString(),
    remoteDigest: schemaString(),
    updateError: schemaOptional(schemaString()),
    errorCode: schemaOptional(schemaString()),
  }),
  schemaObject({
    ...imageDiffBaseShape,
    updateStatus: schemaEnum(["up-to-date"] as const),
    updateAvailable: schemaOptional(schemaEnum([false] as const)),
    localDigest: schemaString(),
    remoteDigest: schemaString(),
    updateError: schemaOptional(schemaString()),
    errorCode: schemaOptional(schemaString()),
  }),
  schemaObject({
    ...imageDiffBaseShape,
    updateStatus: schemaEnum(["unsupported"] as const),
    updateAvailable: schemaOptional(schemaEnum([false] as const)),
    ...imageDiffEvidenceShape,
  }),
  schemaObject({
    ...imageDiffBaseShape,
    updateStatus: schemaEnum(["local-missing"] as const),
    updateAvailable: schemaOptional(schemaEnum([false] as const)),
    ...imageDiffEvidenceShape,
  }),
  schemaObject({
    ...imageDiffBaseShape,
    updateStatus: schemaEnum(["unknown"] as const),
    updateAvailable: schemaOptional(schemaEnum([false] as const)),
    localDigest: schemaOptional(schemaString()),
    remoteDigest: schemaOptional(schemaString()),
    updateError: schemaString(),
    errorCode: schemaOptional(schemaString()),
  }),
]);

const serviceChangeSchema = schemaObject({
  service: schemaString(),
  resolvedConfigFingerprint: schemaOptional(schemaString()),
  changeType: schemaEnum(["create", "update", "recreate", "delete", "unchanged"] as const),
  image: imageDiffSchema,
  environment: schemaArray(envChangeSchema),
  ports: schemaObject({
    current: schemaOptional(schemaArray(portMappingSchema)),
    desired: schemaOptional(schemaArray(portMappingSchema)),
    changed: schemaBoolean(),
  }),
  volumes: schemaObject({
    current: schemaOptional(schemaArray(volumeMappingSchema)),
    desired: schemaOptional(schemaArray(volumeMappingSchema)),
    changed: schemaBoolean(),
  }),
  networks: schemaObject({
    current: schemaOptional(schemaArray(schemaString())),
    desired: schemaOptional(schemaArray(schemaString())),
    changed: schemaBoolean(),
  }),
});

const planSummarySchema = schemaObject({
  toCreate: schemaNumber({ integer: true, minimum: 0 }),
  toUpdate: schemaNumber({ integer: true, minimum: 0 }),
  toRecreate: schemaNumber({ integer: true, minimum: 0 }),
  toDelete: schemaNumber({ integer: true, minimum: 0 }),
  unchanged: schemaNumber({ integer: true, minimum: 0 }),
  updatesAvailable: schemaNumber({ integer: true, minimum: 0 }),
  total: schemaNumber({ integer: true, minimum: 0 }),
});

const changeReasonSchema = schemaObject({
  code: schemaEnum(CHANGE_REASON_CODES),
  kind: schemaEnum(["trigger", "provenance", "advisory"] as const),
  confidence: schemaEnum(["confirmed", "inferred"] as const),
  decisive: schemaBoolean(),
  summary: schemaString(),
  evidence: schemaArray(schemaString()),
});

const serviceImpactSchema = schemaObject({
  effect: schemaEnum(["none", "create", "replace"] as const),
  critical: schemaBoolean(),
  dependentCount: schemaNumber({ integer: true, minimum: 0 }),
  dependents: schemaArray(schemaString()),
  dependentsTruncated: schemaBoolean(),
  runningDependentCount: schemaNumber({ integer: true, minimum: 0 }),
  changingDependencies: schemaArray(schemaString()),
});

const planIntelligenceSchema = schemaObject({
  schemaVersion: schemaEnum([PLAN_INTELLIGENCE_SCHEMA_VERSION] as const),
  provenance: schemaUnion([
    schemaObject({
      baseline: schemaEnum(["none"] as const),
      reason: schemaEnum(["no-comparable-plan", "plan-history-unreadable"] as const),
    }),
    schemaObject({
      baseline: schemaEnum(["previous-plan"] as const),
      planId: schemaString(),
      createdAt: schemaString(),
      composeFileChanged: schemaBoolean(),
    }),
  ]),
  registryChecked: schemaBoolean(),
  runtimeStateObserved: schemaBoolean(),
  services: schemaRecord(
    schemaObject({
      reasons: schemaArray(changeReasonSchema),
      impact: serviceImpactSchema,
    }),
  ),
  summary: schemaObject({
    annotatedServices: schemaNumber({ integer: true, minimum: 0 }),
    downstreamImpacted: schemaNumber({ integer: true, minimum: 0 }),
    criticalServices: schemaNumber({ integer: true, minimum: 0 }),
    // Enum, not schemaString(): schemaOptional(schemaString()) infers
    // `string | undefined`, which is not assignable to
    // `ChangeReasonCode | undefined` in the `_typeCheck` anchor below.
    dominantReason: schemaOptional(schemaEnum(CHANGE_REASON_CODES)),
  }),
});

const deploymentPlanSchema = schemaObject({
  intent: schemaOptional(schemaEnum(["deployment", "managed-update"] as const)),
  id: schemaString(),
  createdAt: schemaString(),
  composeHash: schemaString(),
  composePath: schemaString(),
  targetServices: schemaOptional(schemaArray(schemaString())),
  profiles: schemaOptional(schemaArray(schemaString())),
  services: schemaArray(serviceChangeSchema),
  summary: planSummarySchema,
  intelligence: schemaOptional(planIntelligenceSchema),
});

const planResultSchema = schemaObject({
  planPath: schemaString(),
  plan: deploymentPlanSchema,
});

const applyFailureSchema = schemaObject({
  service: schemaString(),
  error: schemaString(),
});

const applyResultSchema = schemaObject({
  planId: schemaString(),
  applied: schemaArray(schemaString()),
  failed: schemaArray(applyFailureSchema),
  total: schemaNumber({ integer: true, minimum: 0 }),
  success: schemaBoolean(),
});

const stateEntrySchema = schemaObject({
  id: schemaNumber({ integer: true, minimum: 0 }),
  timestamp: schemaString(),
  service: schemaString(),
  action: schemaEnum([
    "deploy",
    "rebuild",
    "delete",
    "rollback",
    "apply",
    "prune",
    "update",
    "import",
  ] as const),
  imageTag: schemaOptional(schemaString()),
  imageId: schemaOptional(schemaString()),
  imageDigest: schemaOptional(schemaString()),
  configSnapshot: schemaOptional(schemaString()),
  status: schemaEnum(["success", "failed", "rolled_back"] as const),
  planId: schemaOptional(schemaString()),
  errorMessage: schemaOptional(schemaString()),
});

const historyResultSchema = schemaObject({
  entries: schemaArray(stateEntrySchema),
  totalCount: schemaNumber({ integer: true, minimum: 0 }),
  filters: schemaObject({
    service: schemaOptional(schemaString()),
    action: schemaOptional(
      schemaEnum([
        "deploy",
        "rebuild",
        "delete",
        "rollback",
        "apply",
        "prune",
        "update",
        "import",
      ] as const),
    ),
    since: schemaOptional(schemaString()),
    limit: schemaNumber({ integer: true, minimum: 1 }),
  }),
});

const rollbackResultSchema = schemaObject({
  success: schemaBoolean(),
  service: schemaString(),
  targetDeploymentId: schemaNumber({ integer: true, minimum: 0 }),
  targetGeneration: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  rollbackDeploymentId: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  errorMessage: schemaOptional(schemaString()),
  restoredImageTag: schemaOptional(schemaString()),
  warnings: schemaOptional(
    schemaArray(
      schemaObject({
        code: schemaEnum(["TEMP_OVERRIDE_CLEANUP_FAILED"] as const),
        message: schemaString(),
        temporaryDirectory: schemaString(),
      }),
    ),
  ),
});

const serviceDriftSchema = schemaObject({
  service: schemaString(),
  hasDrift: schemaBoolean(),
  direction: schemaEnum(["compose_ahead", "container_ahead", "diverged"] as const),
  categories: schemaArray(
    schemaEnum(["image", "environment", "ports", "volumes", "networks", "runtime-status"] as const),
  ),
  image: imageDiffSchema,
  environment: schemaArray(envChangeSchema),
  ports: schemaObject({
    current: schemaOptional(schemaArray(portMappingSchema)),
    desired: schemaOptional(schemaArray(portMappingSchema)),
    changed: schemaBoolean(),
  }),
  volumes: schemaObject({
    current: schemaOptional(schemaArray(volumeMappingSchema)),
    desired: schemaOptional(schemaArray(volumeMappingSchema)),
    changed: schemaBoolean(),
  }),
  networks: schemaObject({
    current: schemaOptional(schemaArray(schemaString())),
    desired: schemaOptional(schemaArray(schemaString())),
    changed: schemaBoolean(),
  }),
  runtimeStatus: schemaObject({
    current: schemaObject({
      state: schemaEnum(["running", "exited", "paused", "restarting", "dead", "created"] as const),
      health: schemaEnum(["healthy", "unhealthy", "starting", "none"] as const),
    }),
    desired: schemaObject({
      state: schemaEnum(["running"] as const),
      health: schemaEnum(["healthy", "none"] as const),
    }),
    changed: schemaBoolean(),
  }),
});

const driftResultSchema = schemaObject({
  schemaVersion: schemaString(),
  timestamp: schemaString(),
  composePath: schemaString(),
  services: schemaArray(serviceDriftSchema),
  summary: schemaObject({
    total: schemaNumber({ integer: true, minimum: 0 }),
    drifted: schemaNumber({ integer: true, minimum: 0 }),
    unchanged: schemaNumber({ integer: true, minimum: 0 }),
    directions: schemaObject({
      composeAhead: schemaNumber({ integer: true, minimum: 0 }),
      containerAhead: schemaNumber({ integer: true, minimum: 0 }),
      diverged: schemaNumber({ integer: true, minimum: 0 }),
    }),
  }),
});

const driftShowResultSchema = schemaObject({
  service: schemaString(),
  drift: serviceDriftSchema,
});

const reconcileCategorySchema = schemaEnum([
  "image",
  "environment",
  "ports",
  "volumes",
  "networks",
  "runtime-status",
] as const);

const reconcileReasonSchema = schemaObject({
  code: schemaString(),
  category: schemaOptional(reconcileCategorySchema),
});

const reconcileDriftProjectionSchema = schemaObject({
  hasDrift: schemaBoolean(),
  direction: schemaEnum(["compose_ahead", "container_ahead", "diverged"] as const),
  categories: schemaArray(reconcileCategorySchema),
  image: schemaObject({ changed: schemaBoolean() }),
  environment: schemaArray(
    schemaObject({
      name: schemaString(),
      changeType: schemaEnum(["added", "removed", "modified", "unchanged"] as const),
    }),
  ),
  ports: schemaObject({ changed: schemaBoolean() }),
  volumes: schemaObject({ changed: schemaBoolean() }),
  networks: schemaObject({ changed: schemaBoolean() }),
  runtimeStatus: schemaObject({
    changed: schemaBoolean(),
    currentState: schemaEnum([
      "running",
      "exited",
      "paused",
      "restarting",
      "dead",
      "created",
      "missing",
      "unknown",
    ] as const),
    currentHealth: schemaEnum(["healthy", "unhealthy", "starting", "none", "unknown"] as const),
    desiredState: schemaEnum(["running"] as const),
    desiredHealth: schemaEnum(["healthy", "none"] as const),
  }),
});

const reconcileActionBaseShape = {
  categories: schemaArray(reconcileCategorySchema),
  reasons: schemaArray(reconcileReasonSchema),
};

const reconcileActionSchema = schemaUnion([
  schemaObject({
    kind: schemaEnum(["none"] as const),
    ...reconcileActionBaseShape,
    eligibility: schemaEnum(["not_requested"] as const),
  }),
  schemaObject({
    kind: schemaEnum(["create", "start", "recreate"] as const),
    ...reconcileActionBaseShape,
    eligibility: schemaEnum(["not_requested", "allowed"] as const),
  }),
  schemaObject({
    kind: schemaEnum(["blocked"] as const),
    proposedKind: schemaOptional(schemaEnum(["create", "start", "recreate"] as const)),
    ...reconcileActionBaseShape,
    eligibility: schemaEnum(["blocked"] as const),
  }),
]);

const reconcileAutomationSchema = schemaUnion([
  schemaObject({ status: schemaEnum(["not_requested"] as const) }),
  schemaObject({ status: schemaEnum(["allowed"] as const) }),
  schemaObject({
    status: schemaEnum(["blocked"] as const),
    reasonCode: schemaOptional(schemaString()),
    nextEligibleAt: schemaOptional(schemaString()),
  }),
]);

const reconcileServiceResultSchema = schemaObject({
  service: schemaString(),
  comparison: schemaEnum(["in_sync", "drifted", "observation_failed"] as const),
  drift: reconcileDriftProjectionSchema,
  action: reconcileActionSchema,
  outcome: schemaEnum([
    "reported",
    "no_action",
    "became_in_sync",
    "converged",
    "blocked_policy",
    "blocked_stale",
    "observation_failed",
    "action_failed",
    "not_converged",
    "cancelled_before_action",
    "cancelled_during_action",
    "skipped_after_unsafe_failure",
  ] as const),
  finalDrift: schemaOptional(reconcileDriftProjectionSchema),
});

const reconcileResultSchema = schemaObject({
  schemaVersion: schemaEnum([RECONCILE_SCHEMA_VERSION] as const),
  operation: schemaEnum(["reconcile"] as const),
  mode: schemaEnum(["report", "auto-apply"] as const),
  dryRun: schemaBoolean(),
  status: schemaEnum([
    "reported",
    "planned",
    "converged",
    "partial",
    "failed",
    "cancelled",
  ] as const),
  scope: schemaObject({
    composePath: schemaString(),
    project: schemaString(),
    profiles: schemaArray(schemaString()),
    services: schemaArray(schemaString()),
  }),
  actionFingerprint: schemaString(),
  automation: reconcileAutomationSchema,
  services: schemaArray(reconcileServiceResultSchema),
  summary: schemaObject({
    selected: schemaNumber({ integer: true, minimum: 0 }),
    inSync: schemaNumber({ integer: true, minimum: 0 }),
    drifted: schemaNumber({ integer: true, minimum: 0 }),
    actionable: schemaNumber({ integer: true, minimum: 0 }),
    blocked: schemaNumber({ integer: true, minimum: 0 }),
    converged: schemaNumber({ integer: true, minimum: 0 }),
    failed: schemaNumber({ integer: true, minimum: 0 }),
  }),
  success: schemaBoolean(),
  exitCode: schemaEnum([0, 1, 2, 3] as const),
});

const driftMutationResultSchema = schemaObject(
  {
    success: schemaBoolean(),
    operation: schemaString(),
    services: schemaOptional(schemaArray(schemaString())),
  },
  { allowUnknownProperties: true },
);

const statusInputSchema = schemaObject({
  ...executionArgShape,
  ...statusTargetArgShape,
  ...statusComposeArgShape,
  all: schemaOptional(schemaBoolean()),
  health: schemaOptional(schemaBoolean()),
  stats: schemaOptional(schemaBoolean()),
  logs: schemaOptional(schemaBoolean()),
});

const pullInputSchema = schemaObject({
  ...executionArgShape,
  ...targetArgShape,
  ...composeArgShape,
});

const deployInputSchema = schemaObject({
  ...executionArgShape,
  ...targetArgShape,
  ...composeArgShape,
  skipPull: schemaOptional(schemaBoolean()),
  forceRecreate: schemaOptional(schemaBoolean()),
  parallel: schemaOptional(schemaBoolean()),
  workers: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  waitForReady: schemaOptional(schemaBoolean()),
  healthTimeout: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
});

const rebuildInputSchema = schemaObject({
  ...executionArgShape,
  ...targetArgShape,
  ...composeArgShape,
  skipPull: schemaOptional(schemaBoolean()),
  parallel: schemaOptional(schemaBoolean()),
  workers: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  waitForReady: schemaOptional(schemaBoolean()),
  healthTimeout: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
});

const healthInputSchema = schemaObject({
  ...executionArgShape,
  ...targetArgShape,
  ...composeArgShape,
  waitForReady: schemaOptional(schemaBoolean()),
  healthTimeout: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
});

const deleteInputSchema = schemaObject({
  ...executionArgShape,
  ...targetArgShape,
  ...composeArgShape,
  volumes: schemaOptional(schemaBoolean()),
  images: schemaOptional(schemaBoolean()),
});

const pruneInputSchema = schemaObject({
  ...executionArgShape,
  ...targetArgShape,
  ...composeArgShape,
  volumes: schemaOptional(schemaBoolean()),
  images: schemaOptional(schemaBoolean()),
});

const planInputSchema = schemaObject({
  ...executionArgShape,
  ...targetArgShape,
  ...composeArgShape,
  apply: schemaOptional(schemaBoolean()),
  out: schemaOptional(schemaString()),
  showUnchanged: schemaOptional(schemaBoolean()),
  checkUpdates: schemaOptional(schemaBoolean()),
  explain: schemaOptional(schemaBoolean()),
});

const applyInputSchema = schemaObject({
  ...executionArgShape,
  planFile: schemaString(),
  force: schemaOptional(schemaBoolean()),
});

const historyInputSchema = schemaObject({
  ...executionArgShape,
  service: schemaOptional(schemaString()),
  limit: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  since: schemaOptional(schemaString()),
  action: schemaOptional(
    schemaEnum([
      "deploy",
      "rebuild",
      "delete",
      "rollback",
      "apply",
      "prune",
      "update",
      "import",
    ] as const),
  ),
});

const rollbackInputSchema = schemaObject({
  ...executionArgShape,
  service: schemaString(),
  steps: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  toDeployment: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  toGeneration: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  toTime: schemaOptional(schemaString()),
  force: schemaOptional(schemaBoolean()),
});

const driftDetectInputSchema = schemaObject({
  ...executionArgShape,
  ...targetArgShape,
  ...composeArgShape,
  showUnchanged: schemaOptional(schemaBoolean()),
  reportOnly: schemaOptional(schemaBoolean()),
});

const driftShowInputSchema = schemaObject({
  ...executionArgShape,
  ...composeArgShape,
  service: schemaString(),
  reportOnly: schemaOptional(schemaBoolean()),
});

const driftImportInputSchema = schemaObject({
  ...executionArgShape,
  ...targetArgShape,
  ...composeArgShape,
  backup: schemaOptional(schemaBoolean()),
});

const reconcileInputBaseShape = {
  dryRun: schemaOptional(schemaBoolean()),
  debug: schemaOptional(schemaBoolean()),
  verbose: schemaOptional(schemaBoolean()),
  useDotenvx: schemaOptional(schemaString()),
  useOp: schemaOptional(schemaString()),
  ...targetArgShape,
  service: schemaOptional(schemaString({ maxLength: RECONCILE_MAX_SERVICE_NAME_LENGTH })),
  services: schemaOptional(
    schemaArray(schemaString({ maxLength: RECONCILE_MAX_SERVICE_NAME_LENGTH }), {
      maxItems: RECONCILE_MAX_SERVICES,
    }),
  ),
  ...composeArgShape,
  showUnchanged: schemaOptional(schemaBoolean()),
  healthTimeout: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
};

const reconcileInputSchema = schemaUnion([
  schemaObject({
    ...reconcileInputBaseShape,
    autoApply: schemaOptional(schemaEnum([false] as const)),
    yes: schemaOptional(schemaBoolean()),
  }),
  schemaObject({
    ...reconcileInputBaseShape,
    autoApply: schemaEnum([true] as const),
    yes: schemaEnum([true] as const),
  }),
]);

export interface RfappsMcpToolSchema<TArgs, TResult> {
  input: McpSchema<TArgs>;
  output: McpSchema<TResult>;
}

export const rfappsMcpSchemas = {
  status: {
    input: statusInputSchema,
    output: withDryRun(statusResultSchema),
  },
  health: {
    input: healthInputSchema,
    output: withDryRun(healthResultSchema),
  },
  pull: {
    input: pullInputSchema,
    output: withDryRun(pullResultSchema),
  },
  deploy: {
    input: deployInputSchema,
    output: withDryRun(deployResultSchema),
  },
  rebuild: {
    input: rebuildInputSchema,
    output: withDryRun(rebuildResultSchema),
  },
  stop: {
    input: pullInputSchema,
    output: withDryRun(stopResultSchema),
  },
  delete: {
    input: deleteInputSchema,
    output: withDryRun(deleteResultSchema),
  },
  prune: {
    input: pruneInputSchema,
    output: withDryRun(pruneResultSchema),
  },
  plan: {
    input: planInputSchema,
    output: withDryRun(planResultSchema),
  },
  apply: {
    input: applyInputSchema,
    output: withDryRun(applyResultSchema),
  },
  history: {
    input: historyInputSchema,
    output: historyResultSchema,
  },
  rollback: {
    input: rollbackInputSchema,
    output: withDryRun(rollbackResultSchema),
  },
  driftDetect: {
    input: driftDetectInputSchema,
    output: withDryRun(driftResultSchema),
  },
  driftShow: {
    input: driftShowInputSchema,
    output: withDryRun(driftShowResultSchema),
  },
  driftReconcile: {
    input: reconcileInputSchema,
    output: reconcileResultSchema,
  },
  driftImport: {
    input: driftImportInputSchema,
    output: withDryRun(driftMutationResultSchema),
  },
} as const satisfies {
  status: RfappsMcpToolSchema<StatusToolArgs, StatusResult | { dryRun: boolean }>;
  health: RfappsMcpToolSchema<HealthToolArgs, HealthCommandResult | { dryRun: boolean }>;
  pull: RfappsMcpToolSchema<PullToolArgs, PullResult | { dryRun: boolean }>;
  deploy: RfappsMcpToolSchema<DeployToolArgs, DeployResult | { dryRun: boolean }>;
  rebuild: RfappsMcpToolSchema<RebuildToolArgs, RebuildResult | { dryRun: boolean }>;
  stop: RfappsMcpToolSchema<PullToolArgs, StopResult | { dryRun: boolean }>;
  delete: RfappsMcpToolSchema<DeleteToolArgs, DeleteResult | { dryRun: boolean }>;
  prune: RfappsMcpToolSchema<PruneToolArgs, PruneResult | { dryRun: boolean }>;
  plan: RfappsMcpToolSchema<
    PlanToolArgs,
    { planPath: string; plan: DeploymentPlan } | { dryRun: boolean }
  >;
  apply: RfappsMcpToolSchema<ApplyToolArgs, ApplyResult | { dryRun: boolean }>;
  history: RfappsMcpToolSchema<HistoryToolArgs, HistoryResult>;
  rollback: RfappsMcpToolSchema<RollbackToolArgs, RollbackResult | { dryRun: boolean }>;
  driftDetect: RfappsMcpToolSchema<DriftDetectToolArgs, DriftResult | { dryRun: boolean }>;
  driftShow: RfappsMcpToolSchema<
    DriftShowToolArgs,
    { service: string; drift: ServiceDrift } | { dryRun: boolean }
  >;
  driftReconcile: RfappsMcpToolSchema<ReconcileToolArgs, ReconcileResult>;
  driftImport: RfappsMcpToolSchema<
    DriftImportToolArgs,
    { success: boolean; operation: string; services?: string[] } | { dryRun: boolean }
  >;
};

export const RFAPPS_MCP_TOOL_NAMES = {
  status: "rfapps.status",
  health: "rfapps.health",
  pull: "rfapps.pull",
  deploy: "rfapps.deploy",
  rebuild: "rfapps.rebuild",
  stop: "rfapps.stop",
  delete: "rfapps.delete",
  prune: "rfapps.prune",
  plan: "rfapps.plan",
  apply: "rfapps.apply",
  history: "rfapps.history",
  rollback: "rfapps.rollback",
  driftDetect: "rfapps.drift.detect",
  driftShow: "rfapps.drift.show",
  driftReconcile: "rfapps.drift.reconcile",
  driftImport: "rfapps.drift.import",
} as const;

// Type anchors to ensure schema contracts stay aligned with existing rfapps types.
const _typeCheck: {
  failedOperation: McpSchema<FailedOperation>;
  serviceStatus: McpSchema<ServiceStatus>;
  resourceStats: McpSchema<ResourceStats>;
  healthResult: McpSchema<HealthCommandResult>;
  serviceChange: McpSchema<ServiceChange>;
  planSummary: McpSchema<PlanSummary>;
  planIntelligence: McpSchema<PlanIntelligence>;
  serviceDrift: McpSchema<ServiceDrift>;
  reconcileResult: McpSchema<ReconcileResult>;
  stagedSummary: McpSchema<StagedRolloutSummary>;
} = {
  failedOperation: failedOperationSchema,
  serviceStatus: serviceStatusSchema,
  resourceStats: resourceStatsSchema,
  healthResult: healthResultSchema,
  serviceChange: serviceChangeSchema,
  planSummary: planSummarySchema,
  planIntelligence: planIntelligenceSchema,
  serviceDrift: serviceDriftSchema,
  reconcileResult: reconcileResultSchema,
  stagedSummary: stagedSummarySchema,
};

void _typeCheck;
