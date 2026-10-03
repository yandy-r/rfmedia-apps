/**
 * Watch mode action for rfmedia CLI.
 *
 * Monitors directories for new content and auto-processes using existing
 * copy logic (album or filter mode). Uses chokidar for cross-platform
 * file watching with debouncing to handle rapid file additions.
 */

import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";

import { isAudioFile } from "../lib/audio.js";
import { pathExists } from "../lib/filesystem.js";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "../lib/logger.js";
import { resolveOptionalScanAdapter } from "../lib/adapters/action-helpers.js";
import type {
  WatchOptions,
  WatchProcessResult,
  CopyOptions,
  CopyMode,
  RatingFilter,
  CopyResult,
} from "../types/index.js";
import { IGNORED_EXTENSIONS } from "../types/index.js";

/**
 * Checks if a file path has an ignored extension (partial downloads, temp files).
 *
 * @param filePath - Path to check
 * @returns true if the file should be ignored
 */
function isIgnoredFile(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return IGNORED_EXTENSIONS.some((ext) => lowerPath.endsWith(ext));
}

/**
 * Determines the content type and path to process based on a detected change.
 *
 * The logic determines what level to process:
 * - If a new file is added to an existing album, process the album
 * - If a new album folder is added, process the album
 * - If a new artist folder is added, process the artist (all albums)
 *
 * @param changedPath - Path that triggered the change
 * @param sourceDir - Base source directory being watched
 * @returns Object with type and path to process, or null if should be ignored
 */
async function determineProcessTarget(
  changedPath: string,
  sourceDir: string,
): Promise<{ type: "artist" | "album" | "file"; path: string } | null> {
  const relativePath = path.relative(sourceDir, changedPath);
  const parts = relativePath.split(path.sep);

  // Filter out ignored files
  if (isIgnoredFile(changedPath)) {
    logDebug(`Ignoring partial/temp file: ${changedPath}`);
    return null;
  }

  // Check if it's a file and filter non-audio files
  try {
    const stats = await stat(changedPath);
    if (stats.isFile() && !isAudioFile(changedPath)) {
      logDebug(`Ignoring non-audio file: ${changedPath}`);
      return null;
    }
  } catch {
    // Path may have been deleted, ignore
    return null;
  }

  // Determine depth relative to source
  // Source/Artist/Album/file.flac -> 3 parts (artist, album, file)
  // Source/Artist/Album -> 2 parts (artist, album)
  // Source/Artist -> 1 part (artist)

  if (parts.length === 0 || parts[0] === "") {
    // Change is at source level itself, ignore
    return null;
  }

  if (parts.length === 1) {
    // New artist folder added
    const artistPath = path.join(sourceDir, parts[0]!);
    return { type: "artist", path: artistPath };
  }

  if (parts.length === 2) {
    // New album folder or file directly in artist folder
    const albumPath = path.join(sourceDir, parts[0]!, parts[1]!);
    try {
      const stats = await stat(albumPath);
      if (stats.isDirectory()) {
        return { type: "album", path: albumPath };
      }
    } catch {
      // Might be a file, treat parent as artist
      const artistPath = path.join(sourceDir, parts[0]!);
      return { type: "artist", path: artistPath };
    }
    return { type: "album", path: albumPath };
  }

  // Deeper paths (files in albums or subdirectories)
  // Process at album level
  const albumPath = path.join(sourceDir, parts[0]!, parts[1]!);
  return { type: "album", path: albumPath };
}

/**
 * Builds CopyOptions for album mode from WatchOptions.
 */
function buildAlbumCopyOptions(watchOptions: WatchOptions, albumOnly: boolean): CopyOptions {
  if (!watchOptions.range) {
    throw new Error("Album mode requires range option");
  }

  const mode: CopyMode = {
    type: "album",
    range: watchOptions.range,
  };

  return {
    mode,
    albumOnly,
    hardlink: watchOptions.hardlink ?? false,
    force: false,
    dryRun: false,
    workers: 1,
  };
}

/**
 * Builds CopyOptions for filter mode from WatchOptions.
 */
function buildFilterCopyOptions(watchOptions: WatchOptions): CopyOptions {
  const rating: RatingFilter = {
    minStars: watchOptions.minStars,
    minRating: watchOptions.minRating,
    outputFolder: watchOptions.outputFolder ?? "liked-songs",
    preserveStructure: watchOptions.preserveStructure ?? false,
  };

  const mode: CopyMode = {
    type: "filter",
    rating,
  };

  return {
    mode,
    albumOnly: false,
    hardlink: watchOptions.hardlink ?? false,
    force: false,
    dryRun: false,
    workers: 1,
  };
}

/**
 * Processes detected changes using the appropriate copy mode.
 *
 * @param targetType - Type of content to process (artist/album/file)
 * @param targetPath - Path to process
 * @param destination - Destination directory
 * @param watchOptions - Watch mode options
 * @returns Processing result
 */
export async function processChange(
  targetType: "artist" | "album" | "file",
  targetPath: string,
  destination: string,
  watchOptions: WatchOptions,
): Promise<WatchProcessResult> {
  const result: WatchProcessResult = {
    type: targetType,
    path: targetPath,
    created: 0,
    skipped: 0,
    filtered: 0,
  };

  try {
    let copyResult: CopyResult;

    if (watchOptions.mode === "album") {
      const { executeAlbumCopy } = await import("./copy-album.js");

      // Determine if we should treat as album-only based on target type
      const albumOnly = targetType === "album" || watchOptions.albumOnly === true;
      const copyOptions = buildAlbumCopyOptions(watchOptions, albumOnly);

      copyResult = await executeAlbumCopy(targetPath, destination, copyOptions);
    } else {
      const { executeFilterCopy } = await import("./copy-filter.js");
      const copyOptions = buildFilterCopyOptions(watchOptions);

      copyResult = await executeFilterCopy(targetPath, destination, copyOptions);
    }

    result.created = copyResult.created;
    result.skipped = copyResult.skipped;
    result.filtered = copyResult.filtered;

    // Trigger Plex scan after successful copy if configured
    // Use path-based scanning for more efficient scans on just the destination folder
    if (result.created > 0 && watchOptions.plexScan !== false) {
      const { adapter: mediaServerAdapter } = resolveOptionalScanAdapter({
        plexScan: watchOptions.plexScan,
      });

      if (mediaServerAdapter?.capabilities.scan) {
        // Determine the destination path for the scan
        // For artist/album mode, the destination is the artist folder in the destination root
        const artistName = path.basename(targetPath);
        const destPath = path.join(destination, artistName);

        // Use path-based scan for the specific destination folder
        const scanResult = await mediaServerAdapter.scan.triggerSource(destPath);
        if (scanResult.success) {
          logSuccess(`Plex scan triggered for: ${destPath}`);
        } else {
          logWarn(`Plex scan failed: ${scanResult.message}`);
        }
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logError(`Failed to process ${targetPath}: ${result.error}`);
  }

  return result;
}

/**
 * Executes watch mode operation.
 *
 * Sets up a file system watcher on the source directory and processes
 * new content as it arrives, using debouncing to batch rapid changes.
 *
 * @param options - Watch mode options
 */
export async function executeWatch(options: WatchOptions): Promise<void> {
  const { source, destination, debounceMs = 5000 } = options;

  // Validate source directory exists
  if (!(await pathExists(source))) {
    throw new Error(`Source directory does not exist: ${source}`);
  }

  // Validate destination directory exists
  if (!(await pathExists(destination))) {
    throw new Error(`Destination directory does not exist: ${destination}`);
  }

  logInfo(`Watch mode starting...`);
  logInfo(`  Source: ${source}`);
  logInfo(`  Destination: ${destination}`);
  logInfo(`  Mode: ${options.mode}`);
  logInfo(`  Debounce: ${debounceMs}ms`);

  if (options.mode === "album" && options.range) {
    const { start, end, padWidth } = options.range;
    const startStr = String(start).padStart(padWidth, "0");
    const endStr = String(end).padStart(padWidth, "0");
    logInfo(`  Range: ${startStr}-${endStr}`);
  }

  if (options.mode === "filter") {
    if (options.minStars !== undefined) {
      logInfo(`  Min stars: ${options.minStars}`);
    }
    if (options.minRating !== undefined) {
      logInfo(`  Min rating: ${options.minRating}%`);
    }
    logInfo(`  Output folder: ${options.outputFolder ?? "liked-songs"}`);
  }

  if (options.hardlink) {
    logInfo(`  Using hardlinks`);
  }

  // Check if scan integration is configured
  const { adapter: mediaServerAdapter, libraryName } = resolveOptionalScanAdapter({
    plexScan: options.plexScan,
  });
  if (mediaServerAdapter) {
    logInfo(`  Plex scan: enabled (${libraryName ?? "all libraries"})`);
  }

  logInfo("");
  logSuccess(`Watching ${source} for changes...`);
  logInfo("Press Ctrl+C to stop");
  logInfo("");

  // Track pending changes with debounce timers
  // Key: parent directory path, Value: timeout handle
  const pendingPaths = new Map<string, NodeJS.Timeout>();

  // Track paths currently being processed to avoid duplicate processing
  const processingPaths = new Set<string>();

  // Set up the file watcher
  const watcher: FSWatcher = watch(source, {
    persistent: true,
    ignoreInitial: true, // Don't process existing files
    depth: 10, // Watch nested directories
    awaitWriteFinish: {
      stabilityThreshold: 2000, // Wait for file to be stable
      pollInterval: 100,
    },
  });

  /**
   * Schedules processing for a changed path after debounce delay.
   */
  const scheduleProcessing = async (changedPath: string): Promise<void> => {
    const target = await determineProcessTarget(changedPath, source);
    if (!target) {
      return;
    }

    const { type, path: targetPath } = target;

    // Skip if already being processed
    if (processingPaths.has(targetPath)) {
      logDebug(`Already processing: ${targetPath}`);
      return;
    }

    // Clear existing timeout for this path
    if (pendingPaths.has(targetPath)) {
      clearTimeout(pendingPaths.get(targetPath)!);
    }

    logDebug(`Scheduling processing for: ${targetPath} (${type})`);

    // Set new timeout
    const timeoutId = setTimeout(async () => {
      pendingPaths.delete(targetPath);

      // Double-check not already processing
      if (processingPaths.has(targetPath)) {
        return;
      }

      processingPaths.add(targetPath);

      const typeName = type === "artist" ? "artist folder" : type === "album" ? "album" : "file";
      logInfo(`Detected new ${typeName}: ${path.basename(targetPath)}`);
      logInfo(`Processing...`);

      try {
        const result = await processChange(type, targetPath, destination, options);

        if (result.error) {
          logError(`Processing failed: ${result.error}`);
        } else {
          logSuccess(`Completed: ${result.created} created, ${result.skipped} skipped`);
          if (options.mode === "filter" && result.filtered > 0) {
            logInfo(`  Filtered: ${result.filtered} tracks below threshold`);
          }
        }
      } finally {
        processingPaths.delete(targetPath);
      }

      logInfo("");
      logInfo("Watching for more changes...");
    }, debounceMs);

    pendingPaths.set(targetPath, timeoutId);
  };

  // Watch for file additions
  watcher.on("add", (filePath: string) => {
    logDebug(`File added: ${filePath}`);
    void scheduleProcessing(filePath);
  });

  // Watch for directory additions
  watcher.on("addDir", (dirPath: string) => {
    // Skip the source directory itself
    if (dirPath === source) {
      return;
    }
    logDebug(`Directory added: ${dirPath}`);
    void scheduleProcessing(dirPath);
  });

  // Handle watcher errors
  watcher.on("error", (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logError(`Watcher error: ${message}`);
  });

  // Handle ready event
  watcher.on("ready", () => {
    logDebug("Watcher ready");
  });

  // Graceful shutdown on SIGINT (Ctrl+C)
  const cleanup = async (): Promise<void> => {
    logInfo("");
    logInfo("Stopping watch mode...");

    // Clear all pending timeouts
    for (const [, timeoutId] of pendingPaths) {
      clearTimeout(timeoutId);
    }
    pendingPaths.clear();

    // Close the watcher
    await watcher.close();

    logSuccess("Watch mode stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void cleanup();
  });

  process.on("SIGTERM", () => {
    void cleanup();
  });

  // Keep the process running
  // The watcher will keep the event loop alive
  await new Promise<void>(() => {
    // This promise never resolves - the process runs until SIGINT/SIGTERM
  });
}
