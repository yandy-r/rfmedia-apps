/**
 * Delete command action for rfapps CLI
 *
 * Stops and removes Docker containers:
 * - Automatic sidecar linking
 * - Service group expansion
 * - Profile support
 * - Optional volume/image cleanup
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

import { formatOutput } from "../lib/formatters/index.js";
import { DockerCommandError } from "../lib/errors.js";

import type { DeleteOptions, DeleteResult, EnvToolExecConfig } from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  stopServices,
  removeServices,
  downServices,
  pruneImages,
  isValidProfile,
  resolveServicesWithInteractive,
  initializeDatabase,
  recordDeployments,
  closeDatabase,
} from "../lib/index.js";

/**
 * Parse raw delete options from CLI
 */
interface RawDeleteOptions {
  service?: string;
  services?: string;
  group?: string;
  tag?: string[];
  sidecars?: boolean;
  compose?: string;
  envFile?: string;
  profile?: string;
  volumes?: boolean;
  images?: boolean;
}

/**
 * Execute the delete command.
 *
 * Stops and removes Docker containers with optional cleanup:
 * - Containers are always removed
 * - Volumes can be removed with --volumes flag
 * - Images can be pruned with --images flag
 *
 * This is a destructive operation. Unlike 'stop', deleted containers
 * cannot be simply restarted - they must be recreated with 'deploy'.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode, secrets injection, etc.)
 *
 * @example
 * ```typescript
 * // Delete a service and its volumes
 * await executeDelete({ service: 'plex', volumes: true }, { yes: true });
 *
 * // Delete all services (containers only)
 * await executeDelete({}, { yes: true });
 * ```
 */
export async function executeDelete(
  rawOptions: RawDeleteOptions,
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
  // Build typed options
  const options: DeleteOptions = {
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
    volumes: rawOptions.volumes ?? false,
    images: rawOptions.images ?? false,
  };

  logDebug(`Delete options: ${JSON.stringify(options)}`);

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
  logDebug(`Deleting services: ${services.length > 0 ? services.join(", ") : "all"}`);

  // Resolve output format
  const format = globalOptions.output ?? "text";

  // Dry run mode
  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const extras = [];
    if (options.volumes) extras.push("volumes");
    if (options.images) extras.push("images");
    const extraStr = extras.length > 0 ? ` (including ${extras.join(" and ")})` : "";

    logInfo(formatDryRun(`delete services: ${serviceList}${extraStr}`));

    if (format !== "text") {
      await formatOutput(format, {
        dryRun: true,
        services: services.length > 0 ? services : ["all"],
        profiles,
        volumes: options.volumes,
        images: options.images,
        composePath: finalConfig.composePath,
      });
    }
    return;
  }

  // Confirmation prompt
  if (!options.yes && !isMachineFormat(format)) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const extras = [];
    if (options.volumes) extras.push("volumes");
    if (options.images) extras.push("unused images");
    const extraStr = extras.length > 0 ? ` and remove ${extras.join(" and ")}` : "";

    const confirmed = await confirm(`Delete ${serviceList}${extraStr}?`);
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  // Initialize result
  const result: DeleteResult = {
    services: [],
    failed: [],
    deleted: 0,
  };

  try {
    // Phase 1: Stop services
    logInfo("Stopping services...");
    const stopResult = await stopServices(
      finalConfig.composePath,
      services.length > 0 ? services : undefined,
      { streamOutput: true, profiles, envTool },
    );

    if (!stopResult.success) {
      const error = new DockerCommandError(
        "stop",
        stopResult.stderr,
        stopResult.code,
        services.length > 0 ? services : ["all"],
        false,
      );
      const formatted = formatError(error);
      outputFormattedError(formatted);
      result.failed.push({ name: "stop", error: error.message });
      process.exitCode = 1;
      if (format !== "text") await formatOutput(format, result);
      return;
    }

    // Phase 2: Remove containers
    logInfo("Removing containers...");
    const removeResult = await removeServices(
      finalConfig.composePath,
      services.length > 0 ? services : undefined,
      { streamOutput: true, profiles, force: true, envTool },
    );

    if (!removeResult.success) {
      const error = new DockerCommandError(
        "rm",
        removeResult.stderr,
        removeResult.code,
        services.length > 0 ? services : ["all"],
        false,
      );
      const formatted = formatError(error);
      outputFormattedError(formatted);
      result.failed.push({ name: "remove", error: error.message });
      process.exitCode = 1;
      if (format !== "text") await formatOutput(format, result);
      return;
    }

    // Mark containers as deleted
    result.services = services.length > 0 ? services : ["all"];
    result.deleted = services.length > 0 ? services.length : 1;

    // Phase 3: Remove volumes (if requested)
    if (options.volumes) {
      logInfo("Removing volumes...");
      const downResult = await downServices(finalConfig.composePath, {
        volumes: true,
        removeOrphans: true,
        streamOutput: true,
        envTool,
      });

      if (downResult.success) {
        result.volumesRemoved = 1; // We don't have exact count
      } else {
        logWarn("Volume removal may have failed (non-critical)");
      }
    }

    // Phase 4: Prune images (if requested)
    if (options.images) {
      logInfo("Pruning unused images...");
      const pruneResult = await pruneImages({ streamOutput: true, envTool });

      if (pruneResult.success) {
        result.imagesRemoved = 1; // We don't have exact count
      } else {
        logWarn("Image pruning may have failed (non-critical)");
      }
    }

    logSuccess(
      `Successfully deleted ${result.deleted === 1 && services.length === 0 ? "all" : result.deleted} service(s)`,
    );

    // Record deletion state for successful deletions
    // Only record if we have specific services (not "all") and deletion succeeded
    const deletedServices = services.length > 0 ? services : [];
    if (deletedServices.length > 0) {
      try {
        const db = await initializeDatabase();
        const timestamp = new Date().toISOString();
        // Include volumes/images flags in config snapshot for rollback reference
        const deleteConfigSnapshot = JSON.stringify({
          volumes: options.volumes,
          images: options.images,
        });

        const deleteEntries = deletedServices.map((service) => ({
          timestamp,
          service,
          action: "delete" as const,
          imageTag: undefined, // No image tag for deletions
          configSnapshot: deleteConfigSnapshot,
          status: "success" as const,
          planId: undefined,
          errorMessage: undefined,
        }));

        recordDeployments(db, deleteEntries);
        closeDatabase(db);
      } catch (stateError) {
        logWarn(
          `Failed to record deletion state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
        );
      }
    }
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const formatted = formatError(errorObj);
    outputFormattedError(formatted);
    result.failed.push({ name: "delete", error: errorObj.message });
    process.exitCode = 1;

    // Record failed deletion state
    const failedServices = services.length > 0 ? services : [];
    if (failedServices.length > 0) {
      try {
        const db = await initializeDatabase();
        const timestamp = new Date().toISOString();
        const deleteConfigSnapshot = JSON.stringify({
          volumes: options.volumes,
          images: options.images,
        });

        const failedEntries = failedServices.map((service) => ({
          timestamp,
          service,
          action: "delete" as const,
          imageTag: undefined,
          configSnapshot: deleteConfigSnapshot,
          status: "failed" as const,
          planId: undefined,
          errorMessage: errorObj.message,
        }));

        recordDeployments(db, failedEntries);
        closeDatabase(db);
      } catch (stateError) {
        logWarn(
          `Failed to record deletion state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
        );
      }
    }
  }

  if (format !== "text") {
    await formatOutput(format, result);
  }
}
