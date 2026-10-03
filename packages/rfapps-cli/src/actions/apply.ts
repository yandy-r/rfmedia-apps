/**
 * Apply command action for rfapps CLI
 *
 * Executes a saved deployment plan.
 */

import {
  logInfo,
  logSuccess,
  logWarn,
  logDebug,
  isMachineFormat,
  formatDryRun,
  confirm,
  colors,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";

import type { OutputFormat } from "@rfmedia/common";

import { formatOutput } from "../lib/formatters/index.js";

import type { ApplyResult } from "../types/plan.js";
import type { DeployResult, EnvToolExecConfig } from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  pullImages,
  startServices,
  getRunningContainers,
  waitForDependencyReadiness,
  initializeDatabase,
  closeDatabase,
  recordDeployments,
  computeExecutionPhases,
  executeParallelPhases,
  formatExecutionPlan,
} from "../lib/index.js";

import { loadPlan, validatePlan } from "../lib/plan-storage.js";
import {
  PlanValidationError,
  ImagePullError,
  ServiceStartError,
  DockerCommandError,
} from "../lib/errors.js";

/**
 * Parse raw apply options from CLI
 */
interface RawApplyOptions {
  planFile: string;
  force?: boolean;
  parallel?: boolean;
  workers?: number | string;
}

/**
 * Apply command options
 */
interface ApplyOptions {
  dryRun: boolean;
  debug: boolean;
  json: boolean;
  verbose: boolean;
  yes: boolean;
  planFile: string;
  force: boolean;
  parallel?: boolean;
  workers?: number;
}

function assertOrdinaryPlanIntent(
  intent: unknown,
  planPath: string,
): asserts intent is "deployment" | undefined {
  if (intent === undefined || intent === "deployment") {
    return;
  }

  if (intent === "managed-update") {
    throw new PlanValidationError(
      planPath,
      "Managed update plans cannot be applied with rfapps apply. Use rfapps update --from-plan <path> --apply instead.",
    );
  }

  throw new PlanValidationError(
    planPath,
    'Plan has an invalid intent; expected "deployment" or no intent for a legacy plan',
  );
}

/**
 * Execute the apply command
 */
export async function executeApply(
  rawOptions: RawApplyOptions,
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
  // Extract env tool config from global options
  const envTool = getEnvToolExecConfig(globalOptions);

  // Build options
  const options: ApplyOptions = {
    dryRun: globalOptions.dryRun ?? false,
    debug: globalOptions.debug ?? false,
    json: globalOptions.json ?? false,
    verbose: globalOptions.verbose ?? false,
    yes: globalOptions.yes ?? false,
    planFile: rawOptions.planFile,
    force: rawOptions.force ?? false,
    parallel: rawOptions.parallel,
    workers:
      typeof rawOptions.workers === "string"
        ? Number.parseInt(rawOptions.workers, 10)
        : rawOptions.workers,
  };

  logDebug(`Apply options: ${JSON.stringify(options)}`);

  // Resolve output format
  const format = globalOptions.output ?? "text";

  // Load plan
  logInfo(`Loading plan from ${options.planFile}...`);
  const plan = await loadPlan(options.planFile);

  if (plan === undefined) {
    throw new PlanValidationError(options.planFile, "Plan file not found");
  }

  assertOrdinaryPlanIntent(plan.intent, options.planFile);

  logDebug(`Loaded plan ID: ${plan.id}, created: ${plan.createdAt}`);

  // Validate plan
  const validation = await validatePlan(plan, { force: options.force });

  // Show validation errors
  if (validation.errors.length > 0) {
    throw new PlanValidationError(options.planFile, validation.errors.join("; "));
  }

  // Show validation warnings
  if (validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      logWarn(warning);
    }
  }

  // Check if there are any changes to apply
  const hasChanges = plan.summary.toCreate + plan.summary.toUpdate + plan.summary.toRecreate > 0;
  if (!hasChanges) {
    logInfo("No changes to apply - plan shows no modifications needed");
    if (format !== "text") {
      await formatOutput(format, {
        planId: plan.id,
        applied: [],
        failed: [],
        total: 0,
        success: true,
      });
    }
    return;
  }

  // Load configuration
  const config = await loadConfig();
  const finalConfig = applyCliOverrides(config, {
    composePath: plan.composePath,
  });

  // Resolve parallel execution options from CLI flags -> config defaults
  const useParallel = options.parallel ?? finalConfig.parallel.enabled;
  const workerCount =
    options.workers !== undefined && Number.isFinite(options.workers) && options.workers > 0
      ? options.workers
      : finalConfig.parallel.workers;

  // Dry run mode
  if (options.dryRun) {
    const parallelNote = useParallel ? ` [parallel, workers: ${workerCount}]` : "";
    logInfo(formatDryRun(`apply plan ${plan.id}${parallelNote}`));
    logInfo(
      `  Services to modify: ${plan.summary.toCreate + plan.summary.toUpdate + plan.summary.toRecreate}`,
    );

    // Show parallel execution plan in dry-run mode
    if (useParallel) {
      const allServiceNames = plan.services
        .filter(
          (s) =>
            s.changeType === "create" || s.changeType === "update" || s.changeType === "recreate",
        )
        .map((s) => s.service);

      if (allServiceNames.length > 0) {
        const graph = await computeExecutionPhases(
          finalConfig.composePath,
          finalConfig,
          allServiceNames,
          envTool,
        );
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
          process.exitCode = 1;
          return;
        }
        logInfo(formatExecutionPlan(graph.phases, workerCount));
      }
    }

    return;
  }

  // Confirmation if not --yes
  if (!options.yes && !isMachineFormat(format)) {
    console.error("");
    console.error(colors.bold("Plan Summary:"));
    if (plan.summary.toCreate > 0) {
      console.error(`  ${colors.green("Create")}: ${plan.summary.toCreate} service(s)`);
    }
    if (plan.summary.toRecreate > 0) {
      console.error(`  ${colors.cyan("Recreate")}: ${plan.summary.toRecreate} service(s)`);
    }
    if (plan.summary.toUpdate > 0) {
      console.error(`  ${colors.yellow("Update")}: ${plan.summary.toUpdate} service(s)`);
    }
    console.error("");

    const confirmed = await confirm("Apply this plan?");
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  // Collect services that need to be deployed
  const servicesToDeploy = plan.services
    .filter(
      (s) => s.changeType === "create" || s.changeType === "update" || s.changeType === "recreate",
    )
    .map((s) => s.service);

  if (servicesToDeploy.length === 0) {
    logInfo("No services to deploy");
    if (format !== "text") {
      await formatOutput(format, {
        planId: plan.id,
        applied: [],
        failed: [],
        total: 0,
        success: true,
      });
    }
    return;
  }

  logInfo(`Applying plan to ${servicesToDeploy.length} service(s)...`);

  const result: ApplyResult = {
    planId: plan.id,
    applied: [],
    failed: [],
    total: servicesToDeploy.length,
    success: false,
  };

  // Determine if force-recreate is needed (used by both paths)
  const needsRecreate = plan.services.some((s) => s.changeType === "recreate");

  if (useParallel && servicesToDeploy.length > 0) {
    // -------------------------------------------------------------------------
    // Parallel execution path
    // -------------------------------------------------------------------------
    try {
      // Build dependency graph for phased execution
      const graph = await computeExecutionPhases(
        finalConfig.composePath,
        finalConfig,
        servicesToDeploy,
        envTool,
      );

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
        process.exitCode = 1;

        if (format !== "text") {
          await formatOutput(format, result);
        }
        return;
      }

      logDebug(`Parallel apply: ${graph.phases.length} phases, workers: ${workerCount}`);

      // Parallel Phase 1: Pull images for services with image changes
      const servicesWithImageChanges = plan.services
        .filter(
          (s) => s.image.changed && (s.changeType === "create" || s.changeType === "recreate"),
        )
        .map((s) => s.service);

      if (servicesWithImageChanges.length > 0) {
        logInfo(`Pulling images for ${servicesWithImageChanges.length} service(s) in parallel...`);

        // Compute phases specifically for services with image changes
        const pullGraph = await computeExecutionPhases(
          finalConfig.composePath,
          finalConfig,
          servicesWithImageChanges,
          envTool,
        );

        const pullResult = await executeParallelPhases({
          phases: pullGraph.phases,
          composePath: finalConfig.composePath,
          operation: "pull",
          workers: workerCount,
          dependencyMap: pullGraph.dependencyMap,
          envTool,
          profiles: plan.profiles,
        });

        if (pullResult.failed.length > 0) {
          const failedNames = pullResult.failed.map((f) => f.name).join(", ");
          logWarn(`Some images failed to pull: ${failedNames}`);
          for (const failure of pullResult.failed) {
            result.failed.push({
              service: failure.name,
              error: failure.error,
            });
          }
        }

        if (pullResult.succeeded.length > 0) {
          logSuccess(`Successfully pulled images for ${pullResult.succeeded.length} services`);
        }
      } else {
        logInfo("No images to pull (all services up to date)");
      }

      // Parallel Phase 2: Start/deploy services in dependency order
      logInfo(`Deploying services in parallel...${needsRecreate ? " (force-recreate)" : ""}`);
      const startResult = await executeParallelPhases({
        phases: graph.phases,
        composePath: finalConfig.composePath,
        operation: "start",
        workers: workerCount,
        dependencyMap: graph.dependencyMap,
        envTool,
        noPull: servicesWithImageChanges.length > 0,
        forceRecreate: needsRecreate,
        profiles: plan.profiles,
      });

      if (startResult.failed.length > 0) {
        const failedNames = startResult.failed.map((f) => f.name).join(", ");
        logWarn(`Some services failed to start: ${failedNames}`);
        // Merge start failures, avoiding duplicates from pull phase
        for (const failure of startResult.failed) {
          if (!result.failed.some((f) => f.service === failure.name)) {
            result.failed.push({
              service: failure.name,
              error: failure.error,
            });
          }
        }
      }

      if (startResult.succeeded.length > 0) {
        logSuccess(`Successfully started ${startResult.succeeded.length} services`);
      }

      // Cleanup pass: run a single docker compose up -d --remove-orphans with no services
      // to maintain parity with sequential behavior's --remove-orphans flag
      logDebug("Running orphan cleanup pass...");
      await startServices(finalConfig.composePath, undefined, {
        streamOutput: false,
        profiles: plan.profiles,
        envTool,
      });

      // Aggregate results into ApplyResult shape
      result.applied = startResult.succeeded;

      // Set exit code if any service failed
      if (result.failed.length > 0) {
        process.exitCode = 1;
        for (const failure of result.failed) {
          const error = new DockerCommandError(
            "parallel-apply",
            `Service '${failure.service}' failed: ${failure.error}`,
            1,
            [failure.service],
            false,
          );
          const formatted = formatError(error);
          outputFormattedError(formatted);
        }
      } else {
        result.success = true;
        logSuccess(`All ${result.applied.length} service(s) deployed successfully`);
      }

      // Dependency readiness check (pass only succeeded services)
      const healthyServices = startResult.succeeded;
      if (healthyServices.length > 0) {
        const waitForReady = finalConfig.healthCheck.waitForReady;
        if (waitForReady) {
          logInfo("Verifying dependency readiness...");
        } else {
          logInfo("Checking dependency readiness snapshot...");
        }

        let lastReadinessSignature = "";
        const readinessSummary = await waitForDependencyReadiness({
          composePath: finalConfig.composePath,
          targetServices: healthyServices,
          projectDir: process.cwd(),
          profiles: plan.profiles,
          envTool,
          waitForReady,
          poll: {
            timeoutSeconds: finalConfig.healthCheck.timeout,
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
          const readinessError = new DockerCommandError(
            "health-check",
            `Dependencies not ready within timeout: ${notReadyDependencies.join(", ")}`,
            1,
            notReadyDependencies,
            false,
          );
          const formatted = formatError(readinessError);
          outputFormattedError(formatted);
          process.exitCode = 1;
          result.success = false;
        } else if (!readinessSummary.ready && readinessUnavailable) {
          logWarn("Dependency readiness checks unavailable. Continuing with startup verification.");
        }
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const formatted = formatError(errorObj);
      outputFormattedError(formatted);
      result.failed.push({
        service: "apply",
        error: errorObj.message,
      });
      process.exitCode = 1;
    }
  } else {
    // -------------------------------------------------------------------------
    // Sequential execution path (existing behavior, unchanged)
    // -------------------------------------------------------------------------
    try {
      // Phase 1: Pull images for services with image changes
      const servicesWithImageChanges = plan.services
        .filter(
          (s) => s.image.changed && (s.changeType === "create" || s.changeType === "recreate"),
        )
        .map((s) => s.service);

      if (servicesWithImageChanges.length > 0) {
        logInfo(`Pulling images for ${servicesWithImageChanges.length} service(s)...`);

        const pullResult = await pullImages(finalConfig.composePath, servicesWithImageChanges, {
          streamOutput: true,
          profiles: plan.profiles,
          envTool,
        });

        if (!pullResult.success) {
          const pullError = new ImagePullError(
            servicesWithImageChanges,
            pullResult.stderr.trim() || "See output above for details",
          );
          const formatted = formatError(pullError);
          outputFormattedError(formatted);
          result.failed.push({
            service: "pull",
            error: pullError.message,
          });
          process.exitCode = 1;

          if (format !== "text") {
            await formatOutput(format, result);
          }
          return;
        }

        logSuccess("Successfully pulled images");
      } else {
        logInfo("No images to pull (all services up to date)");
      }

      // Phase 2: Deploy services
      logInfo(`Deploying services...${needsRecreate ? " (force-recreate)" : ""}`);

      const startResult = await startServices(finalConfig.composePath, servicesToDeploy, {
        streamOutput: true,
        profiles: plan.profiles,
        forceRecreate: needsRecreate,
        envTool,
      });

      if (!startResult.success) {
        const startError = new ServiceStartError(
          servicesToDeploy,
          startResult.stderr.trim() || "See output above for details",
        );
        const formatted = formatError(startError);
        outputFormattedError(formatted);
        result.failed.push({
          service: "deploy",
          error: startError.message,
        });
        process.exitCode = 1;

        if (format !== "text") {
          await formatOutput(format, result);
        }
        return;
      }

      logSuccess("Successfully deployed services");

      // Phase 3: Dependency readiness verification
      const waitForReady = finalConfig.healthCheck.waitForReady;
      if (waitForReady) {
        logInfo("Verifying dependency readiness...");
      } else {
        logInfo("Checking dependency readiness snapshot...");
      }

      let lastReadinessSignature = "";
      const readinessSummary = await waitForDependencyReadiness({
        composePath: finalConfig.composePath,
        targetServices: servicesToDeploy,
        projectDir: process.cwd(),
        profiles: plan.profiles,
        envTool,
        waitForReady,
        poll: {
          timeoutSeconds: finalConfig.healthCheck.timeout,
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
        for (const service of servicesToDeploy) {
          result.failed.push({
            service,
            error: `Dependencies not ready: ${notReadyDependencies.join(", ")}`,
          });
        }
        const readinessError = new ServiceStartError(
          servicesToDeploy,
          `Dependencies not ready within timeout: ${notReadyDependencies.join(", ")}`,
        );
        const formatted = formatError(readinessError);
        outputFormattedError(formatted);
        process.exitCode = 1;
      } else if (!readinessSummary.ready && readinessUnavailable) {
        logWarn("Dependency readiness checks unavailable. Continuing with startup verification.");
      }

      // Phase 4: Verify containers are running
      logInfo("Verifying deployment containers...");

      const containersResult = await getRunningContainers(finalConfig.composePath, {
        profiles: plan.profiles,
        envTool,
      });

      if (containersResult.success) {
        const runningContainers = containersResult.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        // Check which services are running
        for (const service of servicesToDeploy) {
          const isRunning = runningContainers.some((c) =>
            c.toLowerCase().includes(service.toLowerCase()),
          );

          if (isRunning) {
            const hasFailure = result.failed.some((failure) => failure.service === service);
            if (!hasFailure) {
              result.applied.push(service);
            }
          } else {
            result.failed.push({
              service,
              error: "Service not running after deployment",
            });
          }
        }

        if (result.failed.length > 0) {
          const failedServices = result.failed.map((f) => f.service);
          const verifyError = new ServiceStartError(
            failedServices,
            "Service not running after deployment",
          );
          const formatted = formatError(verifyError);
          outputFormattedError(formatted);
          process.exitCode = 1;
        } else {
          result.success = true;
          logSuccess(`All ${result.applied.length} service(s) deployed successfully`);
        }
      } else {
        // Status check failed but deploy completed - mark as success with warning
        logWarn("Status check failed (SSH connection issue). Services were deployed successfully.");
        logDebug(`Status check error: ${containersResult.stderr}`);
        result.applied = servicesToDeploy;
        result.success = true;
        logSuccess("Deployment complete (status check skipped)");
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const formatted = formatError(errorObj);
      outputFormattedError(formatted);
      result.failed.push({
        service: "apply",
        error: errorObj.message,
      });
      process.exitCode = 1;
    }
  }

  // Record state for applied services (non-blocking)
  try {
    const db = await initializeDatabase();
    try {
      const timestamp = new Date().toISOString();

      // Build batch entries for successful services
      const successEntries = result.applied.map((serviceName) => {
        const serviceChange = plan.services.find((s) => s.service === serviceName);
        return {
          timestamp,
          service: serviceName,
          action: "apply" as const,
          // Successful applies run the desired image; generations snapshot the post-apply state
          imageTag: serviceChange?.image.desired ?? serviceChange?.image.current,
          configSnapshot: serviceChange ? JSON.stringify(serviceChange) : undefined,
          status: "success" as const,
          planId: plan.id,
          errorMessage: undefined,
        };
      });

      // Build batch entries for failed services (skip generic failures)
      const failedEntries = result.failed
        .filter((f) => f.service !== "apply" && f.service !== "pull" && f.service !== "deploy")
        .map((failure) => {
          const serviceChange = plan.services.find((s) => s.service === failure.service);
          return {
            timestamp,
            service: failure.service,
            action: "apply" as const,
            imageTag: serviceChange?.image.current ?? serviceChange?.image.desired,
            configSnapshot: serviceChange ? JSON.stringify(serviceChange) : undefined,
            status: "failed" as const,
            planId: plan.id,
            errorMessage: failure.error,
          };
        });

      // Record all entries in a single batch
      const allEntries = [...successEntries, ...failedEntries];
      if (allEntries.length > 0) {
        recordDeployments(db, allEntries);
      }
    } finally {
      closeDatabase(db);
    }
  } catch (stateError) {
    logWarn(
      `Failed to record apply state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
    );
  }

  // Output result in requested format
  if (format !== "text") {
    await formatOutput(format, result);
  }
}
