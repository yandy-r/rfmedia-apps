/**
 * Sync action implementation for rfmedia CLI.
 *
 * This module implements incremental sync operations that detect new and
 * updated files in previously copied sources. It uses an inventory system
 * to track what has been copied and efficiently sync only changes.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";

import type {
  CopyOptions,
  CopyResult,
  RatingFilter,
  ConvertFormat,
  PathEntry,
} from "../types/index.js";
import type {
  SyncOptions,
  SyncResult,
  SyncFailedOperation,
  SyncDiff,
  LoadedInventory,
  SourceInventory,
  DowngradedFileInfo,
  InventoryContext,
} from "../types/inventory.js";
import {
  resolveInventoryPath,
  loadInventory,
  initializeInventory,
  resetInventory,
  appendSourceRecord,
  appendFileRecord,
  computeFilterSyncDiff,
  computeAlbumSyncDiff,
  createFileInventoryEntry,
  getFileMetadata,
  buildInventoryOptionsHash,
  formatInventoryOptionsHash,
} from "../lib/inventory.js";
import {
  initializeDatabase,
  closeDatabase,
  createOperation,
  updateOperationStatus,
  updateOperationCounts,
} from "../lib/db.js";
import type { DbConnection } from "../types/db.js";
import { readSourcePaths } from "../lib/input-file.js";
import { findAudioFiles, isAudioFile } from "../lib/audio.js";
import {
  copyOrLink,
  ensureDir,
  pathExists,
  getFileSize,
  getStats,
  normalizePathResolved,
  remove,
} from "../lib/filesystem.js";
import { readRating, meetsThreshold } from "../lib/ratings.js";
import { formatSuffix } from "../lib/range.js";
import { convertFile, getConvertedFilename } from "../lib/convert.js";
import { calculateHash } from "../lib/integrity.js";
import { resolveOptionalScanAdapter } from "../lib/adapters/action-helpers.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { processInParallel } from "../lib/parallel.js";
import { CopyProgressBar, isProgressEnabled } from "../lib/progress-bar.js";
import {
  formatDryRun,
  isJsonMode,
  logDebug,
  logError,
  logInfo,
  logSuccess,
  logWarn,
} from "../lib/logger.js";
import { formatSyncSummaryTable } from "../lib/table-format.js";

/**
 * Copies or converts a single audio file based on options.
 *
 * @param source - Source file path
 * @param dest - Destination file path
 * @param hardlink - Whether to use hardlinks for copy
 * @param convertFormat - If set, convert to this format instead of copying
 * @returns 'converted' | 'hardlink' | 'copy' indicating the method used
 */
async function copyOrConvertFile(
  source: string,
  dest: string,
  hardlink: boolean,
  convertFormat?: ConvertFormat,
): Promise<"converted" | "hardlink" | "copy"> {
  if (convertFormat) {
    await convertFile(source, dest, convertFormat);
    return "converted";
  }
  const method = await copyOrLink(source, dest, hardlink);
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
 * Extract album name from a file path relative to source directory.
 *
 * @param filePath - Absolute path to the audio file
 * @param sourceDir - Base source directory path (artist folder)
 * @returns Album name or 'Unknown Album' if not in album subfolder
 */
function extractAlbumName(filePath: string, sourceDir: string): string {
  const relativePath = path.relative(sourceDir, filePath);
  const parts = relativePath.split(path.sep);

  // Expected structure: Album/track.ext or Album/subfolder/track.ext
  if (parts.length >= 2) {
    return parts[0] ?? "Unknown Album";
  }

  // Track directly in source folder (no album subfolder)
  return "Unknown Album";
}

/**
 * Builds the destination path for a file in filter mode.
 *
 * @param filePath - Source file path
 * @param source - Source directory
 * @param destination - Destination base directory
 * @param filter - Rating filter configuration
 * @param convertFormat - Optional conversion format
 * @param suffixNum - Optional suffix number for range mode
 * @returns Destination file path
 */
function buildFilterDestPath(
  filePath: string,
  source: string,
  destination: string,
  filter: RatingFilter,
  convertFormat?: ConvertFormat,
  suffixNum?: number | null,
): string {
  const artistName = path.basename(source);
  const albumName = extractAlbumName(filePath, source);
  const filename = path.basename(filePath);
  const destFilename = getDestFilename(filename, convertFormat);

  let destDir: string;
  if (filter.albumMode) {
    // Album mode: Artist/Album(-suffix)/
    const albumFolder =
      suffixNum !== null && suffixNum !== undefined
        ? `${albumName}-${formatSuffix(suffixNum, filter.range!.padWidth)}`
        : albumName;
    destDir = path.join(destination, artistName, albumFolder);
  } else if (filter.preserveStructure) {
    // Preserve structure: Artist/liked-songs/Album/
    destDir = path.join(destination, artistName, filter.outputFolder, albumName);
  } else {
    // Flat structure: Artist/liked-songs/
    destDir = path.join(destination, artistName, filter.outputFolder);
  }

  // Handle suffix for non-album mode
  if (!filter.albumMode && suffixNum !== null && suffixNum !== undefined) {
    const ext = path.extname(destFilename);
    const baseName = path.basename(destFilename, ext);
    return path.join(
      destDir,
      `${baseName}-${formatSuffix(suffixNum, filter.range!.padWidth)}${ext}`,
    );
  }

  return path.join(destDir, destFilename);
}

/**
 * Process a single file for sync - copy and record in inventory.
 *
 * @param filePath - Source file path
 * @param source - Source directory
 * @param destination - Destination directory
 * @param options - Copy options
 * @param inventoryContext - Inventory context
 * @param dryRun - Whether this is a dry run
 * @param classification - Inventory classification authorizing this write
 * @returns Object with success status and counts
 */
async function syncFile(
  filePath: string,
  source: string,
  destination: string,
  options: CopyOptions,
  inventoryContext: InventoryContext,
  dryRun: boolean,
  classification: "new" | "updated",
  signal?: AbortSignal,
  inProgressFiles?: Set<string>,
): Promise<{ success: boolean; created: number; skipped: number; error?: SyncFailedOperation }> {
  const result: {
    success: boolean;
    created: number;
    skipped: number;
    error?: SyncFailedOperation;
  } = {
    success: true,
    created: 0,
    skipped: 0,
  };

  interface PlannedDestination {
    destPath: string;
    destinationExists: boolean;
    stagePath: string;
    backupPath?: string;
    backupCreated: boolean;
    published: boolean;
  }

  const cleanupPath = async (candidate: string): Promise<void> => {
    try {
      await remove(candidate);
    } catch (cleanupError) {
      logWarn(
        `Failed to clean sync transaction file ${candidate}: ${(cleanupError as Error).message}`,
      );
    } finally {
      inProgressFiles?.delete(candidate);
    }
  };

  const cleanupPathForRollback = async (
    candidate: string,
    description: string,
  ): Promise<string | undefined> => {
    try {
      await remove(candidate);
      return undefined;
    } catch (cleanupError) {
      return `${description} ${candidate}: ${(cleanupError as Error).message}`;
    } finally {
      inProgressFiles?.delete(candidate);
    }
  };

  try {
    // Read rating for filter mode
    let rating: number | null = null;
    if (options.mode.type === "filter") {
      const ratingObj = await readRating(filePath);
      rating = ratingObj?.value ?? null;
    }

    // Determine how many copies to create based on mode
    let suffixes: Array<number | null>;
    if (options.mode.type === "filter" && options.mode.rating.range) {
      const range = options.mode.rating.range;
      suffixes = Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i);
    } else if (options.mode.type === "album") {
      const range = options.mode.range;
      suffixes = Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i);
    } else {
      suffixes = [null];
    }

    const destinationPaths: string[] = [];
    for (const suffixNum of suffixes) {
      let destPath: string;

      if (options.mode.type === "filter") {
        destPath = buildFilterDestPath(
          filePath,
          source,
          destination,
          options.mode.rating,
          options.convertFormat,
          suffixNum,
        );
      } else {
        // Album mode - simple Artist/Album(-suffix)/filename structure
        const artistName = path.basename(source);
        const albumName = extractAlbumName(filePath, source);
        const filename = path.basename(filePath);
        const destFilename = getDestFilename(filename, options.convertFormat);
        const range = options.mode.range;
        const albumFolder =
          suffixNum !== null && suffixNum !== undefined
            ? `${albumName}-${formatSuffix(suffixNum, range.padWidth)}`
            : albumName;
        destPath = path.join(destination, artistName, albumFolder, destFilename);
      }

      destinationPaths.push(destPath);
    }

    const destinationStates = await Promise.all(
      destinationPaths.map(async (destPath) => ({
        destPath,
        destinationExists: await pathExists(destPath),
      })),
    );

    if (
      classification === "new" &&
      !options.force &&
      destinationStates.some(({ destinationExists }) => destinationExists)
    ) {
      for (const { destPath, destinationExists } of destinationStates) {
        if (destinationExists) {
          logDebug(`Exists, skipping sync transaction: ${destPath}`);
        }
      }
      result.skipped = suffixes.length;
      return result;
    }

    if (dryRun) {
      for (const { destPath } of destinationStates) {
        const action = options.convertFormat ? `convert (${options.convertFormat})` : "copy";
        logInfo(formatDryRun(`${action} track: ${filePath} -> ${destPath}`));
        result.created++;
      }
      return result;
    }

    const transactionId = randomUUID();
    const plans: PlannedDestination[] = destinationStates.map(
      ({ destPath, destinationExists }, index) => {
        const extension = path.extname(destPath);
        const basename = path.basename(destPath, extension);
        const parent = path.dirname(destPath);
        return {
          destPath,
          destinationExists,
          stagePath: path.join(
            parent,
            `.${basename}.rfmedia-sync-stage-${transactionId}-${index}${extension}`,
          ),
          backupPath: destinationExists
            ? path.join(
                parent,
                `.${basename}.rfmedia-sync-backup-${transactionId}-${index}${extension}`,
              )
            : undefined,
          backupCreated: false,
          published: false,
        };
      },
    );

    try {
      for (const plan of plans) {
        if (signal?.aborted) {
          throw new Error("Operation cancelled");
        }

        await ensureDir(path.dirname(plan.destPath));
        inProgressFiles?.add(plan.stagePath);
      }

      for (const [index, plan] of plans.entries()) {
        const materializeSource = index === 0 ? filePath : plans[0]!.stagePath;
        let method: "copy" | "hardlink" | "converted";

        if (index === 0 && options.convertFormat && isAudioFile(filePath)) {
          await convertFile(filePath, plan.stagePath, options.convertFormat);
          method = "converted";
        } else {
          method = await copyOrLink(materializeSource, plan.stagePath, options.hardlink, signal);
        }

        const methodDesc =
          method === "converted"
            ? "Staged conversion"
            : method === "hardlink"
              ? "Staged link"
              : "Staged copy";
        logDebug(`${methodDesc}: ${materializeSource} -> ${plan.stagePath}`);
      }

      const representedPlan = plans[0]!;
      const stagedHashes: string[] = [];
      for (const plan of plans) {
        stagedHashes.push(await calculateHash(plan.stagePath));
      }
      const contentHash = stagedHashes[0]!;
      if (stagedHashes.some((hash) => hash !== contentHash)) {
        throw new Error("Staged sync destinations do not have identical content");
      }
      const entry = await createFileInventoryEntry(
        source,
        filePath,
        representedPlan.destPath,
        rating,
        contentHash,
      );

      for (const plan of plans) {
        if (signal?.aborted) {
          throw new Error("Operation cancelled");
        }
        if (plan.destinationExists && plan.backupPath) {
          await rename(plan.destPath, plan.backupPath);
          plan.backupCreated = true;
        }
        await rename(plan.stagePath, plan.destPath);
        plan.published = true;
        inProgressFiles?.delete(plan.stagePath);
      }

      await appendFileRecord(inventoryContext, source, entry);
      result.created = plans.length;

      for (const plan of plans) {
        if (plan.backupCreated && plan.backupPath) {
          await cleanupPath(plan.backupPath);
          plan.backupCreated = false;
        }
      }
    } catch (transactionError) {
      const rollbackErrors: string[] = [];
      for (const plan of [...plans].reverse()) {
        let publishedRemovalFailed = false;
        if (plan.published) {
          const cleanupError = await cleanupPathForRollback(
            plan.destPath,
            "Failed to remove published sync destination",
          );
          if (cleanupError) {
            rollbackErrors.push(cleanupError);
            publishedRemovalFailed = true;
          } else {
            plan.published = false;
          }
        }
        if (plan.backupCreated && plan.backupPath) {
          if (publishedRemovalFailed) {
            rollbackErrors.push(
              `Original sync destination retained at recovery path ${plan.backupPath}`,
            );
          } else {
            try {
              await rename(plan.backupPath, plan.destPath);
              plan.backupCreated = false;
            } catch (restoreError) {
              rollbackErrors.push(
                `Failed to restore sync destination ${plan.destPath} from ${plan.backupPath}: ${(restoreError as Error).message}`,
              );
            }
          }
        }
        const stageCleanupError = await cleanupPathForRollback(
          plan.stagePath,
          "Failed to remove staged sync destination",
        );
        if (stageCleanupError) rollbackErrors.push(stageCleanupError);
      }
      if (rollbackErrors.length > 0) {
        const transactionMessage =
          transactionError instanceof Error ? transactionError.message : String(transactionError);
        throw new Error(
          `${transactionMessage}; rollback incomplete: ${rollbackErrors.join("; ")}`,
          { cause: transactionError },
        );
      }
      throw transactionError;
    }
  } catch (err) {
    const error = err as Error;
    result.success = false;
    result.error = {
      sourcePath: filePath,
      message: error.message,
      code: (error as NodeJS.ErrnoException).code,
    };
    logWarn(`Failed to sync ${filePath}: ${error.message}`);
  }

  return result;
}

/**
 * Deletes downgraded files from the destination.
 *
 * Files are deleted when their rating falls below the threshold.
 * Only deletes files that actually exist; missing files are counted as already deleted.
 *
 * @param files - Array of downgraded file info
 * @param dryRun - Whether this is a dry run
 * @returns Object with deleted count and failed operations
 */
async function deleteDowngradedFiles(
  files: DowngradedFileInfo[],
  destination: string,
  dryRun: boolean,
): Promise<{ deleted: number; failed: SyncFailedOperation[] }> {
  let deleted = 0;
  const failed: SyncFailedOperation[] = [];

  for (const file of files) {
    const { destPath, relativePath, previousRating, currentRating } = file;

    try {
      const deletionTarget = await resolveDowngradeDeletionTarget(destination, destPath);
      if (deletionTarget === null) {
        logDebug(`Dest already deleted: ${relativePath}`);
        deleted++;
        continue;
      }

      if (dryRun) {
        const prevRatingStr = previousRating !== null ? (previousRating * 100).toFixed(0) : "null";
        const currRatingStr = currentRating !== null ? (currentRating * 100).toFixed(0) : "null";
        logInfo(
          formatDryRun(`delete (rating ${prevRatingStr}% -> ${currRatingStr}%): ${destPath}`),
        );
        deleted++;
      } else {
        await remove(deletionTarget);
        logDebug(`Deleted downgraded: ${destPath}`);
        deleted++;
      }
    } catch (err) {
      const error = err as Error;
      failed.push({
        sourcePath: relativePath,
        destPath,
        message: `Failed to delete: ${error.message}`,
        code: (error as NodeJS.ErrnoException).code,
      });
      logWarn(`Failed to delete ${destPath}: ${error.message}`);
    }
  }

  return { deleted, failed };
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

async function resolveDowngradeDeletionTarget(
  destination: string,
  persistedDestPath: string,
): Promise<string | null> {
  const requestedRoot = path.resolve(destination);
  const requestedTarget = path.resolve(persistedDestPath);

  if (!isContainedPath(requestedRoot, requestedTarget)) {
    throw new Error(
      `Downgrade destination is outside the selected destination: ${persistedDestPath}`,
    );
  }

  if (!(await pathExists(requestedTarget))) {
    return null;
  }

  const resolvedRoot = await normalizePathResolved(requestedRoot);
  const resolvedTarget = await normalizePathResolved(requestedTarget);
  if (!isContainedPath(resolvedRoot, resolvedTarget)) {
    throw new Error(`Downgrade destination escapes the selected destination: ${persistedDestPath}`);
  }

  const expectedResolvedTarget = path.join(
    resolvedRoot,
    path.relative(requestedRoot, requestedTarget),
  );
  if (resolvedTarget !== expectedResolvedTarget) {
    throw new Error(`Downgrade destination contains a symbolic link: ${persistedDestPath}`);
  }

  const targetStats = await getStats(resolvedTarget);
  if (!targetStats.isFile()) {
    throw new Error(`Downgrade destination is not a regular file: ${persistedDestPath}`);
  }

  return resolvedTarget;
}

/**
 * Execute sync for a single source in filter mode.
 *
 * @param source - Source directory path
 * @param destination - Destination directory
 * @param sourceInventory - Existing inventory for this source
 * @param options - Copy options
 * @param inventoryPath - Path to inventory file
 * @param deleteDowngraded - Whether to delete downgraded files
 * @returns Partial sync result for this source
 */
async function syncFilterSource(
  source: string,
  destination: string,
  sourceInventory: SourceInventory | undefined,
  options: CopyOptions,
  inventoryContext: InventoryContext,
  deleteDowngraded: boolean,
  signal?: AbortSignal,
  inProgressFiles?: Set<string>,
): Promise<{
  newCopied: number;
  updatedCopied: number;
  unchanged: number;
  deleted: number;
  failed: SyncFailedOperation[];
}> {
  const result = {
    newCopied: 0,
    updatedCopied: 0,
    unchanged: 0,
    deleted: 0,
    failed: [] as SyncFailedOperation[],
  };

  if (options.mode.type !== "filter") {
    throw new Error("syncFilterSource called with non-filter mode");
  }

  const filter = options.mode.rating;

  // Compute diff
  console.error(`Scanning ${path.basename(source)} for changes...`);
  const diff = await computeFilterSyncDiff(source, sourceInventory, filter, destination);

  // Log diff summary
  const totalChanges = diff.newFiles.length + diff.updatedFiles.length;
  const hasDowngrades = deleteDowngraded && diff.downgradedFiles.length > 0;
  if (!isJsonMode()) {
    console.error(`  New files: ${diff.newFiles.length}`);
    console.error(`  Rating changes: ${diff.updatedFiles.length}`);
    console.error(`  Unchanged: ${diff.unchangedFiles.length}`);
    if (diff.removedFiles.length > 0) {
      console.error(`  Removed from source: ${diff.removedFiles.length}`);
    }
    if (diff.downgradedFiles.length > 0) {
      if (deleteDowngraded) {
        console.error(`  Rating downgrades (to delete): ${diff.downgradedFiles.length}`);
      } else {
        console.error(`  Rating downgrades (skipping delete): ${diff.downgradedFiles.length}`);
      }
    }
  }

  if (totalChanges === 0 && !hasDowngrades) {
    result.unchanged = diff.unchangedFiles.length;
    return result;
  }

  // Record source scan time (before copying)
  if (!options.dryRun) {
    await appendSourceRecord(inventoryContext, source, Date.now());
  }

  // Process files to sync
  const filesToSync = [...diff.newFiles, ...diff.updatedFiles];

  // Progress tracking setup
  let progressBar: CopyProgressBar | null = null;
  if (!isJsonMode() && isProgressEnabled(options) && filesToSync.length > 0) {
    // Get total bytes for progress bar
    let totalBytes = 0;
    for (const filePath of filesToSync) {
      try {
        totalBytes += await getFileSize(filePath);
      } catch {
        // Ignore size read errors
      }
    }

    // Calculate total files including range copies
    const rangeCount = filter.range ? filter.range.end - filter.range.start + 1 : 1;
    const totalFiles = filesToSync.length * rangeCount;

    progressBar = new CopyProgressBar({
      totalFiles,
      totalBytes: totalBytes * rangeCount,
      operationName: path.basename(source),
      progress: options.progress,
    });
    progressBar.start();
  }

  try {
    // Process files
    for (const filePath of filesToSync) {
      const isNew = diff.newFiles.includes(filePath);
      const fileSize = await getFileSize(filePath).catch(() => 0);

      const syncResult = await syncFile(
        filePath,
        source,
        destination,
        options,
        inventoryContext,
        options.dryRun,
        isNew ? "new" : "updated",
        signal,
        inProgressFiles,
      );

      if (syncResult.success) {
        if (isNew) {
          result.newCopied += syncResult.created;
        } else {
          result.updatedCopied += syncResult.created;
        }
      } else if (syncResult.error) {
        result.failed.push(syncResult.error);
      }

      // Update progress
      progressBar?.updateFile(fileSize);
    }

    result.unchanged = diff.unchangedFiles.length;
  } finally {
    progressBar?.stop();
  }

  // Handle downgraded file deletions
  if (deleteDowngraded && diff.downgradedFiles.length > 0) {
    const deleteResult = await deleteDowngradedFiles(
      diff.downgradedFiles,
      destination,
      options.dryRun,
    );
    result.deleted = deleteResult.deleted;
    result.failed.push(...deleteResult.failed);
  }

  return result;
}

/**
 * Execute sync for a single source in album mode.
 *
 * @param source - Source directory path
 * @param destination - Destination directory
 * @param sourceInventory - Existing inventory for this source
 * @param options - Copy options
 * @param inventoryPath - Path to inventory file
 * @returns Partial sync result for this source
 */
async function syncAlbumSource(
  source: string,
  destination: string,
  sourceInventory: SourceInventory | undefined,
  options: CopyOptions,
  inventoryContext: InventoryContext,
  signal?: AbortSignal,
  inProgressFiles?: Set<string>,
): Promise<{
  newCopied: number;
  updatedCopied: number;
  unchanged: number;
  deleted: number;
  failed: SyncFailedOperation[];
}> {
  const result = {
    newCopied: 0,
    updatedCopied: 0,
    unchanged: 0,
    deleted: 0,
    failed: [] as SyncFailedOperation[],
  };

  if (options.mode.type !== "album") {
    throw new Error("syncAlbumSource called with non-album mode");
  }

  // Compute diff
  console.error(`Scanning ${path.basename(source)} for changes...`);
  const diff = await computeAlbumSyncDiff(source, sourceInventory, destination);

  // Log diff summary
  const totalChanges = diff.newFiles.length + diff.updatedFiles.length;
  if (!isJsonMode()) {
    console.error(`  New files: ${diff.newFiles.length}`);
    console.error(`  Missing dest: ${diff.updatedFiles.length}`);
    console.error(`  Unchanged: ${diff.unchangedFiles.length}`);
  }

  if (totalChanges === 0) {
    result.unchanged = diff.unchangedFiles.length;
    return result;
  }

  // Record source scan time
  if (!options.dryRun) {
    await appendSourceRecord(inventoryContext, source, Date.now());
  }

  // Process files to sync
  const filesToSync = [...diff.newFiles, ...diff.updatedFiles];

  // Progress tracking setup
  let progressBar: CopyProgressBar | null = null;
  if (!isJsonMode() && isProgressEnabled(options) && filesToSync.length > 0) {
    let totalBytes = 0;
    for (const filePath of filesToSync) {
      try {
        totalBytes += await getFileSize(filePath);
      } catch {
        // Ignore size read errors
      }
    }

    const range = options.mode.range;
    const rangeCount = range.end - range.start + 1;
    const totalFiles = filesToSync.length * rangeCount;

    progressBar = new CopyProgressBar({
      totalFiles,
      totalBytes: totalBytes * rangeCount,
      operationName: path.basename(source),
      progress: options.progress,
    });
    progressBar.start();
  }

  try {
    for (const filePath of filesToSync) {
      const isNew = diff.newFiles.includes(filePath);
      const fileSize = await getFileSize(filePath).catch(() => 0);

      const syncResult = await syncFile(
        filePath,
        source,
        destination,
        options,
        inventoryContext,
        options.dryRun,
        isNew ? "new" : "updated",
        signal,
        inProgressFiles,
      );

      if (syncResult.success) {
        if (isNew) {
          result.newCopied += syncResult.created;
        } else {
          result.updatedCopied += syncResult.created;
        }
      } else if (syncResult.error) {
        result.failed.push(syncResult.error);
      }

      progressBar?.updateFile(fileSize);
    }

    result.unchanged = diff.unchangedFiles.length;
  } finally {
    progressBar?.stop();
  }

  return result;
}

/**
 * Execute sync command with file-based input.
 *
 * Reads source paths from the input file, loads or creates the inventory,
 * and syncs each source incrementally.
 *
 * @param destination - Destination directory
 * @param options - Sync options
 * @returns Sync result with counts and failures
 */
export async function executeSyncWithFileInput(
  destination: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const { copyOptions, dryRun, force, resetInventory: shouldReset } = options;

  // Determine source entries from --paths (cliSourceEntries) or --file
  let sourceEntries: PathEntry[];
  let inputFile: string;

  if (copyOptions.cliSourceEntries && copyOptions.cliSourceEntries.length > 0) {
    // Use source entries from --paths option
    sourceEntries = copyOptions.cliSourceEntries;
    inputFile = "yaml-paths"; // Placeholder for inventory identification
    logInfo(`Processing ${sourceEntries.length} source path(s) from --paths`);

    // Log paths with per-source options for clarity
    for (const entry of sourceEntries) {
      const extras: string[] = [];
      if (entry.filterName) extras.push(`filter: ${entry.filterName}`);
      if (entry.outputFolder) extras.push(`outputFolder: ${entry.outputFolder}`);
      if (entry.convertFormat) extras.push(`convert: ${entry.convertFormat}`);
      if (extras.length > 0) {
        logDebug(`  ${entry.path} (${extras.join(", ")})`);
      }
    }
  } else if (copyOptions.file) {
    // Read source paths from file (logging suppressed)
    inputFile = copyOptions.file;
    sourceEntries = await readSourcePaths(inputFile);

    if (sourceEntries.length === 0) {
      throw new Error(`No source paths found in file: ${inputFile}`);
    }
  } else {
    throw new Error("Sync command requires either --file or --paths option");
  }

  // Sync doesn't use per-path ranges, extract just the paths
  const sourcePaths = sourceEntries.map((entry) => entry.path);

  const result: SyncResult = {
    inputFile,
    sourcesScanned: 0,
    newFilesCopied: 0,
    updatedFilesCopied: 0,
    unchangedFilesSkipped: 0,
    deletedFiles: 0,
    failedFiles: 0,
    failed: [],
  };
  let completedSourceCount = 0;
  let failedSourceCount = 0;

  // Initialize database for inventory (if not using legacy mode)
  const config = getLoadedConfig();
  const useLegacy = options.copyOptions.useLegacyTracking ?? config?.tracking?.useLegacy ?? false;
  let db: DbConnection | undefined;
  let operationId: number | undefined;

  if (!useLegacy && !dryRun) {
    const dbPath = options.copyOptions.trackingDatabase ?? config?.tracking?.database;
    db = await initializeDatabase(dbPath);
  }

  let databaseClosed = false;
  const closeOwnedDatabase = (): void => {
    if (db && !databaseClosed) {
      databaseClosed = true;
      closeDatabase(db);
    }
  };
  const registeredCleanupNames: string[] = [];
  let unregisterCleanup: ((name: string) => void) | undefined;
  let processingStarted = false;
  let executionError: unknown;

  try {
    if (db) {
      // Create operation for sync
      const hash = buildInventoryOptionsHash(copyOptions);
      const hashStr = formatInventoryOptionsHash(hash);

      operationId = createOperation(db, {
        command: "sync",
        mode: copyOptions.mode.type,
        inputFile,
        optionsHash: hashStr,
        ratingKey: hash.ratingKey ?? null,
        rangeKey: hash.rangeKey ?? null,
        convertKey: hash.convertKey ?? null,
      });
    }

    // Resolve inventory path
    const inventoryPath = resolveInventoryPath(inputFile, copyOptions);
    logDebug(`Inventory file: ${inventoryPath}`);

    // Build inventory context
    const inventoryContext: InventoryContext = {
      inventoryPath,
      db,
      operationId,
    };

    // Reset inventory if requested
    if (shouldReset && !dryRun) {
      await resetInventory(inventoryContext);
    }

    // Load or initialize inventory
    let inventory: LoadedInventory;
    if (db && operationId !== undefined) {
      // Database mode - always load from database
      inventory = await loadInventory(inventoryContext);
    } else if (await pathExists(inventoryPath)) {
      inventory = await loadInventory(inventoryContext);
    } else {
      inventory = new Map();
      if (!dryRun) {
        await initializeInventory(inventoryContext, inputFile, copyOptions);
      }
    }

    // Setup graceful interruption
    const { getGlobalSignal, registerGlobalCleanup, unregisterGlobalCleanup } =
      await import("../lib/signal-handler.js");
    unregisterCleanup = unregisterGlobalCleanup;
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
      name: "sync-abort",
      cleanup: () => {
        if (!localAbortController.signal.aborted) {
          localAbortController.abort();
        }
      },
    });
    registeredCleanupNames.push("sync-abort");

    registerGlobalCleanup({
      priority: 15,
      name: "sync-partial-files",
      cleanup: async () => {
        const { cleanupPartialFile } = await import("../lib/filesystem.js");
        for (const filePath of inProgressFiles) {
          await cleanupPartialFile(filePath);
        }
      },
    });
    registeredCleanupNames.push("sync-partial-files");

    // Note: Inventory is persisted incrementally during sync via createFileInventoryEntry(),
    // so no explicit save/flush is needed in cleanup handler

    if (db) {
      registerGlobalCleanup({
        priority: 70,
        name: "sync-database",
        cleanup: closeOwnedDatabase,
      });
      registeredCleanupNames.push("sync-database");
    }

    processingStarted = true;
    // Process each source
    for (const sourcePath of sourcePaths) {
      result.sourcesScanned++;

      // Validate source exists
      if (!(await pathExists(sourcePath))) {
        result.failed.push({
          sourcePath,
          message: "Source directory does not exist",
          code: "ENOENT",
        });
        result.failedFiles++;
        failedSourceCount++;
        continue;
      }

      const sourceInventory = inventory.get(sourcePath);

      try {
        let sourceResult: {
          newCopied: number;
          updatedCopied: number;
          unchanged: number;
          deleted: number;
          failed: SyncFailedOperation[];
        };

        if (copyOptions.mode.type === "filter") {
          sourceResult = await syncFilterSource(
            sourcePath,
            destination,
            sourceInventory,
            { ...copyOptions, dryRun, force },
            inventoryContext,
            options.deleteDowngraded,
            localAbortController.signal,
            inProgressFiles,
          );
        } else {
          sourceResult = await syncAlbumSource(
            sourcePath,
            destination,
            sourceInventory,
            { ...copyOptions, dryRun, force },
            inventoryContext,
            localAbortController.signal,
            inProgressFiles,
          );
        }

        result.newFilesCopied += sourceResult.newCopied;
        result.updatedFilesCopied += sourceResult.updatedCopied;
        result.unchangedFilesSkipped += sourceResult.unchanged;
        result.deletedFiles += sourceResult.deleted;
        result.failedFiles += sourceResult.failed.length;
        result.failed.push(...sourceResult.failed);
        if (sourceResult.failed.length > 0) {
          failedSourceCount++;
        } else {
          completedSourceCount++;
        }
      } catch (err) {
        const error = err as Error;
        logError(`Failed to process source: ${sourcePath}`);
        logError(`  ${error.message}`);
        result.failed.push({
          sourcePath,
          message: error.message,
        });
        result.failedFiles++;
        failedSourceCount++;
      }

      // Processing complete for this source
    }

    // Log summary
    console.error("");
    console.error(dryRun ? "Sync Preview (Dry-Run)" : "Sync Summary");
    console.error("");

    const summaryOutput = formatSyncSummaryTable({
      sourcesScanned: result.sourcesScanned,
      newFilesCopied: result.newFilesCopied,
      updatedFilesCopied: result.updatedFilesCopied,
      unchangedSkipped: result.unchangedFilesSkipped,
      deletedFiles: result.deletedFiles,
      failedFiles: result.failedFiles,
    });

    console.error(summaryOutput);
    console.error("");

    // Trigger scan if configured.
    // Use path-based scanning for more efficient scans on just the destination folder.
    const { adapter: mediaServerAdapter } = resolveOptionalScanAdapter({
      plexUrl: copyOptions.plexUrl,
      plexToken: copyOptions.plexToken,
      plexLibrary: copyOptions.plexLibrary,
      plexScan: copyOptions.plexScan,
      plexPerSource: copyOptions.plexPerSource,
    });

    if (
      mediaServerAdapter?.capabilities.scan &&
      !dryRun &&
      (result.newFilesCopied > 0 || result.updatedFilesCopied > 0)
    ) {
      console.error("");
      const scanResult = await mediaServerAdapter.scan.triggerSource(destination);
      if (scanResult.success) {
        logSuccess(`Plex library scan triggered: ${scanResult.libraryName ?? destination}`);
      } else {
        logWarn(`Plex scan failed: ${scanResult.message}`);
      }
    } else if (mediaServerAdapter?.capabilities.scan && dryRun) {
      console.error("");
      console.error(formatDryRun(`trigger Plex scan for: ${destination}`));
    }

    return result;
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    let finalizationError: unknown;
    try {
      if (unregisterCleanup) {
        for (const cleanupName of registeredCleanupNames) {
          unregisterCleanup(cleanupName);
        }
      }

      if (db && !databaseClosed && operationId !== undefined && processingStarted) {
        const status: "completed" | "failed" | "partial" =
          failedSourceCount > 0 ? (completedSourceCount > 0 ? "partial" : "failed") : "completed";

        updateOperationCounts(db, operationId, {
          totalSources: result.sourcesScanned,
          completedCount: completedSourceCount,
          failedCount: failedSourceCount,
        });
        updateOperationStatus(db, operationId, status);
        logDebug(`Updated operation #${operationId} status to: ${status}`);
      }
    } catch (error) {
      finalizationError = error;
    }

    try {
      closeOwnedDatabase();
    } catch (error) {
      finalizationError ??= error;
    }

    if (finalizationError) {
      if (executionError) {
        logWarn(`Sync finalization also failed: ${(finalizationError as Error).message}`);
      } else {
        throw finalizationError;
      }
    }
  }
}
