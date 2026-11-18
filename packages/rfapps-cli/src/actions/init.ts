/**
 * Init action for rfapps CLI
 *
 * Business logic for generating configuration files from compose.yml.
 *
 * IMPORTANT: This command provides BOOTSTRAPPING DEFAULTS for initial setup.
 * The hardcoded patterns and groups defined here are intentional starting points,
 * designed to work with common Docker service naming conventions.
 *
 * After generation:
 * - Users should customize the generated config to match their specific setup
 * - The config file (not this code) becomes the single source of truth
 * - Runtime operations use only the config file, not these defaults
 *
 * To update service mappings after initial setup, edit the config file directly
 * or regenerate with `rfapps init --force`.
 */

import { writeFile, access, constants } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  logInfo,
  logSuccess,
  logWarn,
  logDebug,
  isMachineFormat,
  formatError,
  outputFormattedError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";
import { formatOutput } from "../lib/formatters/index.js";
import { ConfigValidationError, ConfigNotFoundError } from "../lib/errors.js";
import { parseComposeFile } from "../lib/validation.js";
import { getDefaultConfigPath, getProjectConfigPath } from "../lib/config.js";
import type { GlobalOptions, PartialRfappsConfig, Profile } from "../types/index.js";

/**
 * Options specific to init command
 */
export interface InitCommandOptions extends GlobalOptions {
  /** Write to global config location (~/.rfapps.yaml) */
  global: boolean;
  /** Use JSON format instead of YAML */
  json: boolean;
  /** Overwrite existing config file */
  force: boolean;
}

/**
 * Auto-detect sidecar mappings based on naming pattern
 * Services ending in -ts are assumed to be sidecars
 */
function autoDetectSidecars(services: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const sidecars = new Set(services.filter((s) => s.endsWith("-ts")));

  for (const service of services) {
    if (sidecars.has(service)) continue;

    // Try to find matching sidecar
    const potentialSidecar = `${service}-ts`;
    if (sidecars.has(potentialSidecar)) {
      mapping[service] = potentialSidecar;
    }
  }

  return mapping;
}

/**
 * Auto-detect profile for a service based on name patterns
 *
 * These are sensible defaults for bootstrapping a new config.
 * After config generation, the config file becomes authoritative.
 */
function autoDetectProfile(serviceName: string): Profile {
  const lower = serviceName.toLowerCase();

  // Core services
  if (lower.includes("traefik") || lower.includes("authentik")) {
    return "core";
  }

  // Infrastructure
  if (lower.includes("uptime-kuma")) {
    return "infrastructure";
  }

  // Downloads
  if (
    lower.includes("sabnzbd") ||
    lower.includes("prowlarr") ||
    lower.includes("nzbget") ||
    lower.includes("slskd") ||
    lower.includes("qui")
  ) {
    return "downloads";
  }

  // Arr-stack
  if (
    lower.includes("sonarr") ||
    lower.includes("radarr") ||
    lower.includes("lidarr") ||
    lower.includes("bazarr") ||
    lower.includes("autobrr") ||
    lower.includes("notifiarr") ||
    lower.includes("unpackerr") ||
    lower.includes("praxrr") ||
    lower.includes("arr-scripts")
  ) {
    return "arr-stack";
  }

  // Media
  if (
    lower.includes("plex") ||
    lower.includes("kometa") ||
    lower.includes("tautulli") ||
    lower.includes("plexseerr") ||
    lower.includes("jellyseerr") ||
    lower.includes("homarr")
  ) {
    return "media";
  }

  // Photos
  if (lower.includes("immich")) {
    return "photos";
  }

  // Default
  return "all";
}

/**
 * Generate configuration from compose file
 */
async function generateConfigFromCompose(composePath: string): Promise<PartialRfappsConfig> {
  const services = await parseComposeFile(composePath);
  logDebug(`Found ${services.length} services in compose.yml`);

  // Auto-detect sidecars
  const sidecarMapping = autoDetectSidecars(services);
  logDebug(`Auto-detected ${Object.keys(sidecarMapping).length} sidecar mappings`);

  // Auto-detect profiles
  const profileMapping: Record<string, Profile> = {};
  for (const service of services) {
    profileMapping[service] = autoDetectProfile(service);
  }

  // Define valid profiles (default set for bootstrapping new configs)
  const validProfiles: Profile[] = [
    "core",
    "infrastructure",
    "downloads",
    "arr-stack",
    "media",
    "photos",
    "all",
  ];

  // Create predefined groups (bootstrapping defaults)
  // These groups match common service configurations and can be customized
  // in the generated config file after initial creation.
  const groups: Record<string, string[]> = {};

  // VPN stack (default: services commonly run through VPN)
  const vpnServices = ["slskd"];
  const vpnStack = vpnServices.flatMap((s) => {
    const sidecar = sidecarMapping[s];
    return sidecar !== undefined ? [s, sidecar] : [s];
  });
  if (vpnStack.length > 0) {
    groups["vpn-stack"] = vpnStack;
  }

  // Media stack (default: core media management services)
  const mediaServices = ["plex", "sonarr", "radarr", "lidarr", "bazarr"];
  const mediaStack = mediaServices.flatMap((s) => {
    const sidecar = sidecarMapping[s];
    return sidecar !== undefined ? [s, sidecar] : [s];
  });
  if (mediaStack.length > 0) {
    groups["media-stack"] = mediaStack;
  }

  // Arr stack (default: *arr automation services)
  const arrServices = ["sonarr", "radarr", "lidarr", "bazarr", "prowlarr"];
  const arrStack = arrServices.flatMap((s) => {
    const sidecar = sidecarMapping[s];
    return sidecar !== undefined ? [s, sidecar] : [s];
  });
  if (arrStack.length > 0) {
    groups["arr-stack"] = arrStack;
  }

  // Download stack (default: common download clients)
  const downloadServices = ["unpackerr", "autobrr", "sabnzbd", "slskd", "nzbget"];
  const downloadStack = downloadServices.flatMap((s) => {
    const sidecar = sidecarMapping[s];
    return sidecar !== undefined ? [s, sidecar] : [s];
  });
  if (downloadStack.length > 0) {
    groups["download-stack"] = downloadStack;
  }

  // Auth stack (default: Authentik authentication services)
  const authServices = [
    "authentik-server",
    "authentik-worker",
    "authentik-db",
    "authentik-redis",
    "authentik-media",
  ];
  const authStack = authServices.flatMap((s) => {
    const sidecar = sidecarMapping[s];
    return sidecar !== undefined ? [s, sidecar] : [s];
  });
  if (authStack.length > 0) {
    groups["auth-stack"] = authStack;
  }

  // Immich stack (default: Immich photo management services)
  const immichServices = ["immich-server", "immich-ml", "immich-redis", "immich-postgres"];
  const immichStack = immichServices.flatMap((s) => {
    const sidecar = sidecarMapping[s];
    return sidecar !== undefined ? [s, sidecar] : [s];
  });
  if (immichStack.length > 0) {
    groups["immich-stack"] = immichStack;
  }

  return {
    composePath: "compose.yml",
    envFile: ".env.local",
    sidecars: {
      enabled: true,
      mapping: sidecarMapping,
    },
    groups,
    profiles: {
      defaultProfile: "all",
      validProfiles,
      mapping: profileMapping,
    },
    healthCheck: {
      timeout: 60,
      interval: 5,
      retries: 12,
      waitForReady: true,
    },
    envTool: {
      tool: "dotenvx",
    },
    docker: {
      sshRetry: {
        maxRetries: 3,
        delayMs: 2000,
      },
    },
  };
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute the init command
 */
export async function executeInit(options: InitCommandOptions): Promise<void> {
  try {
    // Determine output path
    const outputPath = getDefaultConfigPath(options.global);
    logDebug(`Target config path: ${outputPath}`);

    // Check if file exists
    const exists = await fileExists(outputPath);
    if (exists && !options.force && !options.dryRun) {
      throw new ConfigValidationError("config", outputPath, "Configuration file already exists");
    }

    // Determine compose file path
    const composePath = join(process.cwd(), "compose.yml");
    const composeExists = await fileExists(composePath);

    if (!composeExists) {
      // If compose.yml doesn't exist, use project config as template
      logWarn("No compose.yml found in current directory");
      logInfo("Using project config as template");

      const projectConfigPath = getProjectConfigPath();
      const projectConfigExists = await fileExists(projectConfigPath);

      if (!projectConfigExists) {
        throw new ConfigNotFoundError([projectConfigPath]);
      }
    }

    // Generate config
    logInfo(
      composeExists ? "Generating config from compose.yml..." : "Using project config template...",
    );
    const config = composeExists
      ? await generateConfigFromCompose(composePath)
      : {
          composePath: "compose.yml",
          envFile: ".env.local",
          sidecars: { enabled: true },
          profiles: { defaultProfile: "all" },
          healthCheck: { timeout: 60, interval: 5, retries: 12, waitForReady: true },
          envTool: { tool: "dotenvx" as const },
          docker: { sshRetry: { maxRetries: 3, delayMs: 2000 } },
        };

    // Format config
    const content = options.json ? JSON.stringify(config, null, 2) : YAML.stringify(config);

    // Handle dry run
    if (options.dryRun) {
      logInfo("Dry run - would write to: " + outputPath);
      console.log("\n" + content);
      return;
    }

    // Handle machine-readable output formats (json, yaml, csv)
    // The global --output flag controls CLI output format, separate from
    // init's local --json flag which controls config file format (YAML vs JSON).
    const format: OutputFormat = options.output ?? "text";
    if (isMachineFormat(format)) {
      await formatOutput(format, { path: outputPath, exists, content: config });
      return;
    }

    // Write config
    await writeFile(outputPath, content, "utf-8");

    logSuccess(`Configuration file created: ${outputPath}`);
    logInfo("You can now customize this file to match your setup");
  } catch (error) {
    // Re-throw typed errors for handleCliError() to process
    if (error instanceof ConfigValidationError || error instanceof ConfigNotFoundError) {
      throw error;
    }
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const formatted = formatError(errorObj);
    outputFormattedError(formatted);
    process.exitCode = 1;
  }
}
