/**
 * Parallel executor for dependency-aware phased service operations.
 *
 * Executes Docker operations across topologically-sorted phases, where:
 * - Phases execute sequentially (Phase 0 completes before Phase 1 starts)
 * - Services within each phase execute concurrently up to a worker limit
 * - One service failure does NOT stop other services in the same phase
 * - Failed dependencies cause downstream services to be skipped
 *
 * Uses listr2 (via `@rfmedia/common`) for concurrent task display with
 * captured output mode (`streamOutput: false`) to prevent interleaving.
 *
 * @module rfapps-cli/lib/parallel-executor
 */

import { logDebug, logWarn, runTasks } from "@rfmedia/common";
import type { ListrTask } from "listr2";

import type { EnvToolExecConfig } from "../types/options.js";
import type { ExecutionPhase, ParallelExecutionResult, PhaseResult } from "../types/parallel.js";
import type { FailedOperation } from "../types/results.js";
import type { DockerComposeExecOptions, DockerExecResult } from "./docker.js";
import { buildImages, execDockerCompose, pullImages, stopServices } from "./docker.js";

/**
 * Options for parallel phase execution.
 */
export interface ParallelExecuteOptions extends Pick<
  DockerComposeExecOptions,
  "cwd" | "env" | "replaceEnv" | "envFile" | "projectName"
> {
  /** Topologically-sorted execution phases */
  phases: ExecutionPhase[];
  /** Path to the Docker Compose file */
  composePath: string;
  /** Docker operation to perform */
  operation: "pull" | "start" | "stop" | "build";
  /** Maximum concurrent workers per phase */
  workers: number;
  /** Per-service dependency map (when set, used for per-service skip logic) */
  dependencyMap?: Map<string, string[]>;
  /** Env tool for secrets injection (e.g. --use-op, --use-dotenvx) */
  envTool?: EnvToolExecConfig;
  /** For start: when true, add --pull never (we already ran pull phase) */
  noPull?: boolean;
  /** Whether to force-recreate containers (start operation only) */
  forceRecreate?: boolean;
  /** Whether this is a dry-run (skip actual execution) */
  dryRun?: boolean;
  /** Docker Compose profiles to activate */
  profiles?: string[];
}

/**
 * Execute Docker operations across dependency-sorted phases.
 *
 * Phases execute sequentially; services within each phase execute concurrently
 * up to the `workers` limit. Uses `Promise.allSettled` semantics so that one
 * service failure does not block other services in the same phase.
 *
 * When a service in Phase N fails, services in Phase N+1 that depend on it
 * are skipped (marked as failed with reason "dependency failed"). Services
 * whose dependencies all succeeded still execute.
 *
 * Does NOT set `process.exitCode` -- the caller is responsible for that.
 * Does NOT throw -- returns aggregated results for the caller to inspect.
 *
 * @param options - Parallel execution options
 * @returns Aggregated results across all phases
 */
export async function executeParallelPhases(
  options: ParallelExecuteOptions,
): Promise<ParallelExecutionResult> {
  const { phases, composePath, operation, workers, dependencyMap } = options;
  const allPhaseResults: PhaseResult[] = [];
  const allFailedServices = new Set<string>();

  for (const phase of phases) {
    // Skip empty phases
    if (phase.services.length === 0) {
      continue;
    }

    // Filter out services whose dependencies failed in prior phases
    const { executable, skipped } = filterByDependencyFailures(
      phase,
      allFailedServices,
      dependencyMap,
    );

    // Record skipped services as failed
    const phaseResult: PhaseResult = {
      phase: phase.phase,
      services: phase.services,
      succeeded: [],
      failed: skipped.map((service) => ({
        name: service,
        error: "Skipped: dependency failed in prior phase",
      })),
    };

    // Track skipped services as failed for downstream dependency filtering
    for (const service of skipped) {
      allFailedServices.add(service);
    }

    if (executable.length > 0) {
      logDebug(
        `Phase ${phase.phase}: executing ${operation} for ${executable.length} services (workers: ${Math.min(workers, executable.length)})`,
      );

      const results = await executePhaseServices(
        executable,
        composePath,
        operation,
        workers,
        options,
      );

      for (const result of results) {
        if (result.success) {
          phaseResult.succeeded.push(result.service);
        } else {
          phaseResult.failed.push({
            name: result.service,
            error: result.stderr,
          });
          allFailedServices.add(result.service);
        }
      }
    }

    // Log warnings for phase failures but continue to next phase
    if (phaseResult.failed.length > 0) {
      const failedNames = phaseResult.failed.map((f) => f.name).join(", ");
      logWarn(
        `Phase ${phase.phase}: ${phaseResult.failed.length} service(s) failed: ${failedNames}`,
      );
    }

    allPhaseResults.push(phaseResult);
  }

  return aggregateExecutionResult(allPhaseResults);
}

/**
 * Format a dry-run display of the execution plan.
 *
 * Shows phase numbers, services per phase, total worker parallelism,
 * and estimated concurrency per phase.
 *
 * @param phases - Execution phases from dependency graph
 * @param workers - Maximum concurrent workers
 * @returns Formatted string for display
 */
export function formatExecutionPlan(phases: ExecutionPhase[], workers: number): string {
  const lines: string[] = [];
  lines.push(`Parallel Execution Plan (workers: ${workers})`);

  for (const phase of phases) {
    if (phase.services.length === 0) continue;

    const depDescription =
      phase.phase === 0 ? "no dependencies" : `depends on Phase ${phase.phase - 1}`;
    const effectiveConcurrency = Math.min(workers, phase.services.length);

    lines.push(
      `  Phase ${phase.phase}: ${phase.services.length} services (${depDescription}) [concurrency: ${effectiveConcurrency}]`,
    );

    // Show service names, truncating if many
    const maxDisplay = 8;
    const serviceList =
      phase.services.length <= maxDisplay
        ? phase.services.join(", ")
        : `${phase.services.slice(0, maxDisplay).join(", ")}, ... (+${phase.services.length - maxDisplay} more)`;

    lines.push(`    ${serviceList}`);
  }

  const totalServices = phases.reduce((sum, p) => sum + p.services.length, 0);
  lines.push(`  Total: ${totalServices} services across ${phases.length} phases`);

  return lines.join("\n");
}

/**
 * Map a Docker operation string to the appropriate Docker function call.
 *
 * Handles `streamOutput: false` for parallel mode and strips `--remove-orphans`
 * from per-service start calls (the caller should run a cleanup pass after).
 *
 * @param operation - The Docker operation to perform
 * @param composePath - Path to the Docker Compose file
 * @param services - Services to operate on
 * @param options - Additional options (forceRecreate, profiles, envTool, noPull)
 * @returns Docker execution result
 */
export async function mapDockerOperation(
  operation: "pull" | "start" | "stop" | "build",
  composePath: string,
  services: string[],
  options: Pick<
    DockerComposeExecOptions,
    "cwd" | "env" | "replaceEnv" | "envFile" | "projectName"
  > & {
    streamOutput?: boolean;
    forceRecreate?: boolean;
    profiles?: string[];
    envTool?: EnvToolExecConfig;
    noPull?: boolean;
  } = {},
): Promise<DockerExecResult> {
  const execOptions = {
    streamOutput: options.streamOutput ?? false,
    profiles: options.profiles,
    envTool: options.envTool,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.replaceEnv === undefined ? {} : { replaceEnv: options.replaceEnv }),
    ...(options.envFile === undefined ? {} : { envFile: options.envFile }),
    ...(options.projectName === undefined ? {} : { projectName: options.projectName }),
  };

  switch (operation) {
    case "pull":
      return pullImages(composePath, services, execOptions);

    case "stop":
      return stopServices(composePath, services, execOptions);

    case "build":
      return buildImages(composePath, services, execOptions);

    case "start": {
      // Build args manually to avoid startServices() hardcoded --remove-orphans.
      // Per-service parallel calls must NOT include --remove-orphans to prevent
      // conflicts between concurrent docker compose invocations.
      const args = ["-f", composePath];

      if (options.projectName !== undefined) {
        args.push("--project-name", options.projectName);
      }

      if (options.envFile !== undefined && options.envFile.trim() !== "") {
        args.push("--env-file", options.envFile);
      }

      if (options.profiles !== undefined) {
        for (const profile of options.profiles) {
          args.push("--profile", profile);
        }
      }

      args.push("up", "-d");

      if (options.noPull === true) {
        args.push("--pull", "never");
      }

      if (options.forceRecreate === true) {
        args.push("--force-recreate");
      }

      if (services.length > 0) {
        args.push(...services);
      }

      return execDockerCompose(args, {
        streamOutput: options.streamOutput ?? false,
        envTool: options.envTool,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.replaceEnv === undefined ? {} : { replaceEnv: options.replaceEnv }),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Per-service execution result used internally before aggregation.
 */
interface ServiceExecutionResult {
  /** Service name */
  service: string;
  /** Whether the operation succeeded */
  success: boolean;
  /** Standard error output (for failure diagnostics) */
  stderr: string;
}

/**
 * Execute Docker operations for all services in a phase concurrently.
 *
 * Uses listr2 via `runTasks()` with `concurrent` set to the worker limit
 * and `exitOnError: false` for `Promise.allSettled` semantics.
 *
 * @returns Per-service execution results
 */
async function executePhaseServices(
  services: string[],
  composePath: string,
  operation: "pull" | "start" | "stop" | "build",
  workers: number,
  options: ParallelExecuteOptions,
): Promise<ServiceExecutionResult[]> {
  const results: ServiceExecutionResult[] = [];

  const tasks: ListrTask[] = services.map((service) => ({
    title: `${operation} ${service}`,
    task: async (_ctx: unknown, task: { title: string }) => {
      const result = await mapDockerOperation(operation, composePath, [service], {
        streamOutput: false,
        forceRecreate: options.forceRecreate,
        profiles: options.profiles,
        envTool: options.envTool,
        noPull: options.noPull,
        cwd: options.cwd,
        env: options.env,
        replaceEnv: options.replaceEnv,
        envFile: options.envFile,
        projectName: options.projectName,
      });

      results.push({
        service,
        success: result.success,
        stderr: result.stderr,
      });

      if (!result.success) {
        // Update task title to show failure but do NOT throw --
        // exitOnError: false means the task will be marked as failed
        // but other tasks continue.
        task.title = `${operation} ${service} - FAILED`;
        throw new Error(result.stderr || `${operation} failed for ${service}`);
      }

      task.title = `${operation} ${service} - done`;
    },
  }));

  // listr2's Listr constructor accepts `concurrent: number` at runtime
  // even though the @rfmedia/common wrapper types it as `boolean`.
  // Cast to pass the worker count through for worker-limited concurrency.
  await runTasks(tasks, {
    concurrent: workers as unknown as boolean,
    exitOnError: false,
  });

  return results;
}

/**
 * Filter phase services based on failed dependencies from prior phases.
 *
 * When dependencyMap is provided: each service is skipped only if any of its
 * own dependencies (from the map) failed. When dependencyMap is not provided:
 * the phase's aggregate dependsOn is used (any failed dep in the phase skips
 * the whole phase) for backward compatibility.
 */
export function filterByDependencyFailures(
  phase: ExecutionPhase,
  failedServices: Set<string>,
  dependencyMap?: Map<string, string[]>,
): { executable: string[]; skipped: string[] } {
  if (failedServices.size === 0) {
    return { executable: [...phase.services], skipped: [] };
  }

  const executable: string[] = [];
  const skipped: string[] = [];

  for (const service of phase.services) {
    const hasFailedDep = dependencyMap
      ? (dependencyMap.get(service) ?? []).some((dep) => failedServices.has(dep))
      : phase.dependsOn.some((dep) => failedServices.has(dep));

    if (hasFailedDep) {
      skipped.push(service);
    } else {
      executable.push(service);
    }
  }

  return { executable, skipped };
}

/**
 * Aggregate per-phase results into a single execution result.
 */
function aggregateExecutionResult(phaseResults: PhaseResult[]): ParallelExecutionResult {
  const allSucceeded: string[] = [];
  const allFailed: FailedOperation[] = [];
  let totalServices = 0;

  for (const phase of phaseResults) {
    totalServices += phase.services.length;
    allSucceeded.push(...phase.succeeded);
    allFailed.push(...phase.failed);
  }

  return {
    phases: phaseResults,
    totalServices,
    succeeded: allSucceeded,
    failed: allFailed,
  };
}
