/**
 * Album mode copy logic for rfmedia CLI.
 *
 * Implements range-based album copying with numbered suffixes.
 * Copies albums from source to destination with Album-XXX naming.
 * Supports hardlinks, force overwrite, and dry-run modes.
 *
 * Copy optimization: First copy comes from source, subsequent copies
 * are created from the first copy (significant speedup with hardlinks).
 */

import path from "node:path";
import { readdir } from "node:fs/promises";

import {
  copyDirectory,
  copyOrLink,
  copyOrLinkWithHash,
  ensureDir,
  pathExists,
  remove,
  scanDirectoryStats,
  getFileSize,
} from "../lib/filesystem.js";
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
  outputSuccess,
} from "../lib/logger.js";
import { collectPreviewResult, formatPreviewOutput } from "../lib/preview.js";
import { formatCopySummaryTable } from "../lib/table-format.js";
import {
  createTrackingConfig,
  createTrackingStats,
  loadTrackingState,
  initializeTracking,
  filterPendingSources,
  recordCompleted,
  recordCompletedAlbumCopy,
  recordFailed,
  calculateTimingStats,
  loadCompletedAlbumCopiesForSource,
  getPendingSuffixes,
  buildOptionsHash,
} from "../lib/completed-tracker.js";
import type { TrackingConfig, TrackingState, TrackingStats } from "../types/tracking.js";
import {
  initializeDatabase,
  closeDatabase,
  recordInventoryFiles,
  updateOperationStatus,
  updateOperationCounts,
} from "../lib/db.js";
import type { DbConnection } from "../types/db.js";
import { processInParallel } from "../lib/parallel.js";
import { withSpinner } from "../lib/progress.js";
import { CopyProgressBar, isProgressEnabled } from "../lib/progress-bar.js";
import { formatSuffix, detectHighestSuffix, buildAutoRange, formatRange } from "../lib/range.js";
import { verifyAlbumComplete } from "../lib/verify.js";
import { calculateHash, verifyFileIntegrity } from "../lib/integrity.js";
import { createFileInventoryEntry } from "../lib/inventory.js";
import { isAudioFile } from "../lib/audio.js";
import { convertFile, getConvertedFilename, getFormatDescription } from "../lib/convert.js";
import { resolveOptionalScanAdapter } from "../lib/adapters/action-helpers.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { shouldUseUndoLegacyMode, resolveUndoDatabasePath } from "../lib/config.js";
import {
  detectConflict,
  generateUniquePath,
  resolveConflictInteractive,
  shouldReportConflictsAsJson,
  reportConflictsAsJsonAndExit,
} from "../lib/conflict-resolver.js";
import { isInteractive } from "../lib/prompt.js";
import type {
  CopyOptions,
  CopyRange,
  CopyResult,
  FailedOperation,
  ConvertFormat,
  PathEntry,
  BeforeCopyContext,
  AfterCopyContext,
  AfterBatchContext,
} from "../types/index.js";
import type {
  ConflictContext,
  ConflictResolution,
  ConflictResolutionResult,
} from "../types/conflict.js";
import { getPluginManager } from "../lib/plugin-manager.js";
import { runBeforeCopyHooks, runAfterCopyHooks, runAfterBatchHooks } from "../lib/plugin-runner.js";

/**
 * Progress callback type for tracking file copy completion.
 */
type ProgressCallback = (fileBytes: number) => void;
type InventoryRecord = Parameters<typeof recordInventoryFiles>[2][number];

interface InventoryCaptureOptions {
  sourceRoot: string;
  relativeRoot?: string;
  relativePrefix?: string;
  hashContent: boolean;
}

/**
 * Result of processing a single album across the range.
 */
interface AlbumProcessResult {
  created: number;
  skipped: number;
  failed: FailedOperation[];
  conflictResolutions: ConflictResolutionResult[];
}

/**
 * Finds all album subdirectories in an artist folder.
 *
 * @param artistPath - Path to the artist directory
 * @returns Array of album directory paths
 */
async function findAlbums(artistPath: string): Promise<string[]> {
  const scanOperation = async (): Promise<string[]> => {
    const entries = await readdir(artistPath, { withFileTypes: true });

    const albums: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        albums.push(path.join(artistPath, entry.name));
      }
    }

    // Sort albums alphabetically for consistent ordering
    return albums.sort();
  };

  // Use spinner for scanning unless in JSON mode
  if (isJsonMode()) {
    return scanOperation();
  }

  return withSpinner(`Scanning albums in ${path.basename(artistPath)}`, scanOperation);
}

/**
 * Copies a directory with optional audio conversion and progress tracking.
 *
 * When convertFormat is specified:
 * - Audio files are converted to the target format
 * - Non-audio files are copied/linked normally
 *
 * When convertFormat is undefined, behaves like copyDirectory.
 *
 * @param sourceDir - Path to the source directory
 * @param destDir - Path to the destination directory
 * @param options - Copy options
 * @param options.hardlink - Whether to use hardlinks for non-audio files
 * @param options.convertFormat - Target audio format (undefined for no conversion)
 * @param options.recorder - Optional history recorder for undo support
 * @param onProgress - Optional callback called after each file with file size
 * @param signal - Optional abort signal for cancellation support
 */
async function copyDirectoryWithConversion(
  sourceDir: string,
  destDir: string,
  options: {
    hardlink: boolean;
    convertFormat?: ConvertFormat;
    recorder?: HistoryRecorder;
    verify?: boolean;
    inventory?: InventoryCaptureOptions;
  },
  inventoryRecords: InventoryRecord[] = [],
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  const { hardlink, convertFormat, recorder } = options;

  // If no conversion needed, use standard copy with progress
  if (!convertFormat) {
    await copyDirectoryWithProgress(
      sourceDir,
      destDir,
      { hardlink, recorder, verify: options.verify, inventory: options.inventory },
      inventoryRecords,
      onProgress,
      signal,
    );
    return;
  }

  // Ensure destination directory exists
  const dirExisted = await pathExists(destDir);
  await ensureDir(destDir);
  if (recorder && !dirExisted) {
    await recorder.recordMkdir(destDir, true);
  }

  // Read source directory contents
  const entries = await readdir(sourceDir, { withFileTypes: true });

  // Process each entry
  for (const entry of entries) {
    // Check if operation was cancelled
    if (signal?.aborted) {
      throw new Error("Operation cancelled");
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      // Recursively process subdirectories
      await copyDirectoryWithConversion(
        sourcePath,
        destPath,
        options,
        inventoryRecords,
        onProgress,
        signal,
      );
    } else if (entry.isFile()) {
      let fileSize = await getFileSize(sourcePath);
      let fileMtime: number | undefined;
      const isAudio = isAudioFile(entry.name);

      // Run beforeCopy hooks
      const manager = getPluginManager();
      if (manager.isInitialized()) {
        const beforeContext: BeforeCopyContext = {
          sourcePath,
          destPath: destDir,
          isAudioFile: isAudio,
          convertFormat,
          signal,
        };
        await runBeforeCopyHooks([...manager.getPlugins()], beforeContext, { signal });
      }

      // Track the final destination path and method for afterCopy hook
      let finalDestPath: string;
      let copyMethod: "copy" | "hardlink" | "converted";
      let contentHash: string | null;

      try {
        if (isAudio) {
          // Convert audio files
          const convertedFilename = getConvertedFilename(entry.name, convertFormat);
          const convertedDestPath = path.join(destDir, convertedFilename);
          await convertFile(sourcePath, convertedDestPath, convertFormat);
          logDebug(`Converted: ${sourcePath} -> ${convertedDestPath}`);
          if (recorder) {
            await recorder.recordConvert(sourcePath, convertedDestPath, convertFormat);
          }
          finalDestPath = convertedDestPath;
          copyMethod = "converted";
          contentHash =
            options.inventory?.hashContent === false ? null : await calculateHash(finalDestPath);
        } else {
          // Copy/link non-audio files
          const copyResult =
            options.inventory?.hashContent === false
              ? {
                  method: await copyOrLink(sourcePath, destPath, hardlink, signal),
                  contentHash: null,
                }
              : await copyOrLinkWithHash(sourcePath, destPath, hardlink, signal);
          if (recorder) {
            if (copyResult.method === "hardlink") {
              await recorder.recordHardlink(sourcePath, destPath);
            } else {
              await recorder.recordCopy(sourcePath, destPath);
            }
          }
          finalDestPath = destPath;
          copyMethod = copyResult.method;
          contentHash = copyResult.contentHash;
          if ("size" in copyResult) {
            fileSize = copyResult.size;
          }
          if ("mtime" in copyResult) {
            fileMtime = copyResult.mtime;
          }
        }

        // Verify file integrity if requested (only for byte-identical copy/hardlink; skip for converted)
        if (options.verify && copyMethod !== "converted") {
          const valid = await verifyFileIntegrity(sourcePath, finalDestPath);
          if (!valid) {
            throw new Error(`Integrity check failed for ${entry.name}`);
          }
        }
      } catch (error) {
        // Validation/conversion failed - clean up potential partial file
        // We need to know which file to clean up.
        // If finalDestPath is set, use it. If not, we might fail before setting it?
        // Actually, we set finalDestPath inside the try block. If it fails before setting it (e.g. convertFile throws),
        // we might know the target path from context.
        // For conversion, target is constructed. For copy, it is destPath.
        let cleanupPath: string | undefined;

        if (isAudio) {
          const convertedFilename = getConvertedFilename(entry.name, convertFormat);
          cleanupPath = path.join(destDir, convertedFilename);
        } else {
          cleanupPath = destPath;
        }

        if (cleanupPath) {
          try {
            if (await pathExists(cleanupPath)) {
              await remove(cleanupPath);
            }
          } catch (cleanupError) {
            logWarn(`Failed to cleanup after error: ${(cleanupError as Error).message}`);
          }
        }

        logError(`Failed to process ${entry.name}: ${(error as Error).message}`);
        throw error;
      }

      if (options.inventory) {
        const relativePath =
          options.inventory.relativeRoot === undefined
            ? undefined
            : path.join(
                options.inventory.relativePrefix ?? "",
                path.relative(options.inventory.relativeRoot, sourcePath),
              );
        inventoryRecords.push(
          await createInventoryRecord(
            options.inventory.sourceRoot,
            sourcePath,
            finalDestPath,
            null,
            contentHash,
            fileMtime === undefined || fileSize === undefined
              ? undefined
              : { mtime: fileMtime, size: fileSize },
            relativePath,
          ),
        );
      }

      // Run afterCopy hooks
      if (manager.isInitialized()) {
        const afterContext: AfterCopyContext = {
          sourcePath,
          destPath: finalDestPath,
          method: copyMethod,
          fileSize,
          signal,
        };
        // Note: afterCopy hooks don't receive a CopyResult per-file, passing empty result
        await runAfterCopyHooks(
          [...manager.getPlugins()],
          afterContext,
          {
            source: sourcePath,
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
    }
    // Skip symlinks and other special files
  }

  logDebug(`Copied directory with conversion: ${sourceDir} -> ${destDir}`);
}

/**
 * Copies a directory with progress tracking.
 *
 * @param sourceDir - Path to the source directory
 * @param destDir - Path to the destination directory
 * @param options - Copy options
 * @param options.hardlink - Whether to use hardlinks for files
 * @param options.recorder - Optional history recorder for undo support
 * @param onProgress - Optional callback called after each file with file size
 * @param signal - Optional abort signal for cancellation support
 */
async function copyDirectoryWithProgress(
  sourceDir: string,
  destDir: string,
  options: {
    hardlink: boolean;
    recorder?: HistoryRecorder;
    verify?: boolean;
    inventory?: InventoryCaptureOptions;
  },
  inventoryRecords: InventoryRecord[] = [],
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  const { hardlink, recorder } = options;

  // Ensure destination directory exists
  const dirExisted = await pathExists(destDir);
  await ensureDir(destDir);
  if (recorder && !dirExisted) {
    await recorder.recordMkdir(destDir, true);
  }

  // Read source directory contents
  const entries = await readdir(sourceDir, { withFileTypes: true });

  // Process each entry
  for (const entry of entries) {
    // Check if operation was cancelled
    if (signal?.aborted) {
      throw new Error("Operation cancelled");
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      // Recursively copy subdirectory
      await copyDirectoryWithProgress(
        sourcePath,
        destPath,
        options,
        inventoryRecords,
        onProgress,
        signal,
      );
    } else if (entry.isFile()) {
      const isAudio = isAudioFile(entry.name);

      // Run beforeCopy hooks
      const manager = getPluginManager();
      if (manager.isInitialized()) {
        const beforeContext: BeforeCopyContext = {
          sourcePath,
          destPath: destDir,
          isAudioFile: isAudio,
          signal,
        };
        await runBeforeCopyHooks([...manager.getPlugins()], beforeContext, { signal });
      }

      // Copy or link file
      const copyResult =
        options.inventory?.hashContent === false
          ? { method: await copyOrLink(sourcePath, destPath, hardlink, signal), contentHash: null }
          : await copyOrLinkWithHash(sourcePath, destPath, hardlink, signal);
      const { method, contentHash } = copyResult;
      const size = "size" in copyResult ? copyResult.size : await getFileSize(sourcePath);
      if (recorder) {
        if (method === "hardlink") {
          await recorder.recordHardlink(sourcePath, destPath);
        } else {
          await recorder.recordCopy(sourcePath, destPath);
        }
      }

      if (options.inventory) {
        const relativePath =
          options.inventory.relativeRoot === undefined
            ? undefined
            : path.join(
                options.inventory.relativePrefix ?? "",
                path.relative(options.inventory.relativeRoot, sourcePath),
              );
        inventoryRecords.push(
          await createInventoryRecord(
            options.inventory.sourceRoot,
            sourcePath,
            destPath,
            null,
            contentHash,
            "mtime" in copyResult ? { mtime: copyResult.mtime, size } : undefined,
            relativePath,
          ),
        );
      }

      // Verify file integrity if requested
      if (options.verify) {
        try {
          const valid = await verifyFileIntegrity(sourcePath, destPath);
          if (!valid) {
            // Verification failed - clean up and report error
            await remove(destPath);
            throw new Error(`Integrity check failed for ${entry.name}`);
          }
        } catch (error) {
          logError(`Verification failed for ${entry.name}: ${(error as Error).message}`);
          // Attempt cleanup on verification error
          try {
            if (await pathExists(destPath)) {
              await remove(destPath);
            }
          } catch (cleanupError) {
            logWarn(
              `Failed to cleanup after verification error: ${(cleanupError as Error).message}`,
            );
          }
          throw error;
        }
      }

      // Run afterCopy hooks
      if (manager.isInitialized()) {
        const afterContext: AfterCopyContext = {
          sourcePath,
          destPath,
          method,
          fileSize: size,
          signal,
        };
        await runAfterCopyHooks(
          [...manager.getPlugins()],
          afterContext,
          {
            source: sourcePath,
            created: 1,
            skipped: 0,
            filtered: 0,
            failed: [],
          },
          { signal },
        );
      }

      // Report progress
      onProgress?.(size);
    }
    // Skip symlinks and other special files
  }

  logDebug(`Copied directory: ${sourceDir} -> ${destDir}`);
}

/**
 * Information about a suffix copy task.
 */
interface SuffixCopyTask {
  /** Suffix number to create */
  suffixNum: number;
  /** Formatted suffix string (e.g., "001") */
  suffix: string;
  /** Destination path for this copy */
  destPath: string;
}

/**
 * Context for granular album copy tracking.
 * Passed to processAlbum to enable per-suffix completion tracking.
 */
interface AlbumTrackingContext {
  /** Tracking configuration */
  config: TrackingConfig;
  /** Source path (artist or album directory) */
  sourcePath: string;
  /** Set of already completed suffixes for this album (from database) */
  completedSuffixes: Set<string>;
  /** Rating filter key for rating-aware tracking (e.g., 'r80', 's3', null for no filter) */
  ratingKey?: string | null;
}

function recordAlbumInventory(
  trackingContext: AlbumTrackingContext | undefined,
  records: InventoryRecord[],
): void {
  const db = trackingContext?.config.db;
  const operationId = trackingContext?.config.operationId;
  if (!db || operationId === undefined || records.length === 0) {
    return;
  }

  recordInventoryFiles(db, operationId, records);
}

async function createInventoryRecord(
  sourceRoot: string,
  filePath: string,
  destPath: string,
  rating: number | null,
  contentHash: string | null,
  metadata?: { mtime: number; size: number },
  relativePath?: string,
): Promise<InventoryRecord> {
  if (metadata !== undefined) {
    return {
      sourcePath: path.resolve(sourceRoot),
      relativePath: relativePath ?? path.relative(sourceRoot, filePath),
      mtime: metadata.mtime,
      size: metadata.size,
      rating,
      genre: null,
      year: null,
      bpm: null,
      artist: null,
      destPath,
      contentHash,
    };
  }

  const inventoryEntry = await createFileInventoryEntry(
    sourceRoot,
    filePath,
    destPath,
    rating,
    contentHash,
  );

  return {
    sourcePath: path.resolve(sourceRoot),
    relativePath: relativePath ?? inventoryEntry.relativePath,
    mtime: inventoryEntry.mtime,
    size: inventoryEntry.size,
    rating: inventoryEntry.rating,
    genre: inventoryEntry.genre ?? null,
    year: inventoryEntry.year ?? null,
    bpm: inventoryEntry.bpm ?? null,
    artist: inventoryEntry.artist ?? null,
    destPath: inventoryEntry.destPath,
    contentHash: inventoryEntry.contentHash ?? null,
  };
}

/**
 * Context for conflict resolution during album copy operations.
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
 * Resolves a conflict for an existing album copy directory.
 *
 * Determines the resolution action based on:
 * 1. --force flag (implies 'overwrite')
 * 2. --conflict-strategy option
 * 3. Interactive prompt (if TTY available and strategy is 'ask')
 * 4. Error if non-interactive and strategy is 'ask'
 *
 * @param albumSource - Path to source album directory
 * @param destPath - Path to existing destination album directory
 * @param options - Copy options with force and conflictStrategy
 * @param conflictContext - Shared conflict resolution context with applyToAll state
 * @param albumName - Album name for logging
 * @param suffix - Suffix string for logging
 * @returns The resolution action to take
 * @throws Error if strategy is 'ask' and environment is non-interactive
 */
async function resolveAlbumConflict(
  albumSource: string,
  destPath: string,
  options: CopyOptions,
  conflictContext: ConflictResolutionContext,
  albumName: string,
  suffix: string,
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

  // No conflict strategy specified and no force
  if (!conflictStrategy) {
    // In JSON mode, report conflicts as JSON and exit
    if (shouldReportConflictsAsJson(conflictStrategy)) {
      const context: ConflictContext = {
        sourcePath: albumSource,
        destPath,
        conflictType: { type: "exists", destPath, destSize: 0 },
      };
      reportConflictsAsJsonAndExit([context], "copy");
    }
    // Default to skip for complete albums in interactive mode
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
          sourcePath: albumSource,
          destPath,
          conflictType: { type: "exists", destPath, destSize: 0 },
        };
        reportConflictsAsJsonAndExit([context], "copy");
      }

      // Interactive mode - prompt user for resolution
      if (!isInteractive()) {
        throw new Error(
          `Conflict detected at ${albumName}-${suffix} but running in non-interactive mode. ` +
            "Use --conflict-strategy=skip|overwrite|rename or --force to specify a resolution.",
        );
      }

      // Create conflict context for the prompt
      const context: ConflictContext = {
        sourcePath: albumSource,
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
 * Processes a single album, creating numbered copies within the range.
 *
 * Uses parallel processing for subsequent copies after the first copy is created.
 * The first copy must be created sequentially to serve as the source for subsequent
 * parallel copies (optimization: copy from first copy instead of original source).
 *
 * Supports granular tracking: when tracking context is provided, each completed
 * suffix is recorded individually, enabling range expansion on subsequent runs.
 *
 * @param albumSource - Path to source album directory
 * @param artistDest - Path to destination artist directory
 * @param range - Range of suffixes to create
 * @param options - Copy options including hardlink, force, dryRun, workers, conflictStrategy
 * @param onProgress - Optional callback called after each file with file size
 * @param recorder - Optional history recorder for undo support
 * @param trackingContext - Optional tracking context for granular album copy tracking
 * @param signal - Optional abort signal for cancellation support
 * @param inProgressFiles - Set to track files currently being written
 * @param conflictContext - Optional shared conflict resolution context
 * @returns Result with created/skipped/failed/conflictResolutions counts
 */
async function processAlbum(
  albumSource: string,
  artistDest: string,
  range: CopyRange,
  options: CopyOptions,
  onProgress?: ProgressCallback,
  recorder?: HistoryRecorder,
  trackingContext?: AlbumTrackingContext,
  signal?: AbortSignal,
  inProgressFiles?: Set<string>,
  conflictContext?: ConflictResolutionContext,
): Promise<AlbumProcessResult> {
  const albumName = path.basename(albumSource);
  const { force, dryRun, hardlink, workers, convertFormat } = options;
  // Internal benchmark-only escape hatch used to compare SQLite inventory
  // overhead with and without hashing. CLI/user copy paths never set it.
  const hashInventoryContent =
    (options as { benchmarkDisableContentHashing?: boolean }).benchmarkDisableContentHashing !==
    true;

  let created = 0;
  let skipped = 0;
  const failed: FailedOperation[] = [];
  const conflictResolutions: ConflictResolutionResult[] = [];

  // Use provided conflict context or create local one
  const localConflictContext = conflictContext ?? {
    applyToAll: new Map<string, ConflictResolution>(),
    usedNames: new Map<string, number>(),
    resolutions: [],
  };

  // Track the first created/found copy path for optimization
  let firstCopyPath: string | null = null;

  // Get completed suffixes from tracking context (for range expansion support)
  const completedSuffixes = trackingContext?.completedSuffixes ?? new Set<string>();

  logInfo(`Processing album: ${albumName}`);

  // Build list of all suffix tasks, filtering out already completed ones
  const allTasks: SuffixCopyTask[] = [];
  let skippedByTracking = 0;

  for (let i = range.start; i <= range.end; i++) {
    const suffix = formatSuffix(i, range.padWidth);
    const destPath = path.join(artistDest, `${albumName}-${suffix}`);

    // Check if this suffix was already completed in a previous run
    if (completedSuffixes.has(suffix) && !force) {
      logDebug(`  Skipping tracked completed suffix: ${albumName}-${suffix}`);
      skippedByTracking++;
      skipped++;
      continue;
    }

    allTasks.push({ suffixNum: i, suffix, destPath });
  }

  if (skippedByTracking > 0) {
    logInfo(`  Skipped ${skippedByTracking} already tracked suffix(es)`);
  }

  // If all suffixes were already completed, nothing to do
  if (allTasks.length === 0) {
    logInfo(`  All suffixes already completed for: ${albumName}`);
    return { created, skipped, failed, conflictResolutions };
  }

  // Handle dry-run mode - simulate all copies and detect conflicts
  if (dryRun) {
    for (const task of allTasks) {
      // Check for potential conflicts in dry-run mode
      if (await pathExists(task.destPath)) {
        const conflict = await detectConflict(albumSource, task.destPath);
        if (conflict) {
          logInfo(formatDryRun(`conflict detected at: ${albumName}-${task.suffix}`));
          // Record the conflict for reporting
          conflictResolutions.push({
            context: conflict,
            resolution: "skip", // Default in dry-run
            success: true,
          });
        }
      }

      if (firstCopyPath === null) {
        const action = convertFormat
          ? `convert (${convertFormat}): ${albumName} -> ${albumName}-${task.suffix}`
          : `create: ${albumName} -> ${albumName}-${task.suffix}`;
        logInfo(formatDryRun(action));
        firstCopyPath = task.destPath;
      } else {
        const linkType = hardlink ? "hardlink" : "copy";
        const firstPendingSuffix = allTasks[0]?.suffix ?? formatSuffix(range.start, range.padWidth);
        logInfo(formatDryRun(`${linkType} from: ${albumName}-${firstPendingSuffix}`));
      }
      created++;
    }
    return { created, skipped, failed, conflictResolutions };
  }

  // Phase 1: Check existing copies and find/create the first copy sequentially
  // We need a valid first copy before we can parallelize
  const pendingTasks: SuffixCopyTask[] = [];

  for (const task of allTasks) {
    // Check if destination already exists
    if (await pathExists(task.destPath)) {
      // Use first copy as verify source if available, otherwise use source
      const verifySource = firstCopyPath ?? albumSource;
      const status = await verifyAlbumComplete(verifySource, task.destPath, convertFormat);

      if (status === "complete") {
        // Destination exists and is complete - this is a conflict situation
        // Determine resolution based on conflictStrategy, force flag, or interactive prompt
        const resolution = await resolveAlbumConflict(
          albumSource,
          task.destPath,
          options,
          localConflictContext,
          albumName,
          task.suffix,
        );

        if (resolution === "skip") {
          logInfo(`  Complete, skipping: ${albumName}-${task.suffix}`);
          // Use existing complete copy as source for subsequent copies
          if (firstCopyPath === null) {
            firstCopyPath = task.destPath;
          }
          // Record this as completed in tracking (it exists and is complete)
          if (trackingContext) {
            await recordCompletedAlbumCopy(
              trackingContext.config,
              trackingContext.sourcePath,
              albumName,
              task.suffix,
              trackingContext.ratingKey,
            );
          }
          skipped++;
          continue;
        } else if (resolution === "overwrite") {
          logWarn(`  Overwriting: ${albumName}-${task.suffix}`);
          await remove(task.destPath);
          // Fall through to create the copy
        } else if (resolution === "rename") {
          // For rename, we generate a unique path and create a new copy there
          const newDestPath = generateUniquePath(task.destPath, localConflictContext.usedNames);
          logInfo(
            `  Renaming conflict: ${albumName}-${task.suffix} -> ${path.basename(newDestPath)}`,
          );

          // Record the conflict resolution
          const conflictResult: ConflictResolutionResult = {
            context: {
              sourcePath: albumSource,
              destPath: task.destPath,
              conflictType: { type: "exists", destPath: task.destPath, destSize: 0 },
            },
            resolution: "rename",
            newPath: newDestPath,
            success: true,
          };
          conflictResolutions.push(conflictResult);
          localConflictContext.resolutions.push(conflictResult);

          // Use existing as first copy source if we don't have one
          if (firstCopyPath === null) {
            firstCopyPath = task.destPath;
          }
          // Queue the renamed destination for processing
          pendingTasks.push({ ...task, destPath: newDestPath });
          continue;
        }
      } else if (status === "incomplete") {
        logWarn(`  Incomplete, recreating: ${albumName}-${task.suffix}`);
        await remove(task.destPath);
      }
    }

    // If we don't have a first copy yet, create it now (sequentially)
    if (firstCopyPath === null) {
      try {
        // Track this destination as in-progress
        if (inProgressFiles) {
          inProgressFiles.add(task.destPath);
        }

        // First copy: convert from source if conversion is enabled
        const inventoryRecords: InventoryRecord[] = [];
        await copyDirectoryWithConversion(
          albumSource,
          task.destPath,
          {
            hardlink,
            convertFormat,
            recorder,
            verify: options.verify,
            inventory: trackingContext
              ? { sourceRoot: trackingContext.sourcePath, hashContent: hashInventoryContent }
              : undefined,
          },
          inventoryRecords,
          onProgress,
          signal,
        );
        firstCopyPath = task.destPath;

        // Materialization succeeded, so persistence failures must not cause later
        // interruption cleanup to remove the completed destination.
        if (inProgressFiles) {
          inProgressFiles.delete(task.destPath);
        }

        recordAlbumInventory(trackingContext, inventoryRecords);

        // Record granular completion only after inventory persistence succeeds.
        if (trackingContext) {
          await recordCompletedAlbumCopy(
            trackingContext.config,
            trackingContext.sourcePath,
            albumName,
            task.suffix,
            trackingContext.ratingKey,
          );
        }

        const actionDesc = convertFormat ? `Converted (${convertFormat})` : "Created";
        logSuccess(`  ${actionDesc}: ${albumName}-${task.suffix}`);
        created++;
      } catch (err) {
        const error = err as Error;
        failed.push({
          path: task.destPath,
          message: error.message,
          code: (error as NodeJS.ErrnoException).code,
        });
        logWarn(`  Failed: ${albumName}-${task.suffix}: ${error.message}`);
      }
    } else {
      // Queue for parallel processing
      pendingTasks.push(task);
    }
  }

  // Phase 2: Process remaining copies in parallel
  if (pendingTasks.length > 0 && firstCopyPath !== null) {
    const sourceForCopies = firstCopyPath;
    const inventoryRelativePrefix = trackingContext
      ? path.relative(trackingContext.sourcePath, albumSource)
      : undefined;
    logDebug(`Processing ${pendingTasks.length} copies in parallel with ${workers} workers`);

    const results = await processInParallel(
      pendingTasks,
      async (task) => {
        // Track this destination as in-progress
        if (inProgressFiles) {
          inProgressFiles.add(task.destPath);
        }

        const inventoryRecords: InventoryRecord[] = [];
        await copyDirectoryWithProgress(
          sourceForCopies,
          task.destPath,
          {
            hardlink,
            recorder,
            verify: options.verify,
            inventory: trackingContext
              ? {
                  sourceRoot: trackingContext.sourcePath,
                  relativeRoot: sourceForCopies,
                  relativePrefix: inventoryRelativePrefix,
                  hashContent: hashInventoryContent,
                }
              : undefined,
          },
          inventoryRecords,
          onProgress,
          signal,
        );

        // Remove from in-progress tracking after successful copy
        if (inProgressFiles) {
          inProgressFiles.delete(task.destPath);
        }

        return { ...task, inventoryRecords };
      },
      {
        workers,
        signal,
        onProgress: (completed, total) => {
          logDebug(`Album copy progress: ${completed}/${total}`);
        },
      },
    );

    // Process results
    for (const result of results) {
      const task = pendingTasks[result.index];
      if (task === undefined) continue;

      if (result.success) {
        try {
          recordAlbumInventory(trackingContext, result.value?.inventoryRecords ?? []);

          // Record granular completion only after inventory persistence succeeds.
          if (trackingContext) {
            await recordCompletedAlbumCopy(
              trackingContext.config,
              trackingContext.sourcePath,
              albumName,
              task.suffix,
              trackingContext.ratingKey,
            );
          }

          if (hardlink) {
            logSuccess(`  Linked: ${albumName}-${task.suffix}`);
          } else {
            logSuccess(`  Copied: ${albumName}-${task.suffix}`);
          }
          created++;
        } catch (err) {
          const error = err as Error;
          failed.push({
            path: task.destPath,
            message: error.message,
            code: (error as NodeJS.ErrnoException).code,
          });
          logWarn(`  Failed: ${albumName}-${task.suffix}: ${error.message}`);
        }
      } else {
        const error = result.error ?? new Error("Unknown error");
        failed.push({
          path: task.destPath,
          message: error.message,
          code: (error as NodeJS.ErrnoException).code,
        });
        logWarn(`  Failed: ${albumName}-${task.suffix}: ${error.message}`);
      }
    }
  }

  if (skipped > 0) {
    logInfo(`  (${skipped} already complete)`);
  }

  // Merge any resolutions from the shared context
  if (conflictContext) {
    conflictResolutions.push(...localConflictContext.resolutions);
  }

  return { created, skipped, failed, conflictResolutions };
}

/**
 * Executes album mode copy operation.
 *
 * In artist mode (default): treats source as an artist folder, copying all
 * album subdirectories to the destination with numbered suffixes.
 *
 * In album-only mode (--album-only): treats source as a single album,
 * extracting artist name from parent directory.
 *
 * Supports granular tracking: when trackingConfig is provided with a database
 * connection, each album-suffix combination is tracked individually. This enables
 * range expansion on subsequent runs (e.g., first run with 001-002, second run
 * with 001-020 only processes 003-020).
 *
 * @param source - Source path (artist folder or album folder)
 * @param destination - Destination directory where artist folder will be created
 * @param options - Copy options with mode, range, albumOnly, hardlink, force, dryRun
 * @param recorder - Optional history recorder for undo support
 * @param trackingConfig - Optional tracking config for granular album copy tracking
 * @returns Result with created/skipped/filtered/failed counts
 * @throws Error if source does not exist or mode is not album mode
 */
export async function executeAlbumCopy(
  source: string,
  destination: string,
  options: CopyOptions,
  recorder?: HistoryRecorder,
  trackingConfig?: TrackingConfig,
  signal?: AbortSignal,
  inProgressFiles?: Set<string>,
): Promise<CopyResult> {
  // Validate options has album mode
  if (options.mode.type !== "album") {
    throw new Error("executeAlbumCopy requires album mode options");
  }

  const { range } = options.mode;
  const { albumOnly, dryRun, force, hardlink, convertFormat } = options;

  // Validate source directory exists
  if (!(await pathExists(source))) {
    throw new Error(`Source directory does not exist: ${source}`);
  }

  // Determine artist name and albums based on mode
  let artistName: string;
  let artistDest: string;
  let albums: string[];

  if (albumOnly) {
    // Album-only mode: source is an album, extract artist from parent
    artistName = path.basename(path.dirname(source));
    artistDest = path.join(destination, artistName);
    albums = [source];
    logInfo("Mode: Album-only");
  } else {
    // Artist mode: source is an artist folder, find all albums
    artistName = path.basename(source);
    artistDest = path.join(destination, artistName);
    albums = await findAlbums(source);

    // Apply interactive selection filter
    if (options.selection) {
      const sourceSelection = options.selection.sourceSelections.get(source);
      if (sourceSelection?.level === "album" && sourceSelection.selectedAlbums) {
        const selectedSet = new Set(sourceSelection.selectedAlbums);
        albums = albums.filter((albumPath) => selectedSet.has(path.basename(albumPath)));
        logDebug(`Interactive filter: ${albums.length} albums selected`);
      }
    }

    if (albums.length === 0) {
      throw new Error(`No album folders found in: ${source}`);
    }

    if (!dryRun) {
      logInfo(`Mode: Artist (${albums.length} albums found)`);
    }
  }

  // Log operation details (skip in dry-run mode for cleaner output)
  if (!dryRun) {
    logInfo(`Artist: ${artistName}`);
    logInfo(`Source: ${source}`);
    logInfo(`Destination: ${artistDest}`);
    logInfo(
      `Range: ${formatSuffix(range.start, range.padWidth)}-${formatSuffix(range.end, range.padWidth)}`,
    );

    if (hardlink) {
      logInfo("Using hardlinks");
    }

    if (convertFormat) {
      logInfo(`Converting audio to: ${convertFormat} (${getFormatDescription(convertFormat)})`);
    }

    if (force) {
      logWarn("FORCE mode enabled - will overwrite existing copies");
    }

    logWarn("DRY-RUN mode enabled - no changes will be made");
    logInfo(""); // Empty line for readability
  }

  // DRY-RUN MODE: Use preview system for detailed output
  if (dryRun) {
    // Collect preview information for all albums
    const previewResult = await collectPreviewResult(albums, artistDest, range, {
      range,
      force,
      hardlink,
      convertFormat,
      verbose: options.verbose,
    });
    options.capturePreview?.({ mode: "album", source, preview: previewResult });

    // Format and display preview
    if (!isJsonMode()) {
      await formatPreviewOutput(previewResult, { verbose: options.verbose });
    }

    // Return aggregated results
    return {
      source,
      created:
        previewResult.totals.creates +
        previewResult.totals.overwrites +
        previewResult.totals.recreates,
      skipped: previewResult.totals.skips,
      filtered: 0, // Not applicable to album mode
      failed: [],
    };
  }

  // Create artist destination folder
  if (!(await pathExists(artistDest))) {
    logInfo(`Creating artist folder: ${artistDest}`);
    await ensureDir(artistDest);
  }

  // Calculate total copies to create
  const copyCount = range.end - range.start + 1;

  // Determine if we need pre-scan (for progress bar or disk space check)
  const needsProgressBar = isProgressEnabled(options);
  const needsDiskSpaceCheck = !hardlink && options.requireDiskSpace !== false;
  const needsPreScan = needsProgressBar || needsDiskSpaceCheck;

  // Pre-scan for progress tracking and/or disk space checking
  let progressBar: CopyProgressBar | null = null;
  let totalFiles = 0;
  let totalBytes = 0;

  if (needsPreScan) {
    // Scan all albums to get total file count and bytes
    logDebug("Pre-scanning albums for progress tracking and disk space check...");

    for (const album of albums) {
      const stats = await scanDirectoryStats(album);
      totalFiles += stats.fileCount;
      totalBytes += stats.totalBytes;
    }

    // Multiply by number of copies
    totalFiles *= copyCount;
    totalBytes *= copyCount;

    logDebug(`Total: ${totalFiles} files, ${totalBytes} bytes across ${copyCount} copies`);

    // Disk space check (skip for hardlinks - no additional space needed)
    if (needsDiskSpaceCheck) {
      const { validateDiskSpace, estimateConvertedSize } = await import("../lib/disk.js");

      const estimatedBytes = estimateConvertedSize(totalBytes, convertFormat);
      const margin = getLoadedConfig().copy?.diskSpaceMargin;

      await validateDiskSpace(artistDest, estimatedBytes, {
        margin: margin !== undefined ? margin / 100 : undefined,
        requireSpace: options.requireDiskSpace,
      });
    }

    // Create progress bar if enabled
    if (needsProgressBar) {
      progressBar = new CopyProgressBar({
        totalFiles,
        totalBytes,
        operationName: artistName,
        progress: options.progress,
      });

      progressBar.start();
    }
  }

  // Process each album
  let totalCreated = 0;
  let totalSkipped = 0;
  const allFailed: FailedOperation[] = [];
  const allConflictResolutions: ConflictResolutionResult[] = [];

  // Create shared conflict resolution context for "Apply to All" support across albums
  const sharedConflictContext: ConflictResolutionContext = {
    applyToAll: new Map<string, ConflictResolution>(),
    usedNames: new Map<string, number>(),
    resolutions: [],
  };

  // Create progress callback
  const onProgress: ProgressCallback | undefined = progressBar
    ? (fileBytes: number) => progressBar!.updateFile(fileBytes)
    : undefined;

  // Extract rating key from options for rating-aware tracking
  // Album mode doesn't have a rating filter, so rating_key will be null
  // This is still useful for consistency and future extensibility
  const optionsHash = buildOptionsHash(options);
  const ratingKey = optionsHash.ratingKey ?? null;

  // Load completed album copies for granular tracking (if database tracking is enabled)
  // Pass ratingKey to filter by current rating filter (enables rating-aware tracking)
  let completedAlbumCopies: Map<string, Set<string>> | undefined;
  if (trackingConfig?.db && trackingConfig.operationId !== undefined) {
    completedAlbumCopies = loadCompletedAlbumCopiesForSource(
      trackingConfig.db,
      trackingConfig.operationId,
      source,
      ratingKey,
    );

    // Log if we found previously completed copies
    if (completedAlbumCopies.size > 0) {
      let totalCompleted = 0;
      for (const suffixes of completedAlbumCopies.values()) {
        totalCompleted += suffixes.size;
      }
      const ratingPart = ratingKey ? ` (rating: ${ratingKey})` : "";
      logInfo(
        `Found ${totalCompleted} previously completed album copies${ratingPart} (granular tracking)`,
      );
    }
  }

  try {
    for (const album of albums) {
      const albumName = path.basename(album);

      // Build tracking context for this album
      let trackingContext: AlbumTrackingContext | undefined;
      if (trackingConfig) {
        const completedSuffixes = completedAlbumCopies?.get(albumName) ?? new Set<string>();
        trackingContext = {
          config: trackingConfig,
          sourcePath: source,
          completedSuffixes,
          ratingKey,
        };
      }

      const result = await processAlbum(
        album,
        artistDest,
        range,
        options,
        onProgress,
        recorder,
        trackingContext,
        signal,
        inProgressFiles,
        sharedConflictContext,
      );
      totalCreated += result.created;
      totalSkipped += result.skipped;
      allFailed.push(...result.failed);
      allConflictResolutions.push(...result.conflictResolutions);
    }
  } finally {
    // Stop progress bar
    if (progressBar) {
      progressBar.stop();
    }
  }

  // Log summary
  logInfo(""); // Empty line for readability
  logInfo(`Summary: ${albums.length} album(s) processed`);
  logInfo(`  Created: ${totalCreated}`);
  if (totalSkipped > 0) {
    logInfo(`  Skipped: ${totalSkipped}`);
  }
  if (allFailed.length > 0) {
    logWarn(`  Failed: ${allFailed.length}`);
  }
  if (allConflictResolutions.length > 0) {
    logInfo(`  Conflicts resolved: ${allConflictResolutions.length}`);
  }

  return {
    source,
    created: totalCreated,
    skipped: totalSkipped,
    filtered: 0, // Not applicable to album mode
    failed: allFailed,
    conflictResolutions: allConflictResolutions.length > 0 ? allConflictResolutions : undefined,
  };
}

/**
 * Creates a modified copy of options with a different range.
 *
 * Used when processing file-based input with per-path ranges.
 *
 * @param options - Original copy options
 * @param range - The range to use for this path
 * @returns New CopyOptions with the specified range in album mode
 */
function withRange(options: CopyOptions, range: CopyRange): CopyOptions {
  return {
    ...options,
    mode: {
      type: "album",
      range,
    },
  };
}

/**
 * Executes album copy with support for file-based input.
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
 * Range precedence:
 * 1. CLI --range (applies to ALL paths, overrides per-path and config)
 * 2. Per-path range from file
 * 3. Config file default range
 *
 * Supports tracking completed sources for idempotent operations when:
 * - --file option is used (tracking requires an input file)
 * - --track-completed is specified (or not explicitly disabled)
 *
 * @param source - Source path (used when options.file is not provided)
 * @param destination - Destination directory where artist folders will be created
 * @param options - Copy options including optional file path
 * @returns Aggregated result across all sources
 * @throws Error if file cannot be read or no sources are provided
 */
export async function executeAlbumCopyWithFileInput(
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
      logInfo(`Processing ${sourceEntries.length} source path(s) from CLI`);

      // Log paths with ranges for clarity
      for (const entry of sourceEntries) {
        if (entry.range) {
          logInfo(`  ${entry.path} (range: ${entry.range.start}-${entry.range.end})`);
        } else {
          logInfo(`  ${entry.path}`);
        }
      }
      logInfo(""); // Empty line for readability
    }
  } else if (options.file) {
    // Read sources from file (now returns PathEntry[] with optional ranges)
    logInfo(`Reading source paths from: ${options.file}`);
    sourceEntries = await readSourcePaths(options.file);

    if (sourceEntries.length === 0) {
      throw new Error(`No source paths found in file: ${options.file}`);
    }

    logInfo(`Found ${sourceEntries.length} source path(s)`);
    logInfo(""); // Empty line for readability
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
    name: "copy-album-abort",
    cleanup: () => {
      if (!localAbortController.signal.aborted) {
        localAbortController.abort();
      }
    },
  });

  registerGlobalCleanup({
    priority: 15,
    name: "copy-album-partial-files",
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

    // Determine if we're using granular tracking (database mode)
    // With granular tracking, we don't filter sources at the source level
    // because range expansion requires processing sources even if they were
    // "completed" with a smaller range before
    const useGranularTracking = db !== undefined && !options.dryRun;

    if (useGranularTracking) {
      // Granular tracking: process all sources, let suffix-level tracking handle skipping
      // Only skip sources that are explicitly in the completed set AND have no per-path range
      // (i.e., they would use the same range as before)
      const entriesToProcess: PathEntry[] = [];
      let skipped = 0;

      for (const entry of sourceEntries) {
        // Normalize the path to match tracking state (which uses normalized paths)
        const normalizedPath = path.resolve(entry.path);
        const isCompleted = trackingState.completed.has(normalizedPath);
        const hasPerPathRange = entry.range !== undefined;
        const hasDifferentCliRange = options.cliRange !== undefined;

        // Skip if source is completed AND we're using the same range
        // If there's a per-path range or different CLI range, process it (granular tracking handles it)
        if (isCompleted && !hasPerPathRange && !hasDifferentCliRange) {
          logDebug(`Skipping completed source (no range change): ${entry.path}`);
          skipped++;
        } else {
          if (isCompleted && (hasPerPathRange || hasDifferentCliRange)) {
            logInfo(
              `Source has completed suffixes but processing for range expansion: ${entry.path}`,
            );
          }
          entriesToProcess.push(entry);
        }
      }

      trackingStats.skippedCompleted = skipped;

      if (skipped > 0) {
        logInfo(`Skipping ${skipped} fully completed source(s)`);
      }

      sourceEntries = entriesToProcess;
      sourcePaths = entriesToProcess.map((e) => e.path);
    } else {
      // Legacy tracking: filter at source level (original behavior)
      const { pending, skipped } = filterPendingSources(sourcePaths, trackingState);
      trackingStats.skippedCompleted = skipped;

      if (skipped > 0) {
        logInfo(`Skipping ${skipped} already completed source(s)`);
      }

      // Filter sourceEntries to only include pending paths
      const pendingSet = new Set(pending);
      sourceEntries = sourceEntries.filter((entry) => pendingSet.has(entry.path));
      sourcePaths = pending;
    }

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
      name: "copy-album-history",
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
      name: "copy-album-database",
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
    conflictResolutions: [],
  };

  const failedSources: string[] = [];

  try {
    for (const entry of sourceEntries) {
      const sourcePath = entry.path;

      // Determine effective range for this path:
      // CLI range > auto-range from count > per-path range > config range
      let effectiveRange: CopyRange | undefined;

      if (options.cliRange) {
        // CLI --range overrides everything
        effectiveRange = options.cliRange;
        logDebug(`Using CLI range for ${sourcePath}`);
      } else if (options.count !== undefined) {
        // Auto-detect range for this source (CLI --count)
        const artistName = options.albumOnly
          ? path.basename(path.dirname(sourcePath))
          : path.basename(sourcePath);
        const destArtistDir = path.join(destination, artistName);

        const detection = await detectHighestSuffix(destArtistDir);
        const highestSuffix = detection?.highestSuffix ?? 0;
        const padWidth = detection?.padWidth ?? 3;

        effectiveRange = buildAutoRange(options.count, highestSuffix, padWidth);
        // Auto-detected range (logging suppressed)
      } else if (entry.count !== undefined) {
        // Per-path count from file (auto-detect)
        const artistName = options.albumOnly
          ? path.basename(path.dirname(sourcePath))
          : path.basename(sourcePath);
        const destArtistDir = path.join(destination, artistName);

        const detection = await detectHighestSuffix(destArtistDir);
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
      }

      if (!effectiveRange) {
        // This shouldn't happen in album mode (validated earlier), but handle gracefully
        logError(`No range specified for: ${sourcePath}`);
        logError('  Provide --range, --count, per-path range in file, or set "range" in config');
        failedSources.push(sourcePath);
        aggregatedResult.failed.push({
          path: sourcePath,
          message: "No range specified",
        });
        if (trackingConfig && !options.dryRun) {
          await recordFailed(trackingConfig, sourcePath, "No range specified");
          if (trackingStats) trackingStats.failed++;
        }
        continue;
      }

      // Create options with the effective range for this path
      const pathOptions = withRange(options, effectiveRange);

      try {
        // Pass tracking config for granular album copy tracking
        const result = await executeAlbumCopy(
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
        if (result.conflictResolutions) {
          aggregatedResult.conflictResolutions?.push(...result.conflictResolutions);
        }

        // Record successful source-level completion (only if no file-level failures)
        // Note: Individual album-suffix completions are recorded in processAlbum
        if (trackingConfig && !options.dryRun && result.failed.length === 0) {
          await recordCompleted(trackingConfig, sourcePath);
          if (trackingStats) trackingStats.processed++;
        } else if (trackingConfig && !options.dryRun && result.failed.length > 0) {
          // Source had some failures - record as failed
          await recordFailed(trackingConfig, sourcePath, `${result.failed.length} file(s) failed`);
          if (trackingStats) trackingStats.failed++;
        }

        // Per-source Plex scan: trigger scan for this source's destination immediately
        if (
          mediaServerAdapter?.capabilities.scan &&
          scanPerSource &&
          !options.dryRun &&
          result.created > 0
        ) {
          // Determine the artist destination for this source
          const artistName = options.albumOnly
            ? path.basename(path.dirname(sourcePath))
            : path.basename(sourcePath);
          const artistDest = path.join(destination, artistName);

          const scanResult = await mediaServerAdapter.scan.triggerSource(artistDest);
          if (scanResult.success) {
            logDebug(`Plex scan triggered for: ${artistDest}`);
          } else {
            logWarn(`Plex scan failed for ${artistDest}: ${scanResult.message}`);
          }
        } else if (scanPerSource && options.dryRun && result.created > 0) {
          const artistName = options.albumOnly
            ? path.basename(path.dirname(sourcePath))
            : path.basename(sourcePath);
          const artistDest = path.join(destination, artistName);
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
    unregisterGlobalCleanup("copy-album-abort");
    unregisterGlobalCleanup("copy-album-partial-files");
    unregisterGlobalCleanup("copy-album-history");
    unregisterGlobalCleanup("copy-album-database");

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
      if (aggregatedResult.failed.length > 0) {
        logWarn(`Total failed operations: ${aggregatedResult.failed.length}`);
      }
    }

    console.error("");
  }

  // Run afterBatch hooks
  const manager = getPluginManager();
  if (manager.isInitialized() && !options.dryRun) {
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

  // Trigger end-of-batch scan if configured and not using per-source scanning.
  // Skip if scanPerSource is enabled (scans were already triggered per-source).
  if (mediaServerAdapter?.capabilities.scan && !scanPerSource && !options.dryRun) {
    const scanResult = await mediaServerAdapter.scan.trigger();
    if (!scanResult.success) {
      logWarn(`Plex scan failed: ${scanResult.message}`);
    }
  }

  // Clean up empty conflict resolutions array
  if (aggregatedResult.conflictResolutions?.length === 0) {
    aggregatedResult.conflictResolutions = undefined;
  }

  return aggregatedResult;
}
