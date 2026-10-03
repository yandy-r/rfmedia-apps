/**
 * Plex-based copy action for rfmedia CLI.
 *
 * Provides functionality to copy files based on Plex query results, either
 * from a saved query ID or by executing a new query. This action follows
 * the same folder structure patterns as the regular copy command.
 *
 * Folder Structure:
 * - albumMode + range: {dst}/{Artist}/{Album}-001/, {Album}-002/, etc.
 * - albumMode no range: {dst}/{Artist}/{Album}/
 * - filter mode: {dst}/{Artist}/{outputFolder}/
 * - preserveStructure: {dst}/{Artist}/{outputFolder}/{Album}/
 */

import path from "node:path";

import { logWarn, logDebug, logSuccess, formatDryRun, isJsonMode } from "../lib/logger.js";
import { syncTrackRating } from "../lib/sync-helper.js";
import { pathExists, ensureDir, copyOrLink, getFileSize } from "../lib/filesystem.js";
import {
  extractTrackFilePaths,
  resolveOptionalScanAdapter,
} from "../lib/adapters/action-helpers.js";
import { convertFile, getConvertedFilename } from "../lib/convert.js";
import { processInParallel } from "../lib/parallel.js";
import { CopyProgressBar } from "../lib/progress-bar.js";
import { formatSuffix, detectHighestSuffix, buildAutoRange } from "../lib/range.js";
import { formatCopySummaryTable } from "../lib/table-format.js";
import { initializeDatabase, closeDatabase, getPlexQuery, getPlexQueryResults } from "../lib/db.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { resolveUndoDatabasePath, getAllowedLibraryRoots } from "../lib/config.js";
import type { SavedMediaFilePathRow } from "../lib/media-file-paths.js";
import { executePlexQuery } from "./plex-query.js";
import type {
  PlexCopyOptions,
  PlexCopyResult,
  PlexCopyQueryResultsOptions,
  PlexCopyQueryOptions,
} from "../types/plex.js";
import type { ConvertFormat, CopyRange } from "../types/options.js";
import type { FailedOperation } from "../types/results.js";

/** Default output folder name for plex copy */
const DEFAULT_OUTPUT_FOLDER = "plex-liked";

/** Number of directory levels from track file to library root: /Library/Artist/Album/track.ext */
const PLEX_LIBRARY_DEPTH = 3;

/**
 * Extended options for query mode that include additional action-specific fields.
 * These fields are used during query execution but not stored in the base types.
 */
export interface PlexCopyQueryActionOptions extends PlexCopyQueryOptions {
  /** Plex URL override (for query mode) */
  plexUrl?: string;
  /** Plex token override (for query mode) */
  plexToken?: string;
  /** Named filter from plexFilters config section (for query mode) */
  filter?: string;
}

/**
 * Options for executePlexCopy action.
 * Discriminated union with additional action-specific fields for query mode.
 */
export type PlexCopyActionOptions = PlexCopyQueryResultsOptions | PlexCopyQueryActionOptions;

/**
 * Type guard to check if options are for query-results mode.
 */
function isQueryResultsMode(
  options: PlexCopyActionOptions,
): options is PlexCopyQueryResultsOptions {
  return options.mode === "query-results";
}

/**
 * Grouped tracks by artist/album for organized processing.
 */
interface AlbumGroup {
  artistName: string;
  albumName: string;
  tracks: string[];
}

/**
 * Projects compatibility and persistence rows to the only field required by
 * local path extraction. Keeping this projection narrow prevents Plex and
 * database fields from leaking into the generic filesystem helper.
 */
function projectSavedFilePaths(
  rows: readonly { readonly file_path: string | null }[],
): SavedMediaFilePathRow[] {
  return rows.map(({ file_path }) => ({ file_path }));
}

function projectLiveFilePaths(
  tracks: readonly { readonly filePath: string }[],
): SavedMediaFilePathRow[] {
  return tracks.map(({ filePath }) => ({ file_path: filePath }));
}

/**
 * Generates a unique filename path by adding numeric suffixes for duplicates.
 *
 * For the first occurrence of a filename, returns the original name.
 * For subsequent occurrences, adds suffixes: -002, -003, etc.
 *
 * @param destDir - Destination directory path
 * @param filename - Original filename to make unique
 * @param usedNames - Map tracking next suffix number per base filename
 * @returns Unique absolute path for the file
 */
function getUniquePath(destDir: string, filename: string, usedNames: Map<string, number>): string {
  const ext = path.extname(filename);
  const baseName = path.basename(filename, ext);

  // Key for tracking usage is the lowercase filename (case-insensitive matching)
  const key = filename.toLowerCase();

  const count = usedNames.get(key);

  if (count === undefined) {
    // First occurrence - no suffix needed
    usedNames.set(key, 2); // Next occurrence will get -002
    return path.join(destDir, filename);
  }

  // Subsequent occurrences get numbered suffixes
  const suffix = String(count).padStart(3, "0");
  usedNames.set(key, count + 1);

  const uniqueFilename = `${baseName}-${suffix}${ext}`;
  return path.join(destDir, uniqueFilename);
}

/**
 * Detects the Plex library root for a single file path.
 *
 * For Plex tracks at /library/Artist/Album/track.ext, the library root
 * is 3 directories up from the file (grandparent of grandparent).
 *
 * @param filePath - Absolute file path from Plex
 * @returns Library root path for this file
 */
function getPlexLibraryRoot(filePath: string): string {
  // Plex tracks are at: /library/Artist/Album/track.ext
  // So library root is PLEX_LIBRARY_DEPTH levels up from the file
  return path.resolve(filePath, "../".repeat(PLEX_LIBRARY_DEPTH));
}

/**
 * Extracts artist and album names directly from a Plex file path.
 *
 * For Plex tracks at /library/Artist/Album/track.ext, the artist is
 * the grandparent folder and album is the parent folder.
 *
 * @param filePath - Absolute file path from Plex
 * @returns Object with artistName and albumName
 */
function extractPlexPathInfo(filePath: string): { artistName: string; albumName: string } {
  // Plex tracks are at: /library/Artist/Album/track.ext
  // So artist is parts[-3] and album is parts[-2] (parent and grandparent of file)
  const albumDir = path.dirname(filePath);
  const artistDir = path.dirname(albumDir);

  return {
    artistName: path.basename(artistDir),
    albumName: path.basename(albumDir),
  };
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
 * Validates that a destination path stays within the base destination directory.
 *
 * Prevents path traversal attacks where malicious metadata (e.g., artist names
 * containing "../") could write files outside the intended destination.
 *
 * @param destDir - The computed destination directory path
 * @param baseDestination - The user-specified base destination directory
 * @throws Error if the destination path escapes the base directory
 */
function validateDestinationPath(destDir: string, baseDestination: string): void {
  const resolvedBase = path.resolve(baseDestination);
  const resolvedDest = path.resolve(destDir);

  // Must be inside base directory (with separator) or exactly equal to it
  if (!resolvedDest.startsWith(resolvedBase + path.sep) && resolvedDest !== resolvedBase) {
    throw new Error("Path traversal detected: destination path escapes base directory");
  }
}

/**
 * Execute a Plex-based copy operation.
 *
 * Supports two modes:
 * 1. Query-results mode: Copy from saved query ID
 * 2. Query mode: Execute new query and copy results
 *
 * Folder structure follows the same patterns as rfmedia copy:
 * - albumMode + range: {dst}/{Artist}/{Album}-001/, {Album}-002/, etc.
 * - albumMode no range: {dst}/{Artist}/{Album}/
 * - filter mode: {dst}/{Artist}/{outputFolder}/
 * - preserveStructure: {dst}/{Artist}/{outputFolder}/{Album}/
 *
 * @param options - Copy options including mode, destination, and query parameters
 * @returns Copy result with metrics
 */
export async function executePlexCopy(options: PlexCopyActionOptions): Promise<PlexCopyResult> {
  // Load config to get defaults
  const config = await getLoadedConfig();
  const copyConfig = config.copy ?? {};
  const plexConfig = config.plex ?? {};
  const syncOnCopyDefaults = plexConfig.syncOnCopyDefaults ?? {};

  // Merge CLI options with config defaults
  const {
    destination,
    hardlink = copyConfig.hardlink ?? false,
    convertFormat = copyConfig.convertFormat,
    preserveStructure = copyConfig.preserveStructure ?? false,
    albumMode = copyConfig.albumMode ?? false,
    outputFolder = copyConfig.outputFolder ?? DEFAULT_OUTPUT_FOLDER,
    workers = copyConfig.workers ?? 4,
    dryRun = false,
    progress = copyConfig.progress ?? true,
    plexScan = true,
    range,
    count,
    failFast = false,
    syncRatings = plexConfig.syncRatingsOnCopy ?? false,
    popmEmail = syncOnCopyDefaults.popmEmail ?? "no@email",
    vorbisScale = syncOnCopyDefaults.vorbisScale ?? "normalized",
  } = options;

  // Abort controller for fail-fast mode
  const abortController = new AbortController();
  const { signal: abortSignal } = abortController;

  // Initialize result
  const result: PlexCopyResult = {
    created: 0,
    skipped: 0,
    failed: [],
    totalSize: 0,
  };

  // Validate destination
  if (!destination) {
    throw new Error("Destination path is required");
  }

  // Warn about hardlink mode with sync ratings (modifies source files)
  if (hardlink && syncRatings) {
    logWarn("Warning: syncRatings with hardlink mode modifies source files");
  }

  // Get database connection
  const dbPath = resolveUndoDatabasePath(config);
  const db = await initializeDatabase(dbPath);
  // Plex copy uses this database for Plex query history only. It does not
  // create a copy tracking operation, so there is no inventory row to attach
  // destination content hashes to in this workflow.

  try {
    let filePaths: string[] = [];
    // Rating lookup map: file path -> user rating (0-10 scale)
    const ratingLookup = new Map<string, number>();

    if (isQueryResultsMode(options)) {
      // Query-results mode: Load from database
      const { queryId } = options;
      logDebug(`Loading query results from database (queryId: ${queryId})`);

      // Validate query exists
      const query = getPlexQuery(db, queryId);
      if (!query) {
        throw new Error(`Query not found: ${queryId}`);
      }

      logDebug(`Loading results from query: ${query.name || `#${queryId}`}`);

      // Load results
      const queryResults = getPlexQueryResults(db, queryId);
      if (queryResults.length === 0) {
        logDebug("Query has no results");
        return result;
      }

      logDebug(`Found ${queryResults.length} results`);

      // Extract file paths
      const pathExtraction = await extractTrackFilePaths(projectSavedFilePaths(queryResults), {
        validateExistence: true,
      });
      filePaths = pathExtraction.valid;

      // Build rating lookup map for sync-on-copy
      if (syncRatings) {
        for (const queryResult of queryResults) {
          if (queryResult.file_path && queryResult.user_rating > 0) {
            ratingLookup.set(queryResult.file_path, queryResult.user_rating);
          }
        }
      }

      // Log missing files
      if (pathExtraction.missing.length > 0) {
        logDebug(`${pathExtraction.missing.length} files are missing and will be skipped`);
        for (const missingPath of pathExtraction.missing) {
          logDebug(`Missing: ${missingPath}`);
        }
      }
    } else {
      // Query mode: Execute new query
      logDebug("Executing new Plex query");

      // Build query options from copy options
      const { library, type, ...queryParams } = options;

      if (!library) {
        throw new Error("Library name is required for query mode");
      }

      // Execute query
      const queryResult = await executePlexQuery({
        library,
        type: type || "track",
        ...queryParams,
        noSave: false, // Save query by default
      });

      // Check if we got tracks (only tracks have file paths)
      if (!("tracks" in queryResult)) {
        throw new Error('Plex copy only supports track queries. Use type: "track" option.');
      }

      if (queryResult.tracks.length === 0) {
        logWarn("Query returned no results");
        return result;
      }

      logDebug(`Query returned ${queryResult.tracks.length} tracks`);

      // If query was saved, load from database for consistency
      if (queryResult.queryId !== undefined) {
        const queryResults = getPlexQueryResults(db, queryResult.queryId);
        const pathExtraction = await extractTrackFilePaths(projectSavedFilePaths(queryResults), {
          validateExistence: true,
        });
        filePaths = pathExtraction.valid;

        // Build rating lookup map for sync-on-copy
        if (syncRatings) {
          for (const qr of queryResults) {
            if (qr.file_path && qr.user_rating > 0) {
              ratingLookup.set(qr.file_path, qr.user_rating);
            }
          }
        }

        // Log missing files
        if (pathExtraction.missing.length > 0) {
          logDebug(`${pathExtraction.missing.length} files are missing and will be skipped`);
        }
      } else {
        // Fallback: use tracks directly from query result
        const pathExtraction = await extractTrackFilePaths(
          projectLiveFilePaths(queryResult.tracks),
          {
            validateExistence: true,
          },
        );
        filePaths = pathExtraction.valid;

        // Build rating lookup map for sync-on-copy
        if (syncRatings) {
          for (const track of queryResult.tracks) {
            if (track.filePath && track.userRating > 0) {
              ratingLookup.set(track.filePath, track.userRating);
            }
          }
        }

        // Log missing files
        if (pathExtraction.missing.length > 0) {
          logDebug(`${pathExtraction.missing.length} files are missing and will be skipped`);
        }
      }
    }

    // Check if we have files to copy
    if (filePaths.length === 0) {
      logDebug("No valid files to copy");
      return result;
    }

    // Filter files by allowed library roots if configured
    const allowedRoots = getAllowedLibraryRoots(config);
    logDebug(`allowedLibraryRoots: ${JSON.stringify(allowedRoots)}`);

    if (allowedRoots.length > 0) {
      const beforeCount = filePaths.length;

      // Group by library root for logging (best effort extraction)
      const rootCounts = new Map<string, number>();

      filePaths = filePaths.filter((filePath) => {
        // Check if file path starts with any allowed root
        // This is more robust than extracting library root with fixed depth
        const isAllowed = allowedRoots.some((allowed) => {
          const resolvedAllowed = path.resolve(allowed);
          return filePath.startsWith(resolvedAllowed + path.sep);
        });

        if (!isAllowed) {
          // Extract library root for logging (best effort)
          const libraryRoot = getPlexLibraryRoot(filePath);
          rootCounts.set(libraryRoot, (rootCounts.get(libraryRoot) ?? 0) + 1);
        }
        return isAllowed;
      });

      const filtered = beforeCount - filePaths.length;
      if (filtered > 0) {
        logDebug(`Filtered ${filtered} files from non-allowed library roots:`);
        for (const [root, count] of rootCounts) {
          logDebug(`  - ${root}: ${count} files`);
        }
      }
    } else {
      logDebug("No allowedLibraryRoots configured, all tracks will be included");
    }

    // Check again after filtering
    if (filePaths.length === 0) {
      logDebug("No files remaining after library root filtering");
      return result;
    }

    // Track start time for summary
    const startTime = Date.now();

    // Group tracks by artist/album
    // Use per-file path extraction since Plex may have files from multiple library roots
    const albumGroups = new Map<string, AlbumGroup>();
    for (const filePath of filePaths) {
      // Extract artist/album directly from file path (no global library root needed)
      const { artistName, albumName } = extractPlexPathInfo(filePath);

      const key = `${artistName}\0${albumName}`;
      if (!albumGroups.has(key)) {
        albumGroups.set(key, {
          artistName,
          albumName,
          tracks: [],
        });
      }
      albumGroups.get(key)!.tracks.push(filePath);
    }

    logDebug(`Grouped ${filePaths.length} tracks into ${albumGroups.size} albums`);

    // Determine effective range for creating multiple copies
    let effectiveRange: CopyRange | undefined;

    if (range) {
      effectiveRange = range;
      logDebug(
        `Using explicit range: ${formatSuffix(range.start, range.padWidth)}-${formatSuffix(range.end, range.padWidth)}`,
      );
    } else if (count !== undefined && count > 0) {
      // Auto-detect highest suffix in destination
      const detection = await detectHighestSuffix(destination);
      const highestSuffix = detection?.highestSuffix ?? 0;
      const padWidth = detection?.padWidth ?? 3;
      effectiveRange = buildAutoRange(count, highestSuffix, padWidth);
      logDebug(
        `Auto-detected range: ${formatSuffix(effectiveRange.start, effectiveRange.padWidth)}-${formatSuffix(effectiveRange.end, effectiveRange.padWidth)} (highest existing: ${highestSuffix})`,
      );
    }

    // Build array of suffix strings (null means no suffix)
    const suffixes: Array<string | null> = effectiveRange
      ? Array.from({ length: effectiveRange.end - effectiveRange.start + 1 }, (_, i) =>
          formatSuffix(effectiveRange.start + i, effectiveRange.padWidth),
        )
      : [null];

    // Calculate total files for progress (files × suffixes)
    const totalFiles = filePaths.length * suffixes.length;
    logDebug(
      `Copying ${filePaths.length} files to ${destination}${effectiveRange ? ` (${suffixes.length} copies each = ${totalFiles} total)` : ""}`,
    );

    // Calculate total size for progress tracking (parallel for performance)
    let totalSize = 0;
    if (progress) {
      const fileSizes = await Promise.all(
        filePaths.map(async (filePath) => await getFileSize(filePath)),
      );
      totalSize = fileSizes.reduce((sum, size) => sum + size * suffixes.length, 0);
    }

    // Create progress bar
    const progressBar = progress
      ? new CopyProgressBar({
          totalFiles,
          totalBytes: totalSize,
          operationName: destination,
          progress: true,
        })
      : null;

    // Start progress bar
    progressBar?.start();

    // Track used filenames per destination directory for duplicate handling
    const usedNamesPerFolder = new Map<string, Map<string, number>>();

    try {
      // Process each album group
      for (const [, albumGroup] of albumGroups) {
        const { artistName, albumName, tracks } = albumGroup;

        // Track first copy paths for optimization (copy from first copy instead of source)
        const firstCopyPaths = new Map<string, string>();

        if (albumMode) {
          // ALBUM MODE: Suffix goes on folder name
          // Process each suffix (different folders)
          for (let suffixIndex = 0; suffixIndex < suffixes.length; suffixIndex++) {
            const suffix = suffixes[suffixIndex];
            const isFirstCopy = suffixIndex === 0;

            // Album mode: {dst}/{Artist}/{Album}-{suffix}/ or {dst}/{Artist}/{Album}/
            const albumFolderName = suffix !== null ? `${albumName}-${suffix}` : albumName;
            const destDir = path.join(destination, artistName, albumFolderName);

            // Validate path doesn't escape destination (defense against path traversal)
            validateDestinationPath(destDir, destination);

            // Process tracks in this album for this suffix
            await processInParallel(
              tracks,
              async (trackPath: string) => {
                // Check if we should abort (fail-fast mode)
                if (abortSignal.aborted) {
                  return;
                }

                const fileSize = await getFileSize(trackPath);
                const originalFilename = path.basename(trackPath);
                const destFilename = getDestFilename(originalFilename, convertFormat);
                const destPath = path.join(destDir, destFilename);

                try {
                  // Check if destination already exists
                  if (!dryRun && (await pathExists(destPath))) {
                    logDebug(`File already exists, skipping: ${destPath}`);
                    result.skipped++;
                    progressBar?.updateFile(fileSize);

                    // Still track as first copy source if it exists
                    if (isFirstCopy && !firstCopyPaths.has(originalFilename)) {
                      firstCopyPaths.set(originalFilename, destPath);
                    }
                    return;
                  }

                  if (dryRun) {
                    const action = convertFormat
                      ? `convert (${convertFormat})`
                      : hardlink
                        ? "hardlink"
                        : "copy";
                    logDebug(`[DRY RUN] ${action}: ${trackPath} -> ${destPath}`);
                    result.created++;
                    result.totalSize += fileSize;

                    // Sync rating in dry-run mode (logs intent)
                    if (syncRatings && isFirstCopy) {
                      const plexRating = ratingLookup.get(trackPath);
                      if (plexRating !== undefined && plexRating > 0) {
                        await syncTrackRating(destPath, plexRating, {
                          popmEmail,
                          vorbisScale,
                          dryRun,
                        });
                      }
                    }

                    progressBar?.updateFile(fileSize);
                  } else {
                    // Ensure destination directory exists
                    await ensureDir(destDir);

                    // Determine copy source (first copy from source, subsequent from first copy)
                    const copySource = isFirstCopy
                      ? trackPath
                      : (firstCopyPaths.get(originalFilename) ?? trackPath);

                    // Copy or convert file
                    if (convertFormat && isFirstCopy) {
                      await convertFile(
                        copySource,
                        destPath,
                        convertFormat as "mp3" | "aac" | "opus" | "alac",
                      );
                      result.created++;
                      result.totalSize += fileSize;
                    } else {
                      const method = await copyOrLink(copySource, destPath, hardlink);
                      logDebug(
                        `${method === "hardlink" ? "Hardlinked" : "Copied"}: ${copySource} -> ${destPath}`,
                      );
                      result.created++;
                      result.totalSize += fileSize;
                    }

                    // Sync rating to destination file (only on first copy)
                    if (syncRatings && isFirstCopy) {
                      const plexRating = ratingLookup.get(trackPath);
                      if (plexRating !== undefined && plexRating > 0) {
                        const syncResult = await syncTrackRating(destPath, plexRating, {
                          popmEmail,
                          vorbisScale,
                          dryRun,
                        });
                        if (!syncResult.success && !syncResult.skipped) {
                          logDebug(`Rating sync failed for ${destPath}: ${syncResult.message}`);
                        }
                      }
                    }

                    // Track first copy path for optimization
                    if (isFirstCopy) {
                      firstCopyPaths.set(originalFilename, destPath);
                    }

                    progressBar?.updateFile(fileSize);
                  }
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  const suffixInfo = suffix !== null ? ` (suffix ${suffix})` : "";
                  logDebug(`Failed to process ${trackPath}${suffixInfo}: ${message}`);

                  const failedOp: FailedOperation = {
                    path: trackPath,
                    message,
                  };

                  if (error instanceof Error && "code" in error) {
                    failedOp.code = (error as NodeJS.ErrnoException).code;
                  }

                  result.failed.push(failedOp);

                  // In fail-fast mode, abort further processing
                  if (failFast) {
                    abortController.abort();
                  }
                }
              },
              { workers },
            );

            // Check if we should stop processing more suffixes (fail-fast mode)
            if (abortSignal.aborted) {
              break;
            }
          }
        } else {
          // FILTER MODE: Suffix goes on filename (if range specified)
          // Calculate destination directory
          let destDir: string;
          if (preserveStructure) {
            // Preserve structure: {dst}/{Artist}/{outputFolder}/{Album}/
            destDir = path.join(destination, artistName, outputFolder, albumName);
          } else {
            // Flat filter mode: {dst}/{Artist}/{outputFolder}/
            destDir = path.join(destination, artistName, outputFolder);
          }

          // Validate path doesn't escape destination (defense against path traversal)
          validateDestinationPath(destDir, destination);

          // Get or create used names map for this directory
          let usedNames = usedNamesPerFolder.get(destDir);
          if (!usedNames) {
            usedNames = new Map<string, number>();
            usedNamesPerFolder.set(destDir, usedNames);
          }

          // Process tracks with optional filename suffixes
          await processInParallel(
            tracks,
            async (trackPath: string) => {
              // Check if we should abort (fail-fast mode)
              if (abortSignal.aborted) {
                return;
              }

              const fileSize = await getFileSize(trackPath);
              const originalFilename = path.basename(trackPath);
              const baseDestFilename = getDestFilename(originalFilename, convertFormat);

              // Create each copy (iterate over suffixes in inner loop)
              for (let suffixIndex = 0; suffixIndex < suffixes.length; suffixIndex++) {
                const suffix = suffixes[suffixIndex];
                const isFirstCopy = suffixIndex === 0;

                // Build destination filename with optional suffix
                let destFilename: string;
                if (suffix !== null && effectiveRange) {
                  // Add suffix to filename: basename-001.ext
                  const ext = path.extname(baseDestFilename);
                  const baseName = path.basename(baseDestFilename, ext);
                  destFilename = `${baseName}-${suffix}${ext}`;
                } else {
                  destFilename = baseDestFilename;
                }

                // Get unique path for duplicates (only for first copy without suffix)
                const destPath =
                  suffix === null
                    ? getUniquePath(destDir, destFilename, usedNames!)
                    : path.join(destDir, destFilename);

                try {
                  // Check if destination already exists
                  if (!dryRun && (await pathExists(destPath))) {
                    logDebug(`File already exists, skipping: ${destPath}`);
                    result.skipped++;
                    progressBar?.updateFile(fileSize);

                    // Still track as first copy source if it exists
                    if (isFirstCopy && !firstCopyPaths.has(originalFilename)) {
                      firstCopyPaths.set(originalFilename, destPath);
                    }
                    continue;
                  }

                  if (dryRun) {
                    const action = convertFormat
                      ? `convert (${convertFormat})`
                      : hardlink
                        ? "hardlink"
                        : "copy";
                    logDebug(`[DRY RUN] ${action}: ${trackPath} -> ${destPath}`);
                    result.created++;
                    result.totalSize += fileSize;

                    // Sync rating in dry-run mode (logs intent)
                    if (syncRatings && isFirstCopy) {
                      const plexRating = ratingLookup.get(trackPath);
                      if (plexRating !== undefined && plexRating > 0) {
                        await syncTrackRating(destPath, plexRating, {
                          popmEmail,
                          vorbisScale,
                          dryRun,
                        });
                      }
                    }

                    progressBar?.updateFile(fileSize);
                  } else {
                    // Ensure destination directory exists
                    await ensureDir(destDir);

                    // Determine copy source (first copy from source, subsequent from first copy)
                    const copySource = isFirstCopy
                      ? trackPath
                      : (firstCopyPaths.get(originalFilename) ?? trackPath);

                    // Copy or convert file
                    if (convertFormat && isFirstCopy) {
                      await convertFile(
                        copySource,
                        destPath,
                        convertFormat as "mp3" | "aac" | "opus" | "alac",
                      );
                      result.created++;
                      result.totalSize += fileSize;
                    } else {
                      const method = await copyOrLink(copySource, destPath, hardlink);
                      logDebug(
                        `${method === "hardlink" ? "Hardlinked" : "Copied"}: ${copySource} -> ${destPath}`,
                      );
                      result.created++;
                      result.totalSize += fileSize;
                    }

                    // Sync rating to destination file (only on first copy)
                    if (syncRatings && isFirstCopy) {
                      const plexRating = ratingLookup.get(trackPath);
                      if (plexRating !== undefined && plexRating > 0) {
                        const syncResult = await syncTrackRating(destPath, plexRating, {
                          popmEmail,
                          vorbisScale,
                          dryRun,
                        });
                        if (!syncResult.success && !syncResult.skipped) {
                          logDebug(`Rating sync failed for ${destPath}: ${syncResult.message}`);
                        }
                      }
                    }

                    // Track first copy path for optimization
                    if (isFirstCopy) {
                      firstCopyPaths.set(originalFilename, destPath);
                    }

                    progressBar?.updateFile(fileSize);
                  }
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  const suffixInfo = suffix !== null ? ` (suffix ${suffix})` : "";
                  logDebug(`Failed to process ${trackPath}${suffixInfo}: ${message}`);

                  const failedOp: FailedOperation = {
                    path: trackPath,
                    message,
                  };

                  if (error instanceof Error && "code" in error) {
                    failedOp.code = (error as NodeJS.ErrnoException).code;
                  }

                  result.failed.push(failedOp);

                  // In fail-fast mode, abort further processing
                  if (failFast) {
                    abortController.abort();
                    break; // Exit the suffix loop for this track
                  }
                }
              }
            },
            { workers },
          );
        }

        // Check if we should stop processing more albums (fail-fast mode)
        if (abortSignal.aborted) {
          break;
        }
      }
    } finally {
      // Always stop progress bar
      progressBar?.stop();
    }

    // Output summary (unless JSON mode or dry-run)
    if (!isJsonMode() && !dryRun) {
      const elapsedMs = Date.now() - startTime;
      const elapsedSec = elapsedMs / 1000;
      const elapsed =
        elapsedSec < 60
          ? `${elapsedSec.toFixed(1)}s`
          : `${Math.floor(elapsedSec / 60)}m ${Math.floor(elapsedSec % 60)}s`;
      const sourcesPerMin = elapsedSec > 0 ? (albumGroups.size / elapsedSec) * 60 : 0;

      console.error("");
      console.error(
        formatCopySummaryTable({
          totalSources: albumGroups.size,
          processed: albumGroups.size,
          skippedCompleted: 0,
          failed: result.failed.length > 0 ? 1 : 0,
          filesCreated: result.created,
          filesSkipped: result.skipped,
          filesFailed: result.failed.length,
          elapsed,
          sourcesPerMin,
        }),
      );
    }

    // Trigger Plex scan after copy (if configured and not dry-run)
    if (plexScan !== false && !dryRun && result.created > 0) {
      const { adapter: mediaServerAdapter } = resolveOptionalScanAdapter({
        plexUrl: "plexUrl" in options ? options.plexUrl : undefined,
        plexToken: "plexToken" in options ? options.plexToken : undefined,
        plexScan,
      });

      if (mediaServerAdapter?.capabilities.scan) {
        const scanResult = await mediaServerAdapter.scan.triggerSource(destination);
        if (scanResult.success) {
          logSuccess(`Plex library scan triggered: ${scanResult.libraryName ?? "all libraries"}`);
        } else {
          logWarn(`Plex scan failed: ${scanResult.message}`);
        }
      }
    } else if (plexScan !== false && dryRun && result.created > 0) {
      logDebug(formatDryRun(`trigger Plex scan`));
    }

    return result;
  } finally {
    // Always close database
    closeDatabase(db);
  }
}
