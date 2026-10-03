/**
 * Rebuild command action for rfapps CLI
 *
 * Rebuilds Docker services with:
 * - Stop existing containers
 * - Pull latest images (unless --skip-pull)
 * - Build containers
 * - Start services with force-recreate
 * - Health check after start
 * - Automatic sidecar linking
 * - Service group expansion
 * - Profile support
 */

import {
  logInfo,
  logSuccess,
  logWarn,
  logDebug,
  isMachineFormat,
  formatDryRun,
  confirm,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";

import type { OutputFormat } from "@rfmedia/common";

import type { RebuildOptions, RebuildResult, EnvToolExecConfig } from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  stopServices,
  pullImages,
  buildImages,
  startServices,
  getRunningContainers,
  waitForDependencyReadiness,
  isValidProfile,
  resolveServicesWithInteractive,
  initializeDatabase,
  recordDeployments,
  closeDatabase,
  inspectContainersWithRetry,
  formatOutput,
  computeExecutionPhases,
  executeParallelPhases,
  formatExecutionPlan,
  DockerCommandError,
  ImagePullError,
  ServiceStartError,
} from "../lib/index.js";

/**
 * Parse raw rebuild options from CLI
 */
interface RawRebuildOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  skipPull?: boolean;
  waitForReady?: boolean;
  healthTimeout?: number | string;
  compose?: string;
  envFile?: string;
  profile?: string;
  parallel?: boolean;
  workers?: number | string;
}

/**
 * Execute the rebuild command.
 *
 * Performs a full rebuild cycle with four phases:
 * 1. Stop: Gracefully stop existing containers
 * 2. Pull: Download latest images (unless --skip-pull)
 * 3. Build: Build containers from compose.yml
 * 4. Start: Start containers with force-recreate
 *
 * This is the safest way to update services as it ensures a clean state.
 * Force-recreate is always enabled since containers were just rebuilt.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode, secrets injection, etc.)
 *
 * @example
 * ```typescript
 * // Rebuild a specific service
 * await executeRebuild({ service: 'traefik' }, { yes: true });
 *
 * // Rebuild entire media stack group
 * await executeRebuild({ group: 'media-stack' }, { yes: true });
 * ```
 */
export async function executeRebuild(
  rawOptions: RawRebuildOptions,
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
  const options: RebuildOptions = {
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
    skipPull: rawOptions.skipPull ?? false,
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
  };

  const format = globalOptions.output ?? "text";

  logDebug(`Rebuild options: ${JSON.stringify(options)}`);

  // Load configuration
  const config = await loadConfig();
  const finalConfig = applyCliOverrides(config, {
    composePath: options.composePath,
    envFile: options.envFile,
    profile:
      options.profile !== undefined && isValidProfile(options.profile, config)
        ? options.profile
        : undefined,
    noSidecars: options.noSidecars,
  });

  const healthTimeout =
    Number.isFinite(options.healthTimeout) && options.healthTimeout > 0
      ? options.healthTimeout
      : finalConfig.healthCheck.timeout;
  const waitForReady = rawOptions.waitForReady ?? finalConfig.healthCheck.waitForReady;

  // Resolve parallel execution options from CLI flags -> config defaults
  const useParallel = options.parallel ?? finalConfig.parallel.enabled;
  const workerCount =
    options.workers !== undefined && Number.isFinite(options.workers) && options.workers > 0
      ? options.workers
      : finalConfig.parallel.workers;

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
    process.cwd(),
    { envTool },
  );

  if (resolved === null) {
    return; // User cancelled or no services selected
  }

  const { services, profiles } = resolved;

  logDebug(`Using profiles: ${profiles.join(", ")}`);
  logDebug(`Rebuilding services: ${services.length > 0 ? services.join(", ") : "all"}`);

  // Dry run mode
  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const pullNote = options.skipPull ? " (skip pull)" : " (stop → pull → build → start)";
    const parallelNote = useParallel ? ` [parallel, workers: ${workerCount}]` : "";
    logInfo(formatDryRun(`rebuild services: ${serviceList}${pullNote}${parallelNote}`));

    // Show parallel execution plan in dry-run mode
    if (useParallel && services.length > 0) {
      const graph = await computeExecutionPhases(
        finalConfig.composePath,
        finalConfig,
        services,
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
      logInfo("Stop phase: reverse dependency order (Phase N → Phase 0)");
      logInfo("Pull/Build phase: forward dependency order");
      logInfo("Start phase: forward dependency order (Phase 0 → Phase N)");
      logInfo(formatExecutionPlan(graph.phases, workerCount));
    }

    if (format !== "text") {
      await formatOutput(format, {
        dryRun: true,
        services: services.length > 0 ? services : ["all"],
        profiles,
        composePath: finalConfig.composePath,
        skipPull: options.skipPull,
        phases: options.skipPull ? ["stop", "build", "start"] : ["stop", "pull", "build", "start"],
        waitForReady,
        healthTimeout,
        parallel: useParallel,
        workers: workerCount,
      });
    }
    return;
  }

  // Confirmation if not --yes
  if (!options.yes && !isMachineFormat(format)) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const pullNote = options.skipPull
      ? " (stop → build → start)"
      : " (stop → pull → build → start)";
    const confirmed = await confirm(`Rebuild ${serviceList}${pullNote}?`);
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  // Execute rebuild
  const result: RebuildResult = {
    services: [],
    failed: [],
    healthy: [],
    unhealthy: [],
    completedPhases: [],
    rebuilt: 0,
  };

  if (useParallel && services.length > 0) {
    // -------------------------------------------------------------------------
    // Parallel execution path
    // -------------------------------------------------------------------------
    try {
      // Build dependency graph for phased execution
      const graph = await computeExecutionPhases(
        finalConfig.composePath,
        finalConfig,
        services,
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

      logDebug(`Parallel rebuild: ${graph.phases.length} phases, workers: ${workerCount}`);

      // Prepare reversed phases for stop operation (Phase N first, Phase 0 last)
      const reversedPhases = [...graph.phases].reverse();

      // Parallel Phase 1: Stop services in REVERSE dependency order
      logInfo("Stopping services in parallel (reverse dependency order)...");
      const stopResult = await executeParallelPhases({
        phases: reversedPhases,
        composePath: finalConfig.composePath,
        operation: "stop",
        workers: workerCount,
        dependencyMap: graph.dependencyMap,
        envTool,
        profiles,
      });

      result.completedPhases.push("stop");

      if (stopResult.failed.length > 0) {
        const failedNames = stopResult.failed.map((f) => f.name).join(", ");
        logWarn(`Some services failed to stop: ${failedNames}`);
        result.failed.push(...stopResult.failed);
      }

      if (stopResult.succeeded.length > 0) {
        logSuccess(`Successfully stopped ${stopResult.succeeded.length} services`);
      }

      // Parallel Phase 2: Pull images (unless --skip-pull)
      if (!options.skipPull) {
        logInfo("Pulling images in parallel...");
        const pullResult = await executeParallelPhases({
          phases: graph.phases,
          composePath: finalConfig.composePath,
          operation: "pull",
          workers: workerCount,
          dependencyMap: graph.dependencyMap,
          envTool,
          profiles,
        });

        result.completedPhases.push("pull");

        if (pullResult.failed.length > 0) {
          const failedNames = pullResult.failed.map((f) => f.name).join(", ");
          logWarn(`Some images failed to pull: ${failedNames}`);
          // Merge pull failures, avoiding duplicates from stop phase
          for (const failure of pullResult.failed) {
            if (!result.failed.some((f) => f.name === failure.name)) {
              result.failed.push(failure);
            }
          }
        }

        if (pullResult.succeeded.length > 0) {
          logSuccess(`Successfully pulled images for ${pullResult.succeeded.length} services`);
        }
      } else {
        logInfo("Skipping image pull (--skip-pull)");
      }

      // Parallel Phase 3: Build containers
      logInfo("Building containers in parallel...");
      const buildResult = await executeParallelPhases({
        phases: graph.phases,
        composePath: finalConfig.composePath,
        operation: "build",
        workers: workerCount,
        dependencyMap: graph.dependencyMap,
        envTool,
        profiles,
      });

      result.completedPhases.push("build");

      if (buildResult.failed.length > 0) {
        const failedNames = buildResult.failed.map((f) => f.name).join(", ");
        logWarn(`Some containers failed to build: ${failedNames}`);
        for (const failure of buildResult.failed) {
          if (!result.failed.some((f) => f.name === failure.name)) {
            result.failed.push(failure);
          }
        }
      }

      if (buildResult.succeeded.length > 0) {
        logSuccess(`Successfully built ${buildResult.succeeded.length} containers`);
      }

      // Parallel Phase 4: Start services in forward dependency order (force-recreate always)
      logInfo("Starting services in parallel (force-recreate)...");
      const startResult = await executeParallelPhases({
        phases: graph.phases,
        composePath: finalConfig.composePath,
        operation: "start",
        workers: workerCount,
        dependencyMap: graph.dependencyMap,
        envTool,
        noPull: !options.skipPull,
        forceRecreate: true,
        profiles,
      });

      result.completedPhases.push("start");

      if (startResult.failed.length > 0) {
        const failedNames = startResult.failed.map((f) => f.name).join(", ");
        logWarn(`Some services failed to start: ${failedNames}`);
        for (const failure of startResult.failed) {
          if (!result.failed.some((f) => f.name === failure.name)) {
            result.failed.push(failure);
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
        profiles,
        envTool,
      });

      // Aggregate results into RebuildResult shape
      result.services = services;
      result.rebuilt = startResult.succeeded.length;

      // Set exit code if any service failed
      if (result.failed.length > 0) {
        process.exitCode = 1;
        for (const failure of result.failed) {
          const error = new DockerCommandError(
            "parallel-rebuild",
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
      const healthyServices = startResult.succeeded;
      if (healthyServices.length > 0) {
        if (waitForReady) {
          logInfo("Waiting for dependency readiness...");
        } else {
          logInfo("Checking dependency readiness snapshot (--no-wait-for-ready)...");
        }

        let lastReadinessSignature = "";
        const readinessSummary = await waitForDependencyReadiness({
          composePath: finalConfig.composePath,
          targetServices: healthyServices,
          projectDir: process.cwd(),
          profiles,
          envTool,
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
          process.exitCode = 1;
        } else if (!readinessSummary.ready && readinessUnavailable) {
          logWarn("Dependency readiness checks unavailable. Continuing with startup verification.");
        }

        // Populate healthy list from succeeded services minus unhealthy
        result.healthy = healthyServices.filter((s) => !result.unhealthy.includes(s));
      }

      // Record rebuild state (batch after completion)
      if (services.length > 0) {
        try {
          const db = await initializeDatabase();
          const timestamp = new Date().toISOString();
          const serviceImageMap = await inspectContainersWithRetry(services);

          const rebuildEntries = services.map((service) => {
            const isFailed = result.failed.some((f) => f.name === service);
            const isUnhealthy = result.unhealthy.includes(service);
            const failureEntry = result.failed.find((f) => f.name === service);
            return {
              timestamp,
              service,
              action: "rebuild" as const,
              imageTag: serviceImageMap.get(service),
              configSnapshot: serviceImageMap.get(service)
                ? JSON.stringify({ image: serviceImageMap.get(service) })
                : undefined,
              status: isFailed || isUnhealthy ? ("failed" as const) : ("success" as const),
              planId: undefined,
              errorMessage: isFailed
                ? (failureEntry?.error ?? "Service failed during parallel rebuild")
                : isUnhealthy
                  ? "Service failed health check after rebuild"
                  : undefined,
            };
          });

          recordDeployments(db, rebuildEntries);
          closeDatabase(db);
        } catch (stateError) {
          logWarn(
            `Failed to record rebuild state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const formatted = formatError(errorObj);
      outputFormattedError(formatted);
      result.failed.push({
        name: "rebuild",
        error: errorObj.message,
      });
      process.exitCode = 1;

      // Record failed rebuild state for parallel path
      if (services.length > 0) {
        try {
          const db = await initializeDatabase();
          const timestamp = new Date().toISOString();

          const failedEntries = services.map((service) => ({
            timestamp,
            service,
            action: "rebuild" as const,
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
            `Failed to record rebuild state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
      }
    }
  } else {
    // -------------------------------------------------------------------------
    // Sequential execution path (existing behavior, unchanged)
    // -------------------------------------------------------------------------
    try {
      // Phase 1: Stop services
      logInfo(`Phase 1/4: Stopping services...`);

      const stopResult = await stopServices(
        finalConfig.composePath,
        services.length > 0 ? services : undefined,
        { streamOutput: true, profiles, envTool },
      );

      if (!stopResult.success) {
        const stopError = new DockerCommandError(
          "stop",
          stopResult.stderr,
          stopResult.code,
          services.length > 0 ? services : ["all"],
          false,
        );
        const formattedErr = formatError(stopError);
        outputFormattedError(formattedErr);
        result.failed.push({
          name: "stop",
          error: stopError.message,
        });
        process.exitCode = 1;

        if (format !== "text") {
          await formatOutput(format, result);
        }
        return;
      }

      result.completedPhases.push("stop");
      logSuccess(`Stopped services`);

      // Phase 2: Pull images (unless --skip-pull)
      if (!options.skipPull) {
        logInfo(`Phase 2/4: Pulling images...`);

        const pullResult = await pullImages(
          finalConfig.composePath,
          services.length > 0 ? services : undefined,
          { streamOutput: true, profiles, envTool },
        );

        if (!pullResult.success) {
          const pullError = new ImagePullError(
            services.length > 0 ? services : ["all"],
            pullResult.stderr,
          );
          const formattedErr = formatError(pullError);
          outputFormattedError(formattedErr);
          result.failed.push({
            name: "pull",
            error: pullError.message,
          });
          process.exitCode = 1;

          if (format !== "text") {
            await formatOutput(format, result);
          }
          return;
        }

        result.completedPhases.push("pull");
        logSuccess(`Pulled images`);
      } else {
        logInfo(`Phase 2/4: Skipping pull (--skip-pull)`);
      }

      // Phase 3: Build containers
      logInfo(`Phase 3/4: Building containers...`);

      const buildResult = await buildImages(
        finalConfig.composePath,
        services.length > 0 ? services : undefined,
        { streamOutput: true, profiles, envTool },
      );

      if (!buildResult.success) {
        const buildError = new DockerCommandError(
          "build",
          buildResult.stderr,
          buildResult.code,
          services.length > 0 ? services : ["all"],
          false,
        );
        const formattedErr = formatError(buildError);
        outputFormattedError(formattedErr);
        result.failed.push({
          name: "build",
          error: buildError.message,
        });
        process.exitCode = 1;

        if (format !== "text") {
          await formatOutput(format, result);
        }
        return;
      }

      result.completedPhases.push("build");
      logSuccess(`Built containers`);

      // Phase 4: Start services with force-recreate
      // Force-recreate is always enabled since containers were just rebuilt
      logInfo(`Phase 4/4: Starting services (force-recreate)...`);

      const startResult = await startServices(
        finalConfig.composePath,
        services.length > 0 ? services : undefined,
        { streamOutput: true, profiles, forceRecreate: true, envTool },
      );

      if (!startResult.success) {
        const startError = new ServiceStartError(
          services.length > 0 ? services : ["all"],
          startResult.stderr,
        );
        const formattedErr = formatError(startError);
        outputFormattedError(formattedErr);
        result.failed.push({
          name: "start",
          error: startError.message,
        });
        process.exitCode = 1;

        if (format !== "text") {
          await formatOutput(format, result);
        }
        return;
      }

      result.completedPhases.push("start");
      logSuccess(`Started services`);

      // Dependency readiness check
      if (waitForReady) {
        logInfo("Waiting for dependency readiness...");
      } else {
        logInfo("Checking dependency readiness snapshot (--no-wait-for-ready)...");
      }

      let lastReadinessSignature = "";
      const readinessSummary = await waitForDependencyReadiness({
        composePath: finalConfig.composePath,
        targetServices: services,
        projectDir: process.cwd(),
        profiles,
        envTool,
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
        const healthError = new DockerCommandError(
          "health-check",
          `Dependencies not ready within timeout: ${notReadyDependencies.join(", ")}`,
          1,
          notReadyDependencies,
          false,
        );
        const formattedErr = formatError(healthError);
        outputFormattedError(formattedErr);
        process.exitCode = 1;
      } else if (!readinessSummary.ready && readinessUnavailable) {
        logWarn("Dependency readiness checks unavailable. Continuing with startup verification.");
      }

      // Get running containers
      const containersResult = await getRunningContainers(finalConfig.composePath, {
        profiles,
        envTool,
      });

      if (containersResult.success) {
        const runningContainers = containersResult.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        result.healthy = runningContainers;
        result.services = services.length > 0 ? services : ["all"];
        result.rebuilt = runningContainers.length;

        // Check for unhealthy (services that were supposed to start but aren't running)
        if (services.length > 0) {
          for (const service of services) {
            const isRunning = runningContainers.some((c) =>
              c.toLowerCase().includes(service.toLowerCase()),
            );
            if (!isRunning) {
              result.unhealthy.push(service);
            }
          }
        }

        if (result.unhealthy.length > 0) {
          const healthError = new DockerCommandError(
            "health-check",
            `Services failed health check: ${result.unhealthy.join(", ")}`,
            1,
            result.unhealthy,
            false,
          );
          const formattedErr = formatError(healthError);
          outputFormattedError(formattedErr);
          process.exitCode = 1;
        } else {
          logSuccess(`Rebuild complete: ${result.rebuilt} containers running`);
        }
      } else {
        // Status check failed but rebuild completed - log as warning, not error
        logWarn(`Status check failed (SSH connection issue). Services were started successfully.`);
        logDebug(`Status check error: ${containersResult.stderr}`);
        result.services = services.length > 0 ? services : ["all"];
        result.rebuilt = services.length > 0 ? services.length : 1;
        logSuccess(`Rebuild complete (status check skipped)`);
      }

      // Record rebuild state for successful rebuilds
      // For "rebuild all", use the healthy containers as the service list
      let rebuiltServices = services;
      if (services.length === 0 && result.healthy.length > 0) {
        rebuiltServices = result.healthy;
        logDebug(`Recording "rebuild all" with ${rebuiltServices.length} services`);
      }

      if (rebuiltServices.length > 0) {
        try {
          const db = await initializeDatabase();
          const timestamp = new Date().toISOString();

          // Get container info to capture image tags with retry logic
          const serviceImageMap = await inspectContainersWithRetry(rebuiltServices);

          // Build batch entries for recording
          const rebuildEntries = rebuiltServices.map((service) => ({
            timestamp,
            service,
            action: "rebuild" as const,
            imageTag: serviceImageMap.get(service),
            configSnapshot: serviceImageMap.get(service)
              ? JSON.stringify({ image: serviceImageMap.get(service) })
              : undefined,
            status: result.unhealthy.includes(service) ? ("failed" as const) : ("success" as const),
            planId: undefined,
            errorMessage: result.unhealthy.includes(service)
              ? "Service failed health check after rebuild"
              : undefined,
          }));

          recordDeployments(db, rebuildEntries);
          closeDatabase(db);
        } catch (stateError) {
          logWarn(
            `Failed to record rebuild state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const formattedErr = formatError(errorObj);
      outputFormattedError(formattedErr);
      result.failed.push({
        name: "rebuild",
        error: errorObj.message,
      });
      process.exitCode = 1;

      // Record failed rebuild state
      const failedServices = services.length > 0 ? services : [];
      if (failedServices.length > 0) {
        try {
          const db = await initializeDatabase();
          const timestamp = new Date().toISOString();

          const failedEntries = failedServices.map((service) => ({
            timestamp,
            service,
            action: "rebuild" as const,
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
            `Failed to record rebuild state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
          );
        }
      }
    }
  }

  // Output in requested format (json, yaml, csv, table)
  if (format !== "text") {
    await formatOutput(format, result);
  }
}
