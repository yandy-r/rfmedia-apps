/**
 * Filter mode delete logic for rfmedia CLI.
 *
 * Implements deletion of filter-mode copied content (e.g., liked-songs folders).
 * Handles both album-mode filtered copies (Artist/Album-001, Album-002) and
 * flat-mode filtered copies (Artist/liked-songs/track.mp3).
 *
 * Supports:
 * - Reverse order processing for ranges (highest suffixes first)
 * - Database tracking removal (unless --keep-tracking)
 * - Trash mode (move to trash instead of permanent delete)
 * - History recording for undo support
 * - Dry-run preview
 */

import path from "node:path";
import { readdir } from "node:fs/promises";

import { moveToTrash, pathExists, remove } from "../lib/filesystem.js";
import { createHistorySession, isHistoryEnabled, type HistoryRecorder } from "../lib/history.js";
import { readSourcePaths } from "../lib/input-file.js";
import {
  formatDryRun,
  isJsonMode,
  logDebug,
  logError,
  logInfo,
  logSuccess,
  logWarn,
} from "../lib/logger.js";
import { formatDeleteSummaryTable } from "../lib/table-format.js";
import { formatSuffix, formatRange } from "../lib/range.js";
import { withSpinner } from "../lib/progress.js";
import { confirm } from "../lib/prompt.js";
import {
  initializeDatabase,
  closeDatabase,
  deleteCompletedAlbumCopyByPath,
  createOperation,
  updateOperationStatus,
  updateOperationCounts,
} from "../lib/db.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { shouldUseUndoLegacyMode, resolveUndoDatabasePath } from "../lib/config.js";
import { resolveOptionalScanAdapter } from "../lib/adapters/action-helpers.js";
import type { DbConnection } from "../types/db.js";
import type {
  DeleteOptions,
  DeleteResult,
  FailedOperation,
  RatingFilter,
  CopyRange,
  PathEntry,
  SmartFilter,
} from "../types/index.js";

/**
 * Builds per-source options by applying YAML per-source overrides.
 *
 * Per-source values (from YAML --paths) take precedence over CLI options.
 * Handles: filterName, outputFolder, convertFormat, count, range
 *
 * @param baseOptions - Base options from CLI/config
 * @param entry - Source entry with optional per-source overrides
 * @returns Modified options with per-source values applied
 */
function buildPerSourceOptions(baseOptions: DeleteOptions, entry: PathEntry): DeleteOptions {
  // If no per-source overrides, return base options as-is
  if (
    !entry.filterName &&
    !entry.outputFolder &&
    !entry.convertFormat &&
    entry.count === undefined &&
    !entry.range
  ) {
    return baseOptions;
  }

  // Start with a shallow copy of base options
  let options = { ...baseOptions };

  // Apply per-source count (takes priority over CLI count)
  if (entry.count !== undefined && baseOptions.count === undefined) {
    options = { ...options, count: entry.count };
    logDebug(`Per-source count: ${entry.count}`);
  }

  // Apply per-source range (takes priority over CLI range if no count)
  if (
    entry.range &&
    baseOptions.cliRange === undefined &&
    entry.count === undefined &&
    baseOptions.count === undefined
  ) {
    options = { ...options, cliRange: entry.range };
    logDebug(`Per-source range: ${entry.range.start}-${entry.range.end}`);
  }

  // Apply per-source convertFormat (for filename matching)
  if (entry.convertFormat) {
    options = { ...options, convertFormat: entry.convertFormat };
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
      const smartFilter = availableFilters[entry.filterName] as SmartFilter | undefined;

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
      modifiedRating = { ...modifiedRating, outputFolder: entry.outputFolder };
      logDebug(`Per-source outputFolder: ${entry.outputFolder}`);
    }

    // Create new mode with modified rating
    if (modifiedRating !== baseRating) {
      options = { ...options, mode: { type: "filter", rating: modifiedRating } };
    }
  }

  return options;
}

/**
 * Suffix folder information.
 */
interface SuffixFolder {
  /** Suffix number (e.g., 5 for folder-005) */
  suffixNum: number;
  /** Formatted suffix string (e.g., "005") */
  suffix: string;
  /** Full path to the folder */
  path: string;
  /** Base name without suffix */
  baseName: string;
}

/**
 * Discovers numbered output folders in a destination directory.
 *
 * For album mode filter: looks for Album-001, Album-002, etc.
 * For flat mode filter: looks for liked-songs-001, liked-songs-002, etc.
 *
 * @param destDir - Directory to scan
 * @param outputFolder - Base output folder name (e.g., "liked-songs")
 * @returns Array of suffix folders, sorted descending by suffix number
 */
async function discoverSuffixFolders(
  destDir: string,
  outputFolder?: string,
): Promise<SuffixFolder[]> {
  const scanOperation = async (): Promise<SuffixFolder[]> => {
    if (!(await pathExists(destDir))) {
      return [];
    }

    const entries = await readdir(destDir, { withFileTypes: true });

    // Pattern matches: anything ending with -XXX where XXX is 3+ digits
    const suffixPattern = /^(.+)-(\d{3,})$/;

    const suffixes: SuffixFolder[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const match = entry.name.match(suffixPattern);
      if (!match || !match[1] || !match[2]) {
        continue;
      }

      const baseName = match[1];
      const suffixStr = match[2];
      const suffixNum = parseInt(suffixStr, 10);

      // If outputFolder is specified, only match folders that start with it
      if (outputFolder && baseName !== outputFolder) {
        continue;
      }

      suffixes.push({
        suffixNum,
        suffix: suffixStr,
        path: path.join(destDir, entry.name),
        baseName,
      });
    }

    // Sort by suffix number in descending order (highest first for deletion)
    return suffixes.sort((a, b) => b.suffixNum - a.suffixNum);
  };

  if (isJsonMode()) {
    return scanOperation();
  }

  return withSpinner(`Scanning output folders in ${path.basename(destDir)}`, scanOperation);
}

/**
 * Discovers album folders with numbered suffixes (for album-mode filter).
 *
 * Scans for directories matching the pattern `AlbumName-XXX` where XXX is 3+ digits.
 *
 * @param artistDir - Path to the artist directory in destination
 * @returns Array of suffix folders grouped by album, sorted descending by suffix
 */
async function discoverAlbumSuffixFolders(artistDir: string): Promise<Map<string, SuffixFolder[]>> {
  const albumMap = new Map<string, SuffixFolder[]>();

  if (!(await pathExists(artistDir))) {
    return albumMap;
  }

  const entries = await readdir(artistDir, { withFileTypes: true });

  // Pattern matches: anything ending with -XXX where XXX is 3+ digits
  const suffixPattern = /^(.+)-(\d{3,})$/;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const match = entry.name.match(suffixPattern);
    if (!match || !match[1] || !match[2]) {
      continue;
    }

    const albumName = match[1];
    const suffixStr = match[2];
    const suffixNum = parseInt(suffixStr, 10);

    const folder: SuffixFolder = {
      suffixNum,
      suffix: suffixStr,
      path: path.join(artistDir, entry.name),
      baseName: albumName,
    };

    if (!albumMap.has(albumName)) {
      albumMap.set(albumName, []);
    }
    albumMap.get(albumName)!.push(folder);
  }

  // Sort each album's suffixes in descending order
  for (const folders of albumMap.values()) {
    folders.sort((a, b) => b.suffixNum - a.suffixNum);
  }

  return albumMap;
}

/**
 * Filters suffix folders based on delete options (count or range).
 *
 * For --count: Returns the N highest suffixes.
 * For --range: Returns suffixes within the specified range.
 * For --interactive: Returns only suffixes selected by user.
 *
 * @param allSuffixes - All discovered suffix folders (sorted descending)
 * @param source - Source path (for interactive selection lookup)
 * @param options - Delete options with count or range
 * @returns Filtered array of suffixes to delete
 */
function filterSuffixesToDelete(
  allSuffixes: SuffixFolder[],
  source: string,
  options: DeleteOptions,
): SuffixFolder[] {
  // Interactive selection takes precedence over count/range
  if (options.selection) {
    const sourceSelection = options.selection.sourceSelections.get(source);
    if (sourceSelection?.selectedSuffixes) {
      const selectedSet = new Set(sourceSelection.selectedSuffixes);
      return allSuffixes.filter((s) => selectedSet.has(s.path));
    }
  }

  if (options.count !== undefined) {
    // Delete the N highest suffixes
    return allSuffixes.slice(0, options.count);
  }

  const range = options.cliRange ?? options.configRange;
  if (range) {
    // Delete suffixes within the specified range
    return allSuffixes.filter((s) => s.suffixNum >= range.start && s.suffixNum <= range.end);
  }

  // No count or range specified - delete all
  return allSuffixes;
}

/**
 * Deletes a directory with history recording.
 *
 * @param dirPath - Path to the directory to delete
 * @param useTrash - Whether to move to trash instead of permanent delete
 * @param recorder - Optional history recorder for undo support
 * @param dryRun - Whether this is a dry-run preview
 * @returns Result with success status and optional error
 */
async function deleteDirectory(
  dirPath: string,
  useTrash: boolean,
  recorder?: HistoryRecorder,
  dryRun?: boolean,
): Promise<{ success: boolean; error?: Error }> {
  const dirName = path.basename(dirPath);
  const action = useTrash ? "trash" : "delete";

  if (dryRun) {
    logInfo(formatDryRun(`${action}: ${dirPath}`));
    return { success: true };
  }

  try {
    if (useTrash) {
      await moveToTrash(dirPath);
      if (recorder) {
        await recorder.recordTrash(dirPath);
      }
    } else {
      await remove(dirPath);
      if (recorder) {
        await recorder.recordRemove(dirPath);
      }
    }

    const actionPast = useTrash ? "Moved to trash" : "Deleted";
    logSuccess(`  ${actionPast}: ${dirName}`);
    return { success: true };
  } catch (err) {
    const error = err as Error;
    logWarn(`  Failed to ${action}: ${dirName}: ${error.message}`);
    return { success: false, error };
  }
}

/**
 * Executes filter mode delete operation for a single source.
 *
 * Handles two scenarios:
 * 1. Album-mode filter: Deletes Artist/Album-001, Album-002 folders
 * 2. Flat-mode filter: Deletes Artist/liked-songs or Artist/liked-songs-001 folders
 *
 * @param source - Source path (artist folder)
 * @param destination - Destination directory containing artist folders
 * @param options - Delete options
 * @param recorder - Optional history recorder for undo support
 * @param db - Optional database connection for tracking removal
 * @returns Result with deleted/skipped/failed counts
 */
export async function executeFilterDelete(
  source: string,
  destination: string,
  options: DeleteOptions,
  recorder?: HistoryRecorder,
  db?: DbConnection,
): Promise<DeleteResult> {
  if (options.mode.type !== "filter") {
    throw new Error("executeFilterDelete requires filter mode options");
  }

  const filter: RatingFilter = options.mode.rating;
  const { albumOnly, dryRun, useTrash, keepTracking } = options;

  const result: DeleteResult = {
    source,
    deleted: 0,
    skipped: 0,
    trackingRemoved: 0,
    failed: [],
  };

  // Determine artist name
  const artistName = albumOnly ? path.basename(path.dirname(source)) : path.basename(source);

  const artistDest = path.join(destination, artistName);

  // Verify destination exists
  if (!(await pathExists(artistDest))) {
    logWarn(`Artist destination does not exist: ${artistDest}`);
    return result;
  }

  // Processing artist (logging suppressed)

  if (filter.albumMode) {
    // Album-mode filter: look for Album-001, Album-002, etc.
    const albumSuffixMap = await discoverAlbumSuffixFolders(artistDest);

    if (albumSuffixMap.size === 0) {
      return result;
    }

    // Found numbered copies (logging suppressed)

    // Process each album's suffixes
    for (const [albumName, allSuffixes] of albumSuffixMap) {
      const suffixesToDelete = filterSuffixesToDelete(allSuffixes, source, options);

      if (suffixesToDelete.length === 0) {
        continue;
      }

      // Deleting copies (logging suppressed)

      for (const suffix of suffixesToDelete) {
        const deleteResult = await deleteDirectory(suffix.path, useTrash, recorder, dryRun);

        if (deleteResult.success) {
          result.deleted++;

          // Remove tracking entries (unless --keep-tracking)
          // This removes from ALL operations to ensure re-copy works
          if (!keepTracking && db && !dryRun) {
            // Album name is just the album folder name (source identifies artist)
            const trackingDeleted = deleteCompletedAlbumCopyByPath(
              db,
              source,
              albumName,
              suffix.suffix,
            );
            result.trackingRemoved += trackingDeleted;
          }
        } else {
          result.failed.push({
            path: suffix.path,
            message: deleteResult.error?.message ?? "Unknown error",
            code: (deleteResult.error as NodeJS.ErrnoException)?.code,
          });
        }
      }
    }
  } else {
    // Flat-mode filter: look for outputFolder or outputFolder-XXX
    const outputFolder = filter.outputFolder;
    const outputFolderPath = path.join(artistDest, outputFolder);

    // Check for base output folder (no suffix)
    if (await pathExists(outputFolderPath)) {
      // If we have a range/count, this shouldn't match - skip it
      const hasRange = options.cliRange !== undefined || options.configRange !== undefined;
      const hasCount = options.count !== undefined;

      if (!hasRange && !hasCount) {
        const deleteResult = await deleteDirectory(outputFolderPath, useTrash, recorder, dryRun);

        if (deleteResult.success) {
          result.deleted++;
        } else {
          result.failed.push({
            path: outputFolderPath,
            message: deleteResult.error?.message ?? "Unknown error",
            code: (deleteResult.error as NodeJS.ErrnoException)?.code,
          });
        }
      }
    }

    // Look for numbered output folders
    const suffixFolders = await discoverSuffixFolders(artistDest, outputFolder);

    if (suffixFolders.length > 0) {
      // Found numbered copies (logging suppressed)

      const suffixesToDelete = filterSuffixesToDelete(suffixFolders, source, options);

      for (const suffix of suffixesToDelete) {
        const deleteResult = await deleteDirectory(suffix.path, useTrash, recorder, dryRun);

        if (deleteResult.success) {
          result.deleted++;
        } else {
          result.failed.push({
            path: suffix.path,
            message: deleteResult.error?.message ?? "Unknown error",
            code: (deleteResult.error as NodeJS.ErrnoException)?.code,
          });
        }
      }
    }

    // Result summary (logging suppressed)
  }

  // Per-source summary suppressed - rely on multi-source summary table
  return result;
}

/**
 * Executes filter delete with support for file-based input.
 *
 * If `options.file` is provided, reads source paths from the file and processes
 * each one. Otherwise, uses the provided source argument directly.
 *
 * @param source - Source path (used when options.file is not provided)
 * @param destination - Destination directory where output folders exist
 * @param options - Delete options including optional file path
 * @returns Aggregated result across all sources
 */
export async function executeFilterDeleteWithFileInput(
  source: string | undefined,
  destination: string,
  options: DeleteOptions,
): Promise<DeleteResult> {
  // Determine source entries
  let sourceEntries: PathEntry[];

  if (options.cliSourceEntries && options.cliSourceEntries.length > 0) {
    sourceEntries = options.cliSourceEntries;
  } else if (options.file) {
    sourceEntries = await readSourcePaths(options.file);

    if (sourceEntries.length === 0) {
      throw new Error(`No source paths found in file: ${options.file}`);
    }
  } else if (source) {
    sourceEntries = [{ path: source }];
  } else {
    throw new Error("Either source argument or --file option is required");
  }

  // Initialize database if needed for tracking removal
  const config = getLoadedConfig();
  const undoUseLegacy = shouldUseUndoLegacyMode(config);
  let db: DbConnection | undefined;
  let operationId: number | undefined;

  // Database is needed if we want to remove tracking entries
  const needsDb = !options.useLegacyTracking && !options.dryRun && !options.keepTracking;
  if (needsDb) {
    const dbPath = options.trackingDatabase ?? resolveUndoDatabasePath(config);
    db = await initializeDatabase(dbPath);
    logDebug("Database initialized for tracking removal");

    // Create operation record for tracking
    const inputFile = options.file ?? "cli";
    const optionsHash = `delete-filter-${options.mode.type}-${options.cliRange ? `${options.cliRange.start}-${options.cliRange.end}` : "all"}`;

    operationId = createOperation(db, {
      command: "delete",
      mode: "filter",
      inputFile,
      optionsHash,
      ratingKey: null,
      rangeKey: options.cliRange ? `${options.cliRange.start}-${options.cliRange.end}` : null,
      convertKey: null,
      totalSources: sourceEntries.length,
    });
    logDebug(`Created operation record #${operationId}`);
  }

  // Create history recorder if enabled and not dry-run
  let recorder: HistoryRecorder | undefined;
  if (!options.dryRun && isHistoryEnabled()) {
    const undoDb = undoUseLegacy ? undefined : db;
    recorder = await createHistorySession("delete", undoDb);
    logDebug(`History session started: ${recorder.getId()}`);
  }

  // Aggregated result
  const aggregatedResult: DeleteResult = {
    source: options.file ?? source ?? "",
    deleted: 0,
    skipped: 0,
    trackingRemoved: 0,
    failed: [],
  };

  // Preview all deletions first (if not --force and not --dry-run)
  if (!options.force && !options.dryRun) {
    console.error("");
    console.error("Items will be deleted from the following artists:");
    console.error("");

    for (const entry of sourceEntries) {
      const artistName = options.albumOnly
        ? path.basename(path.dirname(entry.path))
        : path.basename(entry.path);
      console.error(`  - ${artistName}`);
    }

    console.error("");
    const confirmed = await confirm(`Proceed with deletion?`);
    if (!confirmed) {
      console.error("Deletion cancelled");
      return aggregatedResult;
    }
  }

  try {
    for (const entry of sourceEntries) {
      try {
        // Build effective options for this entry (with per-source overrides)
        const entryOptions = buildPerSourceOptions(options, entry);

        const result = await executeFilterDelete(
          entry.path,
          destination,
          entryOptions,
          recorder,
          db,
        );

        aggregatedResult.deleted += result.deleted;
        aggregatedResult.skipped += result.skipped;
        aggregatedResult.trackingRemoved += result.trackingRemoved;
        aggregatedResult.failed.push(...result.failed);
      } catch (err) {
        const error = err as Error;
        logError(`Failed to process source: ${entry.path}`);
        logError(`  ${error.message}`);
        aggregatedResult.failed.push({
          path: entry.path,
          message: error.message,
        });
      }

      // Add spacing between sources when processing multiple
      if (sourceEntries.length > 1) {
        console.error("");
      }
    }
  } finally {
    // Close history recorder
    if (recorder) {
      await recorder.close();
      logDebug(
        `History session closed: ${recorder.getId()} (${recorder.getOperationCount()} operations)`,
      );
    }

    // Update operation status before closing database
    if (db && operationId !== undefined) {
      // Determine final status based on results
      const failedCount = aggregatedResult.failed.length;
      const processedCount = sourceEntries.length - failedCount;

      const status: "completed" | "failed" | "partial" =
        failedCount > 0 ? (processedCount > 0 ? "partial" : "failed") : "completed";

      updateOperationCounts(db, operationId, {
        totalSources: sourceEntries.length,
        completedCount: processedCount,
        failedCount: failedCount,
      });
      updateOperationStatus(db, operationId, status);
      logDebug(`Updated operation #${operationId} status to: ${status}`);
    }

    // Close database
    if (db) {
      closeDatabase(db);
    }
  }

  // Log overall summary for multi-source operations
  if (sourceEntries.length > 1) {
    console.error("");
    console.error("Delete Summary");
    console.error("");

    const summaryOutput = formatDeleteSummaryTable({
      sourcesProcessed: sourceEntries.length,
      deleted: aggregatedResult.deleted,
      trackingRemoved: aggregatedResult.trackingRemoved,
      failed: aggregatedResult.failed.length,
    });

    console.error(summaryOutput);
    console.error("");
  }

  // Trigger media server scan after deletion (if configured and not dry-run).
  const { adapter: mediaServerAdapter, libraryName } = resolveOptionalScanAdapter({
    plexUrl: options.plexUrl,
    plexToken: options.plexToken,
    plexLibrary: options.plexLibrary,
    plexScan: options.plexScan,
    plexPerSource: options.plexPerSource,
  });

  if (mediaServerAdapter?.capabilities.scan && !options.dryRun && aggregatedResult.deleted > 0) {
    logInfo(""); // Empty line for readability
    const scanResult = await mediaServerAdapter.scan.trigger();
    if (scanResult.success) {
      logSuccess(`Plex library scan triggered: ${scanResult.libraryName ?? "all libraries"}`);
    } else {
      logWarn(`Plex scan failed: ${scanResult.message}`);
    }
  } else if (
    mediaServerAdapter?.capabilities.scan &&
    options.dryRun &&
    aggregatedResult.deleted > 0
  ) {
    logInfo(""); // Empty line for readability
    logInfo(formatDryRun(`trigger Plex scan: ${libraryName ?? "all libraries"}`));
  }

  return aggregatedResult;
}
