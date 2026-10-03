/**
 * Configuration file loading and validation for rfmedia CLI.
 *
 * Supports both JSON and YAML formats (.yaml, .yml, .json).
 * YAML files have higher priority than JSON equivalents in each location.
 *
 * Configuration search order (highest priority first):
 * 1. .rfmedia.yaml/.rfmedia.yml/.rfmedia.json in current working directory
 * 2. ~/.config/rfmedia/config.yaml/.yml/.json
 * 3. ~/.rfmedia.yaml/.yml/.json
 */

import { lstat, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import {
  hasUnresolvedTemplates,
  injectSecrets,
  warnUnresolvedTemplates,
  validateConfigSize,
  SecretsInjectionError,
} from "@rfmedia/common";
import { logDebug, logWarn } from "./logger.js";
import { pathExists } from "./filesystem.js";
import { getConfigCache, isConfigCacheValid, updateConfigCache } from "./loaded-config.js";
import {
  ConfigError,
  describeType,
  rejectUnknownConfigKeys,
  requireConfigObject,
  validateBoolean,
  validateBoundedInteger,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateStarRating,
  validateString,
  validateStringArray,
  validateUrl,
} from "./config-validation.js";

export { clearConfigCache } from "./loaded-config.js";

import type {
  ConfigFile,
  ConfigLoadResult,
  CopyConfigOptions,
  ConflictStrategy,
  CleanConfigOptions,
  WatchConfigOptions,
  LinkVideosConfigOptions,
  GlobalConfigOptions,
  PlexAuthConfigOptions,
  PlexConfigOptions,
  PlexLibraryMapping,
  PlexSyncDefaults,
  PlexPlaylistDefaults,
  PlexDefaultFilters,
  PlexCacheConfig,
  DiscoveryConfigOptions,
  LastFmConfigOptions,
  PolicyConfigOptions,
  PolicyRulesConfigOptions,
  PolicyRatingQualityUpgradeConfigOptions,
  PolicyStaleMonitoringConfigOptions,
  PolicyDiscoverySeedConfigOptions,
  LidarrConfigOptions,
  LidarrResilienceConfigOptions,
  LidarrSchedulerConfigOptions,
  LidarrSchedulerLaneConfigOptions,
  UndoConfigOptions,
  TrackingConfigOptions,
  ConvertFormat,
  FiltersConfigOptions,
  SmartFilter,
  SmartFilterRule,
  SeparationConfig,
  FilterRule,
  FilterGroup,
  PlexFiltersConfigOptions,
  PlexSmartFilter,
  PlexSmartFilterRule,
  PlexFilterRule,
  PlexFilterGroup,
  PlexMediaType,
  InteractiveConfig,
  PluginsConfigOptions,
  ExternalCommandPluginConfig,
} from "../types/index.js";
import { getDefaultDatabasePath } from "./db.js";
import type {
  LidarrCascadeAnalysisConfigOptions,
  LidarrConfiguredPresetPack,
  LidarrProfilePresetsConfigOptions,
  PolicyOverrideConfigOptions,
  PlexSyncOnCopyDefaults,
} from "../types/config.js";
import { MEDIA_IDENTITY_MAX_PAGE_SIZE } from "../types/media-server.js";
import type {
  LidarrPresetCapability,
  LidarrPresetCustomFormat,
  LidarrPresetCustomFormatImplementation,
  LidarrPresetCustomFormatSpecification,
  LidarrPresetFieldValue,
  LidarrPresetFormatScore,
  LidarrPresetNaming,
  LidarrPresetQualityItem,
  LidarrPresetQualityProfile,
} from "../types/lidarr-presets.js";

/**
 * Valid conversion formats for validation.
 */
const VALID_CONVERT_FORMATS: ConvertFormat[] = ["alac", "mp3", "aac", "opus"];
const VALID_CONFLICT_STRATEGIES: ConflictStrategy[] = ["skip", "overwrite", "rename", "ask"];

/**
 * Default interactive configuration for ink-based selection UI.
 * These values are used when not specified in the config file.
 */
const DEFAULT_INTERACTIVE_CONFIG: InteractiveConfig = {
  artistPageSize: 20,
  albumPageSize: 20,
  trackPageSize: 25,
};

/**
 * Valid range for interactive page size configuration.
 * Minimum: 5 (enough to be useful)
 * Maximum: 100 (prevents performance issues with large lists)
 */
const MIN_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 100;
const MAX_SEPARATION_GAP = 100;

/**
 * Field names that contain sensitive information and should be redacted in logs.
 *
 * Matching is substring-based (see {@link isSensitiveFieldName}), so entries must
 * be specific enough not to capture unrelated keys. Deliberately excluded:
 * a bare `"pin"` (matches `mapping`, `pinned`, `spinner`, `shipping`) and a bare
 * `"key"` (matches `keyword`) — hence `"pincode"` and `"privatekey"` (issue #251).
 */
const SENSITIVE_FIELD_NAMES = [
  "token",
  "password",
  "apiKey",
  "api_key",
  "api-key",
  "secret",
  "plexToken",
  "privatekey",
  "jwt",
  "nonce",
  "pincode",
  "credential",
  "devicejwt",
] as const;

function isSensitiveFieldName(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_FIELD_NAMES.some(
    (sensitiveKey) =>
      lowerKey === sensitiveKey.toLowerCase() || lowerKey.includes(sensitiveKey.toLowerCase()),
  );
}

/**
 * Recursively redacts sensitive fields from an object for safe logging.
 * Replaces values of fields matching SENSITIVE_FIELD_NAMES with "[REDACTED]".
 *
 * @param value - The value to redact (can be any type)
 * @returns A new object with sensitive fields redacted, or the original value if not an object
 */
function redactSensitiveFields(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item));
  }

  if (typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFieldName(key) && typeof val === "string") {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redactSensitiveFields(val);
      }
    }
    return redacted;
  }

  return value;
}

/**
 * Returns configuration search paths in priority order.
 *
 * Search order (first match wins):
 *   1. CWD: .rfmedia.{yaml,yml,json}
 *   2. XDG: ~/.config/rfmedia/config.{yaml,yml,json}
 *   3. Home directory-based: ~/.rfmedia/config.{yaml,yml,json}
 *   4. Home dotfiles: ~/.rfmedia.{yaml,yml,json}
 *
 * YAML files (.yaml, .yml) have higher priority than JSON equivalents
 * within each location.
 *
 * @returns Array of paths to search, highest priority first
 */
export function getConfigSearchPaths(): string[] {
  const home = homedir();
  return [
    // Current working directory (YAML variants first, then JSON)
    join(process.cwd(), ".rfmedia.yaml"),
    join(process.cwd(), ".rfmedia.yml"),
    join(process.cwd(), ".rfmedia.json"),
    // XDG config directory (YAML variants first, then JSON)
    join(home, ".config", "rfmedia", "config.yaml"),
    join(home, ".config", "rfmedia", "config.yml"),
    join(home, ".config", "rfmedia", "config.json"),
    // Home directory-based (~/.rfmedia/) - common convention for app directories
    join(home, ".rfmedia", "config.yaml"),
    join(home, ".rfmedia", "config.yml"),
    join(home, ".rfmedia", "config.json"),
    // Home dotfiles (YAML variants first, then JSON)
    join(home, ".rfmedia.yaml"),
    join(home, ".rfmedia.yml"),
    join(home, ".rfmedia.json"),
  ];
}

/**
 * Returns the default path for creating a new config file.
 *
 * @param global - If true, return global config path; otherwise, CWD path
 * @returns Path for the config file
 */
export function getDefaultConfigPath(global: boolean): string {
  if (global) {
    return join(homedir(), ".rfmedia.yaml");
  }
  return join(process.cwd(), ".rfmedia.yaml");
}

/**
 * Validates that a value is a positive integer within the page size range.
 *
 * @param value - Value to validate
 * @param propertyPath - Property path for error messages
 * @param configPath - Path to the config file
 * @returns Validated page size
 * @throws ConfigError if value is not within MIN_PAGE_SIZE to MAX_PAGE_SIZE
 */
function validatePageSize(value: unknown, propertyPath: string, configPath: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_PAGE_SIZE ||
    value > MAX_PAGE_SIZE
  ) {
    throw new ConfigError(
      `Expected integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE} for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is a valid convert format.
 */
function validateConvertFormat(
  value: unknown,
  propertyPath: string,
  configPath: string,
): ConvertFormat {
  if (typeof value !== "string" || !VALID_CONVERT_FORMATS.includes(value as ConvertFormat)) {
    throw new ConfigError(
      `Invalid convert format for ${propertyPath}: ${value}. ` +
        `Valid formats: ${VALID_CONVERT_FORMATS.join(", ")}`,
      configPath,
      propertyPath,
    );
  }
  return value as ConvertFormat;
}

/**
 * Validates that a value is a valid rating percent (0-100).
 */
function validateRatingPercent(value: unknown, propertyPath: string, configPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new ConfigError(
      `Expected integer between 0 and 100 for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is a valid range string (e.g., "001-010").
 */
function validateRangeString(value: unknown, propertyPath: string, configPath: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(
      `Expected string for ${propertyPath}, got ${describeType(value)}`,
      configPath,
      propertyPath,
    );
  }
  // Validate format matches START-END pattern
  const rangePattern = /^\d+-\d+$/;
  if (!rangePattern.test(value)) {
    throw new ConfigError(
      `Expected range format "START-END" (e.g., "001-010") for ${propertyPath}, got "${value}"`,
      configPath,
      propertyPath,
    );
  }
  // Validate start <= end
  const [startStr, endStr] = value.split("-");
  const start = parseInt(startStr ?? "0", 10);
  const end = parseInt(endStr ?? "0", 10);
  if (start > end) {
    throw new ConfigError(
      `Range start must be <= end for ${propertyPath}, got "${value}"`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Valid filter fields for smart filter validation.
 */
const VALID_FILTER_FIELDS = ["rating", "genre", "artist", "year", "bpm", "date_added"] as const;
type ValidFilterField = (typeof VALID_FILTER_FIELDS)[number];

/**
 * Valid filter operators for smart filter validation.
 */
const VALID_FILTER_OPERATORS = [">=", "<=", "==", "contains", "within"] as const;
type ValidFilterOperator = (typeof VALID_FILTER_OPERATORS)[number];

/**
 * Valid match types for smart filter groups.
 */
const VALID_MATCH_TYPES = ["all", "any"] as const;
type ValidMatchType = (typeof VALID_MATCH_TYPES)[number];

/**
 * Maximum nesting depth for recursive filter validation.
 * Prevents stack overflow from deeply nested or circular configs.
 */
const MAX_FILTER_DEPTH = 20;

/**
 * Validates that a value is a valid filter field.
 */
function validateFilterField(
  value: unknown,
  propertyPath: string,
  configPath: string,
): ValidFilterField {
  if (typeof value !== "string" || !VALID_FILTER_FIELDS.includes(value as ValidFilterField)) {
    throw new ConfigError(
      `Invalid filter field for ${propertyPath}: ${value}. Valid fields: ${VALID_FILTER_FIELDS.join(", ")}`,
      configPath,
      propertyPath,
    );
  }
  return value as ValidFilterField;
}

/**
 * Validates that a value is a valid filter operator.
 */
function validateFilterOperator(
  value: unknown,
  propertyPath: string,
  configPath: string,
): ValidFilterOperator {
  if (typeof value !== "string" || !VALID_FILTER_OPERATORS.includes(value as ValidFilterOperator)) {
    throw new ConfigError(
      `Invalid filter operator for ${propertyPath}: ${value}. Valid operators: ${VALID_FILTER_OPERATORS.join(", ")}`,
      configPath,
      propertyPath,
    );
  }
  return value as ValidFilterOperator;
}

/**
 * Validates that a value is a valid match type.
 */
function validateMatchType(
  value: unknown,
  propertyPath: string,
  configPath: string,
): ValidMatchType {
  if (typeof value !== "string" || !VALID_MATCH_TYPES.includes(value as ValidMatchType)) {
    throw new ConfigError(
      `Invalid match type for ${propertyPath}: ${value}. Valid types: ${VALID_MATCH_TYPES.join(", ")}`,
      configPath,
      propertyPath,
    );
  }
  return value as ValidMatchType;
}

/**
 * Validates that a filter value is appropriate for the given field type.
 * - rating: number (star rating 1.0-5.0)
 * - genre, artist: string
 * - year, bpm: number
 * - date_added: string (accepts human-readable input like "30d")
 */
function validateFilterValue(
  value: unknown,
  field: ValidFilterField,
  propertyPath: string,
  configPath: string,
): string | number {
  switch (field) {
    case "rating":
      if (typeof value !== "number" || value < 1 || value > 5) {
        throw new ConfigError(
          `Expected number between 1.0 and 5.0 for ${propertyPath}, got ${value}`,
          configPath,
          propertyPath,
        );
      }
      return value;

    case "year":
    case "bpm":
      if (typeof value !== "number") {
        throw new ConfigError(
          `Expected number for ${propertyPath}, got ${describeType(value)}`,
          configPath,
          propertyPath,
        );
      }
      return value;

    case "genre":
    case "artist":
    case "date_added":
      if (typeof value !== "string" || value.trim() === "") {
        throw new ConfigError(
          `Expected non-empty string for ${propertyPath}, got ${describeType(value)}`,
          configPath,
          propertyPath,
        );
      }
      return value;

    default: {
      // Exhaustive check - this should never be reached
      const _exhaustive: never = field;
      throw new ConfigError(`Unknown filter field: ${_exhaustive}`, configPath, propertyPath);
    }
  }
}

/**
 * Validates that a value is a valid disk space margin (0-50).
 */
function validateDiskSpaceMargin(value: unknown, propertyPath: string, configPath: string): number {
  if (typeof value !== "number" || value < 0 || value > 50) {
    throw new ConfigError(
      `Expected number between 0 and 50 for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates CopyConfigOptions.
 */
function validateCopyConfig(raw: Record<string, unknown>, configPath: string): CopyConfigOptions {
  const config: CopyConfigOptions = {};

  if ("outputFolder" in raw && raw["outputFolder"] !== undefined) {
    config.outputFolder = validateString(raw["outputFolder"], "copy.outputFolder", configPath);
  }

  if ("hardlink" in raw && raw["hardlink"] !== undefined) {
    config.hardlink = validateBoolean(raw["hardlink"], "copy.hardlink", configPath);
  }

  if ("force" in raw && raw["force"] !== undefined) {
    config.force = validateBoolean(raw["force"], "copy.force", configPath);
  }

  if ("conflictStrategy" in raw && raw["conflictStrategy"] !== undefined) {
    const conflictStrategy = raw["conflictStrategy"];
    if (
      typeof conflictStrategy !== "string" ||
      !VALID_CONFLICT_STRATEGIES.includes(conflictStrategy as ConflictStrategy)
    ) {
      throw new ConfigError(
        `Invalid conflict strategy for copy.conflictStrategy: ${
          typeof conflictStrategy === "string" ? conflictStrategy : describeType(conflictStrategy)
        }. ` + `Valid strategies: ${VALID_CONFLICT_STRATEGIES.join(", ")}`,
        configPath,
        "copy.conflictStrategy",
      );
    }
    config.conflictStrategy = conflictStrategy as ConflictStrategy;
  }

  if ("convertFormat" in raw && raw["convertFormat"] !== undefined) {
    config.convertFormat = validateConvertFormat(
      raw["convertFormat"],
      "copy.convertFormat",
      configPath,
    );
  }

  if ("workers" in raw && raw["workers"] !== undefined) {
    config.workers = validatePositiveInteger(raw["workers"], "copy.workers", configPath);
  }

  if ("progress" in raw && raw["progress"] !== undefined) {
    config.progress = validateBoolean(raw["progress"], "copy.progress", configPath);
  }

  if ("albumOnly" in raw && raw["albumOnly"] !== undefined) {
    config.albumOnly = validateBoolean(raw["albumOnly"], "copy.albumOnly", configPath);
  }

  if ("preserveStructure" in raw && raw["preserveStructure"] !== undefined) {
    config.preserveStructure = validateBoolean(
      raw["preserveStructure"],
      "copy.preserveStructure",
      configPath,
    );
  }

  if ("albumMode" in raw && raw["albumMode"] !== undefined) {
    config.albumMode = validateBoolean(raw["albumMode"], "copy.albumMode", configPath);
  }

  if ("trackCompleted" in raw && raw["trackCompleted"] !== undefined) {
    config.trackCompleted = validateBoolean(
      raw["trackCompleted"],
      "copy.trackCompleted",
      configPath,
    );
  }

  if ("minStars" in raw && raw["minStars"] !== undefined) {
    config.minStars = validateStarRating(raw["minStars"], "copy.minStars", configPath);
  }

  if ("minRating" in raw && raw["minRating"] !== undefined) {
    config.minRating = validateRatingPercent(raw["minRating"], "copy.minRating", configPath);
  }

  if ("deleteDowngraded" in raw && raw["deleteDowngraded"] !== undefined) {
    config.deleteDowngraded = validateBoolean(
      raw["deleteDowngraded"],
      "copy.deleteDowngraded",
      configPath,
    );
  }

  if ("range" in raw && raw["range"] !== undefined) {
    config.range = validateRangeString(raw["range"], "copy.range", configPath);
  }

  // Metadata filtering options
  if ("minDuration" in raw && raw["minDuration"] !== undefined) {
    config.minDuration = validateNonNegativeInteger(
      raw["minDuration"],
      "copy.minDuration",
      configPath,
    );
  }

  if ("maxDuration" in raw && raw["maxDuration"] !== undefined) {
    config.maxDuration = validatePositiveInteger(
      raw["maxDuration"],
      "copy.maxDuration",
      configPath,
    );
  }

  if ("minBitrate" in raw && raw["minBitrate"] !== undefined) {
    config.minBitrate = validatePositiveInteger(raw["minBitrate"], "copy.minBitrate", configPath);
  }

  if ("codec" in raw && raw["codec"] !== undefined) {
    config.codec = validateString(raw["codec"], "copy.codec", configPath);
  }

  if ("minPlays" in raw && raw["minPlays"] !== undefined) {
    config.minPlays = validateNonNegativeInteger(raw["minPlays"], "copy.minPlays", configPath);
  }

  // Disk space options
  if ("diskSpaceMargin" in raw && raw["diskSpaceMargin"] !== undefined) {
    config.diskSpaceMargin = validateDiskSpaceMargin(
      raw["diskSpaceMargin"],
      "copy.diskSpaceMargin",
      configPath,
    );
  }

  if ("requireDiskSpace" in raw && raw["requireDiskSpace"] !== undefined) {
    config.requireDiskSpace = validateBoolean(
      raw["requireDiskSpace"],
      "copy.requireDiskSpace",
      configPath,
    );
  }

  if ("verify" in raw && raw["verify"] !== undefined) {
    config.verify = validateBoolean(raw["verify"], "copy.verify", configPath);
  }

  return config;
}

/** CopyConfigOptions keys handled by {@link validateCopyConfig}. */
type HandledCopyConfigOptionKey =
  | "outputFolder"
  | "hardlink"
  | "force"
  | "conflictStrategy"
  | "convertFormat"
  | "workers"
  | "progress"
  | "albumOnly"
  | "preserveStructure"
  | "albumMode"
  | "trackCompleted"
  | "minStars"
  | "minRating"
  | "deleteDowngraded"
  | "range"
  | "minDuration"
  | "maxDuration"
  | "minBitrate"
  | "codec"
  | "minPlays"
  | "diskSpaceMargin"
  | "requireDiskSpace"
  | "verify";
type UnhandledCopyConfigOptionKeys = Exclude<keyof CopyConfigOptions, HandledCopyConfigOptionKey>;
const _copyValidatorCoversConfigOptions: UnhandledCopyConfigOptionKeys extends never
  ? true
  : never = true;
void _copyValidatorCoversConfigOptions;

/**
 * Validates CleanConfigOptions.
 */
function validateCleanConfig(raw: Record<string, unknown>, configPath: string): CleanConfigOptions {
  const config: CleanConfigOptions = {};

  if ("force" in raw && raw["force"] !== undefined) {
    config.force = validateBoolean(raw["force"], "clean.force", configPath);
  }

  if ("minFiles" in raw && raw["minFiles"] !== undefined) {
    config.minFiles = validatePositiveInteger(raw["minFiles"], "clean.minFiles", configPath);
  }

  if ("exclude" in raw && raw["exclude"] !== undefined) {
    config.exclude = validateStringArray(raw["exclude"], "clean.exclude", configPath);
  }

  if ("protect" in raw && raw["protect"] !== undefined) {
    config.protect = validateString(raw["protect"], "clean.protect", configPath);
  }

  if ("useTrash" in raw && raw["useTrash"] !== undefined) {
    config.useTrash = validateBoolean(raw["useTrash"], "clean.useTrash", configPath);
  }

  if ("olderThan" in raw && raw["olderThan"] !== undefined) {
    config.olderThan = validatePositiveInteger(raw["olderThan"], "clean.olderThan", configPath);
  }

  if ("depth" in raw && raw["depth"] !== undefined) {
    config.depth = validateNonNegativeInteger(raw["depth"], "clean.depth", configPath);
  }

  return config;
}

/**
 * Validates WatchConfigOptions.
 */
function validateWatchConfig(raw: Record<string, unknown>, configPath: string): WatchConfigOptions {
  const config: WatchConfigOptions = {};

  if ("outputFolder" in raw && raw["outputFolder"] !== undefined) {
    config.outputFolder = validateString(raw["outputFolder"], "watch.outputFolder", configPath);
  }

  if ("hardlink" in raw && raw["hardlink"] !== undefined) {
    config.hardlink = validateBoolean(raw["hardlink"], "watch.hardlink", configPath);
  }

  if ("debounceMs" in raw && raw["debounceMs"] !== undefined) {
    config.debounceMs = validatePositiveInteger(raw["debounceMs"], "watch.debounceMs", configPath);
  }

  if ("albumOnly" in raw && raw["albumOnly"] !== undefined) {
    config.albumOnly = validateBoolean(raw["albumOnly"], "watch.albumOnly", configPath);
  }

  if ("preserveStructure" in raw && raw["preserveStructure"] !== undefined) {
    config.preserveStructure = validateBoolean(
      raw["preserveStructure"],
      "watch.preserveStructure",
      configPath,
    );
  }

  return config;
}

/**
 * Validates GlobalConfigOptions.
 */
function validateGlobalConfig(
  raw: Record<string, unknown>,
  configPath: string,
): GlobalConfigOptions {
  const config: GlobalConfigOptions = {};

  if ("debug" in raw && raw["debug"] !== undefined) {
    config.debug = validateBoolean(raw["debug"], "global.debug", configPath);
  }

  return config;
}

/**
 * Validates a PlexLibraryMapping object.
 *
 * @param value - The value to validate
 * @param index - Index in the libraries array (for error messages)
 * @param configPath - Path to the config file (for error messages)
 * @returns The validated mapping
 * @throws ConfigError if validation fails
 */
function validatePlexLibraryMapping(
  value: unknown,
  index: number,
  configPath: string,
): PlexLibraryMapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `Expected object for plex.libraries[${index}], got ${describeType(value)}`,
      configPath,
      `plex.libraries[${index}]`,
    );
  }

  const obj = value as Record<string, unknown>;

  // Validate required 'path' field
  if (!("path" in obj) || obj["path"] === undefined) {
    throw new ConfigError(
      `Missing required field 'path' in plex.libraries[${index}]`,
      configPath,
      `plex.libraries[${index}].path`,
    );
  }
  if (typeof obj["path"] !== "string" || obj["path"].trim() === "") {
    throw new ConfigError(
      `Expected non-empty string for plex.libraries[${index}].path, got ${describeType(obj["path"])}`,
      configPath,
      `plex.libraries[${index}].path`,
    );
  }

  // Validate required 'library' field
  if (!("library" in obj) || obj["library"] === undefined) {
    throw new ConfigError(
      `Missing required field 'library' in plex.libraries[${index}]`,
      configPath,
      `plex.libraries[${index}].library`,
    );
  }
  if (typeof obj["library"] !== "string" || obj["library"].trim() === "") {
    throw new ConfigError(
      `Expected non-empty string for plex.libraries[${index}].library, got ${describeType(obj["library"])}`,
      configPath,
      `plex.libraries[${index}].library`,
    );
  }

  return {
    path: obj["path"],
    library: obj["library"],
  };
}

/**
 * Valid values for plex.syncDefaults.prefer
 */
const VALID_SYNC_PREFER_VALUES = ["plex", "file"] as const;

/**
 * Valid values for plex.syncDefaults.vorbisScale
 */
const VALID_VORBIS_SCALE_VALUES = ["normalized", "stars", "percent"] as const;

/**
 * Validates PlexSyncDefaults configuration.
 *
 * @param raw - Raw sync defaults object to validate
 * @param configPath - Path to the config file (for error messages)
 * @returns Validated PlexSyncDefaults
 * @throws ConfigError if validation fails
 */
function validatePlexSyncDefaults(
  raw: Record<string, unknown>,
  configPath: string,
): PlexSyncDefaults {
  const syncDefaults: PlexSyncDefaults = {};

  if ("prefer" in raw && raw["prefer"] !== undefined) {
    const prefer = raw["prefer"];
    if (
      typeof prefer !== "string" ||
      !VALID_SYNC_PREFER_VALUES.includes(prefer as "plex" | "file")
    ) {
      throw new ConfigError(
        `Invalid plex.syncDefaults.prefer: ${prefer}. Must be 'plex' or 'file'.`,
        configPath,
        "plex.syncDefaults.prefer",
      );
    }
    syncDefaults.prefer = prefer as "plex" | "file";
  }

  if ("onlyRated" in raw && raw["onlyRated"] !== undefined) {
    syncDefaults.onlyRated = validateBoolean(
      raw["onlyRated"],
      "plex.syncDefaults.onlyRated",
      configPath,
    );
  }

  if ("popmEmail" in raw && raw["popmEmail"] !== undefined) {
    syncDefaults.popmEmail = validateString(
      raw["popmEmail"],
      "plex.syncDefaults.popmEmail",
      configPath,
    );
  }

  if ("vorbisScale" in raw && raw["vorbisScale"] !== undefined) {
    const vorbisScale = raw["vorbisScale"];
    if (
      typeof vorbisScale !== "string" ||
      !VALID_VORBIS_SCALE_VALUES.includes(vorbisScale as "normalized" | "stars" | "percent")
    ) {
      throw new ConfigError(
        `Invalid plex.syncDefaults.vorbisScale: ${vorbisScale}. Must be 'normalized', 'stars', or 'percent'.`,
        configPath,
        "plex.syncDefaults.vorbisScale",
      );
    }
    syncDefaults.vorbisScale = vorbisScale as "normalized" | "stars" | "percent";
  }

  return syncDefaults;
}

/**
 * Validates PlexSyncOnCopyDefaults configuration.
 *
 * @param raw - Raw sync-on-copy defaults object to validate
 * @param configPath - Path to the config file (for error messages)
 * @returns Validated PlexSyncOnCopyDefaults
 * @throws ConfigError if validation fails
 */
function validatePlexSyncOnCopyDefaults(
  raw: Record<string, unknown>,
  configPath: string,
): PlexSyncOnCopyDefaults {
  const syncOnCopyDefaults: PlexSyncOnCopyDefaults = {};

  if ("popmEmail" in raw && raw["popmEmail"] !== undefined) {
    syncOnCopyDefaults.popmEmail = validateString(
      raw["popmEmail"],
      "plex.syncOnCopyDefaults.popmEmail",
      configPath,
    );
  }

  if ("vorbisScale" in raw && raw["vorbisScale"] !== undefined) {
    const vorbisScale = raw["vorbisScale"];
    const propertyPath = "plex.syncOnCopyDefaults.vorbisScale";
    if (
      typeof vorbisScale !== "string" ||
      !VALID_VORBIS_SCALE_VALUES.includes(vorbisScale as "normalized" | "stars" | "percent")
    ) {
      const messagePrefix = `Invalid ${propertyPath}: ${vorbisScale}.`;
      const message = `${messagePrefix} Must be 'normalized', 'stars', or 'percent'.`;
      throw new ConfigError(message, configPath, propertyPath);
    }
    syncOnCopyDefaults.vorbisScale = vorbisScale as "normalized" | "stars" | "percent";
  }

  return syncOnCopyDefaults;
}

/**
 * Validates PlexDefaultFilters configuration.
 *
 * @param raw - Raw default filters object to validate
 * @param configPath - Path to the config file (for error messages)
 * @returns Validated PlexDefaultFilters
 * @throws ConfigError if validation fails
 */
function validatePlexDefaultFilters(
  raw: Record<string, unknown>,
  configPath: string,
): PlexDefaultFilters {
  const filters: PlexDefaultFilters = {};

  if ("minRating" in raw && raw["minRating"] !== undefined) {
    filters.minRating = validateStarRating(
      raw["minRating"],
      "plex.defaultFilters.minRating",
      configPath,
    );
  }

  if ("genre" in raw && raw["genre"] !== undefined) {
    const genre = raw["genre"];
    if (typeof genre !== "string" || genre.trim() === "") {
      throw new ConfigError(
        `Expected non-empty string for plex.defaultFilters.genre, got ${describeType(genre)}`,
        configPath,
        "plex.defaultFilters.genre",
      );
    }
    filters.genre = genre;
  }

  if ("minPlays" in raw && raw["minPlays"] !== undefined) {
    filters.minPlays = validateNonNegativeInteger(
      raw["minPlays"],
      "plex.defaultFilters.minPlays",
      configPath,
    );
  }

  if ("excludeGenres" in raw && raw["excludeGenres"] !== undefined) {
    filters.excludeGenres = validateStringArray(
      raw["excludeGenres"],
      "plex.defaultFilters.excludeGenres",
      configPath,
    );
  }

  return filters;
}

/**
 * Validates PlexPlaylistDefaults configuration.
 *
 * @param raw - Raw playlist defaults object to validate
 * @param configPath - Path to the config file (for error messages)
 * @returns Validated PlexPlaylistDefaults
 * @throws ConfigError if validation fails
 */
function validatePlexPlaylistDefaults(
  raw: Record<string, unknown>,
  configPath: string,
): PlexPlaylistDefaults {
  const playlistDefaults: PlexPlaylistDefaults = {};

  if ("smart" in raw && raw["smart"] !== undefined) {
    playlistDefaults.smart = validateBoolean(
      raw["smart"],
      "plex.playlistDefaults.smart",
      configPath,
    );
  }

  if ("updateExisting" in raw && raw["updateExisting"] !== undefined) {
    playlistDefaults.updateExisting = validateBoolean(
      raw["updateExisting"],
      "plex.playlistDefaults.updateExisting",
      configPath,
    );
  }

  return playlistDefaults;
}

/**
 * Validates PlexCacheConfig configuration.
 *
 * @param raw - Raw cache config object to validate
 * @param configPath - Path to the config file (for error messages)
 * @returns Validated PlexCacheConfig
 * @throws ConfigError if validation fails
 */
function validatePlexCacheConfig(
  raw: Record<string, unknown>,
  configPath: string,
): PlexCacheConfig {
  const cache: PlexCacheConfig = {};

  if ("enabled" in raw && raw["enabled"] !== undefined) {
    cache.enabled = validateBoolean(raw["enabled"], "plex.cache.enabled", configPath);
  }

  if ("ttlSeconds" in raw && raw["ttlSeconds"] !== undefined) {
    cache.ttlSeconds = validatePositiveInteger(
      raw["ttlSeconds"],
      "plex.cache.ttlSeconds",
      configPath,
    );
  }

  return cache;
}

/**
 * Valid `plex.auth.mode` values (issue #251).
 * `"static"` is the default and preserves the pre-#251 credential behaviour.
 */
const VALID_PLEX_AUTH_MODES = ["static", "jwt"] as const;

/**
 * Lower bound for `plex.auth.refreshMarginSeconds`. Below one minute the
 * proactive refresh window is smaller than the clock-skew tolerance.
 */
const MIN_PLEX_AUTH_REFRESH_MARGIN_SECONDS = 60;

/**
 * Upper bound for `plex.auth.refreshMarginSeconds` (24 hours). A larger margin
 * would refresh on every invocation against an IP-scoped rate-limit budget.
 */
const MAX_PLEX_AUTH_REFRESH_MARGIN_SECONDS = 86_400;

/**
 * Default proactive refresh margin in seconds for an enrolled Plex credential
 * (issue #251).
 *
 * Applied at the consumption site, never written back into the validated config
 * — the same convention as `lidarr.resilience.retryBackoffCapMs`. Exported so
 * the adapter resolver and the config validator share one source of truth.
 */
export const PLEX_AUTH_DEFAULT_REFRESH_MARGIN_SECONDS = 300;

/**
 * Validates the `plex.auth` credential-source policy block (issue #251).
 *
 * Unknown keys are ignored, matching every other `plex.*` sub-validator.
 * Defaults are NOT written into the returned object; `refreshMarginSeconds`
 * falls back to {@link PLEX_AUTH_DEFAULT_REFRESH_MARGIN_SECONDS} where it is
 * consumed.
 *
 * @param raw - Raw `plex.auth` object to validate
 * @param configPath - Path to the config file (for error messages)
 * @returns Validated Plex credential-source policy
 * @throws {ConfigError} When a field fails type or range validation
 */
function validatePlexAuthConfigOptions(
  raw: Record<string, unknown>,
  configPath: string,
): PlexAuthConfigOptions {
  const auth: PlexAuthConfigOptions = {};

  if ("mode" in raw && raw["mode"] !== undefined) {
    const mode = raw["mode"];
    if (typeof mode !== "string" || !VALID_PLEX_AUTH_MODES.includes(mode as "static" | "jwt")) {
      throw new ConfigError(
        `Invalid credential mode for plex.auth.mode: ${String(mode)}. ` +
          `Valid modes: ${VALID_PLEX_AUTH_MODES.join(", ")}`,
        configPath,
        "plex.auth.mode",
      );
    }
    auth.mode = mode as "static" | "jwt";
  }

  if ("storePath" in raw && raw["storePath"] !== undefined) {
    auth.storePath = expandPath(
      validateString(raw["storePath"], "plex.auth.storePath", configPath),
    );
  }

  if ("deviceName" in raw && raw["deviceName"] !== undefined) {
    auth.deviceName = validateString(raw["deviceName"], "plex.auth.deviceName", configPath);
  }

  if ("refreshMarginSeconds" in raw && raw["refreshMarginSeconds"] !== undefined) {
    auth.refreshMarginSeconds = validateBoundedInteger(
      raw["refreshMarginSeconds"],
      MIN_PLEX_AUTH_REFRESH_MARGIN_SECONDS,
      MAX_PLEX_AUTH_REFRESH_MARGIN_SECONDS,
      "plex.auth.refreshMarginSeconds",
      configPath,
    );
  }

  return auth;
}

/**
 * Validates PlexConfigOptions.
 */
function validatePlexConfigOptions(
  raw: Record<string, unknown>,
  configPath: string,
): PlexConfigOptions {
  const config: PlexConfigOptions = {};

  if ("url" in raw && raw["url"] !== undefined) {
    config.url = validateUrl(raw["url"], "plex.url", configPath);
  }

  if ("token" in raw && raw["token"] !== undefined) {
    config.token = validateString(raw["token"], "plex.token", configPath);
  }

  if ("scanAfterCopy" in raw && raw["scanAfterCopy"] !== undefined) {
    config.scanAfterCopy = validateBoolean(raw["scanAfterCopy"], "plex.scanAfterCopy", configPath);
  }

  if ("libraryName" in raw && raw["libraryName"] !== undefined) {
    config.libraryName = validateString(raw["libraryName"], "plex.libraryName", configPath);
  }

  if ("scanPerSource" in raw && raw["scanPerSource"] !== undefined) {
    config.scanPerSource = validateBoolean(raw["scanPerSource"], "plex.scanPerSource", configPath);
  }

  if ("libraries" in raw && raw["libraries"] !== undefined) {
    const libraries = raw["libraries"];
    if (!Array.isArray(libraries)) {
      throw new ConfigError(
        `Expected array for plex.libraries, got ${describeType(libraries)}`,
        configPath,
        "plex.libraries",
      );
    }
    config.libraries = libraries.map((item, index) =>
      validatePlexLibraryMapping(item, index, configPath),
    );
  }

  if ("pageSize" in raw && raw["pageSize"] !== undefined) {
    config.pageSize = validateBoundedInteger(
      raw["pageSize"],
      1,
      MEDIA_IDENTITY_MAX_PAGE_SIZE,
      "plex.pageSize",
      configPath,
    );
  }

  // Validate plex.syncDefaults if present
  if ("syncDefaults" in raw && raw["syncDefaults"] !== undefined) {
    const syncDefaultsRaw = raw["syncDefaults"];
    if (
      typeof syncDefaultsRaw !== "object" ||
      syncDefaultsRaw === null ||
      Array.isArray(syncDefaultsRaw)
    ) {
      throw new ConfigError(
        `Expected object for plex.syncDefaults, got ${describeType(syncDefaultsRaw)}`,
        configPath,
        "plex.syncDefaults",
      );
    }
    config.syncDefaults = validatePlexSyncDefaults(
      syncDefaultsRaw as Record<string, unknown>,
      configPath,
    );
  }

  // Validate plex.defaultFilters if present
  if ("defaultFilters" in raw && raw["defaultFilters"] !== undefined) {
    const defaultFiltersRaw = raw["defaultFilters"];
    if (
      typeof defaultFiltersRaw !== "object" ||
      defaultFiltersRaw === null ||
      Array.isArray(defaultFiltersRaw)
    ) {
      throw new ConfigError(
        `Expected object for plex.defaultFilters, got ${describeType(defaultFiltersRaw)}`,
        configPath,
        "plex.defaultFilters",
      );
    }
    config.defaultFilters = validatePlexDefaultFilters(
      defaultFiltersRaw as Record<string, unknown>,
      configPath,
    );
  }

  // Validate plex.playlistDefaults if present
  if ("playlistDefaults" in raw && raw["playlistDefaults"] !== undefined) {
    const playlistDefaultsRaw = raw["playlistDefaults"];
    if (
      typeof playlistDefaultsRaw !== "object" ||
      playlistDefaultsRaw === null ||
      Array.isArray(playlistDefaultsRaw)
    ) {
      throw new ConfigError(
        `Expected object for plex.playlistDefaults, got ${describeType(playlistDefaultsRaw)}`,
        configPath,
        "plex.playlistDefaults",
      );
    }
    config.playlistDefaults = validatePlexPlaylistDefaults(
      playlistDefaultsRaw as Record<string, unknown>,
      configPath,
    );
  }

  // Validate plex.cache if present
  if ("cache" in raw && raw["cache"] !== undefined) {
    const cacheRaw = raw["cache"];
    if (typeof cacheRaw !== "object" || cacheRaw === null || Array.isArray(cacheRaw)) {
      throw new ConfigError(
        `Expected object for plex.cache, got ${describeType(cacheRaw)}`,
        configPath,
        "plex.cache",
      );
    }
    config.cache = validatePlexCacheConfig(cacheRaw as Record<string, unknown>, configPath);
  }

  if ("syncRatingsOnCopy" in raw && raw["syncRatingsOnCopy"] !== undefined) {
    config.syncRatingsOnCopy = validateBoolean(
      raw["syncRatingsOnCopy"],
      "plex.syncRatingsOnCopy",
      configPath,
    );
  }

  if ("syncOnCopyDefaults" in raw && raw["syncOnCopyDefaults"] !== undefined) {
    const syncOnCopyDefaultsRaw = raw["syncOnCopyDefaults"];
    if (
      typeof syncOnCopyDefaultsRaw !== "object" ||
      syncOnCopyDefaultsRaw === null ||
      Array.isArray(syncOnCopyDefaultsRaw)
    ) {
      const valueType = describeType(syncOnCopyDefaultsRaw);
      const message = `Expected object for plex.syncOnCopyDefaults, got ${valueType}`;
      throw new ConfigError(message, configPath, "plex.syncOnCopyDefaults");
    }
    config.syncOnCopyDefaults = validatePlexSyncOnCopyDefaults(
      syncOnCopyDefaultsRaw as Record<string, unknown>,
      configPath,
    );
  }

  // Validate plex.auth if present. Mandatory branch: without it the whole block
  // would be silently dropped from the loaded config (issue #251).
  if ("auth" in raw && raw["auth"] !== undefined) {
    const authRaw = raw["auth"];
    if (typeof authRaw !== "object" || authRaw === null || Array.isArray(authRaw)) {
      throw new ConfigError(
        `Expected object for plex.auth, got ${describeType(authRaw)}`,
        configPath,
        "plex.auth",
      );
    }
    config.auth = validatePlexAuthConfigOptions(authRaw as Record<string, unknown>, configPath);
  }

  // Validate plex.allowedLibraryRoots if present
  if ("allowedLibraryRoots" in raw && raw["allowedLibraryRoots"] !== undefined) {
    const allowedRoots = raw["allowedLibraryRoots"];
    if (!Array.isArray(allowedRoots)) {
      throw new ConfigError(
        `Expected array for plex.allowedLibraryRoots, got ${describeType(allowedRoots)}`,
        configPath,
        "plex.allowedLibraryRoots",
      );
    }
    // Validate each entry is a non-empty string
    config.allowedLibraryRoots = allowedRoots.map((root, index) => {
      if (typeof root !== "string" || root.trim() === "") {
        throw new ConfigError(
          `Expected non-empty string at plex.allowedLibraryRoots[${index}], got ${describeType(root)}`,
          configPath,
          `plex.allowedLibraryRoots[${index}]`,
        );
      }
      return root;
    });
  }

  return config;
}

/** PlexConfigOptions keys handled by {@link validatePlexConfigOptions}. */
type HandledPlexConfigOptionKey =
  | "url"
  | "token"
  | "scanAfterCopy"
  | "libraryName"
  | "scanPerSource"
  | "libraries"
  | "pageSize"
  | "defaultFilters"
  | "allowedLibraryRoots"
  | "syncDefaults"
  | "playlistDefaults"
  | "cache"
  | "syncRatingsOnCopy"
  | "syncOnCopyDefaults"
  | "auth";
type UnhandledPlexConfigOptionKeys = Exclude<keyof PlexConfigOptions, HandledPlexConfigOptionKey>;
const _plexValidatorCoversConfigOptions: UnhandledPlexConfigOptionKeys extends never
  ? true
  : never = true;
void _plexValidatorCoversConfigOptions;

/**
 * Validates LidarrResilienceConfigOptions from the raw `lidarr.resilience`
 * config section. Unknown keys are silently dropped; defaults are applied at
 * the consumption site, never written into config.
 *
 * @param raw - Raw resilience config object to validate
 * @param configPath - Path to the config file (for error messages)
 * @returns Validated Lidarr resilience configuration options
 * @throws {ConfigError} When a field fails type or range validation
 */
function validateLidarrResilienceConfig(
  raw: Record<string, unknown>,
  configPath: string,
): LidarrResilienceConfigOptions {
  const resilience: LidarrResilienceConfigOptions = {};

  if ("failureThreshold" in raw && raw["failureThreshold"] !== undefined) {
    resilience.failureThreshold = validatePositiveInteger(
      raw["failureThreshold"],
      "lidarr.resilience.failureThreshold",
      configPath,
    );
  }

  if ("failureWindowSeconds" in raw && raw["failureWindowSeconds"] !== undefined) {
    resilience.failureWindowSeconds = validatePositiveInteger(
      raw["failureWindowSeconds"],
      "lidarr.resilience.failureWindowSeconds",
      configPath,
    );
  }

  if ("cooldownSeconds" in raw && raw["cooldownSeconds"] !== undefined) {
    resilience.cooldownSeconds = validatePositiveInteger(
      raw["cooldownSeconds"],
      "lidarr.resilience.cooldownSeconds",
      configPath,
    );
  }

  if ("retryAttempts" in raw && raw["retryAttempts"] !== undefined) {
    resilience.retryAttempts = validateNonNegativeInteger(
      raw["retryAttempts"],
      "lidarr.resilience.retryAttempts",
      configPath,
    );
  }

  if ("retryBackoffCapMs" in raw && raw["retryBackoffCapMs"] !== undefined) {
    resilience.retryBackoffCapMs = validatePositiveInteger(
      raw["retryBackoffCapMs"],
      "lidarr.resilience.retryBackoffCapMs",
      configPath,
    );
  }

  if ("cacheTtlSeconds" in raw && raw["cacheTtlSeconds"] !== undefined) {
    resilience.cacheTtlSeconds = validateNonNegativeInteger(
      raw["cacheTtlSeconds"],
      "lidarr.resilience.cacheTtlSeconds",
      configPath,
    );
  }

  if ("cacheStaleMaxAgeSeconds" in raw && raw["cacheStaleMaxAgeSeconds"] !== undefined) {
    resilience.cacheStaleMaxAgeSeconds = validatePositiveInteger(
      raw["cacheStaleMaxAgeSeconds"],
      "lidarr.resilience.cacheStaleMaxAgeSeconds",
      configPath,
    );
  }

  if ("deferredMaxAttempts" in raw && raw["deferredMaxAttempts"] !== undefined) {
    resilience.deferredMaxAttempts = validatePositiveInteger(
      raw["deferredMaxAttempts"],
      "lidarr.resilience.deferredMaxAttempts",
      configPath,
    );
  }

  return resilience;
}

const LIDARR_SCHEDULER_LANES = [
  "local-only",
  "metadata-dependent",
  "discovery",
  "destructive",
] as const;

/** Validates one `lidarr.scheduler.lanes.<lane>` override object. */
function validateLidarrSchedulerLaneConfig(
  raw: Record<string, unknown>,
  propertyPath: string,
  configPath: string,
): LidarrSchedulerLaneConfigOptions {
  const lane: LidarrSchedulerLaneConfigOptions = {};

  if ("concurrency" in raw && raw["concurrency"] !== undefined) {
    lane.concurrency = validateBoundedInteger(
      raw["concurrency"],
      1,
      32,
      `${propertyPath}.concurrency`,
      configPath,
    );
  }
  if ("operationBudget" in raw && raw["operationBudget"] !== undefined) {
    lane.operationBudget = validateBoundedInteger(
      raw["operationBudget"],
      1,
      10_000,
      `${propertyPath}.operationBudget`,
      configPath,
    );
  }
  if ("retryAttempts" in raw && raw["retryAttempts"] !== undefined) {
    lane.retryAttempts = validateBoundedInteger(
      raw["retryAttempts"],
      0,
      10,
      `${propertyPath}.retryAttempts`,
      configPath,
    );
  }
  if ("retryBackoffCapMs" in raw && raw["retryBackoffCapMs"] !== undefined) {
    lane.retryBackoffCapMs = validateBoundedInteger(
      raw["retryBackoffCapMs"],
      1,
      300_000,
      `${propertyPath}.retryBackoffCapMs`,
      configPath,
    );
  }

  return lane;
}

/** Validates the optional `lidarr.scheduler` config section. */
function validateLidarrSchedulerConfig(
  raw: Record<string, unknown>,
  configPath: string,
): LidarrSchedulerConfigOptions {
  const scheduler: LidarrSchedulerConfigOptions = {};
  if (!("lanes" in raw) || raw["lanes"] === undefined) {
    return scheduler;
  }

  const lanesRaw = raw["lanes"];
  if (typeof lanesRaw !== "object" || lanesRaw === null || Array.isArray(lanesRaw)) {
    throw new ConfigError(
      `Expected object for lidarr.scheduler.lanes, got ${describeType(lanesRaw)}`,
      configPath,
      "lidarr.scheduler.lanes",
    );
  }

  const laneRecord = lanesRaw as Record<string, unknown>;
  const lanes: NonNullable<LidarrSchedulerConfigOptions["lanes"]> = {};
  for (const laneName of LIDARR_SCHEDULER_LANES) {
    const laneRaw = laneRecord[laneName];
    if (laneRaw === undefined) {
      continue;
    }
    const propertyPath = `lidarr.scheduler.lanes.${laneName}`;
    if (typeof laneRaw !== "object" || laneRaw === null || Array.isArray(laneRaw)) {
      throw new ConfigError(
        `Expected object for ${propertyPath}, got ${describeType(laneRaw)}`,
        configPath,
        propertyPath,
      );
    }
    lanes[laneName] = validateLidarrSchedulerLaneConfig(
      laneRaw as Record<string, unknown>,
      propertyPath,
      configPath,
    );
  }
  scheduler.lanes = lanes;
  return scheduler;
}

const LIDARR_CASCADE_ANALYSIS_MAX_VALUE = 1_000_000;
const LIDARR_CASCADE_ANALYSIS_KEYS = new Set(["budgets", "assumptions"]);
const LIDARR_CASCADE_BUDGET_KEYS = new Set(["indexerQueries", "acquisitionCandidates"]);
const LIDARR_CASCADE_ASSUMPTION_KEYS = new Set(["albumsPerArtist", "indexerQueriesPerCandidate"]);

function validateLidarrCascadeNumericSection(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  propertyPath: string,
  configPath: string,
): Readonly<Record<string, number>> {
  const raw = requireConfigObject(value, propertyPath, configPath);
  rejectUnknownConfigKeys(raw, allowedKeys, propertyPath, configPath);
  const section: Record<string, number> = {};
  for (const [key, field] of Object.entries(raw)) {
    if (field === undefined) continue;
    section[key] = validateBoundedInteger(
      field,
      1,
      LIDARR_CASCADE_ANALYSIS_MAX_VALUE,
      `${propertyPath}.${key}`,
      configPath,
    );
  }
  return section;
}

function validateLidarrCascadeAnalysisConfig(
  value: unknown,
  configPath: string,
): LidarrCascadeAnalysisConfigOptions {
  const propertyPath = "lidarr.cascadeAnalysis";
  const raw = requireConfigObject(value, propertyPath, configPath);
  rejectUnknownConfigKeys(raw, LIDARR_CASCADE_ANALYSIS_KEYS, propertyPath, configPath);
  const budgets =
    "budgets" in raw && raw["budgets"] !== undefined
      ? validateLidarrCascadeNumericSection(
          raw["budgets"],
          LIDARR_CASCADE_BUDGET_KEYS,
          `${propertyPath}.budgets`,
          configPath,
        )
      : undefined;
  const assumptions =
    "assumptions" in raw && raw["assumptions"] !== undefined
      ? validateLidarrCascadeNumericSection(
          raw["assumptions"],
          LIDARR_CASCADE_ASSUMPTION_KEYS,
          `${propertyPath}.assumptions`,
          configPath,
        )
      : undefined;
  return {
    ...(budgets === undefined ? {} : { budgets }),
    ...(assumptions === undefined ? {} : { assumptions }),
  };
}

const LIDARR_PRESET_MAX_PACKS = 32;
const LIDARR_PRESET_MAX_RESOURCES = 100;
const LIDARR_PRESET_MAX_SPECIFICATIONS = 100;
const LIDARR_PRESET_MAX_FIELDS = 100;
const LIDARR_PRESET_MAX_QUALITY_DEPTH = 10;
const LIDARR_PRESET_MAX_QUALITY_NODES = 500;
const LIDARR_PRESET_MAX_LIST_ITEMS = 100;
const LIDARR_PRESET_MAX_STRING_BYTES = 2_048;
const LIDARR_PRESET_MAX_EXPANDED_BYTES = 1024 * 1024;
const LIDARR_PRESET_MIN_SCORE = -10_000;
const LIDARR_PRESET_MAX_SCORE = 10_000;
const LIDARR_PRESET_MAX_FIELD_NUMBER = 1_000_000_000;

const LIDARR_BUILTIN_PRESET_IDS = new Set(["balanced", "lossless", "space-saver"]);
const LIDARR_PRESET_CAPABILITIES = new Set<LidarrPresetCapability>([
  "custom-format-schema",
  "custom-format-create",
  "custom-format-update",
  "quality-profile-schema",
  "quality-profile-create",
  "quality-profile-update",
  "naming-read",
  "naming-examples",
  "naming-update",
]);
const LIDARR_PRESET_IMPLEMENTATIONS = new Set<LidarrPresetCustomFormatImplementation>([
  "ReleaseTitleSpecification",
  "ReleaseGroupSpecification",
  "IndexerFlagSpecification",
  "SizeSpecification",
]);
const LIDARR_PRESET_UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const LIDARR_PRESET_SENSITIVE_KEY =
  /(?:__proto__|prototype|constructor|token|password|apikey|secret)/iu;

interface LidarrPresetValidationContext {
  readonly seen: WeakSet<object>;
  expandedBytes: number;
  qualityNodes: number;
}

function failLidarrPreset(message: string, propertyPath: string, configPath: string): never {
  throw new ConfigError(message, configPath, propertyPath);
}

function trackLidarrPresetValue(
  value: object,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
): void {
  if (context.seen.has(value)) {
    failLidarrPreset(
      `Aliases or cycles are not allowed at ${propertyPath}`,
      propertyPath,
      configPath,
    );
  }
  context.seen.add(value);
  context.expandedBytes += Array.isArray(value)
    ? value.length + 2
    : Object.keys(value).reduce((bytes, key) => bytes + Buffer.byteLength(key, "utf8") + 4, 2);
  if (context.expandedBytes > LIDARR_PRESET_MAX_EXPANDED_BYTES) {
    failLidarrPreset(
      `Expanded preset data exceeds ${LIDARR_PRESET_MAX_EXPANDED_BYTES} bytes`,
      propertyPath,
      configPath,
    );
  }
}

function requireLidarrPresetObject(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failLidarrPreset(
      `Expected object for ${propertyPath}, got ${describeType(value)}`,
      propertyPath,
      configPath,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failLidarrPreset(`Unsafe object prototype at ${propertyPath}`, propertyPath, configPath);
  }
  trackLidarrPresetValue(value, propertyPath, configPath, context);
  return value as Record<string, unknown>;
}

function requireLidarrPresetArray(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
  maximum = LIDARR_PRESET_MAX_LIST_ITEMS,
  minimum = 0,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    failLidarrPreset(
      `Expected array with ${minimum}-${maximum} items for ${propertyPath}`,
      propertyPath,
      configPath,
    );
  }
  trackLidarrPresetValue(value, propertyPath, configPath, context);
  return value;
}

function requireLidarrPresetKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  propertyPath: string,
  configPath: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    const keyPath = `${propertyPath}.${key}`;
    if (LIDARR_PRESET_SENSITIVE_KEY.test(key) || !allowedSet.has(key)) {
      failLidarrPreset(`Unknown or unsafe property ${keyPath}`, keyPath, configPath);
    }
  }
  for (const key of required) {
    if (!(key in raw) || raw[key] === undefined) {
      const keyPath = `${propertyPath}.${key}`;
      failLidarrPreset(`Missing required property ${keyPath}`, keyPath, configPath);
    }
  }
}

function requireLidarrPresetString(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
  maximumBytes = LIDARR_PRESET_MAX_STRING_BYTES,
): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    LIDARR_PRESET_UNSAFE_TEXT.test(value)
  ) {
    failLidarrPreset(
      `Expected non-empty terminal-safe string up to ${maximumBytes} bytes for ${propertyPath}`,
      propertyPath,
      configPath,
    );
  }
  context.expandedBytes += Buffer.byteLength(value, "utf8");
  if (context.expandedBytes > LIDARR_PRESET_MAX_EXPANDED_BYTES) {
    failLidarrPreset(
      `Expanded preset data exceeds ${LIDARR_PRESET_MAX_EXPANDED_BYTES} bytes`,
      propertyPath,
      configPath,
    );
  }
  return value;
}

function requireLidarrPresetBoolean(
  value: unknown,
  propertyPath: string,
  configPath: string,
): boolean {
  if (typeof value !== "boolean") {
    failLidarrPreset(
      `Expected boolean for ${propertyPath}, got ${describeType(value)}`,
      propertyPath,
      configPath,
    );
  }
  return value;
}

function requireLidarrPresetInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  propertyPath: string,
  configPath: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    failLidarrPreset(
      `Expected safe integer between ${minimum} and ${maximum} for ${propertyPath}`,
      propertyPath,
      configPath,
    );
  }
  return value;
}

function normalizedLidarrPresetName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function assertUniqueLidarrPresetNames(
  values: readonly string[],
  propertyPath: string,
  configPath: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const normalized = normalizedLidarrPresetName(value);
    if (seen.has(normalized)) {
      failLidarrPreset(
        `Duplicate normalized name at ${propertyPath}[${index}]`,
        `${propertyPath}[${index}]`,
        configPath,
      );
    }
    seen.add(normalized);
  }
}

function validateLidarrPresetStringList(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
): readonly string[] {
  const raw = requireLidarrPresetArray(value, propertyPath, configPath, context, 100, 1);
  return raw.map((entry, index) =>
    requireLidarrPresetString(entry, `${propertyPath}[${index}]`, configPath, context),
  );
}

function validateLidarrPresetCapabilities(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
): readonly LidarrPresetCapability[] {
  const raw = requireLidarrPresetArray(value, propertyPath, configPath, context, 9, 1);
  const capabilities = raw.map((entry, index) => {
    const path = `${propertyPath}[${index}]`;
    const capability = requireLidarrPresetString(entry, path, configPath, context);
    if (!LIDARR_PRESET_CAPABILITIES.has(capability as LidarrPresetCapability)) {
      failLidarrPreset(`Unsupported capability at ${path}`, path, configPath);
    }
    return capability as LidarrPresetCapability;
  });
  assertUniqueLidarrPresetNames(capabilities, propertyPath, configPath);
  return capabilities;
}

function validateLidarrPresetRegex(value: string, propertyPath: string, configPath: string): void {
  if (
    /\\(?:[1-9]|k<)/u.test(value) ||
    /\(\?<[=!]/u.test(value) ||
    /\([^)]*[+*][^)]*\)(?:[+*]|\{\d)/u.test(value)
  ) {
    failLidarrPreset(`Unsafe regular expression at ${propertyPath}`, propertyPath, configPath);
  }
  try {
    new RegExp(value);
  } catch {
    failLidarrPreset(`Invalid regular expression at ${propertyPath}`, propertyPath, configPath);
  }
}

function validateLidarrPresetSpecification(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
): LidarrPresetCustomFormatSpecification {
  const raw = requireLidarrPresetObject(value, propertyPath, configPath, context);
  requireLidarrPresetKeys(
    raw,
    ["name", "implementation", "negate", "required", "fields"],
    ["name", "implementation", "negate", "required", "fields"],
    propertyPath,
    configPath,
  );
  const name = requireLidarrPresetString(raw["name"], `${propertyPath}.name`, configPath, context);
  const implementation = requireLidarrPresetString(
    raw["implementation"],
    `${propertyPath}.implementation`,
    configPath,
    context,
  );
  if (
    !LIDARR_PRESET_IMPLEMENTATIONS.has(implementation as LidarrPresetCustomFormatImplementation)
  ) {
    failLidarrPreset(
      `Unsupported custom-format implementation at ${propertyPath}.implementation`,
      `${propertyPath}.implementation`,
      configPath,
    );
  }
  const fieldsRaw = requireLidarrPresetObject(
    raw["fields"],
    `${propertyPath}.fields`,
    configPath,
    context,
  );
  const fieldEntries = Object.entries(fieldsRaw);
  if (fieldEntries.length === 0 || fieldEntries.length > LIDARR_PRESET_MAX_FIELDS) {
    failLidarrPreset(
      `Expected 1-${LIDARR_PRESET_MAX_FIELDS} fields for ${propertyPath}.fields`,
      `${propertyPath}.fields`,
      configPath,
    );
  }
  const fields: Record<string, LidarrPresetFieldValue> = {};
  for (const [fieldName, fieldValue] of fieldEntries) {
    const fieldPath = `${propertyPath}.fields.${fieldName}`;
    if (LIDARR_PRESET_SENSITIVE_KEY.test(fieldName)) {
      failLidarrPreset(`Unsafe field name at ${fieldPath}`, fieldPath, configPath);
    }
    if (typeof fieldValue === "string") {
      const validated = requireLidarrPresetString(fieldValue, fieldPath, configPath, context);
      if (
        (implementation === "ReleaseTitleSpecification" ||
          implementation === "ReleaseGroupSpecification") &&
        fieldName === "value"
      ) {
        validateLidarrPresetRegex(validated, fieldPath, configPath);
      }
      fields[fieldName] = validated;
    } else if (typeof fieldValue === "number") {
      if (!Number.isFinite(fieldValue) || Math.abs(fieldValue) > LIDARR_PRESET_MAX_FIELD_NUMBER) {
        failLidarrPreset(`Out-of-range number at ${fieldPath}`, fieldPath, configPath);
      }
      fields[fieldName] = fieldValue;
    } else if (typeof fieldValue === "boolean") {
      fields[fieldName] = fieldValue;
    } else {
      failLidarrPreset(`Unsupported field value at ${fieldPath}`, fieldPath, configPath);
    }
  }
  return {
    name,
    implementation: implementation as LidarrPresetCustomFormatImplementation,
    negate: requireLidarrPresetBoolean(raw["negate"], `${propertyPath}.negate`, configPath),
    required: requireLidarrPresetBoolean(raw["required"], `${propertyPath}.required`, configPath),
    fields,
  };
}

function validateLidarrPresetCustomFormat(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
): LidarrPresetCustomFormat {
  const raw = requireLidarrPresetObject(value, propertyPath, configPath, context);
  requireLidarrPresetKeys(
    raw,
    ["name", "includeCustomFormatWhenRenaming", "specifications"],
    ["name", "includeCustomFormatWhenRenaming", "specifications"],
    propertyPath,
    configPath,
  );
  const specificationsRaw = requireLidarrPresetArray(
    raw["specifications"],
    `${propertyPath}.specifications`,
    configPath,
    context,
    LIDARR_PRESET_MAX_SPECIFICATIONS,
    1,
  );
  const specifications = specificationsRaw.map((entry, index) =>
    validateLidarrPresetSpecification(
      entry,
      `${propertyPath}.specifications[${index}]`,
      configPath,
      context,
    ),
  );
  assertUniqueLidarrPresetNames(
    specifications.map((entry) => entry.name),
    `${propertyPath}.specifications`,
    configPath,
  );
  return {
    name: requireLidarrPresetString(raw["name"], `${propertyPath}.name`, configPath, context),
    includeCustomFormatWhenRenaming: requireLidarrPresetBoolean(
      raw["includeCustomFormatWhenRenaming"],
      `${propertyPath}.includeCustomFormatWhenRenaming`,
      configPath,
    ),
    specifications,
  };
}

function validateLidarrPresetQualityItem(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
  depth: number,
): LidarrPresetQualityItem {
  if (depth > LIDARR_PRESET_MAX_QUALITY_DEPTH) {
    failLidarrPreset(
      `Quality tree exceeds depth ${LIDARR_PRESET_MAX_QUALITY_DEPTH}`,
      propertyPath,
      configPath,
    );
  }
  context.qualityNodes += 1;
  if (context.qualityNodes > LIDARR_PRESET_MAX_QUALITY_NODES) {
    failLidarrPreset(
      `Quality tree exceeds ${LIDARR_PRESET_MAX_QUALITY_NODES} nodes`,
      propertyPath,
      configPath,
    );
  }
  const raw = requireLidarrPresetObject(value, propertyPath, configPath, context);
  const kind = requireLidarrPresetString(raw["kind"], `${propertyPath}.kind`, configPath, context);
  if (kind === "quality") {
    requireLidarrPresetKeys(
      raw,
      ["kind", "name", "allowed"],
      ["kind", "name", "allowed"],
      propertyPath,
      configPath,
    );
    return {
      kind,
      name: requireLidarrPresetString(raw["name"], `${propertyPath}.name`, configPath, context),
      allowed: requireLidarrPresetBoolean(raw["allowed"], `${propertyPath}.allowed`, configPath),
    };
  }
  if (kind === "group") {
    requireLidarrPresetKeys(
      raw,
      ["kind", "name", "allowed", "items"],
      ["kind", "name", "allowed", "items"],
      propertyPath,
      configPath,
    );
    const itemsRaw = requireLidarrPresetArray(
      raw["items"],
      `${propertyPath}.items`,
      configPath,
      context,
      LIDARR_PRESET_MAX_RESOURCES,
      1,
    );
    return {
      kind,
      name: requireLidarrPresetString(raw["name"], `${propertyPath}.name`, configPath, context),
      allowed: requireLidarrPresetBoolean(raw["allowed"], `${propertyPath}.allowed`, configPath),
      items: itemsRaw.map((entry, index) =>
        validateLidarrPresetQualityItem(
          entry,
          `${propertyPath}.items[${index}]`,
          configPath,
          context,
          depth + 1,
        ),
      ),
    };
  }
  failLidarrPreset(
    `Unsupported quality item kind at ${propertyPath}.kind`,
    `${propertyPath}.kind`,
    configPath,
  );
}

function collectLidarrPresetQualityNamesAndPaths(
  items: readonly LidarrPresetQualityItem[],
  propertyPath: string,
  output: { readonly name: string; readonly path: string }[],
): void {
  for (const [index, item] of items.entries()) {
    const itemPath = `${propertyPath}[${index}]`;
    output.push({ name: item.name, path: `${itemPath}.name` });
    if (item.kind === "group") {
      collectLidarrPresetQualityNamesAndPaths(item.items, `${itemPath}.items`, output);
    }
  }
}

function validateLidarrPresetQualityProfile(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
  customFormatNames: ReadonlySet<string>,
): LidarrPresetQualityProfile {
  const raw = requireLidarrPresetObject(value, propertyPath, configPath, context);
  requireLidarrPresetKeys(
    raw,
    [
      "name",
      "upgradeAllowed",
      "cutoff",
      "items",
      "minFormatScore",
      "cutoffFormatScore",
      "formatScores",
    ],
    [
      "name",
      "upgradeAllowed",
      "cutoff",
      "items",
      "minFormatScore",
      "cutoffFormatScore",
      "formatScores",
    ],
    propertyPath,
    configPath,
  );
  const itemsRaw = requireLidarrPresetArray(
    raw["items"],
    `${propertyPath}.items`,
    configPath,
    context,
    LIDARR_PRESET_MAX_RESOURCES,
    1,
  );
  const items = itemsRaw.map((entry, index) =>
    validateLidarrPresetQualityItem(
      entry,
      `${propertyPath}.items[${index}]`,
      configPath,
      context,
      1,
    ),
  );
  const qualityNamesAndPaths: { readonly name: string; readonly path: string }[] = [];
  collectLidarrPresetQualityNamesAndPaths(items, `${propertyPath}.items`, qualityNamesAndPaths);
  const qualityNames = qualityNamesAndPaths.map(({ name }) => name);
  const normalizedQualityNames = new Set<string>();
  for (const { name, path } of qualityNamesAndPaths) {
    const normalized = normalizedLidarrPresetName(name);
    if (normalizedQualityNames.has(normalized)) {
      failLidarrPreset(`Duplicate normalized name at ${path}`, path, configPath);
    }
    normalizedQualityNames.add(normalized);
  }
  const cutoff = requireLidarrPresetString(
    raw["cutoff"],
    `${propertyPath}.cutoff`,
    configPath,
    context,
  );
  if (
    !new Set(qualityNames.map(normalizedLidarrPresetName)).has(normalizedLidarrPresetName(cutoff))
  ) {
    failLidarrPreset(
      `Unresolved cutoff at ${propertyPath}.cutoff`,
      `${propertyPath}.cutoff`,
      configPath,
    );
  }
  const formatScoresRaw = requireLidarrPresetArray(
    raw["formatScores"],
    `${propertyPath}.formatScores`,
    configPath,
    context,
    LIDARR_PRESET_MAX_RESOURCES,
  );
  const formatScores: LidarrPresetFormatScore[] = formatScoresRaw.map((entry, index) => {
    const scorePath = `${propertyPath}.formatScores[${index}]`;
    const scoreRaw = requireLidarrPresetObject(entry, scorePath, configPath, context);
    requireLidarrPresetKeys(
      scoreRaw,
      ["customFormatName", "score"],
      ["customFormatName", "score"],
      scorePath,
      configPath,
    );
    const customFormatName = requireLidarrPresetString(
      scoreRaw["customFormatName"],
      `${scorePath}.customFormatName`,
      configPath,
      context,
    );
    if (!customFormatNames.has(normalizedLidarrPresetName(customFormatName))) {
      failLidarrPreset(
        `Unknown custom format at ${scorePath}.customFormatName`,
        `${scorePath}.customFormatName`,
        configPath,
      );
    }
    return {
      customFormatName,
      score: requireLidarrPresetInteger(
        scoreRaw["score"],
        LIDARR_PRESET_MIN_SCORE,
        LIDARR_PRESET_MAX_SCORE,
        `${scorePath}.score`,
        configPath,
      ),
    };
  });
  assertUniqueLidarrPresetNames(
    formatScores.map((entry) => entry.customFormatName),
    `${propertyPath}.formatScores`,
    configPath,
  );
  const minFormatScore = requireLidarrPresetInteger(
    raw["minFormatScore"],
    LIDARR_PRESET_MIN_SCORE,
    LIDARR_PRESET_MAX_SCORE,
    `${propertyPath}.minFormatScore`,
    configPath,
  );
  const cutoffFormatScore = requireLidarrPresetInteger(
    raw["cutoffFormatScore"],
    LIDARR_PRESET_MIN_SCORE,
    LIDARR_PRESET_MAX_SCORE,
    `${propertyPath}.cutoffFormatScore`,
    configPath,
  );
  if (cutoffFormatScore < minFormatScore) {
    failLidarrPreset(
      `Cutoff format score must be at least the minimum format score at ${propertyPath}.cutoffFormatScore`,
      `${propertyPath}.cutoffFormatScore`,
      configPath,
    );
  }
  return {
    name: requireLidarrPresetString(raw["name"], `${propertyPath}.name`, configPath, context),
    upgradeAllowed: requireLidarrPresetBoolean(
      raw["upgradeAllowed"],
      `${propertyPath}.upgradeAllowed`,
      configPath,
    ),
    cutoff,
    items,
    minFormatScore,
    cutoffFormatScore,
    formatScores,
  };
}

function validateLidarrPresetNaming(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
): LidarrPresetNaming {
  const raw = requireLidarrPresetObject(value, propertyPath, configPath, context);
  const keys = [
    "renameTracks",
    "replaceIllegalCharacters",
    "colonReplacementFormat",
    "standardTrackFormat",
    "multiDiscTrackFormat",
    "artistFolderFormat",
  ] as const;
  requireLidarrPresetKeys(raw, keys, keys, propertyPath, configPath);
  const standardTrackFormat = requireLidarrPresetString(
    raw["standardTrackFormat"],
    `${propertyPath}.standardTrackFormat`,
    configPath,
    context,
  );
  const multiDiscTrackFormat = requireLidarrPresetString(
    raw["multiDiscTrackFormat"],
    `${propertyPath}.multiDiscTrackFormat`,
    configPath,
    context,
  );
  const artistFolderFormat = requireLidarrPresetString(
    raw["artistFolderFormat"],
    `${propertyPath}.artistFolderFormat`,
    configPath,
    context,
  );
  for (const [field, template] of [
    ["standardTrackFormat", standardTrackFormat],
    ["multiDiscTrackFormat", multiDiscTrackFormat],
    ["artistFolderFormat", artistFolderFormat],
  ] as const) {
    const path = `${propertyPath}.${field}`;
    if (
      /^(?:[\\/]|[a-z]:[\\/])/iu.test(template) ||
      /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u.test(template) ||
      template.replace(/\{[^{}]+\}/gu, "").includes("{") ||
      template.replace(/\{[^{}]+\}/gu, "").includes("}")
    ) {
      failLidarrPreset(`Unsafe path template at ${path}`, path, configPath);
    }
  }
  const hasRequiredTrackTokens = (template: string): boolean =>
    (/\{track title\}/iu.test(template) && /\{track(?::[^}]*)?\}/iu.test(template)) ||
    /\{original (?:title|filename)\}/iu.test(template);
  if (!hasRequiredTrackTokens(standardTrackFormat)) {
    failLidarrPreset(
      `Missing required track tokens at ${propertyPath}.standardTrackFormat`,
      `${propertyPath}.standardTrackFormat`,
      configPath,
    );
  }
  if (!hasRequiredTrackTokens(multiDiscTrackFormat)) {
    failLidarrPreset(
      `Missing required track tokens at ${propertyPath}.multiDiscTrackFormat`,
      `${propertyPath}.multiDiscTrackFormat`,
      configPath,
    );
  }
  if (!/\{artist name\}/iu.test(artistFolderFormat)) {
    failLidarrPreset(
      `Missing required artist token at ${propertyPath}.artistFolderFormat`,
      `${propertyPath}.artistFolderFormat`,
      configPath,
    );
  }
  return {
    renameTracks: requireLidarrPresetBoolean(
      raw["renameTracks"],
      `${propertyPath}.renameTracks`,
      configPath,
    ),
    replaceIllegalCharacters: requireLidarrPresetBoolean(
      raw["replaceIllegalCharacters"],
      `${propertyPath}.replaceIllegalCharacters`,
      configPath,
    ),
    colonReplacementFormat: requireLidarrPresetInteger(
      raw["colonReplacementFormat"],
      0,
      4,
      `${propertyPath}.colonReplacementFormat`,
      configPath,
    ),
    standardTrackFormat,
    multiDiscTrackFormat,
    artistFolderFormat,
  };
}

function validateLidarrConfiguredPresetPack(
  value: unknown,
  propertyPath: string,
  configPath: string,
  context: LidarrPresetValidationContext,
): LidarrConfiguredPresetPack {
  const raw = requireLidarrPresetObject(value, propertyPath, configPath, context);
  const keys = [
    "version",
    "description",
    "assumptions",
    "consequences",
    "capabilities",
    "customFormats",
    "qualityProfiles",
    "naming",
  ] as const;
  requireLidarrPresetKeys(raw, keys, keys, propertyPath, configPath);
  const customFormatsRaw = requireLidarrPresetArray(
    raw["customFormats"],
    `${propertyPath}.customFormats`,
    configPath,
    context,
    LIDARR_PRESET_MAX_RESOURCES,
    1,
  );
  const customFormats = customFormatsRaw.map((entry, index) =>
    validateLidarrPresetCustomFormat(
      entry,
      `${propertyPath}.customFormats[${index}]`,
      configPath,
      context,
    ),
  );
  assertUniqueLidarrPresetNames(
    customFormats.map((entry) => entry.name),
    `${propertyPath}.customFormats`,
    configPath,
  );
  const customFormatNames = new Set(
    customFormats.map((entry) => normalizedLidarrPresetName(entry.name)),
  );
  const qualityProfilesRaw = requireLidarrPresetArray(
    raw["qualityProfiles"],
    `${propertyPath}.qualityProfiles`,
    configPath,
    context,
    LIDARR_PRESET_MAX_RESOURCES,
    1,
  );
  if (customFormats.length + qualityProfilesRaw.length + 1 > LIDARR_PRESET_MAX_RESOURCES) {
    failLidarrPreset(
      `Pack exceeds ${LIDARR_PRESET_MAX_RESOURCES} managed resources`,
      propertyPath,
      configPath,
    );
  }
  const qualityProfiles = qualityProfilesRaw.map((entry, index) =>
    validateLidarrPresetQualityProfile(
      entry,
      `${propertyPath}.qualityProfiles[${index}]`,
      configPath,
      context,
      customFormatNames,
    ),
  );
  assertUniqueLidarrPresetNames(
    qualityProfiles.map((entry) => entry.name),
    `${propertyPath}.qualityProfiles`,
    configPath,
  );
  return {
    version: requireLidarrPresetInteger(
      raw["version"],
      1,
      Number.MAX_SAFE_INTEGER,
      `${propertyPath}.version`,
      configPath,
    ),
    description: requireLidarrPresetString(
      raw["description"],
      `${propertyPath}.description`,
      configPath,
      context,
    ),
    assumptions: validateLidarrPresetStringList(
      raw["assumptions"],
      `${propertyPath}.assumptions`,
      configPath,
      context,
    ),
    consequences: validateLidarrPresetStringList(
      raw["consequences"],
      `${propertyPath}.consequences`,
      configPath,
      context,
    ),
    capabilities: validateLidarrPresetCapabilities(
      raw["capabilities"],
      `${propertyPath}.capabilities`,
      configPath,
      context,
    ),
    customFormats,
    qualityProfiles,
    naming: validateLidarrPresetNaming(
      raw["naming"],
      `${propertyPath}.naming`,
      configPath,
      context,
    ),
  };
}

function validateLidarrProfilePresetsConfig(
  value: unknown,
  configPath: string,
): LidarrProfilePresetsConfigOptions {
  const context: LidarrPresetValidationContext = {
    seen: new WeakSet(),
    expandedBytes: 0,
    qualityNodes: 0,
  };
  const propertyPath = "lidarr.profilePresets";
  const raw = requireLidarrPresetObject(value, propertyPath, configPath, context);
  requireLidarrPresetKeys(raw, ["packs"], ["packs"], propertyPath, configPath);
  const packsRaw = requireLidarrPresetObject(
    raw["packs"],
    `${propertyPath}.packs`,
    configPath,
    context,
  );
  const packEntries = Object.entries(packsRaw);
  if (packEntries.length === 0 || packEntries.length > LIDARR_PRESET_MAX_PACKS) {
    failLidarrPreset(
      `Expected 1-${LIDARR_PRESET_MAX_PACKS} configured packs`,
      `${propertyPath}.packs`,
      configPath,
    );
  }
  const packs: Record<string, LidarrConfiguredPresetPack> = {};
  const normalizedIds = new Set<string>();
  for (const [id, value] of packEntries) {
    const packPath = `${propertyPath}.packs.${id}`;
    if (LIDARR_PRESET_SENSITIVE_KEY.test(id) || !/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      failLidarrPreset(`Invalid configured pack ID at ${packPath}`, packPath, configPath);
    }
    const normalizedId = normalizedLidarrPresetName(id);
    if (LIDARR_BUILTIN_PRESET_IDS.has(normalizedId)) {
      failLidarrPreset(`Configured pack shadows built-in ${id}`, packPath, configPath);
    }
    if (normalizedIds.has(normalizedId)) {
      failLidarrPreset(`Duplicate configured pack ID at ${packPath}`, packPath, configPath);
    }
    normalizedIds.add(normalizedId);
    packs[id] = validateLidarrConfiguredPresetPack(value, packPath, configPath, context);
  }
  return { packs };
}

/**
 * Validates LidarrConfigOptions from a raw config object.
 *
 * @param raw - The raw `lidarr` config section object
 * @param configPath - Path to the config file (for error messages)
 * @returns Validated Lidarr configuration options
 * @throws {ConfigError} When a field fails type or format validation
 */
function validateLidarrConfigOptions(
  raw: Record<string, unknown>,
  configPath: string,
): LidarrConfigOptions {
  const config: LidarrConfigOptions = {};

  if ("baseUrl" in raw && raw["baseUrl"] !== undefined) {
    config.baseUrl = validateUrl(raw["baseUrl"], "lidarr.baseUrl", configPath);
  }

  if ("apiKey" in raw && raw["apiKey"] !== undefined) {
    config.apiKey = validateString(raw["apiKey"], "lidarr.apiKey", configPath);
  }

  if ("timeoutMs" in raw && raw["timeoutMs"] !== undefined) {
    config.timeoutMs = validatePositiveInteger(raw["timeoutMs"], "lidarr.timeoutMs", configPath);
  }

  if ("resilience" in raw && raw["resilience"] !== undefined) {
    const resilienceRaw = raw["resilience"];
    if (
      typeof resilienceRaw !== "object" ||
      resilienceRaw === null ||
      Array.isArray(resilienceRaw)
    ) {
      throw new ConfigError(
        `Expected object for lidarr.resilience, got ${describeType(resilienceRaw)}`,
        configPath,
        "lidarr.resilience",
      );
    }
    config.resilience = validateLidarrResilienceConfig(
      resilienceRaw as Record<string, unknown>,
      configPath,
    );
  }

  if ("scheduler" in raw && raw["scheduler"] !== undefined) {
    const schedulerRaw = raw["scheduler"];
    if (typeof schedulerRaw !== "object" || schedulerRaw === null || Array.isArray(schedulerRaw)) {
      throw new ConfigError(
        `Expected object for lidarr.scheduler, got ${describeType(schedulerRaw)}`,
        configPath,
        "lidarr.scheduler",
      );
    }
    config.scheduler = validateLidarrSchedulerConfig(
      schedulerRaw as Record<string, unknown>,
      configPath,
    );
  }

  if ("cascadeAnalysis" in raw && raw["cascadeAnalysis"] !== undefined) {
    config.cascadeAnalysis = validateLidarrCascadeAnalysisConfig(
      raw["cascadeAnalysis"],
      configPath,
    );
  }

  if ("profilePresets" in raw && raw["profilePresets"] !== undefined) {
    config.profilePresets = validateLidarrProfilePresetsConfig(raw["profilePresets"], configPath);
  }

  return config;
}

const DISCOVERY_CONFIG_KEYS = new Set(["lastfm"]);
const LASTFM_CONFIG_KEYS = new Set(["apiKey", "timeoutMs"]);
const LASTFM_API_KEY_MAX_BYTES = 1_024;
const LASTFM_TIMEOUT_MAX_MS = 300_000;
const UNSAFE_CREDENTIAL_TEXT = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

/** Validates a bounded credential without normalizing or exposing its value. */
function validateLastFmApiKey(value: unknown, configPath: string): string {
  const propertyPath = "discovery.lastfm.apiKey";
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > LASTFM_API_KEY_MAX_BYTES ||
    UNSAFE_CREDENTIAL_TEXT.test(value)
  ) {
    throw new ConfigError(
      `Expected non-empty control-free string up to ${LASTFM_API_KEY_MAX_BYTES} bytes for ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/** Validates the exact optional `discovery.lastfm` configuration object. */
function validateLastFmConfigOptions(
  raw: Record<string, unknown>,
  configPath: string,
): LastFmConfigOptions {
  rejectUnknownConfigKeys(raw, LASTFM_CONFIG_KEYS, "discovery.lastfm", configPath);

  const apiKey =
    "apiKey" in raw && raw["apiKey"] !== undefined
      ? validateLastFmApiKey(raw["apiKey"], configPath)
      : undefined;
  const timeoutMs =
    "timeoutMs" in raw && raw["timeoutMs"] !== undefined
      ? validateBoundedInteger(
          raw["timeoutMs"],
          1,
          LASTFM_TIMEOUT_MAX_MS,
          "discovery.lastfm.timeoutMs",
          configPath,
        )
      : undefined;

  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** Validates the exact optional top-level discovery configuration object. */
function validateDiscoveryConfigOptions(
  raw: Record<string, unknown>,
  configPath: string,
): DiscoveryConfigOptions {
  rejectUnknownConfigKeys(raw, DISCOVERY_CONFIG_KEYS, "discovery", configPath);
  if (!("lastfm" in raw) || raw["lastfm"] === undefined) {
    return {};
  }

  const lastFmRaw = raw["lastfm"];
  if (typeof lastFmRaw !== "object" || lastFmRaw === null || Array.isArray(lastFmRaw)) {
    throw new ConfigError(
      `Expected object for discovery.lastfm, got ${describeType(lastFmRaw)}`,
      configPath,
      "discovery.lastfm",
    );
  }

  return {
    lastfm: validateLastFmConfigOptions(lastFmRaw as Record<string, unknown>, configPath),
  };
}

const POLICY_CONFIG_KEYS = new Set(["plexLibrary", "rules", "overrides"]);
const POLICY_RULE_IDS_SET = new Set([
  "rating-quality-upgrade",
  "stale-monitoring-cleanup",
  "discovery-seed",
]);
const POLICY_QUALITY_UPGRADE_KEYS = new Set([
  "enabled",
  "minRating",
  "targetQualityProfile",
  "maxProposals",
]);
const POLICY_STALE_MONITORING_KEYS = new Set([
  "enabled",
  "maxPlays",
  "minDaysSinceLastViewed",
  "protectRatingAtOrAbove",
  "requireTrackCoverage",
  "minTrackFileCount",
  "maxProposals",
]);
const POLICY_DISCOVERY_SEED_KEYS = new Set(["enabled", "minRating", "minPlays", "maxSeeds"]);
const POLICY_OVERRIDE_KEYS = new Set(["action", "evidenceFingerprint", "reason"]);

const POLICY_MAX_PLAYS_CEILING = 1_000_000;
const POLICY_MAX_DAYS_SINCE_LAST_VIEWED = 36_500;
const POLICY_MAX_PROPOSALS_CEILING = 100;
const POLICY_MAX_SEEDS_CEILING = 100;
const POLICY_MAX_TRACK_FILE_COUNT = 1_000_000;
const POLICY_MAX_OVERRIDES = 500;
const POLICY_OVERRIDE_KEY_MAX_LENGTH = 256;
const POLICY_OVERRIDE_REASON_MAX_BYTES = 512;
const POLICY_OVERRIDE_UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const POLICY_OVERRIDE_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const POLICY_OVERRIDE_UNSAFE_KEY = new Set(["__proto__", "prototype", "constructor"]);

/** Narrows an override mapping or entry to an own-key, plain/null-prototype object. */
function requirePolicyOverrideObject(
  value: unknown,
  propertyPath: string,
  configPath: string,
  childPath: (key: string) => string = (key) => `${propertyPath}.${key}`,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `Expected plain object for ${propertyPath}, got ${describeType(value)}`,
      configPath,
      propertyPath,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConfigError(`Unsafe object prototype at ${propertyPath}`, configPath, propertyPath);
  }
  for (const key of Reflect.ownKeys(value)) {
    const keyPath = typeof key === "string" ? childPath(key) : propertyPath;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new ConfigError(
        `Expected own enumerable data property ${keyPath}`,
        configPath,
        keyPath,
      );
    }
  }
  return value as Record<string, unknown>;
}

function policyOverridePath(key: string): string {
  return `policy.overrides[${quoteTerminalSafePathSegment(key)}]`;
}

function quoteTerminalSafePathSegment(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

function policyOverrideEntryFieldPath(propertyPath: string, field: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(field)
    ? `${propertyPath}.${field}`
    : `${propertyPath}[${quoteTerminalSafePathSegment(field)}]`;
}

function rejectUnknownPolicyOverrideKeys(
  raw: Record<string, unknown>,
  propertyPath: string,
  configPath: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!POLICY_OVERRIDE_KEYS.has(key)) {
      const keyPath = policyOverrideEntryFieldPath(propertyPath, key);
      throw new ConfigError(`Unknown property ${keyPath}`, configPath, keyPath);
    }
  }
}

function isPolicyProposalKey(key: string): boolean {
  if (
    key.length === 0 ||
    key.length > POLICY_OVERRIDE_KEY_MAX_LENGTH ||
    POLICY_OVERRIDE_UNSAFE_TEXT.test(key) ||
    POLICY_OVERRIDE_UNSAFE_KEY.has(key)
  ) {
    return false;
  }

  const segments = key.split(":");
  if (segments.length !== 3) {
    return false;
  }
  const [ruleId, subjectKind, subjectId] = segments;
  if (subjectId === undefined || subjectId.length === 0) {
    return false;
  }

  if (ruleId === "discovery-seed") {
    return subjectKind === "plex";
  }
  if (ruleId !== "rating-quality-upgrade" && ruleId !== "stale-monitoring-cleanup") {
    return false;
  }
  if (subjectKind !== "artist" || !/^[1-9][0-9]*$/u.test(subjectId)) {
    return false;
  }
  const artistId = Number(subjectId);
  return Number.isSafeInteger(artistId) && artistId > 0 && String(artistId) === subjectId;
}

function validatePolicyOverrideEntry(
  raw: Record<string, unknown>,
  propertyPath: string,
  configPath: string,
): PolicyOverrideConfigOptions {
  rejectUnknownPolicyOverrideKeys(raw, propertyPath, configPath);
  for (const requiredKey of POLICY_OVERRIDE_KEYS) {
    if (!Object.hasOwn(raw, requiredKey) || raw[requiredKey] === undefined) {
      const requiredPath = `${propertyPath}.${requiredKey}`;
      throw new ConfigError(`Missing required property ${requiredPath}`, configPath, requiredPath);
    }
  }

  const actionPath = `${propertyPath}.action`;
  if (raw["action"] !== "suppress") {
    throw new ConfigError(
      `Expected "suppress" for ${actionPath}, got ${describeType(raw["action"])}`,
      configPath,
      actionPath,
    );
  }

  const fingerprintPath = `${propertyPath}.evidenceFingerprint`;
  const evidenceFingerprint = raw["evidenceFingerprint"];
  if (
    typeof evidenceFingerprint !== "string" ||
    !POLICY_OVERRIDE_FINGERPRINT.test(evidenceFingerprint)
  ) {
    throw new ConfigError(
      `Expected lowercase sha256 fingerprint for ${fingerprintPath}, got ${describeType(evidenceFingerprint)}`,
      configPath,
      fingerprintPath,
    );
  }

  const reasonPath = `${propertyPath}.reason`;
  const reason = raw["reason"];
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.trim() !== reason ||
    Buffer.byteLength(reason, "utf8") > POLICY_OVERRIDE_REASON_MAX_BYTES ||
    POLICY_OVERRIDE_UNSAFE_TEXT.test(reason)
  ) {
    throw new ConfigError(
      `Expected an already-trimmed terminal-safe string up to ${POLICY_OVERRIDE_REASON_MAX_BYTES} bytes for ${reasonPath}`,
      configPath,
      reasonPath,
    );
  }

  return {
    action: "suppress",
    evidenceFingerprint: evidenceFingerprint as PolicyOverrideConfigOptions["evidenceFingerprint"],
    reason,
  };
}

function validatePolicyOverridesConfigOptions(
  value: unknown,
  configPath: string,
): PolicyConfigOptions["overrides"] {
  const propertyPath = "policy.overrides";
  const raw = requirePolicyOverrideObject(value, propertyPath, configPath, policyOverridePath);
  const keys = Object.keys(raw);
  if (keys.length > POLICY_MAX_OVERRIDES) {
    throw new ConfigError(
      `Expected at most ${POLICY_MAX_OVERRIDES} entries for ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }

  const overrides: Record<string, PolicyOverrideConfigOptions> = Object.create(null) as Record<
    string,
    PolicyOverrideConfigOptions
  >;
  for (const key of keys) {
    const entryPath = policyOverridePath(key);
    if (POLICY_OVERRIDE_UNSAFE_KEY.has(key) || !isPolicyProposalKey(key)) {
      throw new ConfigError(`Invalid proposal decision key ${entryPath}`, configPath, entryPath);
    }
    overrides[key] = validatePolicyOverrideEntry(
      requirePolicyOverrideObject(raw[key], entryPath, configPath, (field) =>
        policyOverrideEntryFieldPath(entryPath, field),
      ),
      entryPath,
      configPath,
    );
  }
  return Object.freeze(overrides);
}

/**
 * Validates a Lidarr quality-profile reference, accepted either as a profile
 * name or as its numeric id (design §5.1: "by name or numeric id").
 *
 * A YAML integer is normalised with `String(...)` so the stored config type
 * stays `string`, which is what `resolveTargetProfileId` consumes — it already
 * resolves an id-shaped string before falling back to a case-insensitive name
 * match. Without this, the natural `targetQualityProfile: 6` threw a
 * `ConfigError` that `loadConfig` swallows, discarding the operator's whole
 * config file behind a single WARN line.
 */
function validateQualityProfileReference(
  value: unknown,
  propertyPath: string,
  configPath: string,
): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ConfigError(
        `Expected a quality profile name or a positive integer profile id for ${propertyPath}, got ${value}`,
        configPath,
        propertyPath,
      );
    }
    return String(value);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(
      `Expected a quality profile name or a positive integer profile id for ${propertyPath}, got ${describeType(value)}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/** Validates the exact optional `policy.rules.rating-quality-upgrade` object. */
function validatePolicyRatingQualityUpgradeConfig(
  raw: Record<string, unknown>,
  configPath: string,
): PolicyRatingQualityUpgradeConfigOptions {
  const propertyPath = "policy.rules.rating-quality-upgrade";
  rejectUnknownConfigKeys(raw, POLICY_QUALITY_UPGRADE_KEYS, propertyPath, configPath);

  const enabled =
    "enabled" in raw && raw["enabled"] !== undefined
      ? validateBoolean(raw["enabled"], `${propertyPath}.enabled`, configPath)
      : undefined;
  const minRating =
    "minRating" in raw && raw["minRating"] !== undefined
      ? validateStarRating(raw["minRating"], `${propertyPath}.minRating`, configPath)
      : undefined;
  const targetQualityProfile =
    "targetQualityProfile" in raw && raw["targetQualityProfile"] !== undefined
      ? validateQualityProfileReference(
          raw["targetQualityProfile"],
          `${propertyPath}.targetQualityProfile`,
          configPath,
        )
      : undefined;
  const maxProposals =
    "maxProposals" in raw && raw["maxProposals"] !== undefined
      ? validateBoundedInteger(
          raw["maxProposals"],
          1,
          POLICY_MAX_PROPOSALS_CEILING,
          `${propertyPath}.maxProposals`,
          configPath,
        )
      : undefined;

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(minRating === undefined ? {} : { minRating }),
    ...(targetQualityProfile === undefined ? {} : { targetQualityProfile }),
    ...(maxProposals === undefined ? {} : { maxProposals }),
  };
}

/** Validates the exact optional `policy.rules.stale-monitoring-cleanup` object. */
function validatePolicyStaleMonitoringConfig(
  raw: Record<string, unknown>,
  configPath: string,
): PolicyStaleMonitoringConfigOptions {
  const propertyPath = "policy.rules.stale-monitoring-cleanup";
  rejectUnknownConfigKeys(raw, POLICY_STALE_MONITORING_KEYS, propertyPath, configPath);

  const enabled =
    "enabled" in raw && raw["enabled"] !== undefined
      ? validateBoolean(raw["enabled"], `${propertyPath}.enabled`, configPath)
      : undefined;
  const maxPlays =
    "maxPlays" in raw && raw["maxPlays"] !== undefined
      ? validateBoundedInteger(
          raw["maxPlays"],
          0,
          POLICY_MAX_PLAYS_CEILING,
          `${propertyPath}.maxPlays`,
          configPath,
        )
      : undefined;
  const minDaysSinceLastViewed =
    "minDaysSinceLastViewed" in raw && raw["minDaysSinceLastViewed"] !== undefined
      ? validateBoundedInteger(
          raw["minDaysSinceLastViewed"],
          1,
          POLICY_MAX_DAYS_SINCE_LAST_VIEWED,
          `${propertyPath}.minDaysSinceLastViewed`,
          configPath,
        )
      : undefined;
  const protectRatingAtOrAbove =
    "protectRatingAtOrAbove" in raw && raw["protectRatingAtOrAbove"] !== undefined
      ? validateStarRating(
          raw["protectRatingAtOrAbove"],
          `${propertyPath}.protectRatingAtOrAbove`,
          configPath,
        )
      : undefined;
  const requireTrackCoverage =
    "requireTrackCoverage" in raw && raw["requireTrackCoverage"] !== undefined
      ? validateBoolean(
          raw["requireTrackCoverage"],
          `${propertyPath}.requireTrackCoverage`,
          configPath,
        )
      : undefined;
  const minTrackFileCount =
    "minTrackFileCount" in raw && raw["minTrackFileCount"] !== undefined
      ? validateBoundedInteger(
          raw["minTrackFileCount"],
          0,
          POLICY_MAX_TRACK_FILE_COUNT,
          `${propertyPath}.minTrackFileCount`,
          configPath,
        )
      : undefined;
  const maxProposals =
    "maxProposals" in raw && raw["maxProposals"] !== undefined
      ? validateBoundedInteger(
          raw["maxProposals"],
          1,
          POLICY_MAX_PROPOSALS_CEILING,
          `${propertyPath}.maxProposals`,
          configPath,
        )
      : undefined;

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(maxPlays === undefined ? {} : { maxPlays }),
    ...(minDaysSinceLastViewed === undefined ? {} : { minDaysSinceLastViewed }),
    ...(protectRatingAtOrAbove === undefined ? {} : { protectRatingAtOrAbove }),
    ...(requireTrackCoverage === undefined ? {} : { requireTrackCoverage }),
    ...(minTrackFileCount === undefined ? {} : { minTrackFileCount }),
    ...(maxProposals === undefined ? {} : { maxProposals }),
  };
}

/** Validates the exact optional `policy.rules.discovery-seed` object. */
function validatePolicyDiscoverySeedConfig(
  raw: Record<string, unknown>,
  configPath: string,
): PolicyDiscoverySeedConfigOptions {
  const propertyPath = "policy.rules.discovery-seed";
  rejectUnknownConfigKeys(raw, POLICY_DISCOVERY_SEED_KEYS, propertyPath, configPath);

  const enabled =
    "enabled" in raw && raw["enabled"] !== undefined
      ? validateBoolean(raw["enabled"], `${propertyPath}.enabled`, configPath)
      : undefined;
  const minRating =
    "minRating" in raw && raw["minRating"] !== undefined
      ? validateStarRating(raw["minRating"], `${propertyPath}.minRating`, configPath)
      : undefined;
  const minPlays =
    "minPlays" in raw && raw["minPlays"] !== undefined
      ? validateBoundedInteger(
          raw["minPlays"],
          0,
          POLICY_MAX_PLAYS_CEILING,
          `${propertyPath}.minPlays`,
          configPath,
        )
      : undefined;
  const maxSeeds =
    "maxSeeds" in raw && raw["maxSeeds"] !== undefined
      ? validateBoundedInteger(
          raw["maxSeeds"],
          1,
          POLICY_MAX_SEEDS_CEILING,
          `${propertyPath}.maxSeeds`,
          configPath,
        )
      : undefined;

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(minRating === undefined ? {} : { minRating }),
    ...(minPlays === undefined ? {} : { minPlays }),
    ...(maxSeeds === undefined ? {} : { maxSeeds }),
  };
}

/**
 * Validates the exact optional `policy.rules` object.
 *
 * Unknown rule ids are rejected rather than ignored, so a typo cannot silently
 * disable enforcement of a rule the operator believes is configured.
 */
function validatePolicyRulesConfigOptions(
  raw: Record<string, unknown>,
  configPath: string,
): PolicyRulesConfigOptions {
  rejectUnknownConfigKeys(raw, POLICY_RULE_IDS_SET, "policy.rules", configPath);

  const ratingQualityUpgrade =
    "rating-quality-upgrade" in raw && raw["rating-quality-upgrade"] !== undefined
      ? validatePolicyRatingQualityUpgradeConfig(
          requireConfigObject(
            raw["rating-quality-upgrade"],
            "policy.rules.rating-quality-upgrade",
            configPath,
          ),
          configPath,
        )
      : undefined;
  const staleMonitoringCleanup =
    "stale-monitoring-cleanup" in raw && raw["stale-monitoring-cleanup"] !== undefined
      ? validatePolicyStaleMonitoringConfig(
          requireConfigObject(
            raw["stale-monitoring-cleanup"],
            "policy.rules.stale-monitoring-cleanup",
            configPath,
          ),
          configPath,
        )
      : undefined;
  const discoverySeed =
    "discovery-seed" in raw && raw["discovery-seed"] !== undefined
      ? validatePolicyDiscoverySeedConfig(
          requireConfigObject(raw["discovery-seed"], "policy.rules.discovery-seed", configPath),
          configPath,
        )
      : undefined;

  return {
    ...(ratingQualityUpgrade === undefined
      ? {}
      : { "rating-quality-upgrade": ratingQualityUpgrade }),
    ...(staleMonitoringCleanup === undefined
      ? {}
      : { "stale-monitoring-cleanup": staleMonitoringCleanup }),
    ...(discoverySeed === undefined ? {} : { "discovery-seed": discoverySeed }),
  };
}

/**
 * Validates the exact optional top-level policy configuration object.
 *
 * No defaults are injected: the validator returns only what the operator
 * supplied. Defaults are applied at the consumption site by
 * `resolvePolicyConfig`, following the `resolveLidarrCascadePolicy` pattern.
 */
function validatePolicyConfigOptions(
  raw: Record<string, unknown>,
  configPath: string,
): PolicyConfigOptions {
  rejectUnknownConfigKeys(raw, POLICY_CONFIG_KEYS, "policy", configPath);

  const plexLibrary =
    "plexLibrary" in raw && raw["plexLibrary"] !== undefined
      ? validateString(raw["plexLibrary"], "policy.plexLibrary", configPath)
      : undefined;
  const rules =
    "rules" in raw && raw["rules"] !== undefined
      ? validatePolicyRulesConfigOptions(
          requireConfigObject(raw["rules"], "policy.rules", configPath),
          configPath,
        )
      : undefined;
  const overrides =
    "overrides" in raw && raw["overrides"] !== undefined
      ? validatePolicyOverridesConfigOptions(raw["overrides"], configPath)
      : undefined;

  return {
    ...(plexLibrary === undefined ? {} : { plexLibrary }),
    ...(rules === undefined ? {} : { rules }),
    ...(overrides === undefined ? {} : { overrides }),
  };
}

/**
 * Validates UndoConfigOptions.
 */
function validateUndoConfig(raw: Record<string, unknown>, configPath: string): UndoConfigOptions {
  const config: UndoConfigOptions = {};

  if ("enabled" in raw && raw["enabled"] !== undefined) {
    config.enabled = validateBoolean(raw["enabled"], "undo.enabled", configPath);
  }

  if ("retentionDays" in raw && raw["retentionDays"] !== undefined) {
    config.retentionDays = validatePositiveInteger(
      raw["retentionDays"],
      "undo.retentionDays",
      configPath,
    );
  }

  if ("maxSizeMB" in raw && raw["maxSizeMB"] !== undefined) {
    config.maxSizeMB = validatePositiveInteger(raw["maxSizeMB"], "undo.maxSizeMB", configPath);
  }

  if ("historyPath" in raw && raw["historyPath"] !== undefined) {
    config.historyPath = validateString(raw["historyPath"], "undo.historyPath", configPath);
  }

  if ("database" in raw && raw["database"] !== undefined) {
    config.database = validateString(raw["database"], "undo.database", configPath);
  }

  if ("useLegacy" in raw && raw["useLegacy"] !== undefined) {
    config.useLegacy = validateBoolean(raw["useLegacy"], "undo.useLegacy", configPath);
  }

  return config;
}

/**
 * Validates LinkVideosConfigOptions.
 */
function validateLinkVideosConfig(
  raw: Record<string, unknown>,
  configPath: string,
): LinkVideosConfigOptions {
  const config: LinkVideosConfigOptions = {};

  if ("minScore" in raw && raw["minScore"] !== undefined) {
    const value = raw["minScore"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new ConfigError(
        `Expected integer between 0 and 100 for linkVideos.minScore, got ${value}`,
        configPath,
        "linkVideos.minScore",
      );
    }
    config.minScore = value;
  }

  if ("preferredFormat" in raw && raw["preferredFormat"] !== undefined) {
    config.preferredFormat = validateString(
      raw["preferredFormat"],
      "linkVideos.preferredFormat",
      configPath,
    );
  }

  if ("progress" in raw && raw["progress"] !== undefined) {
    config.progress = validateBoolean(raw["progress"], "linkVideos.progress", configPath);
  }

  return config;
}

/**
 * Validates TrackingConfigOptions.
 */
function validateTrackingConfig(
  raw: Record<string, unknown>,
  configPath: string,
): TrackingConfigOptions {
  const config: TrackingConfigOptions = {};

  if ("database" in raw && raw["database"] !== undefined) {
    config.database = validateString(raw["database"], "tracking.database", configPath);
  }

  if ("useLegacy" in raw && raw["useLegacy"] !== undefined) {
    config.useLegacy = validateBoolean(raw["useLegacy"], "tracking.useLegacy", configPath);
  }

  return config;
}

/**
 * Validates InteractiveConfig and merges with defaults.
 * Returns a complete InteractiveConfig with all required fields populated.
 */
function validateInteractiveConfig(
  raw: Record<string, unknown>,
  configPath: string,
): InteractiveConfig {
  const config: InteractiveConfig = { ...DEFAULT_INTERACTIVE_CONFIG };

  if ("artistPageSize" in raw && raw["artistPageSize"] !== undefined) {
    (config as { artistPageSize: number }).artistPageSize = validatePageSize(
      raw["artistPageSize"],
      "interactive.artistPageSize",
      configPath,
    );
  }

  if ("albumPageSize" in raw && raw["albumPageSize"] !== undefined) {
    (config as { albumPageSize: number }).albumPageSize = validatePageSize(
      raw["albumPageSize"],
      "interactive.albumPageSize",
      configPath,
    );
  }

  if ("trackPageSize" in raw && raw["trackPageSize"] !== undefined) {
    (config as { trackPageSize: number }).trackPageSize = validatePageSize(
      raw["trackPageSize"],
      "interactive.trackPageSize",
      configPath,
    );
  }

  return config;
}

/**
 * Validates a smart filter rule recursively.
 * Handles both leaf rules (type: 'rule') and nested groups (type: 'group').
 *
 * @param raw - Raw rule object to validate
 * @param propertyPath - Property path for error messages (e.g., "filters.name.rules[0]")
 * @param configPath - Path to the config file
 * @param depth - Current nesting depth (for stack overflow prevention)
 * @returns Validated SmartFilterRule
 * @throws ConfigError if validation fails or depth exceeds limit
 */
function validateSmartFilterRule(
  raw: unknown,
  propertyPath: string,
  configPath: string,
  depth: number = 0,
): SmartFilterRule {
  // Check depth limit to prevent stack overflow
  if (depth >= MAX_FILTER_DEPTH) {
    throw new ConfigError(
      `Filter nesting depth exceeds maximum of ${MAX_FILTER_DEPTH} at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }

  // Rule must be an object
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `Expected object for ${propertyPath}, got ${describeType(raw)}`,
      configPath,
      propertyPath,
    );
  }

  const rawRule = raw as Record<string, unknown>;

  // Check for discriminator 'type' field
  if (!("type" in rawRule) || rawRule["type"] === undefined) {
    throw new ConfigError(
      `Missing required field 'type' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }

  const ruleType = rawRule["type"];

  if (ruleType === "rule") {
    // Validate leaf rule (FilterRule)
    return validateFilterRule(rawRule, propertyPath, configPath);
  } else if (ruleType === "group") {
    // Validate nested group (FilterGroup)
    return validateFilterGroup(rawRule, propertyPath, configPath, depth);
  } else {
    throw new ConfigError(
      `Invalid rule type for ${propertyPath}.type: ${ruleType}. Expected 'rule' or 'group'`,
      configPath,
      `${propertyPath}.type`,
    );
  }
}

/**
 * Validates a leaf filter rule (type: 'rule').
 */
function validateFilterRule(
  rawRule: Record<string, unknown>,
  propertyPath: string,
  configPath: string,
): FilterRule {
  // Validate required field 'field'
  if (!("field" in rawRule) || rawRule["field"] === undefined) {
    throw new ConfigError(
      `Missing required field 'field' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const field = validateFilterField(rawRule["field"], `${propertyPath}.field`, configPath);

  // Validate required field 'operator'
  if (!("operator" in rawRule) || rawRule["operator"] === undefined) {
    throw new ConfigError(
      `Missing required field 'operator' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const operator = validateFilterOperator(
    rawRule["operator"],
    `${propertyPath}.operator`,
    configPath,
  );

  // Validate required field 'value'
  if (!("value" in rawRule) || rawRule["value"] === undefined) {
    throw new ConfigError(
      `Missing required field 'value' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const value = validateFilterValue(rawRule["value"], field, `${propertyPath}.value`, configPath);

  return {
    type: "rule",
    field,
    operator,
    value,
  };
}

/**
 * Validates a nested filter group (type: 'group').
 */
function validateFilterGroup(
  rawGroup: Record<string, unknown>,
  propertyPath: string,
  configPath: string,
  depth: number,
): FilterGroup {
  // Validate required field 'match'
  if (!("match" in rawGroup) || rawGroup["match"] === undefined) {
    throw new ConfigError(
      `Missing required field 'match' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const match = validateMatchType(rawGroup["match"], `${propertyPath}.match`, configPath);

  // Validate required field 'rules' (must be non-empty array)
  if (!("rules" in rawGroup) || rawGroup["rules"] === undefined) {
    throw new ConfigError(
      `Missing required field 'rules' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  if (!Array.isArray(rawGroup["rules"])) {
    throw new ConfigError(
      `Expected array for ${propertyPath}.rules, got ${describeType(rawGroup["rules"])}`,
      configPath,
      `${propertyPath}.rules`,
    );
  }
  if (rawGroup["rules"].length === 0) {
    throw new ConfigError(
      `Rules array cannot be empty at ${propertyPath}.rules`,
      configPath,
      `${propertyPath}.rules`,
    );
  }

  // Recursively validate each rule in the group
  const validatedRules: SmartFilterRule[] = [];
  for (let i = 0; i < rawGroup["rules"].length; i++) {
    const rule = rawGroup["rules"][i];
    const rulePath = `${propertyPath}.rules[${i}]`;
    validatedRules.push(validateSmartFilterRule(rule, rulePath, configPath, depth + 1));
  }

  return {
    type: "group",
    match,
    rules: validatedRules,
  };
}

/**
 * Validates the optional post-filter playlist sequencing policy.
 */
function validateSeparationConfig(
  raw: unknown,
  propertyPath: string,
  configPath: string,
): SeparationConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `Expected object for ${propertyPath}, got ${describeType(raw)}`,
      configPath,
      propertyPath,
    );
  }

  const rawSeparation = raw as Record<string, unknown>;
  const validKeys = new Set(["artist", "genre", "tempo", "era", "energy"]);
  for (const key of Object.keys(rawSeparation)) {
    if (!validKeys.has(key)) {
      throw new ConfigError(
        `Unknown separation option at ${propertyPath}.${key}`,
        configPath,
        `${propertyPath}.${key}`,
      );
    }
  }

  const separation: SeparationConfig = {};
  for (const key of ["artist", "genre"] as const) {
    const value = rawSeparation[key];
    if (value === undefined) continue;
    if (
      !Number.isInteger(value) ||
      (value as number) < 1 ||
      (value as number) > MAX_SEPARATION_GAP
    ) {
      throw new ConfigError(
        `Expected integer from 1 to ${MAX_SEPARATION_GAP} for ${propertyPath}.${key}, got ${String(value)}`,
        configPath,
        `${propertyPath}.${key}`,
      );
    }
    separation[key] = value as number;
  }

  const tempo = rawSeparation["tempo"];
  if (tempo !== undefined) {
    if (tempo !== "alternate") {
      throw new ConfigError(
        `Invalid value for ${propertyPath}.tempo: ${String(tempo)}. Expected 'alternate'`,
        configPath,
        `${propertyPath}.tempo`,
      );
    }
    separation.tempo = tempo;
  }

  const era = rawSeparation["era"];
  if (era !== undefined) {
    if (era !== "distribute") {
      throw new ConfigError(
        `Invalid value for ${propertyPath}.era: ${String(era)}. Expected 'distribute'`,
        configPath,
        `${propertyPath}.era`,
      );
    }
    separation.era = era;
  }

  const energy = rawSeparation["energy"];
  if (energy !== undefined) {
    if (!["alternate", "rise", "fall", "wave"].includes(energy as string)) {
      throw new ConfigError(
        `Invalid value for ${propertyPath}.energy: ${String(energy)}. Expected 'alternate', 'rise', 'fall', or 'wave'`,
        configPath,
        `${propertyPath}.energy`,
      );
    }
    separation.energy = energy as NonNullable<SeparationConfig["energy"]>;
  }

  return separation;
}

/**
 * Validates a SmartFilter (top-level filter with match and rules).
 */
function validateSmartFilter(raw: unknown, propertyPath: string, configPath: string): SmartFilter {
  // Filter must be an object
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `Expected object for ${propertyPath}, got ${describeType(raw)}`,
      configPath,
      propertyPath,
    );
  }

  const rawFilter = raw as Record<string, unknown>;

  // Validate required field 'match'
  if (!("match" in rawFilter) || rawFilter["match"] === undefined) {
    throw new ConfigError(
      `Missing required field 'match' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const match = validateMatchType(rawFilter["match"], `${propertyPath}.match`, configPath);

  // Validate required field 'rules' (must be non-empty array)
  if (!("rules" in rawFilter) || rawFilter["rules"] === undefined) {
    throw new ConfigError(
      `Missing required field 'rules' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  if (!Array.isArray(rawFilter["rules"])) {
    throw new ConfigError(
      `Expected array for ${propertyPath}.rules, got ${describeType(rawFilter["rules"])}`,
      configPath,
      `${propertyPath}.rules`,
    );
  }
  if (rawFilter["rules"].length === 0) {
    throw new ConfigError(
      `Rules array cannot be empty at ${propertyPath}.rules`,
      configPath,
      `${propertyPath}.rules`,
    );
  }

  // Recursively validate each rule
  const validatedRules: SmartFilterRule[] = [];
  for (let i = 0; i < rawFilter["rules"].length; i++) {
    const rule = rawFilter["rules"][i];
    const rulePath = `${propertyPath}.rules[${i}]`;
    validatedRules.push(validateSmartFilterRule(rule, rulePath, configPath, 0));
  }

  const separation =
    rawFilter["separation"] === undefined
      ? undefined
      : validateSeparationConfig(rawFilter["separation"], `${propertyPath}.separation`, configPath);

  return {
    match,
    rules: validatedRules,
    ...(separation !== undefined && { separation }),
  };
}

/**
 * Validates FiltersConfigOptions (named smart filter definitions).
 */
function validateFiltersConfig(raw: unknown, configPath: string): FiltersConfigOptions {
  // Filters section must be an object (not array)
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `Expected object for filters, got ${describeType(raw)}`,
      configPath,
      "filters",
    );
  }

  const rawFilters = raw as Record<string, unknown>;
  const config: FiltersConfigOptions = {};

  // Iterate over filter name keys
  for (const [name, filter] of Object.entries(rawFilters)) {
    const filterPath = `filters.${name}`;
    config[name] = validateSmartFilter(filter, filterPath, configPath);
  }

  return config;
}

// ============================================================================
// Plex Filter Validation
// ============================================================================

/**
 * Valid filter fields for Plex smart filter validation.
 *
 * Field availability varies by media type:
 * - artistRating: Works on all types (artist, album, track)
 * - albumRating: Works on albums and tracks only
 * - trackRating: Works on tracks only
 * - genre: Genre tag string
 * - mood: Mood tag string (works on all types)
 * - style: Style tag string (works on artists and albums only)
 * - year: Exact release year
 * - minYear/maxYear: Year range filters
 * - minPlays: Minimum play count
 * - artist/album/title: Text search fields
 */
const VALID_PLEX_FILTER_FIELDS = [
  "album",
  "albumRating",
  "artist",
  "artistRating",
  "genre",
  "maxYear",
  "minPlays",
  "minYear",
  "mood",
  "style",
  "title",
  "trackRating",
  "year",
] as const;
type ValidPlexFilterField = (typeof VALID_PLEX_FILTER_FIELDS)[number];

/**
 * Valid filter operators for Plex smart filter validation.
 */
const VALID_PLEX_FILTER_OPERATORS = [">=", "<=", "==", "!=", "contains", "not_contains"] as const;
type ValidPlexFilterOperator = (typeof VALID_PLEX_FILTER_OPERATORS)[number];

/**
 * Rating fields that support numeric comparison operators.
 */
const PLEX_RATING_FIELDS: ValidPlexFilterField[] = ["artistRating", "albumRating", "trackRating"];

/**
 * Numeric fields that support >=, <=, ==, != operators.
 */
const PLEX_NUMERIC_FIELDS: ValidPlexFilterField[] = [
  "artistRating",
  "albumRating",
  "trackRating",
  "year",
  "minYear",
  "maxYear",
  "minPlays",
];

/**
 * Text fields that support contains, not_contains, ==, and != operators.
 */
const PLEX_TEXT_FIELDS: ValidPlexFilterField[] = [
  "album",
  "artist",
  "genre",
  "mood",
  "style",
  "title",
];

/**
 * Validates that a value is a valid Plex filter field.
 */
function validatePlexFilterField(
  value: unknown,
  propertyPath: string,
  configPath: string,
): ValidPlexFilterField {
  if (
    typeof value !== "string" ||
    !VALID_PLEX_FILTER_FIELDS.includes(value as ValidPlexFilterField)
  ) {
    throw new ConfigError(
      `Invalid Plex filter field for ${propertyPath}: ${value}. Valid fields: ${VALID_PLEX_FILTER_FIELDS.join(", ")}`,
      configPath,
      propertyPath,
    );
  }
  return value as ValidPlexFilterField;
}

/**
 * Validates that a value is a valid Plex filter operator.
 */
function validatePlexFilterOperator(
  value: unknown,
  propertyPath: string,
  configPath: string,
): ValidPlexFilterOperator {
  if (
    typeof value !== "string" ||
    !VALID_PLEX_FILTER_OPERATORS.includes(value as ValidPlexFilterOperator)
  ) {
    throw new ConfigError(
      `Invalid Plex filter operator for ${propertyPath}: ${value}. Valid operators: ${VALID_PLEX_FILTER_OPERATORS.join(", ")}`,
      configPath,
      propertyPath,
    );
  }
  return value as ValidPlexFilterOperator;
}

/**
 * Validates field/operator compatibility for Plex filters.
 *
 * - Rating fields (artistRating, albumRating, trackRating): Support >=, <=, ==, !=
 * - Numeric fields (year, minYear, maxYear, minPlays): Support >=, <=, ==, !=
 * - Text fields (genre, artist, album, title): Support contains, not_contains, ==, !=
 */
function validatePlexFieldOperatorCompatibility(
  field: ValidPlexFilterField,
  operator: ValidPlexFilterOperator,
  propertyPath: string,
  configPath: string,
): void {
  const isTextField = PLEX_TEXT_FIELDS.includes(field);
  const isNumericField = PLEX_NUMERIC_FIELDS.includes(field);

  if (isTextField) {
    // Text fields support 'contains', 'not_contains', '==', '!='
    if (
      operator !== "contains" &&
      operator !== "not_contains" &&
      operator !== "==" &&
      operator !== "!="
    ) {
      throw new ConfigError(
        `Invalid operator '${operator}' for text field '${field}' at ${propertyPath}. ` +
          `Text fields support: contains, not_contains, ==, !=`,
        configPath,
        propertyPath,
      );
    }
  } else if (isNumericField) {
    // Numeric fields support '>=', '<=', '==', '!=' (not 'contains' or 'not_contains')
    if (operator === "contains" || operator === "not_contains") {
      throw new ConfigError(
        `Invalid operator '${operator}' for numeric field '${field}' at ${propertyPath}. ` +
          `Numeric fields support: >=, <=, ==, !=`,
        configPath,
        propertyPath,
      );
    }
  }
}

/**
 * Validates a Plex filter value based on the field type.
 *
 * - Rating fields: number (1-5 star scale)
 * - Year fields: number (positive integer)
 * - minPlays: number (non-negative integer)
 * - Text fields: non-empty string
 */
function validatePlexFilterValue(
  value: unknown,
  field: ValidPlexFilterField,
  propertyPath: string,
  configPath: string,
): string | number {
  const isRatingField = PLEX_RATING_FIELDS.includes(field);
  const isTextField = PLEX_TEXT_FIELDS.includes(field);

  if (isRatingField) {
    // Rating fields: 1-5 star scale
    if (typeof value !== "number" || value < 1 || value > 5) {
      throw new ConfigError(
        `Expected number between 1 and 5 (star rating) for ${propertyPath}, got ${value}`,
        configPath,
        propertyPath,
      );
    }
    return value;
  }

  if (isTextField) {
    // Text fields: non-empty string
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigError(
        `Expected non-empty string for ${propertyPath}, got ${describeType(value)}`,
        configPath,
        propertyPath,
      );
    }
    return value;
  }

  // Numeric fields (year, minYear, maxYear, minPlays)
  if (field === "minPlays") {
    // minPlays: non-negative integer
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new ConfigError(
        `Expected non-negative integer for ${propertyPath}, got ${value}`,
        configPath,
        propertyPath,
      );
    }
    return value;
  }

  // year, minYear, maxYear: positive integer (reasonable year range)
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1000 || value > 9999) {
    throw new ConfigError(
      `Expected valid year (1000-9999) for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates a Plex filter rule (type: 'rule').
 *
 * @param rawRule - Raw rule object to validate
 * @param propertyPath - Property path for error messages
 * @param configPath - Path to the config file
 * @returns Validated PlexFilterRule
 */
function validatePlexFilterRuleLeaf(
  rawRule: Record<string, unknown>,
  propertyPath: string,
  configPath: string,
): PlexFilterRule {
  // Validate type discriminator
  if (rawRule["type"] !== "rule") {
    throw new ConfigError(
      `Expected type 'rule' at ${propertyPath}.type, got ${rawRule["type"]}`,
      configPath,
      `${propertyPath}.type`,
    );
  }

  // Validate required field 'field'
  if (!("field" in rawRule) || rawRule["field"] === undefined) {
    throw new ConfigError(
      `Missing required field 'field' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const field = validatePlexFilterField(rawRule["field"], `${propertyPath}.field`, configPath);

  // Validate required field 'operator'
  if (!("operator" in rawRule) || rawRule["operator"] === undefined) {
    throw new ConfigError(
      `Missing required field 'operator' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const operator = validatePlexFilterOperator(
    rawRule["operator"],
    `${propertyPath}.operator`,
    configPath,
  );

  // Validate field/operator compatibility
  validatePlexFieldOperatorCompatibility(field, operator, propertyPath, configPath);

  // Validate required field 'value'
  if (!("value" in rawRule) || rawRule["value"] === undefined) {
    throw new ConfigError(
      `Missing required field 'value' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const value = validatePlexFilterValue(
    rawRule["value"],
    field,
    `${propertyPath}.value`,
    configPath,
  );

  return {
    type: "rule",
    field,
    operator,
    value,
  };
}

/**
 * Validates a Plex filter group (type: 'group').
 *
 * @param rawGroup - Raw group object to validate
 * @param propertyPath - Property path for error messages
 * @param configPath - Path to the config file
 * @param depth - Current nesting depth
 * @returns Validated PlexFilterGroup
 */
function validatePlexFilterGroupNode(
  rawGroup: Record<string, unknown>,
  propertyPath: string,
  configPath: string,
  depth: number,
): PlexFilterGroup {
  // Validate type discriminator
  if (rawGroup["type"] !== "group") {
    throw new ConfigError(
      `Expected type 'group' at ${propertyPath}.type, got ${rawGroup["type"]}`,
      configPath,
      `${propertyPath}.type`,
    );
  }

  // Validate required field 'match'
  if (!("match" in rawGroup) || rawGroup["match"] === undefined) {
    throw new ConfigError(
      `Missing required field 'match' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const match = validateMatchType(rawGroup["match"], `${propertyPath}.match`, configPath);

  // Validate required field 'rules' (must be non-empty array)
  if (!("rules" in rawGroup) || rawGroup["rules"] === undefined) {
    throw new ConfigError(
      `Missing required field 'rules' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  if (!Array.isArray(rawGroup["rules"])) {
    throw new ConfigError(
      `Expected array for ${propertyPath}.rules, got ${describeType(rawGroup["rules"])}`,
      configPath,
      `${propertyPath}.rules`,
    );
  }
  if (rawGroup["rules"].length === 0) {
    throw new ConfigError(
      `Rules array cannot be empty at ${propertyPath}.rules`,
      configPath,
      `${propertyPath}.rules`,
    );
  }

  // Recursively validate each rule in the group
  const validatedRules: PlexSmartFilterRule[] = [];
  for (let i = 0; i < rawGroup["rules"].length; i++) {
    const rule = rawGroup["rules"][i];
    const rulePath = `${propertyPath}.rules[${i}]`;
    validatedRules.push(validatePlexSmartFilterRule(rule, rulePath, configPath, depth + 1));
  }

  return {
    type: "group",
    match,
    rules: validatedRules,
  };
}

/**
 * Validates a Plex smart filter rule recursively.
 * Handles both leaf rules (type: 'rule') and nested groups (type: 'group').
 *
 * @param raw - Raw rule object to validate
 * @param propertyPath - Property path for error messages
 * @param configPath - Path to the config file
 * @param depth - Current nesting depth (for stack overflow prevention)
 * @returns Validated PlexSmartFilterRule
 * @throws ConfigError if validation fails or depth exceeds MAX_FILTER_DEPTH
 */
function validatePlexSmartFilterRule(
  raw: unknown,
  propertyPath: string,
  configPath: string,
  depth: number = 0,
): PlexSmartFilterRule {
  // Check depth limit to prevent stack overflow
  if (depth >= MAX_FILTER_DEPTH) {
    throw new ConfigError(
      `Plex filter nesting depth exceeds maximum of ${MAX_FILTER_DEPTH} at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }

  // Rule must be an object
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `Expected object for ${propertyPath}, got ${describeType(raw)}`,
      configPath,
      propertyPath,
    );
  }

  const rawRule = raw as Record<string, unknown>;

  // Check for discriminator 'type' field
  if (!("type" in rawRule) || rawRule["type"] === undefined) {
    throw new ConfigError(
      `Missing required field 'type' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }

  const ruleType = rawRule["type"];

  if (ruleType === "rule") {
    // Validate leaf rule (PlexFilterRule)
    return validatePlexFilterRuleLeaf(rawRule, propertyPath, configPath);
  } else if (ruleType === "group") {
    // Validate nested group (PlexFilterGroup)
    return validatePlexFilterGroupNode(rawRule, propertyPath, configPath, depth);
  } else {
    throw new ConfigError(
      `Invalid rule type for ${propertyPath}.type: ${ruleType}. Expected 'rule' or 'group'`,
      configPath,
      `${propertyPath}.type`,
    );
  }
}

/**
 * Valid Plex media types for filter validation.
 */
const VALID_PLEX_MEDIA_TYPES = ["track", "album", "artist"] as const;

/**
 * Validates a PlexSmartFilter (top-level filter with match, rules, and optional defaults).
 *
 * @param raw - Raw filter object to validate
 * @param propertyPath - Property path for error messages
 * @param configPath - Path to the config file
 * @returns Validated PlexSmartFilter
 */
function validatePlexSmartFilter(
  raw: unknown,
  propertyPath: string,
  configPath: string,
): PlexSmartFilter {
  // Filter must be an object
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `Expected object for ${propertyPath}, got ${describeType(raw)}`,
      configPath,
      propertyPath,
    );
  }

  const rawFilter = raw as Record<string, unknown>;

  // Validate required field 'match'
  if (!("match" in rawFilter) || rawFilter["match"] === undefined) {
    throw new ConfigError(
      `Missing required field 'match' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  const match = validateMatchType(rawFilter["match"], `${propertyPath}.match`, configPath);

  // Validate required field 'rules' (must be non-empty array)
  if (!("rules" in rawFilter) || rawFilter["rules"] === undefined) {
    throw new ConfigError(
      `Missing required field 'rules' at ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  if (!Array.isArray(rawFilter["rules"])) {
    throw new ConfigError(
      `Expected array for ${propertyPath}.rules, got ${describeType(rawFilter["rules"])}`,
      configPath,
      `${propertyPath}.rules`,
    );
  }
  if (rawFilter["rules"].length === 0) {
    throw new ConfigError(
      `Rules array cannot be empty at ${propertyPath}.rules`,
      configPath,
      `${propertyPath}.rules`,
    );
  }

  // Recursively validate each rule
  const validatedRules: PlexSmartFilterRule[] = [];
  for (let i = 0; i < rawFilter["rules"].length; i++) {
    const rule = rawFilter["rules"][i];
    const rulePath = `${propertyPath}.rules[${i}]`;
    validatedRules.push(validatePlexSmartFilterRule(rule, rulePath, configPath, 0));
  }

  const result: PlexSmartFilter = {
    match,
    rules: validatedRules,
  };

  // Validate optional field 'library'
  if ("library" in rawFilter && rawFilter["library"] !== undefined) {
    result.library = validateString(rawFilter["library"], `${propertyPath}.library`, configPath);
  }

  // Validate optional field 'type'
  if ("type" in rawFilter && rawFilter["type"] !== undefined) {
    const typeValue = rawFilter["type"];
    if (
      typeof typeValue !== "string" ||
      !VALID_PLEX_MEDIA_TYPES.includes(typeValue as PlexMediaType)
    ) {
      throw new ConfigError(
        `Invalid Plex media type for ${propertyPath}.type: ${typeValue}. ` +
          `Valid types: ${VALID_PLEX_MEDIA_TYPES.join(", ")}`,
        configPath,
        `${propertyPath}.type`,
      );
    }
    result.type = typeValue as PlexMediaType;
  }

  // Validate optional field 'limit'
  if ("limit" in rawFilter && rawFilter["limit"] !== undefined) {
    result.limit = validatePositiveInteger(rawFilter["limit"], `${propertyPath}.limit`, configPath);
  }

  return result;
}

/**
 * Validates PlexFiltersConfigOptions (named Plex smart filter definitions).
 *
 * @param raw - Raw config object to validate
 * @param configPath - Path to the config file
 * @returns Validated PlexFiltersConfigOptions
 */
function validatePlexFiltersConfig(raw: unknown, configPath: string): PlexFiltersConfigOptions {
  // plexFilters section must be an object (not array)
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `Expected object for plexFilters, got ${describeType(raw)}`,
      configPath,
      "plexFilters",
    );
  }

  const rawFilters = raw as Record<string, unknown>;
  const config: PlexFiltersConfigOptions = {};

  // Iterate over filter name keys
  for (const [name, filter] of Object.entries(rawFilters)) {
    // Validate filter name is a valid non-empty string
    if (name.trim() === "") {
      throw new ConfigError(
        `Invalid filter name: filter names cannot be empty`,
        configPath,
        "plexFilters",
      );
    }

    const filterPath = `plexFilters.${name}`;
    config[name] = validatePlexSmartFilter(filter, filterPath, configPath);
  }

  return config;
}

/**
 * Validates an ExternalCommandPluginConfig object.
 *
 * @param raw - Raw command config object
 * @param propertyPath - Property path for error messages (e.g., "plugins.commands[0]")
 * @param configPath - Path to the config file
 * @returns Validated ExternalCommandPluginConfig
 */
function validateExternalCommandPluginConfig(
  raw: unknown,
  propertyPath: string,
  configPath: string,
): ExternalCommandPluginConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `Expected object for ${propertyPath}, got ${describeType(raw)}`,
      configPath,
      propertyPath,
    );
  }

  const rawObj = raw as Record<string, unknown>;

  // Validate required 'name' field
  if (!("name" in rawObj) || rawObj["name"] === undefined) {
    throw new ConfigError(
      `Missing required field 'name' for ${propertyPath}`,
      configPath,
      `${propertyPath}.name`,
    );
  }
  const name = validateString(rawObj["name"], `${propertyPath}.name`, configPath);

  // Validate required 'command' field
  if (!("command" in rawObj) || rawObj["command"] === undefined) {
    throw new ConfigError(
      `Missing required field 'command' for ${propertyPath}`,
      configPath,
      `${propertyPath}.command`,
    );
  }
  const command = validateString(rawObj["command"], `${propertyPath}.command`, configPath);

  // Validate optional 'args' field (array of strings)
  let args: string[] | undefined;
  if ("args" in rawObj && rawObj["args"] !== undefined) {
    args = validateStringArray(rawObj["args"], `${propertyPath}.args`, configPath);
  }

  // Validate optional 'timeout' field (positive integer)
  let timeout: number | undefined;
  if ("timeout" in rawObj && rawObj["timeout"] !== undefined) {
    timeout = validatePositiveInteger(rawObj["timeout"], `${propertyPath}.timeout`, configPath);
  }

  // Validate required 'hooks' field
  if (!("hooks" in rawObj) || rawObj["hooks"] === undefined) {
    throw new ConfigError(
      `Missing required field 'hooks' for ${propertyPath}`,
      configPath,
      `${propertyPath}.hooks`,
    );
  }

  const hooksRaw = rawObj["hooks"];
  if (hooksRaw === null || typeof hooksRaw !== "object" || Array.isArray(hooksRaw)) {
    throw new ConfigError(
      `Expected object for ${propertyPath}.hooks, got ${describeType(hooksRaw)}`,
      configPath,
      `${propertyPath}.hooks`,
    );
  }

  const hooksObj = hooksRaw as Record<string, unknown>;

  // At least one hook must be enabled
  const hasAfterCopy = "afterCopy" in hooksObj && hooksObj["afterCopy"] !== undefined;
  const hasAfterBatch = "afterBatch" in hooksObj && hooksObj["afterBatch"] !== undefined;

  if (!hasAfterCopy && !hasAfterBatch) {
    throw new ConfigError(
      `At least one hook must be enabled in ${propertyPath}.hooks (afterCopy or afterBatch)`,
      configPath,
      `${propertyPath}.hooks`,
    );
  }

  // Validate hook values (boolean or string)
  const hooks: ExternalCommandPluginConfig["hooks"] = {};

  if (hasAfterCopy) {
    const afterCopyValue = hooksObj["afterCopy"];
    if (typeof afterCopyValue !== "boolean" && typeof afterCopyValue !== "string") {
      throw new ConfigError(
        `Expected boolean or string for ${propertyPath}.hooks.afterCopy, got ${describeType(afterCopyValue)}`,
        configPath,
        `${propertyPath}.hooks.afterCopy`,
      );
    }
    hooks.afterCopy = afterCopyValue;
  }

  if (hasAfterBatch) {
    const afterBatchValue = hooksObj["afterBatch"];
    if (typeof afterBatchValue !== "boolean" && typeof afterBatchValue !== "string") {
      throw new ConfigError(
        `Expected boolean or string for ${propertyPath}.hooks.afterBatch, got ${describeType(afterBatchValue)}`,
        configPath,
        `${propertyPath}.hooks.afterBatch`,
      );
    }
    hooks.afterBatch = afterBatchValue;
  }

  const result: ExternalCommandPluginConfig = {
    name,
    command,
    hooks,
  };

  if (args !== undefined) {
    result.args = args;
  }

  if (timeout !== undefined) {
    result.timeout = timeout;
  }

  return result;
}

/**
 * Validates PluginsConfigOptions.
 *
 * @param raw - Raw plugins config to validate
 * @param configPath - Path to the config file
 * @returns Validated PluginsConfigOptions or undefined if not present
 */
function validatePluginsConfig(raw: unknown, configPath: string): PluginsConfigOptions | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `Expected object for plugins, got ${describeType(raw)}`,
      configPath,
      "plugins",
    );
  }

  const rawObj = raw as Record<string, unknown>;
  const config: PluginsConfigOptions = {};

  // Validate optional 'enabled' field
  if ("enabled" in rawObj && rawObj["enabled"] !== undefined) {
    config.enabled = validateBoolean(rawObj["enabled"], "plugins.enabled", configPath);
  }

  // Validate optional 'directory' field with path normalization
  if ("directory" in rawObj && rawObj["directory"] !== undefined) {
    const directory = validateString(rawObj["directory"], "plugins.directory", configPath);
    // Normalize path: expand ~ to home directory
    config.directory = directory.startsWith("~") ? directory.replace(/^~/, homedir()) : directory;
  }

  // Validate optional 'additionalDirectories' field
  if ("additionalDirectories" in rawObj && rawObj["additionalDirectories"] !== undefined) {
    const dirs = validateStringArray(
      rawObj["additionalDirectories"],
      "plugins.additionalDirectories",
      configPath,
    );
    // Normalize paths: expand ~ to home directory
    config.additionalDirectories = dirs.map((dir) =>
      dir.startsWith("~") ? dir.replace(/^~/, homedir()) : dir,
    );
  }

  // Validate optional 'disabled' field
  if ("disabled" in rawObj && rawObj["disabled"] !== undefined) {
    config.disabled = validateStringArray(rawObj["disabled"], "plugins.disabled", configPath);
  }

  // Validate optional 'commands' field (array of external command configs)
  if ("commands" in rawObj && rawObj["commands"] !== undefined) {
    const commandsRaw = rawObj["commands"];
    if (!Array.isArray(commandsRaw)) {
      throw new ConfigError(
        `Expected array for plugins.commands, got ${describeType(commandsRaw)}`,
        configPath,
        "plugins.commands",
      );
    }

    config.commands = commandsRaw.map((cmd, index) =>
      validateExternalCommandPluginConfig(cmd, `plugins.commands[${index}]`, configPath),
    );
  }

  return config;
}

/**
 * Validates a raw config object and returns a typed ConfigFile.
 *
 * @param raw - Raw parsed JSON object
 * @param configPath - Path to the config file (for error messages)
 * @returns Validated ConfigFile
 * @throws ConfigError if validation fails
 */
export function validateConfig(raw: unknown, configPath: string): ConfigFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("Config must be a JSON object", configPath);
  }

  const rawObj = raw as Record<string, unknown>;
  const config: ConfigFile = {};

  if ("copy" in rawObj && rawObj["copy"] !== undefined) {
    if (
      typeof rawObj["copy"] !== "object" ||
      rawObj["copy"] === null ||
      Array.isArray(rawObj["copy"])
    ) {
      throw new ConfigError("copy must be an object", configPath, "copy");
    }
    config.copy = validateCopyConfig(rawObj["copy"] as Record<string, unknown>, configPath);
  }

  if ("clean" in rawObj && rawObj["clean"] !== undefined) {
    if (
      typeof rawObj["clean"] !== "object" ||
      rawObj["clean"] === null ||
      Array.isArray(rawObj["clean"])
    ) {
      throw new ConfigError("clean must be an object", configPath, "clean");
    }
    config.clean = validateCleanConfig(rawObj["clean"] as Record<string, unknown>, configPath);
  }

  if ("watch" in rawObj && rawObj["watch"] !== undefined) {
    if (
      typeof rawObj["watch"] !== "object" ||
      rawObj["watch"] === null ||
      Array.isArray(rawObj["watch"])
    ) {
      throw new ConfigError("watch must be an object", configPath, "watch");
    }
    config.watch = validateWatchConfig(rawObj["watch"] as Record<string, unknown>, configPath);
  }

  if ("global" in rawObj && rawObj["global"] !== undefined) {
    if (
      typeof rawObj["global"] !== "object" ||
      rawObj["global"] === null ||
      Array.isArray(rawObj["global"])
    ) {
      throw new ConfigError("global must be an object", configPath, "global");
    }
    config.global = validateGlobalConfig(rawObj["global"] as Record<string, unknown>, configPath);
  }

  if ("plex" in rawObj && rawObj["plex"] !== undefined) {
    if (
      typeof rawObj["plex"] !== "object" ||
      rawObj["plex"] === null ||
      Array.isArray(rawObj["plex"])
    ) {
      throw new ConfigError("plex must be an object", configPath, "plex");
    }
    config.plex = validatePlexConfigOptions(rawObj["plex"] as Record<string, unknown>, configPath);
  }

  if ("lidarr" in rawObj && rawObj["lidarr"] !== undefined) {
    if (
      typeof rawObj["lidarr"] !== "object" ||
      rawObj["lidarr"] === null ||
      Array.isArray(rawObj["lidarr"])
    ) {
      throw new ConfigError("lidarr must be an object", configPath, "lidarr");
    }
    config.lidarr = validateLidarrConfigOptions(
      rawObj["lidarr"] as Record<string, unknown>,
      configPath,
    );
  }

  if ("discovery" in rawObj && rawObj["discovery"] !== undefined) {
    if (
      typeof rawObj["discovery"] !== "object" ||
      rawObj["discovery"] === null ||
      Array.isArray(rawObj["discovery"])
    ) {
      throw new ConfigError("discovery must be an object", configPath, "discovery");
    }
    config.discovery = validateDiscoveryConfigOptions(
      rawObj["discovery"] as Record<string, unknown>,
      configPath,
    );
  }

  if ("policy" in rawObj && rawObj["policy"] !== undefined) {
    if (
      typeof rawObj["policy"] !== "object" ||
      rawObj["policy"] === null ||
      Array.isArray(rawObj["policy"])
    ) {
      throw new ConfigError("policy must be an object", configPath, "policy");
    }
    config.policy = validatePolicyConfigOptions(
      rawObj["policy"] as Record<string, unknown>,
      configPath,
    );
  }

  if ("undo" in rawObj && rawObj["undo"] !== undefined) {
    if (
      typeof rawObj["undo"] !== "object" ||
      rawObj["undo"] === null ||
      Array.isArray(rawObj["undo"])
    ) {
      throw new ConfigError("undo must be an object", configPath, "undo");
    }
    config.undo = validateUndoConfig(rawObj["undo"] as Record<string, unknown>, configPath);
  }

  if ("linkVideos" in rawObj && rawObj["linkVideos"] !== undefined) {
    if (
      typeof rawObj["linkVideos"] !== "object" ||
      rawObj["linkVideos"] === null ||
      Array.isArray(rawObj["linkVideos"])
    ) {
      throw new ConfigError("linkVideos must be an object", configPath, "linkVideos");
    }
    config.linkVideos = validateLinkVideosConfig(
      rawObj["linkVideos"] as Record<string, unknown>,
      configPath,
    );
  }

  if ("tracking" in rawObj && rawObj["tracking"] !== undefined) {
    if (
      typeof rawObj["tracking"] !== "object" ||
      rawObj["tracking"] === null ||
      Array.isArray(rawObj["tracking"])
    ) {
      throw new ConfigError("tracking must be an object", configPath, "tracking");
    }
    config.tracking = validateTrackingConfig(
      rawObj["tracking"] as Record<string, unknown>,
      configPath,
    );
  }

  if ("filters" in rawObj && rawObj["filters"] !== undefined) {
    // Check is object, not array
    if (
      typeof rawObj["filters"] !== "object" ||
      rawObj["filters"] === null ||
      Array.isArray(rawObj["filters"])
    ) {
      throw new ConfigError("filters must be an object", configPath, "filters");
    }
    config.filters = validateFiltersConfig(rawObj["filters"], configPath);
  }

  if ("plexFilters" in rawObj && rawObj["plexFilters"] !== undefined) {
    if (
      typeof rawObj["plexFilters"] !== "object" ||
      rawObj["plexFilters"] === null ||
      Array.isArray(rawObj["plexFilters"])
    ) {
      throw new ConfigError(
        "plexFilters must be an object mapping filter names to filter definitions",
        configPath,
        "plexFilters",
      );
    }
    config.plexFilters = validatePlexFiltersConfig(rawObj["plexFilters"], configPath);
  }

  if ("interactive" in rawObj && rawObj["interactive"] !== undefined) {
    if (
      typeof rawObj["interactive"] !== "object" ||
      rawObj["interactive"] === null ||
      Array.isArray(rawObj["interactive"])
    ) {
      throw new ConfigError("interactive must be an object", configPath, "interactive");
    }
    config.interactive = validateInteractiveConfig(
      rawObj["interactive"] as Record<string, unknown>,
      configPath,
    );
  }

  if ("plugins" in rawObj && rawObj["plugins"] !== undefined) {
    config.plugins = validatePluginsConfig(rawObj["plugins"], configPath);
  }

  return config;
}

/**
 * Resolve only the provider origins needed to identify cached reconciliation evidence.
 *
 * This runs after parsing so unresolved credential templates remain inert strings.
 */
function resolveOfflineReconcileOrigins(raw: unknown, configPath: string): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }

  const root = raw as Record<string, unknown>;
  for (const [sectionName, fieldName] of [
    ["plex", "url"],
    ["lidarr", "baseUrl"],
  ] as const) {
    const section = root[sectionName];
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      continue;
    }

    const fieldValue = (section as Record<string, unknown>)[fieldName];
    if (typeof fieldValue === "string") {
      try {
        (section as Record<string, unknown>)[fieldName] = injectSecrets(fieldValue, { configPath });
      } catch (error) {
        if (!(error instanceof SecretsInjectionError)) {
          throw error;
        }
        // Omit an unavailable configured origin so validation succeeds and an explicit CLI
        // origin can override it without discarding unrelated offline configuration.
        delete (section as Record<string, unknown>)[fieldName];
      }
    }
  }

  return raw;
}

/**
 * Loads configuration from the first valid config file found.
 *
 * Supports both JSON and YAML formats. YAML files (.yaml, .yml) have higher
 * priority than JSON equivalents in each search location.
 *
 * Searches paths in priority order:
 * 1. CWD (.rfmedia.yaml, .rfmedia.yml, .rfmedia.json)
 * 2. ~/.config/rfmedia/ (config.yaml, config.yml, config.json)
 * 3. Home directory (.rfmedia.yaml, .rfmedia.yml, .rfmedia.json)
 *
 * Returns an empty config if no valid config is found.
 * Logs warnings for invalid JSON/YAML or validation errors and continues searching.
 *
 * @param options - Controls secret expansion and whether the first existing file is authoritative.
 * @returns ConfigLoadResult with the loaded config and metadata
 */
export async function loadConfig(
  options: Readonly<{ resolveSecrets?: boolean; failOnInvalid?: boolean }> = {},
): Promise<ConfigLoadResult> {
  const resolveSecrets = options.resolveSecrets !== false;
  const failOnInvalid = options.failOnInvalid === true;

  // Strict callers always inspect the authoritative file. They neither consume
  // nor populate the permissive cache, so fallback behavior cannot erase a veto.
  if (resolveSecrets && !failOnInvalid && (await isConfigCacheValid())) {
    const cached = getConfigCache();
    if (cached) {
      return {
        config: cached.result.config,
        loadedFrom: cached.result.loadedFrom,
        searchedPaths: [...cached.result.searchedPaths],
      };
    }
  }

  const searchPaths = getConfigSearchPaths();

  for (const configPath of searchPaths) {
    // Permissive discovery preserves the historical fallback behavior. Strict
    // callers read candidates directly so only ENOENT can mean "not present".
    if (!failOnInvalid && !(await pathExists(configPath))) {
      logDebug(`Config not found: ${configPath}`);
      continue;
    }

    try {
      const content = await readFile(configPath, "utf-8");

      // Validate config file size before processing
      validateConfigSize(content, configPath);

      // Offline origin-only consumers deliberately preserve template strings so
      // provider credential outages cannot block access to cached evidence.
      const processedContent = resolveSecrets ? injectSecrets(content, { configPath }) : content;

      // Warn about any unresolved or malformed templates
      if (resolveSecrets) {
        if (failOnInvalid && hasUnresolvedTemplates(processedContent)) {
          throw new ConfigError(
            `Unresolved or malformed template in config file: ${configPath}`,
            configPath,
          );
        }
        warnUnresolvedTemplates(processedContent, configPath);
      }

      // Parse JSON or YAML based on file extension
      let raw: unknown;
      const ext = extname(configPath).toLowerCase();
      const format = ext === ".yaml" || ext === ".yml" ? "YAML" : "JSON";
      try {
        if (ext === ".yaml" || ext === ".yml") {
          raw = yaml.load(processedContent, { schema: yaml.CORE_SCHEMA });
        } else {
          raw = JSON.parse(processedContent);
        }
      } catch {
        if (failOnInvalid) {
          throw new ConfigError(`Invalid ${format} in config file: ${configPath}`, configPath);
        }
        logWarn(`Invalid ${format} in config file: ${configPath}`);
        continue;
      }

      if (!resolveSecrets) {
        raw = resolveOfflineReconcileOrigins(raw, configPath);
      }

      // Validate config
      const config = validateConfig(raw, configPath);
      logDebug(`Loaded config from: ${configPath}`);

      const result: ConfigLoadResult = {
        config,
        loadedFrom: configPath,
        searchedPaths: searchPaths,
      };

      if (resolveSecrets && !failOnInvalid) {
        await updateConfigCache(result, configPath);
      }

      return result;
    } catch (err) {
      // Re-throw SecretsInjectionError to halt execution immediately
      if (err instanceof SecretsInjectionError) {
        throw err;
      }
      if (failOnInvalid) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
          try {
            await lstat(configPath);
          } catch (inspectionError) {
            if (
              typeof inspectionError === "object" &&
              inspectionError !== null &&
              "code" in inspectionError &&
              inspectionError.code === "ENOENT"
            ) {
              logDebug(`Config not found: ${configPath}`);
              continue;
            }
            throw new ConfigError(
              `Unable to inspect config file: ${configPath}`,
              configPath,
              undefined,
              { cause: inspectionError },
            );
          }
        }
        if (err instanceof ConfigError) {
          throw err;
        }
        throw new ConfigError(`Unable to read config file: ${configPath}`, configPath, undefined, {
          cause: err,
        });
      }
      if (err instanceof ConfigError) {
        logWarn(`Config validation error in ${err.configPath}: ${err.message}`);
        continue;
      }
      // For unexpected errors, log and continue
      logWarn(`Error reading config file ${configPath}: ${(err as Error).message}`);
      continue;
    }
  }

  // No config found, return empty config
  logDebug("No config file found, using defaults");
  return {
    config: {},
    searchedPaths: searchPaths,
  };
}

/**
 * Builds a configuration template object with all available options.
 *
 * Options that require user-specific values are set to null to indicate they exist
 * but need user configuration. Users can replace with actual values or remove if not needed.
 *
 * @returns ConfigFile template object
 */
export function buildConfigTemplate(): ConfigFile {
  return {
    copy: {
      outputFolder: "liked-songs",
      hardlink: false,
      force: false,
      convertFormat: null as unknown as undefined,
      workers: 4,
      progress: true,
      albumOnly: false,
      preserveStructure: false,
      albumMode: false,
      trackCompleted: false,
      // Minimum star rating for filter mode (1.0-5.0, supports half-stars like 3.5)
      // Precision limited by audio format (MP3 POPM: ~0.02 stars, FLAC: arbitrary)
      minStars: null as unknown as undefined,
      minRating: null as unknown as undefined,
      deleteDowngraded: true,
      range: null as unknown as undefined,
      minDuration: null as unknown as undefined,
      maxDuration: null as unknown as undefined,
      minBitrate: null as unknown as undefined,
      codec: null as unknown as undefined,
      minPlays: null as unknown as undefined,
      diskSpaceMargin: 5,
      requireDiskSpace: false,
    },
    clean: {
      force: false,
      minFiles: 1,
      exclude: [],
      protect: null as unknown as undefined,
      useTrash: false,
      olderThan: null as unknown as undefined,
      depth: null as unknown as undefined,
    },
    watch: {
      outputFolder: "liked-songs",
      hardlink: false,
      debounceMs: 5000,
      albumOnly: false,
      preserveStructure: false,
    },
    linkVideos: {
      minScore: 70,
      preferredFormat: "mkv",
      progress: true,
    },
    global: {
      debug: false,
    },
    plex: {
      url: "http://localhost:32400",
      token: "YOUR_PLEX_TOKEN",
      scanAfterCopy: false,
      libraryName: "Music",
      defaultFilters: {
        minRating: null as unknown as undefined,
        genre: null as unknown as undefined,
        minPlays: null as unknown as undefined,
        excludeGenres: [],
      },
      playlistDefaults: {
        smart: false,
        updateExisting: false,
      },
      syncDefaults: {
        prefer: "plex" as const,
        onlyRated: false,
        popmEmail: null as unknown as undefined,
        vorbisScale: null as unknown as undefined,
      },
      cache: {
        enabled: false,
        ttlSeconds: 300,
      },
    },
    undo: {
      enabled: true,
      retentionDays: 30,
      maxSizeMB: 100,
      historyPath: null as unknown as undefined,
    },
    tracking: {
      database: null as unknown as undefined,
      useLegacy: false,
    },
    // Example smart filter - users can add their own named filters
    filters: {
      liked: {
        match: "all",
        rules: [
          {
            type: "rule",
            field: "rating",
            operator: ">=",
            value: 3.0,
          },
        ],
      },
    },
    // Interactive selection UI configuration
    interactive: {
      artistPageSize: DEFAULT_INTERACTIVE_CONFIG.artistPageSize,
      albumPageSize: DEFAULT_INTERACTIVE_CONFIG.albumPageSize,
      trackPageSize: DEFAULT_INTERACTIVE_CONFIG.trackPageSize,
    },
  };
}

/**
 * Generates a configuration file template in JSON format.
 *
 * @returns JSON string with formatted config template
 * @deprecated Use generateYamlConfigTemplate() for new configs
 */
export function generateConfigTemplate(): string {
  const template = buildConfigTemplate();
  return JSON.stringify(template, null, 2) + "\n";
}

/**
 * Generates a configuration file template in YAML format.
 *
 * YAML is the preferred format as it's more human-readable and supports comments.
 *
 * @returns YAML string with formatted config template
 */
export function generateYamlConfigTemplate(): string {
  const template = buildConfigTemplate();
  return yaml.dump(template, {
    indent: 2,
    lineWidth: -1, // Don't wrap lines
    quotingType: '"',
    forceQuotes: false,
    skipInvalid: true,
    noRefs: true,
  });
}

const INIT_FILTER_EXAMPLES_COMMENT_HEADER = "# --- rfmedia init filter examples (commented) ---";
const INIT_FILTER_EXAMPLES_COMMENT_FOOTER = "# --- end rfmedia init filter examples ---";

const INIT_PLEX_FILTER_EXAMPLE: PlexFiltersConfigOptions = {
  "example-high-rated": {
    match: "all",
    library: "Music",
    type: "track",
    rules: [
      {
        type: "rule",
        field: "trackRating",
        operator: ">=",
        value: 4,
      },
    ],
  },
};

function hasOwnKey(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** True if value is a non-null plain object (not array). Used to avoid preserving null filter sections on merge. */
function isValidFilterSectionValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildCommentedFilterExamples(template: ConfigFile): string {
  const examples: Record<string, unknown> = {};
  if (template.filters !== undefined) {
    examples["filters"] = template.filters;
  }
  examples["plexFilters"] = INIT_PLEX_FILTER_EXAMPLE;

  const exampleYaml = yaml.dump(examples, {
    indent: 2,
    lineWidth: -1, // Don't wrap lines
    quotingType: '"',
    forceQuotes: false,
    skipInvalid: true,
    noRefs: true,
  });

  const commentedYaml = exampleYaml
    .trimEnd()
    .split("\n")
    .map((line) => (line.length > 0 ? `# ${line}` : "#"))
    .join("\n");

  return (
    `${INIT_FILTER_EXAMPLES_COMMENT_HEADER}\n` +
    "# Uncomment and adapt these examples if you want starter filters.\n" +
    `${commentedYaml}\n` +
    `${INIT_FILTER_EXAMPLES_COMMENT_FOOTER}\n`
  );
}

function appendCommentedFilterExamples(outputYaml: string, template: ConfigFile): string {
  if (outputYaml.includes(INIT_FILTER_EXAMPLES_COMMENT_HEADER)) {
    return outputYaml.endsWith("\n") ? outputYaml : `${outputYaml}\n`;
  }

  const separator = outputYaml.endsWith("\n") ? "\n" : "\n\n";
  return `${outputYaml}${separator}${buildCommentedFilterExamples(template)}`;
}

/**
 * Deep merges two objects, with existing values taking precedence over template values.
 * This allows new properties from the template to be added while preserving user's existing values.
 *
 * @param existingObj - Existing object (values take precedence)
 * @param templateObj - Template object (provides new properties)
 * @param sectionName - Optional section name for debug logging
 * @returns Merged object
 */
function deepMergeObjects<T>(
  existingObj: T | undefined,
  templateObj: T | undefined,
  sectionName?: string,
): T | undefined {
  if (templateObj === undefined) {
    return existingObj;
  }
  if (existingObj === undefined) {
    return templateObj;
  }

  // Start with template values, then overlay existing values
  const merged = { ...templateObj };

  for (const key of Object.keys(existingObj as object)) {
    const existingValue = (existingObj as Record<string, unknown>)[key];
    const templateValue = (templateObj as Record<string, unknown>)[key];

    // If both are objects (but not arrays), recurse
    if (
      existingValue !== null &&
      typeof existingValue === "object" &&
      !Array.isArray(existingValue) &&
      templateValue !== null &&
      typeof templateValue === "object" &&
      !Array.isArray(templateValue)
    ) {
      (merged as Record<string, unknown>)[key] = deepMergeObjects(
        existingValue as Record<string, unknown>,
        templateValue as Record<string, unknown>,
        sectionName ? `${sectionName}.${key}` : key,
      );
    } else {
      // Existing value takes precedence
      const logKey = sectionName ? `${sectionName}.${key}` : key;
      if (existingValue !== templateValue) {
        const safeExistingValue = isSensitiveFieldName(key)
          ? "[REDACTED]"
          : redactSensitiveFields(existingValue);
        const safeTemplateValue = isSensitiveFieldName(key)
          ? "[REDACTED]"
          : redactSensitiveFields(templateValue);
        logDebug(
          `Config merge: ${logKey} = ${JSON.stringify(safeExistingValue)} (existing) over ${JSON.stringify(safeTemplateValue)} (template)`,
        );
      }
      (merged as Record<string, unknown>)[key] = existingValue;
    }
  }

  return merged;
}

/**
 * Deep merges two config objects, with existing values taking precedence over template values.
 * This allows new properties from the template to be added while preserving user's existing config.
 *
 * @param existing - Existing user configuration
 * @param template - Template configuration with all default values
 * @returns Merged configuration
 */
export function mergeConfigs(existing: ConfigFile, template: ConfigFile): ConfigFile {
  logDebug("Merging config sections...");

  // Merge all top-level keys so unknown/custom sections are preserved.
  const mergedRoot = deepMergeObjects(
    existing as Record<string, unknown>,
    template as Record<string, unknown>,
  ) as Record<string, unknown>;
  const result = mergedRoot as ConfigFile;
  const existingRecord = existing as Record<string, unknown>;

  // Filters section: preserve only when existing value is a valid object (not null/bare key).
  // We don't deep merge filters because that would mix user-defined filters with example filters.
  if (
    hasOwnKey(existingRecord, "filters") &&
    isValidFilterSectionValue(existingRecord["filters"])
  ) {
    result.filters = existingRecord["filters"] as ConfigFile["filters"];
    logDebug("Config merge: preserving existing filters section");
  } else if (template.filters) {
    result.filters = template.filters;
    logDebug("Config merge: using template filters section (user has none or invalid value)");
  }

  // Plex filters section: preserve only when existing value is a valid object (not null/bare key).
  // Avoid deep merge to prevent mixing user-defined filters with template examples.
  if (
    hasOwnKey(existingRecord, "plexFilters") &&
    isValidFilterSectionValue(existingRecord["plexFilters"])
  ) {
    result.plexFilters = existingRecord["plexFilters"] as ConfigFile["plexFilters"];
    logDebug("Config merge: preserving existing plexFilters section");
  } else if (hasOwnKey(existingRecord, "plexFilters")) {
    result.plexFilters = template.plexFilters;
    logDebug(
      "Config merge: existing plexFilters invalid (null/non-object), using template or omitting",
    );
  }

  return result;
}

/**
 * Loads existing config file as raw object without validation.
 * Supports both JSON and YAML formats based on file extension.
 * Used for merging with template.
 *
 * @param path - Path to the config file
 * @returns Parsed config object or null if file doesn't exist or is invalid
 */
export async function loadExistingConfigRaw(path: string): Promise<ConfigFile | null> {
  if (!(await pathExists(path))) {
    return null;
  }

  try {
    const content = await readFile(path, "utf-8");
    const ext = extname(path).toLowerCase();

    // Parse based on file extension
    let raw: unknown;
    if (ext === ".yaml" || ext === ".yml") {
      raw = yaml.load(content, { schema: yaml.CORE_SCHEMA });
    } else {
      raw = JSON.parse(content);
    }

    // Basic type check - must be an object
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      logWarn(`Existing config is not a valid object: ${path}`);
      return null;
    }

    return raw as ConfigFile;
  } catch (err) {
    const ext = extname(path).toLowerCase();
    const format = ext === ".yaml" || ext === ".yml" ? "YAML" : "JSON";
    logWarn(`Failed to parse existing ${format} config: ${path}`);
    return null;
  }
}

/**
 * Writes a configuration template to the specified path.
 *
 * Supports both JSON and YAML output formats. The format is determined by the
 * file extension (.yaml/.yml for YAML, .json for JSON). YAML is the preferred
 * format for new configurations.
 *
 * @param path - Path to write the config file
 * @param force - If true, overwrite existing file
 * @param merge - If true, merge template with existing config (default: true)
 * @throws Error if file exists and force is false (and merge is false)
 */
export async function writeConfigTemplate(
  path: string,
  force: boolean,
  merge: boolean = true,
): Promise<{ merged: boolean }> {
  const fileExists = await pathExists(path);

  // Check if file exists and handle force/merge flags
  if (fileExists) {
    if (!force && !merge) {
      throw new Error(`Config file already exists: ${path}. Use --force to overwrite.`);
    }
  }

  // Ensure parent directory exists
  const parentDir = dirname(path);
  await mkdir(parentDir, { recursive: true });

  // Build template config directly (no parsing needed)
  const templateConfig = buildConfigTemplate();

  let outputConfig: ConfigFile;
  let wasMerged = false;
  let hasExistingFilterSections = false;

  // If merge is enabled and file exists, merge with existing config
  if (merge && fileExists) {
    const existingConfig = await loadExistingConfigRaw(path);
    if (existingConfig) {
      hasExistingFilterSections =
        hasOwnKey(existingConfig as object, "filters") ||
        hasOwnKey(existingConfig as object, "plexFilters");
      logDebug(`Existing config loaded from: ${path}`);
      logDebug(`Existing config sections: ${Object.keys(existingConfig).join(", ")}`);
      outputConfig = mergeConfigs(existingConfig, templateConfig);
      wasMerged = true;
      logDebug(`Merged existing config with template: ${path}`);
    } else {
      // Existing config couldn't be loaded, use template
      outputConfig = templateConfig;
      logDebug(`Could not load existing config, using template: ${path}`);
    }
  } else {
    outputConfig = templateConfig;
    if (fileExists) {
      logDebug(`Overwriting existing config (merge disabled): ${path}`);
    }
  }

  // Determine output format from file extension
  const ext = extname(path).toLowerCase();
  const isYaml = ext === ".yaml" || ext === ".yml";

  // Write output in appropriate format
  let output = isYaml
    ? yaml.dump(outputConfig, {
        indent: 2,
        lineWidth: -1, // Don't wrap lines
        quotingType: '"',
        forceQuotes: false,
        skipInvalid: true,
        noRefs: true,
      })
    : JSON.stringify(outputConfig, null, 2) + "\n";

  // Preserve user filter sections and provide commented examples for YAML configs.
  if (isYaml && merge && wasMerged && hasExistingFilterSections) {
    output = appendCommentedFilterExamples(output, templateConfig);
  }

  await writeFile(path, output, "utf-8");

  return { merged: wasMerged };
}

/**
 * Resolves a file path, expanding ~ to home directory.
 *
 * @param filePath - File path to resolve
 * @returns Resolved absolute path
 */
function expandPath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return join(homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return homedir();
  }
  return resolve(filePath);
}

/**
 * Resolves the undo database path from configuration.
 *
 * Priority order:
 * 1. undo.database from config
 * 2. tracking.database from config
 * 3. Default path via getDefaultDatabasePath() which searches:
 *    - ~/.config/rfmedia/tracking.db (XDG standard)
 *    - ~/.rfmedia/tracking.db (legacy location)
 *
 * @param config - Configuration file
 * @returns Resolved absolute database path
 */
export function resolveUndoDatabasePath(config: ConfigFile): string {
  // Priority 1: undo.database
  if (config.undo?.database) {
    return expandPath(config.undo.database);
  }

  // Priority 2: tracking.database (share database)
  if (config.tracking?.database) {
    return expandPath(config.tracking.database);
  }

  // Priority 3: Default path from db module (searches XDG then legacy)
  return getDefaultDatabasePath();
}

/**
 * Determines if legacy JSONL mode should be used for undo/history.
 *
 * @param config - Configuration file
 * @returns True if legacy mode should be used
 */
export function shouldUseUndoLegacyMode(config: ConfigFile): boolean {
  return config.undo?.useLegacy ?? false;
}

/**
 * Gets allowed library roots from config or environment variable.
 *
 * Environment variable `RFMEDIA_PLEX_LIBRARY_ROOTS` takes precedence over config.
 * The environment variable should be a comma-separated list of paths.
 *
 * @param config - Configuration file (can be null)
 * @returns Array of allowed library root paths (empty means no filtering)
 */
export function getAllowedLibraryRoots(config: ConfigFile | null): string[] {
  // Check env first (takes precedence)
  const envRoots = process.env["RFMEDIA_PLEX_LIBRARY_ROOTS"];
  if (envRoots) {
    const roots = envRoots
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    logDebug(`Using allowedLibraryRoots from env: ${JSON.stringify(roots)}`);
    return roots;
  }
  // Fall back to config
  const roots = config?.plex?.allowedLibraryRoots ?? [];
  logDebug(`Using allowedLibraryRoots from config: ${JSON.stringify(roots)}`);
  return roots;
}

/**
 * Gets interactive configuration from loaded config, merging with defaults.
 * Always returns a complete InteractiveConfig with all required fields.
 *
 * @param config - Configuration file (can be null or undefined)
 * @returns Complete InteractiveConfig with defaults applied
 */
export function getInteractiveConfig(config: ConfigFile | null | undefined): InteractiveConfig {
  if (!config?.interactive) {
    return { ...DEFAULT_INTERACTIVE_CONFIG };
  }

  return {
    artistPageSize: config.interactive.artistPageSize ?? DEFAULT_INTERACTIVE_CONFIG.artistPageSize,
    albumPageSize: config.interactive.albumPageSize ?? DEFAULT_INTERACTIVE_CONFIG.albumPageSize,
    trackPageSize: config.interactive.trackPageSize ?? DEFAULT_INTERACTIVE_CONFIG.trackPageSize,
  };
}
