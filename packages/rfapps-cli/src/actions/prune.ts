/**
 * Prune command action for rfapps CLI
 *
 * Stops containers, removes them, and intelligently removes service images:
 * - Automatic sidecar linking
 * - Service group expansion
 * - Profile support
 * - Smart image removal (skips shared images)
 * - Optional volume/dangling image cleanup
 */

import {
  logInfo,
  logSuccess,
  logDebug,
  logWarn,
  isMachineFormat,
  formatDryRun,
  confirm,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";

import type { OutputFormat } from "@rfmedia/common";

import { formatOutput } from "../lib/formatters/index.js";
import { DockerCommandError } from "../lib/errors.js";

import type { PruneOptions, PruneResult, EnvToolExecConfig } from "../types/index.js";
import { getEnvToolExecConfig } from "../types/index.js";

import {
  loadConfig,
  applyCliOverrides,
  stopServices,
  removeServices,
  pruneImages,
  pruneVolumes,
  getComposeConfig,
  removeImage,
  isImageInUse,
  imageExists,
  isValidProfile,
  resolveServicesWithInteractive,
  initializeDatabase,
  recordDeployments,
  closeDatabase,
} from "../lib/index.js";

/**
 * Parse raw prune options from CLI
 */
interface RawPruneOptions {
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
 * Execute the prune command.
 *
 * Performs intelligent cleanup of Docker resources with five phases:
 * 1. Stop: Gracefully stop targeted services
 * 2. Remove: Remove stopped containers
 * 3. Images: Remove service images (smart removal - skips shared images)
 * 4. Volumes: Prune volumes (optional, --volumes flag)
 * 5. Dangling: Prune dangling images (optional, --images flag)
 *
 * Smart image removal ensures images used by other services are preserved.
 * For example, if multiple services use the same base image, it won't be
 * removed when pruning just one of those services.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode, secrets injection, etc.)
 *
 * @example
 * ```typescript
 * // Prune a service and its images
 * await executePrune({ service: 'plex' }, { yes: true });
 *
 * // Full cleanup including volumes and dangling images
 * await executePrune({ volumes: true, images: true }, { yes: true });
 * ```
 */
export async function executePrune(
  rawOptions: RawPruneOptions,
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
  const options: PruneOptions = {
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

  logDebug(`Prune options: ${JSON.stringify(options)}`);

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
  logDebug(`Pruning services: ${services.length > 0 ? services.join(", ") : "all"}`);

  // Resolve output format
  const format = globalOptions.output ?? "text";

  // Dry run mode
  if (options.dryRun) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const extras = [];
    if (options.volumes) extras.push("volumes");
    if (options.images) extras.push("dangling images");
    const extraStr = extras.length > 0 ? ` (also prune ${extras.join(" and ")})` : "";

    logInfo(formatDryRun(`prune services and their images: ${serviceList}${extraStr}`));

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
    if (options.images) extras.push("dangling images");
    const extraStr = extras.length > 0 ? ` and prune ${extras.join(" and ")}` : "";

    const confirmed = await confirm(
      `Prune ${serviceList} (stop, remove containers, and remove images)${extraStr}?`,
    );
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  // Initialize result
  const result: PruneResult = {
    services: [],
    failed: [],
    containers: 0,
    images: 0,
    imagesSkipped: 0,
    spaceReclaimed: 0,
    completedPhases: [],
  };

  try {
    // Get compose config to identify images for each service
    const composeConfig = await getComposeConfig(finalConfig.composePath, { profiles, envTool });

    if (!composeConfig) {
      const error = new DockerCommandError(
        "config",
        "Failed to read compose configuration",
        1,
        services,
        false,
      );
      const formatted = formatError(error);
      outputFormattedError(formatted);
      result.failed.push({ name: "config", error: error.message });
      process.exitCode = 1;
      if (format !== "text") await formatOutput(format, result);
      return;
    }

    // Build map of service -> image
    const serviceImageMap = new Map<string, string>();
    const allServiceImages = new Set<string>();

    for (const [serviceName, serviceConfig] of Object.entries(composeConfig.services)) {
      if (serviceConfig.image) {
        serviceImageMap.set(serviceName, serviceConfig.image);
        allServiceImages.add(serviceConfig.image);
      }
    }

    // Determine which services we're pruning
    const servicesToPrune =
      services.length > 0
        ? services.filter((s) => serviceImageMap.has(s))
        : Array.from(serviceImageMap.keys());

    // Identify images that will be pruned vs skipped (shared)
    const imagesToRemove = new Set<string>();
    const imagesShared = new Set<string>();

    for (const service of servicesToPrune) {
      const image = serviceImageMap.get(service);
      if (!image) continue;

      // Check if this image is used by services NOT being pruned
      let isShared = false;
      for (const [otherService, otherImage] of serviceImageMap) {
        if (otherImage === image && !servicesToPrune.includes(otherService)) {
          isShared = true;
          break;
        }
      }

      if (isShared) {
        imagesShared.add(image);
      } else {
        imagesToRemove.add(image);
      }
    }

    logDebug(`Images to remove: ${Array.from(imagesToRemove).join(", ")}`);
    logDebug(`Images shared (will skip): ${Array.from(imagesShared).join(", ")}`);

    // Phase 1: Stop services
    logInfo("Phase 1: Stopping services...");
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
    result.completedPhases.push("stop");

    // Phase 2: Remove containers
    logInfo("Phase 2: Removing containers...");
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
    result.completedPhases.push("remove");
    result.services = servicesToPrune;
    result.containers = servicesToPrune.length;

    // Brief delay to ensure Docker daemon has fully processed container removals
    // Prevents race conditions where image check runs before Docker updates internal state
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Phase 3: Remove service images (smart removal)
    logInfo("Phase 3: Removing service images...");
    for (const image of imagesToRemove) {
      // Double-check image isn't in use by running containers
      const inUse = await isImageInUse(image, { envTool });
      if (inUse) {
        logWarn(`Skipping ${image}: still in use by running containers`);
        result.imagesSkipped++;
        continue;
      }

      // Check if image exists
      const exists = await imageExists(image, { envTool });
      if (!exists) {
        logDebug(`Skipping ${image}: image not found locally`);
        continue;
      }

      logInfo(`  Removing image: ${image}`);
      const rmResult = await removeImage(image, { force: true, envTool });
      if (rmResult.success) {
        result.images++;
      } else {
        logWarn(`  Failed to remove ${image}: ${rmResult.stderr.trim()}`);
        result.imagesSkipped++;
      }
    }

    // Log skipped shared images
    for (const image of imagesShared) {
      logInfo(`  Skipping ${image}: shared by other services`);
      result.imagesSkipped++;
    }
    result.completedPhases.push("images");

    // Phase 4: Prune volumes (if requested)
    if (options.volumes) {
      logInfo("Phase 4: Pruning volumes...");
      const volumeResult = await pruneVolumes({ streamOutput: true, envTool });

      if (volumeResult.success) {
        result.volumes = 1; // We don't have exact count from prune output
        result.completedPhases.push("volumes");
      } else {
        logWarn("Volume pruning may have failed (non-critical)");
      }
    }

    // Phase 5: Prune dangling images (if requested)
    if (options.images) {
      logInfo("Phase 5: Pruning dangling images...");
      const pruneResult = await pruneImages({ streamOutput: true, envTool });

      if (pruneResult.success) {
        result.completedPhases.push("prune-images");
      } else {
        logWarn("Dangling image pruning may have failed (non-critical)");
      }
    }

    logSuccess(
      `Successfully pruned ${result.containers} service(s), removed ${result.images} image(s), skipped ${result.imagesSkipped} image(s)`,
    );

    // Record prune state for successful operations
    // Only record if we have specific services pruned
    if (servicesToPrune.length > 0) {
      try {
        const db = await initializeDatabase();
        const timestamp = new Date().toISOString();

        // Build config snapshot with prune details
        const pruneSnapshot = JSON.stringify({
          imagesRemoved: Array.from(imagesToRemove),
          imagesSkipped: Array.from(imagesShared),
          volumesPruned: options.volumes,
          danglingImagesPruned: options.images,
          completedPhases: result.completedPhases,
        });

        const pruneEntries = servicesToPrune.map((service) => ({
          timestamp,
          service,
          action: "prune" as const,
          imageTag: serviceImageMap.get(service),
          configSnapshot: pruneSnapshot,
          status: "success" as const,
          planId: undefined,
          errorMessage: undefined,
        }));

        recordDeployments(db, pruneEntries);
        closeDatabase(db);
      } catch (stateError) {
        logWarn(
          `Failed to record prune state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
        );
      }
    }
  } catch (error) {
    // Re-throw typed errors for handleCliError() to process
    if (error instanceof DockerCommandError) {
      throw error;
    }
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const formatted = formatError(errorObj);
    outputFormattedError(formatted);
    result.failed.push({ name: "prune", error: errorObj.message });
    process.exitCode = 1;

    // Record failed prune state
    const failedServices = services.length > 0 ? services : [];
    if (failedServices.length > 0) {
      try {
        const db = await initializeDatabase();
        const timestamp = new Date().toISOString();

        const failedEntries = failedServices.map((service) => ({
          timestamp,
          service,
          action: "prune" as const,
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
          `Failed to record prune state: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
        );
      }
    }
  }

  if (format !== "text") {
    await formatOutput(format, result);
  }
}
