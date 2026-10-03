/**
 * Interactive boundary for the managed image-update lifecycle.
 *
 * The action owns configuration, service selection, approval, persistence,
 * process output, and database lifetime. The coordinator remains data-only.
 */

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import {
  confirm,
  isMachineFormat,
  logDebug,
  logInfo,
  logSuccess,
  logWarn,
  type OutputFormat,
} from "@rfmedia/common";

import type { DbConnection } from "../lib/db.js";
import type { ManagedUpdateDependencies } from "../lib/managed-update.js";
import type { RfappsConfig } from "../types/config.js";
import type { EnvToolExecConfig } from "../types/options.js";
import type {
  ManagedUpdateCleanupFailure,
  ManagedUpdateError,
  ManagedUpdatePlan,
  ManagedUpdatePlanService,
  ManagedUpdateResult,
  ManagedUpdateServiceResult,
  ManagedUpdateSummary,
} from "../types/update.js";
import { MANAGED_UPDATE_RESULT_SCHEMA_VERSION } from "../types/update.js";
import { getEnvToolExecConfig } from "../types/options.js";

import {
  applyCliOverrides,
  closeDatabase,
  createGeneration,
  findGenerationByNumber,
  findLatestGenerationByImageId,
  generatePlan,
  getComposeConfig,
  getComposeServices,
  getGenerationCount,
  getRunningServiceContainerMap,
  getStateDbPath,
  initializeDatabase,
  isValidProfile,
  loadConfig,
  recordDeployment,
  resolveServicesWithInteractive,
} from "../lib/index.js";
import { inspectContainerIdentity, recreateServiceWithImage } from "../lib/docker.js";
import { verifyServiceReadiness } from "../lib/health.js";
import {
  dockerAuthorityFingerprint,
  resolveComposeProjectIdentity,
  type ComposeProjectIdentity,
  type ResolveComposeProjectIdentityOptions,
} from "../lib/identity.js";
import type { ResolveServicesFn } from "../lib/interactive-selection.js";
import { acquireLifecycleLock } from "../lib/lifecycle-lock.js";
import { generateManagedUpdatePlan, runManagedUpdate } from "../lib/managed-update.js";
import { redactManagedMessage } from "../lib/managed-redaction.js";
import {
  hashFile,
  loadManagedUpdatePlan,
  ManagedArtifactStorageError,
  reserveManagedUpdateResultPath,
  saveManagedUpdatePlan,
  saveManagedUpdateResult,
  type ManagedArtifactWriteOptions,
} from "../lib/plan-storage.js";
import { formatOutput } from "../lib/formatters/index.js";
import { InvalidArgumentError } from "../lib/errors.js";

export interface RawUpdateOptions {
  service?: string;
  services?: string;
  group?: string;
  /** Hierarchical tag patterns (`--tag`), one entry per occurrence. Never defaulted to `[]`. */
  tag?: string[];
  sidecars?: boolean;
  apply?: boolean;
  fromPlan?: string;
  out?: string;
  restoreOnFailure?: boolean;
  healthTimeout?: number | string;
  compose?: string;
  envFile?: string;
  profile?: string;
}

interface NormalizedUpdateOptions {
  service?: string;
  services?: string[];
  group?: string;
  /**
   * Carried verbatim from {@link RawUpdateOptions}. `ServiceTargetOptions`' fan-out does
   * NOT reach this interface — it is declared locally — so omitting it here leaves
   * `options.tag` permanently `undefined` and `update --tag` declares the flag and
   * silently drops it on a command that holds the global state lock.
   */
  tag?: string[];
  noSidecars: boolean;
  apply: boolean;
  fromPlan?: string;
  out?: string;
  restoreOnFailure: boolean;
  healthTimeout?: number;
  composePath?: string;
  envFile?: string;
  profile?: string;
  dryRun: boolean;
  yes: boolean;
  format: OutputFormat;
}

interface ResolvedUpdateServices {
  services: string[];
  profiles: string[];
}

interface UpdateSignalTracker {
  getInterruption(): "SIGINT" | "SIGTERM" | undefined;
}

export {
  dockerAuthorityFingerprint,
  resolveComposeProjectIdentity,
  type ComposeProjectIdentity,
  type ResolveComposeProjectIdentityOptions,
} from "../lib/identity.js";

export interface UpdateActionDependencies {
  loadConfig(): Promise<RfappsConfig>;
  applyCliOverrides: typeof applyCliOverrides;
  /**
   * The shared resolver seam. Declared through {@link ResolveServicesFn} rather than
   * re-stated structurally so a new targeting axis cannot be added here and forgotten in
   * `backup`/`reconcile` — a missed copy typechecks and silently drops the axis.
   */
  resolveServices: ResolveServicesFn<ResolvedUpdateServices, { envTool?: EnvToolExecConfig }>;
  getComposeServices(
    composePath: string,
    options: { profiles?: string[]; projectName?: string; envTool?: EnvToolExecConfig },
  ): Promise<string[]>;
  initializeDatabase(path?: string): Promise<DbConnection>;
  closeDatabase(db: DbConnection): void;
  createCoordinatorDependencies(
    db: DbConnection,
    signal: UpdateSignalTracker,
    envTool?: EnvToolExecConfig,
  ): ManagedUpdateDependencies;
  generateManagedUpdatePlan: typeof generateManagedUpdatePlan;
  runManagedUpdate: typeof runManagedUpdate;
  loadManagedUpdatePlan: typeof loadManagedUpdatePlan;
  saveManagedUpdatePlan: typeof saveManagedUpdatePlan;
  saveManagedUpdateResult: typeof saveManagedUpdateResult;
  reserveManagedUpdateResultPath?: typeof reserveManagedUpdateResultPath;
  confirm(message: string): Promise<boolean>;
  formatOutput(format: OutputFormat, data: unknown): Promise<void>;
  now(): Date;
  randomId(): string;
  resolveComposeProjectIdentity?(
    composePath: string,
    options?: ResolveComposeProjectIdentityOptions,
  ): Promise<ComposeProjectIdentity>;
}

function createProductionCoordinatorDependencies(
  db: DbConnection,
  signal: UpdateSignalTracker,
  envTool?: EnvToolExecConfig,
): ManagedUpdateDependencies {
  return {
    plan: {
      generatePlan,
      async resolveComposeProjectName(options, executionEnvTool) {
        const config = await getComposeConfig(options.composePath, {
          profiles: options.profiles,
          cwd: dirname(options.composePath),
          envTool: executionEnvTool,
        });
        return config?.name;
      },
    },
    docker: {
      getContextFingerprint: () => dockerAuthorityFingerprint(envTool),
      async inspectServiceIdentity(input) {
        const mapping = await getRunningServiceContainerMap(input.composePath, {
          projectName: input.projectName,
          profiles: input.profiles === undefined ? undefined : [...input.profiles],
          envTool: input.envTool,
        });
        const containerName = mapping?.get(input.service);
        if (containerName === undefined) return undefined;
        return inspectContainerIdentity(containerName, { envTool: input.envTool });
      },
      recreateServiceWithImage,
    },
    state: {
      findRecoveryGeneration(service, imageId) {
        return findLatestGenerationByImageId(db, service, imageId);
      },
      findGeneration(service, generation) {
        return findGenerationByNumber(db, service, generation);
      },
      createGeneration(input) {
        return createGeneration(db, input);
      },
      recordDeployment(input) {
        return recordDeployment(db, input);
      },
      getGenerationCount(service) {
        return getGenerationCount(db, { service });
      },
    },
    health: { verifyServiceReadiness },
    clock: {
      now: () => new Date(),
      randomId: randomUUID,
    },
    lock: { acquire: acquireLifecycleLock },
    signal,
    filesystem: { hashFile },
  };
}

const defaultDependencies: UpdateActionDependencies = {
  loadConfig,
  applyCliOverrides,
  resolveServices: resolveServicesWithInteractive,
  getComposeServices,
  initializeDatabase,
  closeDatabase,
  createCoordinatorDependencies: createProductionCoordinatorDependencies,
  generateManagedUpdatePlan,
  runManagedUpdate,
  loadManagedUpdatePlan,
  saveManagedUpdatePlan,
  saveManagedUpdateResult,
  reserveManagedUpdateResultPath,
  confirm,
  formatOutput,
  now: () => new Date(),
  randomId: randomUUID,
  resolveComposeProjectIdentity,
};

function normalizeOptions(
  rawOptions: RawUpdateOptions,
  globalOptions: {
    dryRun?: boolean;
    json?: boolean;
    output?: OutputFormat;
    yes?: boolean;
  },
): NormalizedUpdateOptions {
  const timeout =
    typeof rawOptions.healthTimeout === "string"
      ? Number(rawOptions.healthTimeout)
      : rawOptions.healthTimeout;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new InvalidArgumentError(
      "--health-timeout",
      String(rawOptions.healthTimeout),
      "Must be a positive number of seconds",
    );
  }

  const services = rawOptions.services
    ?.split(",")
    .map((service) => service.trim())
    .filter((service) => service !== "");
  if (rawOptions.services !== undefined && services?.length === 0) {
    throw new InvalidArgumentError("--services", rawOptions.services, "Must name a service");
  }

  const fromPlanConflicts = [
    rawOptions.service === undefined ? undefined : "--service",
    rawOptions.services === undefined ? undefined : "--services",
    rawOptions.group === undefined ? undefined : "--group",
    rawOptions.tag === undefined ? undefined : "--tag",
    rawOptions.compose === undefined ? undefined : "--compose",
    rawOptions.profile === undefined ? undefined : "--profile",
    rawOptions.sidecars === false ? "--no-sidecars" : undefined,
  ].filter((option): option is string => option !== undefined);
  if (rawOptions.fromPlan !== undefined && fromPlanConflicts.length > 0) {
    throw new InvalidArgumentError(
      fromPlanConflicts[0] ?? "--from-plan",
      rawOptions.fromPlan,
      `Cannot change reviewed scope with --from-plan (${fromPlanConflicts.join(", ")})`,
    );
  }

  return {
    service: rawOptions.service,
    services,
    group: rawOptions.group,
    tag: rawOptions.tag,
    noSidecars: rawOptions.sidecars === false,
    apply: rawOptions.apply ?? false,
    fromPlan: rawOptions.fromPlan,
    out: rawOptions.out,
    restoreOnFailure: rawOptions.restoreOnFailure !== false,
    healthTimeout: timeout,
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
    dryRun: globalOptions.dryRun ?? false,
    yes: globalOptions.yes ?? false,
    format: globalOptions.output ?? (globalOptions.json === true ? "json" : "text"),
  };
}

function lifecycleError(
  stage: ManagedUpdateError["stage"],
  code: string,
  message: string,
): ManagedUpdateError {
  return { kind: "lifecycle", stage, code, message };
}

function previewService(
  service: ManagedUpdatePlanService,
  cancelled: boolean,
): ManagedUpdateServiceResult {
  const reviewedIdentity = {
    configuredImage: service.configuredImage,
    ...(service.platform === undefined ? {} : { platform: service.platform }),
    ...(service.currentImageId === undefined ? {} : { currentImageId: service.currentImageId }),
    ...(service.currentDigest === undefined ? {} : { currentDigest: service.currentDigest }),
    ...(service.proposedDigest === undefined ? {} : { proposedDigest: service.proposedDigest }),
  };
  const common = {
    service: service.service,
    reviewedIdentity,
    verification: {
      status: "not-run" as const,
      assurance: "none" as const,
      reasonCode: cancelled ? "approval-declined" : "preview-only",
    },
    restore: { status: "not-required" as const },
    generations: {},
    durationMs: 0,
  };
  switch (service.status) {
    case "update-available":
      return { ...common, outcome: cancelled ? "cancelled" : "planned", stage: "complete" };
    case "up-to-date":
      return { ...common, outcome: "up_to_date", stage: "complete" };
    case "unsupported":
      return { ...common, outcome: "unsupported", stage: "complete" };
    case "local-missing": {
      const error = lifecycleError(
        "validate",
        service.errorCode ?? "LOCAL_IMAGE_MISSING",
        service.message ?? "Current local image identity is unavailable",
      );
      return { ...common, outcome: "blocked", stage: "validate", error };
    }
    case "unknown": {
      const error = lifecycleError(
        "detect",
        service.errorCode ?? "DETECTION_UNKNOWN",
        service.message ?? "Update detection was inconclusive",
      );
      return { ...common, outcome: "detection_unknown", stage: "detect", error };
    }
  }
}

function summarize(
  plan: ManagedUpdatePlan,
  services: ManagedUpdateServiceResult[],
): ManagedUpdateSummary {
  return {
    selected: services.length,
    actionable: plan.services.filter((service) => service.status === "update-available").length,
    updated: 0,
    restored: 0,
    upToDate: services.filter((service) => service.outcome === "up_to_date").length,
    unsupported: services.filter((service) => service.outcome === "unsupported").length,
    unknown: services.filter((service) => service.outcome === "detection_unknown").length,
    blocked: services.filter((service) => service.outcome === "blocked").length,
    failed: 0,
    interrupted: 0,
  };
}

function previewResult(
  plan: ManagedUpdatePlan,
  dependencies: Pick<UpdateActionDependencies, "now" | "randomId">,
  cancelled = false,
): ManagedUpdateResult {
  const timestamp = dependencies.now().toISOString();
  const services = plan.services.map((service) => previewService(service, cancelled));
  const summary = summarize(plan, services);
  const incomplete = summary.unknown + summary.blocked > 0;
  return {
    schemaVersion: MANAGED_UPDATE_RESULT_SCHEMA_VERSION,
    runId: dependencies.randomId(),
    planId: plan.id,
    startedAt: timestamp,
    completedAt: timestamp,
    status: incomplete ? "partial" : summary.actionable === 0 ? "no_updates" : "succeeded",
    success: !incomplete,
    exitCode: incomplete ? 1 : 0,
    applied: false,
    restoreOnFailure: plan.restorePolicy === "restore-on-failure",
    summary,
    services,
  };
}

function displayPlan(plan: ManagedUpdatePlan, artifactPath?: string): void {
  console.error("");
  console.error("Managed image update plan");
  console.error(`Plan ID: ${plan.id}`);
  for (const service of plan.services) {
    const proposed = service.proposedDigest === undefined ? "-" : service.proposedDigest;
    console.error(`  ${service.service}: ${service.status} -> ${proposed}`);
  }
  if (artifactPath !== undefined) console.error(`Plan: ${artifactPath}`);
}

function displayResult(result: ManagedUpdateResult, artifactPath?: string): void {
  console.error("");
  console.error(`Managed update: ${result.status}`);
  for (const service of result.services) {
    console.error(`  ${service.service}: ${service.outcome}`);
  }
  if (artifactPath !== undefined) console.error(`Report: ${artifactPath}`);
}

function artifactArgument(
  error: ManagedArtifactStorageError,
  argument: string,
): InvalidArgumentError {
  return new InvalidArgumentError(
    argument,
    error.artifactPath ?? "",
    `${error.code}: ${error.message}`,
  );
}

function installSignalTracker(): { tracker: UpdateSignalTracker; dispose(): void } {
  let interruption: "SIGINT" | "SIGTERM" | undefined;
  const onSigint = () => {
    interruption = "SIGINT";
  };
  const onSigterm = () => {
    interruption = "SIGTERM";
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    tracker: { getInterruption: () => interruption },
    dispose() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

async function emitResult(
  result: ManagedUpdateResult,
  format: OutputFormat,
  dependencies: UpdateActionDependencies,
): Promise<void> {
  if (format !== "text") {
    await dependencies.formatOutput(format, result);
  }
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

function closeDatabaseBeforeResult(
  result: ManagedUpdateResult,
  db: DbConnection,
  dependencies: Pick<UpdateActionDependencies, "closeDatabase">,
): void {
  try {
    dependencies.closeDatabase(db);
  } catch (error) {
    const failure: ManagedUpdateCleanupFailure = {
      operation: "state-close",
      code: "CLEANUP_FAILED",
      message: redactManagedMessage(
        `Database cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        512,
      ),
    };
    const existing = (result.cleanupFailures ?? []).filter(
      (entry) => entry.operation !== "state-close",
    );
    result.cleanupFailures = [...existing.slice(0, 2), failure];
    if (result.success) {
      result.status = result.applied ? "partial" : "failed";
      result.success = false;
      result.exitCode = 1;
    }
  }
}

/** Execute a preview or approved managed image update. */
export async function executeUpdate(
  rawOptions: RawUpdateOptions,
  globalOptions: {
    dryRun?: boolean;
    debug?: boolean;
    json?: boolean;
    output?: OutputFormat;
    verbose?: boolean;
    yes?: boolean;
    useDotenvx?: string;
    useOp?: string;
  },
  dependencies: UpdateActionDependencies = defaultDependencies,
): Promise<void> {
  const options = normalizeOptions(rawOptions, globalOptions);
  logDebug(`Managed update mode: ${options.apply ? "apply" : "preview"}`);

  const config = await dependencies.loadConfig();
  if (options.profile !== undefined && !isValidProfile(options.profile, config)) {
    throw new InvalidArgumentError(
      "--profile",
      options.profile,
      "Unknown profile",
      config.profiles.validProfiles,
    );
  }
  const finalConfig = dependencies.applyCliOverrides(config, {
    composePath: options.composePath,
    envFile: options.envFile,
    profile: options.profile,
    noSidecars: options.noSidecars,
  });
  const envTool = getEnvToolExecConfig(globalOptions, finalConfig);
  const resolveProjectIdentity =
    dependencies.resolveComposeProjectIdentity ?? resolveComposeProjectIdentity;
  let approvedProject: ComposeProjectIdentity;
  try {
    approvedProject = await resolveProjectIdentity(finalConfig.composePath, { envTool });
  } catch (error) {
    throw new InvalidArgumentError(
      "--compose",
      finalConfig.composePath,
      error instanceof Error ? error.message : "Compose path could not be resolved safely",
    );
  }

  let db: DbConnection | undefined;
  let signals: ReturnType<typeof installSignalTracker> | undefined;
  try {
    let plan: ManagedUpdatePlan;
    if (options.fromPlan !== undefined) {
      logInfo(`Loading managed update plan from ${options.fromPlan}...`);
      try {
        plan = await dependencies.loadManagedUpdatePlan(options.fromPlan);
      } catch (error) {
        if (error instanceof ManagedArtifactStorageError) {
          throw artifactArgument(error, "--from-plan");
        }
        throw error;
      }
      let reviewedProject: ComposeProjectIdentity;
      try {
        reviewedProject = await resolveProjectIdentity(plan.composePath, {
          requireCanonicalInput: true,
          envTool,
        });
      } catch (error) {
        throw new InvalidArgumentError(
          "--from-plan",
          plan.composePath,
          error instanceof Error ? error.message : "Plan Compose path could not be resolved safely",
        );
      }
      if (
        reviewedProject.composePath !== approvedProject.composePath ||
        reviewedProject.projectDir !== approvedProject.projectDir ||
        reviewedProject.projectName !== approvedProject.projectName ||
        plan.composeProjectName !== approvedProject.projectName
      ) {
        throw new InvalidArgumentError(
          "--from-plan",
          plan.composePath,
          "Plan Compose path does not match the currently approved project Compose path",
        );
      }
      if (rawOptions.restoreOnFailure === false && plan.restorePolicy !== "no-restore-on-failure") {
        throw new InvalidArgumentError(
          "--no-restore-on-failure",
          "false",
          "Cannot change the restore policy of a reviewed plan",
        );
      }
    } else {
      const resolved = await dependencies.resolveServices(
        {
          service: options.service,
          services: options.services,
          group: options.group,
          tag: options.tag,
          noSidecars: options.noSidecars,
          sidecars: options.noSidecars ? false : undefined,
          yes: options.yes,
        },
        finalConfig,
        approvedProject.composePath,
        approvedProject.projectDir,
        { envTool },
      );
      if (resolved === null) return;
      const targetServices =
        resolved.services.length > 0
          ? resolved.services
          : await dependencies.getComposeServices(approvedProject.composePath, {
              profiles: resolved.profiles,
              projectName: approvedProject.projectName,
              envTool,
            });
      if (targetServices.length === 0) {
        throw new InvalidArgumentError(
          "--service",
          "",
          "No Compose services were available for managed update",
        );
      }
      db = await dependencies.initializeDatabase(getStateDbPath(finalConfig));
      const noSignal: UpdateSignalTracker = { getInterruption: () => undefined };
      const coordinatorDependencies = dependencies.createCoordinatorDependencies(
        db,
        noSignal,
        envTool,
      );
      logInfo("Checking registry image identities and generating a managed update plan...");
      plan = await dependencies.generateManagedUpdatePlan(
        {
          composePath: approvedProject.composePath,
          targetServices,
          profiles: resolved.profiles,
          restorePolicy: options.restoreOnFailure ? "restore-on-failure" : "no-restore-on-failure",
          envTool,
        },
        coordinatorDependencies,
      );
      if (plan.composeProjectName !== approvedProject.projectName) {
        throw new InvalidArgumentError(
          "--compose",
          approvedProject.composePath,
          "Effective Compose project name changed while generating the managed update plan",
        );
      }
    }

    logWarn(
      "Recovery is image-only: volumes, application data, databases, and migrations are not restored.",
    );

    const actionable = plan.services.filter((service) => service.status === "update-available");
    const shouldApply = options.apply && !options.dryRun && actionable.length > 0;

    if (!shouldApply) {
      const result = previewResult(plan, dependencies);
      if (db !== undefined) {
        closeDatabaseBeforeResult(result, db, dependencies);
        db = undefined;
      }
      let artifactPath: string;
      try {
        artifactPath =
          options.apply && !options.dryRun
            ? await dependencies.saveManagedUpdateResult(result, options.out)
            : await dependencies.saveManagedUpdatePlan(plan, options.out);
      } catch (error) {
        if (error instanceof ManagedArtifactStorageError) throw artifactArgument(error, "--out");
        throw error;
      }
      if (options.format === "text") {
        if (options.apply && !options.dryRun) displayResult(result, artifactPath);
        else displayPlan(plan, artifactPath);
      }
      await emitResult(result, options.format, dependencies);
      return;
    }

    if (isMachineFormat(options.format) && !options.yes) {
      throw new InvalidArgumentError(
        "--yes",
        "false",
        "Machine-format mutation requires explicit --apply --yes",
      );
    }

    const declinedResult = previewResult(plan, dependencies, true);
    let reservedOutput = false;
    if (options.out !== undefined) {
      try {
        const reserveResultPath =
          dependencies.reserveManagedUpdateResultPath ?? reserveManagedUpdateResultPath;
        await reserveResultPath(options.out);
        reservedOutput = true;
      } catch (error) {
        if (error instanceof ManagedArtifactStorageError) throw artifactArgument(error, "--out");
        throw error;
      }
    }

    if (!options.yes) {
      const confirmed = await dependencies.confirm(
        `Apply ${actionable.length} image update(s) sequentially with image-only recovery?`,
      );
      if (!confirmed) {
        logInfo("Managed update cancelled");
        if (db !== undefined) {
          closeDatabaseBeforeResult(declinedResult, db, dependencies);
          db = undefined;
        }
        const reportPath =
          options.out === undefined
            ? await dependencies.saveManagedUpdateResult(declinedResult)
            : await dependencies.saveManagedUpdateResult(declinedResult, options.out, {
                overwrite: reservedOutput,
              });
        if (options.format === "text") displayResult(declinedResult, reportPath);
        await emitResult(declinedResult, options.format, dependencies);
        return;
      }
    }

    if (db === undefined) {
      db = await dependencies.initializeDatabase(getStateDbPath(finalConfig));
    }
    signals = installSignalTracker();
    const coordinatorDependencies = dependencies.createCoordinatorDependencies(
      db,
      signals.tracker,
      envTool,
    );
    logInfo(`Applying ${actionable.length} managed image update(s) sequentially...`);
    const result = await dependencies.runManagedUpdate(
      plan,
      {
        healthPoll: {
          timeoutSeconds: options.healthTimeout ?? finalConfig.healthCheck.timeout,
          intervalSeconds: finalConfig.healthCheck.interval,
          retries: finalConfig.healthCheck.retries,
        },
        projectDir: approvedProject.projectDir,
        envTool,
        dockerOptions: { envTool },
      },
      coordinatorDependencies,
    );
    closeDatabaseBeforeResult(result, db, dependencies);
    db = undefined;

    let reportPath: string;
    try {
      const writeOptions: ManagedArtifactWriteOptions = reservedOutput ? { overwrite: true } : {};
      reportPath = await dependencies.saveManagedUpdateResult(result, options.out, writeOptions);
    } catch (error) {
      if (error instanceof ManagedArtifactStorageError) throw artifactArgument(error, "--out");
      throw error;
    }
    if (options.format === "text") displayResult(result, reportPath);
    await emitResult(result, options.format, dependencies);
    if (result.success) logSuccess("Managed image update completed");
  } finally {
    signals?.dispose();
    if (db !== undefined) dependencies.closeDatabase(db);
  }
}
