/**
 * Shared action helpers for rfapps CLI
 *
 * Contains utility functions extracted from deploy and rebuild actions
 * to reduce duplication and simplify parallel execution integration.
 */

import { logDebug } from "@rfmedia/common";

import type { ContainerInspect, DockerExecOptions } from "./docker.js";
import { inspectContainers } from "./docker.js";

/**
 * Sleep for the specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inspect containers with retry logic and exponential backoff.
 *
 * Containers may not be immediately available for inspection after startup.
 * This function retries inspection with increasing delays to handle slow
 * container initialization.
 *
 * @param services - Service names to inspect
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param delayMs - Base delay between retries in milliseconds (default: 1000)
 * @param options - Docker execution options
 * @returns Map of container name to image tag
 */
export async function inspectContainersWithRetry(
  services: string[],
  maxRetries = 3,
  delayMs = 1000,
  options: DockerExecOptions = {},
): Promise<Map<string, string>> {
  const serviceImageMap = new Map<string, string>();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const containerInfos: ContainerInspect[] | undefined = await inspectContainers(
      services,
      options,
    );

    if (containerInfos && containerInfos.length > 0) {
      for (const info of containerInfos) {
        const containerName = info.Name.replace(/^\//, "");
        serviceImageMap.set(containerName, info.Config.Image);
      }

      // Check if we got all services
      if (serviceImageMap.size === services.length) {
        return serviceImageMap;
      }
    }

    if (attempt < maxRetries) {
      logDebug(`Container inspection attempt ${attempt} incomplete, retrying...`);
      await sleep(delayMs * attempt); // Exponential backoff
    }
  }

  // Log warning about missing image tags
  if (serviceImageMap.size < services.length) {
    const missing = services.filter((s) => !serviceImageMap.has(s));
    logDebug(`Could not inspect containers for: ${missing.join(", ")}`);
  }

  return serviceImageMap;
}
