import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import type { EnvToolExecConfig } from "../types/options.js";
import type { ImageUpdateStatus, PlanOptions, ServiceChange } from "../types/plan.js";
import type { GenerationEntry, GenerationInput, StateEntryInput } from "../types/state.js";
import {
  MANAGED_UPDATE_PLAN_SCHEMA_VERSION,
  MANAGED_UPDATE_RESULT_SCHEMA_VERSION,
  type ManagedUpdateDockerHealth,
  type ManagedUpdateCleanupFailure,
  type ManagedUpdateDriftEvidence,
  type ManagedUpdateError,
  type ManagedUpdateInterruptionEvidence,
  type ManagedUpdatePlan,
  type ManagedUpdatePlanService,
  type ManagedUpdateResult,
  type ManagedUpdateResultStatus,
  type ManagedUpdateRuntimeState,
  type ManagedUpdateServiceResult,
  type ManagedUpdateStage,
  type ManagedUpdateSummary,
  type ManagedUpdateVerificationEvidence,
  type ManagedUpdateVerificationFailed,
  type ManagedUpdateVerificationPassed,
  type ManagedUpdateRestorePolicy,
} from "../types/update.js";
import type {
  DockerContainerIdentity,
  DockerExecOptions,
  RecreateServiceWithImageInput,
  RecreateServiceWithImageResult,
} from "./docker.js";
import type { ServiceVerificationSummary, ReadinessPollSettings } from "../types/health.js";
import type { AcquireLifecycleLockOptions, LifecycleLock } from "./lifecycle-lock.js";
import { redactManagedMessage } from "./managed-redaction.js";

const MAX_EVIDENCE_LENGTH = 512;
const MAX_DEPENDENCY_EVIDENCE_LENGTH = 192;

type Awaitable<T> = T | Promise<T>;

export interface GenerateManagedUpdatePlanInput {
  composePath: string;
  targetServices: readonly string[];
  profiles?: readonly string[];
  restorePolicy: ManagedUpdateRestorePolicy;
  envTool?: EnvToolExecConfig;
}

export interface RunManagedUpdateOptions {
  healthPoll: ReadinessPollSettings;
  stableRunningSeconds?: number;
  projectDir?: string;
  stateDir?: string;
  envTool?: EnvToolExecConfig;
  dockerOptions?: DockerExecOptions;
}

export interface ManagedUpdateServiceIdentityInput {
  composePath: string;
  projectName: string;
  service: string;
  profiles?: readonly string[];
  envTool?: EnvToolExecConfig;
}

export interface ManagedUpdatePlanDependencies {
  resolveComposeProjectName(
    options: PlanOptions,
    envTool?: EnvToolExecConfig,
  ): Promise<string | undefined>;
  generatePlan(
    options: PlanOptions,
    envTool?: EnvToolExecConfig,
  ): Promise<Awaited<ReturnType<typeof import("./plan-generator.js").generatePlan>>>;
}

export interface ManagedUpdateDockerDependencies {
  getContextFingerprint(): Promise<string>;
  inspectServiceIdentity(
    input: ManagedUpdateServiceIdentityInput,
  ): Promise<DockerContainerIdentity | undefined>;
  recreateServiceWithImage(
    input: RecreateServiceWithImageInput,
    options?: DockerExecOptions,
  ): Promise<RecreateServiceWithImageResult>;
}

export interface ManagedUpdateStateDependencies {
  findRecoveryGeneration(service: string, imageId: string): Awaitable<GenerationEntry | undefined>;
  findGeneration(service: string, generation: number): Awaitable<GenerationEntry | undefined>;
  createGeneration(input: GenerationInput): Awaitable<number>;
  recordDeployment(input: StateEntryInput): Awaitable<number>;
  getGenerationCount(service: string): Awaitable<number>;
  close?(): Awaitable<void>;
}

export interface ManagedUpdateHealthDependencies {
  verifyServiceReadiness(input: {
    composePath: string;
    projectName: string;
    projectDir?: string;
    targetService: string;
    expectedImageId: string;
    profiles?: string[];
    envTool?: EnvToolExecConfig;
    poll: ReadinessPollSettings;
    stableRunningSeconds?: number;
    tcpProbeMode?: "local" | "state-and-health-only";
  }): Promise<ServiceVerificationSummary>;
}

export interface ManagedUpdateClockDependencies {
  now(): Date;
  randomId(): string;
}

export interface ManagedUpdateLockDependencies {
  acquire(options: AcquireLifecycleLockOptions): Promise<LifecycleLock>;
}

export interface ManagedUpdateSignalDependencies {
  getInterruption(): ManagedUpdateInterruptionEvidence["signal"] | undefined;
}

export interface ManagedUpdateFilesystemDependencies {
  hashFile(path: string): Promise<string>;
  cleanup?(): Awaitable<void>;
}

export interface ManagedUpdateDependencies {
  plan: ManagedUpdatePlanDependencies;
  docker: ManagedUpdateDockerDependencies;
  state: ManagedUpdateStateDependencies;
  health: ManagedUpdateHealthDependencies;
  clock: ManagedUpdateClockDependencies;
  lock: ManagedUpdateLockDependencies;
  signal: ManagedUpdateSignalDependencies;
  filesystem: ManagedUpdateFilesystemDependencies;
}

interface RevalidatedService {
  planService: ManagedUpdatePlanService;
  identity?: DockerContainerIdentity;
}

interface ServiceExecution {
  result: ManagedUpdateServiceResult;
  stop: boolean;
  applied: boolean;
  interruption?: ManagedUpdateInterruptionEvidence;
}

function boundedEvidence(value: string): string {
  return redactManagedMessage(value, MAX_EVIDENCE_LENGTH);
}

function validComposeProjectName(value: string | undefined): value is string {
  return value !== undefined && /^[a-z0-9][a-z0-9_-]*$/u.test(value);
}

function errorEvidence(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Unknown runtime error";
}

function dependencyEvidence(dependencies: readonly string[]): string {
  if (dependencies.length === 0) return "none";
  const joined = boundedEvidence(dependencies.join(","));
  return joined.length <= MAX_DEPENDENCY_EVIDENCE_LENGTH
    ? joined
    : `${joined.slice(0, MAX_DEPENDENCY_EVIDENCE_LENGTH - 3)}...`;
}

function lifecycleError(
  stage: ManagedUpdateStage,
  code: string,
  message: string,
): ManagedUpdateError {
  return { kind: "lifecycle", stage, code, message: boundedEvidence(message) };
}

function driftError(drift: ManagedUpdateDriftEvidence): ManagedUpdateError {
  return {
    kind: "drift",
    stage: "validate",
    code: `PLAN_${drift.kind.toUpperCase().replace("-", "_")}_DRIFT`,
    message: boundedEvidence(`Reviewed ${drift.kind} identity changed; generate a new plan`),
    drift,
  };
}

function reviewedIdentity(service: ManagedUpdatePlanService) {
  return {
    configuredImage: service.configuredImage,
    ...(service.platform === undefined ? {} : { platform: service.platform }),
    ...(service.currentImageId === undefined ? {} : { currentImageId: service.currentImageId }),
    ...(service.currentDigest === undefined ? {} : { currentDigest: service.currentDigest }),
    ...(service.proposedDigest === undefined ? {} : { proposedDigest: service.proposedDigest }),
  };
}

function notRun(reasonCode: string): ManagedUpdateVerificationEvidence {
  return { status: "not-run", assurance: "none", reasonCode };
}

function baseResult(
  service: ManagedUpdatePlanService,
  outcome: ManagedUpdateServiceResult["outcome"],
  stage: ManagedUpdateStage,
  durationMs: number,
  error?: ManagedUpdateError,
): ManagedUpdateServiceResult {
  return {
    service: service.service,
    outcome,
    stage,
    reviewedIdentity: reviewedIdentity(service),
    verification: notRun(error?.code ?? "not-applicable"),
    restore: { status: "not-required" },
    generations: {},
    durationMs,
    ...(error === undefined ? {} : { error }),
  };
}

function configuredImage(change: ServiceChange): string {
  return change.image.desired ?? change.image.current ?? "unknown-image";
}

function statusFor(change: ServiceChange): ImageUpdateStatus {
  return change.image.updateStatus ?? "unknown";
}

/** Bind approval to an environment provider/source without persisting its path. */
export function environmentSourceFingerprint(envTool?: EnvToolExecConfig): string {
  const source =
    envTool === undefined ? "none\0<none>" : `${envTool.tool}\0${resolve(envTool.envFile)}`;
  return createHash("sha256").update(source).digest("hex");
}

async function inspectForPlan(
  input: GenerateManagedUpdatePlanInput,
  projectName: string,
  service: string,
  dependencies: ManagedUpdateDependencies,
): Promise<DockerContainerIdentity | undefined> {
  try {
    return await dependencies.docker.inspectServiceIdentity({
      composePath: input.composePath,
      projectName,
      service,
      profiles: input.profiles,
      envTool: input.envTool,
    });
  } catch {
    return undefined;
  }
}

export async function generateManagedUpdatePlan(
  input: GenerateManagedUpdatePlanInput,
  dependencies: ManagedUpdateDependencies,
): Promise<ManagedUpdatePlan> {
  if (input.targetServices.length === 0) {
    throw new Error("Managed update plans require at least one target service");
  }

  const targetServices = [...new Set(input.targetServices)];
  const composeProjectName = await dependencies.plan.resolveComposeProjectName(
    {
      composePath: input.composePath,
      profiles: input.profiles === undefined ? undefined : [...input.profiles],
    },
    input.envTool,
  );
  if (!validComposeProjectName(composeProjectName)) {
    throw new Error("Unable to resolve a valid effective Compose project name");
  }
  const [basePlan, composeHash, dockerContextFingerprint] = await Promise.all([
    dependencies.plan.generatePlan(
      {
        composePath: input.composePath,
        projectName: composeProjectName,
        services: targetServices,
        profiles: input.profiles === undefined ? undefined : [...input.profiles],
        checkUpdates: true,
      },
      input.envTool,
    ),
    dependencies.filesystem.hashFile(input.composePath),
    dependencies.docker.getContextFingerprint(),
  ]);
  if (basePlan === undefined) throw new Error("Unable to generate managed update plan");
  if (composeHash === "") throw new Error("Unable to hash the Compose file");

  const changes = new Map(basePlan.services.map((change) => [change.service, change]));
  const services = await Promise.all(
    targetServices.map(async (service): Promise<ManagedUpdatePlanService> => {
      const change = changes.get(service);
      if (change === undefined)
        throw new Error(`Target service is absent from Compose: ${service}`);
      const identity = await inspectForPlan(input, composeProjectName, service, dependencies);
      const currentImageId = identity?.localImageId;
      const recovery =
        currentImageId === undefined
          ? undefined
          : await dependencies.state.findRecoveryGeneration(service, currentImageId);
      const status = statusFor(change);
      const errorCode =
        change.image.errorCode ?? (status === "unknown" ? "detection-status-missing" : undefined);
      if (change.resolvedConfigFingerprint === undefined) {
        throw new Error(`Resolved Compose fingerprint is unavailable for service: ${service}`);
      }
      return {
        service,
        resolvedConfigFingerprint: change.resolvedConfigFingerprint,
        status,
        configuredImage: configuredImage(change),
        ...((change.image.platform ?? identity?.platform) === undefined
          ? {}
          : { platform: change.image.platform ?? identity?.platform }),
        ...(currentImageId === undefined ? {} : { currentImageId }),
        ...((identity?.repositoryDigest ?? change.image.localDigest) === undefined
          ? {}
          : { currentDigest: identity?.repositoryDigest ?? change.image.localDigest }),
        ...(change.image.remoteDigest === undefined
          ? {}
          : { proposedDigest: change.image.remoteDigest }),
        ...(recovery === undefined ? {} : { recoveryGeneration: recovery.generation }),
        recoveryEligible: currentImageId !== undefined,
        verification: identity?.health === "not-configured" ? "running-only" : "healthcheck",
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(change.image.updateError === undefined
          ? {}
          : { message: boundedEvidence(change.image.updateError) }),
      };
    }),
  );

  return {
    schemaVersion: MANAGED_UPDATE_PLAN_SCHEMA_VERSION,
    intent: "managed-update",
    id: basePlan.id,
    createdAt: basePlan.createdAt,
    composeHash,
    composePath: input.composePath,
    dockerContextFingerprint,
    envSourceFingerprint: environmentSourceFingerprint(input.envTool),
    composeProjectName,
    targetServices,
    ...(input.profiles === undefined ? {} : { profiles: [...input.profiles] }),
    applyPolicy: "sequential",
    restorePolicy: input.restorePolicy,
    services,
  };
}

function nonActionableResult(service: ManagedUpdatePlanService): ManagedUpdateServiceResult {
  switch (service.status) {
    case "up-to-date":
      return baseResult(service, "up_to_date", "complete", 0);
    case "unsupported":
      return baseResult(service, "unsupported", "complete", 0);
    case "unknown":
      return baseResult(
        service,
        "detection_unknown",
        "detect",
        0,
        lifecycleError(
          "detect",
          service.errorCode ?? "DETECTION_UNKNOWN",
          service.message ?? "Update detection was inconclusive",
        ),
      );
    case "local-missing":
      return baseResult(
        service,
        "blocked",
        "validate",
        0,
        lifecycleError(
          "validate",
          service.errorCode ?? "LOCAL_IMAGE_MISSING",
          service.message ?? "The current local image identity is unavailable",
        ),
      );
    case "update-available":
      throw new Error("Actionable services require lifecycle execution");
  }
}

function compareIdentity(
  expected: string | undefined,
  observed: string | undefined,
  kind: ManagedUpdateDriftEvidence["kind"],
): ManagedUpdateDriftEvidence | undefined {
  return expected === observed ? undefined : { kind, expected, observed };
}

async function revalidateService(
  planned: ManagedUpdatePlanService,
  fresh: ServiceChange | undefined,
  plan: ManagedUpdatePlan,
  options: RunManagedUpdateOptions,
  dependencies: ManagedUpdateDependencies,
): Promise<{ value?: RevalidatedService; drift?: ManagedUpdateDriftEvidence }> {
  if (fresh === undefined) return { drift: { kind: "scope", expected: planned.service } };
  const resolvedConfigDrift = compareIdentity(
    planned.resolvedConfigFingerprint,
    fresh.resolvedConfigFingerprint,
    "resolved-config",
  );
  if (resolvedConfigDrift !== undefined) return { drift: resolvedConfigDrift };
  const configuredDrift = compareIdentity(planned.configuredImage, configuredImage(fresh), "scope");
  if (configuredDrift !== undefined) return { drift: configuredDrift };
  const proposedDrift = compareIdentity(
    planned.proposedDigest,
    fresh.image.remoteDigest,
    "proposed-digest",
  );
  if (statusFor(fresh) !== "update-available" || proposedDrift !== undefined) {
    return {
      drift: proposedDrift ?? { kind: "proposed-digest", expected: planned.proposedDigest },
    };
  }

  let identity: DockerContainerIdentity | undefined;
  try {
    identity = await dependencies.docker.inspectServiceIdentity({
      composePath: plan.composePath,
      projectName: plan.composeProjectName,
      service: planned.service,
      profiles: plan.profiles,
      envTool: options.envTool,
    });
  } catch {
    identity = undefined;
  }
  const currentImageDrift = compareIdentity(
    planned.currentImageId,
    identity?.localImageId,
    "current-image",
  );
  if (currentImageDrift !== undefined) return { drift: currentImageDrift };
  const platformDrift = compareIdentity(
    planned.platform,
    fresh.image.platform ?? identity?.platform,
    "platform",
  );
  if (platformDrift !== undefined) return { drift: platformDrift };
  const digestDrift = compareIdentity(
    planned.currentDigest,
    identity?.repositoryDigest ?? fresh.image.localDigest,
    "current-image",
  );
  if (digestDrift !== undefined) return { drift: digestDrift };
  if (planned.recoveryGeneration !== undefined) {
    const generation = await dependencies.state.findGeneration(
      planned.service,
      planned.recoveryGeneration,
    );
    if (generation?.imageId !== planned.currentImageId) {
      return {
        drift: {
          kind: "recovery-generation",
          expected: String(planned.recoveryGeneration),
          observed: generation === undefined ? undefined : String(generation.generation),
        },
      };
    }
  }
  return { value: { planService: planned, identity } };
}

function runtimeState(summary: ServiceVerificationSummary): ManagedUpdateRuntimeState {
  const state = summary.target.state;
  return state === "running" || state === "restarting" || state === "exited" || state === "missing"
    ? state
    : "unknown";
}

function dockerHealth(summary: ServiceVerificationSummary): ManagedUpdateDockerHealth {
  return summary.target.health === "none" ? "not-configured" : summary.target.health;
}

function verificationEvidence(
  summary: ServiceVerificationSummary,
  stage: "verify_update" | "verify_restore",
): ManagedUpdateVerificationPassed | ManagedUpdateVerificationFailed {
  if (summary.ready) {
    return {
      status: "passed",
      assurance: summary.assurance,
      expectedImageId: summary.expectedImageId,
      observedImageId: summary.target.imageId ?? summary.expectedImageId,
      runtimeState: "running",
      dockerHealth: summary.target.health === "none" ? "not-configured" : "healthy",
      dependenciesReady: true,
      elapsedMs: summary.elapsedMs,
    };
  }
  const dependenciesNotReady = summary.target.reason === "ready" && !summary.dependencies.ready;
  const verificationCode = dependenciesNotReady
    ? "VERIFY_DEPENDENCIES_NOT_READY"
    : `VERIFY_${summary.target.reason.toUpperCase().replaceAll("-", "_")}`;
  const verificationMessage = dependenciesNotReady
    ? `Dependency verification failed: failed=${dependencyEvidence(summary.dependencies.failedDependencies)}; pending=${dependencyEvidence(summary.dependencies.pendingDependencies)}`
    : `Service verification failed: ${summary.target.reason}`;
  return {
    status: "failed",
    assurance: summary.assurance,
    expectedImageId: summary.expectedImageId,
    ...(summary.target.imageId === undefined ? {} : { observedImageId: summary.target.imageId }),
    runtimeState: runtimeState(summary),
    dockerHealth: dockerHealth(summary),
    dependenciesReady: summary.dependencies.ready,
    elapsedMs: summary.elapsedMs,
    error: lifecycleError(stage, verificationCode, verificationMessage),
  };
}

async function verify(
  plan: ManagedUpdatePlan,
  service: string,
  imageId: string,
  options: RunManagedUpdateOptions,
  dependencies: ManagedUpdateDependencies,
  stage: "verify_update" | "verify_restore",
): Promise<ManagedUpdateVerificationPassed | ManagedUpdateVerificationFailed> {
  try {
    const summary = await dependencies.health.verifyServiceReadiness({
      composePath: plan.composePath,
      projectName: plan.composeProjectName,
      projectDir: options.projectDir,
      targetService: service,
      expectedImageId: imageId,
      profiles: plan.profiles,
      envTool: options.envTool,
      poll: options.healthPoll,
      stableRunningSeconds: options.stableRunningSeconds,
      tcpProbeMode: "state-and-health-only",
    });
    return verificationEvidence(summary, stage);
  } catch (error) {
    const code =
      stage === "verify_update" ? "UPDATE_VERIFICATION_ERROR" : "RESTORE_VERIFICATION_ERROR";
    return {
      status: "failed",
      assurance:
        plan.services.find((planned) => planned.service === service)?.verification ??
        "running-only",
      expectedImageId: imageId,
      runtimeState: "unknown",
      dockerHealth: "unknown",
      dependenciesReady: false,
      elapsedMs: 0,
      error: lifecycleError(
        stage,
        code,
        `Service verification could not complete: ${errorEvidence(error)}`,
      ),
    };
  }
}

async function recordAttempt(
  dependencies: ManagedUpdateDependencies,
  input: StateEntryInput,
): Promise<number | undefined> {
  try {
    await dependencies.state.recordDeployment(input);
    return await dependencies.state.getGenerationCount(input.service);
  } catch {
    return undefined;
  }
}

function stateEntry(
  plan: ManagedUpdatePlan,
  service: ManagedUpdatePlanService,
  timestamp: string,
  status: StateEntryInput["status"],
  imageId: string | undefined,
  imageDigest: string | undefined,
  errorMessage?: string,
  action: StateEntryInput["action"] = "update",
): StateEntryInput {
  return {
    timestamp,
    service: service.service,
    action,
    imageTag: service.configuredImage,
    ...(imageId === undefined ? {} : { imageId }),
    ...(imageDigest === undefined ? {} : { imageDigest }),
    status,
    planId: plan.id,
    ...(errorMessage === undefined ? {} : { errorMessage: boundedEvidence(errorMessage) }),
  };
}

async function recoverService(
  plan: ManagedUpdatePlan,
  service: ManagedUpdatePlanService,
  recoveryGeneration: number,
  updateVerification: ManagedUpdateVerificationEvidence,
  options: RunManagedUpdateOptions,
  dependencies: ManagedUpdateDependencies,
  startedMs: number,
  interruptionSignal?: ManagedUpdateInterruptionEvidence["signal"],
): Promise<ServiceExecution> {
  const imageId = service.currentImageId;
  if (imageId === undefined) {
    const error = lifecycleError(
      "restore",
      "RECOVERY_IMAGE_UNAVAILABLE",
      "Exact recovery image identity is unavailable",
    );
    return {
      result: {
        ...baseResult(
          service,
          interruptionSignal === undefined ? "restore_failed" : "interrupted",
          interruptionSignal === undefined ? "restore" : "interrupted",
          dependencies.clock.now().getTime() - startedMs,
          error,
        ),
        verification: updateVerification,
        restore: { status: "unavailable", reasonCode: error.code, message: error.message },
        generations: { before: recoveryGeneration },
      },
      stop: true,
      applied: true,
      ...(interruptionSignal === undefined
        ? {}
        : {
            interruption: {
              signal: interruptionSignal,
              stage: "restore",
              service: service.service,
              stabilized: false,
            },
          }),
    };
  }
  const restoreStarted = dependencies.clock.now().getTime();
  let recreate: RecreateServiceWithImageResult | undefined;
  let recreateException: ManagedUpdateError | undefined;
  try {
    recreate = await dependencies.docker.recreateServiceWithImage(
      {
        composePaths: [plan.composePath],
        projectName: plan.composeProjectName,
        service: service.service,
        profiles: plan.profiles,
        source: {
          kind: "local-image-id",
          configuredImage: service.configuredImage,
          localImageId: imageId,
          ...(service.platform === undefined ? {} : { platform: service.platform }),
        },
      },
      options.dockerOptions,
    );
  } catch (error) {
    recreateException = lifecycleError(
      "restore",
      "RESTORE_RECREATE_EXCEPTION",
      `Exact-image restore recreation could not complete: ${errorEvidence(error)}`,
    );
  }
  if (recreate !== undefined && !recreate.success) {
    const error = lifecycleError(
      "restore",
      "RESTORE_RECREATE_FAILED",
      "Exact-image restore recreation failed",
    );
    await recordAttempt(
      dependencies,
      stateEntry(
        plan,
        service,
        dependencies.clock.now().toISOString(),
        "failed",
        imageId,
        service.currentDigest,
        error.message,
        "rollback",
      ),
    );
    return {
      result: {
        ...baseResult(
          service,
          interruptionSignal === undefined ? "restore_failed" : "interrupted",
          interruptionSignal === undefined ? "restore" : "interrupted",
          dependencies.clock.now().getTime() - startedMs,
          error,
        ),
        verification: updateVerification,
        restore: {
          status: "failed",
          imageId,
          generation: recoveryGeneration,
          elapsedMs: dependencies.clock.now().getTime() - restoreStarted,
          error,
        },
        generations: { before: recoveryGeneration },
      },
      stop: true,
      applied: true,
      ...(interruptionSignal === undefined
        ? {}
        : {
            interruption: {
              signal: interruptionSignal,
              stage: "restore",
              service: service.service,
              stabilized: false,
            },
          }),
    };
  }
  const restoreVerification = await verify(
    plan,
    service.service,
    imageId,
    options,
    dependencies,
    "verify_restore",
  );
  if (restoreVerification.status === "failed") {
    const restoreError = recreateException ?? restoreVerification.error;
    await recordAttempt(
      dependencies,
      stateEntry(
        plan,
        service,
        dependencies.clock.now().toISOString(),
        "failed",
        imageId,
        service.currentDigest,
        restoreError.message,
        "rollback",
      ),
    );
    return {
      result: {
        ...baseResult(
          service,
          interruptionSignal === undefined ? "restore_failed" : "interrupted",
          interruptionSignal === undefined ? "verify_restore" : "interrupted",
          dependencies.clock.now().getTime() - startedMs,
          restoreError,
        ),
        verification: updateVerification,
        restore: {
          status: "failed",
          imageId,
          generation: recoveryGeneration,
          verification: restoreVerification,
          elapsedMs: dependencies.clock.now().getTime() - restoreStarted,
          error: restoreError,
        },
        generations: { before: recoveryGeneration },
      },
      stop: true,
      applied: true,
      ...(interruptionSignal === undefined
        ? {}
        : {
            interruption: {
              signal: interruptionSignal,
              stage: "verify_restore",
              service: service.service,
              stabilized: false,
            },
          }),
    };
  }
  const restoredGeneration = await recordAttempt(
    dependencies,
    stateEntry(
      plan,
      service,
      dependencies.clock.now().toISOString(),
      "success",
      imageId,
      service.currentDigest,
      undefined,
      "rollback",
    ),
  );
  if (restoredGeneration === undefined) {
    const error = lifecycleError(
      "record",
      "RESTORE_RECORD_FAILED",
      "Verified restore state could not be recorded",
    );
    return {
      result: {
        ...baseResult(
          service,
          interruptionSignal === undefined ? "restore_failed" : "interrupted",
          interruptionSignal === undefined ? "record" : "interrupted",
          dependencies.clock.now().getTime() - startedMs,
          error,
        ),
        verification: updateVerification,
        restore: {
          status: "failed",
          imageId,
          generation: recoveryGeneration,
          elapsedMs: dependencies.clock.now().getTime() - restoreStarted,
          error,
        },
        generations: { before: recoveryGeneration },
      },
      stop: true,
      applied: true,
      ...(interruptionSignal === undefined
        ? {}
        : {
            interruption: {
              signal: interruptionSignal,
              stage: "record",
              service: service.service,
              stabilized: true,
            },
          }),
    };
  }
  return {
    result: {
      service: service.service,
      outcome: interruptionSignal === undefined ? "restored" : "interrupted",
      stage: interruptionSignal === undefined ? "complete" : "interrupted",
      reviewedIdentity: reviewedIdentity(service),
      observedIdentity: {
        configuredImage: service.configuredImage,
        imageId,
        ...(service.currentDigest === undefined ? {} : { digest: service.currentDigest }),
        ...(service.platform === undefined ? {} : { platform: service.platform }),
      },
      verification: updateVerification,
      restore: {
        status: "succeeded",
        imageId,
        generation: restoredGeneration,
        verification: restoreVerification,
        elapsedMs: dependencies.clock.now().getTime() - restoreStarted,
      },
      generations: { before: recoveryGeneration, restored: restoredGeneration },
      durationMs: dependencies.clock.now().getTime() - startedMs,
    },
    stop: interruptionSignal !== undefined,
    applied: true,
    ...(interruptionSignal === undefined
      ? {}
      : {
          interruption: {
            signal: interruptionSignal,
            stage: "verify_restore",
            service: service.service,
            stabilized: true,
          },
        }),
  };
}

async function executeService(
  plan: ManagedUpdatePlan,
  current: RevalidatedService,
  options: RunManagedUpdateOptions,
  dependencies: ManagedUpdateDependencies,
): Promise<ServiceExecution> {
  const service = current.planService;
  const startedMs = dependencies.clock.now().getTime();
  let recoveryGeneration: number;
  try {
    recoveryGeneration = await dependencies.state.createGeneration({
      service: service.service,
      timestamp: dependencies.clock.now().toISOString(),
      imageTag: service.configuredImage,
      imageId: service.currentImageId,
      imageDigest: service.currentDigest,
      createdByAction: "update",
    });
  } catch {
    const error = lifecycleError(
      "snapshot",
      "RECOVERY_SNAPSHOT_WRITE_FAILED",
      "Pre-update recovery identity could not be recorded",
    );
    return {
      result: baseResult(
        service,
        "update_failed",
        "snapshot",
        dependencies.clock.now().getTime() - startedMs,
        error,
      ),
      stop: true,
      applied: false,
    };
  }

  const beforePullSignal = dependencies.signal.getInterruption();
  if (beforePullSignal !== undefined) {
    return {
      result: {
        ...baseResult(
          service,
          "interrupted",
          "interrupted",
          dependencies.clock.now().getTime() - startedMs,
          lifecycleError(
            "interrupted",
            "INTERRUPTED",
            "Managed update was interrupted before mutation",
          ),
        ),
        generations: { before: recoveryGeneration },
      },
      stop: true,
      applied: false,
      interruption: {
        signal: beforePullSignal,
        stage: "snapshot",
        service: service.service,
        stabilized: true,
      },
    };
  }

  let recreate: RecreateServiceWithImageResult;
  try {
    recreate = await dependencies.docker.recreateServiceWithImage(
      {
        composePaths: [plan.composePath],
        projectName: plan.composeProjectName,
        service: service.service,
        profiles: plan.profiles,
        source: {
          kind: "repository-digest",
          configuredImage: service.configuredImage,
          repositoryDigest: service.proposedDigest ?? "",
          ...(service.platform === undefined ? {} : { platform: service.platform }),
        },
      },
      options.dockerOptions,
    );
  } catch (caught) {
    const error = lifecycleError(
      "recreate",
      "UPDATE_RECREATE_EXCEPTION",
      `Service recreation could not complete; mutation state is uncertain: ${errorEvidence(caught)}`,
    );
    await recordAttempt(
      dependencies,
      stateEntry(
        plan,
        service,
        dependencies.clock.now().toISOString(),
        "failed",
        undefined,
        service.proposedDigest,
        error.message,
      ),
    );
    if (plan.restorePolicy === "restore-on-failure") {
      return recoverService(
        plan,
        service,
        recoveryGeneration,
        notRun(error.code),
        options,
        dependencies,
        startedMs,
        dependencies.signal.getInterruption(),
      );
    }
    return {
      result: {
        ...baseResult(
          service,
          "update_failed",
          "recreate",
          dependencies.clock.now().getTime() - startedMs,
          error,
        ),
        restore: { status: "disabled", reasonCode: "restore-disabled" },
        generations: { before: recoveryGeneration },
      },
      stop: true,
      applied: true,
    };
  }
  if (!recreate.success && recreate.stage === "pull") {
    const error = lifecycleError(
      "pull",
      "UPDATE_PULL_FAILED",
      "Pulling the reviewed image digest failed",
    );
    const recorded = await recordAttempt(
      dependencies,
      stateEntry(
        plan,
        service,
        dependencies.clock.now().toISOString(),
        "failed",
        service.currentImageId,
        service.currentDigest,
        error.message,
      ),
    );
    return {
      result: {
        ...baseResult(
          service,
          "update_failed",
          "pull",
          dependencies.clock.now().getTime() - startedMs,
          recorded === undefined
            ? lifecycleError(
                "record",
                "UPDATE_RECORD_FAILED",
                "Update failure could not be recorded",
              )
            : error,
        ),
        generations: { before: recoveryGeneration },
      },
      stop: recorded === undefined,
      applied: true,
    };
  }

  const mutationSignal = dependencies.signal.getInterruption();
  if (!recreate.success) {
    const error = lifecycleError(
      "recreate",
      "UPDATE_RECREATE_FAILED",
      "Recreating the service with the reviewed image failed",
    );
    await recordAttempt(
      dependencies,
      stateEntry(
        plan,
        service,
        dependencies.clock.now().toISOString(),
        "failed",
        undefined,
        service.proposedDigest,
        error.message,
      ),
    );
    if (plan.restorePolicy === "restore-on-failure") {
      return recoverService(
        plan,
        service,
        recoveryGeneration,
        notRun(error.code),
        options,
        dependencies,
        startedMs,
        mutationSignal,
      );
    }
    return {
      result: {
        ...baseResult(
          service,
          mutationSignal === undefined ? "update_failed" : "interrupted",
          mutationSignal === undefined ? "recreate" : "interrupted",
          dependencies.clock.now().getTime() - startedMs,
          error,
        ),
        restore: { status: "disabled", reasonCode: "restore-disabled" },
        generations: { before: recoveryGeneration },
      },
      stop: true,
      applied: true,
      ...(mutationSignal === undefined
        ? {}
        : {
            interruption: {
              signal: mutationSignal,
              stage: "recreate",
              service: service.service,
              stabilized: false,
            },
          }),
    };
  }

  const newImageId = recreate.identity.localImageId;
  if (mutationSignal !== undefined && plan.restorePolicy === "restore-on-failure") {
    return recoverService(
      plan,
      service,
      recoveryGeneration,
      notRun("interrupted-before-verification"),
      options,
      dependencies,
      startedMs,
      mutationSignal,
    );
  }
  const updateVerification = await verify(
    plan,
    service.service,
    newImageId,
    options,
    dependencies,
    "verify_update",
  );
  const verifySignal = dependencies.signal.getInterruption();
  if (updateVerification.status === "failed" || verifySignal !== undefined) {
    const error =
      updateVerification.status === "failed"
        ? updateVerification.error
        : lifecycleError(
            "interrupted",
            "INTERRUPTED",
            "Managed update was interrupted during verification",
          );
    await recordAttempt(
      dependencies,
      stateEntry(
        plan,
        service,
        dependencies.clock.now().toISOString(),
        "failed",
        newImageId,
        service.proposedDigest,
        error.message,
      ),
    );
    if (plan.restorePolicy === "restore-on-failure") {
      return recoverService(
        plan,
        service,
        recoveryGeneration,
        updateVerification,
        options,
        dependencies,
        startedMs,
        verifySignal,
      );
    }
    return {
      result: {
        service: service.service,
        outcome: verifySignal === undefined ? "update_failed" : "interrupted",
        stage: verifySignal === undefined ? "verify_update" : "interrupted",
        reviewedIdentity: reviewedIdentity(service),
        observedIdentity: {
          configuredImage: service.configuredImage,
          imageId: newImageId,
          ...(service.proposedDigest === undefined ? {} : { digest: service.proposedDigest }),
          ...(service.platform === undefined ? {} : { platform: service.platform }),
        },
        verification: updateVerification,
        restore: { status: "disabled", reasonCode: "restore-disabled" },
        generations: { before: recoveryGeneration },
        durationMs: dependencies.clock.now().getTime() - startedMs,
        error,
      },
      stop: true,
      applied: true,
      ...(verifySignal === undefined
        ? {}
        : {
            interruption: {
              signal: verifySignal,
              stage: "verify_update",
              service: service.service,
              stabilized: false,
            },
          }),
    };
  }

  const afterGeneration = await recordAttempt(
    dependencies,
    stateEntry(
      plan,
      service,
      dependencies.clock.now().toISOString(),
      "success",
      newImageId,
      service.proposedDigest,
    ),
  );
  if (afterGeneration === undefined) {
    const error = lifecycleError(
      "record",
      "UPDATE_RECORD_FAILED",
      "Verified update state could not be recorded",
    );
    if (plan.restorePolicy === "restore-on-failure") {
      return recoverService(
        plan,
        service,
        recoveryGeneration,
        updateVerification,
        options,
        dependencies,
        startedMs,
      );
    }
    return {
      result: {
        ...baseResult(
          service,
          "update_failed",
          "record",
          dependencies.clock.now().getTime() - startedMs,
          error,
        ),
        verification: updateVerification,
        restore: { status: "disabled", reasonCode: "restore-disabled" },
        generations: { before: recoveryGeneration },
      },
      stop: true,
      applied: true,
    };
  }
  return {
    result: {
      service: service.service,
      outcome: "updated",
      stage: "complete",
      reviewedIdentity: reviewedIdentity(service),
      observedIdentity: {
        configuredImage: service.configuredImage,
        imageId: newImageId,
        ...(service.proposedDigest === undefined ? {} : { digest: service.proposedDigest }),
        ...(recreate.identity.platform === undefined
          ? {}
          : { platform: recreate.identity.platform }),
      },
      verification: updateVerification,
      restore: { status: "not-required" },
      generations: { before: recoveryGeneration, after: afterGeneration },
      durationMs: dependencies.clock.now().getTime() - startedMs,
    },
    stop: false,
    applied: true,
  };
}

function summarize(
  plan: ManagedUpdatePlan,
  services: readonly ManagedUpdateServiceResult[],
): ManagedUpdateSummary {
  return {
    selected: services.length,
    actionable: plan.services.filter((service) => service.status === "update-available").length,
    updated: services.filter((service) => service.outcome === "updated").length,
    restored: services.filter((service) => service.outcome === "restored").length,
    upToDate: services.filter((service) => service.outcome === "up_to_date").length,
    unsupported: services.filter((service) => service.outcome === "unsupported").length,
    unknown: services.filter((service) => service.outcome === "detection_unknown").length,
    blocked: services.filter((service) => service.outcome === "blocked").length,
    failed: services.filter(
      (service) => service.outcome === "update_failed" || service.outcome === "restore_failed",
    ).length,
    interrupted: services.filter((service) => service.outcome === "interrupted").length,
  };
}

export function aggregateManagedUpdateStatus(
  summary: ManagedUpdateSummary,
  applied: boolean,
): { status: ManagedUpdateResultStatus; success: boolean; exitCode: 0 | 1 } {
  if (summary.interrupted > 0) return { status: "interrupted", success: false, exitCode: 1 };
  if (summary.restored > 0 && summary.failed === 0)
    return { status: "recovered_failure", success: false, exitCode: 1 };
  const incomplete = summary.unknown + summary.blocked + summary.failed > 0;
  if (!applied && summary.actionable === 0) {
    return incomplete
      ? { status: "partial", success: false, exitCode: 1 }
      : { status: "no_updates", success: true, exitCode: 0 };
  }
  if (incomplete) {
    return summary.updated > 0
      ? { status: "partial", success: false, exitCode: 1 }
      : { status: "failed", success: false, exitCode: 1 };
  }
  return { status: "succeeded", success: true, exitCode: 0 };
}

async function cleanup(
  dependencies: ManagedUpdateDependencies,
  lock?: LifecycleLock,
): Promise<ManagedUpdateCleanupFailure[]> {
  const operations: Array<{
    operation: ManagedUpdateCleanupFailure["operation"];
    run: () => Awaitable<void>;
  }> = [];
  if (lock !== undefined) operations.push({ operation: "lock-release", run: () => lock.release() });
  if (dependencies.state.close !== undefined) {
    operations.push({ operation: "state-close", run: () => dependencies.state.close?.() });
  }
  if (dependencies.filesystem.cleanup !== undefined) {
    operations.push({
      operation: "filesystem-cleanup",
      run: () => dependencies.filesystem.cleanup?.(),
    });
  }
  const settled = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation.run)),
  );
  return settled.flatMap((result, index): ManagedUpdateCleanupFailure[] => {
    if (result.status === "fulfilled") return [];
    const operation = operations[index]?.operation;
    if (operation === undefined) return [];
    return [
      {
        operation,
        code: "CLEANUP_FAILED",
        message: boundedEvidence(`Cleanup operation failed: ${errorEvidence(result.reason)}`),
      },
    ];
  });
}

export async function runManagedUpdate(
  plan: ManagedUpdatePlan,
  options: RunManagedUpdateOptions,
  dependencies: ManagedUpdateDependencies,
): Promise<ManagedUpdateResult> {
  const startedAt = dependencies.clock.now();
  const runId = dependencies.clock.randomId();
  const results = new Map<string, ManagedUpdateServiceResult>();
  const actionable = plan.services.filter((service) => service.status === "update-available");
  for (const service of plan.services) {
    if (service.status !== "update-available")
      results.set(service.service, nonActionableResult(service));
  }

  let lock: LifecycleLock | undefined;
  let applied = false;
  let interruption: ManagedUpdateInterruptionEvidence | undefined;
  let completedResult: ManagedUpdateResult | undefined;
  try {
    const earlySignal = dependencies.signal.getInterruption();
    if (earlySignal !== undefined) {
      for (const service of actionable) {
        results.set(
          service.service,
          baseResult(
            service,
            "interrupted",
            "interrupted",
            0,
            lifecycleError(
              "interrupted",
              "INTERRUPTED",
              "Managed update was interrupted before apply",
            ),
          ),
        );
      }
      interruption = { signal: earlySignal, stage: "validate", stabilized: true };
    } else if (actionable.length > 0) {
      lock = await dependencies.lock.acquire({
        projectPath: options.projectDir ?? dirname(plan.composePath),
        dockerContext: plan.dockerContextFingerprint,
        composeProjectName: plan.composeProjectName,
        stateDir: options.stateDir,
      });
      const [composeHash, contextFingerprint, effectiveProjectName, freshPlan] = await Promise.all([
        dependencies.filesystem.hashFile(plan.composePath),
        dependencies.docker.getContextFingerprint(),
        dependencies.plan.resolveComposeProjectName(
          {
            composePath: plan.composePath,
            profiles: plan.profiles,
          },
          options.envTool,
        ),
        dependencies.plan.generatePlan(
          {
            composePath: plan.composePath,
            projectName: plan.composeProjectName,
            services: [...plan.targetServices],
            profiles: plan.profiles,
            checkUpdates: true,
          },
          options.envTool,
        ),
      ]);
      let globalDrift: ManagedUpdateDriftEvidence | undefined;
      if (composeHash !== plan.composeHash)
        globalDrift = { kind: "compose", expected: plan.composeHash, observed: composeHash };
      else if (effectiveProjectName !== plan.composeProjectName)
        globalDrift = {
          kind: "compose-project",
          expected: plan.composeProjectName,
          observed: effectiveProjectName,
        };
      else if (contextFingerprint !== plan.dockerContextFingerprint)
        globalDrift = {
          kind: "docker-context",
          expected: plan.dockerContextFingerprint,
          observed: contextFingerprint,
        };
      else if (environmentSourceFingerprint(options.envTool) !== plan.envSourceFingerprint)
        globalDrift = {
          kind: "env-source",
          expected: plan.envSourceFingerprint,
          observed: environmentSourceFingerprint(options.envTool),
        };
      else if (freshPlan === undefined)
        globalDrift = { kind: "scope", expected: plan.targetServices.join(",") };
      else {
        const freshScope = freshPlan.services
          .map((service) => service.service)
          .sort()
          .join(",");
        const expectedScope = [...plan.targetServices].sort().join(",");
        if (freshScope !== expectedScope)
          globalDrift = { kind: "scope", expected: expectedScope, observed: freshScope };
        else {
          const freshByService = new Map(
            freshPlan.services.map((service) => [service.service, service]),
          );
          const changedConfig = plan.services.find(
            (service) =>
              freshByService.get(service.service)?.resolvedConfigFingerprint !==
              service.resolvedConfigFingerprint,
          );
          if (changedConfig !== undefined) {
            globalDrift = {
              kind: "resolved-config",
              expected: changedConfig.resolvedConfigFingerprint,
              observed: freshByService.get(changedConfig.service)?.resolvedConfigFingerprint,
            };
          }
        }
      }

      const missingRecovery =
        plan.restorePolicy === "restore-on-failure"
          ? actionable.filter(
              (service) => service.currentImageId === undefined || !service.recoveryEligible,
            )
          : [];
      if (globalDrift !== undefined || missingRecovery.length > 0) {
        for (const service of actionable) {
          if (results.has(service.service)) continue;
          const error =
            globalDrift === undefined
              ? lifecycleError(
                  "validate",
                  "RECOVERY_IMAGE_REQUIRED",
                  "Exact daemon-local recovery image ID is required before mutation",
                )
              : driftError(globalDrift);
          results.set(service.service, baseResult(service, "blocked", "validate", 0, error));
        }
      } else {
        let stopped = false;
        for (const service of actionable) {
          if (stopped) {
            results.set(
              service.service,
              baseResult(
                service,
                interruption === undefined ? "blocked" : "interrupted",
                interruption === undefined ? "validate" : "interrupted",
                0,
                lifecycleError(
                  interruption === undefined ? "validate" : "interrupted",
                  interruption === undefined ? "LIFECYCLE_STOPPED" : "INTERRUPTED",
                  interruption === undefined
                    ? "A prior service could not be stabilized"
                    : "Managed update was interrupted",
                ),
              ),
            );
            continue;
          }
          let validation: Awaited<ReturnType<typeof revalidateService>>;
          try {
            const [effectiveProjectName, immediatePlan] = await Promise.all([
              dependencies.plan.resolveComposeProjectName(
                { composePath: plan.composePath, profiles: plan.profiles },
                options.envTool,
              ),
              dependencies.plan.generatePlan(
                {
                  composePath: plan.composePath,
                  projectName: plan.composeProjectName,
                  services: [service.service],
                  profiles: plan.profiles,
                  checkUpdates: true,
                },
                options.envTool,
              ),
            ]);
            validation =
              effectiveProjectName === plan.composeProjectName
                ? await revalidateService(
                    service,
                    immediatePlan?.services.find((change) => change.service === service.service),
                    plan,
                    options,
                    dependencies,
                  )
                : {
                    drift: {
                      kind: "compose-project",
                      expected: plan.composeProjectName,
                      observed: effectiveProjectName,
                    },
                  };
          } catch (error) {
            results.set(
              service.service,
              baseResult(
                service,
                "blocked",
                "validate",
                0,
                lifecycleError(
                  "validate",
                  "REVALIDATION_FAILED",
                  `Service identity could not be revalidated: ${errorEvidence(error)}`,
                ),
              ),
            );
            stopped = true;
            continue;
          }
          if (validation.drift !== undefined) {
            results.set(
              service.service,
              baseResult(service, "blocked", "validate", 0, driftError(validation.drift)),
            );
            stopped = true;
            continue;
          }
          if (validation.value === undefined) {
            results.set(
              service.service,
              baseResult(
                service,
                "blocked",
                "validate",
                0,
                lifecycleError(
                  "validate",
                  "REVALIDATION_FAILED",
                  "Service identity could not be revalidated",
                ),
              ),
            );
            stopped = true;
            continue;
          }
          const execution = await executeService(plan, validation.value, options, dependencies);
          results.set(service.service, execution.result);
          applied ||= execution.applied;
          stopped = execution.stop;
          interruption = execution.interruption ?? interruption;
          const betweenSignal = dependencies.signal.getInterruption();
          if (betweenSignal !== undefined && interruption === undefined) {
            interruption = {
              signal: betweenSignal,
              stage: "complete",
              service: service.service,
              stabilized: true,
            };
            stopped = true;
          }
        }
      }
    }

    const ordered = plan.services.map((service) => {
      const result = results.get(service.service);
      if (result === undefined)
        throw new Error(`Missing managed update result for ${service.service}`);
      return result;
    });
    const summary = summarize(plan, ordered);
    const aggregate = aggregateManagedUpdateStatus(summary, applied);
    completedResult = {
      schemaVersion: MANAGED_UPDATE_RESULT_SCHEMA_VERSION,
      runId,
      planId: plan.id,
      startedAt: startedAt.toISOString(),
      completedAt: dependencies.clock.now().toISOString(),
      status: aggregate.status,
      success: aggregate.success,
      exitCode: aggregate.exitCode,
      applied,
      restoreOnFailure: plan.restorePolicy === "restore-on-failure",
      summary,
      services: ordered,
      ...(interruption === undefined ? {} : { interruption }),
    };
    return completedResult;
  } finally {
    const cleanupFailures = await cleanup(dependencies, lock);
    if (completedResult !== undefined && cleanupFailures.length > 0) {
      completedResult.cleanupFailures = cleanupFailures;
      if (completedResult.success) {
        completedResult.status = completedResult.applied ? "partial" : "failed";
        completedResult.success = false;
        completedResult.exitCode = 1;
      }
    }
  }
}
