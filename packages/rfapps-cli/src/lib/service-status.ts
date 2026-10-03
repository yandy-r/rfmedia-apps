/**
 * Service status retrieval utilities for rfapps CLI
 *
 * Provides functions to retrieve service status for UI display,
 * mapping compose services to their container states.
 */

import { logDebug, logError } from "@rfmedia/common";

import type { ContainerState, HealthStatus } from "../types/results.js";
import type { EnvToolExecConfig } from "../types/options.js";
import { execDockerCompose, getComposeServices, filterToolOutput } from "./docker.js";

/**
 * Default cache TTL in milliseconds (10 seconds).
 *
 * This prevents excessive docker ps calls when the status is requested
 * multiple times in quick succession (e.g., during interactive selection).
 */
const DEFAULT_STATUS_CACHE_TTL_MS = 10_000;

/**
 * Timeout for status calls in milliseconds (15 seconds).
 *
 * Shorter than default Docker command timeout to ensure interactive
 * operations remain responsive in high-latency environments.
 */
const STATUS_CALL_TIMEOUT_MS = 15_000;

/**
 * Cached status map entry with timestamp
 */
interface CachedStatusMap {
  /** The cached status map */
  map: Map<string, ServiceStatusEntry>;
  /** Timestamp when the cache was created */
  timestamp: number;
  /** Cache key (derived from composePath and projectDir) */
  key: string;
}

/**
 * Module-level cache for status maps
 */
let statusCache: CachedStatusMap | null = null;

/**
 * Generate cache key from compose path and project directory
 */
function getCacheKey(
  composePath: string,
  projectDir: string,
  projectName: string | undefined,
  envFile: string | undefined,
  envTool: EnvToolExecConfig | undefined,
  profiles: readonly string[] | undefined,
): string {
  return JSON.stringify({
    composePath,
    projectDir,
    projectName: projectName ?? null,
    envFile: envFile ?? null,
    envTool: envTool ?? null,
    profiles: profiles ?? [],
  });
}

/**
 * Check if cached status is still valid
 */
function isCacheValid(cacheKey: string, ttlMs: number = DEFAULT_STATUS_CACHE_TTL_MS): boolean {
  if (statusCache === null) {
    return false;
  }
  if (statusCache.key !== cacheKey) {
    return false;
  }
  return Date.now() - statusCache.timestamp < ttlMs;
}

/**
 * Clear the status cache.
 *
 * Call this when you know the container state has changed
 * (e.g., after starting/stopping services).
 */
export function clearServiceStatusCache(): void {
  statusCache = null;
  logDebug("Service status cache cleared");
}

/**
 * Service status entry containing state and health information
 */
export interface ServiceStatusEntry {
  /** Container state (running, exited, created, etc.) */
  state: ContainerState;
  /** Health check status (healthy, unhealthy, starting, none) */
  health: HealthStatus;
}

/**
 * Docker ps JSON output structure
 */
interface DockerPsJson {
  Service?: string;
  State: string;
  Health?: string;
  Status: string;
}

/**
 * Parse container state from docker ps State field.
 *
 * Maps Docker's state string to a typed ContainerState enum value.
 * Defaults to 'exited' for unrecognized states.
 *
 * @param state - Raw state string from docker ps output
 * @returns Normalized ContainerState value
 */
function parseContainerState(state: string): ContainerState {
  const normalized = state.toLowerCase();
  if (normalized === "running") return "running";
  if (normalized === "exited") return "exited";
  if (normalized === "paused") return "paused";
  if (normalized === "restarting") return "restarting";
  if (normalized === "dead") return "dead";
  if (normalized === "created") return "created";
  return "exited";
}

/**
 * Parse health status from docker ps Status field
 *
 * @param status - Raw status string from docker ps output (e.g., "Up 2 hours (healthy)")
 * @returns Normalized HealthStatus value
 */
function parseHealthStatus(status: string, health?: string): HealthStatus {
  const lower = `${health ?? ""} ${status}`.toLowerCase();
  if (/\bunhealthy\b/.test(lower)) return "unhealthy";
  if (/\bhealthy\b/.test(lower)) return "healthy";
  if (/\bstarting\b/.test(lower)) return "starting";
  return "none";
}

/**
 * Options for getServiceStatusMap
 */
export interface GetServiceStatusMapOptions {
  /** Explicit Compose project name for project-scoped status commands. */
  projectName?: string;
  /** Plain Compose environment file used for interpolation. */
  envFile?: string;
  /** Env tool configuration for secrets injection */
  envTool?: EnvToolExecConfig;
  /** In-memory environment captured for authority-sensitive execution. */
  env?: Record<string, string>;
  /** Do not inherit the parent process environment. */
  replaceEnv?: boolean;
  /** Compose profiles to include */
  profiles?: string[];
  /** Cache TTL in milliseconds (default: 10000ms). Set to 0 to disable caching. */
  cacheTtlMs?: number;
  /** Timeout in milliseconds for docker commands (default: 15000ms) */
  timeoutMs?: number;
  /** Force refresh the cache even if valid */
  forceRefresh?: boolean;
  /** Pre-fetched service list to skip redundant getComposeServices() call */
  preloadedServices?: string[];
}

/**
 * Get a map of service names to their current status (state and health).
 *
 * This function retrieves all services from the compose file and matches them
 * with their running containers to provide status information. Services without
 * containers are assigned state 'created' and health 'none'.
 *
 * Results are cached for the configured TTL (default 10 seconds) to prevent
 * excessive docker ps calls in interactive operations.
 *
 * @param composePath - Path to the Docker Compose file
 * @param projectDir - Project directory (used to derive project name for container matching)
 * @param options - Optional configuration including env tool, cache settings, and timeout
 * @returns Map with service name as key and { state, health } as value
 *
 * @example
 * ```typescript
 * const statusMap = await getServiceStatusMap('./compose.yml', '/path/to/project');
 * const traefikStatus = statusMap.get('traefik');
 * // { state: 'running', health: 'healthy' }
 *
 * // Disable caching for real-time status
 * const freshStatus = await getServiceStatusMap('./compose.yml', '/path/to/project', {
 *   cacheTtlMs: 0
 * });
 * ```
 */
export async function getServiceStatusMap(
  composePath: string,
  projectDir: string,
  options: GetServiceStatusMapOptions = {},
): Promise<Map<string, ServiceStatusEntry>> {
  const {
    projectName,
    envFile,
    envTool,
    env,
    replaceEnv,
    profiles,
    cacheTtlMs = DEFAULT_STATUS_CACHE_TTL_MS,
    timeoutMs = STATUS_CALL_TIMEOUT_MS,
    forceRefresh = false,
    preloadedServices,
  } = options;

  const cacheKey = getCacheKey(composePath, projectDir, projectName, envFile, envTool, profiles);

  // Return cached result if valid and not forcing refresh
  if (!forceRefresh && cacheTtlMs > 0 && isCacheValid(cacheKey, cacheTtlMs)) {
    logDebug("Returning cached service status map");
    return new Map(statusCache!.map);
  }

  const statusMap = new Map<string, ServiceStatusEntry>();

  // Get all service names from compose file (skip if pre-fetched services provided)
  const services =
    preloadedServices ??
    (await getComposeServices(composePath, {
      profiles,
      projectName,
      envFile,
      envTool,
      env,
      replaceEnv,
      timeout: timeoutMs,
    }));
  if (services.length === 0) {
    logError("No services found in compose file");
    return statusMap;
  }

  logDebug(`Found ${services.length} services in compose file`);

  // Initialize all services with default status (not running)
  for (const service of services) {
    statusMap.set(service, { state: "created", health: "none" });
  }

  // Query through Compose itself so project name, top-level name, profiles, and
  // environment-injected COMPOSE_PROJECT_NAME use the same resolution as apply.
  const profileArgs = (profiles ?? []).flatMap((profile) => ["--profile", profile]);
  const result = await execDockerCompose(
    [
      "-f",
      composePath,
      ...(projectName === undefined ? [] : ["--project-name", projectName]),
      ...(envFile === undefined ? [] : ["--env-file", envFile]),
      ...profileArgs,
      "ps",
      "-a",
      "--format",
      "json",
    ],
    { cwd: projectDir, envTool, env, replaceEnv, timeout: timeoutMs },
  );
  if (!result.success) {
    logError(`Failed to list containers: ${result.stderr}`);
    return statusMap;
  }

  const filteredOutput = filterToolOutput(result.stdout.trim().split("\n"))
    .filter((line) => line.length > 0)
    .join("\n");
  let containers: DockerPsJson[] = [];
  if (filteredOutput !== "") {
    try {
      const parsed = JSON.parse(filteredOutput) as DockerPsJson | DockerPsJson[];
      containers = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      containers = filteredOutput.split("\n").flatMap((line): DockerPsJson[] => {
        try {
          return [JSON.parse(line) as DockerPsJson];
        } catch {
          logDebug(`Failed to parse container line: ${line}`);
          return [];
        }
      });
    }
  }

  for (const data of containers) {
    try {
      const serviceName = data.Service;
      if (serviceName === undefined || serviceName === "") continue;

      // Only update if this is a known service
      if (statusMap.has(serviceName)) {
        statusMap.set(serviceName, {
          state: parseContainerState(data.State),
          health: parseHealthStatus(data.Status, data.Health),
        });
        logDebug(`Service ${serviceName}: state=${data.State}, health from status=${data.Status}`);
      }
    } catch {
      logDebug(`Failed to parse Compose status for service ${data.Service ?? "<unknown>"}`);
    }
  }

  // Update cache if caching is enabled
  if (cacheTtlMs > 0) {
    statusCache = {
      map: new Map(statusMap),
      timestamp: Date.now(),
      key: cacheKey,
    };
    logDebug("Service status map cached");
  }

  return statusMap;
}
