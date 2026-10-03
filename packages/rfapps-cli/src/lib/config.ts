/**
 * Configuration loading and management for rfapps CLI
 *
 * Configuration search order (highest priority first):
 * 1. .rfapps.yaml/.rfapps.yml/.rfapps.json in current directory
 * 2. ~/.config/rfapps/config.yaml/.yml/.json
 * 3. ~/.rfapps.yaml/.yml/.json
 * 4. rfapps.config.yaml in current working directory (required, fallback to repo root)
 *
 * Environment variables and command line options override file config.
 */

import { readFile, access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  logDebug,
  injectSecrets,
  warnUnresolvedTemplates,
  validateConfigSize,
  SecretsInjectionError,
  ConfigSizeError,
} from "@rfmedia/common";

import { ConfigNotFoundError, ConfigValidationError } from "./errors.js";

import type { RfappsConfig, PartialRfappsConfig, Profile } from "../types/index.js";
import { getDefaultDatabasePath } from "./db.js";

/**
 * Configuration file names to search for (in order of priority)
 */
const CONFIG_FILE_NAMES = [".rfapps.yaml", ".rfapps.yml", ".rfapps.json"];

/**
 * Project root configuration file name
 */
const PROJECT_CONFIG_NAME = "rfapps.config.yaml";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

/**
 * Get the project root directory (where rfapps.config.yaml lives)
 * This traverses up from the CLI package to find the workspace root
 */
function getProjectRoot(): string {
  // Get the directory of this source file
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);

  // Navigate up from packages/rfapps-cli/dist/lib to project root
  // In dev: packages/rfapps-cli/src/lib -> ../../.. (3 levels up)
  // In prod: packages/rfapps-cli/dist/lib -> ../../../.. (4 levels up)
  const isDist = currentDir.includes(`${sep}dist${sep}`);
  const levelsUp = isDist ? 4 : 3;

  let root = currentDir;
  for (let i = 0; i < levelsUp; i++) {
    root = dirname(root);
  }

  return root;
}

/**
 * Get the path to the project root config file
 */
export function getProjectConfigPath(): string {
  return join(getProjectRoot(), PROJECT_CONFIG_NAME);
}

/**
 * Check if a file exists and is readable
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
 * Find configuration file in a directory
 */
async function findConfigFile(dir: string): Promise<string | undefined> {
  for (const name of CONFIG_FILE_NAMES) {
    const path = join(dir, name);
    if (await fileExists(path)) {
      return path;
    }
  }
  return undefined;
}

/**
 * Parse configuration file content
 */
function parseConfigFile(content: string, path: string): PartialRfappsConfig {
  if (path.endsWith(".json")) {
    return JSON.parse(content) as PartialRfappsConfig;
  }
  return YAML.parse(content) as PartialRfappsConfig;
}

/**
 * Merge partial config into full config
 * Base is required to have all fields populated
 */
function mergeConfig(base: RfappsConfig, override: PartialRfappsConfig): RfappsConfig {
  return {
    composePath: override.composePath ?? base.composePath,
    envFile: override.envFile ?? base.envFile,
    sidecars: {
      mapping: override.sidecars?.mapping ?? base.sidecars.mapping,
      enabled: override.sidecars?.enabled ?? base.sidecars.enabled,
    },
    groups: override.groups ?? base.groups,
    profiles: {
      mapping: override.profiles?.mapping ?? base.profiles.mapping,
      defaultProfile: override.profiles?.defaultProfile ?? base.profiles.defaultProfile,
      validProfiles: override.profiles?.validProfiles ?? base.profiles.validProfiles,
    },
    healthCheck: {
      timeout: override.healthCheck?.timeout ?? base.healthCheck.timeout,
      interval: override.healthCheck?.interval ?? base.healthCheck.interval,
      retries: override.healthCheck?.retries ?? base.healthCheck.retries,
      waitForReady: override.healthCheck?.waitForReady ?? base.healthCheck.waitForReady,
    },
    envTool: {
      tool: override.envTool?.tool ?? base.envTool.tool,
      dotenvxPath: override.envTool?.dotenvxPath ?? base.envTool.dotenvxPath,
      opOptions: override.envTool?.opOptions ?? base.envTool.opOptions,
    },
    docker: {
      context: override.docker?.context ?? base.docker.context,
      sshRetry: override.docker?.sshRetry ?? base.docker.sshRetry,
    },
    interactive: {
      pageSize: override.interactive?.pageSize ?? base.interactive.pageSize,
    },
    state: {
      dbPath: override.state?.dbPath ?? base.state.dbPath,
      enabled: override.state?.enabled ?? base.state.enabled,
    },
    parallel: {
      enabled: override.parallel?.enabled ?? base.parallel.enabled,
      workers: override.parallel?.workers ?? base.parallel.workers,
    },
    lint: {
      ignore: override.lint?.ignore ?? base.lint?.ignore ?? [],
    },
    scan: {
      scanner: override.scan?.scanner ?? base.scan?.scanner,
      failOn: override.scan?.failOn ?? base.scan?.failOn,
      ignore: override.scan?.ignore ?? base.scan?.ignore ?? [],
      timeoutMs: override.scan?.timeoutMs ?? base.scan?.timeoutMs,
      maxTargets: override.scan?.maxTargets ?? base.scan?.maxTargets,
      concurrency: override.scan?.concurrency ?? base.scan?.concurrency,
    },
    harden: {
      ignore: override.harden?.ignore ?? base.harden?.ignore ?? [],
      rules: override.harden?.rules ?? base.harden?.rules,
      includeReview: override.harden?.includeReview ?? base.harden?.includeReview,
      backup: override.harden?.backup ?? base.harden?.backup,
    },
    // Wholesale replacement, like every other collection here: a `tags:` block in a
    // higher-precedence layer fully shadows the base mapping rather than merging into it.
    tags: {
      mapping: override.tags?.mapping ?? base.tags?.mapping ?? {},
    },
  };
}

/**
 * Convert partial config to full config
 * Throws error if required fields are missing
 */
function partialToFull(partial: PartialRfappsConfig, source: string): RfappsConfig {
  // Validate required fields
  if (partial.sidecars?.mapping === undefined) {
    throw new ConfigValidationError(
      "sidecars.mapping",
      source,
      "Missing required field 'sidecars.mapping'",
    );
  }
  if (partial.groups === undefined) {
    throw new ConfigValidationError("groups", source, "Missing required field 'groups'");
  }
  if (partial.profiles?.mapping === undefined) {
    throw new ConfigValidationError(
      "profiles.mapping",
      source,
      "Missing required field 'profiles.mapping'",
    );
  }
  if (partial.profiles?.validProfiles === undefined) {
    throw new ConfigValidationError(
      "profiles.validProfiles",
      source,
      "Missing required field 'profiles.validProfiles'",
    );
  }

  return {
    composePath: partial.composePath ?? "compose.yml",
    envFile: partial.envFile ?? ".env.local",
    sidecars: {
      mapping: partial.sidecars.mapping,
      enabled: partial.sidecars.enabled ?? true,
    },
    groups: partial.groups,
    profiles: {
      mapping: partial.profiles.mapping,
      defaultProfile: partial.profiles.defaultProfile ?? "all",
      validProfiles: partial.profiles.validProfiles,
    },
    healthCheck: {
      timeout: partial.healthCheck?.timeout ?? 60,
      interval: partial.healthCheck?.interval ?? 5,
      retries: partial.healthCheck?.retries ?? 12,
      waitForReady: partial.healthCheck?.waitForReady ?? true,
    },
    envTool: {
      tool: partial.envTool?.tool ?? "dotenvx",
      dotenvxPath: partial.envTool?.dotenvxPath,
      opOptions: partial.envTool?.opOptions,
    },
    docker: {
      context: partial.docker?.context,
      sshRetry: partial.docker?.sshRetry ?? {
        maxRetries: 3,
        delayMs: 2000,
      },
    },
    interactive: {
      pageSize: partial.interactive?.pageSize ?? 10,
    },
    state: {
      dbPath: partial.state?.dbPath,
      enabled: partial.state?.enabled ?? true,
    },
    parallel: {
      enabled: partial.parallel?.enabled ?? false,
      workers: partial.parallel?.workers ?? 4,
    },
    lint: {
      ignore: partial.lint?.ignore ?? [],
    },
    scan: {
      scanner: partial.scan?.scanner,
      failOn: partial.scan?.failOn,
      ignore: partial.scan?.ignore ?? [],
      timeoutMs: partial.scan?.timeoutMs,
      maxTargets: partial.scan?.maxTargets,
      concurrency: partial.scan?.concurrency,
    },
    harden: {
      ignore: partial.harden?.ignore ?? [],
      rules: partial.harden?.rules,
      includeReview: partial.harden?.includeReview,
      backup: partial.harden?.backup,
    },
    // Optional section: an absent `tags:` block is an empty mapping, never an error.
    tags: {
      mapping: partial.tags?.mapping ?? {},
    },
  };
}

/**
 * Load configuration from a file.
 *
 * @param path - Path to the configuration file
 * @returns Parsed configuration or undefined if the file does not exist
 * @throws {SecretsInjectionError} When template variables reference missing environment variables
 * @throws {ConfigSizeError} When the configuration file exceeds the maximum allowed size
 * @throws {ConfigNotFoundError} When re-thrown from a nested config load
 * @throws {ConfigValidationError} When the configuration file cannot be parsed or is invalid
 */
async function loadConfigFromFile(path: string): Promise<PartialRfappsConfig | undefined> {
  try {
    const content = await readFile(path, "utf-8");

    // Validate config file size before processing
    validateConfigSize(content, path);

    // Inject secrets from environment variables
    const processedContent: string = injectSecrets(content, { configPath: path });

    // Warn about any unresolved or malformed templates
    warnUnresolvedTemplates(processedContent, path);

    return parseConfigFile(processedContent, path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }

    // Re-throw known error types to halt execution immediately
    if (
      error instanceof SecretsInjectionError ||
      error instanceof ConfigSizeError ||
      error instanceof ConfigNotFoundError ||
      error instanceof ConfigValidationError
    ) {
      throw error;
    }
    // Wrap other errors in ConfigValidationError for structured handling
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError("config", path, reason);
  }
}

/**
 * Load configuration from environment variables
 */
function loadConfigFromEnv(): PartialRfappsConfig {
  const config: PartialRfappsConfig = {};

  if (process.env["RFAPPS_COMPOSE_PATH"] !== undefined) {
    config.composePath = process.env["RFAPPS_COMPOSE_PATH"];
  }

  if (process.env["RFAPPS_ENV_FILE"] !== undefined) {
    config.envFile = process.env["RFAPPS_ENV_FILE"];
  }

  if (process.env["RFAPPS_ENV_TOOL"] !== undefined) {
    const tool = process.env["RFAPPS_ENV_TOOL"];
    if (tool === "dotenvx" || tool === "op" || tool === "none") {
      config.envTool = { tool };
    }
  }

  if (process.env["RFAPPS_DEFAULT_PROFILE"] !== undefined) {
    const profile = process.env["RFAPPS_DEFAULT_PROFILE"] as Profile;
    if (config.profiles === undefined) {
      config.profiles = {};
    }
    config.profiles.defaultProfile = profile;
  }

  if (process.env["RFAPPS_SIDECARS_ENABLED"] !== undefined) {
    const enabled = process.env["RFAPPS_SIDECARS_ENABLED"].toLowerCase() === "true";
    if (config.sidecars === undefined) {
      config.sidecars = {};
    }
    config.sidecars.enabled = enabled;
  }

  if (process.env["RFAPPS_HEALTH_TIMEOUT"] !== undefined) {
    const timeout = parseInt(process.env["RFAPPS_HEALTH_TIMEOUT"], 10);
    if (!isNaN(timeout)) {
      if (config.healthCheck === undefined) {
        config.healthCheck = {};
      }
      config.healthCheck.timeout = timeout;
    }
  }

  if (process.env["RFAPPS_WAIT_FOR_READY"] !== undefined) {
    const waitForReady = process.env["RFAPPS_WAIT_FOR_READY"].toLowerCase() === "true";
    if (config.healthCheck === undefined) {
      config.healthCheck = {};
    }
    config.healthCheck.waitForReady = waitForReady;
  }

  if (process.env["RFAPPS_STATE_DB_PATH"] !== undefined) {
    if (config.state === undefined) {
      config.state = {};
    }
    config.state.dbPath = process.env["RFAPPS_STATE_DB_PATH"];
  }

  if (process.env["RFAPPS_STATE_ENABLED"] !== undefined) {
    const enabled = process.env["RFAPPS_STATE_ENABLED"].toLowerCase() === "true";
    if (config.state === undefined) {
      config.state = {};
    }
    config.state.enabled = enabled;
  }

  if (process.env["RFAPPS_PARALLEL_ENABLED"]) {
    const enabled = process.env["RFAPPS_PARALLEL_ENABLED"].toLowerCase() === "true";
    if (config.parallel === undefined) {
      config.parallel = {};
    }
    config.parallel.enabled = enabled;
  }

  if (process.env["RFAPPS_PARALLEL_WORKERS"] !== undefined) {
    const workers = parseInt(process.env["RFAPPS_PARALLEL_WORKERS"], 10);
    if (!isNaN(workers)) {
      if (config.parallel === undefined) {
        config.parallel = {};
      }
      config.parallel.workers = workers;
    }
  }

  return config;
}

/**
 * Load and merge configuration from all sources.
 *
 * Configuration is loaded from multiple sources and merged in priority order.
 * Higher priority sources override lower priority ones.
 *
 * Search order (lowest to highest priority):
 * 1. Project config (rfapps.config.yaml) - required, contains service mappings
 * 2. Home config (~/.rfapps.yaml) - user defaults
 * 3. XDG config (~/.config/rfapps/config.yaml) - XDG compliant location
 * 4. Local config (.rfapps.yaml in current directory) - project-specific overrides
 * 5. Environment variables (RFAPPS_*) - runtime overrides
 *
 * Required fields (must be in project config):
 * - sidecars.mapping: Service to sidecar mappings
 * - groups: Service group definitions
 * - profiles.mapping: Service to profile mappings
 * - profiles.validProfiles: List of valid profile names
 *
 * @param cwd - Working directory for resolving relative paths (defaults to process.cwd())
 * @returns Fully resolved RfappsConfig
 * @throws {ConfigNotFoundError} When the required project configuration file is missing
 * @throws {ConfigValidationError} When required fields are missing from configuration
 *
 * @example
 * ```typescript
 * const config = await loadConfig();
 * console.log(config.composePath); // Absolute path to compose.yml
 * ```
 */
export async function loadConfig(cwd?: string): Promise<RfappsConfig> {
  const workingDir = cwd ?? process.env["INIT_CWD"] ?? process.cwd();

  // 1. Load project config (required, lowest priority)
  const localProjectConfigPath = join(workingDir, PROJECT_CONFIG_NAME);
  const rootProjectConfigPath = getProjectConfigPath();
  const projectConfigPath = (await fileExists(localProjectConfigPath))
    ? localProjectConfigPath
    : rootProjectConfigPath;

  const projectConfig = await loadConfigFromFile(projectConfigPath);

  if (projectConfig === undefined) {
    throw new ConfigNotFoundError([localProjectConfigPath, rootProjectConfigPath]);
  }

  logDebug(`Loading project config from ${projectConfigPath}`);
  let config: RfappsConfig = partialToFull(projectConfig, projectConfigPath);

  // 2. Load home config from home directory
  const homeDir = homedir();
  const homeConfigPath = await findConfigFile(homeDir);
  if (homeConfigPath !== undefined) {
    logDebug(`Loading home config from ${homeConfigPath}`);
    const homeConfig = await loadConfigFromFile(homeConfigPath);
    if (homeConfig !== undefined) {
      config = mergeConfig(config, homeConfig);
    }
  }

  // 3. Load XDG config from ~/.config/rfapps
  const xdgConfigDir = join(homeDir, ".config", "rfapps");
  const xdgConfigPath = await findConfigFile(xdgConfigDir);
  if (xdgConfigPath !== undefined) {
    logDebug(`Loading XDG config from ${xdgConfigPath}`);
    const xdgConfig = await loadConfigFromFile(xdgConfigPath);
    if (xdgConfig !== undefined) {
      config = mergeConfig(config, xdgConfig);
    }
  }

  // 4. Load local config from current directory (highest priority)
  const localConfigPath = await findConfigFile(workingDir);
  if (localConfigPath !== undefined) {
    logDebug(`Loading local config from ${localConfigPath}`);
    const localConfig = await loadConfigFromFile(localConfigPath);
    if (localConfig !== undefined) {
      config = mergeConfig(config, localConfig);
    }
  }

  // 5. Load from environment variables
  const envConfig = loadConfigFromEnv();
  config = mergeConfig(config, envConfig);

  // 6. Resolve relative paths
  config.composePath = resolve(workingDir, config.composePath);
  config.envFile = resolve(workingDir, config.envFile);

  logDebug(`Loaded config: composePath=${config.composePath}, envFile=${config.envFile}`);

  return config;
}

/**
 * List every configuration layer file that currently exists on disk.
 *
 * Uses the same discovery rules as {@link loadConfig}, but reports paths instead of
 * merged values, so callers can attribute a merged section back to the layer that
 * won it. Results are returned in precedence order, **highest priority first**:
 *
 * 1. Local config (`.rfapps.yaml`/`.yml`/`.json` in the working directory)
 * 2. XDG config (`~/.config/rfapps/.rfapps.yaml`/`.yml`/`.json`)
 * 3. Home config (`~/.rfapps.yaml`/`.yml`/`.json`)
 * 4. Project config (`rfapps.config.yaml` in the working directory, else the repo root copy)
 *
 * Read-only and non-throwing: a layer that does not exist is simply omitted, and a file
 * resolving to the same absolute path under two layers (running from `$HOME`, for example)
 * is reported once, at its highest-precedence position.
 *
 * @param cwd - Working directory for layer discovery (defaults to `INIT_CWD` or `process.cwd()`)
 * @returns Absolute paths of the existing config layers, highest precedence first
 *
 * @example
 * ```typescript
 * const layers = await listConfigLayerPaths();
 * // ['/repo/.rfapps.yaml', '/repo/rfapps.config.yaml']
 * ```
 */
export async function listConfigLayerPaths(cwd?: string): Promise<string[]> {
  const workingDir = cwd ?? process.env["INIT_CWD"] ?? process.cwd();
  const homeDir = homedir();

  const localProjectConfigPath = join(workingDir, PROJECT_CONFIG_NAME);
  const projectConfigPath = (await fileExists(localProjectConfigPath))
    ? localProjectConfigPath
    : getProjectConfigPath();

  const candidates = [
    await findConfigFile(workingDir),
    await findConfigFile(join(homeDir, ".config", "rfapps")),
    await findConfigFile(homeDir),
    (await fileExists(projectConfigPath)) ? projectConfigPath : undefined,
  ];

  const seen = new Set<string>();
  const layers: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }
    const absolute = resolve(workingDir, candidate);
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    layers.push(absolute);
  }

  return layers;
}

/**
 * Apply CLI option overrides to loaded configuration.
 *
 * Creates a new config object with CLI-specified values taking precedence
 * over file-based configuration. Relative paths are resolved against the
 * working directory.
 *
 * @param config - Base configuration loaded from files
 * @param overrides - CLI options that override file config
 * @param cwd - Working directory for resolving paths (defaults to process.cwd())
 * @returns New config with overrides applied (original is not mutated)
 *
 * @example
 * ```typescript
 * const config = await loadConfig();
 * const finalConfig = applyCliOverrides(config, {
 *   composePath: './custom/compose.yml',
 *   noSidecars: true
 * });
 * ```
 */
export function applyCliOverrides(
  config: RfappsConfig,
  overrides: {
    composePath?: string;
    envFile?: string;
    profile?: Profile;
    noSidecars?: boolean;
  },
  cwd?: string,
): RfappsConfig {
  const workingDir = cwd ?? process.env["INIT_CWD"] ?? process.cwd();
  const result: RfappsConfig = { ...config };

  if (overrides.composePath !== undefined) {
    result.composePath = resolve(workingDir, overrides.composePath);
  }

  if (overrides.envFile !== undefined) {
    result.envFile = resolve(workingDir, overrides.envFile);
  }

  if (overrides.profile !== undefined) {
    result.profiles = {
      ...result.profiles,
      defaultProfile: overrides.profile,
    };
  }

  if (overrides.noSidecars === true) {
    result.sidecars = {
      ...result.sidecars,
      enabled: false,
    };
  }

  return result;
}

/**
 * Validate configuration
 */
export function validateConfig(config: RfappsConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check compose file path
  if (config.composePath === undefined || config.composePath === "") {
    errors.push("composePath is required");
  }

  // Check env tool
  const validEnvTools = ["dotenvx", "op", "none"];
  if (!validEnvTools.includes(config.envTool.tool)) {
    errors.push(
      `Invalid envTool: ${config.envTool.tool}. Must be one of: ${validEnvTools.join(", ")}`,
    );
  }

  // Check health check config
  if (config.healthCheck.timeout <= 0) {
    errors.push("healthCheck.timeout must be positive");
  }
  if (config.healthCheck.interval <= 0) {
    errors.push("healthCheck.interval must be positive");
  }
  if (config.healthCheck.retries <= 0) {
    errors.push("healthCheck.retries must be positive");
  }
  if (typeof config.healthCheck.waitForReady !== "boolean") {
    errors.push("healthCheck.waitForReady must be a boolean");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Generate a minimal sample configuration file content (for user overrides)
 * Does not include full mappings - those come from project config
 */
export function generateSampleConfig(format: "yaml" | "json" = "yaml"): string {
  const sampleConfig: PartialRfappsConfig = {
    composePath: "compose.yml",
    envFile: ".env.local",
    sidecars: {
      enabled: true,
    },
    profiles: {
      defaultProfile: "all",
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
    interactive: {
      pageSize: 10,
    },
    state: {
      enabled: true,
    },
    parallel: {
      enabled: false,
      workers: 4,
    },
  };

  if (format === "json") {
    return JSON.stringify(sampleConfig, null, 2);
  }

  return YAML.stringify(sampleConfig);
}

/**
 * Get the default config path for creating new configs
 */
export function getDefaultConfigPath(global: boolean): string {
  if (global) {
    return join(homedir(), ".rfapps.yaml");
  }
  return join(process.cwd(), ".rfapps.yaml");
}

/**
 * Get the path to the state database file.
 *
 * Resolution order (highest priority first):
 * 1. RFAPPS_STATE_DB_PATH environment variable
 * 2. state.dbPath in configuration file
 * 3. Default: XDG-aware path (prefers ~/.config/rfapps/state.db)
 *
 * @param config - The loaded rfapps configuration
 * @returns Absolute path to the state database file
 *
 * @example
 * ```typescript
 * const config = await loadConfig();
 * const dbPath = getStateDbPath(config);
 * // Returns: /home/user/.config/rfapps/state.db (or configured path)
 * ```
 */
export function getStateDbPath(config: RfappsConfig): string {
  // Environment variable takes highest priority
  if (process.env["RFAPPS_STATE_DB_PATH"] !== undefined) {
    const envPath = process.env["RFAPPS_STATE_DB_PATH"];
    // Resolve relative paths against home directory
    if (envPath.startsWith("~")) {
      return join(homedir(), envPath.slice(1));
    }
    return resolve(envPath);
  }

  // Config file path takes second priority
  if (config.state.dbPath !== undefined) {
    const configPath = config.state.dbPath;
    // Resolve ~ to home directory
    if (configPath.startsWith("~")) {
      return join(homedir(), configPath.slice(1));
    }
    return resolve(configPath);
  }

  // Default path (XDG-aware)
  return getDefaultDatabasePath();
}
