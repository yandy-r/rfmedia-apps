/**
 * Completed source tracking for rfmedia CLI.
 *
 * Provides idempotent operation support by tracking which sources have been
 * successfully processed in option-aware sidecar files. This enables:
 * - Resuming interrupted operations
 * - Skipping already-processed sources
 * - Tracking failed sources separately
 */

import path, { isAbsolute } from "node:path";
import { readFile, writeFile, appendFile, unlink } from "node:fs/promises";

import { logDebug, logWarn, logInfo, logSuccess } from "./logger.js";
import { normalizePath, pathExists } from "./filesystem.js";
import { formatSuffix } from "./range.js";
import type { CopyOptions, RatingFilter, CopyRange } from "../types/index.js";
import type {
  TrackingOptionsHash,
  TrackingConfig,
  TrackingState,
  TrackingMetadata,
  TrackingStats,
  TimingStats,
  PendingSuffixInfo,
} from "../types/tracking.js";
import type { DbConnection } from "../types/db.js";
import {
  createOperation,
  findOperation,
  getOperation,
  getCompletedSources,
  getFailedSources,
  recordCompleted as dbRecordCompleted,
  recordFailed as dbRecordFailed,
  recordCompletedAlbumCopy as dbRecordCompletedAlbumCopy,
  getCompletedAlbumCopies,
  getCompletedAlbumCopiesUnderPath,
  getCompletedSuffixesForAlbum,
} from "./db.js";

const LEGACY_TRACKING_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export interface LegacyTrackingImportRequest {
  inputFile: string;
  optionsHash: string;
  mode: "album" | "filter";
  completedPath?: string;
  failedPath?: string;
}

export interface LegacyTrackingImportResult {
  operationId: number;
  completed: number;
  failed: number;
  importedFiles: string[];
  alreadyEquivalentFiles: string[];
}

/**
 * Builds an options hash from copy options for tracking file naming.
 *
 * The hash format is human-readable and deterministic:
 * - Album mode: `album-{range}` or `album` (no range)
 * - Filter mode: `filter-{rating}-{range?}-{convert?}`
 *
 * @param options - Copy options to build hash from
 * @returns Options hash object
 */
export function buildOptionsHash(options: CopyOptions): TrackingOptionsHash {
  const hash: TrackingOptionsHash = {
    mode: options.mode.type,
  };

  if (options.mode.type === "album") {
    const range = options.mode.range;
    hash.rangeKey = `${formatSuffix(range.start, range.padWidth)}-${formatSuffix(range.end, range.padWidth)}`;
  } else {
    // Filter mode
    const rating = options.mode.rating;

    // Rating key
    if (rating.minStars !== undefined) {
      hash.ratingKey = `s${rating.minStars}`;
    } else if (rating.minRating !== undefined) {
      hash.ratingKey = `r${rating.minRating}`;
    }

    // Filter name (for smart filters)
    if (rating.filterName) {
      hash.filterName = rating.filterName;
    }

    // Range key (filter mode can also have range)
    if (rating.range) {
      hash.rangeKey = `${formatSuffix(rating.range.start, rating.range.padWidth)}-${formatSuffix(rating.range.end, rating.range.padWidth)}`;
    }
  }

  // Conversion format
  if (options.convertFormat) {
    hash.convertKey = options.convertFormat;
  }

  return hash;
}

/**
 * Formats an options hash into a filename-safe string.
 *
 * @param hash - Options hash to format
 * @returns Formatted string for use in filename
 *
 * @example
 * // Album mode with range
 * formatOptionsHash({ mode: 'album', rangeKey: '001-010' })
 * // Returns: 'album-001-010'
 *
 * @example
 * // Filter mode with rating and conversion
 * formatOptionsHash({ mode: 'filter', ratingKey: 'r80', convertKey: 'mp3' })
 * // Returns: 'filter-r80-mp3'
 *
 * @example
 * // Filter mode with smart filter name
 * formatOptionsHash({ mode: 'filter', filterName: 'liked' })
 * // Returns: 'filter-liked'
 */
export function formatOptionsHash(hash: TrackingOptionsHash): string {
  const parts: string[] = [hash.mode];

  if (hash.filterName) {
    parts.push(hash.filterName);
  }

  if (hash.ratingKey) {
    parts.push(hash.ratingKey);
  }

  if (hash.rangeKey) {
    parts.push(hash.rangeKey);
  }

  if (hash.convertKey) {
    parts.push(hash.convertKey);
  }

  return parts.join("-");
}

/**
 * Resolves the completed tracking file path.
 *
 * Default location is next to the input file with the pattern:
 * `{inputBasename}.completed.{optionsHash}.txt`
 *
 * @param inputFile - Path to the input file containing source paths
 * @param options - Copy options for building the options hash
 * @param customPath - Optional custom path override
 * @returns Absolute path to the completed tracking file
 */
export function resolveCompletedFilePath(
  inputFile: string,
  options: CopyOptions,
  customPath?: string,
): string {
  if (customPath) {
    return path.resolve(customPath);
  }

  const inputDir = path.dirname(inputFile);
  const inputBasename = path.basename(inputFile, path.extname(inputFile));
  const hash = buildOptionsHash(options);
  const hashStr = formatOptionsHash(hash);

  return path.join(inputDir, `${inputBasename}.completed.${hashStr}.txt`);
}

/**
 * Resolves the failed tracking file path from the completed file path.
 *
 * @param completedPath - Path to the completed tracking file
 * @returns Path to the failed tracking file
 */
export function resolveFailedFilePath(completedPath: string): string {
  // Replace '.completed.' with '.failed.' in the filename
  const dir = path.dirname(completedPath);
  const filename = path.basename(completedPath);
  const failedFilename = filename.replace(".completed.", ".failed.");
  return path.join(dir, failedFilename);
}

/**
 * Creates a tracking configuration from inputs.
 *
 * @param inputFile - Path to the input file
 * @param copyOpts - Copy options
 * @param trackOpts - Tracking-specific options
 * @returns TrackingConfig object
 */
export function createTrackingConfig(
  inputFile: string,
  copyOpts: CopyOptions,
  trackOpts: {
    enabled: boolean;
    customPath?: string;
    reset?: boolean;
  },
): TrackingConfig {
  const completedFilePath = resolveCompletedFilePath(inputFile, copyOpts, trackOpts.customPath);
  const failedFilePath = resolveFailedFilePath(completedFilePath);

  return {
    enabled: trackOpts.enabled,
    completedFilePath,
    failedFilePath,
    reset: trackOpts.reset ?? false,
  };
}

/**
 * Generates the file header for a tracking file.
 *
 * @param inputFile - Original input file path
 * @param options - Copy options
 * @returns Header string with metadata
 */
export function generateFileHeader(inputFile: string, options: CopyOptions): string {
  const hash = buildOptionsHash(options);
  const timestamp = new Date().toISOString();

  const lines: string[] = [
    `# Completed paths for ${path.basename(inputFile)}`,
    `# Generated by rfmedia on ${timestamp}`,
  ];

  // Build options description
  const optParts: string[] = [`Mode: ${hash.mode}`];

  if (hash.ratingKey) {
    if (hash.ratingKey.startsWith("r")) {
      optParts.push(`min-rating: ${hash.ratingKey.slice(1)}`);
    } else if (hash.ratingKey.startsWith("s")) {
      optParts.push(`min-stars: ${hash.ratingKey.slice(1)}`);
    }
  }

  if (hash.rangeKey) {
    optParts.push(`range: ${hash.rangeKey}`);
  } else {
    optParts.push("range: none");
  }

  if (hash.convertKey) {
    optParts.push(`convert: ${hash.convertKey}`);
  } else {
    optParts.push("convert: none");
  }

  lines.push(`# ${optParts.join(" | ")}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Loads tracking state from database or disk.
 *
 * Routes to database-backed or file-based tracking based on config.
 * If files don't exist or are corrupted, returns empty state with a warning.
 *
 * @param config - Tracking configuration
 * @returns Tracking state with completed and failed sets
 */
export async function loadTrackingState(config: TrackingConfig): Promise<TrackingState> {
  // Route to database if available
  if (config.db && config.operationId !== undefined) {
    return loadTrackingStateFromDb(config.db, config.operationId);
  }

  // Legacy file-based tracking
  const state: TrackingState = {
    completed: new Set<string>(),
    failed: new Set<string>(),
  };

  // Load completed paths
  if (await pathExists(config.completedFilePath)) {
    try {
      const content = await readFile(config.completedFilePath, "utf-8");
      const paths = parseTrackingFile(content);
      for (const p of paths) {
        state.completed.add(normalizePath(p));
      }
      logDebug(`Loaded ${state.completed.size} completed path(s) from ${config.completedFilePath}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to read completed tracking file: ${msg}`);
      logWarn("Treating as empty - processing will start fresh");
    }
  }

  // Load failed paths
  if (await pathExists(config.failedFilePath)) {
    try {
      const content = await readFile(config.failedFilePath, "utf-8");
      const paths = parseTrackingFile(content);
      for (const p of paths) {
        state.failed.add(normalizePath(p));
      }
      logDebug(`Loaded ${state.failed.size} failed path(s) from ${config.failedFilePath}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to read failed tracking file: ${msg}`);
    }
  }

  return state;
}

/**
 * Parses a tracking file content into paths.
 *
 * @param content - File content
 * @returns Array of paths (comments and empty lines filtered out)
 */
function parseTrackingFile(content: string): string[] {
  const lines = content.split("\n");
  const paths: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    paths.push(trimmed);
  }

  return paths;
}

/**
 * Loads tracking state from the database.
 *
 * @param db - Database connection
 * @param operationId - Operation ID to load from
 * @returns Tracking state with completed and failed sets
 */
function loadTrackingStateFromDb(db: DbConnection, operationId: number): TrackingState {
  const completed = new Set<string>();
  const failed = new Set<string>();

  // Load completed sources
  const completedPaths = getCompletedSources(db, operationId);
  for (const p of completedPaths) {
    completed.add(normalizePath(p));
  }
  logDebug(`Loaded ${completed.size} completed path(s) from database operation ${operationId}`);

  // Load failed sources
  const failedSources = getFailedSources(db, operationId);
  for (const f of failedSources) {
    failed.add(normalizePath(f.source_path));
  }
  logDebug(`Loaded ${failed.size} failed path(s) from database operation ${operationId}`);

  return { completed, failed };
}

/**
 * Loads granular album copy tracking state for a specific source.
 *
 * This is called on-demand when processing a source with per-path ranges,
 * to determine which suffixes have already been completed.
 *
 * When ratingKey is provided, only loads copies matching that rating filter.
 * This enables rating-aware tracking where different rating filters (e.g., r50 vs r80)
 * are tracked independently.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source directory path
 * @param ratingKey - Rating filter key (undefined = all, null = no filter, string = specific filter)
 * @returns Map of album name to set of completed suffixes
 */
export function loadCompletedAlbumCopiesForSource(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  ratingKey?: string | null,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const normalized = normalizePath(sourcePath);

  const copies = getCompletedAlbumCopies(db, operationId, normalized, ratingKey);

  for (const copy of copies) {
    if (!result.has(copy.album_name)) {
      result.set(copy.album_name, new Set());
    }
    result.get(copy.album_name)!.add(copy.suffix);
  }

  const totalCopies = copies.length;
  const albumCount = result.size;
  const ratingPart = ratingKey !== undefined ? ` (rating: ${ratingKey ?? "none"})` : "";
  logDebug(
    `Loaded ${totalCopies} completed album copies across ${albumCount} albums for ${sourcePath}${ratingPart}`,
  );

  return result;
}

/**
 * Loads all completed album copies under a library root path.
 *
 * Returns a two-level map: artistPath -> albumName -> Set of completed suffixes.
 * This handles the consistent data format where source_path is always the artist folder
 * and album_name is always just the album name.
 *
 * Also handles legacy format where source_path is the library root and album_name
 * contains "artist/album" by splitting the album_name.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param libraryRoot - Library root path (e.g., /data/media/music)
 * @param ratingKey - Rating filter key (undefined = all, null = no filter, string = specific filter)
 * @returns Map of artist path to Map of album name to set of completed suffixes
 */
export function loadCompletedAlbumCopiesForLibraryRoot(
  db: DbConnection,
  operationId: number,
  libraryRoot: string,
  ratingKey?: string | null,
): Map<string, Map<string, Set<string>>> {
  const result = new Map<string, Map<string, Set<string>>>();
  const normalizedRoot = normalizePath(libraryRoot);

  const copies = getCompletedAlbumCopiesUnderPath(db, operationId, normalizedRoot, ratingKey);

  for (const copy of copies) {
    let artistPath: string;
    let albumName: string;

    if (copy.source_path === normalizedRoot) {
      // Legacy format: source_path is library root, album_name is "artist/album"
      const slashIdx = copy.album_name.indexOf("/");
      if (slashIdx > 0) {
        const artistFolder = copy.album_name.substring(0, slashIdx);
        albumName = copy.album_name.substring(slashIdx + 1);
        artistPath = path.join(normalizedRoot, artistFolder);
      } else {
        // No slash in album_name, use as-is (shouldn't happen in normal usage)
        artistPath = normalizedRoot;
        albumName = copy.album_name;
      }
    } else {
      // New consistent format: source_path is artist folder, album_name is just album
      artistPath = copy.source_path;
      albumName = copy.album_name;
    }

    if (!result.has(artistPath)) {
      result.set(artistPath, new Map());
    }
    const artistMap = result.get(artistPath)!;

    if (!artistMap.has(albumName)) {
      artistMap.set(albumName, new Set());
    }
    artistMap.get(albumName)!.add(copy.suffix);
  }

  const totalCopies = copies.length;
  const artistCount = result.size;
  const ratingPart = ratingKey !== undefined ? ` (rating: ${ratingKey ?? "none"})` : "";
  logDebug(
    `Loaded ${totalCopies} completed album copies across ${artistCount} artists under ${libraryRoot}${ratingPart}`,
  );

  return result;
}

/**
 * Gets pending suffixes for an album based on the requested range.
 *
 * Compares the requested suffixes against the already completed suffixes
 * to determine which ones still need processing.
 *
 * @param completedSuffixes - Set of already completed suffixes for this album
 * @param range - The range of suffixes being requested
 * @returns Array of suffix strings that still need processing
 */
export function getPendingSuffixes(completedSuffixes: Set<string>, range: CopyRange): string[] {
  const pending: string[] = [];

  for (let i = range.start; i <= range.end; i++) {
    const suffix = formatSuffix(i, range.padWidth);
    if (!completedSuffixes.has(suffix)) {
      pending.push(suffix);
    }
  }

  return pending;
}

/**
 * Checks if a source path has any pending work for the given range and rating.
 *
 * Returns true if ANY suffix in the range is not completed for ANY album.
 * This is used by range-aware filtering to determine whether a source should
 * be processed when using granular tracking.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source directory path
 * @param range - Range to check (e.g., 001-020)
 * @param ratingKey - Rating key (e.g., "r50", "s3", null)
 * @returns true if there's pending work, false if fully completed
 */
export async function hasSourcePendingWorkForRange(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  range: CopyRange,
  ratingKey?: string | null,
): Promise<boolean> {
  // Load all completed album copies for this source + rating
  const completedAlbumCopies = loadCompletedAlbumCopiesForSource(
    db,
    operationId,
    sourcePath,
    ratingKey,
  );

  // If no completed albums at all, definitely has pending work
  if (completedAlbumCopies.size === 0) {
    return true;
  }

  // Generate expected suffixes for the range
  const expectedSuffixes = new Set<string>();
  for (let i = range.start; i <= range.end; i++) {
    expectedSuffixes.add(formatSuffix(i, range.padWidth));
  }

  // Check each album - if ANY album has missing suffixes, return true
  for (const [albumName, completedSuffixes] of completedAlbumCopies.entries()) {
    for (const expectedSuffix of expectedSuffixes) {
      if (!completedSuffixes.has(expectedSuffix)) {
        // Found a pending suffix
        logDebug(
          `Source ${sourcePath} has pending work: ${albumName}-${expectedSuffix} not completed`,
        );
        return true;
      }
    }
  }

  // All suffixes for all albums are completed
  logDebug(`Source ${sourcePath} is fully completed for range ${range.start}-${range.end}`);
  return false;
}

/**
 * Checks if a source path has any pending work for the given range.
 *
 * A source is considered "pending" if any album within it has suffixes
 * that haven't been completed yet.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source directory path
 * @param albumNames - List of album names in the source
 * @param range - The range of suffixes being requested
 * @returns true if there's pending work, false if all suffixes are complete
 */
export function hasSourcePendingWork(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  albumNames: string[],
  range: CopyRange,
): boolean {
  const normalized = normalizePath(sourcePath);

  for (const albumName of albumNames) {
    const completedSuffixes = getCompletedSuffixesForAlbum(db, operationId, normalized, albumName);
    const pendingSuffixes = getPendingSuffixes(completedSuffixes, range);

    if (pendingSuffixes.length > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Initializes tracking in the database and returns the operation ID.
 *
 * @param db - Database connection
 * @param config - Tracking configuration
 * @param inputFile - Input file path
 * @param options - Copy options
 * @param reset - Whether to create a new operation (reset mode)
 * @returns Operation ID (existing or newly created)
 */
function initializeTrackingInDb(
  db: DbConnection,
  config: TrackingConfig,
  inputFile: string,
  options: CopyOptions,
  reset: boolean,
): number {
  const hash = buildOptionsHash(options);
  const hashStr = formatOptionsHash(hash);

  // Try to find existing operation if not resetting
  if (!reset) {
    const existing = findOperation(db, {
      inputFile,
      optionsHash: hashStr,
      mode: options.mode.type,
    });

    if (existing) {
      logDebug(`Reusing existing operation ${existing.id}: ${existing.command} (${hashStr})`);
      return existing.id;
    }
  }

  // Create new operation
  const operationId = createOperation(db, {
    command: "copy",
    mode: options.mode.type,
    inputFile,
    optionsHash: hashStr,
    ratingKey: hash.ratingKey ?? null,
    rangeKey: hash.rangeKey ?? null,
    convertKey: hash.convertKey ?? null,
  });

  logDebug(`Created new operation ${operationId} for tracking`);
  return operationId;
}

/**
 * Records a completed source in the database.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source path that was completed
 */
function recordCompletedInDb(db: DbConnection, operationId: number, sourcePath: string): void {
  const normalized = normalizePath(sourcePath);
  dbRecordCompleted(db, operationId, normalized);
}

/**
 * Records a failed source in the database.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source path that failed
 * @param error - Error message
 */
function recordFailedInDb(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  error: string,
): void {
  const normalized = normalizePath(sourcePath);
  dbRecordFailed(db, operationId, normalized, error);
}

/**
 * Records a completed album copy in the database (granular tracking).
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param sourcePath - Source directory path
 * @param albumName - Album folder name
 * @param suffix - Completed suffix (e.g., '001')
 * @param ratingKey - Rating filter key (e.g., 'r80', 's3', null for no filter)
 */
function recordCompletedAlbumCopyInDb(
  db: DbConnection,
  operationId: number,
  sourcePath: string,
  albumName: string,
  suffix: string,
  ratingKey?: string | null,
): void {
  const normalized = normalizePath(sourcePath);
  dbRecordCompletedAlbumCopy(db, operationId, normalized, albumName, suffix, ratingKey);
}

interface PreparedLegacyTrackingFile {
  filePath: string;
  sources: string[];
}

interface LegacyTrackingFailure {
  sourcePath: string;
  error: string;
}

interface PreparedLegacyFailedTrackingFile {
  filePath: string;
  failures: LegacyTrackingFailure[];
}

interface PreparedLegacyTrackingImport {
  completed?: PreparedLegacyTrackingFile;
  failed?: PreparedLegacyFailedTrackingFile;
}

function assertLegacyTrackingIdentity(request: LegacyTrackingImportRequest): void {
  if (
    request.inputFile.trim() === "" ||
    LEGACY_TRACKING_CONTROL_CHARACTER_PATTERN.test(request.inputFile)
  ) {
    throw new Error("Invalid legacy tracking input identity");
  }

  const expectedPrefix = `${request.mode}-`;
  if (request.optionsHash !== request.mode && !request.optionsHash.startsWith(expectedPrefix)) {
    throw new Error(
      `Invalid legacy tracking options hash for ${request.mode} mode: ${request.optionsHash}`,
    );
  }
}

async function readLegacyTrackingFile(filePath: string): Promise<string> {
  if (!(await pathExists(filePath))) {
    throw new Error(`Legacy tracking file does not exist: ${filePath}`);
  }

  return readFile(filePath, "utf-8");
}

function assertLegacySourcePath(sourcePath: string, filePath: string): void {
  if (!isAbsolute(sourcePath) || LEGACY_TRACKING_CONTROL_CHARACTER_PATTERN.test(sourcePath)) {
    throw new Error(`Invalid legacy tracking source path in ${filePath}: ${sourcePath}`);
  }
}

async function prepareCompletedLegacyTrackingFile(
  filePath: string,
  strict: boolean,
): Promise<PreparedLegacyTrackingFile> {
  const content = await readLegacyTrackingFile(filePath);
  const parsedSources = parseTrackingFile(content);

  if (strict && parsedSources.length === 0) {
    throw new Error(`Legacy tracking file contains no source entries: ${filePath}`);
  }

  if (strict) {
    for (const sourcePath of parsedSources) {
      assertLegacySourcePath(sourcePath, filePath);
    }
  }

  return {
    filePath,
    sources: Array.from(new Set(parsedSources.map((sourcePath) => normalizePath(sourcePath)))),
  };
}

function parseFailedTrackingFile(content: string, strict: boolean): LegacyTrackingFailure[] {
  const failures: LegacyTrackingFailure[] = [];
  let pendingSource: string | undefined;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("# Error:")) {
      const diagnostic = trimmed.slice("# Error:".length).trimStart();
      if (pendingSource === undefined) {
        if (strict) throw new Error("Legacy failed tracking diagnostic has no source path");
        continue;
      }
      if (diagnostic === "" && strict) {
        throw new Error(`Legacy failed tracking source has an empty diagnostic: ${pendingSource}`);
      }
      failures.push({
        sourcePath: pendingSource,
        error: diagnostic || "Migrated from legacy file",
      });
      pendingSource = undefined;
      continue;
    }

    if (trimmed.startsWith("#")) continue;

    if (pendingSource !== undefined) {
      if (strict) {
        throw new Error(`Legacy failed tracking source has no diagnostic: ${pendingSource}`);
      }
      failures.push({
        sourcePath: pendingSource,
        error: "Migrated from legacy file",
      });
    }
    pendingSource = trimmed;
  }

  if (pendingSource !== undefined) {
    if (strict) {
      throw new Error(`Legacy failed tracking source has no diagnostic: ${pendingSource}`);
    }
    failures.push({ sourcePath: pendingSource, error: "Migrated from legacy file" });
  }

  return failures;
}

async function prepareFailedLegacyTrackingFile(
  filePath: string,
  strict: boolean,
): Promise<PreparedLegacyFailedTrackingFile> {
  const content = await readLegacyTrackingFile(filePath);
  const parsedFailures = parseFailedTrackingFile(content, strict);

  if (strict && parsedFailures.length === 0) {
    throw new Error(`Legacy tracking file contains no failed source entries: ${filePath}`);
  }

  const failuresBySource = new Map<string, string>();
  for (const failure of parsedFailures) {
    if (strict) assertLegacySourcePath(failure.sourcePath, filePath);
    const sourcePath = normalizePath(failure.sourcePath);
    const priorError = failuresBySource.get(sourcePath);
    if (strict && priorError !== undefined && priorError !== failure.error) {
      throw new Error(`Legacy failed tracking source has conflicting diagnostics: ${sourcePath}`);
    }
    failuresBySource.set(sourcePath, failure.error);
  }

  return {
    filePath,
    failures: Array.from(failuresBySource, ([sourcePath, error]) => ({ sourcePath, error })),
  };
}

function hasEverySource(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
  return expected.every((sourcePath) => actual.has(sourcePath));
}

function hasEveryFailure(
  actual: ReadonlyMap<string, string | null>,
  expected: readonly LegacyTrackingFailure[],
): boolean {
  return expected.every(({ sourcePath, error }) => actual.get(sourcePath) === error);
}

function importPreparedLegacyTracking(
  db: DbConnection,
  request: LegacyTrackingImportRequest,
  prepared: PreparedLegacyTrackingImport,
  operationId?: number,
): LegacyTrackingImportResult {
  const importTransaction = db.transaction(() => {
    let resolvedOperationId = operationId;

    if (resolvedOperationId === undefined) {
      const existing = findOperation(db, {
        inputFile: request.inputFile,
        optionsHash: request.optionsHash,
        mode: request.mode,
      });
      resolvedOperationId =
        existing?.id ??
        createOperation(db, {
          command: "copy",
          mode: request.mode,
          inputFile: request.inputFile,
          optionsHash: request.optionsHash,
          ratingKey: null,
          rangeKey: null,
          convertKey: null,
        });
    } else {
      const existing = getOperation(db, resolvedOperationId);
      if (
        !existing ||
        existing.input_file !== request.inputFile ||
        existing.options_hash !== request.optionsHash ||
        existing.mode !== request.mode
      ) {
        throw new Error(`Legacy tracking operation identity mismatch: ${resolvedOperationId}`);
      }
    }

    const completedBefore = new Set(getCompletedSources(db, resolvedOperationId));
    const failedBefore = new Map(
      getFailedSources(db, resolvedOperationId).map((source) => [
        source.source_path,
        source.error_message,
      ]),
    );

    for (const sourcePath of prepared.completed?.sources ?? []) {
      if (!completedBefore.has(sourcePath)) {
        dbRecordCompleted(db, resolvedOperationId, sourcePath);
      }
    }
    for (const { sourcePath, error } of prepared.failed?.failures ?? []) {
      if (failedBefore.get(sourcePath) !== error) {
        dbRecordFailed(db, resolvedOperationId, sourcePath, error);
      }
    }

    return {
      operationId: resolvedOperationId,
      completedWasEquivalent:
        prepared.completed !== undefined &&
        hasEverySource(completedBefore, prepared.completed.sources),
      failedWasEquivalent:
        prepared.failed !== undefined && hasEveryFailure(failedBefore, prepared.failed.failures),
    };
  });

  const transactionResult = importTransaction();
  const completedAfter = new Set(getCompletedSources(db, transactionResult.operationId));
  const failedAfter = new Map(
    getFailedSources(db, transactionResult.operationId).map((source) => [
      source.source_path,
      source.error_message,
    ]),
  );

  if (
    (prepared.completed && !hasEverySource(completedAfter, prepared.completed.sources)) ||
    (prepared.failed && !hasEveryFailure(failedAfter, prepared.failed.failures))
  ) {
    throw new Error("Legacy tracking import could not be verified after commit");
  }

  const importedFiles: string[] = [];
  const alreadyEquivalentFiles: string[] = [];
  if (prepared.completed && prepared.completed.sources.length > 0) {
    (transactionResult.completedWasEquivalent ? alreadyEquivalentFiles : importedFiles).push(
      prepared.completed.filePath,
    );
  }
  if (prepared.failed && prepared.failed.failures.length > 0) {
    (transactionResult.failedWasEquivalent ? alreadyEquivalentFiles : importedFiles).push(
      prepared.failed.filePath,
    );
  }

  return {
    operationId: transactionResult.operationId,
    completed: prepared.completed?.sources.length ?? 0,
    failed: prepared.failed?.failures.length ?? 0,
    importedFiles,
    alreadyEquivalentFiles,
  };
}

/**
 * Imports one legacy tracking operation and returns per-file durable proof.
 *
 * Operation creation and row writes commit atomically. A sidecar is returned as imported or
 * already equivalent only after every normalized source has been read back from the committed
 * database state.
 */
export async function migrateLegacyTracking(
  db: DbConnection,
  request: LegacyTrackingImportRequest,
): Promise<LegacyTrackingImportResult> {
  assertLegacyTrackingIdentity(request);
  if (!request.completedPath && !request.failedPath) {
    throw new Error("Legacy tracking import requires at least one sidecar path");
  }

  const prepared: PreparedLegacyTrackingImport = {};
  if (request.completedPath) {
    prepared.completed = await prepareCompletedLegacyTrackingFile(request.completedPath, true);
  }
  if (request.failedPath) {
    prepared.failed = await prepareFailedLegacyTrackingFile(request.failedPath, true);
  }

  return importPreparedLegacyTracking(db, request, prepared);
}

async function migrateLegacyTrackingForInitialization(
  db: DbConnection,
  operationId: number,
  request: LegacyTrackingImportRequest,
): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;

  if (request.completedPath && (await pathExists(request.completedPath))) {
    try {
      const prepared = await prepareCompletedLegacyTrackingFile(request.completedPath, false);
      completed = importPreparedLegacyTracking(
        db,
        request,
        { completed: prepared },
        operationId,
      ).completed;
      logDebug(`Migrated ${completed} completed sources from ${request.completedPath}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to migrate completed tracking file: ${msg}`);
    }
  }

  if (request.failedPath && (await pathExists(request.failedPath))) {
    try {
      const prepared = await prepareFailedLegacyTrackingFile(request.failedPath, false);
      failed = importPreparedLegacyTracking(db, request, { failed: prepared }, operationId).failed;
      logDebug(`Migrated ${failed} failed sources from ${request.failedPath}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to migrate failed tracking file: ${msg}`);
    }
  }

  return { completed, failed };
}

/**
 * Initializes tracking for a new operation.
 *
 * Routes to database-backed or file-based tracking based on config.
 * If using database and legacy files exist, automatically migrates them.
 * If reset is true, deletes existing tracking files or creates new operation.
 *
 * @param config - Tracking configuration
 * @param inputFile - Input file path for header
 * @param options - Copy options for header
 */
export async function initializeTracking(
  config: TrackingConfig,
  inputFile: string,
  options: CopyOptions,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  // Route to database mode
  if (config.db) {
    const operationId = initializeTrackingInDb(config.db, config, inputFile, options, config.reset);

    // Store operation ID in config for subsequent calls
    config.operationId = operationId;

    // Auto-migrate legacy files if they exist
    const hasCompleted = await pathExists(config.completedFilePath);
    const hasFailed = await pathExists(config.failedFilePath);

    if (hasCompleted || hasFailed) {
      logInfo("Detected legacy tracking files, migrating to database...");
      const hash = formatOptionsHash(buildOptionsHash(options));
      const migrated = await migrateLegacyTrackingForInitialization(config.db, operationId, {
        inputFile,
        optionsHash: hash,
        mode: options.mode.type,
        completedPath: config.completedFilePath,
        failedPath: config.failedFilePath,
      });
      logSuccess(`Migrated ${migrated.completed} completed and ${migrated.failed} failed sources`);
    }

    return;
  }

  // Legacy file-based tracking
  if (config.reset) {
    logDebug("Resetting tracking files");
    if (await pathExists(config.completedFilePath)) {
      await unlink(config.completedFilePath);
      logDebug(`Deleted: ${config.completedFilePath}`);
    }
    if (await pathExists(config.failedFilePath)) {
      await unlink(config.failedFilePath);
      logDebug(`Deleted: ${config.failedFilePath}`);
    }
  }

  // Create completed file with header if it doesn't exist
  if (!(await pathExists(config.completedFilePath))) {
    const header = generateFileHeader(inputFile, options);
    await writeFile(config.completedFilePath, header, "utf-8");
    logDebug(`Created tracking file: ${config.completedFilePath}`);
  }
}

/**
 * Records a successfully completed source path.
 *
 * Routes to database or file-based tracking based on config.
 *
 * @param config - Tracking configuration
 * @param sourcePath - Source path that was completed
 */
export async function recordCompleted(config: TrackingConfig, sourcePath: string): Promise<void> {
  if (!config.enabled) {
    return;
  }

  // Route to database mode
  if (config.db && config.operationId !== undefined) {
    await recordCompletedInDb(config.db, config.operationId, sourcePath);
    return;
  }

  // Legacy file-based tracking
  const normalized = normalizePath(sourcePath);
  await appendFile(config.completedFilePath, normalized + "\n", "utf-8");
  logDebug(`Recorded completed: ${normalized}`);
}

/**
 * Records a completed album copy (granular per-suffix tracking).
 *
 * This enables range expansion support. When a user first runs with range 001-002,
 * each album-suffix combination is recorded. If they later expand to 001-020,
 * only the new suffixes (003-020) will be processed.
 *
 * Also supports rating-aware tracking: different rating filters (e.g., r50 vs r80)
 * create separate tracking states, allowing re-processing with different filters.
 *
 * Note: This only works with database-backed tracking. File-based tracking
 * does not support granular album copy tracking.
 *
 * @param config - Tracking configuration
 * @param sourcePath - Source directory path
 * @param albumName - Album folder name
 * @param suffix - Completed suffix (e.g., '001')
 * @param ratingKey - Rating filter key (e.g., 'r80', 's3', null for no filter)
 */
export async function recordCompletedAlbumCopy(
  config: TrackingConfig,
  sourcePath: string,
  albumName: string,
  suffix: string,
  ratingKey?: string | null,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  // Only database mode supports granular tracking
  if (config.db && config.operationId !== undefined) {
    recordCompletedAlbumCopyInDb(
      config.db,
      config.operationId,
      sourcePath,
      albumName,
      suffix,
      ratingKey,
    );
    return;
  }

  // File-based tracking: no granular album copy support
  // Just log a debug message - the source-level completion will still be tracked
  const ratingPart = ratingKey ? ` (rating: ${ratingKey})` : "";
  logDebug(
    `Skipping granular album copy tracking (legacy mode): ${sourcePath}/${albumName}-${suffix}${ratingPart}`,
  );
}

/**
 * Records a failed source path with error information.
 *
 * Routes to database or file-based tracking based on config.
 *
 * @param config - Tracking configuration
 * @param sourcePath - Source path that failed
 * @param error - Error message describing the failure
 */
export async function recordFailed(
  config: TrackingConfig,
  sourcePath: string,
  error: string,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  // Route to database mode
  if (config.db && config.operationId !== undefined) {
    await recordFailedInDb(config.db, config.operationId, sourcePath, error);
    return;
  }

  // Legacy file-based tracking
  const normalized = normalizePath(sourcePath);

  // Create failed file with header if it doesn't exist
  if (!(await pathExists(config.failedFilePath))) {
    const header = [
      `# Failed paths (errors encountered during processing)`,
      `# Generated by rfmedia on ${new Date().toISOString()}`,
      "",
    ].join("\n");
    await writeFile(config.failedFilePath, header, "utf-8");
  }

  // Record path with error as comment
  const line = `${normalized}\n# Error: ${error}\n`;
  await appendFile(config.failedFilePath, line, "utf-8");
  logDebug(`Recorded failed: ${normalized}`);
}

/**
 * Checks if a source path is already completed.
 *
 * @param state - Current tracking state
 * @param sourcePath - Path to check
 * @returns true if the source is already completed
 */
export function isSourceCompleted(state: TrackingState, sourcePath: string): boolean {
  const normalized = normalizePath(sourcePath);
  return state.completed.has(normalized);
}

/**
 * Filters a list of source paths to only pending (not completed) ones.
 *
 * @param paths - Array of source paths to filter
 * @param state - Current tracking state
 * @returns Object with pending paths array and count of skipped paths
 */
export function filterPendingSources(
  paths: string[],
  state: TrackingState,
): { pending: string[]; skipped: number } {
  const pending: string[] = [];
  let skipped = 0;

  for (const p of paths) {
    if (isSourceCompleted(state, p)) {
      logDebug(`Skipping completed source: ${p}`);
      skipped++;
    } else {
      pending.push(p);
    }
  }

  return { pending, skipped };
}

/**
 * Creates initial tracking stats for an operation.
 *
 * @param totalSources - Total number of sources to process
 * @param trackingFile - Path to tracking file (for display)
 * @returns Initial TrackingStats object
 */
export function createTrackingStats(totalSources: number, trackingFile?: string): TrackingStats {
  return {
    totalSources,
    processed: 0,
    skippedCompleted: 0,
    failed: 0,
    startTime: Date.now(),
    trackingFile,
  };
}

/**
 * Calculates timing statistics from tracking stats.
 *
 * @param stats - Tracking statistics
 * @returns Timing information including formatted duration
 */
export function calculateTimingStats(stats: TrackingStats): TimingStats {
  const endTime = stats.endTime ?? Date.now();
  const elapsedMs = endTime - stats.startTime;

  // Format elapsed time
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  let elapsedFormatted: string;
  if (minutes > 0) {
    elapsedFormatted = `${minutes}m ${seconds}s`;
  } else {
    elapsedFormatted = `${seconds}s`;
  }

  // Calculate sources per minute
  const sourcesProcessed = stats.processed + stats.failed;
  const sourcesPerMinute = elapsedMs > 0 ? (sourcesProcessed / elapsedMs) * 60000 : 0;

  return {
    elapsedMs,
    elapsedFormatted,
    sourcesPerMinute,
  };
}
