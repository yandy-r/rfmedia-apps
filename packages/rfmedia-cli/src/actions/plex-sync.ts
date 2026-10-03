/**
 * Plex metadata sync action.
 *
 * Implements bidirectional rating synchronization between file tags and Plex.
 * Supports three sync directions:
 * - push: File ratings -> Plex
 * - pull: Plex ratings -> File
 * - both: Bidirectional with conflict resolution
 *
 * @module actions/plex-sync
 */

import { findAudioFiles } from "../lib/audio.js";
import { pathExists } from "../lib/filesystem.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { logDebug, logInfo, logWarn, formatDryRun } from "../lib/logger.js";
import { processInParallel } from "../lib/parallel.js";
import { resolveRequiredMediaServerAdapter } from "../lib/adapters/action-helpers.js";
import { advancePaginationOffset } from "../lib/pagination.js";
import { readRating } from "../lib/ratings.js";
import { writeRating } from "../lib/tag-writer.js";

import type { MetadataSyncOptions, MetadataSyncResult } from "../types/plex.js";
import type {
  MediaServerAdapter,
  MediaServerNativeRatingScale,
  MediaTrack,
} from "../types/media-server.js";

/**
 * Default page size for Plex queries.
 * Large value to minimize API calls when fetching all tracks.
 */
const DEFAULT_PAGE_SIZE = 500;

/**
 * Compares normalized ratings at the precision representable by the server.
 *
 * The adapter owns native conversion, but its feature metadata lets the action
 * avoid repeatedly writing normalized file values that map to the same native
 * rating step. A null server rating shares the native minimum step with zero.
 */
function ratingsShareNativeStep(
  fileRating: number,
  serverRating: number | null,
  scale: MediaServerNativeRatingScale,
): boolean {
  const span = scale.max - scale.min;
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(scale.step) || scale.step <= 0) {
    return fileRating === serverRating;
  }

  const stepFor = (rating: number | null): number =>
    Math.round(((rating ?? 0) * span) / scale.step);
  return stepFor(fileRating) === stepFor(serverRating);
}

/**
 * Fetches all tracks from a Plex library, handling pagination.
 *
 * @param plexConfig - Plex server configuration
 * @param library - Library name to query
 * @returns Array of all tracks in the library
 */
async function fetchAllPlexTracks(
  adapter: MediaServerAdapter,
  library: string,
): Promise<MediaTrack[]> {
  const allTracks: MediaTrack[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await adapter.query.tracks({
      library,
      kind: "track",
      limit: DEFAULT_PAGE_SIZE,
      offset,
    });

    allTracks.push(...page.items);
    hasMore = page.hasMore;

    if (hasMore) {
      offset = advancePaginationOffset(page, "tracks");
    }

    if (hasMore) {
      logDebug(`Fetched ${allTracks.length}/${page.total} tracks...`);
    }
  }

  return allTracks;
}

/**
 * Execute a metadata sync operation.
 *
 * Orchestrates the sync based on direction type, routing to the appropriate
 * implementation function.
 *
 * @param options - Sync configuration options
 * @returns Result of the sync operation
 */
export async function executeMetadataSync(
  options: MetadataSyncOptions,
): Promise<MetadataSyncResult> {
  const config = getLoadedConfig();
  const plexConfigOptions = config?.plex ?? {};
  const syncDefaults = plexConfigOptions.syncDefaults ?? {};

  const {
    direction,
    library,
    sourcePath,
    onlyRated = syncDefaults.onlyRated ?? false,
    dryRun = false,
    workers = config?.copy?.workers ?? 4,
    progress = config?.copy?.progress ?? true,
  } = options;

  const plexConfig = resolveRequiredMediaServerAdapter({
    plexUrl: plexConfigOptions.url,
    plexToken: plexConfigOptions.token,
    plexLibrary: plexConfigOptions.libraryName,
  });

  switch (direction.type) {
    case "push":
      return executePushSync(sourcePath, library, plexConfig, {
        onlyRated,
        dryRun,
        workers,
        progress,
      });
    case "pull":
      return executePullSync(sourcePath, library, plexConfig, {
        onlyRated,
        dryRun,
        workers,
        progress,
        popmEmail: options.popmEmail ?? syncDefaults.popmEmail,
        vorbisScale: options.vorbisScale ?? syncDefaults.vorbisScale,
      });
    case "both":
      return executeBidirectionalSync(sourcePath, library, plexConfig, {
        prefer: direction.prefer,
        onlyRated,
        dryRun,
        workers,
        progress,
        popmEmail: options.popmEmail ?? syncDefaults.popmEmail,
        vorbisScale: options.vorbisScale ?? syncDefaults.vorbisScale,
      });
    default: {
      const _exhaustive: never = direction;
      throw new Error(`Unknown sync direction: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Push file ratings to Plex.
 *
 * Scans local audio files, reads their embedded ratings, and updates
 * the corresponding Plex tracks. Only updates tracks where ratings differ.
 *
 * @param sourcePath - Path to scan for audio files
 * @param library - Plex library name
 * @param plexConfig - Plex server configuration
 * @param options - Sync operation options
 * @returns Result of the sync operation
 */
async function executePushSync(
  sourcePath: string,
  library: string,
  plexConfig: MediaServerAdapter,
  options: {
    onlyRated: boolean;
    dryRun: boolean;
    workers: number;
    progress: boolean;
  },
): Promise<MetadataSyncResult> {
  const { onlyRated, dryRun, workers, progress } = options;

  const result: MetadataSyncResult = {
    totalTracks: 0,
    synced: 0,
    skipped: 0,
    conflicts: 0,
    failed: [],
  };

  // Find local audio files
  logInfo(`Scanning ${sourcePath} for audio files...`);
  const localFiles = await findAudioFiles(sourcePath);
  logInfo(`Found ${localFiles.length} audio files`);

  // Query Plex tracks
  logInfo(`Querying Plex library "${library}"...`);
  const plexTracks = await fetchAllPlexTracks(plexConfig, library);
  logInfo(`Found ${plexTracks.length} tracks in Plex`);

  // Create lookup map by file path
  const plexTracksByPath = new Map<string, MediaTrack>();
  for (const track of plexTracks) {
    if (track.filePath) {
      plexTracksByPath.set(track.filePath, track);
    }
  }

  // Filter to matched files
  const matchedFiles: Array<{ filePath: string; plexTrack: MediaTrack }> = [];
  for (const filePath of localFiles) {
    const plexTrack = plexTracksByPath.get(filePath);
    if (plexTrack) {
      matchedFiles.push({ filePath, plexTrack });
    }
  }

  logInfo(`Matched ${matchedFiles.length} files to Plex tracks`);
  result.totalTracks = matchedFiles.length;

  if (matchedFiles.length === 0) {
    logWarn("No files matched to Plex tracks. Check that file paths match.");
    return result;
  }

  // Process in parallel
  const parallelResults = await processInParallel(
    matchedFiles,
    async ({ filePath, plexTrack }, _index, signal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // Read file rating
      const fileRating = await readRating(filePath);

      if (fileRating === null) {
        if (onlyRated) {
          return { action: "skipped" as const, reason: "no rating in file" };
        }
        // No rating in file - nothing to push
        return { action: "skipped" as const, reason: "no rating in file" };
      }

      const rating = fileRating.value;
      const currentRating = plexTrack.rating;

      // Check if already in sync
      if (ratingsShareNativeStep(rating, currentRating, plexConfig.features.ratings.nativeScale)) {
        return { action: "skipped" as const, reason: "already in sync" };
      }

      if (dryRun) {
        logInfo(
          formatDryRun(`Would update ${plexTrack.title}: ${currentRating ?? 0} -> ${rating}`),
        );
        return { action: "synced" as const };
      }

      // Update Plex rating
      const updateResult = await plexConfig.metadata.updateTrackRating(plexTrack.id, rating);

      if (!updateResult.success) {
        throw new Error(updateResult.message);
      }

      return { action: "synced" as const };
    },
    {
      workers,
      onProgress: (completed, total) => {
        if (progress && !dryRun) {
          // Simple text-based progress for non-byte operations
          logDebug(`Progress: ${completed}/${total} tracks processed`);
        }
      },
    },
  );

  // Aggregate results
  for (let i = 0; i < parallelResults.length; i++) {
    const parallelResult = parallelResults[i];
    if (parallelResult === undefined) continue;

    if (parallelResult.success && parallelResult.value) {
      if (parallelResult.value.action === "synced") {
        result.synced++;
      } else {
        result.skipped++;
      }
    } else if (!parallelResult.success && parallelResult.error) {
      const matchedFile = matchedFiles[parallelResult.index];
      if (matchedFile) {
        result.failed.push({
          path: matchedFile.filePath,
          message: parallelResult.error.message,
        });
      }
    }
  }

  return result;
}

/**
 * Pull Plex ratings to files.
 *
 * Queries Plex for tracks with ratings and writes them to the corresponding
 * local files. Only updates files where ratings differ from current embedded tags.
 *
 * @param sourcePath - Path to scan for audio files
 * @param library - Plex library name
 * @param plexConfig - Plex server configuration
 * @param options - Sync operation options
 * @returns Result of the sync operation
 */
async function executePullSync(
  sourcePath: string,
  library: string,
  plexConfig: MediaServerAdapter,
  options: {
    onlyRated: boolean;
    dryRun: boolean;
    workers: number;
    progress: boolean;
    popmEmail?: string;
    vorbisScale?: "normalized" | "stars" | "percent";
  },
): Promise<MetadataSyncResult> {
  const { onlyRated, dryRun, workers, progress, popmEmail, vorbisScale } = options;

  const result: MetadataSyncResult = {
    totalTracks: 0,
    synced: 0,
    skipped: 0,
    conflicts: 0,
    failed: [],
  };

  // Query Plex tracks with ratings
  logInfo(`Querying Plex library "${library}" for rated tracks...`);
  const plexTracks = await fetchAllPlexTracks(plexConfig, library);
  logInfo(`Found ${plexTracks.length} tracks in Plex`);

  // Filter to tracks with ratings if onlyRated is set
  const tracksWithRatings = onlyRated
    ? plexTracks.filter((track) => track.rating !== null)
    : plexTracks;

  if (onlyRated) {
    logInfo(`${tracksWithRatings.length} tracks have ratings in Plex`);
  }

  // Filter to tracks with files in sourcePath (existence check happens in parallel worker)
  const tracksToSync = tracksWithRatings.filter(
    (track) => track.filePath && track.filePath.startsWith(sourcePath),
  );

  logInfo(`${tracksToSync.length} tracks match source path`);
  result.totalTracks = tracksToSync.length;

  if (tracksToSync.length === 0) {
    logWarn("No tracks found to sync. Check that file paths match.");
    return result;
  }

  // Process in parallel
  const parallelResults = await processInParallel(
    tracksToSync,
    async (plexTrack, _index, signal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // Check file exists (parallelized across workers)
      const exists = await pathExists(plexTrack.filePath!);
      if (!exists) {
        logDebug(`File not found: ${plexTrack.filePath}`);
        return { action: "skipped" as const, reason: "file not found" };
      }

      const plexRating = plexTrack.rating;

      if (plexRating === null) {
        return { action: "skipped" as const, reason: "no rating in Plex" };
      }

      // Read current file rating
      const currentFileRating = await readRating(plexTrack.filePath!);

      // Check if already in sync (within tolerance for floating point)
      if (currentFileRating !== null && Math.abs(currentFileRating.value - plexRating) < 0.05) {
        return { action: "skipped" as const, reason: "already in sync" };
      }

      if (dryRun) {
        const currentValue = currentFileRating?.value ?? 0;
        logInfo(
          formatDryRun(
            `Would update ${plexTrack.filePath}: ${currentValue.toFixed(2)} -> ${plexRating.toFixed(2)}`,
          ),
        );
        return { action: "synced" as const };
      }

      // Write rating to file
      const writeResult = await writeRating(plexTrack.filePath!, plexRating, {
        popmEmail,
        vorbisScale,
      });

      if (!writeResult.success) {
        throw new Error(writeResult.message);
      }

      return { action: "synced" as const };
    },
    {
      workers,
      onProgress: (completed, total) => {
        if (progress && !dryRun) {
          logDebug(`Progress: ${completed}/${total} tracks processed`);
        }
      },
    },
  );

  // Aggregate results
  for (let i = 0; i < parallelResults.length; i++) {
    const parallelResult = parallelResults[i];
    if (parallelResult === undefined) continue;

    if (parallelResult.success && parallelResult.value) {
      if (parallelResult.value.action === "synced") {
        result.synced++;
      } else {
        result.skipped++;
      }
    } else if (!parallelResult.success && parallelResult.error) {
      const track = tracksToSync[parallelResult.index];
      if (track?.filePath) {
        result.failed.push({
          path: track.filePath,
          message: parallelResult.error.message,
        });
      }
    }
  }

  return result;
}

/**
 * Bidirectional sync with conflict resolution.
 *
 * Compares ratings between local files and Plex, syncing in both directions.
 * When both sources have different ratings, uses the `prefer` option to resolve.
 *
 * @param sourcePath - Path to scan for audio files
 * @param library - Plex library name
 * @param plexConfig - Plex server configuration
 * @param options - Sync operation options including conflict resolution preference
 * @returns Result of the sync operation
 */
async function executeBidirectionalSync(
  sourcePath: string,
  library: string,
  plexConfig: MediaServerAdapter,
  options: {
    prefer: "plex" | "file";
    onlyRated: boolean;
    dryRun: boolean;
    workers: number;
    progress: boolean;
    popmEmail?: string;
    vorbisScale?: "normalized" | "stars" | "percent";
  },
): Promise<MetadataSyncResult> {
  const { prefer, onlyRated, dryRun, workers, progress, popmEmail, vorbisScale } = options;

  const result: MetadataSyncResult = {
    totalTracks: 0,
    synced: 0,
    skipped: 0,
    conflicts: 0,
    failed: [],
  };

  // Find local audio files
  logInfo(`Scanning ${sourcePath} for audio files...`);
  const localFiles = await findAudioFiles(sourcePath);
  logInfo(`Found ${localFiles.length} audio files`);

  // Query Plex tracks
  logInfo(`Querying Plex library "${library}"...`);
  const plexTracks = await fetchAllPlexTracks(plexConfig, library);
  logInfo(`Found ${plexTracks.length} tracks in Plex`);

  // Create lookup map by file path
  const plexTracksByPath = new Map<string, MediaTrack>();
  for (const track of plexTracks) {
    if (track.filePath) {
      plexTracksByPath.set(track.filePath, track);
    }
  }

  // Build comparison list
  const comparisons: Array<{
    filePath: string;
    plexTrack: MediaTrack;
    fileRating: number | null;
    plexRating: number | null;
  }> = [];

  for (const filePath of localFiles) {
    const plexTrack = plexTracksByPath.get(filePath);
    if (!plexTrack) continue;

    const fileRatingData = await readRating(filePath);
    const fileRating = fileRatingData?.value ?? null;
    const plexRating = plexTrack.rating;

    if (onlyRated && fileRating === null && plexRating === null) {
      continue; // Skip unrated on both sides
    }

    comparisons.push({ filePath, plexTrack, fileRating, plexRating });
  }

  logInfo(`Processing ${comparisons.length} tracks for bidirectional sync`);
  result.totalTracks = comparisons.length;

  if (comparisons.length === 0) {
    logWarn("No tracks found to sync. Check that file paths match.");
    return result;
  }

  // Process in parallel
  const parallelResults = await processInParallel(
    comparisons,
    async (comparison, _index, signal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const { filePath, plexTrack, fileRating, plexRating } = comparison;

      // Case 1: Both unrated
      if (fileRating === null && plexRating === null) {
        return { action: "skipped" as const, isConflict: false };
      }

      // Case 2: Already in sync (within 0.05 tolerance)
      if (fileRating !== null && plexRating !== null && Math.abs(fileRating - plexRating) < 0.05) {
        return { action: "skipped" as const, isConflict: false };
      }

      // Case 3: Only file has rating -> push to Plex
      if (fileRating !== null && plexRating === null) {
        if (dryRun) {
          logInfo(formatDryRun(`Would push ${filePath}: file=${fileRating.toFixed(2)} -> Plex`));
          return { action: "synced" as const, isConflict: false };
        }
        const updateResult = await plexConfig.metadata.updateTrackRating(plexTrack.id, fileRating);
        if (!updateResult.success) throw new Error(updateResult.message);
        return { action: "synced" as const, isConflict: false };
      }

      // Case 4: Only Plex has rating -> pull to file
      if (fileRating === null && plexRating !== null) {
        if (dryRun) {
          logInfo(formatDryRun(`Would pull ${filePath}: Plex=${plexRating.toFixed(2)} -> file`));
          return { action: "synced" as const, isConflict: false };
        }
        const writeResult = await writeRating(filePath, plexRating, {
          popmEmail,
          vorbisScale,
        });
        if (!writeResult.success) throw new Error(writeResult.message);
        return { action: "synced" as const, isConflict: false };
      }

      // Case 5: Both have ratings but differ -> conflict resolution
      if (dryRun) {
        logInfo(
          formatDryRun(
            `Conflict: ${filePath} file=${fileRating!.toFixed(2)} plex=${plexRating!.toFixed(2)} -> using ${prefer}`,
          ),
        );
        return { action: "synced" as const, isConflict: true };
      }

      if (prefer === "plex") {
        // Write Plex rating to file
        const writeResult = await writeRating(filePath, plexRating!, {
          popmEmail,
          vorbisScale,
        });
        if (!writeResult.success) throw new Error(writeResult.message);
      } else {
        // Push file rating to Plex
        const updateResult = await plexConfig.metadata.updateTrackRating(plexTrack.id, fileRating!);
        if (!updateResult.success) throw new Error(updateResult.message);
      }

      return { action: "synced" as const, isConflict: true };
    },
    {
      workers,
      onProgress: (completed, total) => {
        if (progress && !dryRun) {
          logDebug(`Progress: ${completed}/${total} tracks processed`);
        }
      },
    },
  );

  // Aggregate results
  for (let i = 0; i < parallelResults.length; i++) {
    const parallelResult = parallelResults[i];
    if (parallelResult === undefined) continue;

    if (parallelResult.success && parallelResult.value) {
      if (parallelResult.value.action === "synced") {
        result.synced++;
        if (parallelResult.value.isConflict) {
          result.conflicts++;
        }
      } else {
        result.skipped++;
      }
    } else if (!parallelResult.success && parallelResult.error) {
      const comparison = comparisons[parallelResult.index];
      if (comparison) {
        result.failed.push({
          path: comparison.filePath,
          message: parallelResult.error.message,
        });
      }
    }
  }

  return result;
}
