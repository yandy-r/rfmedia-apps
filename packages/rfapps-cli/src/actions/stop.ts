/**
 * Stop command action for rfapps CLI
 *
 * Stops Docker services without removing them:
 * - Automatic sidecar linking
 * - Service group expansion
 * - Profile support
 */

import {
  logInfo,
  logSuccess,
  logDebug,
  isMachineFormat,
  formatDryRun,
  confirm,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";

import type { OutputFormat } from "@rfmedia/common";

import { formatOutput } from "../lib/formatters/index.js";

import type { StopOptions, StopResult, EnvToolExecConfig } from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  stopServices,
  isValidProfile,
  resolveServicesWithInteractive,
} from "../lib/index.js";

import { DockerCommandError } from "../lib/errors.js";

/**
 * Parse raw stop options from CLI
 */
interface RawStopOptions {
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
 * Execute the stop command.
 *
 * Gracefully stops Docker services without removing containers.
 * Containers can be restarted later using 'deploy' without pulling new images.
 *
 * Automatically handles sidecar linking - stopping a main service will also
 * stop its Tailscale sidecar (unless --no-sidecars is specified).
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode, secrets injection, etc.)
 *
 * @example
 * ```typescript
 * // Stop a specific service
 * await executeStop({ service: 'plex' }, { yes: true });
 *
 * // Stop all services
 * await executeStop({}, { yes: true });
 * ```
 */
export async function executeStop(
  rawOptions: RawStopOptions,
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
  const options: StopOptions = {
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
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  };

  logDebug(`Stop options: ${JSON.stringify(options)}`);

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
  logDebug(`Stopping services: ${services.length > 0 ? services.join(", ") : "all"}`);

  // Resolve output format
  const format = globalOptions.output ?? "text";

  // Dry run mode
  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    logInfo(formatDryRun(`stop services: ${serviceList}`));

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

  // Confirmation if not --yes
  if (!options.yes && !isMachineFormat(format)) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const confirmed = await confirm(`Stop ${serviceList}?`);
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  // Execute stop
  const result: StopResult = {
    services: [],
    failed: [],
    stopped: 0,
  };

  try {
    logInfo(`Stopping Docker services...`);

    const stopResult = await stopServices(
      finalConfig.composePath,
      services.length > 0 ? services : undefined,
      { streamOutput: true, profiles, envTool },
    );

    if (!stopResult.success) {
      // When streamOutput is true, stderr is empty (output went directly to console)
      // User already saw the error, just log a summary
      const errorMsg = stopResult.stderr.trim()
        ? (stopResult.stderr.split("\n").pop() ?? "See output above")
        : "See output above for details";

      const error = new DockerCommandError("stop", errorMsg, stopResult.code, services, false);
      const formatted = formatError(error);
      outputFormattedError(formatted);
      result.failed.push({
        name: "stop",
        error: errorMsg,
      });
      process.exitCode = 1;

      // Output result in requested format even on failure
      if (format !== "text") {
        await formatOutput(format, result);
      }
      return;
    }

    // Mark success
    result.services = services.length > 0 ? services : ["all"];
    result.stopped = services.length > 0 ? services.length : 1;

    logSuccess(
      `Successfully stopped ${result.stopped === 1 && services.length === 0 ? "all" : result.stopped} service(s)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = new DockerCommandError("stop", message, 1, services, false);
    const formatted = formatError(error);
    outputFormattedError(formatted);
    result.failed.push({
      name: "stop",
      error: message,
    });
    process.exitCode = 1;
  }

  // Output result in requested format
  if (format !== "text") {
    await formatOutput(format, result);
  }
}
