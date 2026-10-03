/**
 * YAML-based paths file parser for rfmedia CLI.
 *
 * Parses YAML files containing destination and source paths with optional
 * range/count configurations. Provides a single-file alternative to combining
 * --file with positional arguments.
 *
 * @example
 * ```yaml
 * destination: /data/media/music-manual
 * sources:
 *   - path: /data/media/music/Artist Name (uuid)
 *     count: 5
 *   - path: /data/media/music/Another Artist (uuid)
 *     range: 001-003
 * ```
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { logDebug } from "./logger.js";
import { isValidRange, tryParseRange } from "./range.js";
import { requireFfmpeg } from "./convert.js";
import { getLoadedConfig } from "./loaded-config.js";
import { LookupNotFoundError } from "./errors.js";
import { findClosestMatch } from "./fuzzy-match.js";
import type {
  ConvertFormat,
  PathEntry,
  PathsYamlFile,
  PathsYamlSource,
  PathsYamlDefaults,
  ParsedPathsYaml,
} from "../types/index.js";

/**
 * Valid audio conversion formats.
 */
const VALID_CONVERT_FORMATS = ["alac", "mp3", "aac", "opus"] as const;

/**
 * Custom error class for paths YAML parsing errors.
 */
export class PathsYamlError extends Error {
  /** Path to the YAML file that caused the error */
  readonly filePath: string;

  constructor(message: string, filePath: string) {
    super(message);
    this.name = "PathsYamlError";
    this.filePath = filePath;
  }
}

/**
 * Validates that a value is a non-empty string.
 *
 * @param value - Value to validate
 * @param fieldName - Field name for error messages
 * @param filePath - Path to the YAML file for error context
 * @throws PathsYamlError if validation fails
 */
function validateString(value: unknown, fieldName: string, filePath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PathsYamlError(`Expected non-empty string for '${fieldName}'`, filePath);
  }
  return value.trim();
}

/**
 * Validates that a value is a positive integer.
 *
 * @param value - Value to validate
 * @param fieldName - Field name for error messages
 * @param filePath - Path to the YAML file for error context
 * @throws PathsYamlError if validation fails
 */
function validatePositiveInteger(value: unknown, fieldName: string, filePath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PathsYamlError(
      `Expected positive integer for '${fieldName}', got ${value}`,
      filePath,
    );
  }
  return value;
}

/**
 * Validates and parses a range string (e.g., "001-005").
 *
 * @param value - Range string to validate
 * @param context - Context for error messages (e.g., "source index 0" or "defaults")
 * @param filePath - Path to the YAML file for error context
 * @returns Parsed CopyRange
 * @throws PathsYamlError if validation fails
 */
function validateRangeString(
  value: unknown,
  context: string,
  filePath: string,
): PathEntry["range"] {
  if (typeof value !== "string") {
    throw new PathsYamlError(
      `Expected string for 'range' at ${context}, got ${typeof value}`,
      filePath,
    );
  }

  if (!isValidRange(value)) {
    throw new PathsYamlError(
      `Invalid range format at ${context}: "${value}". Expected format: START-END (e.g., "001-005")`,
      filePath,
    );
  }

  const parsed = tryParseRange(value);
  if (!parsed) {
    throw new PathsYamlError(`Failed to parse range at ${context}: "${value}"`, filePath);
  }

  return parsed;
}

/**
 * Validates a convert format string.
 *
 * @param value - Convert format to validate
 * @param context - Context for error messages
 * @param filePath - Path to the YAML file for error context
 * @returns Validated convert format
 * @throws PathsYamlError if validation fails
 */
function validateConvertFormat(value: unknown, context: string, filePath: string): ConvertFormat {
  if (typeof value !== "string") {
    throw new PathsYamlError(
      `Expected string for 'convert' at ${context}, got ${typeof value}`,
      filePath,
    );
  }

  const format = value.toLowerCase().trim();
  if (!VALID_CONVERT_FORMATS.includes(format as (typeof VALID_CONVERT_FORMATS)[number])) {
    throw new PathsYamlError(
      `Invalid convert format at ${context}: "${value}". Valid formats: ${VALID_CONVERT_FORMATS.join(", ")}`,
      filePath,
    );
  }

  return format as ConvertFormat;
}

/**
 * Validates an optional string field (filter, outputFolder).
 *
 * @param value - Value to validate
 * @param fieldName - Field name for error messages
 * @param context - Context for error messages
 * @param filePath - Path to the YAML file for error context
 * @returns Validated string or undefined
 * @throws PathsYamlError if validation fails
 */
function validateOptionalString(
  value: unknown,
  fieldName: string,
  context: string,
  filePath: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PathsYamlError(
      `Expected string for '${fieldName}' at ${context}, got ${typeof value}`,
      filePath,
    );
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  return trimmed;
}

/**
 * Validates the defaults section of the YAML file.
 *
 * @param defaults - Raw defaults object from YAML
 * @param filePath - Path to the YAML file for error context
 * @returns Validated PathsYamlDefaults
 * @throws PathsYamlError if validation fails
 */
function validateDefaults(defaults: unknown, filePath: string): PathsYamlDefaults {
  if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new PathsYamlError("Field 'defaults' must be an object", filePath);
  }

  const defaultsObj = defaults as Record<string, unknown>;
  const result: PathsYamlDefaults = {};

  // Validate optional 'filter'
  if ("filter" in defaultsObj && defaultsObj["filter"] !== undefined) {
    result.filter = validateOptionalString(defaultsObj["filter"], "filter", "defaults", filePath);
  }

  // Validate optional 'count'
  if ("count" in defaultsObj && defaultsObj["count"] !== undefined) {
    result.count = validatePositiveInteger(defaultsObj["count"], "defaults.count", filePath);
  }

  // Validate optional 'range'
  if ("range" in defaultsObj && defaultsObj["range"] !== undefined) {
    // Store as string, validate format
    if (typeof defaultsObj["range"] !== "string") {
      throw new PathsYamlError(
        `Expected string for 'range' in defaults, got ${typeof defaultsObj["range"]}`,
        filePath,
      );
    }
    validateRangeString(defaultsObj["range"], "defaults", filePath);
    result.range = defaultsObj["range"];
  }

  // Validate optional 'outputFolder'
  if ("outputFolder" in defaultsObj && defaultsObj["outputFolder"] !== undefined) {
    result.outputFolder = validateOptionalString(
      defaultsObj["outputFolder"],
      "outputFolder",
      "defaults",
      filePath,
    );
  }

  // Validate optional 'convert'
  if ("convert" in defaultsObj && defaultsObj["convert"] !== undefined) {
    result.convert = validateConvertFormat(defaultsObj["convert"], "defaults", filePath);
  }

  // Check for mutually exclusive count/range
  if (result.count !== undefined && result.range !== undefined) {
    throw new PathsYamlError(
      "Defaults section has both 'count' and 'range' - use only one",
      filePath,
    );
  }

  return result;
}

/**
 * Validates a single source entry from the YAML file.
 *
 * @param source - Raw source object from YAML
 * @param index - Source index for error messages
 * @param filePath - Path to the YAML file for error context
 * @returns Validated PathsYamlSource
 * @throws PathsYamlError if validation fails
 */
function validateSource(source: unknown, index: number, filePath: string): PathsYamlSource {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new PathsYamlError(`Source at index ${index} must be an object`, filePath);
  }

  const sourceObj = source as Record<string, unknown>;
  const context = `source index ${index}`;

  // Validate required 'path' field
  if (!("path" in sourceObj) || sourceObj["path"] === undefined) {
    throw new PathsYamlError(`Source at index ${index} missing required field 'path'`, filePath);
  }
  const path = validateString(sourceObj["path"], `sources[${index}].path`, filePath);

  // Validate optional 'count' and 'range' are mutually exclusive
  const hasCount = "count" in sourceObj && sourceObj["count"] !== undefined;
  const hasRange = "range" in sourceObj && sourceObj["range"] !== undefined;

  if (hasCount && hasRange) {
    throw new PathsYamlError(
      `Source at index ${index} has both 'count' and 'range' - use only one`,
      filePath,
    );
  }

  const result: PathsYamlSource = { path };

  // Validate optional 'count'
  if (hasCount) {
    result.count = validatePositiveInteger(sourceObj["count"], `sources[${index}].count`, filePath);
  }

  // Validate optional 'range'
  if (hasRange) {
    result.range = sourceObj["range"] as string;
    // Validate range format (will throw if invalid)
    validateRangeString(sourceObj["range"], context, filePath);
  }

  // Validate optional 'filter'
  if ("filter" in sourceObj && sourceObj["filter"] !== undefined) {
    result.filter = validateOptionalString(sourceObj["filter"], "filter", context, filePath);
  }

  // Validate optional 'outputFolder'
  if ("outputFolder" in sourceObj && sourceObj["outputFolder"] !== undefined) {
    result.outputFolder = validateOptionalString(
      sourceObj["outputFolder"],
      "outputFolder",
      context,
      filePath,
    );
  }

  // Validate optional 'convert'
  if ("convert" in sourceObj && sourceObj["convert"] !== undefined) {
    result.convert = validateConvertFormat(sourceObj["convert"], context, filePath);
  }

  // Validate optional 'groups' field (string or array of strings)
  if ("groups" in sourceObj && sourceObj["groups"] !== undefined) {
    const groupsValue = sourceObj["groups"];
    if (typeof groupsValue === "string") {
      const trimmed = groupsValue.trim();
      if (trimmed.length === 0) {
        throw new PathsYamlError(`Empty 'groups' at ${context}`, filePath);
      }
      result.groups = [trimmed];
    } else if (Array.isArray(groupsValue)) {
      if (groupsValue.length === 0) {
        throw new PathsYamlError(`Empty 'groups' array at ${context}`, filePath);
      }
      const groups: string[] = [];
      for (const item of groupsValue) {
        if (typeof item !== "string") {
          throw new PathsYamlError(
            `Invalid group in array at ${context}: expected string`,
            filePath,
          );
        }
        const trimmed = item.trim();
        if (trimmed.length === 0) {
          throw new PathsYamlError(`Invalid group in array at ${context}: empty string`, filePath);
        }
        groups.push(trimmed);
      }
      result.groups = groups;
    } else {
      throw new PathsYamlError(`'groups' must be string or array at ${context}`, filePath);
    }
  }

  // Preserve optional metadata fields (artist is used as fallback for name)
  if ("artist" in sourceObj && typeof sourceObj["artist"] === "string") {
    result.artist = sourceObj["artist"];
  }
  if ("type" in sourceObj && typeof sourceObj["type"] === "string") {
    result.type = sourceObj["type"];
  }
  if ("media" in sourceObj && typeof sourceObj["media"] === "string") {
    result.media = sourceObj["media"];
  }

  return result;
}

/**
 * Validates the raw YAML content.
 *
 * @param raw - Parsed YAML content
 * @param filePath - Path to the YAML file for error context
 * @returns Validated PathsYamlFile
 * @throws PathsYamlError if validation fails
 */
function validatePathsYaml(raw: unknown, filePath: string): PathsYamlFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PathsYamlError("Paths file must be a YAML object", filePath);
  }

  const rawObj = raw as Record<string, unknown>;

  // Validate required 'destination' field
  if (!("destination" in rawObj) || rawObj["destination"] === undefined) {
    throw new PathsYamlError("Missing required field 'destination' in paths file", filePath);
  }
  const destination = validateString(rawObj["destination"], "destination", filePath);

  // Validate optional 'defaults' field
  let defaults: PathsYamlDefaults | undefined;
  if ("defaults" in rawObj && rawObj["defaults"] !== undefined) {
    defaults = validateDefaults(rawObj["defaults"], filePath);
  }

  // Validate required 'sources' field
  if (!("sources" in rawObj) || rawObj["sources"] === undefined) {
    throw new PathsYamlError("Missing required field 'sources' in paths file", filePath);
  }

  if (!Array.isArray(rawObj["sources"])) {
    throw new PathsYamlError("Field 'sources' must be an array", filePath);
  }

  if (rawObj["sources"].length === 0) {
    throw new PathsYamlError("Sources array cannot be empty in paths file", filePath);
  }

  // Validate each source
  const sources: PathsYamlSource[] = [];
  for (let i = 0; i < rawObj["sources"].length; i++) {
    const source = rawObj["sources"][i];
    sources.push(validateSource(source, i, filePath));
  }

  return { destination, defaults, sources };
}

/**
 * Converts a PathsYamlSource to a PathEntry, merging with defaults.
 *
 * Per-source values take precedence over defaults.
 *
 * @param source - Source from YAML file
 * @param defaults - Default values from YAML file (if any)
 * @param index - Source index for logging
 * @returns PathEntry compatible with existing action handlers
 */
function convertToPathEntry(
  source: PathsYamlSource,
  defaults: PathsYamlDefaults | undefined,
  index: number,
): PathEntry {
  const entry: PathEntry = { path: source.path };

  // Merge count/range: per-source > defaults
  const effectiveCount = source.count ?? defaults?.count;
  const effectiveRange = source.range ?? defaults?.range;

  // count and range are mutually exclusive - per-source takes precedence
  if (source.count !== undefined) {
    entry.count = source.count;
    logDebug(`Source ${index}: ${source.path} with count ${source.count}`);
  } else if (source.range !== undefined) {
    // Parse range string to CopyRange
    const parsed = tryParseRange(source.range);
    if (parsed) {
      entry.range = parsed;
      logDebug(`Source ${index}: ${source.path} with range ${source.range}`);
    }
  } else if (effectiveCount !== undefined) {
    entry.count = effectiveCount;
    logDebug(`Source ${index}: ${source.path} with count ${effectiveCount} (from defaults)`);
  } else if (effectiveRange !== undefined) {
    // Parse range string to CopyRange
    const parsed = tryParseRange(effectiveRange);
    if (parsed) {
      entry.range = parsed;
      logDebug(`Source ${index}: ${source.path} with range ${effectiveRange} (from defaults)`);
    }
  } else {
    logDebug(`Source ${index}: ${source.path} (no range/count specified)`);
  }

  // Merge filter: per-source > defaults
  const effectiveFilter = source.filter ?? defaults?.filter;
  if (effectiveFilter !== undefined) {
    entry.filterName = effectiveFilter;
    const fromDefaults = source.filter === undefined && defaults?.filter !== undefined;
    logDebug(`Source ${index}: filter=${effectiveFilter}${fromDefaults ? " (from defaults)" : ""}`);
  }

  // Merge outputFolder: per-source > defaults
  const effectiveOutputFolder = source.outputFolder ?? defaults?.outputFolder;
  if (effectiveOutputFolder !== undefined) {
    entry.outputFolder = effectiveOutputFolder;
    const fromDefaults = source.outputFolder === undefined && defaults?.outputFolder !== undefined;
    logDebug(
      `Source ${index}: outputFolder=${effectiveOutputFolder}${fromDefaults ? " (from defaults)" : ""}`,
    );
  }

  // Merge convert: per-source > defaults
  const effectiveConvert = source.convert ?? defaults?.convert;
  if (effectiveConvert !== undefined) {
    entry.convertFormat = effectiveConvert;
    const fromDefaults = source.convert === undefined && defaults?.convert !== undefined;
    logDebug(
      `Source ${index}: convert=${effectiveConvert}${fromDefaults ? " (from defaults)" : ""}`,
    );
  }

  // Set sourceGroups for --group selection (from YAML groups field)
  const groups = Array.isArray(source.groups)
    ? source.groups
    : source.groups
      ? [source.groups]
      : undefined;
  if (groups && groups.length > 0) {
    entry.sourceGroups = groups;
  }

  // Set sourceArtist for --artist selection
  entry.sourceArtist = source.artist;

  // Set sourceNames for unified --source-name selection: groups + artist + basename(path)
  // This combines all searchable terms for case-insensitive contains matching
  const unifiedNames: string[] = [];
  if (groups && groups.length > 0) {
    unifiedNames.push(...groups);
  }
  if (source.artist) {
    unifiedNames.push(source.artist);
  }
  // Always include basename as fallback
  unifiedNames.push(path.basename(source.path));
  entry.sourceNames = unifiedNames;

  // Set 1-based sourceIndex for --source-idx selection
  entry.sourceIndex = index + 1;

  return entry;
}

/**
 * Parses a paths YAML file and returns the destination and sources.
 *
 * This function reads and validates a YAML file containing:
 * - destination: Output directory path
 * - defaults: Optional default options for all sources
 * - sources: Array of source paths with optional count/range/filter/etc
 *
 * @param filePath - Path to the YAML file
 * @returns Parsed result with destination and PathEntry array
 * @throws PathsYamlError if parsing or validation fails
 *
 * @example
 * ```typescript
 * const { destination, sources } = await parsePathsYaml('paths.yml');
 * // destination: '/data/media/music-manual'
 * // sources: [{ path: '/data/media/music/Artist', count: 5, filterName: 'liked' }, ...]
 * ```
 */
export async function parsePathsYaml(filePath: string): Promise<ParsedPathsYaml> {
  let content: string;

  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PathsYamlError(`Failed to read paths file: ${message}`, filePath);
  }

  let raw: unknown;
  try {
    raw = yaml.load(content, { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PathsYamlError(`Invalid YAML syntax: ${message}`, filePath);
  }

  // Validate structure
  const validated = validatePathsYaml(raw, filePath);

  // Log defaults if present
  if (validated.defaults) {
    const defaultsInfo: string[] = [];
    if (validated.defaults.filter) defaultsInfo.push(`filter=${validated.defaults.filter}`);
    if (validated.defaults.count) defaultsInfo.push(`count=${validated.defaults.count}`);
    if (validated.defaults.range) defaultsInfo.push(`range=${validated.defaults.range}`);
    if (validated.defaults.outputFolder)
      defaultsInfo.push(`outputFolder=${validated.defaults.outputFolder}`);
    if (validated.defaults.convert) defaultsInfo.push(`convert=${validated.defaults.convert}`);
    if (defaultsInfo.length > 0) {
      logDebug(`YAML defaults: ${defaultsInfo.join(", ")}`);
    }
  }

  // Convert sources to PathEntry format, merging with defaults
  const sources: PathEntry[] = validated.sources.map((source, index) =>
    convertToPathEntry(source, validated.defaults, index),
  );

  logDebug(`Parsed ${sources.length} source(s) from ${filePath}`);
  logDebug(`Destination: ${validated.destination}`);

  return {
    destination: validated.destination,
    sources,
  };
}

/**
 * Custom error class for source selection errors.
 */
export class SourceSelectionError extends Error {
  readonly selectionSummary?: string;
  readonly availableSources?: string;
  readonly suggestion?: string;

  constructor(
    message: string,
    options?: {
      selectionSummary?: string;
      availableSources?: string;
      suggestion?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "SourceSelectionError";
    this.selectionSummary = options?.selectionSummary;
    this.availableSources = options?.availableSources;
    this.suggestion = options?.suggestion;
  }
}

/**
 * Parses index selection string into an array of 1-based indices.
 *
 * Supports:
 * - Single indices: "1", "3", "5"
 * - Comma-separated: "1,3,5"
 * - Ranges: "2-5" (expands to 2,3,4,5)
 * - Mixed: "1,3-5,8" (expands to 1,3,4,5,8)
 *
 * @param selection - Index selection string
 * @param maxIndex - Maximum valid index (for bounds checking)
 * @returns Array of 1-based indices
 * @throws SourceSelectionError if format is invalid or indices out of bounds
 */
function parseIndexSelection(selection: string, maxIndex: number): number[] {
  const indices = new Set<number>();
  const parts = selection
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const part of parts) {
    // Check if it's a range (contains hyphen but not at start for negative numbers)
    if (part.includes("-") && !part.startsWith("-")) {
      const [startStr, endStr] = part.split("-");
      if (!startStr || !endStr) {
        throw new SourceSelectionError(
          `Invalid index range format: "${part}". Expected format: START-END (e.g., "2-5")`,
        );
      }

      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new SourceSelectionError(
          `Invalid index range: "${part}". Both start and end must be numbers.`,
        );
      }

      if (start < 1 || end < 1) {
        throw new SourceSelectionError(
          `Index out of bounds: "${part}". Indices must be 1 or greater (1-based indexing).`,
        );
      }

      if (start > end) {
        throw new SourceSelectionError(
          `Invalid index range: "${part}". Start (${start}) must be <= end (${end}).`,
        );
      }

      if (start > maxIndex || end > maxIndex) {
        throw new SourceSelectionError(
          `Index out of bounds: "${part}". Valid range is 1-${maxIndex}.`,
        );
      }

      for (let i = start; i <= end; i++) {
        indices.add(i);
      }
    } else {
      // Single index
      const index = parseInt(part, 10);

      if (Number.isNaN(index)) {
        throw new SourceSelectionError(`Invalid index: "${part}". Must be a positive integer.`);
      }

      if (index < 1) {
        throw new SourceSelectionError(
          `Index out of bounds: ${index}. Indices must be 1 or greater (1-based indexing).`,
        );
      }

      if (index > maxIndex) {
        throw new SourceSelectionError(
          `Index out of bounds: ${index}. Valid range is 1-${maxIndex}.`,
        );
      }

      indices.add(index);
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

/**
 * Filters sources by index, name, artist, or group selection.
 *
 * Selection filters are applied as intersection (AND logic):
 * - A source must match ALL specified filters to be included
 * - Within each filter type, values are OR'd (match any)
 *
 * @param sources - All parsed sources with sourceNames, sourceGroups, sourceArtist, and sourceIndex
 * @param indexSelection - Comma-separated indices or ranges (e.g., "1,3,5" or "2-5")
 * @param nameSelection - Unified search: case-insensitive contains match against groups + artist + basename
 * @param artistSelection - Artist-only: case-insensitive contains match against artist field
 * @param groupSelection - Group-only: case-insensitive contains match against groups field
 * @returns Filtered array of PathEntry
 * @throws SourceSelectionError if selection criteria are invalid or no matches found
 */
export function filterSourcesBySelection(
  sources: PathEntry[],
  indexSelection?: string,
  nameSelection?: string,
  artistSelection?: string,
  groupSelection?: string,
): PathEntry[] {
  if (!indexSelection && !nameSelection && !artistSelection && !groupSelection) {
    return sources;
  }

  let filtered: PathEntry[] = sources;

  // Filter by index selection
  if (indexSelection) {
    const selectedIndices = parseIndexSelection(indexSelection, sources.length);
    filtered = filtered.filter(
      (entry) => entry.sourceIndex !== undefined && selectedIndices.includes(entry.sourceIndex),
    );
    logDebug(`Index selection "${indexSelection}" matched ${filtered.length} source(s)`);
  }

  // Filter by unified name selection (case-insensitive contains against groups + artist + basename)
  if (nameSelection) {
    const names = nameSelection
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    if (names.length === 0) {
      throw new SourceSelectionError("Name selection is empty after parsing.");
    }

    filtered = filtered.filter((entry) => {
      const searchTerms = new Set<string>();
      if (entry.sourceNames) {
        for (const name of entry.sourceNames) {
          searchTerms.add(name.toLowerCase());
        }
      }
      if (entry.sourceArtist) {
        searchTerms.add(entry.sourceArtist.toLowerCase());
      }
      const basename = path.basename(entry.path).toLowerCase();
      searchTerms.add(basename);

      return names.some((name) => {
        for (const term of searchTerms) {
          if (term.includes(name)) {
            return true;
          }
        }
        return false;
      });
    });

    logDebug(`Name selection "${nameSelection}" matched ${filtered.length} source(s)`);
  }

  // Filter by artist selection (case-insensitive contains against artist field only)
  if (artistSelection) {
    const artists = artistSelection
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    if (artists.length === 0) {
      throw new SourceSelectionError("Artist selection is empty after parsing.");
    }

    filtered = filtered.filter((entry) => {
      if (!entry.sourceArtist) {
        return false;
      }
      const artistLower = entry.sourceArtist.toLowerCase();
      return artists.some((artist) => artistLower.includes(artist));
    });

    logDebug(`Artist selection "${artistSelection}" matched ${filtered.length} source(s)`);
  }

  // Filter by group selection (case-insensitive contains against groups field only)
  if (groupSelection) {
    const groups = groupSelection
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    if (groups.length === 0) {
      throw new SourceSelectionError("Group selection is empty after parsing.");
    }

    filtered = filtered.filter((entry) => {
      if (!entry.sourceGroups || entry.sourceGroups.length === 0) {
        return false;
      }
      const entryGroupsLower = entry.sourceGroups.map((g) => g.toLowerCase());
      return groups.some((group) => entryGroupsLower.some((eg) => eg.includes(group)));
    });

    logDebug(`Group selection "${groupSelection}" matched ${filtered.length} source(s)`);
  }

  return filtered;
}

/**
 * Formats available sources for error messages.
 *
 * @param sources - All sources to list
 * @returns Formatted string listing sources with their indices, groups, and artists
 */
export function formatAvailableSources(sources: PathEntry[]): string {
  const lines = sources.map((entry) => {
    const parts: string[] = [];

    // Show groups if available
    if (entry.sourceGroups && entry.sourceGroups.length > 0) {
      parts.push(`groups: ${entry.sourceGroups.join(", ")}`);
    }

    // Show artist if available
    if (entry.sourceArtist) {
      parts.push(`artist: ${entry.sourceArtist}`);
    }

    // Fallback to basename if no groups or artist
    const displayName = parts.length > 0 ? parts.join(", ") : path.basename(entry.path);
    return `  ${entry.sourceIndex}: ${displayName}`;
  });
  return lines.join("\n");
}

/**
 * Options for loading and validating a paths YAML file.
 */
export interface LoadPathsOptions {
  /** Path to the YAML file */
  pathsFile: string;
  /** Source index selection (e.g., "1,3-5") */
  sourceIdx?: string;
  /** Unified source name selection - matches groups, artist, and basename (e.g., "britney,pop-divas") */
  sourceName?: string;
  /** Artist-only selection - matches only the artist field (e.g., "britney,shakira") */
  sourceArtist?: string;
  /** Group-only selection - matches only the groups field (e.g., "pop-divas,rock-favorites") */
  sourceGroup?: string;
  /** Suppress informational logging in dry-run mode */
  dryRun?: boolean;
}

/**
 * Result from loading and validating a paths YAML file.
 */
export interface LoadPathsResult {
  /** Validated source entries (filtered if selection applied) */
  sourceEntries: PathEntry[];
  /** Destination path from YAML */
  destination: string;
  /** True if any source has a filter defined */
  hasYamlFilters: boolean;
  /** First filter name found (for auto-enabling filter mode) */
  firstFilterName?: string;
}

function buildSelectionSummary(options: LoadPathsOptions): string | undefined {
  const selectionParts: string[] = [];

  if (options.sourceIdx) {
    selectionParts.push(`--source-idx=${options.sourceIdx}`);
  }
  if (options.sourceName) {
    selectionParts.push(`--source-name=${options.sourceName}`);
  }
  if (options.sourceArtist) {
    selectionParts.push(`--artist=${options.sourceArtist}`);
  }
  if (options.sourceGroup) {
    selectionParts.push(`--group=${options.sourceGroup}`);
  }

  if (selectionParts.length === 0) {
    return undefined;
  }

  return selectionParts.join(", ");
}

function collectSelectorCandidates(
  sources: PathEntry[],
  selector: "name" | "artist" | "group",
): string[] {
  const values = new Set<string>();

  for (const source of sources) {
    if (selector === "name") {
      for (const name of source.sourceNames ?? []) {
        values.add(name);
      }
      values.add(path.basename(source.path));
      continue;
    }

    if (selector === "artist" && source.sourceArtist) {
      values.add(source.sourceArtist);
      continue;
    }

    if (selector === "group") {
      for (const group of source.sourceGroups ?? []) {
        values.add(group);
      }
    }
  }

  return Array.from(values);
}

function findSelectionSuggestion(query: string, candidates: string[]): string | undefined {
  const queries = query
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  for (const value of queries) {
    const match = findClosestMatch(value, candidates);
    if (match) {
      return match;
    }
  }

  return undefined;
}

/**
 * Loads, parses, and validates a paths YAML file.
 *
 * Performs all validation:
 * - Parses YAML structure
 * - Validates filter names exist in config
 * - Checks ffmpeg availability if any source has convert format
 * - Applies source selection filtering
 *
 * @param options - Load options with paths file and selection criteria
 * @returns LoadPathsResult on success
 */
export async function loadAndValidatePathsYaml(
  options: LoadPathsOptions,
): Promise<LoadPathsResult> {
  const { pathsFile, sourceIdx, sourceName, sourceArtist, sourceGroup } = options;

  const parsed = await parsePathsYaml(pathsFile);
  let sourceEntries = parsed.sources;
  const destination = parsed.destination;
  logDebug(`Loaded ${sourceEntries.length} source(s) from ${pathsFile}`);

  // Validate filter names from YAML exist in config
  const config = getLoadedConfig();
  const availableFilters = config.filters ?? {};
  const filterNames = Object.keys(availableFilters);

  for (const entry of sourceEntries) {
    if (entry.filterName && !availableFilters[entry.filterName]) {
      const suggestion = findClosestMatch(entry.filterName, filterNames);
      throw new LookupNotFoundError(
        "filter",
        entry.filterName,
        filterNames,
        suggestion,
        `source path: ${entry.path}`,
      );
    }
  }

  // Check if any source has a convert format that requires ffmpeg.
  // Throwing here lets the global formatter pipeline render guidance once.
  const hasPerSourceConvert = sourceEntries.some((entry) => entry.convertFormat);
  if (hasPerSourceConvert) {
    await requireFfmpeg();
  }

  // Auto-detect filter mode from YAML: if any source has a filter, enable filter mode
  const hasYamlFilters = sourceEntries.some((entry) => entry.filterName);
  const firstFilterName = hasYamlFilters
    ? sourceEntries.find((entry) => entry.filterName)?.filterName
    : undefined;

  // Apply source selection filtering (--source-idx, --source-name, --artist, --group)
  if (sourceIdx || sourceName || sourceArtist || sourceGroup) {
    const selectionSummary = buildSelectionSummary(options);
    const availableSources = formatAvailableSources(parsed.sources);

    try {
      sourceEntries = filterSourcesBySelection(
        sourceEntries,
        sourceIdx,
        sourceName,
        sourceArtist,
        sourceGroup,
      );
    } catch (error) {
      if (error instanceof SourceSelectionError) {
        throw new SourceSelectionError(error.message, {
          selectionSummary,
          availableSources,
          suggestion: error.suggestion,
          cause: error,
        });
      }
      throw error;
    }

    if (sourceEntries.length === 0) {
      const selectorCandidates =
        sourceName !== undefined
          ? collectSelectorCandidates(parsed.sources, "name")
          : sourceArtist !== undefined
            ? collectSelectorCandidates(parsed.sources, "artist")
            : sourceGroup !== undefined
              ? collectSelectorCandidates(parsed.sources, "group")
              : [];

      const suggestion =
        sourceName !== undefined
          ? findSelectionSuggestion(sourceName, selectorCandidates)
          : sourceArtist !== undefined
            ? findSelectionSuggestion(sourceArtist, selectorCandidates)
            : sourceGroup !== undefined
              ? findSelectionSuggestion(sourceGroup, selectorCandidates)
              : undefined;

      throw new SourceSelectionError("No sources matched the selection criteria.", {
        selectionSummary,
        availableSources,
        suggestion,
      });
    }
  }

  return {
    sourceEntries,
    destination,
    hasYamlFilters,
    firstFilterName,
  };
}
