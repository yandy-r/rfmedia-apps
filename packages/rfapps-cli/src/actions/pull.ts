/**
 * Pull command action for rfapps CLI
 *
 * Pulls Docker images for services with:
 * - Automatic sidecar linking
 * - Service group expansion
 * - Profile support
 */

import {
  logInfo,
  logSuccess,
  logDebug,
  formatDryRun,
  confirm,
  withSpinner,
  isMachineFormat,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";

import type { OutputFormat } from "@rfmedia/common";

import { formatOutput } from "../lib/formatters/index.js";

import type { PullOptions, PullResult } from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  pullImages,
  isValidProfile,
  resolveServicesWithInteractive,
} from "../lib/index.js";

import { ImagePullError } from "../lib/errors.js";

/**
 * Parse raw pull options from CLI
 */
interface RawPullOptions {
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
 * Execute the pull command.
 *
 * Pulls the latest Docker images for services without starting them.
 * This allows pre-downloading images before a maintenance window.
 *
 * Note: Pull does not affect running containers. Use 'deploy' or 'rebuild'
 * after pulling to update running services.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode, secrets injection, etc.)
 *
 * @example
 * ```typescript
 * // Pull images for a specific service
 * await executePull({ service: 'sonarr' }, { yes: true });
 *
 * // Pull all images in the arr-stack group
 * await executePull({ group: 'arr-stack' }, { yes: true });
 * ```
 */
export async function executePull(
  rawOptions: RawPullOptions,
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
  const options: PullOptions = {
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

  const format = globalOptions.output ?? "text";

  logDebug(`Pull options: ${JSON.stringify(options)}`);

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
  logDebug(`Pulling services: ${services.length > 0 ? services.join(", ") : "all"}`);

  // Dry run mode
  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    logInfo(formatDryRun(`pull images for ${serviceList}`));

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
    const confirmed = await confirm(`Pull images for ${serviceList}?`);
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  // Execute pull
  const result: PullResult = {
    services: [],
    skipped: [],
    failed: [],
    pulled: 0,
  };

  try {
    logInfo(`Pulling Docker images...`);

    const pullResult = await withSpinner(
      `Pulling ${services.length > 0 ? `${services.length} services` : "all services"}`,
      async () =>
        pullImages(finalConfig.composePath, services.length > 0 ? services : undefined, {
          streamOutput: options.verbose,
          envTool,
        }),
    );

    if (pullResult.success) {
      result.services = services.length > 0 ? services : ["all"];
      result.pulled = services.length > 0 ? services.length : 1;
      logSuccess(`Successfully pulled images`);
    } else {
      const error = new ImagePullError(services.length > 0 ? services : ["all"], pullResult.stderr);
      const formatted = formatError(error);
      outputFormattedError(formatted);
      result.failed.push({
        name: "pull",
        error: pullResult.stderr,
      });
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = new ImagePullError(services.length > 0 ? services : ["all"], message);
    const formatted = formatError(error);
    outputFormattedError(formatted);
    result.failed.push({
      name: "pull",
      error: message,
    });
    process.exitCode = 1;
  }

  // Output result in requested format
  if (format !== "text") {
    await formatOutput(format, result);
  }
}
