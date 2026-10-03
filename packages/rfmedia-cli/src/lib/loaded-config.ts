/**
 * Shared configuration state for rfmedia CLI.
 *
 * This module provides a simple way to share the loaded configuration
 * across command handlers and action modules without circular imports.
 * Also owns the config cache state for mtime+size-based invalidation.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ConfigFile } from "../types/index.js";
import type { ConfigLoadResult } from "../types/config.js";
import type { PlexConfigOptions } from "../types/config.js";
import type { LidarrConfigOptions } from "../types/config.js";
import type { PolicyConfigOptions } from "../types/config.js";

import { logDebug } from "./logger.js";

/**
 * Loaded configuration from config files.
 * Populated by the CLI's preAction hook before command execution.
 */
let loadedConfig: ConfigFile = {};

/**
 * Sets the loaded configuration.
 * Called by the CLI's preAction hook after loading config.
 *
 * @param config - The loaded configuration file
 */
export function setLoadedConfig(config: ConfigFile): void {
  loadedConfig = config;
}

/**
 * Returns the loaded configuration.
 * Call this from commands to merge config values with CLI options.
 *
 * @returns The loaded configuration
 */
export function getLoadedConfig(): ConfigFile {
  return loadedConfig;
}

/**
 * Returns loaded Plex config options with an empty-object fallback.
 *
 * This helper keeps Plex config reads consistent across actions and adapters.
 */
export function getLoadedPlexConfig(): PlexConfigOptions {
  return loadedConfig.plex ?? {};
}

/**
 * Returns loaded Lidarr config options with an empty-object fallback.
 *
 * This helper keeps Lidarr config reads consistent across the lidarr client
 * factory and actions.
 *
 * @returns The loaded Lidarr configuration, or an empty object when unset
 */
export function getLoadedLidarrConfig(): LidarrConfigOptions {
  return loadedConfig.lidarr ?? {};
}

/**
 * Returns loaded policy config options, or `undefined` when the section is absent.
 *
 * Absence is preserved rather than collapsed to `{}` so the policy engine can
 * distinguish "no `policy:` section at all" from an empty one, and so actions
 * read policy config without importing `config.ts` and risking an ESM cycle.
 *
 * @returns The loaded policy configuration, or `undefined` when unset
 */
export function getLoadedPolicyConfig(): PolicyConfigOptions | undefined {
  return loadedConfig.policy;
}

// ---------------------------------------------------------------------------
// Config cache -- mtime+size invalidation following rfapps-cli validation.ts
// ---------------------------------------------------------------------------

/** Cached config entry with file metadata for invalidation. */
export interface ConfigCacheEntry {
  /** Resolved config file path */
  key: string;
  /** File modification time in milliseconds */
  mtimeMs: number;
  /** File size in bytes */
  size: number;
  /** The full config load result (config, loadedFrom, searchedPaths) */
  result: ConfigLoadResult;
}

/** Module-level config cache (single entry, not a Map). */
let configCache: ConfigCacheEntry | null = null;

/**
 * Returns the raw config cache entry, or null if no cache exists.
 */
export function getConfigCache(): ConfigCacheEntry | null {
  return configCache;
}

/**
 * Checks whether the config cache is still valid by comparing
 * the cached file's mtime and size against the current filesystem state.
 *
 * @returns `true` if the cache is valid, `false` otherwise
 */
export async function isConfigCacheValid(): Promise<boolean> {
  if (configCache === null) {
    return false;
  }

  try {
    const stats = await stat(configCache.key);
    const valid = stats.mtimeMs === configCache.mtimeMs && stats.size === configCache.size;

    if (valid) {
      logDebug(`Config cache hit: ${configCache.key}`);
    } else {
      logDebug(`Config cache miss: ${configCache.key} (file changed)`);
    }

    return valid;
  } catch {
    return false;
  }
}

/**
 * Stores a new config cache entry after a successful config load.
 * Stats the config file to capture mtime and size for later invalidation.
 *
 * @param result - The complete config load result to cache
 * @param configPath - The path to the config file that was loaded
 */
export async function updateConfigCache(
  result: ConfigLoadResult,
  configPath: string,
): Promise<void> {
  try {
    const stats = await stat(configPath);
    configCache = {
      key: resolve(configPath),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      result,
    };
    logDebug(`Config cache stored: ${configPath}`);
  } catch {
    configCache = null;
  }
}

/**
 * Clears the config cache. Used for test isolation and after config-modifying actions.
 */
export function clearConfigCache(): void {
  configCache = null;
  logDebug("Config cache cleared");
}
