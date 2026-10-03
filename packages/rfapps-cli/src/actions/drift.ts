/**
 * Drift command actions for rfapps CLI
 *
 * Detects and manages configuration drift between compose.yml and running containers.
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  logInfo,
  logSuccess,
  logWarn,
  logDebug,
  formatDryRun,
  colors,
  confirm,
  isMachineFormat,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";
import { parseDocument, isMap, isSeq } from "yaml";

import { DRIFT_SCHEMA_VERSION } from "../types/drift.js";
import type { DriftResult, ServiceDrift } from "../types/drift.js";
import type { EnvChange, PortMapping, VolumeMapping } from "../types/plan.js";
import type { Profile, RfappsConfig } from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  autoDetectProfiles,
  isValidProfile,
  resolveServicesWithInteractive,
  formatOutput,
  DockerCommandError,
  InvalidArgumentError,
} from "../lib/index.js";
import {
  formatDirection,
  formatDiffValue,
  formatArrayDiff,
} from "../lib/formatters/diff-helpers.js";
import { detectDrift, getDriftForService, hasImportableDrift } from "../lib/drift.js";
import { executeReconcile, type ReconcileGlobalOptions } from "./reconcile.js";

/**
 * Parse raw drift detect options from CLI
 */
interface RawDriftDetectOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  showUnchanged?: boolean;
  reportOnly?: boolean;
  compose?: string;
  envFile?: string;
  profile?: string;
}

/**
 * Parse raw drift show options from CLI
 */
interface RawDriftShowOptions {
  service?: string;
  compose?: string;
  envFile?: string;
  profile?: string;
  reportOnly?: boolean;
}

/**
 * Parse raw drift reconcile options from CLI
 */
interface RawDriftReconcileOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  compose?: string;
  envFile?: string;
  profile?: string;
}

/**
 * Parse raw drift import options from CLI
 */
interface RawDriftImportOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  backup?: boolean;
  compose?: string;
  envFile?: string;
  profile?: string;
}

/**
 * Display detailed drift for a service
 */
function displayServiceDrift(drift: ServiceDrift, verbose: boolean): void {
  const prefix = "  ";

  if (drift.image.changed || verbose) {
    console.error(
      `${prefix}${colors.bold("image")}: ${formatDiffValue(drift.image.current, drift.image.desired)}`,
    );
  }

  const envToShow = verbose
    ? drift.environment
    : drift.environment.filter((e) => e.changeType !== "unchanged");

  if (envToShow.length > 0) {
    console.error(`${prefix}${colors.bold("environment")}:`);
    for (const env of envToShow) {
      const value = env.isSecret
        ? formatDiffValue(
            env.current !== undefined ? "********" : undefined,
            env.desired !== undefined ? "********" : undefined,
          )
        : formatDiffValue(env.current, env.desired);
      console.error(`${prefix}  ${env.name}: ${value}`);
    }
  }

  if (
    drift.ports.changed ||
    (verbose && (drift.ports.current !== undefined || drift.ports.desired !== undefined))
  ) {
    const currentPorts = drift.ports.current?.map(
      (p) => `${p.host ?? "*"}:${p.container}/${p.protocol}`,
    );
    const desiredPorts = drift.ports.desired?.map(
      (p) => `${p.host ?? "*"}:${p.container}/${p.protocol}`,
    );
    const portLines = formatArrayDiff(currentPorts, desiredPorts);
    console.error(`${prefix}${colors.bold("ports")}:`);
    for (const line of portLines) {
      console.error(`${prefix}  ${line}`);
    }
  }

  if (
    drift.volumes.changed ||
    (verbose && (drift.volumes.current !== undefined || drift.volumes.desired !== undefined))
  ) {
    const currentVolumes = drift.volumes.current?.map(
      (v) => `${v.source}:${v.target}${v.readonly ? ":ro" : ""}`,
    );
    const desiredVolumes = drift.volumes.desired?.map(
      (v) => `${v.source}:${v.target}${v.readonly ? ":ro" : ""}`,
    );
    const volumeLines = formatArrayDiff(currentVolumes, desiredVolumes);
    console.error(`${prefix}${colors.bold("volumes")}:`);
    for (const line of volumeLines) {
      console.error(`${prefix}  ${line}`);
    }
  }

  if (
    drift.networks.changed ||
    (verbose && (drift.networks.current !== undefined || drift.networks.desired !== undefined))
  ) {
    const networkLines = formatArrayDiff(drift.networks.current, drift.networks.desired);
    console.error(`${prefix}${colors.bold("networks")}:`);
    for (const line of networkLines) {
      console.error(`${prefix}  ${line}`);
    }
  }

  if (drift.runtimeStatus.changed || verbose) {
    console.error(`${prefix}${colors.bold("runtime-status")}:`);
    console.error(
      `${prefix}  state: ${formatDiffValue(
        drift.runtimeStatus.current.state,
        drift.runtimeStatus.desired.state,
      )}`,
    );
    console.error(
      `${prefix}  health: ${formatDiffValue(
        drift.runtimeStatus.current.health,
        drift.runtimeStatus.desired.health,
      )}`,
    );
  }
}

/**
 * Display drift results
 */
function displayDriftResult(
  result: DriftResult,
  options: { showUnchanged: boolean; verbose: boolean },
): void {
  console.error("");
  console.error(colors.bold("Drift Detection Results"));
  console.error(colors.dim(`Compose: ${result.composePath}`));
  console.error("");

  const driftedServices = result.services.filter((s) => s.hasDrift);
  const unchangedCount = result.services.length - driftedServices.length;

  console.error(
    `  Total: ${result.services.length} | Drifted: ${colors.yellow(driftedServices.length.toString())} | Unchanged: ${colors.green(unchangedCount.toString())}`,
  );
  console.error("");

  const toShow = options.showUnchanged ? result.services : driftedServices;

  for (const service of toShow) {
    const categories = service.categories.length > 0 ? service.categories.join(", ") : "none";
    const direction = formatDirection(service.direction);
    const marker = service.hasDrift ? colors.yellow("~") : colors.dim("=");
    console.error(
      `${marker} ${colors.bold(service.service)} (${categories}) ${colors.dim(`[${direction}]`)}`,
    );
    if (service.hasDrift || options.verbose) {
      displayServiceDrift(service, options.verbose);
    }
    console.error("");
  }
}

/**
 * Build environment map from drift changes
 */
function buildEnvFromChanges(changes: EnvChange[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const change of changes) {
    if (change.current !== undefined) {
      env[change.name] = change.current;
    }
  }
  return env;
}

/**
 * Convert port mappings to compose string format
 */
function portsToCompose(ports: PortMapping[]): string[] {
  return ports
    .map((port) => {
      const protocol = port.protocol !== "tcp" ? `/${port.protocol}` : "";
      if (port.host !== undefined && port.host.length > 0) {
        return `${port.host}:${port.container}${protocol}`;
      }
      return `${port.container}${protocol}`;
    })
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Convert volume mappings to compose string format
 */
function volumesToCompose(volumes: VolumeMapping[]): string[] {
  return volumes
    .map((volume) => `${volume.source}:${volume.target}${volume.readonly ? ":ro" : ""}`)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Update compose file based on drifted services
 */
async function applyImport(
  composePath: string,
  driftedServices: ServiceDrift[],
  options: { backup: boolean },
): Promise<void> {
  const content = await readFile(composePath, "utf8");
  const doc = parseDocument(content);

  const servicesNode = doc.get("services");
  if (!isMap(servicesNode)) {
    throw new Error("compose.yml is missing services section");
  }

  for (const drift of driftedServices) {
    const serviceNode = doc.getIn(["services", drift.service]);
    if (!isMap(serviceNode)) {
      logWarn(`Service not found in compose.yml: ${drift.service}`);
      continue;
    }

    const hasBuild = isMap(serviceNode) && serviceNode.has("build");
    if (drift.image.changed && drift.image.current !== undefined && !hasBuild) {
      doc.setIn(["services", drift.service, "image"], drift.image.current);
    }

    if (drift.categories.includes("environment")) {
      const envMap = buildEnvFromChanges(drift.environment);
      const envNode = doc.getIn(["services", drift.service, "environment"]);
      if (Object.keys(envMap).length === 0) {
        doc.deleteIn(["services", drift.service, "environment"]);
      } else if (isSeq(envNode)) {
        const entries = Object.entries(envMap)
          .map(([key, value]) => `${key}=${value}`)
          .sort((a, b) => a.localeCompare(b));
        doc.setIn(["services", drift.service, "environment"], entries);
      } else {
        doc.setIn(["services", drift.service, "environment"], envMap);
      }
    }

    if (drift.ports.current !== undefined) {
      const ports = portsToCompose(drift.ports.current);
      if (ports.length === 0) {
        doc.deleteIn(["services", drift.service, "ports"]);
      } else {
        doc.setIn(["services", drift.service, "ports"], ports);
      }
    }

    if (drift.volumes.current !== undefined) {
      const volumes = volumesToCompose(drift.volumes.current);
      if (volumes.length === 0) {
        doc.deleteIn(["services", drift.service, "volumes"]);
      } else {
        doc.setIn(["services", drift.service, "volumes"], volumes);
      }
    }

    if (drift.networks.current !== undefined) {
      if (drift.networks.current.length === 0) {
        doc.deleteIn(["services", drift.service, "networks"]);
      } else {
        doc.setIn(["services", drift.service, "networks"], drift.networks.current);
      }
    }
  }

  if (options.backup) {
    const dir = dirname(composePath);
    const base = basename(composePath);
    const backupPath = join(dir, `${base}.bak`);
    await copyFile(composePath, backupPath);
    logInfo(`Backup saved to ${backupPath}`);
  }

  await writeFile(composePath, doc.toString(), "utf8");
}

/**
 * Execute drift detect command.
 *
 * Compares running containers against compose.yml to detect configuration drift.
 * Drift occurs when a container's runtime configuration differs from what's
 * defined in the compose file.
 *
 * Drift categories detected:
 * - image: Container running different image than compose specifies
 * - environment: Environment variables differ
 * - ports: Port mappings differ
 * - volumes: Volume mounts differ
 * - networks: Network connections differ
 *
 * Drift direction indicates which side has newer changes:
 * - compose_ahead: Compose has changes not in running container
 * - container_ahead: Container has changes not in compose
 * - diverged: Both have different changes
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options
 */
export async function executeDriftDetect(
  rawOptions: RawDriftDetectOptions,
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
  const envTool = getEnvToolExecConfig(globalOptions);
  const format = globalOptions.output ?? "text";

  const options = {
    dryRun: globalOptions.dryRun ?? false,
    debug: globalOptions.debug ?? false,
    verbose: globalOptions.verbose ?? false,
    yes: globalOptions.yes ?? false,
    service: rawOptions.service,
    services: rawOptions.services?.split(",").map((s) => s.trim()),
    group: rawOptions.group,
    tag: rawOptions.tag,
    noSidecars: rawOptions.sidecars === false,
    showUnchanged: rawOptions.showUnchanged ?? false,
    reportOnly: rawOptions.reportOnly ?? false,
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  };

  logDebug(`Drift detect options: ${JSON.stringify(options)}`);

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

  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    logInfo(formatDryRun(`detect drift for: ${serviceList}`));
    if (format !== "text") {
      await formatOutput(format, {
        dryRun: true,
        services: services.length > 0 ? services : ["all"],
        profiles,
        composePath: finalConfig.composePath,
      });
    }
    return;
  }

  const result = await detectDrift(
    {
      composePath: finalConfig.composePath,
      services: services.length > 0 ? services : undefined,
      profiles,
    },
    envTool,
  );

  if (result === undefined) {
    const error = new DockerCommandError(
      "inspect",
      "Failed to detect drift",
      1,
      services.length > 0 ? services : ["all"],
      false,
    );
    const formatted = formatError(error);
    outputFormattedError(formatted);
    process.exitCode = 1;
    return;
  }

  if (format !== "text") {
    await formatOutput(format, result);
    if (result.summary.drifted > 0 && !options.reportOnly) {
      process.exitCode = 1;
    }
    return;
  }

  if (result.summary.drifted === 0 && !options.showUnchanged) {
    logSuccess("No drift detected");
    return;
  }

  displayDriftResult(result, { showUnchanged: options.showUnchanged, verbose: options.verbose });
  logSuccess("Drift detection complete");
  if (result.summary.drifted > 0 && !options.reportOnly) {
    process.exitCode = 1;
  }
}

/**
 * Execute drift show command.
 *
 * Shows detailed drift information for a single service, including
 * all configuration differences between compose.yml and the running container.
 *
 * @param rawOptions - Command-specific options from CLI (service is required)
 * @param globalOptions - Global CLI options
 */
export async function executeDriftShow(
  rawOptions: RawDriftShowOptions,
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
  const envTool = getEnvToolExecConfig(globalOptions);
  const format = globalOptions.output ?? "text";

  const service = rawOptions.service;
  if (service === undefined) {
    throw new InvalidArgumentError("--service", "", "Service is required for drift show");
  }

  const options = {
    dryRun: globalOptions.dryRun ?? false,
    debug: globalOptions.debug ?? false,
    verbose: globalOptions.verbose ?? false,
    yes: globalOptions.yes ?? false,
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
    reportOnly: rawOptions.reportOnly ?? false,
  };

  logDebug(`Drift show options: ${JSON.stringify(options)}`);

  const config = await loadConfig();
  const finalConfig = applyCliOverrides(config, {
    composePath: options.composePath,
    envFile: options.envFile,
    profile:
      options.profile !== undefined && isValidProfile(options.profile, config)
        ? options.profile
        : undefined,
  });

  const profiles =
    options.profile !== undefined && isValidProfile(options.profile, config)
      ? [options.profile]
      : autoDetectProfiles([service], finalConfig);

  if (options.dryRun) {
    logInfo(formatDryRun(`show drift for: ${service}`));
    if (format !== "text") {
      await formatOutput(format, {
        dryRun: true,
        service,
        profiles,
        composePath: finalConfig.composePath,
      });
    }
    return;
  }

  const drift = await getDriftForService(
    service,
    {
      composePath: finalConfig.composePath,
      services: [service],
      profiles,
    },
    envTool,
  );

  if (drift === undefined) {
    const error = new DockerCommandError("inspect", "Failed to detect drift", 1, [service], false);
    const formatted = formatError(error);
    outputFormattedError(formatted);
    process.exitCode = 1;
    return;
  }

  if (format !== "text") {
    await formatOutput(format, { service, drift });
    if (drift.hasDrift && !options.reportOnly) {
      process.exitCode = 1;
    }
    return;
  }

  const result: DriftResult = {
    schemaVersion: DRIFT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    composePath: finalConfig.composePath,
    services: [drift],
    summary: {
      total: 1,
      drifted: drift.hasDrift ? 1 : 0,
      unchanged: drift.hasDrift ? 0 : 1,
      directions: {
        composeAhead: drift.hasDrift && drift.direction === "compose_ahead" ? 1 : 0,
        containerAhead: drift.hasDrift && drift.direction === "container_ahead" ? 1 : 0,
        diverged: drift.hasDrift && drift.direction === "diverged" ? 1 : 0,
      },
    },
  };

  displayDriftResult(result, { showUnchanged: true, verbose: options.verbose });
  if (drift.hasDrift && !options.reportOnly) {
    process.exitCode = 1;
  }
}

/**
 * Execute drift reconcile command.
 *
 * Preserves the legacy command spelling while delegating to the single safe
 * reconciliation action. The legacy spelling is explicitly auto-apply; the
 * shared action retains confirmation, machine authorization, dry-run veto,
 * targeted mutation, result rendering, and exit semantics.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options
 */
export async function executeDriftReconcile(
  rawOptions: RawDriftReconcileOptions,
  globalOptions: ReconcileGlobalOptions,
): Promise<void> {
  await executeReconcile({ ...rawOptions, autoApply: true }, globalOptions);
}

/**
 * Execute drift import command.
 *
 * Updates compose.yml to match running containers (reverse of reconcile).
 * Useful when container configuration has been manually changed and you want
 * to capture those changes in compose.yml.
 *
 * Imports: images, environment variables, ports, volumes, networks.
 * Optionally creates a backup of compose.yml before modification.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options
 */
export async function executeDriftImport(
  rawOptions: RawDriftImportOptions,
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
  const envTool = getEnvToolExecConfig(globalOptions);
  const format = globalOptions.output ?? "text";

  const options = {
    dryRun: globalOptions.dryRun ?? false,
    debug: globalOptions.debug ?? false,
    verbose: globalOptions.verbose ?? false,
    yes: globalOptions.yes ?? false,
    service: rawOptions.service,
    services: rawOptions.services?.split(",").map((s) => s.trim()),
    group: rawOptions.group,
    tag: rawOptions.tag,
    noSidecars: rawOptions.sidecars === false,
    backup: rawOptions.backup ?? false,
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  };

  logDebug(`Drift import options: ${JSON.stringify(options)}`);

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

  // Resolve services with interactive selection support
  // Note: Import typically uses -s/-g flags, but uses the centralized helper for consistency
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

  const driftResult = await detectDrift(
    {
      composePath: finalConfig.composePath,
      services: services.length > 0 ? services : undefined,
      profiles,
    },
    envTool,
  );

  if (driftResult === undefined) {
    const error = new DockerCommandError(
      "inspect",
      "Failed to detect drift",
      1,
      services.length > 0 ? services : ["all"],
      false,
    );
    const formatted = formatError(error);
    outputFormattedError(formatted);
    process.exitCode = 1;
    return;
  }

  const driftedServices = driftResult.services.filter((s) => s.hasDrift && hasImportableDrift(s));
  if (driftedServices.length === 0) {
    logSuccess("No drift to import");
    return;
  }

  if (options.dryRun) {
    logInfo(formatDryRun(`import drift for: ${driftedServices.map((s) => s.service).join(", ")}`));
    if (format !== "text") {
      await formatOutput(format, {
        dryRun: true,
        services: driftedServices.map((s) => s.service),
        profiles,
        composePath: finalConfig.composePath,
      });
    }
    return;
  }

  if (!options.yes && !isMachineFormat(format)) {
    const confirmed = await confirm(
      `Import drift into compose.yml for ${driftedServices.map((s) => s.service).join(", ")}?`,
    );
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  try {
    await applyImport(finalConfig.composePath, driftedServices, { backup: options.backup });
    logSuccess("Drift import complete");
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    const importError = new DockerCommandError(
      "import",
      stderr,
      1,
      driftedServices.map((s) => s.service),
      false,
    );
    const formatted = formatError(importError);
    outputFormattedError(formatted);
    process.exitCode = 1;
  }
}
