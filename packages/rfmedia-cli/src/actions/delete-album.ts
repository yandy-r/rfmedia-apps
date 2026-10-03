/**
 * Album mode delete logic for rfmedia CLI.
 *
 * Implements reverse-order deletion of numbered album copies.
 * When --count=5, deletes the 5 highest suffixes (e.g., 010, 009, 008, 007, 006).
 * When --range=008-010, deletes the specified suffixes.
 *
 * Supports:
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
import { formatSuffix, detectHighestSuffix, formatRange } from "../lib/range.js";
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
import { buildOptionsHash, formatOptionsHash } from "../lib/completed-tracker.js";
import { resolveOptionalScanAdapter } from "../lib/adapters/action-helpers.js";
import type { DbConnection } from "../types/db.js";
import type {
  DeleteOptions,
  DeleteResult,
  FailedOperation,
  CopyRange,
  PathEntry,
} from "../types/index.js";

/**
 * Builds per-source options by applying YAML per-source overrides.
 *
 * Per-source values (from YAML --paths) take precedence over CLI options.
 * For album mode, handles: count, range, convertFormat
 *
 * @param baseOptions - Base options from CLI/config
 * @param entry - Source entry with optional per-source overrides
 * @returns Modified options with per-source values applied
 */
function buildPerSourceOptions(baseOptions: DeleteOptions, entry: PathEntry): DeleteOptions {
  // If no per-source overrides, return base options as-is
  if (entry.count === undefined && !entry.range && !entry.convertFormat) {
    return baseOptions;
  }

  // Start with a shallow copy of base options
  let options = { ...baseOptions };

  // Apply per-source count (only if CLI count not specified)
  if (entry.count !== undefined && baseOptions.count === undefined) {
    options = { ...options, count: entry.count };
    logDebug(`Per-source count: ${entry.count}`);
  }

  // Apply per-source range (only if no count specified and CLI range not specified)
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

  return options;
}

/**
 * Suffix information for a discovered album copy.
 */
interface AlbumSuffix {
  /** Suffix number (e.g., 5 for Album-005) */
  suffixNum: number;
  /** Formatted suffix string (e.g., "005") */
  suffix: string;
  /** Full path to the album directory */
  path: string;
  /** Base album name without suffix */
  albumName: string;
}

/**
 * Discovers all numbered album copies in an artist directory.
 *
 * Scans for directories matching the pattern `AlbumName-XXX` where XXX is 3+ digits.
 * Returns results sorted by suffix in descending order (highest first).
 *
 * @param artistDir - Path to the artist directory
 * @returns Array of album suffixes, sorted descending by suffix number
 */
async function discoverAlbumSuffixes(artistDir: string): Promise<AlbumSuffix[]> {
  const scanOperation = async (): Promise<AlbumSuffix[]> => {
    const entries = await readdir(artistDir, { withFileTypes: true });

    // Pattern matches: anything ending with -XXX where XXX is 3+ digits
    const suffixPattern = /^(.+)-(\d{3,})$/;

    const suffixes: AlbumSuffix[] = [];

    for (const entry of entries) {
      // Only check directories (album folders)
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

      suffixes.push({
        suffixNum,
        suffix: suffixStr,
        path: path.join(artistDir, entry.name),
        albumName,
      });
    }

    // Sort by suffix number in descending order (highest first for deletion)
    return suffixes.sort((a, b) => b.suffixNum - a.suffixNum);
  };

  // Use spinner for scanning unless in JSON mode
  if (isJsonMode()) {
    return scanOperation();
  }

  return withSpinner(`Scanning album copies in ${path.basename(artistDir)}`, scanOperation);
}

/**
 * Filters album suffixes based on delete options (count or range).
 *
 * For --count: Returns the N highest suffixes.
 * For --range: Returns suffixes within the specified range.
 * For --interactive: Returns only suffixes selected by user.
 *
 * @param allSuffixes - All discovered album suffixes (sorted descending)
 * @param source - Source path (for interactive selection lookup)
 * @param options - Delete options with count or range
 * @returns Filtered array of suffixes to delete
 */
function filterSuffixesToDelete(
  allSuffixes: AlbumSuffix[],
  source: string,
  options: DeleteOptions,
): AlbumSuffix[] {
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
 * Deletes a single album directory with history recording.
 *
 * @param albumPath - Path to the album directory to delete
 * @param useTrash - Whether to move to trash instead of permanent delete
 * @param recorder - Optional history recorder for undo support
 * @param dryRun - Whether this is a dry-run preview
 * @returns true if deletion succeeded, false otherwise
 */
async function deleteAlbumDirectory(
  albumPath: string,
  useTrash: boolean,
  recorder?: HistoryRecorder,
  dryRun?: boolean,
): Promise<{ success: boolean; error?: Error }> {
  const albumName = path.basename(albumPath);
  const action = useTrash ? "trash" : "delete";

  if (dryRun) {
    logInfo(formatDryRun(`${action}: ${albumPath}`));
    return { success: true };
  }

  try {
    if (useTrash) {
      await moveToTrash(albumPath);
      if (recorder) {
        await recorder.recordTrash(albumPath);
      }
    } else {
      await remove(albumPath);
      if (recorder) {
        await recorder.recordRemove(albumPath);
      }
    }

    const actionPast = useTrash ? "Moved to trash" : "Deleted";
    logSuccess(`  ${actionPast}: ${albumName}`);
    return { success: true };
  } catch (err) {
    const error = err as Error;
    logWarn(`  Failed to ${action}: ${albumName}: ${error.message}`);
    return { success: false, error };
  }
}

/**
 * Executes album mode delete operation for a single source.
 *
 * In artist mode (default): treats source as an artist folder, deleting
 * numbered album copies from the destination artist folder.
 *
 * In album-only mode (--album-only): treats source as a single album,
 * extracting artist name from parent directory.
 *
 * Processes suffixes in reverse order (highest first) when using --count.
 *
 * @param source - Source path (artist folder or album folder)
 * @param destination - Destination directory containing artist folders
 * @param options - Delete options with mode, range/count, albumOnly, etc.
 * @param recorder - Optional history recorder for undo support
 * @param db - Optional database connection for tracking removal
 * @returns Result with deleted/skipped/failed counts
 */
export async function executeAlbumDelete(
  source: string,
  destination: string,
  options: DeleteOptions,
  recorder?: HistoryRecorder,
  db?: DbConnection,
): Promise<DeleteResult> {
  const { albumOnly, dryRun, useTrash, keepTracking } = options;

  const result: DeleteResult = {
    source,
    deleted: 0,
    skipped: 0,
    trackingRemoved: 0,
    failed: [],
  };

  // Determine artist name based on mode
  let artistName: string;
  if (albumOnly) {
    // Album-only mode: source is an album, extract artist from parent
    artistName = path.basename(path.dirname(source));
  } else {
    // Artist mode: source is an artist folder
    artistName = path.basename(source);
  }

  const artistDest = path.join(destination, artistName);

  // Verify destination exists
  if (!(await pathExists(artistDest))) {
    logWarn(`Artist destination does not exist: ${artistDest}`);
    return result;
  }

  // Discover all album suffixes in the destination
  const allSuffixes = await discoverAlbumSuffixes(artistDest);

  if (allSuffixes.length === 0) {
    return result;
  }

  // Filter suffixes based on count or range or interactive selection
  const suffixesToDelete = filterSuffixesToDelete(allSuffixes, source, options);

  if (suffixesToDelete.length === 0) {
    return result;
  }

  for (const suffix of suffixesToDelete) {
    logDebug(`  - ${suffix.albumName}-${suffix.suffix}`);
  }

  if (dryRun) {
    logWarn("[DRY-RUN] Previewing deletions...");
  }

  // Delete each album suffix
  for (const suffix of suffixesToDelete) {
    const deleteResult = await deleteAlbumDirectory(suffix.path, useTrash, recorder, dryRun);

    if (deleteResult.success) {
      result.deleted++;

      // Remove tracking entries (unless --keep-tracking)
      // This removes from ALL operations, not just one, to ensure re-copy works
      if (!keepTracking && db && !dryRun) {
        // Album name is just the album folder name (source identifies artist)
        const trackingDeleted = deleteCompletedAlbumCopyByPath(
          db,
          source,
          suffix.albumName,
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

  // Per-source summary suppressed - rely on multi-source summary table
  return result;
}

/**
 * Executes album delete with support for file-based input.
 *
 * If `options.file` is provided, reads source paths from the file and processes
 * each one. Otherwise, uses the provided source argument directly.
 *
 * When processing multiple sources from a file, errors on individual sources
 * are logged but do not stop processing of remaining sources. The final result
 * aggregates all operations.
 *
 * @param source - Source path (used when options.file is not provided)
 * @param destination - Destination directory where artist folders exist
 * @param options - Delete options including optional file path
 * @returns Aggregated result across all sources
 */
export async function executeAlbumDeleteWithFileInput(
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
    const optionsHash = `delete-album-${options.cliRange ? `${options.cliRange.start}-${options.cliRange.end}` : options.count ? `count-${options.count}` : "all"}`;

    operationId = createOperation(db, {
      command: "delete",
      mode: "album",
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
    logInfo("");
    logInfo("The following album copies will be deleted:");
    logInfo("");

    let totalToDelete = 0;

    for (const entry of sourceEntries) {
      const artistName = options.albumOnly
        ? path.basename(path.dirname(entry.path))
        : path.basename(entry.path);
      const artistDest = path.join(destination, artistName);

      if (await pathExists(artistDest)) {
        const allSuffixes = await discoverAlbumSuffixes(artistDest);

        // Build effective options for this entry (with per-source overrides)
        const entryOptions = buildPerSourceOptions(options, entry);
        const suffixesToDelete = filterSuffixesToDelete(allSuffixes, entry.path, entryOptions);

        if (suffixesToDelete.length > 0) {
          logInfo(`  ${artistName}:`);
          for (const suffix of suffixesToDelete) {
            logInfo(`    - ${suffix.albumName}-${suffix.suffix}`);
            totalToDelete++;
          }
        }
      }
    }

    if (totalToDelete === 0) {
      logInfo("  (no album copies to delete)");
      return aggregatedResult;
    }

    logInfo("");
    const confirmed = await confirm(`Delete ${totalToDelete} album copies?`);
    if (!confirmed) {
      logInfo("Deletion cancelled");
      return aggregatedResult;
    }
  }

  try {
    for (const entry of sourceEntries) {
      try {
        // Build effective options for this entry (with per-source overrides)
        const entryOptions = buildPerSourceOptions(options, entry);

        const result = await executeAlbumDelete(
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
