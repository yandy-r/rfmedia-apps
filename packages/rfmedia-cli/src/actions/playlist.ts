/**
 * Playlist action handlers for rfmedia CLI.
 *
 * Provides functions for creating smart playlists from filters and Plex playlists.
 * These actions implement the business logic for the `playlist` command group.
 *
 * Smart playlists support two source types:
 * 1. Filter-based: Uses named SmartFilter from config, evaluated against local audio metadata
 * 2. Plex playlist-based: Fetches tracks from an existing Plex playlist via API (Task 2.3)
 */

import path from "node:path";

import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat, getOutputFormat } from "@rfmedia/common";

import { logDebug, logInfo, logWarn, logSuccess, logError, formatDryRun } from "../lib/logger.js";
import { pathExists, remove } from "../lib/filesystem.js";
import { confirm } from "../lib/prompt.js";
import { findAudioFiles } from "../lib/audio.js";
import { readExtendedMetadata } from "../lib/metadata.js";
import { evaluateSmartFilter } from "../lib/ratings.js";
import { sequenceTracks, type SeparationTrack } from "../lib/separation.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { processInParallel, getDefaultWorkers } from "../lib/parallel.js";
import { writeM3UPlaylist } from "../lib/m3u.js";
import {
  extractTrackFilePaths as getTrackFilePaths,
  resolveRequiredMediaServerAdapter,
} from "../lib/adapters/action-helpers.js";
import type { MediaServerAdapter, MediaTrack } from "../types/media-server.js";
import {
  initializeDatabase,
  createSmartPlaylist,
  recordPlaylistHistory,
  getSmartPlaylist,
  updateSmartPlaylist,
  listSmartPlaylists as listSmartPlaylistsDb,
  deleteSmartPlaylist as deleteSmartPlaylistDb,
  getSmartPlaylistHistory,
} from "../lib/db.js";
import type { DbConnection, DbSmartPlaylist, SmartPlaylistTrackInfo } from "../types/db.js";
import type {
  M3UPlaylistResult,
  M3UTrackInfo,
  PlaylistSource,
  PlaylistUpdateResult,
  PlaylistShowResult,
} from "../types/playlist.js";
import type { FailedOperation, SmartFilter, ConfigFile } from "../types/index.js";

// ============================================================================
// Options Interfaces
// ============================================================================

/**
 * Options for creating a playlist.
 */
export interface PlaylistCreateOptions {
  /** Display name for the playlist */
  name: string;
  /** Output file path for the M3U/M3U8 file */
  output: string;
  /** Named filter from config (mutually exclusive with plexPlaylist) */
  filter?: string;
  /** Plex playlist name (mutually exclusive with filter) */
  plexPlaylist?: string;
  /** Use relative paths in the playlist */
  relative?: boolean;
  /** Base directory for computing relative paths */
  baseDir?: string;
  /** Overwrite existing playlist file if present */
  force?: boolean;
  /** Preview without writing files */
  dryRun?: boolean;
  /** Output in JSON format */
  json?: boolean;
}

/**
 * Options for updating playlists.
 */
export interface PlaylistUpdateOptions {
  /** Specific playlist name to update */
  name?: string;
  /** Update all saved playlists */
  all?: boolean;
  /** Output in JSON format */
  json?: boolean;
}

/**
 * Options for listing playlists.
 */
export interface PlaylistListOptions {
  /** Output in JSON format */
  json?: boolean;
}

/**
 * Options for showing playlist details.
 */
export interface PlaylistShowOptions {
  /** Output in JSON format */
  json?: boolean;
}

/**
 * Options for deleting a playlist.
 */
export interface PlaylistDeleteOptions {
  /** Skip confirmation prompt */
  force?: boolean;
  /** Also delete the M3U file */
  deleteFile?: boolean;
}

interface FilterPlaylistCandidate extends M3UTrackInfo, SeparationTrack {
  artists?: string[];
  genres?: string[];
  year?: number;
  bpm?: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Loads a named filter from the configuration.
 *
 * @param filterName - Name of the filter to load
 * @returns The SmartFilter definition
 * @throws Error if filter is not found
 */
function loadNamedFilter(filterName: string): SmartFilter {
  const config = getLoadedConfig();
  const filters = config?.filters;
  if (!filters || !(filterName in filters)) {
    const available = filters ? Object.keys(filters).join(", ") : "none";
    throw new Error(
      `Filter "${filterName}" not found in config.filters. Available filters: ${available}`,
    );
  }
  const filter = filters[filterName];
  if (!filter) {
    throw new Error(`Filter "${filterName}" is undefined in config.filters.`);
  }
  logDebug(`Loaded filter: ${filterName}`);
  return filter;
}

/**
 * Gets the library paths from configuration for audio file discovery.
 *
 * @param config - Configuration file
 * @returns Array of library root paths
 */
function getLibraryPaths(config: ConfigFile | null): string[] {
  // Check plex.allowedLibraryRoots first
  const plexRoots = config?.plex?.allowedLibraryRoots;
  if (plexRoots && plexRoots.length > 0) {
    logDebug(`Using library paths from plex.allowedLibraryRoots: ${JSON.stringify(plexRoots)}`);
    return plexRoots;
  }

  // Fall back to environment variable
  const envRoots = process.env["RFMEDIA_PLEX_LIBRARY_ROOTS"];
  if (envRoots) {
    const roots = envRoots
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    logDebug(`Using library paths from RFMEDIA_PLEX_LIBRARY_ROOTS: ${JSON.stringify(roots)}`);
    return roots;
  }

  throw new Error(
    "No library paths configured. Set plex.allowedLibraryRoots in config or RFMEDIA_PLEX_LIBRARY_ROOTS environment variable.",
  );
}

/**
 * Determines the source type from options.
 *
 * @param options - Playlist create options
 * @returns The playlist source
 * @throws Error if neither filter nor plexPlaylist is provided
 */
function determineSource(options: PlaylistCreateOptions): PlaylistSource {
  if (options.filter) {
    return { type: "filter", filterName: options.filter };
  }
  if (options.plexPlaylist) {
    return { type: "plex-playlist", playlistName: options.plexPlaylist };
  }
  throw new Error("Either --filter or --plex-playlist must be specified.");
}

/**
 * Truncates a string to a maximum length with ellipsis.
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length
 * @returns Truncated string
 */
function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + "...";
}

/**
 * Maximum number of tracks to show in dry-run preview.
 */
const DRY_RUN_PREVIEW_LIMIT = 15;

/**
 * Formats and prints a dry-run track preview table.
 *
 * Shows a compact table with track numbers, truncated artist and title columns.
 * Uses dim styling for truncated counts.
 *
 * @param tracks - Array of track info to preview
 * @param output - Output path for the playlist
 */
function printDryRunTrackPreview(tracks: M3UTrackInfo[], output: string): void {
  console.error("");
  console.error(pc.bold(pc.yellow("Dry Run Preview")));
  console.error(`  Would create playlist with ${pc.cyan(tracks.length.toString())} tracks`);
  console.error(`  Output: ${pc.dim(output)}`);
  console.error("");

  const previewCount = Math.min(DRY_RUN_PREVIEW_LIMIT, tracks.length);

  const table = new Table({
    columns: [
      { name: "num", title: "#", alignment: "right" },
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "title", title: "Title", alignment: "left" },
    ],
  });

  for (let i = 0; i < previewCount; i++) {
    const track = tracks[i];
    if (track) {
      table.addRow({
        num: i + 1,
        artist: truncateString(track.artist ?? "Unknown", 25),
        title: truncateString(track.title ?? "Unknown", 35),
      });
    }
  }

  console.error(table.render());

  if (tracks.length > previewCount) {
    console.error(pc.dim(`  ... and ${tracks.length - previewCount} more tracks`));
  }
  console.error("");
}

// ============================================================================
// Main Actions
// ============================================================================

/**
 * Creates a new M3U playlist from a filter or Plex playlist source.
 *
 * Implementation flow for filter source:
 * 1. Load named filter from config
 * 2. Discover audio files from config library paths
 * 3. Read extended metadata for each file in parallel
 * 4. Evaluate filter against each file's metadata
 * 5. Collect matching tracks with metadata
 * 6. Write M3U playlist file
 * 7. Record to database with history
 *
 * @param options - Playlist creation options
 * @returns Result with track count, failed operations, output path
 */
export async function executePlaylistCreate(
  options: PlaylistCreateOptions,
): Promise<M3UPlaylistResult> {
  const { output, force = false, dryRun = false } = options;

  // Validate options
  if (!options.filter && !options.plexPlaylist) {
    throw new Error("Either --filter or --plex-playlist must be specified.");
  }

  // Determine source
  const source = determineSource(options);

  // Initialize result
  const result: M3UPlaylistResult = {
    success: false,
    outputPath: output,
    trackCount: 0,
    tracks: [],
    failed: [],
    skipped: 0,
  };

  // Check if output file exists
  if (!force && !dryRun && (await pathExists(output))) {
    throw new Error(`Output file already exists: ${output}. Use --force to overwrite.`);
  }

  // Handle based on source type
  if (source.type === "filter") {
    return executeFilterPlaylistCreate(options, source.filterName, result);
  } else {
    // Plex playlist source
    return executePlexPlaylistCreate(options, source.playlistName, result);
  }
}

/**
 * Creates a playlist from a named filter.
 *
 * @param options - Playlist creation options
 * @param filterName - Name of the filter to use
 * @param result - Result object to populate
 * @returns Updated result with track information
 */
async function executeFilterPlaylistCreate(
  options: PlaylistCreateOptions,
  filterName: string,
  result: M3UPlaylistResult,
): Promise<M3UPlaylistResult> {
  const { name, output, relative = false, baseDir, dryRun = false } = options;

  // Load the filter
  const filter = loadNamedFilter(filterName);

  // Get config for library paths
  const config = getLoadedConfig();
  const libraryPaths = getLibraryPaths(config);

  logInfo(`Creating playlist "${name}" from filter "${filterName}"`);
  logDebug(`Library paths: ${JSON.stringify(libraryPaths)}`);
  logDebug(`Filter: ${JSON.stringify(filter)}`);

  // Discover all audio files from library paths
  logInfo("Discovering audio files...");
  const allFiles: string[] = [];
  for (const libraryPath of libraryPaths) {
    if (!(await pathExists(libraryPath))) {
      logWarn(`Library path does not exist: ${libraryPath}`);
      continue;
    }
    const files = await findAudioFiles(libraryPath);
    logDebug(`Found ${files.length} audio files in ${libraryPath}`);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    logWarn("No audio files found in configured library paths.");
    result.success = true;
    return result;
  }

  logInfo(`Found ${allFiles.length} audio files. Reading metadata and evaluating filter...`);

  // Read metadata and evaluate filter in parallel
  const workers = getDefaultWorkers();
  const failed: FailedOperation[] = [];
  const matchingTracks: FilterPlaylistCandidate[] = [];
  let processedCount = 0;
  let matchedCount = 0;

  const parallelResults = await processInParallel(
    allFiles,
    async (filePath) => {
      // Read extended metadata
      const metadata = await readExtendedMetadata(filePath);
      if (!metadata) {
        return { filePath, matched: false, error: "Failed to read metadata" };
      }

      // Evaluate filter
      const matches = evaluateSmartFilter(metadata, filter);
      if (matches) {
        // Build track info from metadata
        const trackInfo: FilterPlaylistCandidate = {
          filePath,
          title: metadata.common.title?.trim() || path.basename(filePath, path.extname(filePath)),
          artist: metadata.common.artist,
          artists: [
            ...(metadata.common.artist ? [metadata.common.artist] : []),
            ...(metadata.common.artists ?? []),
          ],
          genres: metadata.common.genre,
          year: metadata.common.year,
          bpm: metadata.common.bpm,
          durationMs: metadata.format.duration
            ? Math.round(metadata.format.duration * 1000)
            : undefined,
        };
        return { filePath, matched: true, trackInfo };
      }

      return { filePath, matched: false };
    },
    {
      workers,
      onProgress: (completed, total) => {
        if (completed % 100 === 0 || completed === total) {
          logDebug(`Processed ${completed}/${total} files`);
        }
      },
    },
  );

  // Process results
  for (const parallelResult of parallelResults) {
    processedCount++;
    if (!parallelResult.success) {
      const filePath = allFiles[parallelResult.index];
      if (filePath) {
        failed.push({
          path: filePath,
          message: parallelResult.error?.message ?? "Unknown error",
        });
      }
      continue;
    }

    const value = parallelResult.value;
    if (value && value.matched && value.trackInfo) {
      matchingTracks.push(value.trackInfo);
      matchedCount++;
    }
  }

  logInfo(`Filter matched ${matchedCount} of ${processedCount} files`);

  if (matchingTracks.length === 0) {
    logWarn("No tracks matched the filter criteria.");
    result.success = true;
    result.failed = failed;
    return result;
  }

  // Sort tracks by path for consistent ordering
  matchingTracks.sort((a, b) => a.filePath.localeCompare(b.filePath));

  const separationResult =
    filter.separation === undefined
      ? { tracks: matchingTracks, relaxations: [] }
      : sequenceTracks(matchingTracks, filter.separation);

  if (separationResult.relaxations.length > 0) {
    logWarn(
      `Separation relaxed ${separationResult.relaxations.length} placement(s) to preserve all matched tracks.`,
    );
    for (const relaxation of separationResult.relaxations) {
      logDebug(
        `Separation relaxation at position ${relaxation.position}: ${relaxation.filePath} (${relaxation.constraints.join(", ")})`,
      );
    }
  }

  const playlistTracks: M3UTrackInfo[] = separationResult.tracks.map(
    ({ filePath, title, artist, durationMs }) => ({
      filePath,
      title,
      artist,
      durationMs,
    }),
  );

  // Preview in dry-run mode
  if (dryRun) {
    if (!isMachineFormat()) {
      printDryRunTrackPreview(playlistTracks, output);
    } else {
      logInfo(formatDryRun(`Would create playlist with ${playlistTracks.length} tracks`));
      logInfo(formatDryRun(`Output: ${output}`));
    }

    result.success = true;
    result.trackCount = playlistTracks.length;
    result.tracks = playlistTracks;
    result.failed = failed;
    return result;
  }

  // Write M3U playlist
  logInfo(`Writing playlist to ${output}...`);
  const writeResult = await writeM3UPlaylist({
    outputPath: output,
    tracks: playlistTracks,
    relativePaths: relative,
    baseDir: baseDir ?? path.dirname(output),
  });

  if (!writeResult.success) {
    throw new Error(`Failed to write playlist to ${output}`);
  }

  // Record to database
  logDebug("Recording playlist to database...");
  let db: DbConnection | undefined;
  try {
    db = await initializeDatabase();

    // Check if playlist already exists
    const existingPlaylist = getSmartPlaylist(db, name);
    let playlistId: number;

    if (existingPlaylist) {
      // Update existing playlist (persist config so update uses current path/source)
      playlistId = existingPlaylist.id;
      updateSmartPlaylist(db, playlistId, {
        trackCount: playlistTracks.length,
        outputPath: output,
        sourceType: "filter",
        sourceName: filterName,
        relativePaths: relative,
      });
      logDebug(`Updated existing playlist: ${name} (ID: ${playlistId})`);
    } else {
      // Create new playlist
      playlistId = createSmartPlaylist(db, {
        name,
        outputPath: output,
        sourceType: "filter",
        sourceName: filterName,
        relativePaths: relative,
      });
      logDebug(`Created new playlist: ${name} (ID: ${playlistId})`);
    }

    // Record history with track details
    const trackInfos: SmartPlaylistTrackInfo[] = playlistTracks.map((t) => ({
      filePath: t.filePath,
      title: t.title,
      artist: t.artist,
      durationMs: t.durationMs,
    }));
    recordPlaylistHistory(db, playlistId, trackInfos);
    logDebug(`Recorded playlist history with ${trackInfos.length} tracks`);
  } catch (dbError) {
    const message = dbError instanceof Error ? dbError.message : String(dbError);
    logWarn(`Failed to record playlist to database: ${message}`);
    // Continue without failing - playlist file was created successfully
  } finally {
    if (db) {
      db.close();
    }
  }

  // Success
  logSuccess(`Created playlist "${name}" with ${playlistTracks.length} tracks`);

  result.success = true;
  result.trackCount = playlistTracks.length;
  result.tracks = playlistTracks;
  result.failed = failed;
  return result;
}

/**
 * Builds a required media server adapter for API access.
 *
 * Uses config file values and validates URL/token via adapter factory.
 *
 * @returns Media server adapter if configuration is valid
 */
function getPlexConfig(): MediaServerAdapter {
  return resolveRequiredMediaServerAdapter({});
}

/**
 * Creates a playlist from a Plex playlist source.
 *
 * Implementation flow:
 * 1. Build Plex API config from loaded config
 * 2. Find playlist by name (throws descriptive error if not found)
 * 3. Fetch all tracks from the playlist
 * 4. Extract file paths and validate existence
 * 5. Build M3UTrackInfo array from Plex track metadata
 * 6. Write M3U playlist file
 * 7. Record to database with history
 *
 * @param options - Playlist creation options
 * @param playlistName - Name of the Plex playlist to use as source
 * @param result - Result object to populate
 * @returns Updated result with track information
 */
async function executePlexPlaylistCreate(
  options: PlaylistCreateOptions,
  playlistName: string,
  result: M3UPlaylistResult,
): Promise<M3UPlaylistResult> {
  const { name, output, relative = false, baseDir, dryRun = false } = options;

  // Get Plex configuration
  const plexConfig = getPlexConfig();

  logInfo(`Creating playlist "${name}" from Plex playlist "${playlistName}"`);

  // Find the playlist by name (throws descriptive error if not found)
  logDebug(`Finding Plex playlist: ${playlistName}`);
  const playlist = await plexConfig.playlist.byName(playlistName);
  logDebug(`Found Plex playlist "${playlist.title}" with ${playlist.itemCount} tracks`);

  // Fetch all tracks from the playlist
  logInfo(`Fetching tracks from Plex playlist "${playlist.title}"...`);
  const tracks = await plexConfig.playlist.tracks(playlist.id);
  logDebug(`Fetched ${tracks.length} tracks from Plex playlist`);

  if (tracks.length === 0) {
    logWarn(`Plex playlist "${playlist.title}" has no tracks.`);
    result.success = true;
    return result;
  }

  // Extract and validate file paths
  logInfo(`Validating file paths for ${tracks.length} tracks...`);
  const pathResult = await getTrackFilePaths(tracks, { validateExistence: true });
  const failed: FailedOperation[] = [];

  // Log warnings for tracks with missing files
  if (pathResult.missing.length > 0) {
    logWarn(`${pathResult.missing.length} track(s) have unresolvable file paths:`);
    for (const missingPath of pathResult.missing) {
      logDebug(`  Missing: ${missingPath}`);
      failed.push({
        path: missingPath,
        message: "File not found on filesystem",
      });
    }
  }

  // Build track info map from Plex tracks for valid paths
  const trackInfoByPath = new Map<string, MediaTrack>();
  for (const track of tracks) {
    if (track.filePath) {
      trackInfoByPath.set(track.filePath, track);
    }
  }

  // Build M3UTrackInfo array from valid tracks
  const matchingTracks: M3UTrackInfo[] = [];
  for (const filePath of pathResult.valid) {
    const track = trackInfoByPath.get(filePath);
    if (track) {
      matchingTracks.push({
        filePath,
        title: track.title,
        artist: track.artist,
        durationMs: track.durationMs,
      });
    }
  }

  logInfo(`Found ${matchingTracks.length} valid tracks (${pathResult.missing.length} missing)`);

  if (matchingTracks.length === 0) {
    logWarn("No valid tracks found to include in playlist.");
    result.success = true;
    result.failed = failed;
    result.skipped = pathResult.missing.length;
    return result;
  }

  // Preview in dry-run mode
  if (dryRun) {
    if (!isMachineFormat()) {
      printDryRunTrackPreview(matchingTracks, output);
    } else {
      logInfo(formatDryRun(`Would create playlist with ${matchingTracks.length} tracks`));
      logInfo(formatDryRun(`Output: ${output}`));
    }

    result.success = true;
    result.trackCount = matchingTracks.length;
    result.tracks = matchingTracks;
    result.failed = failed;
    result.skipped = pathResult.missing.length;
    return result;
  }

  // Write M3U playlist
  logInfo(`Writing playlist to ${output}...`);
  const writeResult = await writeM3UPlaylist({
    outputPath: output,
    tracks: matchingTracks,
    relativePaths: relative,
    baseDir: baseDir ?? path.dirname(output),
  });

  if (!writeResult.success) {
    throw new Error(`Failed to write playlist to ${output}`);
  }

  // Record to database
  logDebug("Recording playlist to database...");
  let db: DbConnection | undefined;
  try {
    db = await initializeDatabase();

    // Check if playlist already exists
    const existingPlaylist = getSmartPlaylist(db, name);
    let playlistId: number;

    if (existingPlaylist) {
      // Update existing playlist (persist config so update uses current path/source)
      playlistId = existingPlaylist.id;
      updateSmartPlaylist(db, playlistId, {
        trackCount: matchingTracks.length,
        outputPath: output,
        sourceType: "plex-playlist",
        sourceName: playlistName,
        relativePaths: relative,
      });
      logDebug(`Updated existing playlist: ${name} (ID: ${playlistId})`);
    } else {
      // Create new playlist
      playlistId = createSmartPlaylist(db, {
        name,
        outputPath: output,
        sourceType: "plex-playlist",
        sourceName: playlistName,
        relativePaths: relative,
      });
      logDebug(`Created new playlist: ${name} (ID: ${playlistId})`);
    }

    // Record history with track details
    const trackInfos: SmartPlaylistTrackInfo[] = matchingTracks.map((t) => ({
      filePath: t.filePath,
      title: t.title,
      artist: t.artist,
      durationMs: t.durationMs,
    }));
    recordPlaylistHistory(db, playlistId, trackInfos);
    logDebug(`Recorded playlist history with ${trackInfos.length} tracks`);
  } catch (dbError) {
    const message = dbError instanceof Error ? dbError.message : String(dbError);
    logWarn(`Failed to record playlist to database: ${message}`);
    // Continue without failing - playlist file was created successfully
  } finally {
    if (db) {
      db.close();
    }
  }

  // Success
  logSuccess(
    `Created playlist "${name}" with ${matchingTracks.length} tracks from Plex playlist "${playlist.title}"`,
  );

  result.success = true;
  result.trackCount = matchingTracks.length;
  result.tracks = matchingTracks;
  result.failed = failed;
  result.skipped = pathResult.missing.length;
  return result;
}

// ============================================================================
// Update, List, Show, and Delete Actions
// ============================================================================

/**
 * Updates existing playlist(s) by re-evaluating their source.
 *
 * If `--all` is provided, iterates through all playlists in the database.
 * Otherwise, updates the playlist with the specified name.
 *
 * For each playlist:
 * 1. Load the playlist definition from the database
 * 2. Re-run the create logic with the stored source configuration
 * 3. Update track_count and updated_at in the database
 * 4. Record a new history entry
 *
 * @param options - Update options
 * @returns Result with update details
 */
export async function executePlaylistUpdate(
  options: PlaylistUpdateOptions,
): Promise<PlaylistUpdateResult> {
  const { name, all = false } = options;

  // Validate options
  if (!name && !all) {
    throw new Error("Either a playlist name or --all must be specified.");
  }

  const result: PlaylistUpdateResult = {
    updated: 0,
    failed: [],
    playlists: [],
  };

  let db: DbConnection | undefined;
  try {
    db = await initializeDatabase();

    // Get playlists to update
    let playlistsToUpdate: DbSmartPlaylist[];
    if (all) {
      playlistsToUpdate = listSmartPlaylistsDb(db);
      if (playlistsToUpdate.length === 0) {
        logWarn("No playlists found in database.");
        const format = getOutputFormat();
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          await formatOutput(format, { command: "playlist update", result });
        }
        return result;
      }
      logInfo(`Updating ${playlistsToUpdate.length} playlists...`);
    } else {
      const playlist = getSmartPlaylist(db, name!);
      if (!playlist) {
        throw new Error(`Playlist "${name}" not found in database.`);
      }
      playlistsToUpdate = [playlist];
    }

    // Close db before processing - we'll reopen inside each create call
    db.close();
    db = undefined;

    // Update each playlist
    for (const playlist of playlistsToUpdate) {
      try {
        logInfo(`Updating playlist "${playlist.name}"...`);

        // Build create options from stored configuration
        const createOptions: PlaylistCreateOptions = {
          name: playlist.name,
          output: playlist.output_path,
          relative: playlist.relative_paths === 1,
          force: true, // Always overwrite existing file during update
        };

        // Set source based on stored type
        if (playlist.source_type === "filter") {
          createOptions.filter = playlist.source_name;
        } else {
          createOptions.plexPlaylist = playlist.source_name;
        }

        // Re-run create logic
        const createResult = await executePlaylistCreate(createOptions);

        if (createResult.success) {
          result.updated++;
          result.playlists.push({
            name: playlist.name,
            trackCount: createResult.trackCount,
            outputPath: createResult.outputPath,
          });
          logSuccess(`Updated playlist "${playlist.name}" with ${createResult.trackCount} tracks`);
        } else {
          result.failed.push({
            path: playlist.name,
            message: "Playlist creation returned unsuccessful result",
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Failed to update playlist "${playlist.name}": ${message}`);
        result.failed.push({
          path: playlist.name,
          message,
        });
      }
    }
  } finally {
    if (db) {
      db.close();
    }
  }

  // Output results
  const format = getOutputFormat();
  if (isMachineFormat(format)) {
    const { formatOutput } = await import("../lib/formatters/index.js");
    await formatOutput(format, { command: "playlist update", result });
  } else {
    console.error("");
    console.error(pc.bold("Update Summary"));
    console.error(`  ${pc.green("\u2713")} Updated: ${pc.green(result.updated.toString())}`);
    if (result.failed.length > 0) {
      console.error(`  ${pc.red("\u2717")} Failed: ${pc.red(result.failed.length.toString())}`);
    }
    console.error("");
  }

  return result;
}

/**
 * Lists all saved smart playlists.
 *
 * Queries all playlists from the database and returns them.
 * Console formatting is handled by the command layer.
 *
 * @param _options - List options (reserved for future use)
 * @returns Array of playlist records
 */
export async function listSmartPlaylists(
  _options: PlaylistListOptions,
): Promise<DbSmartPlaylist[]> {
  let db: DbConnection | undefined;
  try {
    db = await initializeDatabase();
    const playlists = listSmartPlaylistsDb(db);
    return playlists;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * Shows details and history for a smart playlist.
 *
 * Gets the playlist by name and includes recent history entries.
 *
 * @param name - Playlist name
 * @param options - Show options
 * @returns Playlist details with history
 */
export async function showSmartPlaylist(
  name: string,
  options: PlaylistShowOptions,
): Promise<PlaylistShowResult> {
  let db: DbConnection | undefined;
  try {
    db = await initializeDatabase();

    // Get playlist
    const playlist = getSmartPlaylist(db, name);
    if (!playlist) {
      throw new Error(`Playlist "${name}" not found in database.`);
    }

    // Get history
    const historyRecords = getSmartPlaylistHistory(db, playlist.id, 10);
    const history = historyRecords.map((h) => ({
      generatedAt: h.generated_at,
      trackCount: h.track_count,
    }));

    const result: PlaylistShowResult = {
      playlist,
      history,
    };

    const format = getOutputFormat();
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(format, {
        command: "playlist show",
        result: {
          name: playlist.name,
          sourceType: playlist.source_type,
          sourceName: playlist.source_name,
          trackCount: playlist.track_count,
          outputPath: playlist.output_path,
          relativePaths: playlist.relative_paths === 1,
          createdAt: playlist.created_at,
          updatedAt: playlist.updated_at,
          history,
        },
      });
    }
    // Console formatting is handled in the command file

    return result;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * Deletes a saved smart playlist.
 *
 * Requires confirmation unless `--force` is provided.
 * Optionally deletes the M3U file if `--delete-file` is set.
 *
 * @param name - Playlist name
 * @param options - Delete options
 */
export async function deleteSmartPlaylist(
  name: string,
  options: PlaylistDeleteOptions,
): Promise<void> {
  const { force = false, deleteFile = false } = options;

  let db: DbConnection | undefined;
  try {
    db = await initializeDatabase();

    // Get playlist
    const playlist = getSmartPlaylist(db, name);
    if (!playlist) {
      throw new Error(`Playlist "${name}" not found in database.`);
    }

    // Confirm deletion unless force
    if (!force) {
      const confirmed = await confirm(
        `Delete playlist "${name}"${deleteFile ? " and its M3U file" : ""}?`,
      );
      if (!confirmed) {
        logInfo("Deletion cancelled.");
        return;
      }
    }

    // Delete M3U file if requested
    if (deleteFile) {
      if (await pathExists(playlist.output_path)) {
        await remove(playlist.output_path);
        logInfo(`Deleted M3U file: ${playlist.output_path}`);
      } else {
        logWarn(`M3U file not found: ${playlist.output_path}`);
      }
    }

    // Delete from database (cascade deletes history/tracks)
    const deleted = deleteSmartPlaylistDb(db, playlist.id);
    if (deleted) {
      logSuccess(`Deleted playlist "${name}" from database.`);
    } else {
      logWarn(`Playlist "${name}" was not found in database (may have been already deleted).`);
    }

    const format = getOutputFormat();
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(format, {
        command: "playlist delete",
        result: {
          name,
          deleted: true,
          fileDeleted: deleteFile,
        },
      });
    }
  } finally {
    if (db) {
      db.close();
    }
  }
}
