/**
 * Plex playlist action handlers for rfmedia CLI.
 *
 * Provides functions for listing, exporting, and syncing Plex playlists.
 * These actions implement the business logic for the `plex playlist` command group.
 *
 * Export Folder Structure (default creates playlist subfolder):
 * - Default:                    {dst}/{Playlist}/{filename}
 * - --preserve-structure:       {dst}/{Playlist}/{Artist}/{Album}/{filename}
 * - --flat:                     {dst}/{filename}
 * - --flat --preserve-structure:{dst}/{Artist}/{Album}/{filename}
 * - --folder <name>:            {dst}/{name}/{filename}
 */

import path from "node:path";
import { link } from "node:fs/promises";

import { logWarn, logDebug, logSuccess, logInfo, formatDryRun, isJsonMode } from "../lib/logger.js";
import {
  pathExists,
  ensureDir,
  copyOrLink,
  getFileSize,
  remove,
  sanitizeForFilesystem,
} from "../lib/filesystem.js";
import { syncTrackRating } from "../lib/sync-helper.js";
import {
  formatSuffix,
  detectHighestFileSuffix,
  buildAutoRange,
  formatRange,
} from "../lib/range.js";
import { findAudioFiles } from "../lib/audio.js";
import {
  extractTrackFilePaths as getTrackFilePaths,
  resolveOptionalScanAdapter,
  resolveRequiredMediaServerAdapter,
} from "../lib/adapters/action-helpers.js";
import { convertFile, getConvertedFilename } from "../lib/convert.js";
import { processInParallel } from "../lib/parallel.js";
import { CopyProgressBar } from "../lib/progress-bar.js";
import { formatCopySummaryTable } from "../lib/table-format.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { getAllowedLibraryRoots } from "../lib/config.js";
import { advancePaginationOffset } from "../lib/pagination.js";
import type {
  PlaylistExportOptions,
  PlaylistExportResult,
  PlaylistSyncOptions,
  PlaylistCreateOptions,
  PlaylistCreateResult,
  PlaylistAddOptions,
  PlaylistAddResult,
} from "../types/plex.js";
import type { ConvertFormat, CopyRange } from "../types/options.js";
import type { FailedOperation } from "../types/results.js";
import type { MediaFilter, MediaFilterRule } from "../types/media-filters.js";
import type {
  MediaAlbum,
  MediaPlaylist,
  MediaServerAdapter,
  MediaTrack,
} from "../types/media-server.js";

/** Number of directory levels from track file to library root: /Library/Artist/Album/track.ext */
const PLEX_LIBRARY_DEPTH = 3;

/**
 * Grouped tracks by artist/album for organized processing.
 */
interface AlbumGroup {
  artistName: string;
  albumName: string;
  tracks: MediaTrack[];
}

/**
 * Options for listing Plex playlists.
 */
export interface ListPlaylistsOptions {
  /** Filter to only exportable playlists (non-empty audio playlists) */
  exportable?: boolean;
  /** Override Plex server URL from config */
  plexUrl?: string;
  /** Override Plex authentication token from config */
  plexToken?: string;
}

/** Compatibility presentation returned by the Plex-namespaced list command. */
export interface PlexPlaylistListItem {
  ratingKey: string;
  title: string;
  smart: boolean;
  leafCount: number;
  duration: number;
  addedAt: number;
  updatedAt: number;
}

function projectPlaylistForPlexCommand(playlist: MediaPlaylist): PlexPlaylistListItem {
  return {
    ratingKey: playlist.id,
    title: playlist.title,
    smart: playlist.smart,
    leafCount: playlist.itemCount,
    duration: playlist.durationMs,
    addedAt: playlist.createdAt ?? 0,
    updatedAt: playlist.updatedAt ?? 0,
  };
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
 * Lists available Plex audio playlists.
 *
 * Retrieves playlists from the configured Plex server and optionally filters
 * to only exportable playlists (those with at least one track).
 *
 * @param options - Configuration options for listing playlists
 * @returns Array of audio playlists from the Plex server
 * @throws Error if Plex URL or token is not configured
 * @throws Error if the Plex API request fails
 *
 * @example
 * // List all audio playlists
 * const playlists = await listPlaylists({});
 *
 * @example
 * // List only exportable playlists (non-empty)
 * const exportable = await listPlaylists({ exportable: true });
 *
 * @example
 * // Override Plex connection settings
 * const playlists = await listPlaylists({
 *   plexUrl: 'http://192.168.1.100:32400',
 *   plexToken: 'my-token',
 * });
 */
export async function listPlaylists(
  options: ListPlaylistsOptions,
): Promise<PlexPlaylistListItem[]> {
  const mediaServerAdapter = resolveRequiredMediaServerAdapter({
    plexUrl: options.plexUrl,
    plexToken: options.plexToken,
  });

  // Fetch all audio playlists from Plex
  const playlists = await mediaServerAdapter.playlist.list();

  // Optionally filter to exportable playlists (non-empty audio playlists)
  const selected = options.exportable
    ? playlists.filter((playlist) => playlist.itemCount > 0)
    : playlists;
  return selected.map(projectPlaylistForPlexCommand);
}

/**
 * Execute a playlist export operation.
 *
 * Exports all tracks from a Plex playlist to the destination folder.
 * Supports flat structure or artist/album folder organization.
 *
 * @param options - Export options including playlist name and destination
 * @returns Export result with metrics
 * @throws Error if playlist not found or Plex configuration invalid
 *
 * @example
 * // Export a playlist with default settings
 * const result = await executePlaylistExport({
 *   playlistName: 'My Favorites',
 *   destination: '/music/exports/favorites',
 * });
 *
 * @example
 * // Export with artist/album folder structure
 * const result = await executePlaylistExport({
 *   playlistName: 'My Favorites',
 *   destination: '/music/exports/favorites',
 *   preserveStructure: true,
 * });
 *
 * @example
 * // Export with hardlinks and conversion
 * const result = await executePlaylistExport({
 *   playlistName: 'Workout Mix',
 *   destination: '/music/workout',
 *   hardlink: true,
 *   convertFormat: 'mp3',
 *   workers: 4,
 * });
 */
export async function executePlaylistExport(
  options: PlaylistExportOptions,
): Promise<PlaylistExportResult> {
  // Load config to get defaults
  // Note: playlistDefaults (smart, updateExisting) are for playlist creation in Plex,
  // not for export operations. They'll be consumed when `plex playlist create` is implemented.
  const config = getLoadedConfig();
  logDebug(
    `Config loaded, plex.allowedLibraryRoots: ${JSON.stringify(config.plex?.allowedLibraryRoots)}`,
  );
  const copyConfig = config.copy ?? {};
  const plexConfigOpts = config.plex ?? {};
  const syncOnCopyDefaults = plexConfigOpts.syncOnCopyDefaults ?? {};

  // Merge CLI options with config defaults
  const {
    playlistName,
    destination,
    hardlink = copyConfig.hardlink ?? false,
    convertFormat = copyConfig.convertFormat,
    preserveStructure = copyConfig.preserveStructure ?? false,
    flat = false,
    folder,
    workers = copyConfig.workers ?? 4,
    dryRun = false,
    progress = copyConfig.progress ?? true,
    plexScan = true,
    range,
    count,
    syncRatings = plexConfigOpts.syncRatingsOnCopy ?? false,
    popmEmail = syncOnCopyDefaults.popmEmail ?? "no@email",
    vorbisScale = syncOnCopyDefaults.vorbisScale ?? "normalized",
  } = options;

  // Validate mutually exclusive options
  if (flat && folder) {
    throw new Error(
      "Cannot use --flat and --folder together. Use --flat to output directly to destination, or --folder to specify a custom subfolder name.",
    );
  }

  // Warn about sync with hardlinks (modifies source files due to shared inode)
  if (hardlink && syncRatings) {
    logWarn("Warning: syncRatings with hardlink mode modifies source files");
  }

  // Abort controller for fail-fast mode (reserved for future use)
  const abortController = new AbortController();
  const { signal: abortSignal } = abortController;

  // Initialize result
  const result: PlaylistExportResult = {
    playlistName,
    totalTracks: 0,
    created: 0,
    skipped: 0,
    failed: [],
    totalSize: 0,
  };

  // Validate destination
  if (!destination) {
    throw new Error("Destination path is required");
  }

  const mediaServerAdapter = resolveRequiredMediaServerAdapter({});

  // Find playlist
  logDebug(`Finding playlist: ${playlistName}`);
  const playlist = await mediaServerAdapter.playlist.byName(playlistName);
  logDebug(`Found playlist "${playlist.title}" with ${playlist.itemCount} tracks`);

  // Compute effective destination path
  // Default: creates a playlist subfolder; --flat outputs directly; --folder overrides name
  let effectiveDestination = destination;

  if (!flat) {
    // Create a subfolder named after the playlist (or custom folder name)
    const folderName = folder
      ? sanitizeForFilesystem(folder)
      : sanitizeForFilesystem(playlist.title);
    effectiveDestination = path.join(destination, folderName);
    logDebug(`Using playlist subfolder: ${effectiveDestination}`);
  } else {
    logDebug(`Using flat mode: files output directly to ${destination}`);
  }

  // Determine effective range for creating multiple copies
  let effectiveRange: CopyRange | undefined;

  if (range) {
    effectiveRange = range;
    logDebug(`Using explicit range: ${formatRange(range)}`);
  } else if (count !== undefined && count > 0) {
    const detection = await detectHighestFileSuffix(effectiveDestination);
    const highestSuffix = detection?.highestSuffix ?? 0;
    const padWidth = detection?.padWidth ?? 3;
    effectiveRange = buildAutoRange(count, highestSuffix, padWidth);
    logDebug(
      `Auto-detected range: ${formatRange(effectiveRange)} (highest existing: ${highestSuffix})`,
    );
  }

  // Build suffix array (null = no suffix, uses original duplicate handling)
  const suffixes: Array<string | null> = effectiveRange
    ? Array.from({ length: effectiveRange.end - effectiveRange.start + 1 }, (_, i) =>
        formatSuffix(effectiveRange!.start + i, effectiveRange!.padWidth),
      )
    : [null];

  logDebug(`Suffixes to create: ${suffixes[0] === null ? "none (original)" : suffixes.join(", ")}`);

  // Get tracks
  logDebug(`Fetching tracks for playlist: ${playlist.id}`);
  const tracks = await mediaServerAdapter.playlist.tracks(playlist.id);
  result.totalTracks = tracks.length;

  if (tracks.length === 0) {
    logDebug("Playlist has no tracks");
    return result;
  }

  logDebug(`Fetched ${tracks.length} tracks from playlist`);

  // Extract and validate file paths
  const pathExtraction = await getTrackFilePaths(tracks, { validateExistence: true });
  let validTracks = tracks.filter((track) => pathExtraction.valid.includes(track.filePath));

  // Log missing files
  if (pathExtraction.missing.length > 0) {
    logDebug(`${pathExtraction.missing.length} files are missing and will be skipped`);
    for (const missingPath of pathExtraction.missing) {
      logDebug(`Missing: ${missingPath}`);
    }
  }

  // Filter files by allowed library roots if configured
  const allowedRoots = getAllowedLibraryRoots(config);
  logDebug(`allowedLibraryRoots: ${JSON.stringify(allowedRoots)}`);

  if (allowedRoots.length > 0) {
    const beforeCount = validTracks.length;

    // Group by library root for logging (best effort extraction)
    const rootCounts = new Map<string, number>();

    validTracks = validTracks.filter((track) => {
      const filePath = track.filePath;
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

    const filtered = beforeCount - validTracks.length;
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
  if (validTracks.length === 0) {
    logDebug("No files remaining after filtering");
    return result;
  }

  // Track start time for summary
  const startTime = Date.now();

  // Group tracks by artist/album for organized processing
  const albumGroups = new Map<string, AlbumGroup>();
  for (const track of validTracks) {
    const { artistName, albumName } = extractPlexPathInfo(track.filePath);

    const key = `${artistName}\0${albumName}`;
    if (!albumGroups.has(key)) {
      albumGroups.set(key, {
        artistName,
        albumName,
        tracks: [],
      });
    }
    albumGroups.get(key)!.tracks.push(track);
  }

  logDebug(`Grouped ${validTracks.length} tracks into ${albumGroups.size} albums`);
  logDebug(`Exporting ${validTracks.length} files to ${effectiveDestination}`);

  // Calculate total size for progress tracking (parallel for performance)
  // Total is tracks × suffixes for accurate progress
  const totalFilesToProcess = validTracks.length * suffixes.length;
  let totalSize = 0;
  if (progress) {
    const fileSizes = await Promise.all(
      validTracks.map(async (track) => await getFileSize(track.filePath)),
    );
    // Total size is also multiplied by suffix count (each file is created N times)
    totalSize = fileSizes.reduce((sum, size) => sum + size, 0) * suffixes.length;
  }

  // Create progress bar
  const progressBar = progress
    ? new CopyProgressBar({
        totalFiles: totalFilesToProcess,
        totalBytes: totalSize,
        operationName: playlistName,
        progress: true,
      })
    : null;

  // Start progress bar
  progressBar?.start();

  // Track used filenames for flat structure duplicate handling
  const usedNames = new Map<string, number>();

  try {
    // Track first copy paths for hardlink optimization
    // Key: originalFilename (or full path for preserve-structure), Value: path to first copy
    const firstCopyPaths = new Map<string, string>();

    if (preserveStructure) {
      // PRESERVE STRUCTURE MODE: {effectiveDst}/{Artist}/{Album}/{filename-suffix}
      // Process each album group
      for (const [, albumGroup] of albumGroups) {
        const { artistName, albumName, tracks: albumTracks } = albumGroup;

        // Build destination directory
        const destDir = path.join(effectiveDestination, artistName, albumName);

        // Validate path doesn't escape destination (defense against path traversal)
        validateDestinationPath(destDir, effectiveDestination);

        // Process tracks in this album - sequential for each track to handle suffixes properly
        for (const track of albumTracks) {
          // Check if we should abort
          if (abortSignal.aborted) {
            break;
          }

          const trackPath = track.filePath;
          const fileSize = await getFileSize(trackPath);
          const originalFilename = path.basename(trackPath);
          const baseDestFilename = getDestFilename(originalFilename, convertFormat);

          // Process each suffix for this track
          for (let suffixIndex = 0; suffixIndex < suffixes.length; suffixIndex++) {
            const suffix = suffixes[suffixIndex];
            const isFirstCopy = suffixIndex === 0;

            // Build destination filename with suffix
            let destFilename: string;
            if (suffix !== null) {
              const ext = path.extname(baseDestFilename);
              const baseName = path.basename(baseDestFilename, ext);
              destFilename = `${baseName}-${suffix}${ext}`;
            } else {
              destFilename = baseDestFilename;
            }

            const destPath = path.join(destDir, destFilename);

            try {
              // Check if destination already exists
              if (!dryRun && (await pathExists(destPath))) {
                logDebug(`File already exists, skipping: ${destPath}`);
                result.skipped++;
                progressBar?.updateFile(fileSize);
                // Still record first copy path for subsequent hardlinks
                if (isFirstCopy && suffix !== null) {
                  firstCopyPaths.set(trackPath, destPath);
                }
                continue;
              }

              if (dryRun) {
                const action =
                  !isFirstCopy && suffix !== null
                    ? "hardlink (from first copy)"
                    : convertFormat
                      ? `convert (${convertFormat})`
                      : hardlink
                        ? "hardlink"
                        : "copy";
                logDebug(`[DRY RUN] ${action}: ${trackPath} -> ${destPath}`);
                result.created++;
                result.totalSize += fileSize;
                progressBar?.updateFile(fileSize);
              } else {
                // Ensure destination directory exists
                await ensureDir(destDir);

                if (isFirstCopy || suffix === null) {
                  // First copy (or no suffix mode): copy/convert from source
                  if (convertFormat) {
                    await convertFile(
                      trackPath,
                      destPath,
                      convertFormat as "mp3" | "aac" | "opus" | "alac",
                    );
                  } else {
                    await copyOrLink(trackPath, destPath, hardlink);
                  }
                  // Record for subsequent hardlinks
                  if (suffix !== null) {
                    firstCopyPaths.set(trackPath, destPath);
                  }
                  logDebug(`Created first copy: ${destPath}`);
                } else {
                  // Subsequent copies: hardlink from first copy
                  const firstCopyPath = firstCopyPaths.get(trackPath);
                  if (firstCopyPath) {
                    await link(firstCopyPath, destPath);
                    logDebug(`Hardlinked from first copy: ${destPath}`);
                  } else {
                    // Fallback: copy from source if first copy not available
                    if (convertFormat) {
                      await convertFile(
                        trackPath,
                        destPath,
                        convertFormat as "mp3" | "aac" | "opus" | "alac",
                      );
                    } else {
                      await copyOrLink(trackPath, destPath, hardlink);
                    }
                    logDebug(`Fallback copy: ${destPath}`);
                  }
                }

                result.created++;

                // Sync rating to destination file if enabled
                if (syncRatings && track.rating !== null && track.rating > 0) {
                  const syncResult = await syncTrackRating(destPath, track.rating * 10, {
                    popmEmail,
                    vorbisScale,
                    dryRun,
                  });
                  if (!syncResult.success && !syncResult.skipped) {
                    logDebug(`Rating sync failed for ${destPath}: ${syncResult.message}`);
                  }
                }

                result.totalSize += fileSize;
                progressBar?.updateFile(fileSize);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logDebug(`Failed to process ${trackPath} -> ${destPath}: ${message}`);

              const failedOp: FailedOperation = {
                path: trackPath,
                message,
              };

              if (error instanceof Error && "code" in error) {
                failedOp.code = (error as NodeJS.ErrnoException).code;
              }

              result.failed.push(failedOp);
            }
          }
        }

        // Check if we should stop processing more albums
        if (abortSignal.aborted) {
          break;
        }
      }
    } else {
      // FLAT STRUCTURE MODE: {effectiveDst}/{filename-suffix}
      // All tracks go to the effective destination root with unique filenames

      // Validate base destination path
      validateDestinationPath(effectiveDestination, effectiveDestination);

      // Sort tracks by opaque ID for deterministic suffix assignment
      // This ensures sync operations compute the same expected paths
      const sortedTracks = [...validTracks].sort((a, b) => a.id.localeCompare(b.id));

      // Pre-compute base destination filenames sequentially to ensure deterministic assignment
      // For suffix mode, we don't use usedNames since suffixes make filenames unique
      // For no-suffix mode, we use usedNames for duplicate handling
      const trackBaseFilenames = new Map<string, string>();
      if (suffixes[0] === null) {
        // No suffix mode: use original unique path logic
        for (const track of sortedTracks) {
          const originalFilename = path.basename(track.filePath);
          const destFilename = getDestFilename(originalFilename, convertFormat);
          const destPath = getUniquePath(effectiveDestination, destFilename, usedNames);
          trackBaseFilenames.set(track.id, destPath);
        }
      } else {
        // Suffix mode: just compute base filename (suffix will be added later)
        for (const track of sortedTracks) {
          const originalFilename = path.basename(track.filePath);
          const destFilename = getDestFilename(originalFilename, convertFormat);
          trackBaseFilenames.set(track.id, destFilename);
        }
      }

      // Process all tracks sequentially to maintain suffix order
      for (const track of sortedTracks) {
        // Check if we should abort
        if (abortSignal.aborted) {
          break;
        }

        const trackPath = track.filePath;
        const fileSize = await getFileSize(trackPath);
        const baseInfo = trackBaseFilenames.get(track.id)!;

        // Process each suffix for this track
        for (let suffixIndex = 0; suffixIndex < suffixes.length; suffixIndex++) {
          const suffix = suffixes[suffixIndex];
          const isFirstCopy = suffixIndex === 0;

          // Build destination path
          let destPath: string;
          if (suffix === null) {
            // No suffix mode: baseInfo is already the full path
            destPath = baseInfo;
          } else {
            // Suffix mode: add suffix to base filename
            const ext = path.extname(baseInfo);
            const baseName = path.basename(baseInfo, ext);
            destPath = path.join(effectiveDestination, `${baseName}-${suffix}${ext}`);
          }

          try {
            // Check if destination already exists
            if (!dryRun && (await pathExists(destPath))) {
              logDebug(`File already exists, skipping: ${destPath}`);
              result.skipped++;
              progressBar?.updateFile(fileSize);
              // Still record first copy path for subsequent hardlinks
              if (isFirstCopy && suffix !== null) {
                firstCopyPaths.set(trackPath, destPath);
              }
              continue;
            }

            if (dryRun) {
              const action =
                !isFirstCopy && suffix !== null
                  ? "hardlink (from first copy)"
                  : convertFormat
                    ? `convert (${convertFormat})`
                    : hardlink
                      ? "hardlink"
                      : "copy";
              logDebug(`[DRY RUN] ${action}: ${trackPath} -> ${destPath}`);
              result.created++;
              result.totalSize += fileSize;
              progressBar?.updateFile(fileSize);
            } else {
              // Ensure destination directory exists
              await ensureDir(effectiveDestination);

              if (isFirstCopy || suffix === null) {
                // First copy (or no suffix mode): copy/convert from source
                if (convertFormat) {
                  await convertFile(
                    trackPath,
                    destPath,
                    convertFormat as "mp3" | "aac" | "opus" | "alac",
                  );
                } else {
                  await copyOrLink(trackPath, destPath, hardlink);
                }
                // Record for subsequent hardlinks
                if (suffix !== null) {
                  firstCopyPaths.set(trackPath, destPath);
                }
                logDebug(`Created first copy: ${destPath}`);
              } else {
                // Subsequent copies: hardlink from first copy
                const firstCopyPath = firstCopyPaths.get(trackPath);
                if (firstCopyPath) {
                  await link(firstCopyPath, destPath);
                  logDebug(`Hardlinked from first copy: ${destPath}`);
                } else {
                  // Fallback: copy from source if first copy not available
                  if (convertFormat) {
                    await convertFile(
                      trackPath,
                      destPath,
                      convertFormat as "mp3" | "aac" | "opus" | "alac",
                    );
                  } else {
                    await copyOrLink(trackPath, destPath, hardlink);
                  }
                  logDebug(`Fallback copy: ${destPath}`);
                }
              }

              result.created++;

              // Sync rating to destination file if enabled
              if (syncRatings && track.rating !== null && track.rating > 0) {
                const syncResult = await syncTrackRating(destPath, track.rating * 10, {
                  popmEmail,
                  vorbisScale,
                  dryRun,
                });
                if (!syncResult.success && !syncResult.skipped) {
                  logDebug(`Rating sync failed for ${destPath}: ${syncResult.message}`);
                }
              }

              result.totalSize += fileSize;
              progressBar?.updateFile(fileSize);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logDebug(`Failed to process ${trackPath} -> ${destPath}: ${message}`);

            const failedOp: FailedOperation = {
              path: trackPath,
              message,
            };

            if (error instanceof Error && "code" in error) {
              failedOp.code = (error as NodeJS.ErrnoException).code;
            }

            result.failed.push(failedOp);
          }
        }
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

  // Trigger Plex scan after export (if configured and not dry-run)
  if (plexScan !== false && !dryRun && result.created > 0) {
    const { adapter: scanAdapter } = resolveOptionalScanAdapter({ plexScan });

    if (scanAdapter?.capabilities.scan) {
      const scanResult = await scanAdapter.scan.trigger();
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
}

/**
 * Builds the expected destination path for a track.
 *
 * Used by sync operations to compute the set of expected files.
 *
 * @param track - The Plex track
 * @param destination - Base destination directory
 * @param preserveStructure - Whether to preserve artist/album folders
 * @param convertFormat - Optional conversion format affecting extension
 * @param usedNames - Map for tracking unique names in flat mode (only used when suffix is null)
 * @param suffix - Optional suffix to append to filename (e.g., '001')
 * @returns Expected destination path for this track
 */
function buildExpectedDestPath(
  track: MediaTrack,
  destination: string,
  preserveStructure: boolean,
  convertFormat: ConvertFormat | undefined,
  usedNames: Map<string, number>,
  suffix: string | null = null,
): string {
  const originalFilename = path.basename(track.filePath);
  let destFilename = getDestFilename(originalFilename, convertFormat);

  // Add suffix to filename if provided
  if (suffix !== null) {
    const ext = path.extname(destFilename);
    const baseName = path.basename(destFilename, ext);
    destFilename = `${baseName}-${suffix}${ext}`;
  }

  if (preserveStructure) {
    const { artistName, albumName } = extractPlexPathInfo(track.filePath);
    return path.join(destination, artistName, albumName, destFilename);
  } else {
    // Flat structure - need to handle duplicates only when no suffix
    if (suffix === null) {
      return getUniquePath(destination, destFilename, usedNames);
    } else {
      return path.join(destination, destFilename);
    }
  }
}

/**
 * Execute a playlist sync operation.
 *
 * Syncs a Plex playlist to the destination folder. This performs an export
 * operation and optionally removes files that are no longer in the playlist.
 *
 * @param options - Sync options including playlist name, destination, and deleteRemoved flag
 * @returns Sync result with metrics including removed file count
 * @throws Error if playlist not found or Plex configuration invalid
 *
 * @example
 * // Sync a playlist, removing tracks no longer in it
 * const result = await executePlaylistSync({
 *   playlistName: 'My Favorites',
 *   destination: '/music/exports/favorites',
 *   deleteRemoved: true,
 * });
 *
 * @example
 * // Sync with preview mode
 * const result = await executePlaylistSync({
 *   playlistName: 'My Favorites',
 *   destination: '/music/exports/favorites',
 *   deleteRemoved: true,
 *   dryRun: true,
 * });
 */
export async function executePlaylistSync(
  options: PlaylistSyncOptions,
): Promise<PlaylistExportResult> {
  const {
    playlistName,
    destination,
    deleteRemoved = false,
    preserveStructure = false,
    flat = false,
    folder,
    convertFormat,
    dryRun = false,
    range,
    count,
  } = options;

  // First, perform the export operation
  const result = await executePlaylistExport(options);

  // If deleteRemoved is not enabled, return the export result as-is
  if (!deleteRemoved) {
    return result;
  }

  // Load config to get Plex settings for fetching tracks
  const config = getLoadedConfig();

  const mediaServerAdapter = resolveRequiredMediaServerAdapter({});

  // Find playlist and get current tracks
  logDebug(`Fetching current playlist tracks for sync comparison`);
  const playlist = await mediaServerAdapter.playlist.byName(playlistName);
  const tracks = await mediaServerAdapter.playlist.tracks(playlist.id);

  // Compute effective destination path (must match export logic)
  let effectiveDestination = destination;
  if (!flat) {
    const folderName = folder
      ? sanitizeForFilesystem(folder)
      : sanitizeForFilesystem(playlist.title);
    effectiveDestination = path.join(destination, folderName);
  }

  // Determine effective range for sync (must match export logic)
  let effectiveRange: CopyRange | undefined;

  if (range) {
    effectiveRange = range;
  } else if (count !== undefined && count > 0) {
    const detection = await detectHighestFileSuffix(effectiveDestination);
    const highestSuffix = detection?.highestSuffix ?? 0;
    const padWidth = detection?.padWidth ?? 3;
    effectiveRange = buildAutoRange(count, highestSuffix, padWidth);
  }

  // Build suffix array (null = no suffix)
  const suffixes: Array<string | null> = effectiveRange
    ? Array.from({ length: effectiveRange.end - effectiveRange.start + 1 }, (_, i) =>
        formatSuffix(effectiveRange!.start + i, effectiveRange!.padWidth),
      )
    : [null];

  // Build set of expected destination paths from current playlist tracks
  // We need to simulate the same path-building logic used during export
  const expectedPaths = new Set<string>();

  // Sort tracks by opaque ID for deterministic suffix assignment
  // This matches the sorting done in executePlaylistExport for flat structure mode
  const sortedTracks = [...tracks].sort((a, b) => a.id.localeCompare(b.id));

  // Iterate over all suffixes, resetting usedNames for each suffix iteration
  for (const suffix of suffixes) {
    const usedNames = new Map<string, number>();
    for (const track of sortedTracks) {
      const expectedPath = buildExpectedDestPath(
        track,
        effectiveDestination,
        preserveStructure,
        convertFormat,
        usedNames,
        suffix,
      );
      expectedPaths.add(expectedPath);
    }
  }

  logDebug(
    `Built ${expectedPaths.size} expected destination paths (${suffixes.length} suffix${suffixes.length === 1 ? "" : "es"})`,
  );

  // Scan destination directory for existing audio files
  let existingFiles: string[] = [];
  try {
    if (await pathExists(effectiveDestination)) {
      existingFiles = await findAudioFiles(effectiveDestination);
      logDebug(`Found ${existingFiles.length} existing audio files in destination`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to scan destination directory: ${message}`);
    return result;
  }

  // Identify files to remove: existing files NOT in expected set
  const filesToRemove = existingFiles.filter((file) => !expectedPaths.has(file));

  if (filesToRemove.length === 0) {
    logDebug("No files to remove - destination is in sync");
    result.removed = 0;
    return result;
  }

  logDebug(`Identified ${filesToRemove.length} files to remove`);

  // Remove files that are no longer in the playlist
  let removedCount = 0;

  for (const filePath of filesToRemove) {
    try {
      if (dryRun) {
        logInfo(formatDryRun(`remove: ${filePath}`));
        removedCount++;
      } else {
        await remove(filePath);
        logDebug(`Removed: ${filePath}`);
        removedCount++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to remove ${filePath}: ${message}`);

      const failedOp: FailedOperation = {
        path: filePath,
        message: `Failed to remove: ${message}`,
      };

      if (error instanceof Error && "code" in error) {
        failedOp.code = (error as NodeJS.ErrnoException).code;
      }

      result.failed.push(failedOp);
    }
  }

  result.removed = removedCount;

  // Log removal summary
  if (!isJsonMode() && removedCount > 0) {
    if (dryRun) {
      logDebug(`[DRY RUN] Would remove ${removedCount} files no longer in playlist`);
    } else {
      logSuccess(`Removed ${removedCount} files no longer in playlist`);
    }
  }

  return result;
}

// =============================================================================
// Playlist Create Helper Functions
// =============================================================================

/**
 * Loads a named filter from the plexFilters configuration section.
 *
 * @param filterName - Name of the filter to load from config.plexFilters
 * @returns The loaded provider-neutral media filter
 * @throws Error if the filter is not found, listing available filters
 */
function loadNamedFilter(filterName: string): MediaFilter {
  const config = getLoadedConfig();
  const filters = config?.plexFilters;
  if (!filters || !(filterName in filters)) {
    const available = filters ? Object.keys(filters).join(", ") : "none";
    throw new Error(
      `Filter "${filterName}" not found in plexFilters config. Available: ${available}`,
    );
  }
  const filter = filters[filterName];
  if (!filter) {
    throw new Error(`Filter "${filterName}" is undefined in plexFilters config.`);
  }
  logDebug(`Loaded Plex filter: ${filterName}`);
  return filter;
}

/**
 * Parses compatibility CLI query options into a provider-neutral filter.
 *
 * @param options - Query options with filter fields (library/type optional; action supplies them)
 * @returns A conjunctive media filter, or undefined if no filters were provided
 */
function parseFilterOptions(
  options?: PlaylistCreateOptions["queryOptions"],
): MediaFilter | undefined {
  if (!options) return undefined;

  const rules: MediaFilterRule[] = [];
  const addTextRule = (field: MediaFilterRule["field"], value: string | undefined): void => {
    if (value !== undefined && value !== "") {
      rules.push({ type: "rule", field, operator: "contains", value });
    }
  };
  const addNumberRule = (
    field: MediaFilterRule["field"],
    operator: MediaFilterRule["operator"],
    value: number | undefined,
  ): void => {
    if (value !== undefined) {
      rules.push({ type: "rule", field, operator, value });
    }
  };

  addTextRule("genre", options.genre);
  addTextRule("style", options.style);
  addTextRule("mood", options.mood);
  addTextRule("artist", options.artist);
  addTextRule("title", options.title);
  addTextRule("album", options.album);
  addNumberRule("year", "==", options.year);
  addNumberRule("minYear", ">=", options.minYear);
  addNumberRule("maxYear", "<=", options.maxYear);
  addNumberRule("artistRating", ">=", options.minArtistRating);
  addNumberRule("artistRating", "<=", options.maxArtistRating);
  addNumberRule("albumRating", ">=", options.minAlbumRating);
  addNumberRule("albumRating", "<=", options.maxAlbumRating);
  addNumberRule("trackRating", ">=", options.minTrackRating);
  addNumberRule("trackRating", "<=", options.maxTrackRating);
  addNumberRule("minPlays", ">=", options.minPlays);

  return rules.length > 0 ? { match: "all", rules } : undefined;
}

function combineFilters(
  compatibilityFilter: MediaFilter | undefined,
  namedFilter: MediaFilter | undefined,
): MediaFilter | undefined {
  if (!compatibilityFilter) return namedFilter;
  if (!namedFilter) return compatibilityFilter;

  return {
    match: "all",
    rules: [
      ...compatibilityFilter.rules,
      { type: "group", match: namedFilter.match, rules: namedFilter.rules },
    ],
    library: namedFilter.library,
    type: namedFilter.type,
    limit: namedFilter.limit,
  };
}

/**
 * Queries all tracks from Plex library matching filters, with pagination.
 *
 * Provider-specific pushdown and residual filtering remain encapsulated by the adapter.
 *
 * @param mediaServerAdapter - Resolved media server adapter
 * @param library - Library name
 * @param filter - Provider-neutral filter expression
 * @param limit - Maximum number of tracks to return (undefined = no limit)
 * @returns Array of matched tracks
 */
async function queryTracksWithFilters(
  mediaServerAdapter: MediaServerAdapter,
  library: string,
  filter: MediaFilter,
  limit?: number,
): Promise<readonly MediaTrack[]> {
  const PAGE_SIZE = 500;
  const filterType = filter.type ?? "track";

  if (filterType === "album") {
    logDebug(`Using album-based filtering (filter type: album)`);
    const allAlbums: MediaAlbum[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await mediaServerAdapter.query.albums({
        kind: "album",
        library,
        filter,
        offset,
        limit: PAGE_SIZE,
      });
      allAlbums.push(...page.items);
      hasMore = page.hasMore;
      if (hasMore) {
        offset = advancePaginationOffset(page, "albums");
        logDebug(`Fetched ${allAlbums.length} albums so far, continuing...`);
      }
    }

    logDebug(`Found ${allAlbums.length} albums matching filter, fetching tracks...`);

    const allTracks: MediaTrack[] = [];
    for (const album of allAlbums) {
      const albumTracks = await mediaServerAdapter.query.albumTracks(album.id);
      allTracks.push(...albumTracks);
      logDebug(`Album "${album.title}" by ${album.artist}: ${albumTracks.length} tracks`);
    }

    logDebug(`Total tracks from ${allAlbums.length} albums: ${allTracks.length}`);

    // Apply limit after fetching all results
    if (limit !== undefined && allTracks.length > limit) {
      logDebug(`Limiting results from ${allTracks.length} to ${limit}`);
      return allTracks.slice(0, limit);
    }

    return allTracks;
  }

  const allTracks: MediaTrack[] = [];
  let offset = 0;
  let hasMore = true;
  logDebug(`Querying tracks with pagination (limit: ${limit ?? "none"})`);

  while (hasMore) {
    if (limit !== undefined && allTracks.length >= limit) break;
    const page = await mediaServerAdapter.query.tracks({
      kind: "track",
      library,
      filter,
      offset,
      limit: PAGE_SIZE,
    });
    allTracks.push(...page.items);
    hasMore = page.hasMore;
    if (hasMore) {
      offset = advancePaginationOffset(page, "tracks");
      logDebug(`Fetched ${allTracks.length} tracks so far, continuing...`);
    }
  }

  if (limit !== undefined && allTracks.length > limit) {
    logDebug(`Limiting results from ${allTracks.length} to ${limit}`);
    return allTracks.slice(0, limit);
  }

  logDebug(`Total tracks fetched: ${allTracks.length}`);
  return allTracks;
}

/**
 * Extracts opaque media-server identifiers from tracks.
 *
 * @param items - Array of tracks
 * @returns Array of track identifiers
 */
function extractTrackIds(items: readonly MediaTrack[]): string[] {
  return items.map((item) => item.id);
}

// =============================================================================
// Playlist Create Action
// =============================================================================

/**
 * Creates a new Plex playlist from filtered tracks.
 *
 * Supports both static playlists (explicit track references) and smart playlists
 * (filter-based, auto-updating). Can optionally update an existing playlist
 * if one with the same name already exists.
 *
 * @param options - Options for playlist creation
 * @returns Result containing playlist info and track count
 * @throws Error if Plex configuration is invalid, library not found, or filter returns no tracks
 *
 * @example
 * // Create a playlist from genre filter
 * const result = await executePlaylistCreate({
 *   playlistName: 'Jazz Favorites',
 *   libraryName: 'Music',
 *   queryOptions: { genre: 'Jazz', minTrackRating: 4 },
 * });
 *
 * @example
 * // Create using a named filter from config
 * const result = await executePlaylistCreate({
 *   playlistName: 'Rock 2020s',
 *   filterName: 'rock-2020s',
 * });
 */
export async function executePlaylistCreate(
  options: PlaylistCreateOptions,
): Promise<PlaylistCreateResult> {
  // Build API config with CLI overrides
  const plexConfig = resolveRequiredMediaServerAdapter({
    plexUrl: options.url,
    plexToken: options.token,
  });

  // Load config for defaults
  const config = getLoadedConfig();
  const playlistDefaults = config?.plex?.playlistDefaults ?? {};

  // Apply defaults from config, then CLI overrides
  const smart = options.smart ?? playlistDefaults.smart ?? false;
  const updateExisting = options.updateExisting ?? playlistDefaults.updateExisting ?? false;

  // Load named filter if provided
  const plexFilter = options.filterName ? loadNamedFilter(options.filterName) : undefined;

  // Determine library: CLI option takes precedence over filter default
  const libraryName = options.libraryName ?? plexFilter?.library;

  // Library is required for playlist creation
  if (!libraryName) {
    throw new Error("Library name is required. Use --library <name> or specify in filter");
  }

  logDebug(`Creating playlist "${options.playlistName}" in library "${libraryName}"`);

  // Resolve library name to section ID (validates it exists)
  const library = await plexConfig.library.byName(libraryName);

  logDebug(`Resolved library "${libraryName}" to key: ${library.id}`);

  // Parse filter options from queryOptions
  const filterOptions = parseFilterOptions(options.queryOptions);

  // Determine if we should query for items (either CLI filters or named filter)
  const hasFilters = filterOptions !== undefined || plexFilter !== undefined;

  if (!hasFilters) {
    throw new Error(
      "No filters provided. Use filter options (--genre, --artist, etc.) or --filter <name> to select tracks",
    );
  }

  logInfo("Querying library with filters...");

  // Build filters object: use parsed CLI options or empty object if only named filter
  const filter = combineFilters(filterOptions, plexFilter);
  if (!filter) {
    throw new Error("No filters provided");
  }

  // Query tracks with pagination and hybrid filtering (maxTracks = global cap, not per-page)
  const tracks = await queryTracksWithFilters(plexConfig, libraryName, filter, options.maxTracks);

  if (tracks.length === 0) {
    throw new Error(
      "Filter returned no matching tracks. Playlist not created to avoid empty playlist.",
    );
  }

  const trackIds = extractTrackIds(tracks);
  logInfo(`Found ${trackIds.length} tracks matching filters`);

  // Check if playlist already exists
  let existingPlaylist: MediaPlaylist | undefined;
  try {
    existingPlaylist = await plexConfig.playlist.byName(options.playlistName);
    logDebug(`Found existing playlist: "${existingPlaylist.title}" (key: ${existingPlaylist.id})`);
  } catch {
    // Playlist doesn't exist - this is fine for create
    logDebug(`No existing playlist named "${options.playlistName}"`);
  }

  // Handle collision: if exists and !updateExisting, throw error
  if (existingPlaylist && !updateExisting) {
    throw new Error(
      `Playlist "${options.playlistName}" already exists. Use --update-existing to add tracks to it.`,
    );
  }

  // Handle dry-run: output what would be created and return early
  if (options.dryRun) {
    const action = existingPlaylist ? "updated" : "created";
    if (!options.json) {
      logInfo(
        formatDryRun(
          `${action === "created" ? "create" : "update"} playlist "${options.playlistName}" with ${trackIds.length} tracks (smart=${smart})`,
        ),
      );
    }

    return {
      playlistName: options.playlistName,
      ratingKey: existingPlaylist?.id ?? "dry-run",
      tracksAdded: trackIds.length,
      action,
      smart,
    };
  }

  let playlist: MediaPlaylist;
  let action: "created" | "updated";
  let initialTrackCount = 0;

  if (existingPlaylist) {
    // Update existing playlist by adding tracks
    playlist = existingPlaylist;
    action = "updated";
    initialTrackCount = (await plexConfig.playlist.tracks(existingPlaylist.id)).length;
    logDebug(`Updating existing playlist "${playlist.title}" (${initialTrackCount} tracks)`);
  } else {
    // Create new playlist
    playlist = await plexConfig.playlist.create(options.playlistName, { smart });
    action = "created";
    logSuccess(`Created playlist "${playlist.title}" (key: ${playlist.id})`);
  }

  // Add tracks to playlist (handles batching internally)
  logInfo(`Adding ${trackIds.length} tracks to playlist...`);
  await plexConfig.playlist.addTracks(playlist.id, trackIds);

  // Re-fetch playlist to get accurate count (add is idempotent; Plex may dedupe)
  const updatedTracks = await plexConfig.playlist.tracks(playlist.id);
  const tracksAdded = existingPlaylist
    ? updatedTracks.length - initialTrackCount
    : updatedTracks.length;
  logSuccess(`Added ${tracksAdded} tracks to playlist`);

  const result: PlaylistCreateResult = {
    playlistName: playlist.title,
    ratingKey: playlist.id,
    tracksAdded,
    action,
    smart: playlist.smart,
  };

  return result;
}

// =============================================================================
// Playlist Add Action
// =============================================================================

/**
 * Adds tracks to an existing Plex playlist.
 *
 * This action only adds tracks to existing playlists - it does not create new ones.
 * Use `executePlaylistCreate()` to create new playlists.
 *
 * @param options - Options for adding tracks to the playlist
 * @returns Result containing playlist info and track counts
 * @throws Error if Plex configuration is invalid, playlist not found, or filter returns no tracks
 *
 * @example
 * // Add tracks from filter to existing playlist
 * const result = await executePlaylistAdd({
 *   playlistName: 'Jazz Favorites',
 *   libraryName: 'Music',
 *   queryOptions: { artist: 'Miles Davis' },
 * });
 *
 * @example
 * // Add tracks using a named filter from config
 * const result = await executePlaylistAdd({
 *   playlistName: 'Rock 2020s',
 *   filterName: 'rock-2020s',
 * });
 */
export async function executePlaylistAdd(options: PlaylistAddOptions): Promise<PlaylistAddResult> {
  // Build API config with CLI overrides
  const plexConfig = resolveRequiredMediaServerAdapter({
    plexUrl: options.url,
    plexToken: options.token,
  });

  // Load named filter if provided
  const plexFilter = options.filterName ? loadNamedFilter(options.filterName) : undefined;

  // Determine library: CLI option takes precedence over filter default
  const libraryName = options.libraryName ?? plexFilter?.library;

  // Library is required for adding tracks
  if (!libraryName) {
    throw new Error("Library name is required. Use --library <name> or specify in filter");
  }

  logDebug(`Adding tracks to playlist "${options.playlistName}" from library "${libraryName}"`);

  // Resolve library name to section ID (validates it exists)
  const library = await plexConfig.library.byName(libraryName);

  logDebug(`Resolved library "${libraryName}" to key: ${library.id}`);

  // Find existing playlist - throw if not found
  let existingPlaylist: MediaPlaylist;
  try {
    existingPlaylist = await plexConfig.playlist.byName(options.playlistName);
    logDebug(`Found playlist: "${existingPlaylist.title}" (key: ${existingPlaylist.id})`);
  } catch {
    throw new Error(
      `Playlist "${options.playlistName}" not found. Use "plex playlist create" to create a new playlist.`,
    );
  }

  // Get current track count from existing playlist
  const currentTracks = await plexConfig.playlist.tracks(existingPlaylist.id);
  const currentTrackCount = currentTracks.length;
  logDebug(`Playlist currently has ${currentTrackCount} tracks`);

  // Parse filter options from queryOptions
  const filterOptions = parseFilterOptions(options.queryOptions);

  // Determine if we should query for items (either CLI filters or named filter)
  const hasFilters = filterOptions !== undefined || plexFilter !== undefined;

  if (!hasFilters) {
    throw new Error(
      "No filters provided. Use filter options (--genre, --artist, etc.) or --filter <name> to select tracks",
    );
  }

  logInfo("Querying library with filters...");

  // Build filters object: use parsed CLI options or empty object if only named filter
  const filter = combineFilters(filterOptions, plexFilter);
  if (!filter) {
    throw new Error("No filters provided");
  }

  // Query tracks with pagination and hybrid filtering (maxTracks = global cap, not per-page)
  const tracks = await queryTracksWithFilters(plexConfig, libraryName, filter, options.maxTracks);

  if (tracks.length === 0) {
    throw new Error("Filter returned no matching tracks. No tracks added to playlist.");
  }

  const trackIds = extractTrackIds(tracks);
  logInfo(`Found ${trackIds.length} tracks matching filters`);

  // Handle dry-run: output what would be added and return early (dry-run uses estimate)
  if (options.dryRun) {
    const estimatedTotal = currentTrackCount + trackIds.length;
    if (!options.json) {
      logInfo(
        formatDryRun(
          `add ${trackIds.length} tracks to playlist "${options.playlistName}" (total: ${estimatedTotal})`,
        ),
      );
    }

    return {
      playlistName: existingPlaylist.title,
      ratingKey: existingPlaylist.id,
      tracksAdded: trackIds.length,
      totalTracks: estimatedTotal,
    };
  }

  // Add tracks to playlist (handles batching internally)
  logInfo(`Adding ${trackIds.length} tracks to playlist...`);
  await plexConfig.playlist.addTracks(existingPlaylist.id, trackIds);

  // Re-fetch playlist to get accurate count (add is idempotent; Plex may dedupe)
  const updatedTracks = await plexConfig.playlist.tracks(existingPlaylist.id);
  const totalTracks = updatedTracks.length;
  const tracksAdded = totalTracks - currentTrackCount;
  logSuccess(
    `Added ${tracksAdded} tracks to playlist "${existingPlaylist.title}" (total: ${totalTracks})`,
  );

  const result: PlaylistAddResult = {
    playlistName: existingPlaylist.title,
    ratingKey: existingPlaylist.id,
    tracksAdded,
    totalTracks,
  };

  return result;
}
