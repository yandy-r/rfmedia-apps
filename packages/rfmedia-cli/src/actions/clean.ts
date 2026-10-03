/**
 * Clean action for rfmedia CLI.
 *
 * Provides functionality to detect and remove empty album and artist folders
 * from a music directory.
 */

import { readdir, stat } from "node:fs/promises";
import path, { join } from "node:path";

import pc from "picocolors";

import { findAudioFilesInDir } from "../lib/audio.js";
import { moveToTrash, normalizePath, pathExists, remove } from "../lib/filesystem.js";
import { createHistorySession, isHistoryEnabled, type HistoryRecorder } from "../lib/history.js";
import {
  formatDryRun,
  isJsonMode,
  logDebug,
  logError,
  logInfo,
  logSuccess,
  logWarn,
} from "../lib/logger.js";
import { matchesAnyPattern, readProtectionPatterns } from "../lib/patterns.js";
import { runTasks } from "../lib/progress.js";
import { confirm } from "../lib/prompt.js";
import type { CleanOptions } from "../types/options.js";
import type { CleanResult, FailedOperation } from "../types/results.js";

/**
 * Options for the findEmptyAlbums function.
 */
interface FindEmptyAlbumsOptions {
  /** Only consider albums not modified in the past N days */
  olderThan?: number;
  /** Glob patterns to exclude from deletion */
  exclude?: string[];
  /** Path to file containing patterns to protect from deletion */
  protect?: string;
  /** Maximum directory depth to scan (default: 2, 0 for unlimited) */
  depth?: number;
}

/**
 * Gets the most recent mtime of any audio file in an album directory.
 *
 * @param albumPath - Path to the album directory
 * @returns Date of most recent modification, or undefined if no audio files
 */
async function getAlbumLastModified(albumPath: string): Promise<Date | undefined> {
  const audioFiles = await findAudioFilesInDir(albumPath);
  if (audioFiles.length === 0) return undefined;

  let latestMtime: Date | undefined;
  for (const file of audioFiles) {
    const filePath = join(albumPath, file);
    const stats = await stat(filePath);
    if (!latestMtime || stats.mtime > latestMtime) {
      latestMtime = stats.mtime;
    }
  }
  return latestMtime;
}

/**
 * Checks if an album is older than the specified number of days.
 *
 * @param lastModified - Most recent modification date of album files
 * @param days - Number of days threshold
 * @returns true if album should be considered for deletion
 */
function isAlbumOlderThan(lastModified: Date | undefined, days: number): boolean {
  if (!lastModified) return true; // No audio files = can delete
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  return lastModified < cutoffDate;
}

/**
 * Checks if a directory is an empty leaf (no audio files) and passes the age filter.
 * Returns the normalized path if it should be collected, or null otherwise.
 */
async function checkEmptyLeaf(
  fullPath: string,
  options: { olderThan?: number },
): Promise<string | null> {
  const audioFiles = await findAudioFilesInDir(fullPath);
  if (audioFiles.length !== 0) {
    logDebug(`Directory has ${audioFiles.length} audio file(s): ${fullPath}`);
    return null;
  }
  if (options.olderThan !== undefined) {
    const lastModified = await getAlbumLastModified(fullPath);
    if (!isAlbumOlderThan(lastModified, options.olderThan)) {
      logDebug(`Protected (recently modified): ${fullPath}`);
      return null;
    }
  }
  return normalizePath(fullPath);
}

/**
 * Recursively scans directories for empty leaf directories up to a maximum depth.
 *
 * A directory is considered a "leaf" when it has no subdirectory children or
 * when the current depth has reached maxDepth (and maxDepth is not 0).
 * Leaf directories are checked for audio files via findAudioFilesInDir().
 * If empty, the optional olderThan filter is applied before adding to the result.
 *
 * @param dir - The directory to scan
 * @param currentDepth - Current recursion depth (starts at 0)
 * @param maxDepth - Maximum depth to recurse (0 = unlimited)
 * @param options - Scanning options including protection patterns and age filter
 * @returns Array of absolute paths to empty directories
 */
async function scanDirectoryForEmpty(
  dir: string,
  currentDepth: number,
  maxDepth: number,
  options: {
    protectionPatterns: string[];
    musicDir: string;
    olderThan?: number;
  },
): Promise<string[]> {
  const emptyDirs: string[] = [];

  const isUnlimitedDepth = maxDepth === 0;

  // Read directory entries
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    logDebug(`Failed to read directory: ${dir}`);
    return emptyDirs;
  }

  // Filter to directory entries only
  const subdirs = entries.filter((entry) => entry.isDirectory());

  for (const entry of subdirs) {
    const fullPath = join(dir, entry.name);

    // Check protection patterns -- skip if protected
    if (options.protectionPatterns.length > 0) {
      if (matchesAnyPattern(fullPath, options.protectionPatterns, options.musicDir)) {
        logDebug(`Protected (pattern match): ${fullPath}`);
        continue;
      }
    }

    // Determine if we should recurse deeper
    if (isUnlimitedDepth || currentDepth < maxDepth) {
      // Check if this subdirectory itself has subdirectory children
      let childEntries;
      try {
        childEntries = await readdir(fullPath, { withFileTypes: true });
      } catch (err) {
        logDebug(`Failed to read directory: ${fullPath}`);
        continue;
      }

      const childSubdirs = childEntries.filter((e) => e.isDirectory());

      if (childSubdirs.length > 0 && (isUnlimitedDepth || currentDepth + 1 < maxDepth)) {
        // Has subdirectory children and we can go deeper -- recurse
        const childResults = await scanDirectoryForEmpty(
          fullPath,
          currentDepth + 1,
          maxDepth,
          options,
        );
        emptyDirs.push(...childResults);
      } else {
        // Leaf directory: no subdirectory children or at max depth
        const normalizedPath = await checkEmptyLeaf(fullPath, options);
        if (normalizedPath !== null) {
          emptyDirs.push(normalizedPath);
          logDebug(`Empty directory found: ${normalizedPath}`);
        }
      }
    } else {
      // At max depth -- treat as leaf
      const normalizedPath = await checkEmptyLeaf(fullPath, options);
      if (normalizedPath !== null) {
        emptyDirs.push(normalizedPath);
        logDebug(`Empty directory found: ${normalizedPath}`);
      }
    }
  }

  return emptyDirs;
}

/**
 * Finds all empty album folders in a music directory.
 *
 * Scans the directory structure up to the configured depth (default: 2 levels
 * for backward-compatible Artist/Album scanning). A directory is considered
 * "empty" if it contains no audio files directly in the folder (non-recursive check).
 *
 * @param musicDir - The root music directory to scan
 * @param options - Optional settings including depth, age filter, and protection patterns
 * @returns Array of absolute paths to empty directories
 */
export async function findEmptyAlbums(
  musicDir: string,
  options?: FindEmptyAlbumsOptions,
): Promise<string[]> {
  const normalizedMusicDir = normalizePath(musicDir);
  const maxDepth = options?.depth ?? 2;

  logInfo(`Scanning for empty album folders in: ${normalizedMusicDir}`);

  // Verify music directory exists
  if (!(await pathExists(normalizedMusicDir))) {
    logDebug(`Music directory does not exist: ${normalizedMusicDir}`);
    return [];
  }

  // Build combined protection patterns from --exclude and --protect options
  let protectionPatterns: string[] = [...(options?.exclude ?? [])];

  // Load patterns from protection file if specified
  if (options?.protect) {
    try {
      const filePatterns = await readProtectionPatterns(options.protect);
      protectionPatterns = [...protectionPatterns, ...filePatterns];
      logInfo(`Loaded ${filePatterns.length} protection pattern(s) from ${options.protect}`);
    } catch (err) {
      const error = err as Error;
      logWarn(`Failed to read protection file: ${options.protect} - ${error.message}`);
    }
  }

  if (protectionPatterns.length > 0) {
    logDebug(`Active protection patterns: ${protectionPatterns.join(", ")}`);
  }

  // Delegate to recursive scanning helper
  const emptyAlbums = await scanDirectoryForEmpty(normalizedMusicDir, 0, maxDepth, {
    protectionPatterns,
    musicDir: normalizedMusicDir,
    olderThan: options?.olderThan,
  });

  logInfo(`Found ${emptyAlbums.length} empty album folder(s)`);
  return emptyAlbums;
}

/**
 * Finds all parent directories that will become empty after leaf directory deletion.
 *
 * Performs a bottom-up predictive cascade: starting from the set of empty leaf
 * directories (from `findEmptyAlbums()`), this function determines which parent
 * directories will also become empty once their children are deleted. The cascade
 * propagates upward through arbitrary depth levels, stopping at the music directory
 * root or when a parent has non-deleted children.
 *
 * This is PREDICTIVE -- it predicts which parents WILL become empty after deletions.
 * It does NOT rely on post-deletion filesystem state. This is essential because the
 * preview/confirmation step happens before any deletions.
 *
 * A parent is considered "will become empty" when all of its subdirectory children
 * are in the deletion set. Non-directory entries (loose files) are ignored.
 *
 * @param musicDir - The root music directory (never deleted)
 * @param emptyAlbums - Array of leaf directory paths that will be deleted
 * @param protectionPatterns - Optional glob patterns; matching parents are skipped
 * @returns Array of parent paths that will become empty after leaf deletion
 */
export async function findEmptyArtists(
  musicDir: string,
  emptyAlbums: string[],
  protectionPatterns?: string[],
): Promise<string[]> {
  const emptyParents: string[] = [];
  const normalizedMusicDir = normalizePath(musicDir);

  // Build a Set of all directories marked for deletion (starts with emptyAlbums)
  const deletionSet = new Set(emptyAlbums);

  logDebug(`Checking for parent directories that will become empty after deletion`);
  logDebug(`Empty directories to delete: ${emptyAlbums.length}`);

  // Verify music directory exists
  if (!(await pathExists(normalizedMusicDir))) {
    logDebug(`Music directory does not exist: ${normalizedMusicDir}`);
    return emptyParents;
  }

  // Fixed-point iteration: cascade upward until no new parents are added
  let changed = true;
  while (changed) {
    changed = false;

    // Extract unique candidate parent directories from the current deletion set
    const candidateParents = new Set<string>();
    for (const dir of deletionSet) {
      const parent = normalizePath(path.dirname(dir));
      if (parent !== normalizedMusicDir && !deletionSet.has(parent)) {
        candidateParents.add(parent);
      }
    }

    // Sort by path depth descending (deepest first) for correct cascade propagation
    const sortedParents = [...candidateParents].sort(
      (a, b) => b.split(path.sep).length - a.split(path.sep).length,
    );

    for (const parent of sortedParents) {
      // Check protection patterns -- skip if protected
      if (protectionPatterns && protectionPatterns.length > 0) {
        if (matchesAnyPattern(parent, protectionPatterns, normalizedMusicDir)) {
          logDebug(`Protected parent (pattern match): ${parent}`);
          continue;
        }
      }

      // Read children of this parent directory
      let childEntries;
      try {
        childEntries = await readdir(parent, { withFileTypes: true });
      } catch (err) {
        logDebug(`Failed to read parent directory: ${parent}`);
        continue;
      }

      // Check if ALL child directories are in the deletion set
      const childDirs = childEntries.filter((entry) => entry.isDirectory());

      // A parent with no subdirectory children cannot cascade (nothing to check)
      if (childDirs.length === 0) {
        continue;
      }

      const allChildDirsInSet = childDirs.every((entry) => {
        const childPath = normalizePath(join(parent, entry.name));
        return deletionSet.has(childPath);
      });

      if (allChildDirsInSet) {
        deletionSet.add(parent);
        emptyParents.push(parent);
        changed = true;
        logDebug(`Parent will be empty: ${parent}`);
      } else {
        logDebug(`Parent has remaining children: ${parent}`);
      }
    }
  }

  if (emptyParents.length > 0) {
    logInfo(`Found ${emptyParents.length} parent folder(s) that will become empty`);
  }

  return emptyParents;
}

/**
 * Displays the list of items that will be deleted with visual markers.
 *
 * Uses generic labels when a non-default depth is specified, and preserves
 * the existing "Album folders"/"Artist folders" labels when depth is undefined or 2.
 *
 * @param emptyAlbums - Array of album paths to delete
 * @param emptyArtists - Array of artist paths that will become empty
 * @param depth - Optional depth setting; when not 2 or undefined, generic labels are used
 */
function showDeletions(emptyAlbums: string[], emptyArtists: string[], depth?: number): void {
  const useGenericLabels = depth !== undefined && depth !== 2;
  const albumLabel = useGenericLabels ? "Empty directories to delete:" : "Album folders to delete:";
  const artistLabel = useGenericLabels
    ? "Empty parent directories to also delete:"
    : "Artist folders that will become empty (also deleted):";

  // Display albums to delete
  console.error("");
  logInfo(albumLabel);
  for (const album of emptyAlbums) {
    console.error(`  ${pc.red("\u2717")} ${album}`);
  }

  // Display artists that will become empty
  if (emptyArtists.length > 0) {
    console.error("");
    logInfo(artistLabel);
    for (const artist of emptyArtists) {
      console.error(`  ${pc.red("\u2717")} ${artist}`);
    }
  }

  // Show total summary
  console.error("");
  logInfo(`Total: ${emptyAlbums.length} album(s), ${emptyArtists.length} artist(s)`);
}

/**
 * Executes the clean command to delete empty album and artist folders.
 *
 * @param directory - The music directory to clean
 * @param options - Clean command options
 * @returns Result containing counts of deleted folders and any errors
 */
export async function executeClean(directory: string, options: CleanOptions): Promise<CleanResult> {
  const errors: FailedOperation[] = [];
  let albumsDeleted = 0;
  let artistsDeleted = 0;

  // Validate directory exists before scanning
  const normalizedDir = normalizePath(directory);
  if (!(await pathExists(normalizedDir))) {
    logError(`Directory does not exist: ${normalizedDir}`);
    return {
      albumsDeleted: 0,
      artistsDeleted: 0,
      errors: [
        {
          path: normalizedDir,
          message: "Directory does not exist",
          code: "ENOENT",
        },
      ],
    };
  }

  // Build protection patterns for passing to findEmptyArtists
  let protectionPatterns: string[] = [...(options.exclude ?? [])];
  if (options.protect) {
    try {
      const filePatterns = await readProtectionPatterns(options.protect);
      protectionPatterns = [...protectionPatterns, ...filePatterns];
    } catch {
      // Protection file errors are handled inside findEmptyAlbums; skip here
    }
  }

  // Build depth-aware progress task titles
  const depth = options.depth;
  const useGenericTitles = depth !== undefined && depth !== 2;
  const scanTitle = useGenericTitles
    ? `Scanning for empty directories (${depth === 0 ? "unlimited" : `depth: ${depth}`})`
    : "Scanning for empty album folders";
  const cascadeTitle = useGenericTitles
    ? "Checking for cascading parent cleanup"
    : "Checking for cascading artist cleanup";

  // Context for progress tracking
  interface CleanContext {
    emptyAlbums: string[];
    emptyArtists: string[];
  }

  const ctx: CleanContext = {
    emptyAlbums: [],
    emptyArtists: [],
  };

  // Find empty albums and artists with progress tracking
  if (!isJsonMode()) {
    await runTasks<CleanContext>(
      [
        {
          title: scanTitle,
          task: async (taskCtx) => {
            taskCtx.emptyAlbums = await findEmptyAlbums(normalizedDir, {
              olderThan: options.olderThan,
              exclude: options.exclude,
              protect: options.protect,
              depth: options.depth,
            });
          },
        },
        {
          title: cascadeTitle,
          skip: (taskCtx) => {
            if (taskCtx.emptyAlbums.length === 0) {
              return "No empty albums found";
            }
            return false;
          },
          task: async (taskCtx) => {
            taskCtx.emptyArtists = await findEmptyArtists(
              normalizedDir,
              taskCtx.emptyAlbums,
              protectionPatterns,
            );
          },
        },
      ],
      { ctx },
    );
  } else {
    // JSON mode - no progress display
    ctx.emptyAlbums = await findEmptyAlbums(normalizedDir, {
      olderThan: options.olderThan,
      exclude: options.exclude,
      protect: options.protect,
      depth: options.depth,
    });
    if (ctx.emptyAlbums.length > 0) {
      ctx.emptyArtists = await findEmptyArtists(normalizedDir, ctx.emptyAlbums, protectionPatterns);
    }
  }

  const { emptyAlbums, emptyArtists } = ctx;

  // Early exit if nothing to delete
  if (emptyAlbums.length === 0) {
    logSuccess("No empty album folders found");
    return {
      albumsDeleted: 0,
      artistsDeleted: 0,
      errors: [],
    };
  }

  // Display items to delete
  showDeletions(emptyAlbums, emptyArtists, options.depth);

  // Handle dry-run mode - show what would be deleted/trashed but make no changes
  if (options.dryRun) {
    const dryRunAction = options.useTrash ? "trash" : "delete";
    console.error("");
    for (const album of emptyAlbums) {
      logInfo(formatDryRun(`${dryRunAction}: ${album}`));
    }
    for (const artist of emptyArtists) {
      logInfo(formatDryRun(`${dryRunAction}: ${artist}`));
    }
    console.error("");
    const dryRunVerb = options.useTrash ? "move to trash" : "delete";
    logInfo(
      `[DRY-RUN] Would ${dryRunVerb} ${emptyAlbums.length} album(s) and ${emptyArtists.length} artist(s)`,
    );

    return {
      albumsDeleted: emptyAlbums.length,
      artistsDeleted: emptyArtists.length,
      errors: [],
    };
  }

  // Interactive confirmation (skip if --force)
  if (!options.force) {
    console.error("");
    const confirmed = await confirm("Proceed with deletion?");
    if (!confirmed) {
      logInfo("Deletion cancelled");
      return {
        albumsDeleted: 0,
        artistsDeleted: 0,
        errors: [],
      };
    }
  }

  // Create history recorder if enabled
  let recorder: HistoryRecorder | undefined;
  if (isHistoryEnabled()) {
    recorder = await createHistorySession("clean");
    logDebug(`History session started: ${recorder.getId()}`);
  }

  // Delete or trash function for albums and artists
  const action = options.useTrash ? "trash" : "delete";
  const actionPast = options.useTrash ? "Moved to trash" : "Deleted";

  const deleteAlbum = async (album: string): Promise<void> => {
    try {
      if (options.useTrash) {
        await moveToTrash(album);
        if (recorder) {
          await recorder.recordTrash(album);
        }
      } else {
        await remove(album);
        if (recorder) {
          await recorder.recordRemove(album);
        }
      }
      logSuccess(`${actionPast}: ${album}`);
      albumsDeleted++;
    } catch (err) {
      const error = err as Error & { code?: string };
      logError(`Failed to ${action}: ${album} - ${error.message}`);
      errors.push({
        path: album,
        message: error.message,
        code: error.code,
      });
      // Continue with remaining items (non-fatal)
    }
  };

  const deleteArtist = async (artist: string): Promise<void> => {
    try {
      if (options.useTrash) {
        await moveToTrash(artist);
        if (recorder) {
          await recorder.recordTrash(artist);
        }
      } else {
        await remove(artist);
        if (recorder) {
          await recorder.recordRemove(artist);
        }
      }
      logSuccess(`${actionPast}: ${artist}`);
      artistsDeleted++;
    } catch (err) {
      const error = err as Error & { code?: string };
      logError(`Failed to ${action}: ${artist} - ${error.message}`);
      errors.push({
        path: artist,
        message: error.message,
        code: error.code,
      });
      // Continue with remaining items (non-fatal)
    }
  };

  // Delete with progress tracking when not in JSON mode
  if (!isJsonMode()) {
    interface DeleteContext {
      albumsToDelete: string[];
      artistsToDelete: string[];
    }

    const taskVerb = options.useTrash ? "Moving" : "Deleting";
    const taskNoun = options.useTrash ? "trash" : "delete";

    await runTasks<DeleteContext>(
      [
        {
          title: `${taskVerb} empty albums`,
          task: async (taskCtx, task) => {
            const total = taskCtx.albumsToDelete.length;
            for (let i = 0; i < total; i++) {
              const album = taskCtx.albumsToDelete[i];
              if (album !== undefined) {
                task.title = `${taskVerb} empty albums (${i + 1}/${total})`;
                await deleteAlbum(album);
              }
            }
            task.title = `${taskVerb} empty albums (${total}/${total})`;
          },
        },
        {
          title: `${taskVerb} empty artists`,
          skip: (taskCtx) => {
            if (taskCtx.artistsToDelete.length === 0) {
              return `No artist folders to ${taskNoun}`;
            }
            return false;
          },
          task: async (taskCtx, task) => {
            const total = taskCtx.artistsToDelete.length;
            for (let i = 0; i < total; i++) {
              const artist = taskCtx.artistsToDelete[i];
              if (artist !== undefined) {
                task.title = `${taskVerb} empty artists (${i + 1}/${total})`;
                await deleteArtist(artist);
              }
            }
            task.title = `${taskVerb} empty artists (${total}/${total})`;
          },
        },
      ],
      {
        ctx: {
          albumsToDelete: emptyAlbums,
          artistsToDelete: emptyArtists,
        },
      },
    );
  } else {
    // JSON mode - no progress display
    for (const album of emptyAlbums) {
      await deleteAlbum(album);
    }
    for (const artist of emptyArtists) {
      await deleteArtist(artist);
    }
  }

  // Close history recorder
  if (recorder) {
    await recorder.close();
    logDebug(
      `History session closed: ${recorder.getId()} (${recorder.getOperationCount()} operations)`,
    );
  }

  // Final summary
  console.error("");
  logSuccess(`${actionPast} ${albumsDeleted} album(s) and ${artistsDeleted} artist(s)`);

  if (errors.length > 0) {
    logWarn(`${errors.length} item(s) failed to ${action}`);
  }

  return {
    albumsDeleted,
    artistsDeleted,
    errors,
  };
}
