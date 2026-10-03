/**
 * Rating reading and normalization utilities for rfmedia CLI.
 *
 * This module handles reading and normalizing ratings from various audio formats:
 * - MP3: POPM (Popularimeter) frames in ID3v2 tags (0-255 scale)
 * - FLAC: Vorbis Comment RATING field (0-5, 0-100, or 0-1 scale)
 * - M4A: iTunes metadata (limited support - ratings stored in database)
 *
 * All ratings are normalized to a 0.0-1.0 scale internally.
 */

import { parseFile } from "music-metadata";
import type { IAudioMetadata, IFormat } from "music-metadata";
import type {
  NormalizedRating,
  RatingFilter,
  RatingSource,
  SmartFilter,
  SmartFilterRule,
  FilterRule,
  FilterGroup,
  FilterField,
  FilterOperator,
} from "../types/index.js";
import type { ExtendedMetadata } from "./metadata.js";
import { logDebug, logWarn } from "./logger.js";

/**
 * Common POPM email identifiers used by different applications.
 * Used for fallback rating detection when the primary identifier is not found.
 */
const COMMON_POPM_EMAILS = [
  "Windows Media Player 9 Series",
  "MediaMonkey",
  "MusicBee",
  "no@email",
  "", // Some tools use empty string
] as const;

/**
 * POPM value representing an unrated track.
 * POPM 0 means unrated, NOT 0 stars.
 */
const POPM_UNRATED = 0;

/**
 * Read the rating from an audio file.
 * Returns null if the file is unrated or if the rating cannot be read.
 *
 * @param filePath - Absolute path to the audio file
 * @returns Normalized rating (0.0-1.0) or null if unrated
 */
export async function readRating(filePath: string): Promise<NormalizedRating | null> {
  try {
    const metadata = await parseFile(filePath, {
      skipCovers: true, // Skip cover art for performance
    });

    const rating = extractNormalizedRating(metadata, filePath);
    if (rating === null && isM4aOrAac(filePath)) {
      // iTunes stores ratings in database, not file metadata
      logDebug(
        `M4A rating: iTunes stores ratings in database, not file metadata. File: ${filePath}`,
      );
    }

    return rating;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to read rating from ${filePath}: ${message}`);
    return null;
  }
}

/**
 * Detect the rating source format based on file extension.
 */
function detectSourceFromFormat(filePath: string): RatingSource {
  const extension = filePath.toLowerCase().split(".").pop();
  switch (extension) {
    case "mp3":
      return "POPM";
    case "flac":
    case "ogg":
    case "opus":
      return "Vorbis";
    case "m4a":
    case "aac":
      return "iTunes";
    default:
      return "unknown";
  }
}

/**
 * Extract a normalized rating from already-parsed metadata.
 *
 * Supported native rating tags take precedence over music-metadata's common
 * projection because that projection can mis-scale native Vorbis ratings.
 * M4A/AAC ratings remain unsupported because iTunes ratings are not stored in
 * an interoperable file tag.
 */
export function extractNormalizedRating(
  metadata: Pick<IAudioMetadata, "common" | "native">,
  filePath: string,
): NormalizedRating | null {
  const extension = filePath.toLowerCase().split(".").pop();

  if (extension === "m4a" || extension === "aac") {
    return null;
  }

  if (extension === "mp3") {
    const nativeRating = readNativePopm(metadata.native);
    if (nativeRating !== null) {
      return nativeRating;
    }
  } else if (extension === "flac" || extension === "ogg" || extension === "opus") {
    const nativeRating = readNativeVorbisRating(metadata.native);
    if (nativeRating !== null) {
      return nativeRating;
    }
  }

  return readCommonRating(metadata.common.rating, filePath);
}

function isM4aOrAac(filePath: string): boolean {
  const extension = filePath.toLowerCase().split(".").pop();
  return extension === "m4a" || extension === "aac";
}

function readCommonRating(
  commonRatings: IAudioMetadata["common"]["rating"],
  filePath: string,
): NormalizedRating | null {
  const rating = commonRatings?.[0];
  if (
    rating?.rating === undefined ||
    !Number.isFinite(rating.rating) ||
    rating.rating <= 0 ||
    rating.rating > 1
  ) {
    return null;
  }

  return {
    value: rating.rating,
    source: detectSourceFromFormat(filePath),
    email: rating.source,
  };
}

interface PopmFrame {
  readonly email: string;
  readonly rating: number;
  readonly counter?: number;
}

/**
 * Read rating from native ID3v2 POPM frames.
 * Checks both ID3v2.3 and ID3v2.4 formats.
 */
function readNativePopm(nativeTags: IAudioMetadata["native"]): NormalizedRating | null {
  // Find all POPM frames
  const popmFrames: PopmFrame[] = [];

  for (const family of ["ID3v2.3", "ID3v2.4"] as const) {
    for (const tag of nativeTags[family] ?? []) {
      if (tag.id === "POPM") {
        const value = parsePopmFrame(tag.value);
        if (value !== null) {
          popmFrames.push(value);
        }
      }
    }
  }

  if (popmFrames.length === 0) {
    return null;
  }

  // Find the best rating (prefer known email identifiers)
  let bestPopm: PopmFrame | null = null;

  // First, look for ratings from common applications
  for (const email of COMMON_POPM_EMAILS) {
    const found = popmFrames.find((p) => p.email === email && p.rating > POPM_UNRATED);
    if (found) {
      bestPopm = found;
      break;
    }
  }

  // Fall back to any rating with a value > 0
  if (!bestPopm) {
    bestPopm = popmFrames.find((p) => p.rating > POPM_UNRATED) ?? null;
  }

  if (!bestPopm || bestPopm.rating === POPM_UNRATED) {
    return null;
  }

  return {
    value: popmToNormalized(bestPopm.rating),
    source: "POPM",
    email: bestPopm.email,
    counter: bestPopm.counter,
  };
}

function parsePopmFrame(value: unknown): PopmFrame | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("email" in value) ||
    !("rating" in value) ||
    typeof value.email !== "string" ||
    typeof value.rating !== "number" ||
    !Number.isFinite(value.rating) ||
    value.rating < POPM_UNRATED ||
    value.rating > 255
  ) {
    return null;
  }

  const counter = "counter" in value ? value.counter : undefined;
  if (counter !== undefined && (typeof counter !== "number" || !Number.isFinite(counter))) {
    return null;
  }

  return counter === undefined
    ? { email: value.email, rating: value.rating }
    : { email: value.email, rating: value.rating, counter };
}

/**
 * Read rating from native Vorbis Comment RATING field.
 * Handles multiple scale formats (0-5, 0-100, 0-1).
 */
function readNativeVorbisRating(nativeTags: IAudioMetadata["native"]): NormalizedRating | null {
  const vorbis = nativeTags["vorbis"];

  if (!vorbis) {
    return null;
  }

  // Look for RATING field (case-insensitive)
  for (const tag of vorbis) {
    if (tag.id.toUpperCase() === "RATING") {
      const value = parseFloat(String(tag.value));

      if (!Number.isFinite(value)) {
        continue;
      }

      // Detect scale and normalize
      const normalized = normalizeVorbisRating(value);

      if (normalized === null || normalized === 0) {
        continue;
      }

      return {
        value: normalized,
        source: "Vorbis",
      };
    }
  }

  return null;
}

/**
 * Normalize a Vorbis RATING value to 0-1 scale.
 * Detects the scale based on the value range:
 * - 0-1: Already normalized
 * - 0-5: Star rating scale
 * - 0-100: Percentage scale
 */
function normalizeVorbisRating(value: number): number | null {
  if (value < 0) {
    return null;
  }

  // Detect scale based on value
  if (value <= 1) {
    // Already 0-1 scale
    return value;
  } else if (value <= 5) {
    // 0-5 star scale
    return value / 5;
  } else if (value <= 100) {
    // 0-100 percentage scale
    return value / 100;
  }

  // Value out of expected range
  logDebug(`Unexpected Vorbis RATING value: ${value}`);
  return null;
}

/**
 * Convert a normalized rating (0-1) to star rating (0-5).
 * Preserves float precision for half-star support.
 *
 * @param rating - Normalized rating (0.0-1.0)
 * @returns Star rating (0.0-5.0)
 */
export function normalizedToStars(rating: number): number {
  return rating * 5;
}

/**
 * Convert a star rating (0-5) to normalized scale (0-1).
 *
 * @param stars - Star rating (0-5)
 * @returns Normalized rating (0.0-1.0)
 */
export function starsToNormalized(stars: number): number {
  return Math.max(0, Math.min(5, stars)) / 5;
}

/**
 * Convert a POPM rating (0-255) to normalized scale (0-1).
 * Note: POPM 0 indicates unrated, not 0 stars.
 * The actual rating range for rated tracks is 1-255.
 *
 * @param popm - POPM rating value (0-255)
 * @returns Normalized rating (0.0-1.0), or 0 if unrated
 */
export function popmToNormalized(popm: number): number {
  if (popm === POPM_UNRATED) {
    return 0;
  }
  // POPM 1-255 maps to 0-1 scale
  // Use 255 as max for simplicity (some apps use 1-254)
  return popm / 255;
}

/**
 * Convert a normalized rating (0-1) to POPM scale (0-255).
 * Returns 0 for unrated (normalized 0).
 *
 * @param normalized - Normalized rating (0.0-1.0)
 * @returns POPM rating value (0-255)
 */
export function normalizedToPopm(normalized: number): number {
  if (normalized === 0) {
    return POPM_UNRATED;
  }
  // Map 0-1 to 1-255 range
  return Math.round(normalized * 254) + 1;
}

/**
 * Convert a normalized rating (0-1) to Plex scale (0-10).
 * Plex uses 0-10 internally where 2 = 1 star, 4 = 2 stars, etc.
 *
 * @param rating - Normalized rating (0.0 to 1.0)
 * @returns Plex rating (0-10)
 */
export function normalizedToPlex(rating: number): number {
  if (rating <= 0) return 0; // Unrated
  return Math.round(rating * 10);
}

/**
 * Convert a Plex rating (0-10) to normalized scale (0-1).
 *
 * @param plexRating - Plex rating (0-10)
 * @returns Normalized rating (0.0 to 1.0)
 */
export function plexToNormalized(plexRating: number): number {
  if (plexRating <= 0) return 0; // Unrated
  return plexRating / 10;
}

/**
 * Check if a rating meets the threshold defined in the filter.
 * Handles both minStars and minRating filter options.
 *
 * @param rating - Normalized rating value (0.0-1.0)
 * @param filter - Rating filter configuration
 * @returns true if the rating meets the threshold
 */
export function meetsThreshold(rating: number, filter: RatingFilter): boolean {
  // Check star-based threshold
  if (filter.minStars !== undefined) {
    // Direct comparison on normalized scale for precision
    const normalizedThreshold = starsToNormalized(filter.minStars);
    return rating >= normalizedThreshold;
  }

  // Check normalized rating threshold (minRating is on 0-100 scale per type definition)
  if (filter.minRating !== undefined) {
    // Convert minRating from 0-100 percentage to 0-1 normalized
    const normalizedThreshold = filter.minRating / 100;
    return rating >= normalizedThreshold;
  }

  // No threshold specified - all ratings pass
  return true;
}

/**
 * Check if a play count meets the minimum threshold.
 *
 * @param counter - Play count from POPM frame (undefined for non-MP3 files)
 * @param minPlays - Minimum play count threshold (undefined = no filtering)
 * @returns true if the play count meets or exceeds the threshold
 */
export function meetsPlayCountThreshold(
  counter: number | undefined,
  minPlays: number | undefined,
): boolean {
  // No threshold specified - all files pass
  if (minPlays === undefined) return true;
  // Non-MP3 files (no counter) pass the filter
  if (counter === undefined) return true;
  // Check if counter meets threshold
  return counter >= minPlays;
}

// ============================================================================
// Duration Parsing and Metadata Filtering
// ============================================================================

/**
 * Parse duration string in MM:SS or M:SS format to seconds.
 *
 * @param duration - Duration string (e.g., "1:30", "10:00")
 * @returns Duration in seconds
 * @throws Error if format is invalid
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid duration format "${duration}". Expected MM:SS (e.g., "1:30")`);
  }
  const minutes = parseInt(match[1]!, 10);
  const seconds = parseInt(match[2]!, 10);
  if (seconds >= 60) {
    throw new Error(`Invalid seconds "${seconds}" in duration. Must be 00-59.`);
  }
  return minutes * 60 + seconds;
}

/**
 * Format duration in seconds to MM:SS string.
 *
 * @param seconds - Duration in seconds
 * @returns Formatted string in MM:SS format
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Result of checking if audio metadata meets filter criteria.
 */
export interface MetadataFilterResult {
  /** Whether the file passes all metadata filters */
  passes: boolean;
  /** Human-readable reason for filtering (when passes is false) */
  reason?: string;
}

/**
 * Check if audio file metadata meets the filter criteria.
 *
 * Checks duration, bitrate, and codec against filter settings.
 * Missing metadata values are treated as passing (undefined != filtered out).
 *
 * @param format - Audio format metadata from music-metadata
 * @param filter - Rating filter configuration with metadata filter options
 * @returns Object indicating whether the file passes and why if not
 */
export function meetsMetadataFilters(format: IFormat, filter: RatingFilter): MetadataFilterResult {
  // Duration checks (only apply if both filter and format have values)
  if (filter.minDuration !== undefined && format.duration !== undefined) {
    if (format.duration < filter.minDuration) {
      return {
        passes: false,
        reason: `duration ${formatDuration(format.duration)} < min ${formatDuration(filter.minDuration)}`,
      };
    }
  }

  if (filter.maxDuration !== undefined && format.duration !== undefined) {
    if (format.duration > filter.maxDuration) {
      return {
        passes: false,
        reason: `duration ${formatDuration(format.duration)} > max ${formatDuration(filter.maxDuration)}`,
      };
    }
  }

  // Bitrate check (convert bps to kbps for comparison)
  if (filter.minBitrate !== undefined && format.bitrate !== undefined) {
    const bitrateKbps = format.bitrate / 1000;
    if (bitrateKbps < filter.minBitrate) {
      return {
        passes: false,
        reason: `bitrate ${Math.round(bitrateKbps)}kbps < min ${filter.minBitrate}kbps`,
      };
    }
  }

  // Codec check (case-insensitive)
  if (filter.codec !== undefined && format.codec !== undefined) {
    if (format.codec.toLowerCase() !== filter.codec.toLowerCase()) {
      return {
        passes: false,
        reason: `codec "${format.codec}" != "${filter.codec}"`,
      };
    }
  }

  return { passes: true };
}

/**
 * Combined rating and format metadata from an audio file.
 */
export interface RatingAndFormat {
  /** Normalized rating (null if unrated) */
  rating: NormalizedRating | null;
  /** Audio format metadata */
  format: IFormat;
}

/**
 * Read rating and format metadata from an audio file in a single pass.
 *
 * More efficient than calling readRating() separately when metadata filters
 * are needed, as it avoids reading the file twice.
 *
 * @param filePath - Absolute path to the audio file
 * @returns Combined rating and format, or null on error
 */
export async function readRatingAndFormat(filePath: string): Promise<RatingAndFormat | null> {
  try {
    const metadata = await parseFile(filePath, { skipCovers: true });
    return {
      rating: extractNormalizedRating(metadata, filePath),
      format: metadata.format,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to read metadata from ${filePath}: ${message}`);
    return null;
  }
}

/**
 * Check if any metadata filters are configured in the filter.
 *
 * @param filter - Rating filter configuration
 * @returns true if any metadata filter is set
 */
export function hasMetadataFilters(filter: RatingFilter): boolean {
  return (
    filter.minDuration !== undefined ||
    filter.maxDuration !== undefined ||
    filter.minBitrate !== undefined ||
    filter.codec !== undefined ||
    filter.minPlays !== undefined
  );
}

// ============================================================================
// Smart Filter Evaluation (Recursive Filter Rule Evaluation)
// ============================================================================

/**
 * Maximum recursion depth for nested filter groups.
 * Prevents stack overflow from maliciously deep or accidentally recursive filters.
 */
const MAX_FILTER_DEPTH = 20;

/**
 * Parse a time duration string (e.g., "30d") to milliseconds.
 *
 * Supported formats:
 * - "30d" - 30 days
 * - "7d" - 7 days
 * - "1d" - 1 day
 *
 * @param duration - Duration string with 'd' suffix
 * @returns Duration in milliseconds
 * @throws Error if format is invalid
 */
function parseTimeDuration(duration: string): number {
  const match = duration.match(/^(\d+)d$/);
  if (!match || !match[1]) {
    throw new Error(
      `Invalid time duration format "${duration}". Expected format like "30d" for days.`,
    );
  }
  const days = parseInt(match[1], 10);
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Get a field value from extended metadata for filter evaluation.
 *
 * Maps FilterField to the corresponding ExtendedMetadata property.
 * Returns undefined for missing fields to enable proper null handling.
 *
 * @param metadata - Extended metadata from audio file
 * @param field - Field name to extract
 * @returns Field value or undefined if not present
 */
function getFieldValue(
  metadata: ExtendedMetadata,
  field: FilterField,
): number | string | string[] | undefined {
  switch (field) {
    case "rating":
      return metadata.rating?.value;
    case "genre":
      return metadata.common.genre;
    case "artist":
      return (
        metadata.common.artists ?? (metadata.common.artist ? [metadata.common.artist] : undefined)
      );
    case "year":
      return metadata.common.year;
    case "bpm":
      return metadata.common.bpm;
    case "date_added":
      // date_added would come from inventory database, not file metadata
      // For now, return undefined - this requires integration with inventory system
      return undefined;
    default: {
      // Exhaustive type checking - this should never happen
      const exhaustiveCheck: never = field;
      throw new Error(`Unknown filter field: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Evaluate a leaf filter rule against extended metadata.
 *
 * Handles all comparison operators and field types:
 * - Numeric fields (rating, year, bpm): >=, <=, ==
 * - Array fields (genre, artist): contains (uses array.includes())
 * - Date fields (date_added): within (e.g., "30d" for last 30 days)
 *
 * @param metadata - Extended metadata from audio file
 * @param rule - Leaf filter rule to evaluate
 * @returns true if the rule matches, false otherwise
 */
function evaluateFilterRule(metadata: ExtendedMetadata, rule: FilterRule): boolean {
  const fieldValue = getFieldValue(metadata, rule.field);
  const { operator, value } = rule;

  // Null handling: undefined fields return false (except for != which we don't support yet)
  if (fieldValue === undefined) {
    return false;
  }

  // Handle array fields (genre, artist) with contains operator
  if (Array.isArray(fieldValue)) {
    if (operator === "contains") {
      const searchValue = String(value).toLowerCase();
      return fieldValue.some((item) => item.toLowerCase().includes(searchValue));
    }
    if (operator === "==") {
      const searchValue = String(value).toLowerCase();
      return fieldValue.some((item) => item.toLowerCase() === searchValue);
    }
    // Numeric operators don't make sense for arrays
    logWarn(`Operator "${operator}" not supported for array field "${rule.field}"`);
    return false;
  }

  // Handle numeric fields
  if (typeof fieldValue === "number") {
    const numericValue = typeof value === "number" ? value : parseFloat(String(value));
    if (isNaN(numericValue)) {
      logWarn(`Invalid numeric value "${value}" for field "${rule.field}"`);
      return false;
    }

    // Special handling for rating field: convert star values to normalized (0-1)
    let compareValue = numericValue;
    if (rule.field === "rating" && numericValue > 1) {
      // Assume star scale (1-5) if value > 1
      compareValue = numericValue / 5;
    }

    switch (operator) {
      case ">=":
        return fieldValue >= compareValue;
      case "<=":
        return fieldValue <= compareValue;
      case "==":
        return fieldValue === compareValue;
      case "contains":
        logWarn(`Operator "contains" not supported for numeric field "${rule.field}"`);
        return false;
      case "within":
        logWarn(`Operator "within" not supported for numeric field "${rule.field}"`);
        return false;
      default: {
        const exhaustiveCheck: never = operator;
        throw new Error(`Unknown operator: ${exhaustiveCheck}`);
      }
    }
  }

  // Handle string fields (date_added uses 'within' operator)
  if (typeof fieldValue === "string") {
    if (operator === "within" && rule.field === "date_added") {
      try {
        const durationMs = parseTimeDuration(String(value));
        const fieldDate = new Date(fieldValue).getTime();
        const cutoffDate = Date.now() - durationMs;
        return fieldDate >= cutoffDate;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn(`Failed to parse date_added filter: ${message}`);
        return false;
      }
    }

    if (operator === "contains") {
      return fieldValue.toLowerCase().includes(String(value).toLowerCase());
    }

    if (operator === "==") {
      return fieldValue.toLowerCase() === String(value).toLowerCase();
    }

    logWarn(`Operator "${operator}" not supported for string field "${rule.field}"`);
    return false;
  }

  // Should not reach here with proper type definitions
  logWarn(`Unexpected field value type for "${rule.field}"`);
  return false;
}

/**
 * Evaluate a filter group (AND/OR container) recursively.
 *
 * Uses short-circuit evaluation:
 * - AND groups (match: 'all'): stops on first false
 * - OR groups (match: 'any'): stops on first true
 *
 * @param metadata - Extended metadata from audio file
 * @param group - Filter group to evaluate
 * @param depth - Current recursion depth (for stack overflow protection)
 * @returns true if the group matches according to its match strategy
 * @throws Error if max recursion depth exceeded
 */
function evaluateFilterGroup(
  metadata: ExtendedMetadata,
  group: FilterGroup,
  depth: number,
): boolean {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(
      `Max filter recursion depth (${MAX_FILTER_DEPTH}) exceeded. Check for circular references.`,
    );
  }

  if (group.match === "all") {
    // AND logic: all rules must match, early exit on first false
    return group.rules.every((rule) => evaluateSmartFilterRule(metadata, rule, depth + 1));
  } else if (group.match === "any") {
    // OR logic: at least one rule must match, early exit on first true
    return group.rules.some((rule) => evaluateSmartFilterRule(metadata, rule, depth + 1));
  } else {
    // Exhaustive type checking
    const exhaustiveCheck: never = group.match;
    throw new Error(`Unknown match strategy: ${exhaustiveCheck}`);
  }
}

/**
 * Evaluate a smart filter rule (discriminated union) against extended metadata.
 *
 * This is the main dispatcher that handles both leaf rules and nested groups
 * using the discriminated union's `type` field.
 *
 * @param metadata - Extended metadata from audio file
 * @param rule - Smart filter rule (leaf or group)
 * @param depth - Current recursion depth (default: 0)
 * @returns true if the rule/group matches, false otherwise
 */
export function evaluateSmartFilterRule(
  metadata: ExtendedMetadata,
  rule: SmartFilterRule,
  depth: number = 0,
): boolean {
  switch (rule.type) {
    case "rule":
      return evaluateFilterRule(metadata, rule);
    case "group":
      return evaluateFilterGroup(metadata, rule, depth);
    default: {
      // Exhaustive type checking - should never happen with proper types
      const exhaustiveCheck: never = rule;
      throw new Error(`Unknown rule type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Evaluate a complete smart filter against extended metadata.
 *
 * This is the top-level entry point for smart filter evaluation.
 * It wraps the root-level match/rules as a filter group and delegates
 * to the recursive evaluator.
 *
 * @param metadata - Extended metadata from audio file
 * @param filter - Smart filter definition
 * @returns true if the track passes all filter criteria
 *
 * @example
 * const filter: SmartFilter = {
 *   match: 'all',
 *   rules: [
 *     { type: 'rule', field: 'rating', operator: '>=', value: 4.0 },
 *     {
 *       type: 'group',
 *       match: 'any',
 *       rules: [
 *         { type: 'rule', field: 'genre', operator: 'contains', value: 'Rock' },
 *         { type: 'rule', field: 'genre', operator: 'contains', value: 'Alternative' }
 *       ]
 *     }
 *   ]
 * };
 *
 * const metadata = await readExtendedMetadata('/path/to/track.mp3');
 * if (metadata && evaluateSmartFilter(metadata, filter)) {
 *   console.log('Track matches filter criteria');
 * }
 */
export function evaluateSmartFilter(metadata: ExtendedMetadata, filter: SmartFilter): boolean {
  // Wrap the top-level SmartFilter as a FilterGroup for evaluation
  const rootGroup: FilterGroup = {
    type: "group",
    match: filter.match,
    rules: filter.rules,
  };

  return evaluateFilterGroup(metadata, rootGroup, 0);
}

// ============================================================================
// Verbose Smart Filter Evaluation (Per-Rule Results for Dry-Run Preview)
// ============================================================================

/**
 * Result of evaluating a single filter rule.
 * Used for verbose output in dry-run mode.
 */
export interface RuleEvaluationResult {
  /** The original rule that was evaluated */
  rule: FilterRule;
  /** Whether the rule passed */
  passed: boolean;
  /** The actual value from the file (for display) */
  actualValue?: string | number | string[];
}

/**
 * Detailed result of evaluating a smart filter.
 * Contains per-rule results for verbose output.
 */
export interface SmartFilterEvaluationResult {
  /** Whether the filter as a whole passed */
  passed: boolean;
  /** Results for each leaf rule (flattened from nested groups) */
  ruleResults: RuleEvaluationResult[];
  /** The rule that caused the filter to fail (if any) */
  failingRule?: FilterRule;
}

/**
 * Count the total number of leaf rules in a smart filter.
 * Recursively counts rules in nested groups.
 *
 * @param filter - Smart filter to count rules in
 * @returns Total number of leaf rules
 */
export function countSmartFilterRules(filter: SmartFilter): number {
  function countRules(rule: SmartFilterRule): number {
    switch (rule.type) {
      case "rule":
        return 1;
      case "group":
        return rule.rules.reduce((sum, r) => sum + countRules(r), 0);
    }
  }

  return filter.rules.reduce((sum, rule) => sum + countRules(rule), 0);
}

/**
 * Evaluate a leaf filter rule and return detailed result.
 *
 * @param metadata - Extended metadata from audio file
 * @param rule - Leaf filter rule to evaluate
 * @returns Detailed evaluation result with actual value
 */
function evaluateFilterRuleVerbose(
  metadata: ExtendedMetadata,
  rule: FilterRule,
): RuleEvaluationResult {
  const fieldValue = getFieldValue(metadata, rule.field);
  const passed = evaluateFilterRule(metadata, rule);

  return {
    rule,
    passed,
    actualValue: fieldValue,
  };
}

/**
 * Collect all leaf rule results from a smart filter evaluation.
 * Recursively traverses nested groups to get all individual rule results.
 *
 * @param metadata - Extended metadata from audio file
 * @param rule - Smart filter rule (leaf or group)
 * @param results - Array to collect results into
 * @param depth - Current recursion depth
 */
function collectRuleResults(
  metadata: ExtendedMetadata,
  rule: SmartFilterRule,
  results: RuleEvaluationResult[],
  depth: number = 0,
): void {
  if (depth > MAX_FILTER_DEPTH) {
    return;
  }

  switch (rule.type) {
    case "rule":
      results.push(evaluateFilterRuleVerbose(metadata, rule));
      break;
    case "group":
      for (const childRule of rule.rules) {
        collectRuleResults(metadata, childRule, results, depth + 1);
      }
      break;
  }
}

/**
 * Evaluate a smart filter and return detailed per-rule results.
 *
 * This function is used for verbose dry-run output to show which rules
 * passed or failed for each file.
 *
 * @param metadata - Extended metadata from audio file
 * @param filter - Smart filter definition
 * @returns Detailed evaluation result with per-rule results
 *
 * @example
 * const result = evaluateSmartFilterVerbose(metadata, filter);
 * if (!result.passed && result.failingRule) {
 *   console.log(`Failed on: ${result.failingRule.field} ${result.failingRule.operator} ${result.failingRule.value}`);
 * }
 */
export function evaluateSmartFilterVerbose(
  metadata: ExtendedMetadata,
  filter: SmartFilter,
): SmartFilterEvaluationResult {
  // Get overall pass/fail
  const passed = evaluateSmartFilter(metadata, filter);

  // Collect all individual rule results
  const ruleResults: RuleEvaluationResult[] = [];
  for (const rule of filter.rules) {
    collectRuleResults(metadata, rule, ruleResults);
  }

  // Find the first failing rule (for debugging output)
  const failingResult = ruleResults.find((r) => !r.passed);

  return {
    passed,
    ruleResults,
    failingRule: failingResult?.rule,
  };
}

/**
 * Format a filter rule for display.
 * Produces a human-readable string like "rating >= 4.0".
 *
 * @param rule - Filter rule to format
 * @returns Formatted string representation
 */
export function formatFilterRule(rule: FilterRule): string {
  return `${rule.field} ${rule.operator} ${rule.value}`;
}
