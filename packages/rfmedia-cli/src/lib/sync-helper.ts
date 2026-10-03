/**
 * Sync helper for rating synchronization during copy operations.
 *
 * Provides a reusable function to sync Plex ratings to file metadata
 * during copy operations. Designed to never throw - failures are returned
 * as results to allow copy operations to continue.
 *
 * @module lib/sync-helper
 */

import { plexToNormalized } from "./ratings.js";
import { writeRating, type WriteRatingOptions } from "./tag-writer.js";
import { logDebug, formatDryRun, logInfo } from "./logger.js";

/**
 * Options for syncing a track rating.
 */
export interface SyncTrackRatingOptions {
  /** POPM email identifier for MP3 files (default: 'no@email') */
  popmEmail?: string;
  /** Vorbis rating scale: 'normalized' (0-1), 'stars' (0-5), 'percent' (0-100) */
  vorbisScale?: "normalized" | "stars" | "percent";
  /** Preview mode - logs intent without writing */
  dryRun?: boolean;
}

/**
 * Result of a track rating sync operation.
 */
export interface SyncTrackRatingResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Reason if skipped (e.g., 'unrated') */
  skipped?: string;
  /** Error message if failed */
  message?: string;
}

/**
 * Sync a Plex rating to a file's metadata.
 *
 * Converts Plex 0-10 rating to normalized 0-1 and writes using writeRating().
 * Returns success/failure without throwing - failures should not stop copy operations.
 *
 * @param destPath - Path to the destination file
 * @param plexRating - Plex rating (0-10 scale, 0 means unrated)
 * @param options - Optional settings for the sync operation
 * @returns Result of the sync operation
 *
 * @example
 * const result = await syncTrackRating('/path/to/dest.mp3', 8, { dryRun: false });
 * if (!result.success && !result.skipped) {
 *   logDebug(`Rating sync failed: ${result.message}`);
 * }
 */
export async function syncTrackRating(
  destPath: string,
  plexRating: number,
  options: SyncTrackRatingOptions = {},
): Promise<SyncTrackRatingResult> {
  const { popmEmail, vorbisScale, dryRun = false } = options;

  // Skip unrated tracks (0 means unrated in Plex, not zero stars)
  if (plexRating === 0) {
    return { success: true, skipped: "unrated" };
  }

  // In dry-run mode, log intent and return success
  if (dryRun) {
    const normalizedRating = plexToNormalized(plexRating);
    logInfo(formatDryRun(`Would sync rating ${normalizedRating.toFixed(2)} to ${destPath}`));
    return { success: true };
  }

  try {
    // Convert Plex rating (0-10) to normalized (0-1)
    const normalizedRating = plexToNormalized(plexRating);

    // Write rating to file
    const writeResult = await writeRating(destPath, normalizedRating, {
      popmEmail,
      vorbisScale,
    } as WriteRatingOptions);

    if (!writeResult.success) {
      return { success: false, message: writeResult.message };
    }

    logDebug(`Synced rating ${normalizedRating.toFixed(2)} to ${destPath}`);
    return { success: true };
  } catch (error) {
    // Catch any unexpected errors - sync failures should not stop copy operations
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message };
  }
}
