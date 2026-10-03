/**
 * Filter mode copy logic for rfmedia CLI.
 *
 * This module implements rating-based track copying where individual tracks
 * that meet a rating threshold are copied to a dedicated output folder
 * (e.g., "liked-songs") instead of copying entire albums.
 */

import path from "node:path";

import type {
  CopyOptions,
  CopyResult,
  FailedOperation,
  RatingFilter,
  ConvertFormat,
  PathEntry,
  CopyRange,
} from "../types/index.js";
import { createHistorySession, isHistoryEnabled, type HistoryRecorder } from "../lib/history.js";
import type { TrackingConfig, TrackingState, TrackingStats } from "../types/tracking.js";
import {
  initializeDatabase,
  closeDatabase,
  recordInventoryFile,
  updateOperationStatus,
  updateOperationCounts,
} from "../lib/db.js";
import type { DbConnection } from "../types/db.js";
import { formatSuffix, detectHighestSuffix, buildAutoRange } from "../lib/range.js";
import {
  readRating,
  meetsThreshold,
  meetsPlayCountThreshold,
  readRatingAndFormat,
  meetsMetadataFilters,
  hasMetadataFilters,
  evaluateSmartFilter,
  evaluateSmartFilterVerbose,
  countSmartFilterRules,
  formatFilterRule,
  type RuleEvaluationResult,
} from "../lib/ratings.js";
import { readExtendedMetadata, hasExtendedFilters } from "../lib/metadata.js";
import { findAudioFiles } from "../lib/audio.js";
import {
  copyOrLink,
  ensureDir,
  pathExists,
  getFileSize,
  getFilesStats,
  remove,
} from "../lib/filesystem.js";
import { calculateHash, verifyFileIntegrity } from "../lib/integrity.js";
import { createFileInventoryEntry } from "../lib/inventory.js";
import { readSourcePaths } from "../lib/input-file.js";
import {
  formatDryRun,
  isJsonMode,
  isDebugMode,
  logDebug,
  logError,
  logInfo,
  logWarn,
  colors,
  outputSuccess,
  outputInlineSuccess,
} from "../lib/logger.js";
import { extractPathInfo, detectLibraryRoot } from "../lib/path-info.js";
import { applyInteractiveSelectionFilter } from "../lib/interactive.js";
import {
  createTrackingConfig,
  createTrackingStats,
  loadTrackingState,
  initializeTracking,
  filterPendingSources,
  recordCompleted,
  recordFailed,
  calculateTimingStats,
  recordCompletedAlbumCopy,
  loadCompletedAlbumCopiesForSource,
  loadCompletedAlbumCopiesForLibraryRoot,
  buildOptionsHash,
  hasSourcePendingWorkForRange,
  isSourceCompleted,
} from "../lib/completed-tracker.js";
import { processInParallel } from "../lib/parallel.js";
import { runTasks } from "../lib/progress.js";
import { CopyProgressBar, isProgressEnabled } from "../lib/progress-bar.js";
import { convertFile, getConvertedFilename, getFormatDescription } from "../lib/convert.js";
import { allocateUniqueDestinationPaths } from "../lib/verify.js";
import { resolveOptionalScanAdapter } from "../lib/adapters/action-helpers.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { shouldUseUndoLegacyMode, resolveUndoDatabasePath } from "../lib/config.js";
import { collectFilterPreview, formatFilterPreviewOutput, formatBytes } from "../lib/preview.js";
import { formatAlbumModePreviewTable, formatCopySummaryTable } from "../lib/table-format.js";
import {
  generateUniquePath,
  resolveConflictInteractive,
  shouldReportConflictsAsJson,
  reportConflictsAsJsonAndExit,
} from "../lib/conflict-resolver.js";
import { isInteractive } from "../lib/prompt.js";
import type {
  ConflictContext,
  ConflictResolution,
  ConflictResolutionResult,
} from "../types/conflict.js";
import { getPluginManager } from "../lib/plugin-manager.js";
import {
  runProcessFileHooks,
  runBeforeCopyHooks,
  runAfterCopyHooks,
  runAfterBatchHooks,
} from "../lib/plugin-runner.js";
import type {
  ProcessFileContext,
  BeforeCopyContext,
  AfterCopyContext,
  AfterBatchContext,
} from "../types/index.js";

// ============================================================================
// Verbose Filter Output Helpers
// ============================================================================

/**
 * Threshold for warning about verbose output with large file counts.
 * When verbose mode is enabled and file count exceeds this, a warning is shown.
 */
const VERBOSE_WARNING_THRESHOLD = 100;

/**
 * Check if colors should be disabled.
 * Respects the NO_COLOR environment variable standard (https://no-color.org/).
 *
 * @returns true if colors should be disabled
 */
function shouldDisableColors(): boolean {
  return process.env["NO_COLOR"] !== undefined;
}

/**
 * Format a checkmark or X for rule pass/fail status.
 * Uses color coding unless NO_COLOR is set.
 *
 * @param passed - Whether the rule passed
 * @returns Formatted symbol with optional color
 */
function formatRuleStatus(passed: boolean): string {
  const noColor = shouldDisableColors();
  if (passed) {
    return noColor ? "[PASS]" : colors.green("[PASS]");
  } else {
    return noColor ? "[FAIL]" : colors.red("[FAIL]");
  }
}

/**
 * Format a single rule evaluation result for verbose output.
 *
 * @param result - Rule evaluation result
 * @returns Formatted string like "[PASS] rating >= 4.0"
 */
function formatRuleResult(result: RuleEvaluationResult): string {
  const status = formatRuleStatus(result.passed);
  const ruleStr = formatFilterRule(result.rule);
  return `${status} ${ruleStr}`;
}

/**
 * Format verbose output for a file's filter evaluation.
 * Shows per-rule results with pass/fail indicators.
 *
 * @param filename - Name of the file being evaluated
 * @param ruleResults - Array of per-rule evaluation results
 * @returns Formatted string for logging
 *
 * @example
 * // Output: "track.flac: [PASS] rating >= 4.0 | [FAIL] genre contains Rock"
 */
function formatVerboseFilterOutput(filename: string, ruleResults: RuleEvaluationResult[]): string {
  const parts = ruleResults.map(formatRuleResult);
  return `${filename}: ${parts.join(" | ")}`;
}

/**
 * Progress callback type for tracking file copy completion.
 */
type ProgressCallback = (fileBytes: number) => void;

/**
 * Options for deferred progress bar creation in album mode.
 */
interface DeferredProgressOptions {
  /** Operation name for the progress bar */
  operationName: string;
  /** User's progress preference (undefined = auto-detect) */
  progressPreference?: boolean;
}

/**
 * Result of pre-scanning audio files for rating threshold.
 */
interface PreScanResult {
  /** Files that meet the rating threshold */
  likedFiles: string[];
  /** Normalized rating values for liked files */
  likedFileRatings: Map<string, number | null>;
  /** Files that don't meet the threshold (filtered out) */
  filteredFiles: string[];
}

/**
 * Pre-scans audio files to determine which meet the rating and metadata thresholds.
 *
 * This is used for accurate progress bar initialization in standard filter mode,
 * allowing us to know the exact number of files that will be copied before
 * starting the actual copy operations.
 *
 * Supports two evaluation modes:
 * - Smart filter: Uses readExtendedMetadata() + evaluateSmartFilter() for nested boolean logic
 * - Legacy filter: Uses readRatingAndFormat() + meetsThreshold() for flat threshold checks
 *
 * Single-pass optimization: Each file is read exactly once regardless of evaluation mode.
 *
 * @param audioFiles - Array of audio file paths to scan
 * @param filter - Rating filter configuration (includes metadata filters and optional smartFilter)
 * @returns Object with liked files and filtered files
 */
async function preScanRatings(
  audioFiles: string[],
  filter: RatingFilter,
  signal?: AbortSignal,
): Promise<PreScanResult> {
  const likedFiles: string[] = [];
  const likedFileRatings = new Map<string, number | null>();
  const filteredFiles: string[] = [];

  // Determine evaluation mode: smart filter takes precedence over legacy filters
  const smartFilter = filter.smartFilter;
  const useSmartFilter = hasExtendedFilters(filter);
  const checkMetadata = hasMetadataFilters(filter);

  // Check if verbose mode is enabled (debug mode enables verbose filter output)
  const verboseMode = isDebugMode();

  // Log filter summary with name and rule count for smart filters
  if (useSmartFilter && smartFilter !== undefined) {
    const ruleCount = countSmartFilterRules(smartFilter);
    const filterName = filter.filterName ?? "unnamed";
    logDebug(`Evaluating smart filter: ${filterName}`);

    // Warn about verbose output with large file counts
    if (verboseMode && audioFiles.length > VERBOSE_WARNING_THRESHOLD) {
      logWarn(
        `Verbose mode with ${audioFiles.length} files may produce extensive output. ` +
          `Consider using with smaller test sets or disabling debug mode.`,
      );
    }
  } else {
    logDebug(
      `Evaluating legacy filter (minStars: ${filter.minStars}, minRating: ${filter.minRating})`,
    );
  }

  let passCount = 0;
  let failCount = 0;

  for (const filePath of audioFiles) {
    try {
      if (useSmartFilter && smartFilter !== undefined) {
        // Smart filter mode: use extended metadata for full filter evaluation
        // Single-pass: readExtendedMetadata() reads file once, provides all data needed
        const metadata = await readExtendedMetadata(filePath);

        if (metadata === null) {
          // Error reading file
          filteredFiles.push(filePath);
          failCount++;
          continue;
        }

        // Run processFile hooks
        const manager = getPluginManager();
        if (manager.isInitialized()) {
          const processContext: ProcessFileContext = { filePath, metadata, signal };
          await runProcessFileHooks([...manager.getPlugins()], processContext, { signal });
        }

        // Use verbose evaluation in debug mode to get per-rule results
        if (verboseMode) {
          const verboseResult = evaluateSmartFilterVerbose(metadata, smartFilter);
          const filename = path.basename(filePath);

          // Log per-file rule results
          logDebug(formatVerboseFilterOutput(filename, verboseResult.ruleResults));

          if (verboseResult.passed) {
            likedFiles.push(filePath);
            likedFileRatings.set(filePath, metadata.rating?.value ?? null);
            passCount++;
          } else {
            filteredFiles.push(filePath);
            failCount++;
            // Log which rule caused the failure
            if (verboseResult.failingRule) {
              logDebug(`  -> Failed on: ${formatFilterRule(verboseResult.failingRule)}`);
            }
          }
        } else {
          // Standard evaluation without verbose output
          const passes = evaluateSmartFilter(metadata, smartFilter);

          if (passes) {
            likedFiles.push(filePath);
            likedFileRatings.set(filePath, metadata.rating?.value ?? null);
            passCount++;
          } else {
            filteredFiles.push(filePath);
            failCount++;
          }
        }
      } else if (checkMetadata) {
        // Legacy mode with metadata filters: use combined reader for efficiency
        const result = await readRatingAndFormat(filePath);

        if (result === null) {
          // Error reading file
          filteredFiles.push(filePath);
          failCount++;
          continue;
        }

        const { rating, format } = result;

        // Check rating threshold first
        if (rating === null || !meetsThreshold(rating.value, filter)) {
          filteredFiles.push(filePath);
          failCount++;
          continue;
        }

        // Check play count threshold
        if (!meetsPlayCountThreshold(rating?.counter, filter.minPlays)) {
          logDebug(`Filtered by play count: ${rating?.counter ?? 0} < ${filter.minPlays}`);
          filteredFiles.push(filePath);
          failCount++;
          continue;
        }

        // Check metadata filters (duration, bitrate, codec)
        const metaResult = meetsMetadataFilters(format, filter);
        if (!metaResult.passes) {
          logDebug(`Filtered ${path.basename(filePath)}: ${metaResult.reason}`);
          filteredFiles.push(filePath);
          failCount++;
          continue;
        }

        // Passes all filters
        likedFiles.push(filePath);
        likedFileRatings.set(filePath, rating.value);
        passCount++;
      } else {
        // Legacy mode without metadata filters: use simpler rating-only check
        const rating = await readRating(filePath);

        if (rating === null) {
          // Unrated - filtered out
          filteredFiles.push(filePath);
          failCount++;
        } else if (meetsThreshold(rating.value, filter)) {
          // Meets threshold
          likedFiles.push(filePath);
          likedFileRatings.set(filePath, rating.value);
          passCount++;
        } else {
          // Below threshold
          filteredFiles.push(filePath);
          failCount++;
        }
      }
    } catch {
      // Error reading rating - treat as filtered
      filteredFiles.push(filePath);
      failCount++;
    }
  }

  // Log filter pass/fail counts with filter name for smart filters
  if (useSmartFilter) {
    const filterName = filter.filterName ?? "unnamed";
    logDebug(`Filter "${filterName}" complete: ${passCount} passed, ${failCount} filtered`);
  } else {
    logDebug(`Filter evaluation complete: ${passCount} passed, ${failCount} filtered`);
  }

  return { likedFiles, likedFileRatings, filteredFiles };
}

/**
 * Copies or converts a single audio file based on options.
 *
 * @param source - Source file path
 * @param dest - Destination file path
 * @param hardlink - Whether to use hardlinks for copy
 * @param convertFormat - If set, convert to this format instead of copying
 * @param recorder - Optional history recorder for undo support
 * @returns 'converted' | 'hardlink' | 'copy' indicating the method used
 */
async function copyOrConvertFile(
  source: string,
  dest: string,
  hardlink: boolean,
  convertFormat?: ConvertFormat,
  recorder?: HistoryRecorder,
): Promise<"converted" | "hardlink" | "copy"> {
  if (convertFormat) {
    await convertFile(source, dest, convertFormat);
    if (recorder) {
      await recorder.recordConvert(source, dest, convertFormat);
    }
    return "converted";
  }
  const method = await copyOrLink(source, dest, hardlink);
  if (recorder) {
    if (method === "hardlink") {
      await recorder.recordHardlink(source, dest);
    } else {
      await recorder.recordCopy(source, dest);
    }
  }
  return method;
}

/**
 * Gets the destination filename, handling conversion extension changes.
 *
 * @param originalFilename - Original filename
 * @param convertFormat - If set, change extension to match format
 * @returns Filename with appropriate extension
 */
function getDestFilename(originalFilename: string, convertFormat?: ConvertFormat): string {
  if (convertFormat) {
    return getConvertedFilename(originalFilename, convertFormat);
  }
  return originalFilename;
}

/**
 * Information about a track copy task in album mode.
 */
interface AlbumTrackCopyTask {
  /** Source track path */
  trackPath: string;
  /** Normalized rating value */
  rating: number | null;
  /** Destination path for this copy */
  destPath: string;
  /** Album destination directory */
  albumDest: string;
  /** Original filename */
  filename: string;
  /** Suffix being applied (null if no range) */
  suffix: string | null;
}

/**
 * Context for granular album copy tracking in filter mode.
 * Passed to processAlbumMode to enable per-suffix completion tracking.
 */
interface AlbumTrackingContext {
  /** Tracking configuration */
  config: TrackingConfig;
  /** Source path (artist directory or library root) */
  sourcePath: string;
  /** Map of album name to set of already completed suffixes (for single artist mode) */
  completedAlbumCopies: Map<string, Set<string>>;
  /** Map of artist path -> album name -> completed suffixes (for library root mode) */
  libraryRootCompletedCopies?: Map<string, Map<string, Set<string>>>;
  /** Rating filter key for rating-aware tracking (e.g., 'r80', 's3', null for no filter) */
  ratingKey?: string | null;
}

async function recordCopiedFileInventory(
  sourceRoot: string,
  filePath: string,
  destPath: string,
  rating: number | null,
  trackingContext: AlbumTrackingContext | undefined,
): Promise<void> {
  const db = trackingContext?.config.db;
  const operationId = trackingContext?.config.operationId;
  if (!db || operationId === undefined) {
    return;
  }

  const contentHash = await calculateHash(destPath);
  const inventoryEntry = await createFileInventoryEntry(
    sourceRoot,
    filePath,
    destPath,
    rating,
    contentHash,
  );

  recordInventoryFile(db, operationId, {
    sourcePath: path.resolve(sourceRoot),
    relativePath: inventoryEntry.relativePath,
    mtime: inventoryEntry.mtime,
    size: inventoryEntry.size,
    rating: inventoryEntry.rating,
    genre: inventoryEntry.genre ?? null,
    year: inventoryEntry.year ?? null,
    bpm: inventoryEntry.bpm ?? null,
    artist: inventoryEntry.artist ?? null,
    destPath: inventoryEntry.destPath,
    contentHash: inventoryEntry.contentHash ?? null,
  });
}

/**
 * Context for conflict resolution during copy operations.
 * Shared across file copy operations to support "Apply to All" functionality.
 */
interface ConflictResolutionContext {
  /** Map tracking "Apply to All" resolutions by conflict type */
  applyToAll: Map<string, ConflictResolution>;
  /** Map tracking used names for rename resolution */
  usedNames: Map<string, number>;
  /** Array of conflict resolutions that occurred */
  resolutions: ConflictResolutionResult[];
}

/**
 * Resolves a conflict for an existing file during copy operations.
 *
 * Determines the resolution action based on:
 * 1. --force flag (implies 'overwrite')
 * 2. --conflict-strategy option
 * 3. Interactive prompt (if TTY available and strategy is 'ask')
 * 4. Error if non-interactive and strategy is 'ask'
 *
 * @param sourcePath - Path to source file
 * @param destPath - Path to existing destination file
 * @param options - Options with force and conflictStrategy
 * @param conflictContext - Shared conflict resolution context with applyToAll state
 * @returns The resolution action to take
 * @throws Error if strategy is 'ask' and environment is non-interactive
 */
async function resolveFileConflict(
  sourcePath: string,
  destPath: string,
  options: { force: boolean; conflictStrategy?: import("../types/conflict.js").ConflictStrategy },
  conflictContext: ConflictResolutionContext,
): Promise<ConflictResolution> {
  const { force, conflictStrategy } = options;

  // --force implies overwrite
  if (force) {
    return "overwrite";
  }

  // Check for "Apply to All" resolution from previous prompts
  const previousResolution = conflictContext.applyToAll.get("exists");
  if (previousResolution) {
    logDebug(`  Using "Apply to All" resolution: ${previousResolution}`);
    return previousResolution;
  }

  // No conflict strategy specified and no force - default to skip
  if (!conflictStrategy) {
    return "skip";
  }

  // Handle explicit conflict strategies
  switch (conflictStrategy) {
    case "skip":
      return "skip";

    case "overwrite":
      return "overwrite";

    case "rename":
      return "rename";

    case "ask": {
      // Check for JSON mode FIRST - output conflict details as structured JSON
      // This must come before the isInteractive() check because JSON mode is typically non-interactive
      if (shouldReportConflictsAsJson(conflictStrategy)) {
        const context: ConflictContext = {
          sourcePath,
          destPath,
          conflictType: { type: "exists", destPath, destSize: 0 },
        };
        reportConflictsAsJsonAndExit([context], "copy");
      }

      // Interactive mode - prompt user for resolution
      if (!isInteractive()) {
        throw new Error(
          `Conflict detected at ${path.basename(destPath)} but running in non-interactive mode. ` +
            "Use --conflict-strategy=skip|overwrite|rename or --force to specify a resolution.",
        );
      }

      // Create conflict context for the prompt
      const context: ConflictContext = {
        sourcePath,
        destPath,
        conflictType: { type: "exists", destPath, destSize: 0 },
      };

      // Prompt user
      const result = await resolveConflictInteractive(context, {
        applyToAll: conflictContext.applyToAll,
      });

      // Update "Apply to All" map if user chose to apply to all
      if (result.applyToAll) {
        conflictContext.applyToAll.set("exists", result.resolution);
      }

      return result.resolution;
    }

    default: {
      // Exhaustive check for ConflictStrategy
      const exhaustiveCheck: never = conflictStrategy;
      throw new Error(`Unknown conflict strategy: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Process audio files in album mode.
 *
 * In album mode, tracks are grouped by album and only liked tracks are copied.
 * With a range, numbered album folder copies are created (Album-001, Album-002, etc.).
 * Without a range, albums are copied with only liked tracks.
 *
 * Uses parallel processing for rating reads and file copies.
 *
 * Supports granular tracking: when tracking context is provided, each completed
 * album-suffix combination is recorded individually, enabling range expansion on
 * subsequent runs.
 *
 * @param audioFiles - List of audio file paths to process
 * @param source - Source directory path
 * @param destination - Destination directory path
 * @param fallbackArtistName - Artist name (basename of source directory), used when isLibraryRoot=false
 * @param filter - Rating filter configuration
 * @param options - Copy options (dryRun, hardlink, force, workers, convertFormat, isLibraryRoot, conflictStrategy)
 * @param result - CopyResult object to update with counts
 * @param progressOptions - Optional deferred progress bar options (created after rating scan)
 * @param recorder - Optional history recorder for undo support
 * @param trackingContext - Optional tracking context for granular album copy tracking
 * @param conflictContext - Optional shared conflict resolution context
 */
async function processAlbumMode(
  audioFiles: string[],
  source: string,
  destination: string,
  fallbackArtistName: string,
  filter: RatingFilter,
  options: {
    dryRun: boolean;
    hardlink: boolean;
    force: boolean;
    workers: number;
    convertFormat?: ConvertFormat;
    requireDiskSpace?: boolean;
    isLibraryRoot?: boolean;
    verbose?: boolean;
    verify?: boolean;
    conflictStrategy?: import("../types/conflict.js").ConflictStrategy;
  },
  result: CopyResult,
  progressOptions?: DeferredProgressOptions,
  recorder?: HistoryRecorder,
  trackingContext?: AlbumTrackingContext,
  signal?: AbortSignal,
  inProgressFiles?: Set<string>,
  conflictContext?: ConflictResolutionContext,
): Promise<void> {
  const {
    dryRun,
    hardlink,
    force,
    workers,
    convertFormat,
    requireDiskSpace,
    isLibraryRoot = false,
    verbose = false,
    verify: verifyIntegrity = false,
    conflictStrategy,
  } = options;

  // Use provided conflict context or create local one for "Apply to All" support
  const localConflictContext = conflictContext ?? {
    applyToAll: new Map<string, ConflictResolution>(),
    usedNames: new Map<string, number>(),
    resolutions: [],
  };

  // Phase 1: Scan and group liked tracks by artist/album (parallel rating reads)
  logDebug(`Reading ratings for ${audioFiles.length} files with ${workers} workers`);
  const checkMetadata = hasMetadataFilters(filter);

  // Check if smart filter is defined (takes precedence over legacy filters)
  const smartFilter = filter.smartFilter;
  const useSmartFilter = hasExtendedFilters(filter);

  if (useSmartFilter && smartFilter !== undefined && !dryRun) {
    const ruleCount = countSmartFilterRules(smartFilter);
    // Album mode filtering (logging suppressed)
  }

  interface RatingResult {
    filePath: string;
    rating: number | null;
    meetsThreshold: boolean;
    meetsMetadata: boolean;
    meetsPlayCount: boolean;
    filterReason?: string;
    artistName: string;
    albumName: string;
  }

  const ratingResults = await processInParallel(
    audioFiles,
    async (filePath) => {
      const { artistName, albumName } = extractPathInfo(
        filePath,
        source,
        fallbackArtistName,
        isLibraryRoot,
      );

      // Smart filter mode: use extended metadata for full filter evaluation
      if (useSmartFilter && smartFilter !== undefined) {
        const metadata = await readExtendedMetadata(filePath);
        if (metadata === null) {
          return {
            filePath,
            rating: null,
            meetsThreshold: false,
            meetsMetadata: false,
            meetsPlayCount: true,
            artistName,
            albumName,
          };
        }

        // Evaluate smart filter against extended metadata
        const passes = evaluateSmartFilter(metadata, smartFilter);
        if (!passes) {
          logDebug(`Smart filter rejected: ${path.basename(filePath)}`);
        }
        return {
          filePath,
          rating: metadata.rating?.value ?? null,
          meetsThreshold: passes,
          meetsMetadata: true,
          meetsPlayCount: true,
          artistName,
          albumName,
        };
      } else if (checkMetadata) {
        // Legacy mode with metadata filters: use combined reader for efficiency
        const result = await readRatingAndFormat(filePath);
        if (result === null) {
          return {
            filePath,
            rating: null,
            meetsThreshold: false,
            meetsMetadata: false,
            meetsPlayCount: true,
            artistName,
            albumName,
          };
        }

        const { rating, format } = result;
        const meetsRating = rating !== null && meetsThreshold(rating.value, filter);

        if (!meetsRating) {
          return {
            filePath,
            rating: rating?.value ?? null,
            meetsThreshold: false,
            meetsMetadata: true,
            meetsPlayCount: true,
            artistName,
            albumName,
          };
        }

        // Check play count threshold
        const meetsPlays = meetsPlayCountThreshold(rating?.counter, filter.minPlays);

        // Check metadata filters
        const metaResult = meetsMetadataFilters(format, filter);
        return {
          filePath,
          rating: rating.value,
          meetsThreshold: true,
          meetsMetadata: metaResult.passes,
          meetsPlayCount: meetsPlays,
          filterReason: !meetsPlays
            ? `play count ${rating?.counter ?? 0} < ${filter.minPlays}`
            : metaResult.reason,
          artistName,
          albumName,
        };
      } else {
        // Legacy mode without metadata filters - use simpler rating-only check
        const rating = await readRating(filePath);
        const meets = rating !== null && meetsThreshold(rating.value, filter);
        return {
          filePath,
          rating: rating?.value ?? null,
          meetsThreshold: meets,
          meetsMetadata: true,
          meetsPlayCount: true,
          artistName,
          albumName,
        };
      }
    },
    {
      workers,
      signal,
      onProgress: (completed, total) => {
        logDebug(`Rating scan progress: ${completed}/${total}`);
      },
    },
  );

  // Group liked tracks by artist/album key
  // Key format: "artistName\0albumName" (null char as separator for uniqueness)
  const likedTracksByArtistAlbum = new Map<
    string,
    {
      artistName: string;
      albumName: string;
      tracks: Array<{ path: string; rating: number | null }>;
    }
  >();
  let filteredCount = 0;

  for (const ratingResult of ratingResults) {
    if (!ratingResult.success || ratingResult.value === undefined) {
      // Rating read failed, count as filtered
      filteredCount++;
      continue;
    }

    const {
      filePath,
      rating,
      meetsThreshold: meets,
      meetsMetadata,
      meetsPlayCount,
      filterReason,
      artistName,
      albumName,
    } = ratingResult.value;

    if (!meets) {
      filteredCount++;
      continue;
    }

    if (!meetsPlayCount) {
      if (filterReason) {
        logDebug(`Filtered ${path.basename(filePath)}: ${filterReason}`);
      }
      filteredCount++;
      continue;
    }

    if (!meetsMetadata) {
      if (filterReason) {
        logDebug(`Filtered ${path.basename(filePath)}: ${filterReason}`);
      }
      filteredCount++;
      continue;
    }

    // Create unique key for artist/album combination
    const key = `${artistName}\0${albumName}`;
    if (!likedTracksByArtistAlbum.has(key)) {
      likedTracksByArtistAlbum.set(key, { artistName, albumName, tracks: [] });
    }
    likedTracksByArtistAlbum.get(key)!.tracks.push({ path: filePath, rating });
  }

  result.filtered = filteredCount;

  // Phase 2: Build copy tasks
  const suffixes: Array<string | null> = filter.range
    ? Array.from({ length: filter.range.end - filter.range.start + 1 }, (_, i) =>
        formatSuffix(filter.range!.start + i, filter.range!.padWidth),
      )
    : [null]; // null means no suffix

  // Count total liked tracks for progress bar
  let totalLikedTracks = 0;
  let totalLikedBytes = 0;
  const likedTracksList: string[] = [];

  for (const { tracks } of likedTracksByArtistAlbum.values()) {
    totalLikedTracks += tracks.length;
    likedTracksList.push(...tracks.map((track) => track.path));
  }

  // Now we know the actual files to copy - create progress bar if requested
  let progressBar: CopyProgressBar | null = null;
  let onProgress: ProgressCallback | undefined;

  // Check if we need to pre-scan for progress bar or disk space
  const needsDiskSpaceCheck = !hardlink && requireDiskSpace !== false && !dryRun;

  if ((progressOptions || needsDiskSpaceCheck) && totalLikedTracks > 0) {
    // Pre-scan liked files only for accurate byte count
    const stats = await getFilesStats(likedTracksList);
    totalLikedBytes = stats.totalBytes;

    const rangeCount = suffixes.length;
    const totalFiles = totalLikedTracks * rangeCount;
    const totalBytes = totalLikedBytes * rangeCount;

    logDebug(
      `Liked tracks: ${totalLikedTracks} files, ${totalLikedBytes} bytes (x${rangeCount} copies = ${totalFiles} files, ${totalBytes} bytes)`,
    );

    // Disk space check (skip for hardlinks - no additional space needed)
    if (needsDiskSpaceCheck) {
      const { validateDiskSpace, estimateConvertedSize } = await import("../lib/disk.js");
      const { getLoadedConfig } = await import("../lib/loaded-config.js");

      const estimatedBytes = estimateConvertedSize(totalBytes, convertFormat);
      const margin = getLoadedConfig().copy?.diskSpaceMargin;

      // Use destination directly - may contain multiple artists when isLibraryRoot
      await validateDiskSpace(destination, estimatedBytes, {
        margin: margin !== undefined ? margin / 100 : undefined,
        requireSpace: requireDiskSpace,
      });
    }

    // Create progress bar if requested
    if (progressOptions) {
      progressBar = new CopyProgressBar({
        totalFiles,
        totalBytes,
        operationName: progressOptions.operationName,
        progress: progressOptions.progressPreference,
      });

      progressBar.start();
      onProgress = (fileBytes: number) => progressBar!.updateFile(fileBytes);
    }
  }

  // DRY-RUN MODE: Generate preview and return early
  if (dryRun) {
    if (!isJsonMode()) {
      console.error("");
      console.error(colors.bold("=== DRY-RUN PREVIEW (Album Mode) ==="));
      console.error("");

      // Show filter summary
      if (filteredCount > 0) {
        console.error(colors.gray(`Filtered out: ${filteredCount} tracks (below threshold)`));
      }
      console.error(colors.green(`Liked tracks: ${totalLikedTracks} tracks`));

      if (filter.range) {
        console.error(
          colors.blue(
            `Range: ${filter.range.start}-${filter.range.end} (${suffixes.length} copies per album)`,
          ),
        );
      }
      console.error("");
    }

    // Build album data for table
    const albumData: Array<{ artistName: string; albumName: string; trackCount: number }> = [];
    const rangeCount = suffixes.length;
    let totalCopies = 0;

    for (const [_key, { artistName, albumName, tracks }] of likedTracksByArtistAlbum) {
      albumData.push({
        artistName,
        albumName,
        trackCount: tracks.length,
      });
      totalCopies += tracks.length * rangeCount;
      result.created += tracks.length * rangeCount;
    }

    // Show table
    if (!isJsonMode() && albumData.length > 0) {
      const tableOutput = formatAlbumModePreviewTable(albumData, rangeCount);
      console.error(tableOutput);
    }

    // Show file-level details in verbose mode
    if (!isJsonMode() && verbose && albumData.length > 0) {
      console.error("");
      console.error(colors.bold("--- Track-Level Details ---"));
      console.error("");

      for (const [_key, { artistName, albumName, tracks }] of likedTracksByArtistAlbum) {
        console.error(colors.bold(`Album: ${albumName}`));
        console.error(
          colors.gray(`  ${tracks.length} liked tracks will be copied ${rangeCount} times:`),
        );

        const maxFiles = 10;
        for (let i = 0; i < Math.min(tracks.length, maxFiles); i++) {
          const track = tracks[i];
          if (track) {
            console.error(colors.green(`    + ${path.basename(track.path)}`));
          }
        }

        if (tracks.length > maxFiles) {
          console.error(colors.gray(`    ... (${tracks.length - maxFiles} more tracks)`));
        }
        console.error("");
      }
    }

    // Show totals
    if (!isJsonMode()) {
      console.error(colors.bold("--- Summary ---"));
      console.error(colors.green(`  Total copies: ${totalCopies} files`));
      if (filteredCount > 0) {
        console.error(colors.gray(`  Filtered: ${filteredCount} tracks`));
      }
      console.error("");
    }

    return;
  }

  try {
    // For each artist/album, we need to create first copies sequentially, then parallel
    for (const [_key, { artistName, albumName, tracks }] of likedTracksByArtistAlbum) {
      // Track first copy paths for optimization (copy from first copy instead of source)
      const firstCopyPaths = new Map<string, string>();

      // Process first suffix sequentially to establish first copies
      const firstSuffix = suffixes[0];
      const remainingSuffixes = suffixes.slice(1);

      const firstAlbumDest =
        firstSuffix !== null && firstSuffix !== undefined
          ? path.join(destination, artistName, `${albumName}-${firstSuffix}`)
          : path.join(destination, artistName, albumName);

      // Build consistent tracking source path:
      // - Library root mode: append artistName to source (e.g., /data/media/music/Artist)
      // - Artist mode: use source as-is (already /data/media/music/Artist)
      // This ensures source_path column always contains the artist folder
      const trackingSourcePath = isLibraryRoot ? path.join(source, artistName) : source;

      // Get completed suffixes for this album from tracking context
      // For library root mode, look up in the two-level map; otherwise use single-level map
      let completedSuffixes: Set<string>;
      if (isLibraryRoot && trackingContext?.libraryRootCompletedCopies) {
        const artistMap = trackingContext.libraryRootCompletedCopies.get(trackingSourcePath);
        completedSuffixes = artistMap?.get(albumName) ?? new Set<string>();
      } else {
        completedSuffixes =
          trackingContext?.completedAlbumCopies.get(albumName) ?? new Set<string>();
      }

      // Check if first suffix is already completed (skip if so, unless force mode)
      // Note: firstSuffix can be null (no range) or undefined (from noUncheckedIndexedAccess)
      const firstSuffixCompleted =
        firstSuffix !== null &&
        firstSuffix !== undefined &&
        completedSuffixes.has(firstSuffix) &&
        !force;
      let firstSuffixHadFailures = false;

      if (firstSuffixCompleted) {
        logDebug(`  Skipping tracked completed suffix: ${artistName}/${albumName}-${firstSuffix}`);
        // Populate firstCopyPaths from existing completed directory for subsequent copies
        // Iterate through source tracks to map original filenames to destination paths
        for (const track of tracks) {
          const trackPath = track.path;
          const originalFilename = path.basename(trackPath);
          const destFilename = getDestFilename(originalFilename, convertFormat);
          const destPath = path.join(firstAlbumDest, destFilename);

          // Check if the destination file exists
          if (await pathExists(destPath)) {
            firstCopyPaths.set(originalFilename, destPath);
          }
        }
        logDebug(
          `  Loaded ${firstCopyPaths.size} files from existing first copy: ${firstAlbumDest}`,
        );
      }

      // Create first copies for all tracks in this album (unless already completed)
      if (!firstSuffixCompleted) {
        for (const track of tracks) {
          const trackPath = track.path;
          const trackRating = track.rating;
          const originalFilename = path.basename(trackPath);
          // Get appropriate filename (may change extension if converting)
          const destFilename = getDestFilename(originalFilename, convertFormat);
          let destPath = path.join(firstAlbumDest, destFilename);

          // Get file size for progress tracking
          const fileSize = await getFileSize(trackPath);

          // Check if destination already exists - use conflict resolution
          if (await pathExists(destPath)) {
            // Resolve the conflict using the shared conflict context
            const resolution = await resolveFileConflict(
              trackPath,
              destPath,
              { force, conflictStrategy },
              localConflictContext,
            );

            if (resolution === "skip") {
              logDebug(`Conflict resolved as skip: ${destPath}`);
              await recordCopiedFileInventory(
                trackingSourcePath,
                trackPath,
                destPath,
                trackRating,
                trackingContext,
              );
              result.skipped++;
              // Still use as first copy source if it exists (key by original filename)
              if (!firstCopyPaths.has(originalFilename)) {
                firstCopyPaths.set(originalFilename, destPath);
              }
              // Report progress for skipped files
              onProgress?.(fileSize);
              continue;
            } else if (resolution === "overwrite") {
              logDebug(`Conflict resolved as overwrite: ${destPath}`);
              // Remove existing file before copy
              await import("../lib/filesystem.js").then((fs) => fs.remove(destPath));
              // Fall through to copy
            } else if (resolution === "rename") {
              // Generate a unique path for the renamed file
              const newDestPath = generateUniquePath(destPath, localConflictContext.usedNames);
              logDebug(`Conflict resolved as rename: ${destPath} -> ${newDestPath}`);

              // Record the conflict resolution
              const conflictResult: ConflictResolutionResult = {
                context: {
                  sourcePath: trackPath,
                  destPath,
                  conflictType: { type: "exists", destPath, destSize: 0 },
                },
                resolution: "rename",
                newPath: newDestPath,
                success: true,
              };
              localConflictContext.resolutions.push(conflictResult);
              if (result.conflictResolutions) {
                result.conflictResolutions.push(conflictResult);
              } else {
                result.conflictResolutions = [conflictResult];
              }

              destPath = newDestPath;
              // Fall through to copy with new path
            }
          }

          try {
            await ensureDir(firstAlbumDest);

            // Run beforeCopy hooks
            const manager = getPluginManager();
            if (manager.isInitialized()) {
              const beforeContext: BeforeCopyContext = {
                sourcePath: trackPath,
                destPath,
                isAudioFile: true, // In filter mode, all files are audio files
                convertFormat,
                signal,
              };
              await runBeforeCopyHooks([...manager.getPlugins()], beforeContext, { signal });
            }

            // First copy: convert from source if conversion enabled
            const method = await copyOrConvertFile(
              trackPath,
              destPath,
              hardlink,
              convertFormat,
              recorder,
            );
            firstCopyPaths.set(originalFilename, destPath);

            // Verify file integrity if requested (skip for converted; source and dest differ)
            if (verifyIntegrity && method !== "converted") {
              try {
                const valid = await verifyFileIntegrity(trackPath, destPath);
                if (!valid) {
                  await remove(destPath);
                  throw new Error(`Integrity check failed for ${originalFilename}`);
                }
              } catch (error) {
                logError(
                  `Verification failed for ${originalFilename}: ${(error as Error).message}`,
                );
                throw error;
              }
            }

            const methodDesc =
              method === "converted" ? "Converted" : method === "hardlink" ? "Linked" : "Copied";
            logDebug(`${methodDesc}: ${trackPath} -> ${destPath}`);
            await recordCopiedFileInventory(
              trackingSourcePath,
              trackPath,
              destPath,
              trackRating,
              trackingContext,
            );
            result.created++;

            // Run afterCopy hooks
            if (manager.isInitialized()) {
              const afterContext: AfterCopyContext = {
                sourcePath: trackPath,
                destPath,
                method:
                  method === "converted"
                    ? "converted"
                    : method === "hardlink"
                      ? "hardlink"
                      : "copy",
                fileSize,
                signal,
              };
              await runAfterCopyHooks(
                [...manager.getPlugins()],
                afterContext,
                {
                  source: trackPath,
                  created: 1,
                  skipped: 0,
                  filtered: 0,
                  failed: [],
                },
                { signal },
              );
            }

            // Report progress
            onProgress?.(fileSize);
          } catch (err) {
            firstSuffixHadFailures = true;
            const error = err as Error;
            result.failed.push({
              path: destPath,
              message: error.message,
              code: (error as NodeJS.ErrnoException).code,
            });
            logWarn(`Failed to copy ${trackPath}: ${error.message}`);
          }
        }

        // Record granular completion for first suffix (only if not dry-run and no failures)
        if (
          trackingContext &&
          !dryRun &&
          !firstSuffixHadFailures &&
          firstSuffix !== null &&
          firstSuffix !== undefined
        ) {
          await recordCompletedAlbumCopy(
            trackingContext.config,
            trackingSourcePath, // Use artist folder path (consistent across modes)
            albumName, // Always just the album name
            firstSuffix,
            trackingContext.ratingKey,
          );
        }
      }

      // Process remaining suffixes in parallel (if any)
      if (remainingSuffixes.length > 0 && firstCopyPaths.size > 0) {
        // Filter out already-completed suffixes
        const pendingSuffixes = remainingSuffixes.filter((suffix) => {
          if (suffix !== null && completedSuffixes.has(suffix) && !force) {
            logDebug(`  Skipping tracked completed suffix: ${artistName}/${albumName}-${suffix}`);
            return false;
          }
          return true;
        });

        if (pendingSuffixes.length === 0) {
          logDebug(`  All remaining suffixes already completed for: ${artistName}/${albumName}`);
        } else {
          // Build all copy tasks for pending suffixes
          const copyTasks: AlbumTrackCopyTask[] = [];

          for (const suffix of pendingSuffixes) {
            const albumDest =
              suffix !== null
                ? path.join(destination, artistName, `${albumName}-${suffix}`)
                : path.join(destination, artistName, albumName);

            for (const track of tracks) {
              const trackPath = track.path;
              const originalFilename = path.basename(trackPath);
              // Subsequent copies use the converted filename from first copy
              const destFilename = getDestFilename(originalFilename, convertFormat);
              const destPath = path.join(albumDest, destFilename);
              copyTasks.push({
                trackPath,
                rating: track.rating,
                destPath,
                albumDest,
                filename: originalFilename,
                suffix,
              });
            }
          }

          logDebug(
            `Processing ${copyTasks.length} album track copies in parallel with ${workers} workers`,
          );

          const copyResults = await processInParallel(
            copyTasks,
            async (task) => {
              // Get file size for progress tracking
              const fileSize = await getFileSize(task.trackPath);
              let finalDestPath = task.destPath;

              // Check if destination already exists - handle conflict
              if (await pathExists(task.destPath)) {
                // Determine resolution based on force flag and conflict strategy
                // Note: 'ask' strategy defaults to 'skip' in parallel context (can't prompt)
                let resolution: ConflictResolution = "skip";

                if (force) {
                  resolution = "overwrite";
                } else if (conflictStrategy === "overwrite") {
                  resolution = "overwrite";
                } else if (conflictStrategy === "rename") {
                  resolution = "rename";
                } else {
                  // 'skip', 'ask', or undefined - all treated as skip in parallel context
                  // For 'ask', we can't prompt in parallel, so skip is the safe default
                  resolution = "skip";
                }

                if (resolution === "skip") {
                  await recordCopiedFileInventory(
                    trackingSourcePath,
                    task.trackPath,
                    task.destPath,
                    task.rating,
                    trackingContext,
                  );
                  // Report progress for skipped files
                  onProgress?.(fileSize);
                  return { skipped: true, destPath: task.destPath, fileSize, suffix: task.suffix };
                } else if (resolution === "overwrite") {
                  // Remove existing file before copy
                  const { remove } = await import("../lib/filesystem.js");
                  await remove(task.destPath);
                  // Fall through to copy
                } else if (resolution === "rename") {
                  // Generate unique path - use a local usedNames map for this task batch
                  // Note: For rename in parallel, each task gets a unique suffix
                  const localUsedNames = new Map<string, number>();
                  localUsedNames.set(path.basename(task.destPath).toLowerCase(), 2);
                  finalDestPath = generateUniquePath(task.destPath, localUsedNames);
                  // Fall through to copy with new path
                }
              }

              // Track this destination as in-progress
              if (inProgressFiles) {
                inProgressFiles.add(finalDestPath);
              }

              await ensureDir(task.albumDest);

              // Run beforeCopy hooks
              const hookManager = getPluginManager();
              if (hookManager.isInitialized()) {
                const beforeContext: BeforeCopyContext = {
                  sourcePath: task.trackPath,
                  destPath: finalDestPath,
                  isAudioFile: true, // In filter mode, all files are audio files
                  signal,
                };
                await runBeforeCopyHooks([...hookManager.getPlugins()], beforeContext, { signal });
              }

              // Use first copy as source for optimization
              const copySource = firstCopyPaths.get(task.filename) ?? task.trackPath;
              const method = await copyOrLink(copySource, finalDestPath, hardlink, signal);
              // Record history for undo support
              if (recorder) {
                if (method === "hardlink") {
                  await recorder.recordHardlink(copySource, finalDestPath);
                } else {
                  await recorder.recordCopy(copySource, finalDestPath);
                }
              }

              // Verify file integrity if requested (this path is always copy/hardlink)
              if (verifyIntegrity) {
                try {
                  const valid = await verifyFileIntegrity(copySource, finalDestPath);
                  if (!valid) {
                    await remove(finalDestPath);
                    throw new Error(`Integrity check failed for ${task.filename}`);
                  }
                } catch (error) {
                  logError(`Verification failed for ${task.filename}: ${(error as Error).message}`);
                  throw error;
                }
              }

              await recordCopiedFileInventory(
                trackingSourcePath,
                task.trackPath,
                finalDestPath,
                task.rating,
                trackingContext,
              );

              // Run afterCopy hooks
              if (hookManager.isInitialized()) {
                const afterContext: AfterCopyContext = {
                  sourcePath: task.trackPath,
                  destPath: finalDestPath,
                  method: method === "hardlink" ? "hardlink" : "copy",
                  fileSize,
                  signal,
                };
                await runAfterCopyHooks(
                  [...hookManager.getPlugins()],
                  afterContext,
                  {
                    source: task.trackPath,
                    created: 1,
                    skipped: 0,
                    filtered: 0,
                    failed: [],
                  },
                  { signal },
                );
              }

              // Report progress after copy
              onProgress?.(fileSize);

              // Remove from in-progress tracking after successful copy
              if (inProgressFiles) {
                inProgressFiles.delete(finalDestPath);
              }

              return {
                skipped: false,
                destPath: finalDestPath,
                method,
                fileSize,
                suffix: task.suffix,
                renamed: finalDestPath !== task.destPath,
                originalDestPath: task.destPath,
              };
            },
            {
              workers,
              signal,
              onProgress: (completed, total) => {
                logDebug(`Album track copy progress: ${completed}/${total}`);
              },
            },
          );

          // Track success/failure per suffix for granular tracking
          const suffixFailures = new Set<string>();

          // Process results
          for (const copyResult of copyResults) {
            if (!copyResult.success) {
              const task = copyTasks[copyResult.index];
              if (task !== undefined) {
                const error = copyResult.error ?? new Error("Unknown error");
                result.failed.push({
                  path: task.destPath,
                  message: error.message,
                  code: (error as NodeJS.ErrnoException).code,
                });
                logWarn(`Failed to copy ${task.trackPath}: ${error.message}`);
                // Mark this suffix as having failures
                if (task.suffix !== null) {
                  suffixFailures.add(task.suffix);
                }
              }
              continue;
            }

            const value = copyResult.value;
            if (value === undefined) continue;

            if (value.skipped) {
              logDebug(`Exists, skipping: ${value.destPath}`);
              result.skipped++;
            } else {
              logDebug(`${value.method === "hardlink" ? "Linked" : "Copied"}: ${value.destPath}`);
              result.created++;

              // Track rename resolutions
              if (value.renamed && value.originalDestPath) {
                const task = copyTasks[copyResult.index];
                if (task !== undefined) {
                  const conflictResult: ConflictResolutionResult = {
                    context: {
                      sourcePath: task.trackPath,
                      destPath: value.originalDestPath,
                      conflictType: {
                        type: "exists",
                        destPath: value.originalDestPath,
                        destSize: 0,
                      },
                    },
                    resolution: "rename",
                    newPath: value.destPath,
                    success: true,
                  };
                  localConflictContext.resolutions.push(conflictResult);
                  if (result.conflictResolutions) {
                    result.conflictResolutions.push(conflictResult);
                  } else {
                    result.conflictResolutions = [conflictResult];
                  }
                }
              }
            }
          }

          // Record granular completion for successful suffixes
          if (trackingContext) {
            for (const suffix of pendingSuffixes) {
              if (suffix !== null && !suffixFailures.has(suffix)) {
                await recordCompletedAlbumCopy(
                  trackingContext.config,
                  trackingSourcePath, // Use artist folder path (consistent across modes)
                  albumName, // Always just the album name
                  suffix,
                  trackingContext.ratingKey,
                );
              }
            }
          }
        }
      }
    }
  } finally {
    // Stop progress bar if we created one
    if (progressBar) {
      progressBar.stop();
    }
  }
}

/**
 * Process tracks in parallel using the provided processor function.
 *
 * @param tracks - Array of track file paths
 * @param processor - Async function to process each track
 * @param workers - Number of parallel workers
 * @param signal - Optional abort signal for cancellation support
 */
async function processTracksInParallel(
  tracks: string[],
  processor: (filePath: string) => Promise<void>,
  workers: number,
  signal?: AbortSignal,
): Promise<void> {
  await processInParallel(
    tracks,
    async (filePath) => {
      await processor(filePath);
      return filePath;
    },
    {
      workers,
      signal,
      onProgress: (completed, total) => {
        logDebug(`Track processing progress: ${completed}/${total}`);
      },
    },
  );
}

/**
 * Builds per-source options by applying PathEntry overrides to base options.
 *
 * Per-source values (from YAML --paths) take precedence over CLI options.
 * Handles: filterName, outputFolder, convertFormat
 *
 * @param baseOptions - Base options from CLI/config
 * @param entry - Source entry with optional per-source overrides
 * @returns Modified options with per-source values applied
 */
function buildPerSourceOptions(baseOptions: CopyOptions, entry: PathEntry): CopyOptions {
  // If no per-source overrides, return base options as-is
  if (!entry.filterName && !entry.outputFolder && !entry.convertFormat) {
    return baseOptions;
  }

  // Start with a shallow copy of base options
  let options = { ...baseOptions };

  // Apply per-source convertFormat (already validated at YAML parse time)
  if (entry.convertFormat) {
    options = {
      ...options,
      convertFormat: entry.convertFormat,
    };
    logDebug(`Per-source convert: ${entry.convertFormat}`);
  }

  // Apply per-source filter and outputFolder (only in filter mode)
  if (options.mode.type === "filter") {
    const baseRating = options.mode.rating;
    let modifiedRating = baseRating;

    // Apply per-source filter
    if (entry.filterName) {
      const config = getLoadedConfig();
      const availableFilters = config.filters ?? {};
      const smartFilter = availableFilters[entry.filterName];

      if (smartFilter) {
        modifiedRating = {
          ...modifiedRating,
          smartFilter,
          filterName: entry.filterName,
          // Clear legacy rating options when using smart filter
          minStars: undefined,
          minRating: undefined,
        };
        logDebug(`Per-source filter: ${entry.filterName}`);
      } else {
        // This should not happen as we validate in the command layer, but handle gracefully
        logWarn(`Filter "${entry.filterName}" not found for ${entry.path}, using default`);
      }
    }

    // Apply per-source outputFolder
    if (entry.outputFolder) {
      modifiedRating = {
        ...modifiedRating,
        outputFolder: entry.outputFolder,
      };
      logDebug(`Per-source outputFolder: ${entry.outputFolder}`);
    }

    // Create new mode with modified rating
    if (modifiedRating !== baseRating) {
      options = {
        ...options,
        mode: {
          type: "filter",
          rating: modifiedRating,
        },
      };
    }
  }

  return options;
}

/**
 * Execute filter mode copy: copy tracks meeting rating threshold.
 *
 * Scans all audio files in the source directory recursively, reads their
 * ratings, and copies only those meeting the specified threshold to the
 * output folder structure.
 *
 * Supports granular tracking in album mode: when trackingConfig is provided
 * with a database connection, each album-suffix combination is tracked
 * individually. This enables range expansion on subsequent runs.
 *
 * @param source - Source directory containing audio files
 * @param destination - Base destination directory
 * @param options - Copy options including filter settings and dry-run mode
 * @param recorder - Optional history recorder for undo support
 * @param trackingConfig - Optional tracking config for granular album copy tracking
 * @param signal - Optional abort signal for cancellation support
 * @param inProgressFiles - Set to track files currently being written
 * @returns Result with counts of created, skipped, filtered, and failed files
 */
export async function executeFilterCopy(
  source: string,
  destination: string,
  options: CopyOptions,
  recorder?: HistoryRecorder,
  trackingConfig?: TrackingConfig,
  signal?: AbortSignal,
  inProgressFiles?: Set<string>,
): Promise<CopyResult> {
  // Validate mode is filter
  if (options.mode.type !== "filter") {
    throw new Error("executeFilterCopy called with non-filter mode");
  }

  const filter: RatingFilter = options.mode.rating;
  const { dryRun, hardlink, force, workers, convertFormat, conflictStrategy, verify } = options;

  const result: CopyResult = {
    source,
    created: 0,
    skipped: 0,
    filtered: 0,
    failed: [],
  };

  // Create conflict resolution context for this copy session
  const conflictContext: ConflictResolutionContext = {
    applyToAll: new Map<string, ConflictResolution>(),
    usedNames: new Map<string, number>(),
    resolutions: [],
  };

  // Validate source directory exists
  if (!(await pathExists(source))) {
    throw new Error(`Source directory does not exist: ${source}`);
  }

  // Fallback artist name from source directory (used when source is artist folder, not library root)
  const fallbackArtistName = path.basename(source);

  // Track requested paths per output folder so copy and verify share one allocation policy.
  const requestedPathsPerFolder = new Map<string, string[]>();
  // Preserve the existing per-folder conflict rename state.
  const usedNamesPerFolder = new Map<string, Map<string, number>>();

  // Context for task progress tracking
  interface FilterContext {
    audioFiles: string[];
    processed: number;
    isLibraryRoot: boolean;
  }

  const ctx: FilterContext = {
    audioFiles: [],
    processed: 0,
    isLibraryRoot: false,
  };

  // Progress bar for copy operations (created later after scan)
  let progressBar: CopyProgressBar | null = null;

  // Process a single audio file
  const processFile = async (filePath: string): Promise<void> => {
    const filename = path.basename(filePath);
    // Get file size for progress tracking
    const fileSize = await getFileSize(filePath);
    let inventoryRating: number | null = null;

    try {
      if (hasExtendedFilters(filter)) {
        const smartFilter = filter.smartFilter;
        if (smartFilter === undefined) {
          result.filtered++;
          progressBar?.updateFile(fileSize);
          return;
        }

        const metadata = await readExtendedMetadata(filePath);
        if (metadata === null) {
          logDebug(`Failed to read metadata, skipping: ${filePath}`);
          result.filtered++;
          progressBar?.updateFile(fileSize);
          return;
        }

        const manager = getPluginManager();
        if (manager.isInitialized()) {
          const processContext: ProcessFileContext = { filePath, metadata, signal };
          await runProcessFileHooks([...manager.getPlugins()], processContext, { signal });
        }

        const passes = evaluateSmartFilter(metadata, smartFilter);
        if (!passes) {
          logDebug(`Smart filter rejected: ${filePath}`);
          result.filtered++;
          progressBar?.updateFile(fileSize);
          return;
        }
        inventoryRating = metadata.rating?.value ?? null;
      } else {
        // Read rating from file (legacy path)
        const rating = await readRating(filePath);

        // Check if track meets threshold
        if (rating === null) {
          logDebug(`Unrated track, skipping: ${filePath}`);
          result.filtered++;
          // Report progress for filtered files
          progressBar?.updateFile(fileSize);
          return;
        }

        if (!meetsThreshold(rating.value, filter)) {
          logDebug(`Below threshold (${rating.value.toFixed(2)}), skipping: ${filePath}`);
          result.filtered++;
          // Report progress for filtered files
          progressBar?.updateFile(fileSize);
          return;
        }

        // Check play count threshold
        if (!meetsPlayCountThreshold(rating.counter, filter.minPlays)) {
          logDebug(
            `Below play count threshold (${rating.counter ?? 0} < ${filter.minPlays}), skipping: ${filePath}`,
          );
          result.filtered++;
          // Report progress for filtered files
          progressBar?.updateFile(fileSize);
          return;
        }
        inventoryRating = rating.value;
      }

      // Track meets threshold - determine destination path
      const { artistName: extractedArtist, albumName } = extractPathInfo(
        filePath,
        source,
        fallbackArtistName,
        ctx.isLibraryRoot,
      );

      let destDir: string;
      if (filter.preserveStructure) {
        // Keep album subfolders: Artist/liked-songs/Album/
        destDir = path.join(destination, extractedArtist, filter.outputFolder, albumName);
      } else {
        // Flat structure: Artist/liked-songs/
        destDir = path.join(destination, extractedArtist, filter.outputFolder);
      }

      // Get or create the ordered requested-path list for this folder.
      let requestedPaths = requestedPathsPerFolder.get(destDir);
      if (!requestedPaths) {
        requestedPaths = [];
        requestedPathsPerFolder.set(destDir, requestedPaths);
      }
      let usedNames = usedNamesPerFolder.get(destDir);
      if (!usedNames) {
        usedNames = new Map<string, number>();
        usedNamesPerFolder.set(destDir, usedNames);
      }

      // Determine how many copies to create
      const copies = filter.range
        ? Array.from(
            { length: filter.range.end - filter.range.start + 1 },
            (_, i) => filter.range!.start + i,
          )
        : [null]; // null means no suffix

      let firstCopyPath: string | null = null;

      for (const suffixNum of copies) {
        // Build destination filename with optional suffix
        // Handle conversion extension change
        const baseFilename = getDestFilename(filename, convertFormat);
        const ext = path.extname(baseFilename);
        const baseName = path.basename(baseFilename, ext);
        const destFilename =
          suffixNum !== null
            ? `${baseName}-${formatSuffix(suffixNum, filter.range!.padWidth)}${ext}`
            : baseFilename;

        requestedPaths.push(path.join(destDir, destFilename));
        const destPath = allocateUniqueDestinationPaths(requestedPaths)[requestedPaths.length - 1]!;
        const nameKey = destFilename.toLowerCase();
        usedNames.set(nameKey, (usedNames.get(nameKey) ?? 1) + 1);

        // Get unique path (handles duplicate filenames from different albums)
        let finalDestPath = destPath;

        // Check if destination already exists - handle conflict
        if (await pathExists(destPath)) {
          // Determine resolution based on force flag and conflict strategy
          // Note: 'ask' strategy requires sequential handling - in parallel context, use skip
          let resolution: ConflictResolution = "skip";

          if (force) {
            resolution = "overwrite";
          } else if (conflictStrategy === "overwrite") {
            resolution = "overwrite";
          } else if (conflictStrategy === "rename") {
            resolution = "rename";
          } else {
            // 'skip', 'ask', or undefined - treated as skip in this parallel-capable context
            // For proper 'ask' handling, the caller should pre-validate conflicts
            resolution = "skip";
          }

          if (resolution === "skip") {
            logDebug(`Exists, skipping: ${destPath}`);
            await recordCopiedFileInventory(
              ctx.isLibraryRoot ? path.join(source, extractedArtist) : source,
              filePath,
              destPath,
              inventoryRating,
              trackingContext,
            );
            result.skipped++;
            // Report progress for skipped files (only once per source file)
            if (suffixNum === copies[0]) {
              progressBar?.updateFile(fileSize);
            }
            continue;
          } else if (resolution === "overwrite") {
            logDebug(`Conflict resolved as overwrite: ${destPath}`);
            // Remove existing file before copy (done in actual copy block)
            const { remove } = await import("../lib/filesystem.js");
            await remove(destPath);
            // Fall through to copy
          } else if (resolution === "rename") {
            // Generate unique path using the shared usedNames map for this folder
            finalDestPath = generateUniquePath(destPath, usedNames);
            logDebug(`Conflict resolved as rename: ${destPath} -> ${finalDestPath}`);

            // Record the conflict resolution
            const conflictResult: ConflictResolutionResult = {
              context: {
                sourcePath: filePath,
                destPath,
                conflictType: { type: "exists", destPath, destSize: 0 },
              },
              resolution: "rename",
              newPath: finalDestPath,
              success: true,
            };
            conflictContext.resolutions.push(conflictResult);
            if (result.conflictResolutions) {
              result.conflictResolutions.push(conflictResult);
            } else {
              result.conflictResolutions = [conflictResult];
            }
            // Fall through to copy with new path
          }
        }

        if (dryRun) {
          const action =
            convertFormat && firstCopyPath === null
              ? `convert (${convertFormat}) track`
              : "copy track";
          logInfo(formatDryRun(`${action}: ${filePath} -> ${finalDestPath}`));
          result.created++;
        } else {
          await ensureDir(destDir);

          // Run beforeCopy hooks
          const hookManager = getPluginManager();
          if (hookManager.isInitialized()) {
            const beforeContext: BeforeCopyContext = {
              sourcePath: filePath,
              destPath: finalDestPath,
              isAudioFile: true,
              convertFormat,
            };
            await runBeforeCopyHooks([...hookManager.getPlugins()], beforeContext, { signal });
          }

          // Copy optimization: first copy converts from source, subsequent copies from first copy
          const copySource = firstCopyPath ?? filePath;
          // Only convert on first copy; subsequent copies just copy the already converted file
          const method =
            firstCopyPath === null
              ? await copyOrConvertFile(
                  copySource,
                  finalDestPath,
                  hardlink,
                  convertFormat,
                  recorder,
                )
              : await copyOrLink(copySource, finalDestPath, hardlink);

          // Record history for subsequent copies (first copy recorded by copyOrConvertFile)
          if (recorder && firstCopyPath !== null) {
            if (method === "hardlink") {
              await recorder.recordHardlink(copySource, finalDestPath);
            } else {
              await recorder.recordCopy(copySource, finalDestPath);
            }
          }

          // Verify file integrity if requested (skip for converted)
          if (verify && method !== "converted") {
            try {
              const valid = await verifyFileIntegrity(copySource, finalDestPath);
              if (!valid) {
                await remove(finalDestPath);
                throw new Error(`Integrity check failed for ${filename}`);
              }
            } catch (error) {
              logError(`Verification failed for ${filename}: ${(error as Error).message}`);
              throw error;
            }
          }

          if (firstCopyPath === null) {
            firstCopyPath = finalDestPath;
          }

          const methodDesc =
            method === "converted" ? "Converted" : method === "hardlink" ? "Linked" : "Copied";
          logDebug(`${methodDesc}: ${copySource} -> ${finalDestPath}`);
          await recordCopiedFileInventory(
            ctx.isLibraryRoot ? path.join(source, extractedArtist) : source,
            filePath,
            finalDestPath,
            inventoryRating,
            trackingContext,
          );
          result.created++;

          // Run afterCopy hooks
          if (hookManager.isInitialized()) {
            const afterContext: AfterCopyContext = {
              sourcePath: filePath,
              destPath: finalDestPath,
              method:
                method === "converted" ? "converted" : method === "hardlink" ? "hardlink" : "copy",
              fileSize,
              signal,
            };
            await runAfterCopyHooks(
              [...hookManager.getPlugins()],
              afterContext,
              {
                source: filePath,
                created: 1,
                skipped: 0,
                filtered: 0,
                failed: [],
              },
              { signal },
            );
          }

          // Report progress after copy (only once per source file)
          if (suffixNum === copies[0]) {
            progressBar?.updateFile(fileSize);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to process ${filePath}: ${message}`);

      const failedOp: FailedOperation = {
        path: filePath,
        message,
      };

      // Extract error code if available
      if (error instanceof Error && "code" in error) {
        failedOp.code = (error as NodeJS.ErrnoException).code;
      }

      result.failed.push(failedOp);
    }
  };

  // Process a pre-scanned liked file (already known to meet threshold)
  // This version reports progress for EACH copy operation, not just once per source
  const processLikedFile = async (
    filePath: string,
    inventoryRating: number | null,
  ): Promise<void> => {
    const filename = path.basename(filePath);
    // Get file size for progress tracking
    const fileSize = await getFileSize(filePath);

    try {
      // Track already meets threshold - determine destination path
      const { artistName: extractedArtist, albumName } = extractPathInfo(
        filePath,
        source,
        fallbackArtistName,
        ctx.isLibraryRoot,
      );

      let destDir: string;
      if (filter.preserveStructure) {
        // Keep album subfolders: Artist/liked-songs/Album/
        destDir = path.join(destination, extractedArtist, filter.outputFolder, albumName);
      } else {
        // Flat structure: Artist/liked-songs/
        destDir = path.join(destination, extractedArtist, filter.outputFolder);
      }

      // Get or create the ordered requested-path list for this folder.
      let requestedPaths = requestedPathsPerFolder.get(destDir);
      if (!requestedPaths) {
        requestedPaths = [];
        requestedPathsPerFolder.set(destDir, requestedPaths);
      }
      let usedNames = usedNamesPerFolder.get(destDir);
      if (!usedNames) {
        usedNames = new Map<string, number>();
        usedNamesPerFolder.set(destDir, usedNames);
      }

      // Determine how many copies to create
      const copies = filter.range
        ? Array.from(
            { length: filter.range.end - filter.range.start + 1 },
            (_, i) => filter.range!.start + i,
          )
        : [null]; // null means no suffix

      let firstCopyPath: string | null = null;

      for (const suffixNum of copies) {
        // Build destination filename with optional suffix
        // Handle conversion extension change
        const baseFilename = getDestFilename(filename, convertFormat);
        const ext = path.extname(baseFilename);
        const baseName = path.basename(baseFilename, ext);
        const destFilename =
          suffixNum !== null
            ? `${baseName}-${formatSuffix(suffixNum, filter.range!.padWidth)}${ext}`
            : baseFilename;

        requestedPaths.push(path.join(destDir, destFilename));
        const destPath = allocateUniqueDestinationPaths(requestedPaths)[requestedPaths.length - 1]!;
        const nameKey = destFilename.toLowerCase();
        usedNames.set(nameKey, (usedNames.get(nameKey) ?? 1) + 1);
        let finalDestPath = destPath;

        // Check if destination already exists - handle conflict
        if (await pathExists(destPath)) {
          // Determine resolution based on force flag and conflict strategy
          // Note: 'ask' strategy requires sequential handling - in parallel context, use skip
          let resolution: ConflictResolution = "skip";

          if (force) {
            resolution = "overwrite";
          } else if (conflictStrategy === "overwrite") {
            resolution = "overwrite";
          } else if (conflictStrategy === "rename") {
            resolution = "rename";
          } else {
            // 'skip', 'ask', or undefined - treated as skip in this parallel-capable context
            resolution = "skip";
          }

          if (resolution === "skip") {
            logDebug(`Exists, skipping: ${destPath}`);
            await recordCopiedFileInventory(
              ctx.isLibraryRoot ? path.join(source, extractedArtist) : source,
              filePath,
              destPath,
              inventoryRating,
              trackingContext,
            );
            result.skipped++;
            // Report progress for each skipped copy
            progressBar?.updateFile(fileSize);
            continue;
          } else if (resolution === "overwrite") {
            logDebug(`Conflict resolved as overwrite: ${destPath}`);
            // Remove existing file before copy
            const { remove } = await import("../lib/filesystem.js");
            await remove(destPath);
            // Fall through to copy
          } else if (resolution === "rename") {
            // Generate unique path using the shared usedNames map for this folder
            finalDestPath = generateUniquePath(destPath, usedNames);
            logDebug(`Conflict resolved as rename: ${destPath} -> ${finalDestPath}`);

            // Record the conflict resolution
            const conflictResult: ConflictResolutionResult = {
              context: {
                sourcePath: filePath,
                destPath,
                conflictType: { type: "exists", destPath, destSize: 0 },
              },
              resolution: "rename",
              newPath: finalDestPath,
              success: true,
            };
            conflictContext.resolutions.push(conflictResult);
            if (result.conflictResolutions) {
              result.conflictResolutions.push(conflictResult);
            } else {
              result.conflictResolutions = [conflictResult];
            }
            // Fall through to copy with new path
          }
        }

        if (dryRun) {
          const action =
            convertFormat && firstCopyPath === null
              ? `convert (${convertFormat}) track`
              : "copy track";
          logInfo(formatDryRun(`${action}: ${filePath} -> ${finalDestPath}`));
          result.created++;
          // Report progress for each dry-run copy
          progressBar?.updateFile(fileSize);
        } else {
          await ensureDir(destDir);

          // Run beforeCopy hooks
          const hookManager = getPluginManager();
          if (hookManager.isInitialized()) {
            const beforeContext: BeforeCopyContext = {
              sourcePath: filePath,
              destPath: finalDestPath,
              isAudioFile: true,
              convertFormat,
            };
            await runBeforeCopyHooks([...hookManager.getPlugins()], beforeContext, { signal });
          }

          // Copy optimization: first copy converts from source, subsequent copies from first copy
          const copySource = firstCopyPath ?? filePath;
          // Only convert on first copy; subsequent copies just copy the already converted file
          const method =
            firstCopyPath === null
              ? await copyOrConvertFile(
                  copySource,
                  finalDestPath,
                  hardlink,
                  convertFormat,
                  recorder,
                )
              : await copyOrLink(copySource, finalDestPath, hardlink);

          // Record history for subsequent copies (first copy recorded by copyOrConvertFile)
          if (recorder && firstCopyPath !== null) {
            if (method === "hardlink") {
              await recorder.recordHardlink(copySource, finalDestPath);
            } else {
              await recorder.recordCopy(copySource, finalDestPath);
            }
          }

          // Verify file integrity if requested (skip for converted)
          if (verify && method !== "converted") {
            try {
              const valid = await verifyFileIntegrity(copySource, finalDestPath);
              if (!valid) {
                await remove(finalDestPath);
                throw new Error(`Integrity check failed for ${filename}`);
              }
            } catch (error) {
              logError(`Verification failed for ${filename}: ${(error as Error).message}`);
              throw error;
            }
          }

          if (firstCopyPath === null) {
            firstCopyPath = finalDestPath;
          }

          const methodDesc =
            method === "converted" ? "Converted" : method === "hardlink" ? "Linked" : "Copied";
          logDebug(`${methodDesc}: ${copySource} -> ${finalDestPath}`);
          await recordCopiedFileInventory(
            ctx.isLibraryRoot ? path.join(source, extractedArtist) : source,
            filePath,
            finalDestPath,
            inventoryRating,
            trackingContext,
          );
          result.created++;

          // Run afterCopy hooks
          if (hookManager.isInitialized()) {
            const afterContext: AfterCopyContext = {
              sourcePath: filePath,
              destPath: finalDestPath,
              method:
                method === "converted" ? "converted" : method === "hardlink" ? "hardlink" : "copy",
              fileSize,
              signal,
            };
            await runAfterCopyHooks(
              [...hookManager.getPlugins()],
              afterContext,
              {
                source: filePath,
                created: 1,
                skipped: 0,
                filtered: 0,
                failed: [],
              },
              { signal },
            );
          }

          // Report progress for each actual copy
          progressBar?.updateFile(fileSize);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to process ${filePath}: ${message}`);

      const failedOp: FailedOperation = {
        path: filePath,
        message,
      };

      // Extract error code if available
      if (error instanceof Error && "code" in error) {
        failedOp.code = (error as NodeJS.ErrnoException).code;
      }

      result.failed.push(failedOp);
    }
  };

  // Determine if we should use progress bar
  const useProgressBar = !dryRun && isProgressEnabled(options);

  // Build tracking context for inventory hashing and granular album copy tracking.
  let trackingContext: AlbumTrackingContext | undefined;
  if (trackingConfig?.db && trackingConfig.operationId !== undefined && !dryRun) {
    // Extract rating key from options for rating-aware tracking
    const optionsHash = buildOptionsHash(options);
    const ratingKey = optionsHash.ratingKey ?? null;

    // Load completed album copies for this source (single artist mode)
    const completedAlbumCopies = loadCompletedAlbumCopiesForSource(
      trackingConfig.db,
      trackingConfig.operationId,
      source,
      ratingKey,
    );

    // Also load library root data (handles both legacy and new format for multi-artist mode)
    const libraryRootCompletedCopies = loadCompletedAlbumCopiesForLibraryRoot(
      trackingConfig.db,
      trackingConfig.operationId,
      source,
      ratingKey,
    );

    // Log if we found previously completed copies (count from both sources)
    let totalCompleted = 0;
    for (const suffixes of completedAlbumCopies.values()) {
      totalCompleted += suffixes.size;
    }
    for (const artistMap of libraryRootCompletedCopies.values()) {
      for (const suffixes of artistMap.values()) {
        totalCompleted += suffixes.size;
      }
    }
    if (totalCompleted > 0) {
      // Previously completed album copies (logging suppressed)
    }

    trackingContext = {
      config: trackingConfig,
      sourcePath: source,
      completedAlbumCopies,
      libraryRootCompletedCopies,
      ratingKey,
    };
  }

  // Run with progress tracking when not in JSON mode
  // (plan generation must reach the structured pre-scan preview branch below)
  if (!isJsonMode() && !useProgressBar && !options.capturePreview) {
    // Use listr2 spinners when progress bar is not explicitly enabled
    await runTasks<FilterContext>(
      [
        {
          title: `Scanning for audio files in ${path.basename(source)}`,
          task: async (taskCtx) => {
            taskCtx.audioFiles = await findAudioFiles(source);
            // Detect if source is a library root (Artist/Album/track structure)
            taskCtx.isLibraryRoot = detectLibraryRoot(source, taskCtx.audioFiles);

            // Apply interactive selection filter
            if (options.selection) {
              taskCtx.audioFiles = applyInteractiveSelectionFilter(
                taskCtx.audioFiles,
                source,
                options.selection,
                fallbackArtistName,
                taskCtx.isLibraryRoot,
              );
              logDebug(`Interactive filter: ${taskCtx.audioFiles.length} files after selection`);
            }
          },
        },
        {
          title: "Processing tracks",
          skip: (taskCtx) => {
            if (taskCtx.audioFiles.length === 0) {
              return "No audio files found";
            }
            return false;
          },
          task: async (taskCtx, task) => {
            // Check for album mode - use different processing logic
            if (filter.albumMode) {
              task.title = "Processing albums (grouping liked tracks)";
              await processAlbumMode(
                taskCtx.audioFiles,
                source,
                destination,
                fallbackArtistName,
                filter,
                {
                  dryRun,
                  hardlink,
                  force,
                  workers,
                  convertFormat,
                  requireDiskSpace: options.requireDiskSpace,
                  isLibraryRoot: taskCtx.isLibraryRoot,
                  verbose: options.verbose,
                  verify,
                  conflictStrategy,
                },
                result,
                undefined, // progressOptions - not needed in listr mode
                recorder,
                trackingContext,
                signal,
                inProgressFiles,
                conflictContext,
              );
              task.title = "Processing albums (complete)";
            } else {
              // Standard per-track processing with parallel execution
              const total = taskCtx.audioFiles.length;
              let completed = 0;

              logDebug(`Processing ${total} tracks with ${workers} workers`);

              await processInParallel(
                taskCtx.audioFiles,
                async (filePath) => {
                  await processFile(filePath);
                  completed++;
                  task.title = `Processing tracks (${completed}/${total})`;
                  return filePath;
                },
                {
                  workers,
                  signal,
                  onProgress: (done) => {
                    task.title = `Processing tracks (${done}/${total})`;
                  },
                },
              );

              task.title = `Processing tracks (${total}/${total})`;
            }
          },
        },
      ],
      { ctx },
    );
  } else {
    // Scanning for audio files (logging suppressed)
    ctx.audioFiles = await findAudioFiles(source);

    if (ctx.audioFiles.length === 0) {
      logWarn(`No audio files found in source directory: ${source}`);
      return result;
    }

    // Found audio files (logging suppressed)

    // Detect if source is a library root (Artist/Album/track structure)
    ctx.isLibraryRoot = detectLibraryRoot(source, ctx.audioFiles);

    // Apply interactive selection filter
    if (options.selection) {
      ctx.audioFiles = applyInteractiveSelectionFilter(
        ctx.audioFiles,
        source,
        options.selection,
        fallbackArtistName,
        ctx.isLibraryRoot,
      );
      logDebug(`Interactive filter: ${ctx.audioFiles.length} files after selection`);
    }

    // Check for album mode - use different processing logic
    if (filter.albumMode) {
      // Album mode: progress bar is created INSIDE processAlbumMode after rating scan
      // This ensures accurate progress based on liked files, not all files
      const progressOpts: DeferredProgressOptions | undefined = useProgressBar
        ? { operationName: fallbackArtistName, progressPreference: options.progress }
        : undefined;

      await processAlbumMode(
        ctx.audioFiles,
        source,
        destination,
        fallbackArtistName,
        filter,
        {
          dryRun,
          hardlink,
          force,
          workers,
          convertFormat,
          requireDiskSpace: options.requireDiskSpace,
          isLibraryRoot: ctx.isLibraryRoot,
          verbose: options.verbose,
          verify,
          conflictStrategy,
        },
        result,
        progressOpts,
        recorder,
        trackingContext,
        signal,
        inProgressFiles,
        conflictContext,
      );
    } else {
      // Standard filter mode: pre-scan ratings to determine actual files to copy
      // This allows accurate progress bar based on liked files × range copies
      logDebug("Pre-scanning ratings for progress tracking...");
      const { likedFiles, likedFileRatings, filteredFiles } = await preScanRatings(
        ctx.audioFiles,
        filter,
        signal,
      );
      logDebug(`Pre-scan complete: ${likedFiles.length} liked, ${filteredFiles.length} filtered`);

      // DRY-RUN MODE: Use preview system for detailed output
      if (dryRun) {
        // Get file sizes for preview
        const likedFilesWithBytes: Array<{ path: string; bytes: number }> = [];
        for (const filePath of likedFiles) {
          const bytes = await getFileSize(filePath);
          likedFilesWithBytes.push({ path: filePath, bytes });
        }

        // Collect and display preview
        const filterPreview = await collectFilterPreview(
          likedFilesWithBytes,
          filteredFiles.length,
          source,
          destination,
          filter.outputFolder,
          { force, convertFormat },
        );
        options.capturePreview?.({ mode: "filter", source, preview: filterPreview });

        if (!isJsonMode()) {
          // Display preview
          console.error("");
          console.error(colors.bold("=== DRY-RUN PREVIEW ==="));
          console.error("");
          formatFilterPreviewOutput(filterPreview, options.verbose ?? false);
          console.error("");

          // Format totals
          console.error(colors.bold("--- Summary ---"));
          if (filterPreview.summary.willCopy > 0) {
            console.error(
              colors.green(
                `  Copy: ${filterPreview.summary.willCopy} tracks (${formatBytes(filterPreview.summary.totalBytes)})`,
              ),
            );
          }
          if (filterPreview.summary.willSkip > 0) {
            console.error(
              colors.gray(`  Skip: ${filterPreview.summary.willSkip} tracks (already exist)`),
            );
          }
          if (filterPreview.filteredCount > 0) {
            console.error(
              colors.gray(`  Filtered: ${filterPreview.filteredCount} tracks (below threshold)`),
            );
          }
          console.error("");
        }

        // Return preview results
        return {
          source,
          created: filterPreview.summary.willCopy,
          skipped: filterPreview.summary.willSkip,
          filtered: filterPreview.filteredCount,
          failed: [],
        };
      }

      // Calculate range multiplier
      const rangeCount = filter.range ? filter.range.end - filter.range.start + 1 : 1;

      // Check if we need disk space check or progress bar
      const needsDiskSpaceCheck = !hardlink && options.requireDiskSpace !== false;

      if ((useProgressBar || needsDiskSpaceCheck) && likedFiles.length > 0) {
        // Get stats for liked files only
        const stats = await getFilesStats(likedFiles);
        const totalFiles = likedFiles.length * rangeCount;
        const totalBytes = stats.totalBytes * rangeCount;

        logDebug(
          `Liked files: ${likedFiles.length} files, ${stats.totalBytes} bytes (x${rangeCount} copies = ${totalFiles} files, ${totalBytes} bytes)`,
        );

        // Disk space check (skip for hardlinks - no additional space needed)
        if (needsDiskSpaceCheck) {
          const { validateDiskSpace, estimateConvertedSize } = await import("../lib/disk.js");

          const estimatedBytes = estimateConvertedSize(totalBytes, convertFormat);
          const margin = getLoadedConfig().copy?.diskSpaceMargin;
          // When isLibraryRoot, destination contains multiple artists, so use destination directly
          const destDir = ctx.isLibraryRoot
            ? destination
            : path.join(destination, fallbackArtistName, filter.outputFolder);

          await validateDiskSpace(destDir, estimatedBytes, {
            margin: margin !== undefined ? margin / 100 : undefined,
            requireSpace: options.requireDiskSpace,
          });
        }

        // Create progress bar if enabled
        if (useProgressBar) {
          progressBar = new CopyProgressBar({
            totalFiles,
            totalBytes,
            operationName: fallbackArtistName,
            progress: options.progress,
          });

          progressBar.start();
        }
      }

      // Record filtered count upfront (we know these from pre-scan)
      result.filtered = filteredFiles.length;

      try {
        // Process only liked files (filtered already counted)
        if (likedFiles.length > 0) {
          logDebug(`Processing ${likedFiles.length} liked tracks with ${workers} workers`);
          await processTracksInParallel(
            likedFiles,
            // Wrap processFile to skip re-reading ratings (we know they're liked)
            async (filePath: string) => {
              await processLikedFile(filePath, likedFileRatings.get(filePath) ?? null);
            },
            workers,
            signal,
          );
        }
      } finally {
        // Stop progress bar
        if (progressBar) {
          progressBar.stop();
        }
      }
    }
  }

  // Log summary - handle minStars, minRating, or filterName (smart filters)
  let thresholdDesc: string;
  if (filter.minStars !== undefined) {
    thresholdDesc = `${filter.minStars}+ stars`;
  } else if (filter.minRating !== undefined) {
    thresholdDesc = `${filter.minRating}%+ rating`;
  } else if (filter.filterName !== undefined) {
    thresholdDesc = `"${filter.filterName}" filter`;
  } else if (filter.smartFilter !== undefined) {
    thresholdDesc = "smart filter";
  } else {
    thresholdDesc = "filter criteria";
  }

  const modeDesc = filter.albumMode ? " (album mode)" : "";
  const convertDesc = convertFormat ? ` [converted to ${convertFormat}]` : "";

  if (dryRun) {
    logDebug(
      `[DRY-RUN] Would copy ${result.created} track(s) meeting ${thresholdDesc} threshold${modeDesc}${convertDesc}`,
    );
  } else {
    // Build inline success message for after progress bar
    const plexNote = getLoadedConfig().plex?.scanAfterCopy ? ", Plex scan triggered" : "";
    outputInlineSuccess(`${result.created} tracks copied${plexNote}`);

    if (result.failed.length > 0) {
      logWarn(`Failed to process ${result.failed.length} file(s)`);
    }
  }

  return result;
}

/**
 * Filters sources considering granular album-suffix tracking.
 * For filter mode with ranges, checks if all suffixes are completed.
 *
 * @param sourceEntries - Source paths with per-path ranges
 * @param trackingState - Source-level tracking state
 * @param trackingConfig - Tracking configuration
 * @param options - Copy options
 * @returns Filtered pending sources and skip count
 */
async function filterSourcesWithRangeAwareness(
  sourceEntries: PathEntry[],
  trackingState: TrackingState,
  trackingConfig: TrackingConfig,
  options: CopyOptions,
): Promise<{ pending: PathEntry[]; skipped: number }> {
  const pending: PathEntry[] = [];
  let skipped = 0;

  // Check if we should use granular range-aware filtering
  const useGranularCheck =
    trackingConfig.db &&
    trackingConfig.operationId !== undefined &&
    options.mode.type === "filter" &&
    (options.cliRange !== undefined || // CLI --range
      sourceEntries.some((e) => e.range !== undefined) || // Per-path ranges
      options.configRange !== undefined); // Config default range

  if (!useGranularCheck) {
    // Fall back to standard source-level filtering
    const paths = sourceEntries.map((e) => e.path);
    const result = filterPendingSources(paths, trackingState);
    return {
      pending: sourceEntries.filter((e) => result.pending.includes(e.path)),
      skipped: result.skipped,
    };
  }

  // Granular range-aware filtering
  const ratingKey = buildOptionsHash(options).ratingKey;

  for (const entry of sourceEntries) {
    const sourcePath = entry.path;
    const effectiveRange = options.cliRange ?? entry.range ?? options.configRange;

    if (!effectiveRange) {
      // No range specified - treat as single copy, use standard check
      if (isSourceCompleted(trackingState, sourcePath)) {
        logDebug(`Skipping completed source: ${sourcePath}`);
        skipped++;
      } else {
        pending.push(entry);
      }
      continue;
    }

    // Check if source has pending work for this range
    const hasPendingWork = await hasSourcePendingWorkForRange(
      trackingConfig.db!,
      trackingConfig.operationId!,
      sourcePath,
      effectiveRange,
      ratingKey,
    );

    if (hasPendingWork || options.force) {
      pending.push(entry);
    } else {
      logDebug(
        `Skipping fully completed source: ${sourcePath} (range ${effectiveRange.start}-${effectiveRange.end})`,
      );
      skipped++;
    }
  }

  return { pending, skipped };
}

/**
 * Creates a modified copy of options with a different range for filter mode.
 *
 * Used when processing file-based input with per-path ranges.
 * In filter mode, the range is stored in RatingFilter.range.
 *
 * @param options - Original copy options
 * @param range - The range to use for this path (or undefined for no range)
 * @returns New CopyOptions with the specified range in filter mode
 */
function withFilterRange(options: CopyOptions, range: CopyRange | undefined): CopyOptions {
  if (options.mode.type !== "filter") {
    return options;
  }

  return {
    ...options,
    mode: {
      type: "filter",
      rating: {
        ...options.mode.rating,
        range,
      },
    },
  };
}

/**
 * Executes filter copy with support for file-based input.
 *
 * If `options.file` is provided, reads source paths from the file and processes
 * each one. Otherwise, uses the provided source argument directly.
 *
 * When processing multiple sources from a file, errors on individual sources
 * are logged but do not stop processing of remaining sources. The final result
 * aggregates all operations.
 *
 * Supports per-path ranges in the input file with the format:
 * - "path,START-END" (e.g., "/music/Artist/Album,001-005")
 *
 * Range precedence (for creating numbered copies of filtered tracks):
 * 1. CLI --range (applies to ALL paths, overrides per-path and config)
 * 2. Per-path range from file
 * 3. Config file default range
 * 4. No range (single copy of filtered tracks)
 *
 * Supports tracking completed sources for idempotent operations when:
 * - --file option is used (tracking requires an input file)
 * - --track-completed is specified (or not explicitly disabled)
 *
 * @param source - Source path (used when options.file is not provided)
 * @param destination - Destination directory where output folders will be created
 * @param options - Copy options including optional file path
 * @returns Aggregated result across all sources
 * @throws Error if file cannot be read or no sources are provided
 */
export async function executeFilterCopyWithFileInput(
  source: string | undefined,
  destination: string,
  options: CopyOptions,
): Promise<CopyResult> {
  // Determine source entries (paths with optional ranges)
  let sourceEntries: PathEntry[];

  if (options.cliSourceEntries && options.cliSourceEntries.length > 0) {
    // Use source entries from CLI arguments
    sourceEntries = options.cliSourceEntries;

    if (!options.dryRun) {
      // Processing source paths (logging suppressed)
    }
  } else if (options.file) {
    // Read sources from file (logging suppressed)
    sourceEntries = await readSourcePaths(options.file);

    if (sourceEntries.length === 0) {
      throw new Error(`No source paths found in file: ${options.file}`);
    }
  } else if (source) {
    // Use single source argument (no per-path range)
    sourceEntries = [{ path: source }];
  } else {
    throw new Error("Either source argument, --file option, or multiple source paths are required");
  }

  // Extract paths for tracking (tracking uses path strings, not entries)
  let sourcePaths = sourceEntries.map((entry) => entry.path);

  // Initialize database for tracking and/or undo (if not using legacy mode)
  const config = getLoadedConfig();
  const trackingUseLegacy = options.useLegacyTracking ?? config?.tracking?.useLegacy ?? false;
  const undoUseLegacy = shouldUseUndoLegacyMode(config);
  let db: DbConnection | undefined;

  // Initialize database if either tracking or undo need it
  const needsDb = (!trackingUseLegacy || !undoUseLegacy) && !options.dryRun;
  if (needsDb) {
    // Use CLI override if provided, otherwise resolve from config
    const dbPath = options.trackingDatabase ?? resolveUndoDatabasePath(config);
    db = await initializeDatabase(dbPath);
  }

  // Setup graceful interruption
  const { getGlobalSignal, registerGlobalCleanup, unregisterGlobalCleanup } =
    await import("../lib/signal-handler.js");
  const localAbortController = new AbortController();
  const globalSignal = getGlobalSignal();
  const inProgressFiles = new Set<string>();

  // Link local controller to global signal
  if (globalSignal) {
    globalSignal.addEventListener("abort", () => {
      localAbortController.abort();
    });
  }

  // Register cleanup handlers
  registerGlobalCleanup({
    priority: 10,
    name: "copy-filter-abort",
    cleanup: () => {
      if (!localAbortController.signal.aborted) {
        localAbortController.abort();
      }
    },
  });

  registerGlobalCleanup({
    priority: 15,
    name: "copy-filter-partial-files",
    cleanup: async () => {
      const { cleanupPartialFile } = await import("../lib/filesystem.js");
      for (const filePath of inProgressFiles) {
        await cleanupPartialFile(filePath);
      }
    },
  });

  // Setup tracking if enabled (enabled by default unless explicitly disabled)
  const trackingEnabled = options.trackCompleted !== false;
  let trackingConfig: TrackingConfig | undefined;
  let trackingState: TrackingState | undefined;
  let trackingStats: TrackingStats | undefined;

  if (trackingEnabled) {
    // Use input file/paths if provided, otherwise use destination path as tracking identifier
    // Priority: --file > --paths > destination
    const trackingIdentifier = options.file ?? options.paths ?? destination;

    trackingConfig = createTrackingConfig(trackingIdentifier, options, {
      enabled: true,
      customPath: options.completedFile,
      reset: options.resetCompleted,
    });

    // Attach database to tracking config
    if (db) {
      trackingConfig.db = db;
    }

    // Don't modify tracking files in dry-run mode
    if (!options.dryRun) {
      await initializeTracking(trackingConfig, trackingIdentifier, options);
    }

    trackingState = await loadTrackingState(trackingConfig);
    trackingStats = createTrackingStats(sourcePaths.length, trackingConfig.completedFilePath);

    // Filter sources with range-aware granular tracking
    const { pending, skipped } = await filterSourcesWithRangeAwareness(
      sourceEntries, // Use sourceEntries instead of sourcePaths to preserve ranges
      trackingState,
      trackingConfig,
      options,
    );
    trackingStats.skippedCompleted = skipped;

    // Skipped completed sources (logging suppressed)

    // Update sourceEntries and sourcePaths to only pending
    sourceEntries = pending;
    sourcePaths = pending.map((e) => e.path);

    if (sourcePaths.length === 0) {
      outputSuccess("All sources already completed!");
      return {
        source: trackingIdentifier,
        created: 0,
        skipped: 0,
        filtered: 0,
        failed: [],
      };
    }

    // Processing pending sources (logging suppressed)
  }

  // Create history recorder if enabled and not dry-run
  let recorder: HistoryRecorder | undefined;
  if (!options.dryRun && isHistoryEnabled()) {
    // Pass database if undo is not using legacy mode
    const undoDb = undoUseLegacy ? undefined : db;
    recorder = await createHistorySession("copy", undoDb);
    logDebug(`History session started: ${recorder.getId()}`);
    options.onHistorySession?.(recorder.getId());

    // Register cleanup handler for recorder
    registerGlobalCleanup({
      priority: 50,
      name: "copy-filter-history",
      cleanup: async () => {
        if (recorder) {
          await recorder.close();
        }
      },
    });
  }

  // Register cleanup handler for database
  if (db) {
    registerGlobalCleanup({
      priority: 70,
      name: "copy-filter-database",
      cleanup: () => {
        if (db) {
          closeDatabase(db);
        }
      },
    });
  }

  // Resolve media server adapter early for optional per-source scanning.
  const { adapter: mediaServerAdapter, scanPerSource } = resolveOptionalScanAdapter({
    plexUrl: options.plexUrl,
    plexToken: options.plexToken,
    plexLibrary: options.plexLibrary,
    plexScan: options.plexScan,
    plexPerSource: options.plexPerSource,
  });

  // Process each source entry
  const aggregatedResult: CopyResult = {
    source: options.file ?? source ?? "",
    created: 0,
    skipped: 0,
    filtered: 0,
    failed: [],
  };

  const failedSources: string[] = [];

  try {
    for (const entry of sourceEntries) {
      const sourcePath = entry.path;

      // Determine effective range for this path:
      // CLI range > auto-range from count > per-path range > config range > no range
      // Note: In filter mode, range is optional (for creating numbered copies)
      let effectiveRange: CopyRange | undefined;

      if (options.cliRange) {
        // CLI --range overrides everything
        effectiveRange = options.cliRange;
        logDebug(`Using CLI range for ${sourcePath}`);
      } else if (options.count !== undefined) {
        // Auto-detect range for this source (CLI --count)
        // For filter mode, get filter from options
        const ratingFilter = options.mode.type === "filter" ? options.mode.rating : undefined;
        if (!ratingFilter) {
          throw new Error("Invalid mode: expected filter mode");
        }

        let destDir: string;

        if (ratingFilter.albumMode) {
          // Album mode: artist name like in copy-album.ts
          const artistName = options.albumOnly
            ? path.basename(path.dirname(sourcePath))
            : path.basename(sourcePath);
          destDir = path.join(destination, artistName);
        } else {
          // Flat mode: output folder directly in destination
          destDir = destination;
        }

        const detection = await detectHighestSuffix(destDir);
        const highestSuffix = detection?.highestSuffix ?? 0;
        const padWidth = detection?.padWidth ?? 3;

        effectiveRange = buildAutoRange(options.count, highestSuffix, padWidth);
        // Auto-detected range (logging suppressed)
      } else if (entry.count !== undefined) {
        // Per-path count from file (auto-detect)
        // For filter mode, get filter from options
        const ratingFilter = options.mode.type === "filter" ? options.mode.rating : undefined;
        if (!ratingFilter) {
          throw new Error("Invalid mode: expected filter mode");
        }

        let destDir: string;

        if (ratingFilter.albumMode) {
          // Album mode: artist folder in destination
          const artistName = options.albumOnly
            ? path.basename(path.dirname(sourcePath))
            : path.basename(sourcePath);
          destDir = path.join(destination, artistName);
        } else {
          // Flat mode: output folder directly in destination
          destDir = destination;
        }

        const detection = await detectHighestSuffix(destDir);
        const highestSuffix = detection?.highestSuffix ?? 0;
        const padWidth = detection?.padWidth ?? 3;

        effectiveRange = buildAutoRange(entry.count, highestSuffix, padWidth);
        // Auto-detected range from file (logging suppressed)
      } else if (entry.range) {
        // Per-path range from file
        effectiveRange = entry.range;
        logDebug(
          `Using per-path range for ${sourcePath}: ${effectiveRange.start}-${effectiveRange.end}`,
        );
      } else if (options.configRange) {
        // Config default range
        effectiveRange = options.configRange;
        logDebug(`Using config default range for ${sourcePath}`);
      } else {
        // No range - single copy
        logDebug(`No range for ${sourcePath} (single copy)`);
      }

      // Build per-source options (filter, outputFolder, convertFormat)
      const perSourceOptions = buildPerSourceOptions(options, entry);

      // Create options with the effective range for this path
      const pathOptions = withFilterRange(perSourceOptions, effectiveRange);

      try {
        // Pass tracking config for granular album copy tracking
        const result = await executeFilterCopy(
          sourcePath,
          destination,
          pathOptions,
          recorder,
          trackingConfig,
          localAbortController.signal,
          inProgressFiles,
        );
        aggregatedResult.created += result.created;
        aggregatedResult.skipped += result.skipped;
        aggregatedResult.filtered += result.filtered;
        aggregatedResult.failed.push(...result.failed);

        // Record successful completion (only if no file-level failures)
        if (trackingConfig && !options.dryRun && result.failed.length === 0) {
          // Check if we're using granular (album-suffix) tracking
          // Granular tracking is enabled when: DB exists + operation ID + range is present
          const usingGranularTracking =
            trackingConfig.db &&
            trackingConfig.operationId !== undefined &&
            effectiveRange !== undefined;

          if (!usingGranularTracking) {
            // Standard source-level tracking
            await recordCompleted(trackingConfig, sourcePath);
            if (trackingStats) trackingStats.processed++;
          } else {
            // Granular tracking mode - only mark source complete if all suffixes done
            // (The granular recordCompletedAlbumCopy calls handle per-suffix tracking)
            logDebug(
              `Skipping source-level completion for ${sourcePath} (using granular tracking)`,
            );
            if (trackingStats) trackingStats.processed++;
          }
        } else if (trackingConfig && !options.dryRun && result.failed.length > 0) {
          // Source had some failures - record as failed
          await recordFailed(trackingConfig, sourcePath, `${result.failed.length} file(s) failed`);
          if (trackingStats) trackingStats.failed++;
        }

        // Per-source Plex scan: trigger scan for this source's destination immediately
        // Use pathOptions to get per-source outputFolder if specified
        if (
          mediaServerAdapter?.capabilities.scan &&
          scanPerSource &&
          !options.dryRun &&
          result.created > 0
        ) {
          // Determine the destination path for this source (using per-source options)
          const ratingFilter =
            pathOptions.mode.type === "filter" ? pathOptions.mode.rating : undefined;
          let scanDestPath: string;

          if (ratingFilter?.albumMode) {
            // Album mode: artist folder in destination
            const artistName = pathOptions.albumOnly
              ? path.basename(path.dirname(sourcePath))
              : path.basename(sourcePath);
            scanDestPath = path.join(destination, artistName);
          } else {
            // Flat mode: output folder directly in destination
            const outputFolder = ratingFilter?.outputFolder ?? "liked-songs";
            const artistName = pathOptions.albumOnly
              ? path.basename(path.dirname(sourcePath))
              : path.basename(sourcePath);
            scanDestPath = path.join(destination, artistName, outputFolder);
          }

          const scanResult = await mediaServerAdapter.scan.triggerSource(scanDestPath);
          if (scanResult.success) {
            logDebug(`Plex scan triggered for: ${scanDestPath}`);
          } else {
            logWarn(`Plex scan failed for ${scanDestPath}: ${scanResult.message}`);
          }
        } else if (scanPerSource && options.dryRun && result.created > 0) {
          // Dry-run Plex scan (using per-source options)
          const ratingFilter =
            pathOptions.mode.type === "filter" ? pathOptions.mode.rating : undefined;
          let scanDestPath: string;

          if (ratingFilter?.albumMode) {
            const artistName = pathOptions.albumOnly
              ? path.basename(path.dirname(sourcePath))
              : path.basename(sourcePath);
            scanDestPath = path.join(destination, artistName);
          } else {
            const outputFolder = ratingFilter?.outputFolder ?? "liked-songs";
            const artistName = pathOptions.albumOnly
              ? path.basename(path.dirname(sourcePath))
              : path.basename(sourcePath);
            scanDestPath = path.join(destination, artistName, outputFolder);
          }
          // Plex scan message suppressed in dry-run mode for cleaner output
        }
      } catch (err) {
        const error = err as Error;
        failedSources.push(sourcePath);
        logError(`Failed to process source: ${sourcePath}`);
        logError(`  ${error.message}`);
        aggregatedResult.failed.push({
          path: sourcePath,
          message: error.message,
        });

        // Record failed source
        if (trackingConfig && !options.dryRun) {
          await recordFailed(trackingConfig, sourcePath, error.message);
          if (trackingStats) trackingStats.failed++;
        }
      }

      // Spacing between sources handled by progress bar output
    }
  } finally {
    // Unregister cleanup handlers
    unregisterGlobalCleanup("copy-filter-abort");
    unregisterGlobalCleanup("copy-filter-partial-files");
    unregisterGlobalCleanup("copy-filter-history");
    unregisterGlobalCleanup("copy-filter-database");

    // Close history recorder FIRST (it may need the database connection)
    if (recorder) {
      await recorder.close();
      logDebug(
        `History session closed: ${recorder.getId()} (${recorder.getOperationCount()} operations)`,
      );
    }

    // Update operation status before closing database
    if (db && trackingConfig?.operationId !== undefined) {
      // Determine final status based on results
      const processedCount = trackingStats?.processed ?? 0;
      const failedCount = trackingStats?.failed ?? failedSources.length;
      const totalCount = trackingStats?.totalSources ?? sourceEntries.length;

      const status: "completed" | "failed" | "partial" =
        failedCount > 0 ? (processedCount > 0 ? "partial" : "failed") : "completed";

      updateOperationCounts(db, trackingConfig.operationId, {
        totalSources: totalCount,
        completedCount: processedCount,
        failedCount: failedCount,
      });
      updateOperationStatus(db, trackingConfig.operationId, status);
      logDebug(`Updated operation #${trackingConfig.operationId} status to: ${status}`);
    }

    // Close database connection AFTER recorder is closed
    if (db) {
      closeDatabase(db);
    }
  }

  // Finalize tracking stats
  if (trackingStats) {
    trackingStats.endTime = Date.now();
  }

  // Log overall summary for multi-source operations (skip in dry-run mode)
  if ((sourceEntries.length > 1 || trackingStats) && !options.dryRun) {
    console.error("");
    console.error("Copy Summary");
    console.error("");

    if (trackingStats) {
      // Enhanced summary with tracking info
      const timing = calculateTimingStats(trackingStats);

      // Build tracking info string
      let trackingInfo: string | undefined;
      if (trackingConfig) {
        if (trackingConfig.db && trackingConfig.operationId !== undefined) {
          trackingInfo = `Database (operation #${trackingConfig.operationId})`;
        } else if (trackingStats.trackingFile) {
          trackingInfo = path.basename(trackingStats.trackingFile);
        }
      }

      const summaryOutput = formatCopySummaryTable({
        totalSources: trackingStats.totalSources,
        processed: trackingStats.processed,
        skippedCompleted: trackingStats.skippedCompleted,
        failed: trackingStats.failed,
        filesCreated: aggregatedResult.created,
        filesSkipped: aggregatedResult.skipped,
        filesFiltered: aggregatedResult.filtered,
        filesFailed: aggregatedResult.failed.length,
        elapsed: timing.elapsedFormatted,
        sourcesPerMin: timing.sourcesPerMinute,
        trackingInfo,
      });

      console.error(summaryOutput);
    } else {
      // Original summary format (no tracking stats)
      console.error(`Sources processed: ${sourceEntries.length}`);
      if (failedSources.length > 0) {
        logWarn(`Sources failed: ${failedSources.length}`);
        for (const failed of failedSources) {
          logWarn(`  - ${failed}`);
        }
      }
      console.error(`Total created: ${aggregatedResult.created}`);
      console.error(`Total skipped: ${aggregatedResult.skipped}`);
      console.error(`Total filtered: ${aggregatedResult.filtered}`);
      if (aggregatedResult.failed.length > 0) {
        logWarn(`Total failed operations: ${aggregatedResult.failed.length}`);
      }
    }

    console.error("");
  }

  // Trigger end-of-batch scan if configured and not using per-source scanning.
  // Skip if scanPerSource is enabled (scans were already triggered per-source).
  if (mediaServerAdapter?.capabilities.scan && !scanPerSource && !options.dryRun) {
    const scanResult = await mediaServerAdapter.scan.trigger();
    if (!scanResult.success) {
      logWarn(`Plex scan failed: ${scanResult.message}`);
    }
  }

  // Run afterBatch hooks
  const manager = getPluginManager();
  if (manager.isInitialized()) {
    const batchContext: AfterBatchContext = {
      results: [aggregatedResult],
      sources: sourceEntries.map((e) => e.path),
      historyId: recorder?.getId?.(),
      signal: localAbortController.signal,
    };
    const hookResults = await runAfterBatchHooks([...manager.getPlugins()], batchContext, {
      signal: localAbortController.signal,
    });

    // Log hook errors but don't fail the operation
    const errors = hookResults.filter((r) => !r.success);
    if (errors.length > 0) {
      logWarn(`${errors.length} plugin(s) failed during afterBatch hook`);
      for (const error of errors) {
        logDebug(`  ${error.pluginName}: ${error.error?.message}`);
      }
    }
  }

  return aggregatedResult;
}
