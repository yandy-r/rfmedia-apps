/**
 * Status command action for rfapps CLI
 *
 * Shows the status of Docker services with optional:
 * - Health check status
 * - Resource statistics
 * - Recent logs
 */

import {
  logInfo,
  logSuccess,
  logDebug,
  isMachineFormat,
  colors,
  formatDryRun,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";

import type { OutputFormat } from "@rfmedia/common";

import type {
  StatusOptions,
  GlobalOptions,
  StatusResult,
  ServiceStatus,
  ResourceStats,
  ContainerState,
  HealthStatus,
  RfappsConfig,
} from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  listContainers,
  getContainerStats,
  execDockerCompose,
  formatOutput,
  parseComposeFile,
  getTagIndex,
  applyTagAxis,
  explicitSelectorFlagNames,
} from "../lib/index.js";

// Imported from the implementation module rather than the `lib/` barrel: this is the shared
// `TagSelectorEmptyError` diagnosis, and the resolver imports the very same symbol, so both
// throw sites are provably explaining an empty tag selection the same way.
import { diagnoseEmptyTagSelection } from "../lib/tags/tag-suggestions.js";

import { DockerCommandError, TagSelectorEmptyError } from "../lib/errors.js";

/**
 * Parse raw container status options from CLI
 */
interface RawStatusOptions {
  service?: string;
  services?: string;
  /**
   * Hierarchical tag patterns, one entry per `--tag` occurrence.
   *
   * This interface is bespoke to `status` and deliberately does not extend
   * `ServiceTargetOptions` (no `-g`, no `--no-sidecars`), so the axis is declared here
   * as well as on the shared `StatusOptions`.
   */
  tag?: string[];
  all?: boolean;
  health?: boolean;
  stats?: boolean;
  logs?: boolean;
  compose?: string;
  envFile?: string;
}

/**
 * Parse container JSON from docker ps --format json
 */
interface DockerPsJson {
  ID: string;
  Image: string;
  Command: string;
  CreatedAt: string;
  RunningFor: string;
  Ports: string;
  State: string;
  Status: string;
  Size: string;
  Names: string;
  Labels: string;
  Mounts: string;
  Networks: string;
}

/**
 * Parse container stats JSON
 */
interface DockerStatsJson {
  Container: string;
  Name: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
  NetIO: string;
  BlockIO: string;
  PIDs: string;
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
 */
function parseHealthStatus(status: string): HealthStatus {
  const lower = status.toLowerCase();
  if (lower.includes("(healthy)")) return "healthy";
  if (lower.includes("(unhealthy)")) return "unhealthy";
  if (lower.includes("(health: starting)")) return "starting";
  return "none";
}

/**
 * Parse image name and tag
 */
function parseImage(image: string): { name: string; tag: string } {
  const parts = image.split(":");
  return {
    name: parts[0] ?? image,
    tag: parts[1] ?? "latest",
  };
}

/**
 * Parse ports from docker ps Ports field
 */
function parsePorts(ports: string): string[] {
  if (ports === "" || ports === undefined) return [];
  return ports
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Parse CPU percentage string
 */
function parseCpuPercent(cpuPerc: string): number {
  const match = cpuPerc.match(/(\d+\.?\d*)%/);
  return match?.[1] !== undefined ? parseFloat(match[1]) : 0;
}

/**
 * Parse memory usage string like "100MiB / 1GiB"
 */
function parseMemoryUsage(memUsage: string): { usage: number; limit: number } {
  const parts = memUsage.split("/").map((p) => p.trim());
  return {
    usage: parseMemoryValue(parts[0] ?? "0"),
    limit: parseMemoryValue(parts[1] ?? "0"),
  };
}

/**
 * Parse memory value with unit
 */
function parseMemoryValue(value: string): number {
  const match = value.match(/(\d+\.?\d*)\s*(B|KiB|MiB|GiB|TiB)?/i);
  if (match === null) return 0;

  const num = parseFloat(match[1] ?? "0");
  const unit = (match[2] ?? "B").toLowerCase();

  const multipliers: Record<string, number> = {
    b: 1,
    kib: 1024,
    mib: 1024 * 1024,
    gib: 1024 * 1024 * 1024,
    tib: 1024 * 1024 * 1024 * 1024,
  };

  return num * (multipliers[unit] ?? 1);
}

/**
 * Parse memory percentage string
 */
function parseMemoryPercent(memPerc: string): number {
  const match = memPerc.match(/(\d+\.?\d*)%/);
  return match?.[1] !== undefined ? parseFloat(match[1]) : 0;
}

/**
 * Format service status for display
 */
function formatServiceStatus(service: ServiceStatus): string {
  const stateColor = service.state === "running" ? colors.green : colors.red;
  const healthColor =
    service.health === "healthy"
      ? colors.green
      : service.health === "unhealthy"
        ? colors.red
        : service.health === "starting"
          ? colors.yellow
          : colors.gray;

  const stateStr = stateColor(service.state);
  const healthStr = service.health !== "none" ? ` (${healthColor(service.health)})` : "";
  const portsStr = service.ports.length > 0 ? ` [${service.ports.join(", ")}]` : "";

  return `  ${colors.bold(service.name)}: ${stateStr}${healthStr}${portsStr}`;
}

/**
 * Resolve `--tag` into the set of service keys `status` is allowed to report.
 *
 * `status` is the one command that never reaches `resolveServicesWithInteractive`
 * (design §7.9): it post-filters a bare `docker ps` on container names instead. The tag
 * axis is therefore applied here, but through the **same** `applyTagAxis` the resolver
 * uses, so `status --tag "media/**" -s traefik` and `rebuild --tag "media/**" -s traefik`
 * select identically. Divergent semantics for identical syntax across commands is exactly
 * what produces a wrong-target incident.
 *
 * Composition is INTERSECTION: the `-s` / `--services` names form BASE, the whole compose
 * universe stands in for BASE when neither was given, and the result is BASE ∩ matched.
 *
 * @param tagPatterns - One entry per `--tag` occurrence; callers guard against empty
 * @param options - Built status options, read for the `-s` / `--services` BASE
 * @param config - CLI-overridden config, for the compose path and `tags.mapping`
 * @returns The service keys a `docker ps` row must match, or `undefined` to not narrow
 * @throws TagSelectorEmptyError when the intersection is empty (P2 — never fall through)
 * @throws InvalidArgumentError when a `--tag` pattern is malformed
 */
async function resolveTaggedServices(
  tagPatterns: readonly string[],
  options: StatusOptions,
  config: RfappsConfig,
): Promise<ReadonlySet<string> | undefined> {
  const universe = await parseComposeFile(config.composePath);
  const index = await getTagIndex(config, config.composePath, universe);
  const axis = applyTagAxis(tagPatterns, index, universe);

  // Only an empty flag list yields "absent", which the caller's guard already excluded.
  // Reporting it as "do not narrow" keeps this branch honest instead of inventing a set.
  if (axis.kind === "absent") {
    return undefined;
  }

  // Empty `--services` entries are dropped, matching `hasServicesSelector`: `--services ""`
  // names nothing, so counting it as a BASE would turn the tag axis into a guaranteed
  // TagSelectorEmptyError instead of narrowing the whole universe.
  const named = [
    ...(options.service === undefined ? [] : [options.service]),
    ...(options.services ?? []).filter((name) => name.length > 0),
  ];
  const base = named.length > 0 ? named : universe;
  const selected = base.filter((service) => axis.matched.has(service));

  // P2, the single most important rule in the design: a zero-match tag NEVER degrades to
  // "no filter". `status -s bogus` exiting 0 today is a pre-existing inconsistency
  // (`status` never calls `validateServiceNames`); it is not a reason to propagate it.
  if (selected.length === 0) {
    const diagnosis = diagnoseEmptyTagSelection(axis.terms, axis.matched, index);

    throw new TagSelectorEmptyError(
      axis.terms.map((term) => term.source),
      explicitSelectorFlagNames({ service: options.service, services: options.services }),
      [...index.allTags],
      diagnosis.suggestion,
      diagnosis.staleServices,
    );
  }

  return new Set(selected);
}

/**
 * Execute the status command.
 *
 * Shows the current status of Docker services with optional health checks,
 * resource statistics, and recent logs.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode, etc.)
 *
 * @example
 * ```typescript
 * // Show status of all services
 * await executeStatus({}, { json: false });
 *
 * // Show status with stats for a specific service
 * await executeStatus({ service: 'traefik', stats: true }, {});
 * ```
 */
export async function executeStatus(
  rawOptions: RawStatusOptions,
  globalOptions: {
    dryRun?: boolean;
    debug?: boolean;
    json?: boolean;
    verbose?: boolean;
    output?: OutputFormat;
  },
): Promise<void> {
  // Build options
  const options: StatusOptions = {
    dryRun: globalOptions.dryRun ?? false,
    debug: globalOptions.debug ?? false,
    json: globalOptions.json ?? false,
    verbose: globalOptions.verbose ?? false,
    yes: false,
    service: rawOptions.service,
    services: rawOptions.services?.split(",").map((s) => s.trim()),
    tag: rawOptions.tag,
    noSidecars: false,
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    all: rawOptions.all ?? false,
    health: rawOptions.health ?? false,
    stats: rawOptions.stats ?? false,
    logs: rawOptions.logs ?? false,
  };

  logDebug(`Status options: ${JSON.stringify(options)}`);

  // Load configuration
  const config = await loadConfig();
  const finalConfig = applyCliOverrides(config, {
    composePath: options.composePath,
    envFile: options.envFile,
  });

  // Tag narrowing. P1 is STRUCTURAL for the hottest command in the CLI: with no --tag,
  // NOTHING below runs — no compose parse, no tag index, and no ConfigValidationError
  // from a malformed `tags.mapping` entry can reach `rfapps status`. This is a real `if`
  // guard rather than an argument expression precisely so the pre-#63 path is
  // unreachable rather than merely equivalent.
  const tagPatterns = options.tag;
  let selectedServices: ReadonlySet<string> | undefined;

  if (tagPatterns !== undefined && tagPatterns.length > 0) {
    selectedServices = await resolveTaggedServices(tagPatterns, options, finalConfig);
  }

  // Dry run mode
  if (options.dryRun) {
    logInfo(formatDryRun("show status of Docker services"));
    return;
  }

  // Get container list
  logDebug("Fetching container list...");
  const psResult = await listContainers(options.all);

  if (!psResult.success) {
    const error = new DockerCommandError("status", psResult.stderr, psResult.code, [], false);
    const formatted = formatError(error);
    outputFormattedError(formatted);
    const format = globalOptions.output ?? "text";
    if (isMachineFormat(format)) {
      await formatOutput(format, { error: psResult.stderr });
    }
    process.exitCode = 1;
    return;
  }

  // Parse container data
  const containers: ServiceStatus[] = [];
  const lines = psResult.stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);

  for (const line of lines) {
    try {
      const data = JSON.parse(line) as DockerPsJson;
      const { name, tag } = parseImage(data.Image);

      // Filter by service name if specified
      if (options.service !== undefined && data.Names !== options.service) {
        continue;
      }
      if (options.services !== undefined && !options.services.includes(data.Names)) {
        continue;
      }
      // Tag narrowing keys off the SERVICE KEY only. `status` reads no compose file for
      // its container list and shells a bare `docker ps`; resolving a service-to-container
      // map through an extra Compose subprocess on the hottest command in the CLI would
      // buy a container_name-vs-service-key divergence that does not exist here (all 45
      // services declare them identical). The divergent case is a documented limitation.
      if (selectedServices !== undefined && !selectedServices.has(data.Names)) {
        continue;
      }

      containers.push({
        name: data.Names,
        containerId: data.ID.substring(0, 12),
        state: parseContainerState(data.State),
        health: parseHealthStatus(data.Status),
        status: data.Status,
        ports: parsePorts(data.Ports),
        image: name,
        tag,
      });
    } catch {
      logDebug(`Failed to parse container line: ${line}`);
    }
  }

  // Sort containers by name
  containers.sort((a, b) => a.name.localeCompare(b.name));

  // Get stats if requested
  let stats: ResourceStats[] | undefined;
  if (options.stats) {
    logDebug("Fetching container stats...");
    const statsResult = await getContainerStats();

    if (statsResult.success) {
      stats = [];
      const statsLines = statsResult.stdout
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);

      for (const line of statsLines) {
        try {
          const data = JSON.parse(line) as DockerStatsJson;
          const mem = parseMemoryUsage(data.MemUsage);

          stats.push({
            name: data.Name,
            cpuPercent: parseCpuPercent(data.CPUPerc),
            memoryUsage: mem.usage,
            memoryLimit: mem.limit,
            memoryPercent: parseMemoryPercent(data.MemPerc),
            netIO: data.NetIO,
            blockIO: data.BlockIO,
          });
        } catch {
          logDebug(`Failed to parse stats line: ${line}`);
        }
      }
    }
  }

  // Build result
  const running = containers.filter((c) => c.state === "running").length;
  const healthy = containers.filter((c) => c.health === "healthy").length;

  const result: StatusResult = {
    timestamp: new Date().toISOString(),
    services: containers,
    stats,
    total: containers.length,
    running,
    healthy,
  };

  // Output in requested format (json, yaml, csv, table)
  const format = globalOptions.output ?? "text";
  if (format !== "text") {
    await formatOutput(format, result);
    return;
  }

  // Display results
  if (containers.length === 0) {
    logInfo("No containers found");
    return;
  }

  console.error("");
  console.error(colors.bold("Docker Service Status"));
  console.error(
    `  Total: ${result.total} | Running: ${colors.green(running.toString())} | Healthy: ${colors.green(healthy.toString())}`,
  );
  console.error("");

  for (const service of containers) {
    console.error(formatServiceStatus(service));
  }

  // Show stats if requested
  if (stats !== undefined && stats.length > 0) {
    console.error("");
    console.error(colors.bold("Resource Usage"));
    for (const s of stats) {
      const cpuColor =
        s.cpuPercent > 80 ? colors.red : s.cpuPercent > 50 ? colors.yellow : colors.green;
      const memColor =
        s.memoryPercent > 80 ? colors.red : s.memoryPercent > 50 ? colors.yellow : colors.green;
      console.error(
        `  ${colors.bold(s.name)}: CPU ${cpuColor(s.cpuPercent.toFixed(1) + "%")} | Mem ${memColor(s.memoryPercent.toFixed(1) + "%")}`,
      );
    }
  }

  // Show logs if requested
  if (options.logs && containers.length > 0) {
    console.error("");
    console.error(colors.bold("Recent Logs"));

    const serviceNames =
      options.service !== undefined
        ? [options.service]
        : (options.services ?? containers.map((c) => c.name));

    const logsResult = await execDockerCompose(
      ["-f", finalConfig.composePath, "logs", "--tail", "10", ...serviceNames],
      { streamOutput: false },
    );

    if (logsResult.success) {
      console.error(logsResult.stdout);
    } else {
      const logsError = new DockerCommandError(
        "logs",
        logsResult.stderr,
        logsResult.code,
        serviceNames,
        false,
      );
      const formattedLogs = formatError(logsError);
      outputFormattedError(formattedLogs);
    }
  }

  console.error("");
  logSuccess(`Status check complete`);
}
