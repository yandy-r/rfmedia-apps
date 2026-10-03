import { join } from "node:path";

import {
  BACKUP_HELPER_IMAGE_REFERENCE,
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BACKUP_RESULT_SCHEMA_VERSION,
  type BackupArchivedArtifactOutcome,
  type BackupArtifactOutcome,
  type BackupError,
  type BackupFailedArtifactOutcome,
  type BackupManifest,
  type BackupManifestMount,
  type BackupPlan,
  type BackupPlannedArtifactOutcome,
  type BackupPlannedMount,
  type BackupRecoveryFailure,
  type BackupResult,
  type BackupSummary,
} from "../types/backup.js";
import type { ComposeContainerObservation } from "./docker.js";
import type { ArchiveBackupSourceResult, PrepareBackupHelperResult } from "./backup-docker.js";
import type { LifecycleLock } from "./lifecycle-lock.js";
import { BackupPlannerError, type BackupPlannerInput } from "./backup-planner.js";
import {
  BackupStorageError,
  type ReservedBackupBundle,
  type ValidatedBackupDestination,
} from "./backup-storage.js";

type BackupSignal = "SIGINT" | "SIGTERM";

export interface RunBackupInput {
  readonly dryRun: boolean;
  readonly destinationPath: string;
  readonly bundleName: string;
  readonly composePath: string;
  readonly projectDir: string;
  readonly stateDir?: string;
  readonly reviewedHelper?: PrepareBackupHelperResult;
  readonly plannerInput: BackupPlannerInput;
  readonly loadRevalidationInput: () => Promise<BackupPlannerInput>;
}

export interface BackupCoordinatorDependencies {
  validateDestination(path: string): Promise<ValidatedBackupDestination>;
  plan(input: BackupPlannerInput): Promise<BackupPlan>;
  reserveBundle(
    destination: ValidatedBackupDestination,
    bundleName: string,
  ): Promise<ReservedBackupBundle>;
  prepareHelper(): Promise<PrepareBackupHelperResult>;
  inspectHelper(): Promise<PrepareBackupHelperResult | undefined>;
  acquireLock(options: {
    readonly projectPath: string;
    readonly dockerContext: string;
    readonly composeProjectName: string;
    readonly stateDir?: string;
  }): Promise<LifecycleLock>;
  observeRunning(
    composePath: string,
    writerServices: readonly string[],
  ): Promise<readonly ComposeContainerObservation[]>;
  stopWriters(composePath: string, writerServices: readonly string[]): Promise<void>;
  archiveSource(
    source: BackupPlannedMount["source"],
    destinationPath: string,
    resolvedImageId: string,
  ): Promise<ArchiveBackupSourceResult>;
  startContainer(containerId: string): Promise<void>;
  publishManifest(bundle: ReservedBackupBundle, manifest: BackupManifest): Promise<string>;
  removeIncompleteBundle(bundle: ReservedBackupBundle): Promise<void>;
  retainIncompleteBundle(bundle: ReservedBackupBundle): Promise<string>;
  now(): Date;
  randomId(): string;
  getInterruption(): BackupSignal | undefined;
}

interface ArchivedMount {
  readonly mount: BackupPlannedMount;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly result: ArchiveBackupSourceResult;
}

interface RunState {
  readonly backupId: string;
  readonly startedAt: string;
  readonly destinationPath: string;
  readonly projectName: string;
  plan: BackupPlan;
  bundle?: ReservedBackupBundle;
  helper?: PrepareBackupHelperResult;
  captured: readonly ComposeContainerObservation[];
  artifacts: BackupArtifactOutcome[];
  primaryFailure?: BackupError;
  additionalFailures: BackupError[];
  recoveryFailures: BackupRecoveryFailure[];
  stagingDisposition: "none" | "removed" | "published" | "retained-incomplete";
  retainedBundlePath?: string;
  manifestPath?: string;
}

function operationalFailure(stage: BackupError["stage"], code: string): BackupError {
  return {
    kind: "operational",
    stage,
    code,
    message:
      stage === "cancelled"
        ? "Backup was interrupted; recovery and cleanup were completed before termination"
        : `Backup failed during ${stage}`,
  };
}

function boundedCode(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
  ) {
    return error.code;
  }
  return fallback;
}

function failureFrom(
  error: unknown,
  stage: BackupError["stage"],
  fallbackCode: string,
): BackupError {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "preflight" || error.kind === "operational") &&
    "stage" in error &&
    "code" in error &&
    "message" in error
  ) {
    return error as BackupError;
  }
  if (error instanceof BackupPlannerError) {
    if (
      [
        "ANONYMOUS_VOLUME",
        "UNSUPPORTED_MOUNT_TYPE",
        "BIND_SOURCE_MISSING",
        "BIND_SOURCE_NOT_DIRECTORY",
        "NAMED_VOLUME_MISSING",
        "NESTED_SELECTED_BIND",
        "AMBIGUOUS_BIND_PATH",
        "DESTINATION_INSIDE_SOURCE",
        "SOURCE_PROBE_FAILED",
      ].includes(error.code)
    ) {
      return {
        kind: "preflight",
        stage: "plan",
        code: error.code as Extract<BackupError, { kind: "preflight" }>["code"],
        message: "Backup planning failed closed",
      };
    }
  }
  return operationalFailure(stage, boundedCode(error, fallbackCode));
}

function interruptedFailure(): BackupError {
  return operationalFailure("cancelled", "INTERRUPTED");
}

function recordInterruption(
  state: RunState,
  dependencies: Pick<BackupCoordinatorDependencies, "getInterruption">,
): boolean {
  if (dependencies.getInterruption() === undefined) return false;
  if (state.primaryFailure?.stage !== "cancelled") {
    if (state.primaryFailure !== undefined) state.additionalFailures.push(state.primaryFailure);
    state.primaryFailure = interruptedFailure();
  }
  return true;
}

function plannedArtifacts(plan: BackupPlan): BackupPlannedArtifactOutcome[] {
  return plan.mounts.map((mount) => ({
    id: mount.id,
    artifactPath: mount.artifactPath,
    status: "planned",
  }));
}

function emptyPlan(input: RunBackupInput, destinationPath: string): BackupPlan {
  return {
    requestedServices: [...input.plannerInput.requestedServices].sort(),
    resolvedServices: [],
    quiescedServices: [],
    recoveryLayers: [],
    mounts: [],
    skipped: [],
    warnings: [],
    resolvedConfigSha256: input.plannerInput.composeEvidence.resolvedConfigFingerprint,
    dockerAuthorityFingerprint: input.plannerInput.dockerAuthorityFingerprint,
    bindTopologyFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalDestination: destinationPath,
  };
}

function summary(state: RunState): BackupSummary {
  return {
    requestedServices: state.plan.requestedServices.length,
    resolvedServices: state.plan.resolvedServices.length,
    writerServices: state.plan.quiescedServices.length,
    previouslyRunningContainers: state.captured.length,
    plannedArtifacts: state.plan.mounts.length,
    archivedArtifacts: state.artifacts.filter((artifact) => artifact.status === "archived").length,
    skippedSources: state.plan.skipped.length,
    failedArtifacts: state.artifacts.filter((artifact) => artifact.status === "failed").length,
    recoveryFailures: state.recoveryFailures.length,
  };
}

function baseResult(state: RunState, completedAt: string) {
  return {
    schemaVersion: BACKUP_RESULT_SCHEMA_VERSION,
    operation: "backup" as const,
    backupId: state.backupId,
    startedAt: state.startedAt,
    completedAt,
    requestedServices: [...state.plan.requestedServices],
    resolvedServices: [...state.plan.resolvedServices],
    writerServices: [...state.plan.quiescedServices],
    previouslyRunningContainerIds: state.captured.map((item) => item.containerId).sort(),
    destinationPath: state.destinationPath,
    planned: state.plan.mounts.map((mount) => ({
      ...mount,
      consumers: mount.consumers.map((consumer) => ({ ...consumer })),
      writerServices: [...mount.writerServices],
      source: { ...mount.source },
      restore: { ...mount.restore },
    })),
    skipped: state.plan.skipped.map((item) => ({
      ...item,
      consumers: item.consumers.map((consumer) => ({ ...consumer })),
    })),
    artifacts: state.artifacts,
    warnings: state.plan.warnings.map((warning) => ({ ...warning })),
    summary: summary(state),
  };
}

function failedResult(state: RunState, completedAt: string, dryRun: boolean): BackupResult {
  const primaryFailure = state.primaryFailure ?? operationalFailure("cleanup", "BACKUP_FAILED");
  const errors = [primaryFailure, ...state.additionalFailures] as [BackupError, ...BackupError[]];
  if (dryRun) {
    return {
      ...baseResult(state, completedAt),
      status: "failed",
      success: false,
      exitCode: 2,
      dryRun: true,
      errors,
      primaryFailure,
      recoveryFailures: [],
      stagingDisposition: "none",
    };
  }
  const status = primaryFailure.stage === "cancelled" ? "cancelled" : "failed";
  const retainedBundlePath = state.bundle?.bundlePath ?? state.retainedBundlePath;
  if (state.stagingDisposition === "retained-incomplete" && retainedBundlePath !== undefined) {
    if (status === "cancelled") {
      return {
        ...baseResult(state, completedAt),
        status: "cancelled",
        success: false,
        exitCode: 2,
        dryRun: false,
        errors,
        primaryFailure,
        recoveryFailures: state.recoveryFailures,
        stagingDisposition: "retained-incomplete",
        bundlePath: retainedBundlePath,
      };
    }
    return {
      ...baseResult(state, completedAt),
      status: "failed",
      success: false,
      exitCode: 1,
      dryRun: false,
      errors,
      primaryFailure,
      recoveryFailures: state.recoveryFailures,
      stagingDisposition: "retained-incomplete",
      bundlePath: retainedBundlePath,
    };
  }
  if (
    state.stagingDisposition === "published" &&
    state.bundle !== undefined &&
    state.manifestPath !== undefined
  ) {
    if (status === "cancelled") {
      return {
        ...baseResult(state, completedAt),
        status: "cancelled",
        success: false,
        exitCode: 2,
        dryRun: false,
        errors,
        primaryFailure,
        recoveryFailures: state.recoveryFailures,
        stagingDisposition: "published",
        bundlePath: state.bundle.bundlePath,
        manifestPath: state.manifestPath,
      };
    }
    return {
      ...baseResult(state, completedAt),
      status: "failed",
      success: false,
      exitCode: 1,
      dryRun: false,
      errors,
      primaryFailure,
      recoveryFailures: state.recoveryFailures,
      stagingDisposition: "published",
      bundlePath: state.bundle.bundlePath,
      manifestPath: state.manifestPath,
    };
  }
  if (status === "cancelled") {
    return {
      ...baseResult(state, completedAt),
      status: "cancelled",
      success: false,
      exitCode: 2,
      dryRun: false,
      errors,
      primaryFailure,
      recoveryFailures: [],
      stagingDisposition: state.stagingDisposition === "removed" ? "removed" : "none",
    };
  }
  return {
    ...baseResult(state, completedAt),
    status: "failed",
    success: false,
    exitCode: primaryFailure.kind === "preflight" || primaryFailure.stage === "validate" ? 2 : 1,
    dryRun: false,
    errors,
    primaryFailure,
    recoveryFailures: [],
    stagingDisposition: state.stagingDisposition === "removed" ? "removed" : "none",
  };
}

function plansEqual(expected: BackupPlan, observed: BackupPlan): boolean {
  return JSON.stringify(expected) === JSON.stringify(observed);
}

function writerIsActive(observation: ComposeContainerObservation): boolean {
  const state = observation.state.toLowerCase();
  return state === "running" || state === "restarting";
}

function captureByRecoveryOrder(
  captured: readonly ComposeContainerObservation[],
  layers: readonly (readonly string[])[],
): ComposeContainerObservation[] {
  const byService = new Map<string, ComposeContainerObservation[]>();
  for (const item of captured) {
    const serviceItems = byService.get(item.serviceName) ?? [];
    serviceItems.push(item);
    byService.set(item.serviceName, serviceItems);
  }
  const ordered: ComposeContainerObservation[] = [];
  const included = new Set<string>();
  for (const layer of layers) {
    for (const service of [...layer].sort()) {
      const items = (byService.get(service) ?? []).sort((a, b) =>
        a.containerId.localeCompare(b.containerId),
      );
      ordered.push(...items);
      items.forEach((item) => included.add(item.containerId));
    }
  }
  ordered.push(
    ...captured
      .filter((item) => !included.has(item.containerId))
      .sort(
        (a, b) =>
          a.serviceName.localeCompare(b.serviceName) || a.containerId.localeCompare(b.containerId),
      ),
  );
  return ordered;
}

async function recoverCapturedContainers(
  input: RunBackupInput,
  state: RunState,
  dependencies: BackupCoordinatorDependencies,
): Promise<void> {
  const captured = captureByRecoveryOrder(state.captured, state.plan.recoveryLayers);
  if (captured.length === 0) return;

  const failedIds = new Set<string>();
  const recordRecoveryFailure = (
    item: ComposeContainerObservation,
    code: string,
    message: string,
  ): void => {
    if (failedIds.has(item.containerId)) return;
    failedIds.add(item.containerId);
    state.recoveryFailures.push({
      containerId: item.containerId,
      service: item.serviceName,
      code,
      message,
    });
  };

  let runningIds = new Set<string>();
  try {
    const observed = await dependencies.observeRunning(
      input.composePath,
      state.plan.quiescedServices,
    );
    runningIds = new Set(observed.filter(writerIsActive).map((item) => item.containerId));
  } catch {
    // If observation fails, starting every exact captured ID is the conservative recovery action.
  }
  for (const item of captured) {
    if (runningIds.has(item.containerId)) continue;
    try {
      await dependencies.startContainer(item.containerId);
    } catch {
      recordRecoveryFailure(
        item,
        "CONTAINER_RESTART_FAILED",
        "An exact previously-running container could not be restarted",
      );
    }
  }

  let recovered: readonly ComposeContainerObservation[];
  try {
    recovered = await dependencies.observeRunning(input.composePath, state.plan.quiescedServices);
  } catch {
    for (const item of captured) {
      recordRecoveryFailure(
        item,
        "RECOVERY_OBSERVATION_FAILED",
        "The recovered state of an exact previously-running container could not be observed",
      );
    }
    return;
  }

  const recoveredById = new Map(recovered.map((item) => [item.containerId, item]));
  for (const item of captured) {
    const observation = recoveredById.get(item.containerId);
    if (observation !== undefined && writerIsActive(observation)) continue;
    recordRecoveryFailure(
      item,
      observation === undefined ? "RECOVERED_CONTAINER_MISSING" : "RECOVERED_CONTAINER_INACTIVE",
      observation === undefined
        ? "An exact previously-running container was missing after recovery"
        : "An exact previously-running container was inactive after recovery",
    );
  }
}

function manifest(
  state: RunState,
  archived: readonly ArchivedMount[],
  completedAt: string,
): BackupManifest {
  if (state.helper === undefined) throw new Error("Backup helper evidence is missing");
  const mounts: BackupManifestMount[] = archived.map((item) => ({
    id: item.mount.id,
    artifactPath: item.mount.artifactPath,
    source: { ...item.mount.source },
    consumers: item.mount.consumers.map((consumer) => ({ ...consumer })),
    archiveStartedAt: item.startedAt,
    archiveCompletedAt: item.completedAt,
    compressedBytes: item.result.compressedBytes,
    sha256: item.result.sha256,
    restore: { ...item.mount.restore },
  }));
  return {
    schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
    backupId: state.backupId,
    createdAt: state.startedAt,
    completedAt,
    consistency: "detected-compose-writers-stopped",
    project: {
      name: state.projectName,
      resolvedConfigSha256: state.plan.resolvedConfigSha256,
      dockerAuthorityFingerprint: state.plan.dockerAuthorityFingerprint,
    },
    scope: {
      requestedServices: [...state.plan.requestedServices],
      resolvedServices: [...state.plan.resolvedServices],
      quiescedServices: [...state.plan.quiescedServices],
      previouslyRunningServices: [
        ...new Set(state.captured.map((item) => item.serviceName)),
      ].sort(),
    },
    helperImage: {
      reference: BACKUP_HELPER_IMAGE_REFERENCE,
      resolvedImageId: state.helper.resolvedImageId,
    },
    skipped: state.plan.skipped.map((item) => ({
      ...item,
      consumers: item.consumers.map((consumer) => ({ ...consumer })),
    })),
    mounts,
    warnings: state.plan.warnings.map((warning) => ({ ...warning })),
  };
}

async function cleanupFailedRun(
  state: RunState,
  dependencies: BackupCoordinatorDependencies,
): Promise<void> {
  if (state.bundle === undefined) return;
  if (state.recoveryFailures.length > 0) {
    state.stagingDisposition = "retained-incomplete";
    await dependencies.retainIncompleteBundle(state.bundle);
    return;
  }
  try {
    await dependencies.removeIncompleteBundle(state.bundle);
    state.stagingDisposition = "removed";
  } catch (error) {
    state.additionalFailures.push(failureFrom(error, "cleanup", "BUNDLE_CLEANUP_FAILED"));
    state.stagingDisposition = "retained-incomplete";
    await dependencies.retainIncompleteBundle(state.bundle);
  }
}

async function releaseLifecycleLock(
  lock: LifecycleLock | undefined,
  state: RunState,
): Promise<void> {
  try {
    await lock?.release();
  } catch {
    state.plan.warnings.push({
      code: "LOCK_RELEASE_FAILED",
      message: "The lifecycle lock could not be released automatically.",
    });
  }
}

/** Execute the all-or-nothing cold-backup lifecycle and return typed terminal evidence. */
export async function runBackup(
  input: RunBackupInput,
  dependencies: BackupCoordinatorDependencies,
): Promise<BackupResult> {
  const state: RunState = {
    backupId: dependencies.randomId(),
    startedAt: dependencies.now().toISOString(),
    destinationPath: input.destinationPath,
    projectName: input.plannerInput.composeEvidence.config.name,
    plan: emptyPlan(input, input.destinationPath),
    captured: [],
    artifacts: [],
    additionalFailures: [],
    recoveryFailures: [],
    stagingDisposition: "none",
  };
  if (recordInterruption(state, dependencies)) {
    return failedResult(state, dependencies.now().toISOString(), input.dryRun);
  }
  let destination: ValidatedBackupDestination;
  try {
    destination = await dependencies.validateDestination(input.destinationPath);
    state.plan = await dependencies.plan({
      ...input.plannerInput,
      canonicalDestination: destination.path,
    });
    state.artifacts = plannedArtifacts(state.plan);
    if (recordInterruption(state, dependencies)) {
      return failedResult(state, dependencies.now().toISOString(), input.dryRun);
    }
  } catch (error) {
    state.primaryFailure = failureFrom(error, "validate", "BACKUP_VALIDATION_FAILED");
    return failedResult(state, dependencies.now().toISOString(), input.dryRun);
  }

  if (input.dryRun) {
    return {
      ...baseResult(state, dependencies.now().toISOString()),
      status: "planned",
      success: true,
      exitCode: 0,
      dryRun: true,
      artifacts: state.artifacts as BackupPlannedArtifactOutcome[],
      errors: [],
      recoveryFailures: [],
      stagingDisposition: "none",
    };
  }

  if (input.reviewedHelper === undefined) {
    state.primaryFailure = operationalFailure("prepare-helper", "HELPER_IDENTITY_UNREVIEWED");
    return failedResult(state, dependencies.now().toISOString(), false);
  }
  state.helper = input.reviewedHelper;

  if (recordInterruption(state, dependencies)) {
    return failedResult(state, dependencies.now().toISOString(), false);
  }

  try {
    state.bundle = await dependencies.reserveBundle(destination, input.bundleName);
    if (recordInterruption(state, dependencies)) {
      await cleanupFailedRun(state, dependencies);
      return failedResult(state, dependencies.now().toISOString(), false);
    }
  } catch (error) {
    if (error instanceof BackupStorageError && error.retainedReservation !== undefined) {
      state.retainedBundlePath = error.retainedReservation.bundlePath;
      state.stagingDisposition = error.retainedReservation.stagingDisposition;
    }
    state.primaryFailure = failureFrom(error, "reserve", "BACKUP_RESERVATION_FAILED");
    await cleanupFailedRun(state, dependencies);
    return failedResult(state, dependencies.now().toISOString(), false);
  }

  try {
    const preparedHelper = await dependencies.prepareHelper();
    if (
      preparedHelper.reference !== input.reviewedHelper.reference ||
      preparedHelper.resolvedImageId !== input.reviewedHelper.resolvedImageId
    ) {
      throw operationalFailure("prepare-helper", "HELPER_IDENTITY_DRIFT");
    }
    if (recordInterruption(state, dependencies)) throw interruptedFailure();
  } catch (error) {
    state.primaryFailure = failureFrom(error, "prepare-helper", "HELPER_PREPARATION_FAILED");
    await cleanupFailedRun(state, dependencies);
    return failedResult(state, dependencies.now().toISOString(), false);
  }

  let lock: LifecycleLock | undefined;
  let stopAttempted = false;
  const archived: ArchivedMount[] = [];
  try {
    lock = await dependencies.acquireLock({
      projectPath: input.projectDir,
      dockerContext: state.plan.dockerAuthorityFingerprint,
      composeProjectName: input.plannerInput.composeEvidence.config.name,
      stateDir: input.stateDir,
    });
    if (recordInterruption(state, dependencies)) throw interruptedFailure();

    let freshInput: BackupPlannerInput;
    let freshPlan: BackupPlan;
    let freshHelper: PrepareBackupHelperResult | undefined;
    try {
      freshHelper = await dependencies.inspectHelper();
      freshInput = await input.loadRevalidationInput();
      freshPlan = await dependencies.plan({
        ...freshInput,
        canonicalDestination: destination.path,
      });
    } catch {
      throw operationalFailure("revalidate", "REVALIDATION_FAILED");
    }
    if (
      freshHelper === undefined ||
      freshHelper.reference !== state.helper.reference ||
      freshHelper.resolvedImageId !== state.helper.resolvedImageId ||
      freshInput.composeEvidence.config.name !== state.projectName ||
      !plansEqual(state.plan, freshPlan)
    ) {
      throw operationalFailure("revalidate", "REVALIDATION_FAILED");
    }
    if (recordInterruption(state, dependencies)) throw interruptedFailure();

    if (state.plan.quiescedServices.length > 0) {
      state.captured = await dependencies.observeRunning(
        input.composePath,
        state.plan.quiescedServices,
      );
      if (recordInterruption(state, dependencies)) throw interruptedFailure();
      stopAttempted = true;
      await dependencies.stopWriters(input.composePath, state.plan.quiescedServices);
      if (recordInterruption(state, dependencies)) throw interruptedFailure();
      const afterStop = await dependencies.observeRunning(
        input.composePath,
        state.plan.quiescedServices,
      );
      if (afterStop.some(writerIsActive)) {
        throw operationalFailure("stop", "WRITER_STILL_RUNNING");
      }
    }

    for (const mount of state.plan.mounts) {
      if (recordInterruption(state, dependencies)) throw interruptedFailure();
      if (state.plan.quiescedServices.length > 0) {
        const beforeArchive = await dependencies.observeRunning(
          input.composePath,
          state.plan.quiescedServices,
        );
        if (beforeArchive.some(writerIsActive)) {
          throw operationalFailure("stop", "WRITER_STILL_RUNNING");
        }
      }
      const startedAt = dependencies.now().toISOString();
      try {
        const result = await dependencies.archiveSource(
          mount.source,
          join(state.bundle.bundlePath, mount.artifactPath),
          state.helper.resolvedImageId,
        );
        const completedAt = dependencies.now().toISOString();
        archived.push({ mount, startedAt, completedAt, result });
        const outcome: BackupArchivedArtifactOutcome = {
          id: mount.id,
          artifactPath: mount.artifactPath,
          status: "archived",
          compressedBytes: result.compressedBytes,
          sha256: result.sha256,
        };
        const index = state.artifacts.findIndex((artifact) => artifact.id === mount.id);
        state.artifacts[index] = outcome;
      } catch (error) {
        const failure = failureFrom(error, "archive", "ARCHIVE_FAILED");
        const outcome: BackupFailedArtifactOutcome = {
          id: mount.id,
          artifactPath: mount.artifactPath,
          status: "failed",
          error: failure,
        };
        const index = state.artifacts.findIndex((artifact) => artifact.id === mount.id);
        state.artifacts[index] = outcome;
        throw failure;
      }
      if (recordInterruption(state, dependencies)) throw interruptedFailure();
    }
  } catch (error) {
    state.primaryFailure =
      typeof error === "object" &&
      error !== null &&
      "kind" in error &&
      (error.kind === "preflight" || error.kind === "operational")
        ? (error as BackupError)
        : failureFrom(error, stopAttempted ? "stop" : "revalidate", "BACKUP_LIFECYCLE_FAILED");
  } finally {
    if (stopAttempted) await recoverCapturedContainers(input, state, dependencies);
    recordInterruption(state, dependencies);
  }

  if (
    state.primaryFailure === undefined &&
    state.recoveryFailures.length === 0 &&
    !recordInterruption(state, dependencies)
  ) {
    try {
      const completedAt = dependencies.now().toISOString();
      const manifestPath = await dependencies.publishManifest(
        state.bundle,
        manifest(state, archived, completedAt),
      );
      state.stagingDisposition = "published";
      state.manifestPath = manifestPath;
      await releaseLifecycleLock(lock, state);
      if (recordInterruption(state, dependencies)) {
        return failedResult(state, dependencies.now().toISOString(), false);
      }
      const result: BackupResult = {
        ...baseResult(state, completedAt),
        status: "succeeded",
        success: true,
        exitCode: 0,
        dryRun: false,
        bundlePath: state.bundle.bundlePath,
        manifestPath,
        artifacts: state.artifacts as BackupArchivedArtifactOutcome[],
        errors: [],
        recoveryFailures: [],
        stagingDisposition: "published",
      };
      return result;
    } catch (error) {
      state.primaryFailure = failureFrom(error, "publish", "MANIFEST_PUBLICATION_FAILED");
    }
  }

  try {
    await cleanupFailedRun(state, dependencies);
  } catch {
    state.plan.warnings.push({
      code: "STAGING_CLEANUP_FAILED",
      message: "The incomplete backup bundle could not be finalized or removed automatically.",
    });
  } finally {
    await releaseLifecycleLock(lock, state);
  }
  recordInterruption(state, dependencies);
  return failedResult(state, dependencies.now().toISOString(), false);
}
