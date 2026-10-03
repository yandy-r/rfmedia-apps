/**
 * Deploy command action for rfapps CLI
 *
 * Deploys Docker services with:
 * - Automatic image pull (unless --skip-pull)
 * - Service startup with health checks
 * - Automatic sidecar linking
 * - Service group expansion
 * - Profile support
 */

import {
  logInfo,
  logSuccess,
  logWarn,
  logDebug,
  formatDryRun,
  confirm,
  isMachineFormat,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";

import type { OutputFormat } from "@rfmedia/common";

import { formatOutput, projectConflictValidationTable } from "../lib/formatters/index.js";
import {
  ConfigValidationError,
  ImagePullError,
  ServiceStartError,
  DockerCommandError,
  InvalidArgumentError,
  ProfileNotFoundError,
} from "../lib/errors.js";
import { ExitCode, setDeployExitCode, setExitCode } from "../lib/exit-codes.js";

import type {
  DependencyGraph,
  DeployOptions,
  DeployResult,
  ConflictValidationResult,
  StagedExecutionContext,
  StagedPlan,
} from "../types/index.js";
import { getEnvToolExecConfig, isStagedFailurePolicy } from "../types/index.js";
import type { ScanReport } from "../types/security-scan.js";

import {
  loadConfig,
  applyCliOverrides,
  pullImages,
  startServices,
  getRunningContainers,
  waitForDependencyReadiness,
  isValidProfile,
  resolveServicesWithInteractive,
  initializeDatabase,
  recordDeployments,
  closeDatabase,
  inspectContainersWithRetry,
  computeExecutionPhases,
  executeParallelPhases,
  formatExecutionPlan,
  formatConflictValidationText,
  planStagedBatches,
  executeStagedRollout,
  summarizeStagedRollout,
  formatStagedPlan,
  formatStagedEvent,
  formatStagedSummary,
  stagedExceedsLockStaleness,
  waitForBatchReady,
  createBatchObserver,
  getComposeConfig,
  resolveScanSettings,
  resolveScanTargets,
  runSecurityScan,
  formatScanText,
} from "../lib/index.js";
import {
  canonicalizeDeployEnvTool,
  composeExecutionOptions,
  inconclusiveValidation,
  revalidateDeployBinding,
  runDeployValidation,
  validationDependencyGraph,
  validationFailureFromError,
  validationScope,
  type DeployValidationOutcome,
} from "../lib/deploy-validation.js";
import type { DockerComposeExecOptions } from "../lib/docker.js";
import {
  validateConfigAgainstCompose,
  formatValidationWarnings,
  hasErrors,
} from "../lib/validation.js";

/**
 * Parse raw deploy options from CLI
 */
interface RawDeployOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  skipPull?: boolean;
  forceRecreate?: boolean;
  allowPartial?: boolean;
  waitForReady?: boolean;
  healthTimeout?: number | string;
  compose?: string;
  envFile?: string;
  profile?: string;
  parallel?: boolean;
  workers?: number | string;
  validateFirst?: boolean;
  scan?: boolean;
  scanner?: string;
  scanFailOn?: string;
  staged?: boolean;
  batchSize?: number | string;
  onFailure?: string;
}

function validationFailureEntry(status: "blocked" | "inconclusive"): {
  name: string;
  code: string;
  error: string;
} {
  return status === "blocked"
    ? {
        name: "validation",
        code: "SERVICE_CONFLICT",
        error: "Pre-deploy validation found blocking conflicts",
      }
    : {
        name: "validation",
        code: "VALIDATION_INCONCLUSIVE",
        error: "Pre-deploy validation could not collect complete evidence",
      };
}

function scanFailureEntry(status: "blocked" | "inconclusive"): {
  name: string;
  code: string;
  error: string;
} {
  return status === "blocked"
    ? {
        name: "scan",
        code: "VULNERABILITY_THRESHOLD",
        error: "Image vulnerability scan found findings at or above the configured severity",
      }
    : {
        name: "scan",
        code: "SCAN_INCONCLUSIVE",
        error: "Image vulnerability scan could not complete for every target",
      };
}

/**
 * Compact severity annotation for the deploy confirmation prompt.
 *
 * A non-blocking scan still produces findings the operator must see before
 * answering "yes". Returns "" when there is no scan or no surviving finding, so
 * the prompt text is byte-identical to today without `--scan`.
 */
function scanConfirmAnnotation(report: ScanReport | undefined): string {
  if (report === undefined || report.summary.total === 0) {
    return "";
  }

  const severities = ["critical", "high", "medium", "low", "negligible", "unknown"] as const;
  const parts = severities
    .filter((severity) => report.summary[severity] > 0)
    .map((severity) => `${report.summary[severity]} ${severity}`);

  return parts.length === 0 ? "" : ` [scan: ${parts.join(", ")}]`;
}

async function outputValidationFailure(format: OutputFormat, result: DeployResult): Promise<void> {
  const validation = result.validation;
  if (validation === undefined) return;
  if (format === "text" || format === "table") {
    await outputConflictValidation(format, validation);
  } else {
    await formatOutput(format, result);
  }
}

async function outputConflictValidation(
  format: "text" | "table",
  validation: ConflictValidationResult,
): Promise<void> {
  if (format === "text") {
    for (const line of formatConflictValidationText(validation)) {
      logInfo(line);
    }
  } else {
    await formatOutput("table", projectConflictValidationTable(validation), {
      columns: ["field", "value"],
    });
  }
}

function deployResultForOutput(format: OutputFormat, result: DeployResult): DeployResult | object {
  const flattens = format === "table" || format === "csv";
  if (
    !flattens ||
    (result.validation === undefined && result.staged === undefined && result.scan === undefined)
  ) {
    return result;
  }

  const { validation: _validation, staged: _staged, scan: _scan, ...deployResult } = result;
  return deployResult;
}

async function outputDeployResult(format: OutputFormat, result: DeployResult): Promise<void> {
  await formatOutput(format, deployResultForOutput(format, result));
}

/**
 * Execute the deploy command.
 *
 * Deploys Docker services with a two-phase approach:
 * 1. Pull images (unless --skip-pull)
 * 2. Start services with optional force-recreate
 *
 * Automatically handles sidecar linking when services use Tailscale sidecars.
 * When sidecars are expanded, force-recreate is auto-enabled to prevent stale
 * network state issues.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode, secrets injection, etc.)
 *
 * @example
 * ```typescript
 * // Deploy a specific service
 * await executeDeploy({ service: 'traefik' }, { yes: true });
 *
 * // Deploy with 1Password secrets injection
 * await executeDeploy({}, { useOp: '.env.local', yes: true });
 * ```
 */
export async function executeDeploy(
  rawOptions: RawDeployOptions,
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
): Promise<void> {
  const invocationCwd = process.cwd();
  const configuredEnvTool = getEnvToolExecConfig(globalOptions);
  // Build options
  const options: DeployOptions = {
    dryRun: globalOptions.dryRun ?? false,
    debug: globalOptions.debug ?? false,
    json: globalOptions.json ?? false,
    verbose: globalOptions.verbose ?? false,
    yes: globalOptions.yes ?? false,
    service: rawOptions.service,
    services: rawOptions.services?.split(",").map((s) => s.trim()),
    group: rawOptions.group,
    tag: rawOptions.tag,
    noSidecars: rawOptions.sidecars === false,
    validateFirst: rawOptions.validateFirst ?? false,
    scan: rawOptions.scan ?? false,
    skipPull: rawOptions.skipPull ?? false,
    forceRecreate: rawOptions.forceRecreate ?? false,
    allowPartial: rawOptions.allowPartial ?? false,
    waitForReady: rawOptions.waitForReady ?? true,
    healthTimeout:
      typeof rawOptions.healthTimeout === "string"
        ? Number.parseInt(rawOptions.healthTimeout, 10)
        : (rawOptions.healthTimeout ?? 0),
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
    parallel: rawOptions.parallel,
    workers:
      typeof rawOptions.workers === "string"
        ? Number.parseInt(rawOptions.workers, 10)
        : rawOptions.workers,
    staged: rawOptions.staged ?? false,
    batchSize:
      typeof rawOptions.batchSize === "string"
        ? Number.parseInt(rawOptions.batchSize, 10)
        : rawOptions.batchSize,
    onFailure: isStagedFailurePolicy(rawOptions.onFailure) ? rawOptions.onFailure : undefined,
  };

  const format = globalOptions.output ?? "text";
  if (options.validateFirst && format === "csv") {
    throw new InvalidArgumentError(
      "--output",
      "csv",
      "CSV output is not supported with --validate-first",
      ["json", "yaml", "table", "text"],
    );
  }
  if (
    !options.staged &&
    (rawOptions.batchSize !== undefined || rawOptions.onFailure !== undefined)
  ) {
    // Report the flag the operator actually typed; naming --batch-size for a
    // lone --on-failure points at an option that never appeared in the argv.
    const suppliedFlag = rawOptions.batchSize !== undefined ? "--batch-size" : "--on-failure";
    throw new InvalidArgumentError(
      suppliedFlag,
      String(rawOptions.batchSize ?? rawOptions.onFailure),
      "Staged rollout options require --staged",
    );
  }
  if (!options.scan && (rawOptions.scanner !== undefined || rawOptions.scanFailOn !== undefined)) {
    // Report the flag the operator actually typed.
    const suppliedFlag = rawOptions.scanner !== undefined ? "--scanner" : "--scan-fail-on";
    throw new InvalidArgumentError(
      suppliedFlag,
      String(rawOptions.scanner ?? rawOptions.scanFailOn),
      "Scan options require --scan",
    );
  }
  if (
    rawOptions.batchSize !== undefined &&
    (options.batchSize === undefined ||
      !Number.isInteger(options.batchSize) ||
      options.batchSize < 1)
  ) {
    throw new InvalidArgumentError(
      "--batch-size",
      String(rawOptions.batchSize),
      "Batch size must be a positive integer",
    );
  }
  const envTool = options.validateFirst
    ? await canonicalizeDeployEnvTool(configuredEnvTool, invocationCwd)
    : configuredEnvTool;

  logDebug(`Deploy options: ${JSON.stringify(options)}`);

  // Load configuration
  const config = await loadConfig();
  if (options.profile !== undefined && !isValidProfile(options.profile, config)) {
    throw new ProfileNotFoundError(options.profile, config.profiles.validProfiles);
  }
  const finalConfig = applyCliOverrides(config, {
    composePath: options.composePath,
    envFile: options.envFile,
    profile: options.profile,
    noSidecars: options.noSidecars,
  });

  const healthTimeout =
    Number.isFinite(options.healthTimeout) && options.healthTimeout > 0
      ? options.healthTimeout
      : finalConfig.healthCheck.timeout;
  const waitForReady = rawOptions.waitForReady ?? finalConfig.healthCheck.waitForReady;

  // Resolve parallel execution options from CLI flags -> config defaults
  const staged = options.staged ?? false;
  const batchSize =
    options.batchSize !== undefined && Number.isFinite(options.batchSize) && options.batchSize > 0
      ? options.batchSize
      : 1;
  const onFailure = options.onFailure ?? "halt";
  const configParallel = options.parallel ?? finalConfig.parallel.enabled;
  const useParallel = staged || configParallel;
  if (staged && !configParallel) {
    logInfo("--staged uses dependency-phased execution");
  }
  if (staged && !waitForReady) {
    logWarn(
      "Staged health gating is disabled (--no-wait-for-ready or healthCheck.waitForReady: false); batches will not halt on unhealthy services",
    );
  }
  const workerCount =
    options.workers !== undefined && Number.isFinite(options.workers) && options.workers > 0
      ? options.workers
      : finalConfig.parallel.workers;

  // Validate configuration against compose.yml
  const validationWarnings = await validateConfigAgainstCompose(
    finalConfig,
    finalConfig.composePath,
  );
  if (validationWarnings.length > 0) {
    const warningMessages = formatValidationWarnings(validationWarnings);
    warningMessages.forEach((warning) => logWarn(warning));

    if (hasErrors(validationWarnings)) {
      const error = new ConfigValidationError(
        "compose",
        finalConfig.composePath,
        "Configuration validation failed. Please fix errors before deploying.",
      );
      const formatted = formatError(error);
      outputFormattedError(formatted);
      setExitCode(ExitCode.OperationalError);
      return;
    }
  }

  // Resolve services with interactive selection support
  const resolved = await resolveServicesWithInteractive(
    {
      service: options.service,
      services: options.services,
      group: options.group,
      tag: options.tag,
      noSidecars: options.noSidecars,
      sidecars: options.noSidecars === true ? false : undefined,
      yes: options.yes,
    },
    finalConfig,
    finalConfig.composePath,
    invocationCwd,
    { envTool },
  );

  if (resolved === null) {
    return; // User cancelled or no services selected
  }

  let services = resolved.services;
  const { profiles, sidecarsExpanded } = resolved;

  // An unresolved target is the empty "all services" sentinel, and the phased
  // path is entered only for `services.length > 0`. Without this gate `--staged`
  // would be silently dropped and the whole fleet deployed unstaged. Fail closed
  // rather than expanding the sentinel, which would change the compose
  // invocation shape and profile selection.
  if (staged && services.length === 0) {
    throw new InvalidArgumentError(
      "--staged",
      "true",
      "staged rollout requires an explicit service target; pass -g <group>, --services a,b,c, or -s <service>",
    );
  }

  // Create the shared result envelope before the validation/dry-run split so
  // every structured preflight outcome is emitted exactly once.
  const result: DeployResult = {
    services: [],
    failed: [],
    healthy: [],
    unhealthy: [],
    started: 0,
  };

  let validationPass: DeployValidationOutcome | undefined;
  if (options.validateFirst) {
    try {
      const validationOutcome = await runDeployValidation(
        finalConfig.composePath,
        finalConfig.envFile,
        profiles,
        services,
        envTool,
      );
      services = validationOutcome.effectiveServices;
      result.validation = validationOutcome.result;
      if (validationOutcome.result.status === "passed") {
        validationPass = validationOutcome;
      }
    } catch (error) {
      const scope = validationScope("unknown", services, profiles);
      result.validation = inconclusiveValidation(scope, validationFailureFromError(error));
    }

    if (result.validation.status !== "passed") {
      result.failed.push(validationFailureEntry(result.validation.status));
      await outputValidationFailure(format, result);
      setExitCode(ExitCode.OperationalError);
      return;
    }
  }

  const deployComposePath = validationPass?.binding.composePath ?? finalConfig.composePath;
  const deployExecution =
    validationPass === undefined ? { envTool } : composeExecutionOptions(validationPass.binding);

  // `options.scan` is only ever true on the CLI path: `scan`/`scanner`/`scanFailOn`
  // are absent from `deployInputSchema` and are not forwarded by `invokeDeploy`
  // (src/mcp/adapters.ts), so `result.scan` is never CREATED on the MCP path.
  // `deployResultSchema` is `additionalProperties: false` and its strict-key
  // check reads `Object.keys(result)`, so assigning `undefined` would break it.
  if (options.scan) {
    const settings = resolveScanSettings(rawOptions, finalConfig.scan, invocationCwd);
    const composeConfig = await getComposeConfig(deployComposePath, {
      profiles,
      envFile: finalConfig.envFile,
      ...deployExecution,
    });
    if (composeConfig === undefined) {
      const error = new DockerCommandError(
        "config",
        "Failed to resolve compose config for scanning",
        1,
        services.length > 0 ? services : ["all"],
        false,
      );
      outputFormattedError(formatError(error));
      setExitCode(ExitCode.OperationalError);
      return;
    }

    const { targets, skipped } = resolveScanTargets(composeConfig, services, settings.maxTargets);
    result.scan = await runSecurityScan(
      targets,
      skipped,
      { services, profiles, composePath: deployComposePath },
      settings,
    );

    if (format === "text" || format === "table") {
      for (const line of formatScanText(result.scan)) {
        logInfo(line);
      }
    }
  }

  // Auto-enable forceRecreate when deploying services with sidecars
  // This prevents stale network state issues when main service is recreated but sidecar isn't
  const forceRecreate = options.forceRecreate || (sidecarsExpanded && services.length > 0);

  logDebug(`Using profiles: ${profiles.join(", ")}`);
  logDebug(`Deploying services: ${services.length > 0 ? services.join(", ") : "all"}`);
  if (forceRecreate) {
    logDebug(`Force recreate enabled${sidecarsExpanded ? " (sidecars detected)" : ""}`);
  }

  if (validationPass !== undefined && result.validation !== undefined) {
    if (format === "text" || format === "table") {
      await outputConflictValidation(format, result.validation);
    }
  }

  // Dry run mode
  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const pullNote = options.skipPull ? " (skip pull)" : " (pull + start)";
    const recreateNote = forceRecreate ? " [force-recreate]" : "";
    const parallelNote = useParallel ? ` [parallel, workers: ${workerCount}]` : "";
    logInfo(
      formatDryRun(`deploy services: ${serviceList}${pullNote}${recreateNote}${parallelNote}`),
    );

    // Show parallel execution plan in dry-run mode
    let dryRunStagedPlan: StagedPlan | undefined;
    if (useParallel && services.length > 0) {
      const graph =
        validationPass === undefined
          ? await computeExecutionPhases(deployComposePath, finalConfig, services, envTool)
          : validationDependencyGraph(validationPass, finalConfig.sidecars.mapping);
      if (graph.hasCycles) {
        const cycleList = graph.cycleServices?.join(", ") ?? "unknown";
        const error = new DockerCommandError(
          "dependency-graph",
          `Circular dependency detected among services: ${cycleList}`,
          1,
          graph.cycleServices ?? [],
          false,
        );
        const formatted = formatError(error);
        outputFormattedError(formatted);
        setExitCode(ExitCode.OperationalError);
        return;
      }
      dryRunStagedPlan = staged
        ? planStagedBatches({
            graph,
            batchSize,
            onFailure,
            profileMapping: finalConfig.profiles.mapping,
          })
        : undefined;

      if (dryRunStagedPlan !== undefined) {
        logInfo(formatStagedPlan(dryRunStagedPlan, { perBatchGateSeconds: 0 }));
      } else {
        logInfo(formatExecutionPlan(graph.phases, workerCount));
      }
    }

    // `--dry-run` means "preview, always succeed" everywhere else in this CLI, so a
    // would-block gate reports and exits 0. `gate.blocking` in the machine payload
    // plus this line gives CI everything it needs.
    if (result.scan?.gate.blocking === true) {
      logInfo(`would block deploy (--scan-fail-on ${result.scan.gate.failOn})`);
    }

    if (format !== "text") {
      await formatOutput(format, {
        dryRun: true,
        services: services.length > 0 ? services : ["all"],
        profiles,
        composePath: deployComposePath,
        skipPull: options.skipPull,
        forceRecreate,
        waitForReady,
        healthTimeout,
        parallel: useParallel,
        workers: workerCount,
        ...(dryRunStagedPlan === undefined
          ? {}
          : {
              staged: {
                batchSize,
                onFailure,
                batches: dryRunStagedPlan.batches.map((b) => ({
                  index: b.index,
                  services: b.services,
                })),
              },
            }),
        ...(result.validation === undefined || format === "table"
          ? {}
          : { validation: result.validation }),
        ...(result.scan === undefined || format === "table" || format === "csv"
          ? {}
          : { scan: result.scan }),
      });
    }
    return;
  }

  if (result.scan !== undefined && result.scan.gate.blocking) {
    result.failed.push(
      scanFailureEntry(result.scan.gate.status === "blocked" ? "blocked" : "inconclusive"),
    );
    logInfo("Deploy blocked by vulnerability scan. No containers were modified.");
    if (format !== "text") {
      await outputDeployResult(format, result);
    }
    setExitCode(ExitCode.OperationalError);
    return;
  }

  // Confirmation if not --yes
  if (!options.yes && !isMachineFormat(format)) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const pullNote = options.skipPull ? "" : " (will pull images first)";
    // Only a non-blocking scan reaches here; the blocking gate returned above.
    const scanNote = scanConfirmAnnotation(result.scan);
    const confirmed = await confirm(`Deploy ${serviceList}${pullNote}${scanNote}?`);
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  let preparedValidationGraph: DependencyGraph | undefined;
  if (options.validateFirst && useParallel && services.length > 0) {
    preparedValidationGraph =
      validationPass === undefined
        ? await computeExecutionPhases(deployComposePath, finalConfig, services, envTool)
        : validationDependencyGraph(validationPass, finalConfig.sidecars.mapping);
    if (preparedValidationGraph.hasCycles) {
      const cycleList = preparedValidationGraph.cycleServices?.join(", ") ?? "unknown";
      const error = new DockerCommandError(
        "dependency-graph",
        `Circular dependency detected among services: ${cycleList}`,
        1,
        preparedValidationGraph.cycleServices ?? [],
        false,
      );
      const formatted = formatError(error);
      outputFormattedError(formatted);
      setExitCode(ExitCode.OperationalError);
      if (format !== "text") {
        await outputDeployResult(format, result);
      }
      return;
    }
  }

  if (validationPass !== undefined) {
    const driftFailure = await revalidateDeployBinding(validationPass.binding);
    if (driftFailure !== undefined) {
      result.validation = inconclusiveValidation(
        result.validation?.scope ??
          validationScope(validationPass.binding.projectName, services, profiles),
        driftFailure,
        result.validation,
      );
      result.failed.push(validationFailureEntry("inconclusive"));
      await outputValidationFailure(format, result);
      setExitCode(ExitCode.OperationalError);
      return;
    }
  }

  if (useParallel && services.length > 0) {
    // -------------------------------------------------------------------------
    // Parallel execution path
    // -------------------------------------------------------------------------
    try {
      // Build dependency graph for phased execution
      const graph =
        preparedValidationGraph ??
        (await computeExecutionPhases(deployComposePath, finalConfig, services, envTool));

      if (graph.hasCycles) {
        const cycleList = graph.cycleServices?.join(", ") ?? "unknown";
        const error = new DockerCommandError(
          "dependency-graph",
          `Circular dependency detected among services: ${cycleList}`,
          1,
          graph.cycleServices ?? [],
          false,
        );
        const formatted = formatError(error);
        outputFormattedError(formatted);
        setExitCode(ExitCode.OperationalError);

        if (format !== "text") {
          await outputDeployResult(format, result);
        }
        return;
      }

      logDebug(`Parallel deploy: ${graph.phases.length} phases, workers: ${workerCount}`);

      const stagedContext: StagedExecutionContext = {
        composePath: deployComposePath,
        projectDir: validationPass?.binding.projectDir ?? process.cwd(),
        profiles,
        exec: deployExecution,
      };

      const plan = planStagedBatches({
        graph,
        batchSize: staged ? batchSize : Math.max(1, services.length),
        // Non-staged is a single batch that must never halt, so the orphan pass
        // and the tail readiness gate still run on a partial failure.
        onFailure: staged ? onFailure : "continue",
        profileMapping: finalConfig.profiles.mapping,
      });

      const runPerBatchGate = staged && waitForReady;
      const perBatchGateSeconds = runPerBatchGate
        ? Math.min(
            healthTimeout,
            finalConfig.healthCheck.retries * finalConfig.healthCheck.interval,
          )
        : 0;

      if (staged) {
        logInfo(formatStagedPlan(plan, { perBatchGateSeconds }));
        if (stagedExceedsLockStaleness(plan, perBatchGateSeconds)) {
          logWarn(
            "Worst-case staged rollout exceeds the 10-minute state-lock staleness threshold; another operator's force-unlock could see this live rollout as stale. Raise --batch-size or lower --health-timeout.",
          );
        }
      } else if (options.skipPull) {
        logInfo("Skipping image pull (--skip-pull)");
      }

      const report = await executeStagedRollout(
        {
          plan,
          dependencyMap: graph.dependencyMap,
          skipPull: options.skipPull === true,
          // Staged-only: the non-staged path keeps its legacy per-phase log lines.
          onEvent:
            staged && !isMachineFormat(format)
              ? (event) => {
                  const render = formatStagedEvent(event);
                  if (render.level === "warn") {
                    logWarn(render.message);
                  } else {
                    logInfo(render.message);
                  }
                }
              : undefined,
        },
        {
          runPhase: async ({ operation, phases }) => {
            if (!staged) {
              if (operation === "pull") {
                logInfo("Pulling images in parallel...");
              } else {
                logInfo(
                  `Starting Docker services in parallel...${forceRecreate ? " (force-recreate)" : ""}`,
                );
              }
            }
            const phaseResult = await executeParallelPhases({
              phases,
              composePath: deployComposePath,
              operation,
              workers: workerCount,
              dependencyMap: graph.dependencyMap,
              ...(operation === "start" ? { noPull: !options.skipPull, forceRecreate } : {}),
              profiles,
              ...deployExecution,
            });
            if (!staged) {
              if (phaseResult.failed.length > 0) {
                const names = phaseResult.failed.map((f) => f.name).join(", ");
                logWarn(
                  operation === "pull"
                    ? `Some images failed to pull: ${names}`
                    : `Some services failed to start: ${names}`,
                );
              }
              if (phaseResult.succeeded.length > 0) {
                logSuccess(
                  operation === "pull"
                    ? `Successfully pulled images for ${phaseResult.succeeded.length} services`
                    : `Successfully started ${phaseResult.succeeded.length} services`,
                );
              }
            }
            return { succeeded: phaseResult.succeeded, failed: phaseResult.failed };
          },
          gate: runPerBatchGate
            ? ({ started, onProgress }) =>
                waitForBatchReady(
                  {
                    services: started,
                    waitForReady,
                    onProgress,
                    poll: {
                      timeoutSeconds: healthTimeout,
                      intervalSeconds: finalConfig.healthCheck.interval,
                      retries: finalConfig.healthCheck.retries,
                    },
                  },
                  { observe: createBatchObserver(stagedContext) },
                )
            : undefined,
        },
      );

      const halted = report.status === "halted";
      // Preserve the caller's service order so non-staged argv is byte-identical.
      const attempted = services.filter((service) => report.attempted.includes(service));

      // Cleanup pass: scoped to services a start was ISSUED for, and skipped entirely
      // on a halt. startServices unconditionally emits `up -d --remove-orphans`, so an
      // unscoped pass would start exactly the services the halt was meant to protect.
      if (!halted && attempted.length > 0) {
        logDebug("Running orphan cleanup pass...");
        await startServices(deployComposePath, attempted, {
          streamOutput: false,
          profiles,
          ...deployExecution,
        });
      } else if (halted) {
        logDebug("Orphan cleanup skipped: staged rollout halted");
      }

      // Aggregate results into DeployResult shape
      result.services = services;
      result.started = report.started;
      result.healthy = [...report.healthy];
      result.unhealthy.push(...report.unhealthy);
      for (const failure of report.failed) {
        if (!result.failed.some((f) => f.name === failure.name)) {
          result.failed.push(failure);
        }
      }
      if (staged) {
        result.staged = summarizeStagedRollout(report);
      }
      if (staged && report.status !== "completed" && format === "text") {
        for (const line of formatStagedSummary(report)) {
          logInfo(line);
        }
      }

      // Set exit code if any service failed
      if (result.failed.length > 0) {
        setDeployExitCode(result, options.allowPartial ?? false);
        for (const failure of result.failed) {
          if (failure.code === "STAGE_NOT_ATTEMPTED") {
            continue;
          }
          const error = new DockerCommandError(
            "parallel-deploy",
            `Service '${failure.name}' failed: ${failure.error}`,
            1,
            [failure.name],
            false,
          );
          const formatted = formatError(error);
          outputFormattedError(formatted);
        }
      }

      // Dependency readiness check (pass only healthy/succeeded services)
      const healthyServices = report.healthy;
      if (!halted && healthyServices.length > 0) {
        if (waitForReady) {
          logInfo("Waiting for dependency readiness...");
        } else {
          logInfo("Checking dependency readiness snapshot (--no-wait-for-ready)...");
        }

        let lastReadinessSignature = "";
        const readinessSummary = await waitForDependencyReadiness({
          composePath: deployComposePath,
          targetServices: healthyServices,
          projectDir: validationPass?.binding.projectDir ?? process.cwd(),
          profiles,
          ...deployExecution,
          waitForReady,
          poll: {
            timeoutSeconds: healthTimeout,
            intervalSeconds: finalConfig.healthCheck.interval,
            retries: finalConfig.healthCheck.retries,
          },
          onProgress: isMachineFormat(format)
            ? undefined
            : (summary) => {
                const waiting = [...summary.pendingDependencies, ...summary.failedDependencies];
                const signature = waiting.join(",");
                if (signature === lastReadinessSignature) {
                  return;
                }

                lastReadinessSignature = signature;
                if (waiting.length > 0) {
                  logInfo(`Dependencies pending readiness: ${waiting.join(", ")}`);
                } else if (summary.ready) {
                  logSuccess("Dependencies are ready");
                }
              },
        });

        if (readinessSummary.warnings !== undefined) {
          for (const warning of readinessSummary.warnings) {
            logWarn(warning);
          }
        }

        const readinessUnavailable = readinessSummary.signalAvailability.available === false;

        if (waitForReady && !readinessSummary.ready && !readinessUnavailable) {
          const notReadyDependencies = [
            ...readinessSummary.pendingDependencies,
            ...readinessSummary.failedDependencies,
          ];
          result.unhealthy.push(...notReadyDependencies);
          const readinessError = new DockerCommandError(
            "health-check",
            `Dependencies not ready within timeout: ${notReadyDependencies.join(", ")}`,
            1,
            notReadyDependencies,
            false,
          );
          const formatted = formatError(readinessError);
          outputFormattedError(formatted);
          setDeployExitCode(result, options.allowPartial ?? false);
        } else if (!readinessSummary.ready && readinessUnavailable) {
          logWarn("Dependency readiness checks unavailable. Continuing with startup verification.");
        }

        // Populate healthy list from succeeded services minus unhealthy
        result.healthy = healthyServices.filter((s) => !result.unhealthy.includes(s));
      }

      // Record deployments (batch after completion)
      if (services.length > 0) {
        try {
          const db = await initializeDatabase();
          const timestamp = new Date().toISOString();
          const serviceImageMap = await inspectContainersWithRetry(
            staged ? attempted : services,
            3,
            1000,
            deployExecution,
          );

          const deploymentEntries = services.map((service) => {
            const isFailed = result.failed.some((f) => f.name === service);
            const isUnhealthy = result.unhealthy.includes(service);
            const failureEntry = result.failed.find((f) => f.name === service);
            return {
              timestamp,
              service,
              action: "deploy" as const,
              imageTag: serviceImageMap.get(service),
              configSnapshot: serviceImageMap.get(service)
                ? JSON.stringify({ image: serviceImageMap.get(service) })
                : undefined,
              status: isFailed || isUnhealthy ? ("failed" as const) : ("success" as const),
              planId: undefined,
              errorMessage: isFailed
                ? (failureEntry?.error ?? "Service failed during parallel deploy")
                : isUnhealthy
                  ? "Service failed to start"
                  : undefined,
            };
          });

          recordDeployments(db, deploymentEntries);
          closeDatabase(db);
        } catch (stateError) {
          logWarn(
            `Failed to record deployment state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const formatted = formatError(errorObj);
      outputFormattedError(formatted);
      result.failed.push({
        name: "deploy",
        error: errorObj.message,
      });
      setExitCode(ExitCode.OperationalError);

      // Record failed deployment state for parallel path
      if (services.length > 0) {
        try {
          const db = await initializeDatabase();
          const timestamp = new Date().toISOString();

          const failedEntries = services.map((service) => ({
            timestamp,
            service,
            action: "deploy" as const,
            imageTag: undefined,
            configSnapshot: undefined,
            status: "failed" as const,
            planId: undefined,
            errorMessage: errorObj.message,
          }));

          recordDeployments(db, failedEntries);
          closeDatabase(db);
        } catch (stateError) {
          logWarn(
            `Failed to record deployment state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
      }
    }
  } else {
    // -------------------------------------------------------------------------
    // Sequential execution path (existing behavior, unchanged)
    // -------------------------------------------------------------------------
    try {
      // Phase 1: Pull images (unless --skip-pull)
      // Always stream output - pulling can be slow and users need feedback
      if (!options.skipPull) {
        const pullResult = await pullImages(
          deployComposePath,
          services.length > 0 ? services : undefined,
          { streamOutput: true, profiles, ...deployExecution },
        );

        if (!pullResult.success) {
          const pullServices = services.length > 0 ? services : ["all"];
          const error = new ImagePullError(pullServices, pullResult.stderr);
          const formatted = formatError(error);
          outputFormattedError(formatted);
          result.failed.push({
            name: "pull",
            error: pullResult.stderr || error.message,
          });
          setExitCode(ExitCode.OperationalError);

          // Output result if non-text format even on failure
          if (format !== "text") {
            await outputDeployResult(format, result);
          }
          return;
        }

        logSuccess(`Successfully pulled images`);
      } else {
        logInfo(`Skipping image pull (--skip-pull)`);
      }

      // Phase 2: Start services
      // Always stream output for start - it's a long-running operation and users need feedback
      logInfo(`Starting Docker services...${forceRecreate ? " (force-recreate)" : ""}`);

      const startResult = await startServices(
        deployComposePath,
        services.length > 0 ? services : undefined,
        {
          streamOutput: true,
          profiles,
          forceRecreate,
          noPull: !options.skipPull,
          ...deployExecution,
        },
      );

      if (!startResult.success) {
        const failedStartServices = services.length > 0 ? services : ["all"];
        const error = new ServiceStartError(failedStartServices, startResult.stderr);
        const formatted = formatError(error);
        outputFormattedError(formatted);
        result.failed.push({
          name: "start",
          error: startResult.stderr || error.message,
        });

        if ((options.allowPartial ?? false) && services.length > 1) {
          await populateStartedServicesAfterFailure(result, deployComposePath, services, {
            profiles,
            ...deployExecution,
          });
        }

        setDeployExitCode(result, options.allowPartial ?? false);

        // Output result if non-text format even on failure
        if (format !== "text") {
          await outputDeployResult(format, result);
        }
        return;
      }

      logSuccess(`Successfully started services`);

      // Phase 3: Dependency readiness check
      if (waitForReady) {
        logInfo("Waiting for dependency readiness...");
      } else {
        logInfo("Checking dependency readiness snapshot (--no-wait-for-ready)...");
      }

      let lastReadinessSignature = "";
      const readinessSummary = await waitForDependencyReadiness({
        composePath: deployComposePath,
        targetServices: services,
        projectDir: validationPass?.binding.projectDir ?? process.cwd(),
        profiles,
        ...deployExecution,
        waitForReady,
        poll: {
          timeoutSeconds: healthTimeout,
          intervalSeconds: finalConfig.healthCheck.interval,
          retries: finalConfig.healthCheck.retries,
        },
        onProgress: isMachineFormat(format)
          ? undefined
          : (summary) => {
              const waiting = [...summary.pendingDependencies, ...summary.failedDependencies];
              const signature = waiting.join(",");
              if (signature === lastReadinessSignature) {
                return;
              }

              lastReadinessSignature = signature;
              if (waiting.length > 0) {
                logInfo(`Dependencies pending readiness: ${waiting.join(", ")}`);
              } else if (summary.ready) {
                logSuccess("Dependencies are ready");
              }
            },
      });

      if (readinessSummary.warnings !== undefined) {
        for (const warning of readinessSummary.warnings) {
          logWarn(warning);
        }
      }

      const readinessUnavailable = readinessSummary.signalAvailability.available === false;

      if (waitForReady && !readinessSummary.ready && !readinessUnavailable) {
        const notReadyDependencies = [
          ...readinessSummary.pendingDependencies,
          ...readinessSummary.failedDependencies,
        ];
        result.unhealthy.push(...notReadyDependencies);
        const error = new DockerCommandError(
          "health-check",
          `Dependencies not ready within timeout: ${notReadyDependencies.join(", ")}`,
          1,
          notReadyDependencies,
          false,
        );
        const formatted = formatError(error);
        outputFormattedError(formatted);
        setDeployExitCode(result, options.allowPartial ?? false);
      } else if (!readinessSummary.ready && readinessUnavailable) {
        logWarn("Dependency readiness checks unavailable. Continuing with startup verification.");
      }

      // Get running containers
      const containersResult = await getRunningContainers(deployComposePath, {
        profiles,
        ...deployExecution,
      });

      if (containersResult.success) {
        const runningContainers = containersResult.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        result.healthy = runningContainers;
        result.services = services.length > 0 ? services : ["all"];
        result.started = runningContainers.length;

        // Check for unhealthy (services that were supposed to start but aren't running)
        if (services.length > 0) {
          for (const service of services) {
            // Container names may have project prefix, so check if service name is contained
            const isRunning = runningContainers.some((c) =>
              c.toLowerCase().includes(service.toLowerCase()),
            );
            if (!isRunning) {
              result.unhealthy.push(service);
            }
          }
        }

        if (result.unhealthy.length > 0) {
          const error = new DockerCommandError(
            "health-check",
            `Services not running after startup: ${result.unhealthy.join(", ")}`,
            1,
            result.unhealthy,
            false,
          );
          const formatted = formatError(error);
          outputFormattedError(formatted);
          setDeployExitCode(result, options.allowPartial ?? false);
        } else {
          logSuccess(`All ${result.started} containers running`);
        }
      } else {
        // Status check failed but deploy completed - log as warning, not error
        logWarn(`Status check failed (SSH connection issue). Services were started successfully.`);
        logDebug(`Status check error: ${containersResult.stderr}`);
        result.services = services.length > 0 ? services : ["all"];
        result.started = services.length > 0 ? services.length : 1;
        logSuccess(`Deploy complete (status check skipped)`);
      }

      // Record deployment state for successful deployments
      // For "deploy all", use the healthy containers as the service list
      let deployedServices = services;
      if (services.length === 0 && result.healthy.length > 0) {
        deployedServices = result.healthy;
        logDebug(`Recording "deploy all" with ${deployedServices.length} services`);
      }

      if (deployedServices.length > 0) {
        try {
          const db = await initializeDatabase();
          const timestamp = new Date().toISOString();

          // Get container info to capture image tags with retry logic
          const serviceImageMap = await inspectContainersWithRetry(
            deployedServices,
            3,
            1000,
            deployExecution,
          );

          // Build batch entries for recording
          const deploymentEntries = deployedServices.map((service) => ({
            timestamp,
            service,
            action: "deploy" as const,
            imageTag: serviceImageMap.get(service),
            configSnapshot: serviceImageMap.get(service)
              ? JSON.stringify({ image: serviceImageMap.get(service) })
              : undefined,
            status: result.unhealthy.includes(service) ? ("failed" as const) : ("success" as const),
            planId: undefined,
            errorMessage: result.unhealthy.includes(service)
              ? "Service failed to start"
              : undefined,
          }));

          recordDeployments(db, deploymentEntries);
          closeDatabase(db);
        } catch (stateError) {
          logWarn(
            `Failed to record deployment state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const formatted = formatError(errorObj);
      outputFormattedError(formatted);
      result.failed.push({
        name: "deploy",
        error: errorObj.message,
      });
      setExitCode(ExitCode.OperationalError);

      // Record failed deployment state
      // For "deploy all", we don't have healthy containers yet, so only record specific services
      const failedServices = services.length > 0 ? services : [];
      if (failedServices.length > 0) {
        try {
          const db = await initializeDatabase();
          const timestamp = new Date().toISOString();

          const failedEntries = failedServices.map((service) => ({
            timestamp,
            service,
            action: "deploy" as const,
            imageTag: undefined,
            configSnapshot: undefined,
            status: "failed" as const,
            planId: undefined,
            errorMessage: errorObj.message,
          }));

          recordDeployments(db, failedEntries);
          closeDatabase(db);
        } catch (stateError) {
          logWarn(
            `Failed to record deployment state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
      }
    }
  }

  // Output result in requested format
  if (format !== "text") {
    await outputDeployResult(format, result);
  }
}

async function populateStartedServicesAfterFailure(
  result: DeployResult,
  composePath: string,
  services: string[],
  options: DockerComposeExecOptions & { profiles: string[] },
): Promise<void> {
  const containersResult = await getRunningContainers(composePath, options);

  if (!containersResult.success) {
    return;
  }

  const runningContainers = containersResult.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const runningServices = services.filter((service) =>
    runningContainers.some((container) => container.toLowerCase().includes(service.toLowerCase())),
  );

  result.services = services;
  result.healthy = runningServices;
  result.started = runningServices.length;
}
