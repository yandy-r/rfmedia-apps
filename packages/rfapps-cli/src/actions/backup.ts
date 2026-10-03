import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import { confirm, type OutputFormat } from "@rfmedia/common";

import {
  archiveBackupSource,
  BackupDockerError,
  inspectBackupHelper,
  observeRunningBackupContainers,
  prepareBackupHelper,
  probeBackupBindTopology,
  probeBackupSource,
  startBackupContainer,
  stopBackupWriterServices,
  type PrepareBackupHelperResult,
} from "../lib/backup-docker.js";
import {
  runBackup,
  type BackupCoordinatorDependencies,
  type RunBackupInput,
} from "../lib/backup-coordinator.js";
import { planBackup, type BackupPlannerInput } from "../lib/backup-planner.js";
import {
  publishBackupManifest,
  removeIncompleteBackupBundle,
  reserveBackupBundle,
  retainIncompleteBackupBundle,
  validateBackupDestination,
} from "../lib/backup-storage.js";
import {
  applyCliOverrides,
  getCanonicalComposeConfigEvidence,
  getComposeServices,
  getStateDbPath,
  isValidProfile,
  loadConfig,
  resolveServicesWithInteractive,
} from "../lib/index.js";
import {
  dockerAuthorityFingerprintFromEnvironment,
  isLocalDockerAuthorityFromEnvironment,
  resolveComposeProjectIdentity,
} from "../lib/identity.js";
import { captureEffectiveEnvironment } from "../lib/env-tools.js";
import type { ResolveServicesFn } from "../lib/interactive-selection.js";
import { acquireLifecycleLock } from "../lib/lifecycle-lock.js";
import { explicitSelectorFlagNames } from "../lib/selector.js";
import type { DockerExecOptions } from "../lib/docker.js";
import { deferSignal } from "../lib/deferred-signal.js";
import { InvalidArgumentError } from "../lib/errors.js";
import { setExitCode } from "../lib/exit-codes.js";
import { formatOutput } from "../lib/formatters/index.js";
import type { ComposeProjectIdentity } from "../lib/identity.js";
import { BACKUP_RESULT_SCHEMA_VERSION } from "../types/backup.js";
import type { RfappsConfig } from "../types/config.js";
import { getEnvToolExecConfig, type EnvToolExecConfig } from "../types/options.js";
import type {
  BackupCancelledResult,
  BackupDryRunResult,
  BackupError,
  BackupPlan,
  BackupResult,
} from "../types/backup.js";

export interface RawBackupOptions {
  readonly service?: string;
  readonly services?: string;
  readonly group?: string;
  /** Hierarchical tag patterns (`--tag`), one entry per occurrence. Never defaulted to `[]`. */
  readonly tag?: string[];
  readonly all?: boolean;
  readonly sidecars?: boolean;
  readonly destination?: string;
  readonly compose?: string;
  readonly envFile?: string;
  readonly profile?: string;
}

export interface BackupGlobalOptions {
  readonly dryRun?: boolean;
  readonly debug?: boolean;
  readonly json?: boolean;
  readonly output?: OutputFormat;
  readonly verbose?: boolean;
  readonly yes?: boolean;
  readonly useDotenvx?: string;
  readonly useOp?: string;
}

interface ResolvedBackupServices {
  readonly services: string[];
  readonly profiles: string[];
}

interface ResolvedBackupInvocation {
  readonly destinationPath: string;
  readonly format: OutputFormat;
  readonly requestedServices: readonly string[];
  readonly stateDir: string;
  readonly context: BackupExecutionContext;
}

export interface BackupExecutionContext {
  readonly dryRun: boolean;
  readonly composePath: string;
  readonly projectDir: string;
  readonly projectName: string;
  readonly envFile?: string;
  readonly profiles: readonly string[];
  readonly env: Record<string, string>;
  readonly replaceEnv: true;
}

interface BackupSignalTracker {
  readonly signal: AbortSignal;
  getInterruption(): "SIGINT" | "SIGTERM" | undefined;
}

export interface BackupActionDependencies {
  loadConfig(): Promise<RfappsConfig>;
  applyCliOverrides: typeof applyCliOverrides;
  /**
   * The shared resolver seam. Declared through {@link ResolveServicesFn} rather than
   * re-stated structurally so a new targeting axis cannot be added here and forgotten in
   * `reconcile`/`update` — a missed copy typechecks and silently drops the axis.
   */
  resolveServices: ResolveServicesFn<
    ResolvedBackupServices,
    Pick<DockerExecOptions, "env" | "replaceEnv">
  >;
  getComposeServices(
    composePath: string,
    options: {
      profiles?: string[];
      projectName?: string;
      envFile?: string;
      env?: Record<string, string>;
      replaceEnv?: boolean;
    },
  ): Promise<string[]>;
  resolveProjectIdentity(
    composePath: string,
    options?: {
      envFile?: string;
      env?: Record<string, string>;
      replaceEnv?: boolean;
    },
  ): Promise<ComposeProjectIdentity>;
  captureEnvironment(options: {
    tool: EnvToolExecConfig["tool"];
    envFile?: string;
    cwd: string;
  }): Promise<Record<string, string>>;
  loadPlannerInput(
    context: BackupExecutionContext,
    requestedServices: readonly string[],
    destinationPath: string,
    localDockerAuthority: boolean,
  ): Promise<BackupPlannerInput>;
  classifyDockerAuthority(context: BackupExecutionContext): Promise<boolean>;
  preparePlanningHelper(context: BackupExecutionContext): Promise<PrepareBackupHelperResult>;
  createCoordinatorDependencies(
    context: BackupExecutionContext,
    getPlanningHelper: () => Promise<PrepareBackupHelperResult>,
    signal: BackupSignalTracker,
  ): BackupCoordinatorDependencies;
  runBackup: typeof runBackup;
  confirm(message: string): Promise<boolean>;
  formatOutput: typeof formatOutput;
  now(): Date;
  reraiseSignal(signal: "SIGINT" | "SIGTERM"): void;
}

function dockerOptions(context: BackupExecutionContext) {
  return {
    cwd: context.projectDir,
    env: context.env,
    replaceEnv: context.replaceEnv,
  };
}

async function loadPlannerInput(
  context: BackupExecutionContext,
  requestedServices: readonly string[],
  destinationPath: string,
  localDockerAuthority: boolean,
): Promise<BackupPlannerInput> {
  const [composeEvidence, authorityFingerprint] = await Promise.all([
    getCanonicalComposeConfigEvidence(context.composePath, {
      cwd: context.projectDir,
      envFile: context.envFile,
      profiles: context.profiles,
      projectName: context.projectName,
      env: context.env,
      replaceEnv: context.replaceEnv,
    }),
    dockerAuthorityFingerprintFromEnvironment(context.env),
  ]);
  return {
    composeEvidence,
    requestedServices: [...requestedServices],
    canonicalDestination: destinationPath,
    dockerAuthorityFingerprint: authorityFingerprint,
    localDockerAuthority,
  };
}

async function preparePlanningHelper(
  context: BackupExecutionContext,
): Promise<PrepareBackupHelperResult> {
  const options = dockerOptions(context);
  if (!context.dryRun) return prepareBackupHelper(options);
  const helper = await inspectBackupHelper(options);
  if (helper !== undefined) return helper;
  throw new BackupDockerError(
    "The pinned backup helper is not available for a no-pull dry-run source probe",
    "SOURCE_PROBE_FAILED",
    "validate",
  );
}

function createProductionCoordinatorDependencies(
  context: BackupExecutionContext,
  getPlanningHelper: () => Promise<PrepareBackupHelperResult>,
  signal: BackupSignalTracker,
): BackupCoordinatorDependencies {
  const options = dockerOptions(context);
  const composeOptions = {
    ...options,
    projectName: context.projectName,
    envFile: context.envFile,
    profiles: context.profiles,
  };
  return {
    validateDestination: validateBackupDestination,
    plan: async (input) => {
      const helper = await getPlanningHelper();
      return planBackup(input, {
        probeSource: (source) => probeBackupSource(source, helper.resolvedImageId, options),
        probeBindTopology: (sourcePaths) =>
          probeBackupBindTopology(sourcePaths, helper.resolvedImageId, options),
      });
    },
    reserveBundle: reserveBackupBundle,
    prepareHelper: () => prepareBackupHelper(options),
    inspectHelper: () => inspectBackupHelper(options),
    acquireLock: acquireLifecycleLock,
    observeRunning: (composePath, writerServices) =>
      observeRunningBackupContainers(composePath, writerServices, composeOptions),
    stopWriters: (composePath, writerServices) =>
      stopBackupWriterServices(composePath, writerServices, composeOptions),
    archiveSource: (source, destinationPath, resolvedImageId) =>
      archiveBackupSource({
        source,
        destinationPath,
        resolvedImageId,
        ...options,
        signal: signal.signal,
      }),
    startContainer: (containerId) => startBackupContainer(containerId, options),
    publishManifest: publishBackupManifest,
    removeIncompleteBundle: removeIncompleteBackupBundle,
    retainIncompleteBundle: retainIncompleteBackupBundle,
    now: () => new Date(),
    randomId: randomUUID,
    getInterruption: () => signal.getInterruption(),
  };
}

const defaultDependencies: BackupActionDependencies = {
  loadConfig,
  applyCliOverrides,
  resolveServices: resolveServicesWithInteractive,
  getComposeServices,
  resolveProjectIdentity: resolveComposeProjectIdentity,
  captureEnvironment: captureEffectiveEnvironment,
  loadPlannerInput,
  classifyDockerAuthority: (context) => isLocalDockerAuthorityFromEnvironment(context.env),
  preparePlanningHelper,
  createCoordinatorDependencies: createProductionCoordinatorDependencies,
  runBackup,
  confirm,
  formatOutput,
  now: () => new Date(),
  reraiseSignal: deferSignal,
};

function resolvedFormat(options: BackupGlobalOptions): OutputFormat {
  return options.output ?? (options.json === true ? "json" : "text");
}

function parsedServices(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const services = value.split(",").map((service) => service.trim());
  if (services.length === 0 || services.some((service) => service === "")) {
    throw new InvalidArgumentError(
      "--services",
      value,
      "Must be a comma-separated list of service names",
    );
  }
  return services;
}

function installSignalTracker(): { tracker: BackupSignalTracker; dispose(): void } {
  const controller = new AbortController();
  let interruption: "SIGINT" | "SIGTERM" | undefined;
  const onSigint = () => {
    interruption ??= "SIGINT";
    controller.abort();
  };
  const onSigterm = () => {
    interruption ??= "SIGTERM";
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    tracker: {
      signal: controller.signal,
      getInterruption: () => interruption,
    },
    dispose() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

function backupBundleName(projectName: string, now: Date): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  const safeProject = projectName.replace(/[^A-Za-z0-9._-]/gu, "-");
  return `rfapps-backup-${safeProject}-${timestamp}`;
}

function renderPlan(result: BackupDryRunResult): void {
  console.error("Native backup plan");
  console.error(`Destination: ${result.destinationPath}`);
  console.error(`Services: ${result.resolvedServices.join(", ")}`);
  console.error(`Writer services: ${result.writerServices.join(", ") || "none"}`);
  for (const mount of result.planned) {
    const source = mount.source.kind === "bind" ? mount.source.path : mount.source.name;
    console.error(`  ${mount.artifactPath} <- ${mount.source.kind}:${source}`);
  }
}

function renderResult(result: BackupResult): void {
  console.error(`Native backup: ${result.status}`);
  console.error(`Destination: ${result.destinationPath}`);
  if ("bundlePath" in result && result.bundlePath !== undefined) {
    console.error(`Bundle: ${result.bundlePath}`);
  }
  if ("manifestPath" in result && result.manifestPath !== undefined) {
    console.error(`Manifest: ${result.manifestPath}`);
  }
  console.error(
    `Artifacts: ${result.summary.archivedArtifacts}/${result.summary.plannedArtifacts} archived`,
  );
  for (const error of result.errors) {
    console.error(`  ${error.code}: ${error.message}`);
  }
  for (const failure of result.recoveryFailures) {
    console.error(`  recovery ${failure.service}: ${failure.code}`);
  }
}

function cancellationFailure(code: "APPROVAL_DECLINED" | "INTERRUPTED"): BackupError {
  return {
    kind: "operational",
    stage: "cancelled",
    code,
    message:
      code === "INTERRUPTED"
        ? "Backup was interrupted; cleanup completed before termination"
        : "Backup was cancelled before mutation",
  };
}

function cancelledResult(
  preview: BackupDryRunResult,
  code: "APPROVAL_DECLINED" | "INTERRUPTED" = "APPROVAL_DECLINED",
): BackupCancelledResult {
  const primaryFailure = cancellationFailure(code);
  return {
    ...preview,
    status: "cancelled",
    success: false,
    exitCode: 2,
    dryRun: false,
    errors: [primaryFailure],
    primaryFailure,
    recoveryFailures: [],
    stagingDisposition: "none",
  };
}

function interruptedDryRunResult(preview: BackupDryRunResult): BackupResult {
  const primaryFailure = cancellationFailure("INTERRUPTED");
  return {
    ...preview,
    status: "failed",
    success: false,
    exitCode: 2,
    errors: [primaryFailure],
    primaryFailure,
  };
}

function interruptSuccessfulResult(result: BackupResult): BackupResult {
  if (!result.success) return result;
  if (result.dryRun) return interruptedDryRunResult(result);
  const primaryFailure = cancellationFailure("INTERRUPTED");
  return {
    ...result,
    status: "cancelled",
    success: false,
    exitCode: 2,
    errors: [primaryFailure],
    primaryFailure,
  };
}

function realPreflightFailure(result: BackupResult): BackupResult {
  if (result.success || !result.dryRun) return result;
  return {
    ...result,
    dryRun: false,
    recoveryFailures: [],
    stagingDisposition: "none",
  };
}

async function emitResult(
  result: BackupResult,
  format: OutputFormat,
  dependencies: Pick<BackupActionDependencies, "formatOutput">,
): Promise<void> {
  if (format === "text" || format === "table") {
    renderResult(result);
  } else {
    await dependencies.formatOutput(format, result);
  }
  if (result.exitCode !== 0) setExitCode(result.exitCode);
}

function validateBackupInvocation(
  rawOptions: RawBackupOptions,
  globalOptions: BackupGlobalOptions,
): { destinationPath: string; format: OutputFormat } {
  const destinationPath = rawOptions.destination;
  if (destinationPath === undefined || destinationPath.trim() === "") {
    throw new InvalidArgumentError(
      "--destination",
      destinationPath ?? "",
      "Must name an existing destination directory",
    );
  }
  const format = resolvedFormat(globalOptions);
  if (format === "csv") {
    throw new InvalidArgumentError(
      "--output",
      "csv",
      "CSV output cannot represent backup storage and recovery evidence",
      ["json", "yaml", "table", "text"],
    );
  }
  // Selector site 6. The flag names come from lib/selector.ts, not a local array literal:
  // a copy that predates --tag computes explicitTarget = false for
  // `backup --tag "media/**" --yes` and refuses a backup that does have a target, while
  // simultaneously letting `backup --all --tag "media/**"` past the mutual-exclusion
  // check so the whole project is archived with --tag silently ignored.
  const selectorFlags = explicitSelectorFlagNames(rawOptions);
  if (rawOptions.all === true && selectorFlags.length > 0) {
    throw new InvalidArgumentError(
      "--all",
      "true",
      `Cannot combine --all with ${selectorFlags.join(", ")}`,
    );
  }
  const machine = format === "json" || format === "yaml";
  const explicitTarget = rawOptions.all === true || selectorFlags.length > 0;
  if (!explicitTarget && (globalOptions.yes === true || machine || process.stdin.isTTY !== true)) {
    throw new InvalidArgumentError(
      "--all",
      "false",
      "Backup requires an explicit service target or --all in non-interactive, machine, or --yes mode",
    );
  }
  if (machine && globalOptions.yes !== true) {
    throw new InvalidArgumentError(
      "--yes",
      "false",
      "Machine-format backup creation requires explicit --yes",
    );
  }
  return { destinationPath, format };
}

async function resolveBackupInvocation(
  rawOptions: RawBackupOptions,
  globalOptions: BackupGlobalOptions,
  dependencies: BackupActionDependencies,
): Promise<ResolvedBackupInvocation | undefined> {
  const { destinationPath, format } = validateBackupInvocation(rawOptions, globalOptions);
  const config = await dependencies.loadConfig();
  if (rawOptions.profile !== undefined && !isValidProfile(rawOptions.profile, config)) {
    throw new InvalidArgumentError(
      "--profile",
      rawOptions.profile,
      "Unknown profile",
      config.profiles.validProfiles,
    );
  }
  const finalConfig = dependencies.applyCliOverrides(config, {
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
    noSidecars: rawOptions.sidecars === false,
  });
  const envTool = getEnvToolExecConfig(globalOptions, finalConfig);
  const capturedEnvironment = await dependencies.captureEnvironment({
    tool: envTool?.tool ?? "none",
    ...(envTool?.envFile === undefined ? {} : { envFile: envTool.envFile }),
    cwd: dirname(resolve(finalConfig.composePath)),
  });
  const pinnedExecution = {
    env: capturedEnvironment,
    replaceEnv: true as const,
  };
  const identity = await dependencies.resolveProjectIdentity(finalConfig.composePath, {
    envFile: finalConfig.envFile,
    ...pinnedExecution,
  });

  let requestedServices: string[];
  let profiles: string[];
  if (rawOptions.all === true) {
    profiles = [rawOptions.profile ?? finalConfig.profiles.defaultProfile];
    requestedServices = await dependencies.getComposeServices(identity.composePath, {
      profiles,
      projectName: identity.projectName,
      envFile: finalConfig.envFile,
      ...pinnedExecution,
    });
  } else {
    const resolved = await dependencies.resolveServices(
      {
        service: rawOptions.service,
        services: parsedServices(rawOptions.services),
        group: rawOptions.group,
        tag: rawOptions.tag,
        noSidecars: rawOptions.sidecars === false,
        sidecars: rawOptions.sidecars,
        yes: globalOptions.yes,
      },
      finalConfig,
      identity.composePath,
      identity.projectDir,
      pinnedExecution,
    );
    if (resolved === null) {
      setExitCode(2);
      return undefined;
    }
    requestedServices = resolved.services;
    profiles = resolved.profiles;
  }
  if (requestedServices.length === 0) {
    throw new InvalidArgumentError(
      "--all",
      String(rawOptions.all === true),
      "Backup selection resolved to no services",
    );
  }

  return {
    destinationPath,
    format,
    requestedServices,
    stateDir: dirname(getStateDbPath(finalConfig)),
    context: {
      dryRun: globalOptions.dryRun === true,
      composePath: identity.composePath,
      projectDir: identity.projectDir,
      projectName: identity.projectName,
      envFile: finalConfig.envFile,
      profiles,
      ...pinnedExecution,
    },
  };
}

interface BackupPlanningSession {
  readonly coordinatorDependencies: BackupCoordinatorDependencies;
  readonly getPlanningHelper: () => Promise<PrepareBackupHelperResult>;
  readonly loadCurrentPlannerInput: () => Promise<BackupPlannerInput>;
}

function createBackupPlanningSession(
  invocation: ResolvedBackupInvocation,
  dependencies: BackupActionDependencies,
  signal: BackupSignalTracker,
): BackupPlanningSession {
  let helper: Promise<PrepareBackupHelperResult> | undefined;
  const getPlanningHelper = () => {
    helper ??= dependencies.preparePlanningHelper(invocation.context);
    return helper;
  };
  const coordinatorDependencies = dependencies.createCoordinatorDependencies(
    invocation.context,
    getPlanningHelper,
    signal,
  );
  const loadCurrentPlannerInput = async () => {
    const localDockerAuthority = await dependencies.classifyDockerAuthority(invocation.context);
    return dependencies.loadPlannerInput(
      invocation.context,
      invocation.requestedServices,
      invocation.destinationPath,
      localDockerAuthority,
    );
  };
  return { coordinatorDependencies, getPlanningHelper, loadCurrentPlannerInput };
}

function boundedFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "PLANNER_INPUT_UNAVAILABLE";
}

function initialPlannerFailureResult(
  invocation: ResolvedBackupInvocation,
  backupId: string,
  startedAt: Date,
  completedAt: Date,
  error: unknown,
): BackupResult {
  const primaryFailure: BackupError = {
    kind: "operational",
    stage: "validate",
    code: boundedFailureCode(error),
    message: "Backup authority and planner evidence could not be established",
  };
  const base = {
    schemaVersion: BACKUP_RESULT_SCHEMA_VERSION,
    operation: "backup" as const,
    backupId,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    requestedServices: [...invocation.requestedServices].sort(),
    resolvedServices: [],
    writerServices: [],
    previouslyRunningContainerIds: [],
    destinationPath: invocation.destinationPath,
    planned: [],
    skipped: [],
    artifacts: [],
    warnings: [],
    summary: {
      requestedServices: invocation.requestedServices.length,
      resolvedServices: 0,
      writerServices: 0,
      previouslyRunningContainers: 0,
      plannedArtifacts: 0,
      archivedArtifacts: 0,
      skippedSources: 0,
      failedArtifacts: 0,
      recoveryFailures: 0,
    },
    status: "failed" as const,
    success: false as const,
    exitCode: 2 as const,
    errors: [primaryFailure] as [BackupError],
    primaryFailure,
    recoveryFailures: [] as [],
    stagingDisposition: "none" as const,
  };
  return invocation.context.dryRun ? { ...base, dryRun: true } : { ...base, dryRun: false };
}

interface ReadyBackupPreview {
  readonly ready: true;
  readonly input: RunBackupInput;
  readonly preview: BackupDryRunResult;
  readonly reviewedPlan?: BackupPlan;
  readonly session: BackupPlanningSession;
}

interface TerminalBackupPreview {
  readonly ready: false;
  readonly result: BackupResult;
}

async function constructBackupPreview(
  invocation: ResolvedBackupInvocation,
  session: BackupPlanningSession,
  signal: BackupSignalTracker,
  dependencies: BackupActionDependencies,
): Promise<ReadyBackupPreview | TerminalBackupPreview> {
  const startedAt = dependencies.now();
  const bundleName = backupBundleName(invocation.context.projectName, startedAt);
  let initialPlannerInput: BackupPlannerInput;
  try {
    initialPlannerInput = await session.loadCurrentPlannerInput();
  } catch (error) {
    return {
      ready: false,
      result: initialPlannerFailureResult(
        invocation,
        bundleName,
        startedAt,
        dependencies.now(),
        error,
      ),
    };
  }
  const input: RunBackupInput = {
    dryRun: true,
    destinationPath: invocation.destinationPath,
    bundleName,
    composePath: invocation.context.composePath,
    projectDir: invocation.context.projectDir,
    stateDir: invocation.stateDir,
    plannerInput: initialPlannerInput,
    loadRevalidationInput: session.loadCurrentPlannerInput,
  };

  let reviewedPlan: BackupPlan | undefined;
  const previewDependencies: BackupCoordinatorDependencies = {
    ...session.coordinatorDependencies,
    plan: async (plannerInput) => {
      const plan = await session.coordinatorDependencies.plan(plannerInput);
      reviewedPlan = plan;
      return plan;
    },
  };
  let preview = await dependencies.runBackup(input, previewDependencies);
  if (signal.getInterruption() !== undefined && preview.success && preview.status === "planned") {
    preview = invocation.context.dryRun
      ? interruptedDryRunResult(preview)
      : cancelledResult(preview, "INTERRUPTED");
  }
  if (!preview.success || preview.status !== "planned") {
    return {
      ready: false,
      result: invocation.context.dryRun ? preview : realPreflightFailure(preview),
    };
  }
  return { ready: true, input, preview, reviewedPlan, session };
}

async function authorizeBackup(
  preview: BackupDryRunResult,
  globalOptions: BackupGlobalOptions,
  signal: BackupSignalTracker,
  dependencies: BackupActionDependencies,
): Promise<BackupResult | undefined> {
  renderPlan(preview);
  if (signal.getInterruption() !== undefined) {
    return cancelledResult(preview, "INTERRUPTED");
  }
  if (globalOptions.yes === true) return undefined;
  const approved = await dependencies.confirm(
    `Create ${String(preview.summary.plannedArtifacts)} archive(s) after stopping ${String(preview.summary.writerServices)} writer service(s)?`,
  );
  if (signal.getInterruption() !== undefined) {
    return cancelledResult(preview, "INTERRUPTED");
  }
  return approved ? undefined : cancelledResult(preview);
}

async function executeApprovedBackup(
  ready: ReadyBackupPreview,
  signal: BackupSignalTracker,
  dependencies: BackupActionDependencies,
): Promise<BackupResult> {
  let reusedReviewedPlan = false;
  const executionDependencies: BackupCoordinatorDependencies = {
    ...ready.session.coordinatorDependencies,
    plan: async (plannerInput) => {
      if (!reusedReviewedPlan && ready.reviewedPlan !== undefined) {
        reusedReviewedPlan = true;
        return ready.reviewedPlan;
      }
      return ready.session.coordinatorDependencies.plan(plannerInput);
    },
  };
  const reviewedHelper = await ready.session.getPlanningHelper();
  if (signal.getInterruption() !== undefined) {
    return cancelledResult(ready.preview, "INTERRUPTED");
  }
  const result = await dependencies.runBackup(
    { ...ready.input, dryRun: false, reviewedHelper },
    executionDependencies,
  );
  return signal.getInterruption() === undefined ? result : interruptSuccessfulResult(result);
}

/**
 * Resolve, preview, authorize, and execute one native cold backup.
 *
 * The complete preview plan is cached for the coordinator's initial real pass;
 * the coordinator still performs its mandatory fresh locked revalidation.
 */
export async function executeBackup(
  rawOptions: RawBackupOptions,
  globalOptions: BackupGlobalOptions,
  dependencies: BackupActionDependencies = defaultDependencies,
): Promise<void> {
  const invocation = await resolveBackupInvocation(rawOptions, globalOptions, dependencies);
  if (invocation === undefined) return;
  const signals = installSignalTracker();
  try {
    const session = createBackupPlanningSession(invocation, dependencies, signals.tracker);
    const preview = await constructBackupPreview(
      invocation,
      session,
      signals.tracker,
      dependencies,
    );
    if (!preview.ready) {
      await emitResult(preview.result, invocation.format, dependencies);
      return;
    }
    if (invocation.context.dryRun) {
      await emitResult(preview.preview, invocation.format, dependencies);
      return;
    }
    const approvalFailure = await authorizeBackup(
      preview.preview,
      globalOptions,
      signals.tracker,
      dependencies,
    );
    if (approvalFailure !== undefined) {
      await emitResult(approvalFailure, invocation.format, dependencies);
      return;
    }
    const result = await executeApprovedBackup(preview, signals.tracker, dependencies);
    await emitResult(result, invocation.format, dependencies);
  } finally {
    const interruption = signals.tracker.getInterruption();
    signals.dispose();
    if (interruption !== undefined) dependencies.reraiseSignal(interruption);
  }
}
