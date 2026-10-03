/**
 * Build command action for rfapps CLI
 *
 * Builds Docker containers for services with:
 * - Automatic image pull (unless --skip-pull)
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
  logWarn,
  isMachineFormat,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";

import type { OutputFormat } from "@rfmedia/common";

import { formatOutput } from "../lib/formatters/index.js";

import type { BuildOptions, BuildResult, EnvToolExecConfig } from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  pullImages,
  buildImages,
  isValidProfile,
  resolveServicesWithInteractive,
  ImagePullError,
  DockerCommandError,
  ConfigValidationError,
} from "../lib/index.js";
import {
  validateConfigAgainstCompose,
  formatValidationWarnings,
  hasErrors,
} from "../lib/validation.js";

/**
 * Parse raw build options from CLI
 */
interface RawBuildOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  skipPull?: boolean;
  compose?: string;
  envFile?: string;
  profile?: string;
}

/**
 * Execute the build command.
 *
 * Builds Docker containers with a two-phase approach:
 * 1. Pull images (unless --skip-pull)
 * 2. Build containers using docker compose build
 *
 * This command prepares containers without starting them. Use 'deploy' or
 * 'rebuild' to actually start services.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode, secrets injection, etc.)
 *
 * @example
 * ```typescript
 * // Build a specific service
 * await executeBuild({ service: 'plex' }, { yes: true });
 *
 * // Build all services in a group
 * await executeBuild({ group: 'media-stack' }, { yes: true });
 * ```
 */
export async function executeBuild(
  rawOptions: RawBuildOptions,
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
  const options: BuildOptions = {
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
    composePath: rawOptions.compose,
    envFile: rawOptions.envFile,
    profile: rawOptions.profile,
  };

  const format = globalOptions.output ?? "text";

  logDebug(`Build options: ${JSON.stringify(options)}`);

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

  // Validate configuration against compose.yml
  const validationWarnings = await validateConfigAgainstCompose(
    finalConfig,
    finalConfig.composePath,
  );
  if (validationWarnings.length > 0) {
    const formatted = formatValidationWarnings(validationWarnings);
    formatted.forEach((warning) => logWarn(warning));

    if (hasErrors(validationWarnings)) {
      const error = new ConfigValidationError(
        "compose",
        finalConfig.composePath,
        "Configuration validation failed. Please fix errors before building.",
      );
      const formattedErr = formatError(error);
      outputFormattedError(formattedErr);
      process.exitCode = 1;
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
    process.cwd(),
    { envTool },
  );

  if (resolved === null) {
    return; // User cancelled or no services selected
  }

  const { services, profiles } = resolved;

  logDebug(`Using profiles: ${profiles.join(", ")}`);
  logDebug(`Building services: ${services.length > 0 ? services.join(", ") : "all"}`);

  // Dry run mode
  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const pullNote = options.skipPull ? " (skip pull)" : " (pull + build)";
    logInfo(formatDryRun(`build containers for ${serviceList}${pullNote}`));

    if (format !== "text") {
      await formatOutput(format, {
        dryRun: true,
        services: services.length > 0 ? services : ["all"],
        profiles,
        composePath: finalConfig.composePath,
        skipPull: options.skipPull,
      });
    }
    return;
  }

  // Confirmation if not --yes
  if (!options.yes && !isMachineFormat(format)) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const pullNote = options.skipPull ? "" : " (will pull images first)";
    const confirmed = await confirm(`Build containers for ${serviceList}${pullNote}?`);
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  // Execute build
  const result: BuildResult = {
    services: [],
    failed: [],
    built: 0,
  };

  try {
    // Phase 1: Pull images (unless --skip-pull)
    if (!options.skipPull) {
      logInfo(`Pulling Docker images...`);

      const pullResult = await withSpinner(
        `Pulling ${services.length > 0 ? `${services.length} services` : "all services"}`,
        async () =>
          pullImages(finalConfig.composePath, services.length > 0 ? services : undefined, {
            streamOutput: options.verbose,
            profiles,
            envTool,
          }),
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

        // Output result if non-text format even on failure
        if (format !== "text") {
          await formatOutput(format, result);
        }
        return;
      }

      logSuccess(`Successfully pulled images`);
    } else {
      logInfo(`Skipping image pull (--skip-pull)`);
    }

    // Phase 2: Build containers
    logInfo(`Building Docker containers...`);

    const buildResult = await withSpinner(
      `Building ${services.length > 0 ? `${services.length} services` : "all services"}`,
      async () =>
        buildImages(finalConfig.composePath, services.length > 0 ? services : undefined, {
          streamOutput: options.verbose,
          profiles,
          envTool,
        }),
    );

    if (buildResult.success) {
      result.services = services.length > 0 ? services : ["all"];
      result.built = services.length > 0 ? services.length : 1;
      logSuccess(`Successfully built containers`);
    } else {
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
    }
  } catch (error) {
    const buildError = error instanceof Error ? error : new Error(String(error));
    const formattedErr = formatError(buildError);
    outputFormattedError(formattedErr);
    result.failed.push({
      name: "build",
      error: buildError.message,
    });
    process.exitCode = 1;
  }

  // Output result in requested format
  if (format !== "text") {
    await formatOutput(format, result);
  }
}
