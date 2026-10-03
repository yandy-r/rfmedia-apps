/**
 * Type definitions for smart playlist generation from filters and Plex playlists.
 *
 * Smart playlists support two source types:
 * 1. Filter-based: Uses named SmartFilter from config, evaluated against local audio metadata
 * 2. Plex playlist-based: Fetches tracks from an existing Plex playlist via API
 *
 * Uses discriminated unions with `type` field for exhaustive type checking.
 */

import type { DbSmartPlaylist } from "./db.js";
import type { FailedOperation } from "./results.js";

// ============================================================================
// PlaylistSource Discriminated Union
// ============================================================================

/**
 * Playlist source using a named smart filter from configuration.
 *
 * The filter is evaluated against local audio file metadata to determine
 * which tracks to include in the playlist.
 *
 * @example
 * const source: FilterPlaylistSource = {
 *   type: 'filter',
 *   filterName: 'high-quality-rock'
 * };
 */
export interface FilterPlaylistSource {
  /** Discriminator for filter-based source */
  type: "filter";
  /** Name of the filter from config.filters */
  filterName: string;
}

/**
 * Playlist source using an existing Plex playlist.
 *
 * Tracks are fetched from the Plex Media Server API and their local
 * file paths are resolved for M3U generation.
 *
 * @example
 * const source: PlexPlaylistSource = {
 *   type: 'plex-playlist',
 *   playlistName: 'My Favorites'
 * };
 */
export interface PlexPlaylistSource {
  /** Discriminator for Plex playlist source */
  type: "plex-playlist";
  /** Name of the Plex playlist to fetch */
  playlistName: string;
}

/**
 * Discriminated union of playlist source types.
 *
 * Use the `type` field to discriminate between sources in switch statements.
 *
 * @example
 * function processSource(source: PlaylistSource): void {
 *   switch (source.type) {
 *     case 'filter':
 *       // source is FilterPlaylistSource
 *       loadFilter(source.filterName);
 *       break;
 *     case 'plex-playlist':
 *       // source is PlexPlaylistSource
 *       fetchPlexPlaylist(source.playlistName);
 *       break;
 *   }
 * }
 */
export type PlaylistSource = FilterPlaylistSource | PlexPlaylistSource;

// ============================================================================
// M3U Playlist Options and Results
// ============================================================================

/**
 * Options for creating an M3U playlist.
 */
export interface M3UPlaylistOptions {
  /** Display name for the playlist */
  name: string;
  /** Output file path for the M3U/M3U8 file */
  outputPath: string;
  /** Source for playlist tracks (filter or Plex playlist) */
  source: PlaylistSource;
  /** Use relative paths in the playlist (default: absolute paths) */
  relativePaths?: boolean;
  /** Base directory for computing relative paths */
  baseDir?: string;
  /** Overwrite existing playlist file if present */
  force?: boolean;
  /** Preview without writing files */
  dryRun?: boolean;
}

/**
 * Information about a single track in an M3U playlist.
 */
export interface M3UTrackInfo {
  /** Absolute or relative path to the audio file */
  filePath: string;
  /** Track title (from metadata or filename) */
  title?: string;
  /** Artist name (from metadata) */
  artist?: string;
  /** Track duration in milliseconds */
  durationMs?: number;
}

/**
 * Result from M3U playlist creation.
 */
export interface M3UPlaylistResult {
  /** Whether the playlist was created successfully */
  success: boolean;
  /** Path to the created M3U file */
  outputPath: string;
  /** Number of tracks in the playlist */
  trackCount: number;
  /** Track information included in the playlist */
  tracks: M3UTrackInfo[];
  /** Operations that failed during playlist creation */
  failed: FailedOperation[];
  /** Number of tracks skipped (e.g., missing files) */
  skipped: number;
}

// ============================================================================
// Playlist Update and Show Results
// ============================================================================

/**
 * Result from updating one or more smart playlists.
 */
export interface PlaylistUpdateResult {
  /** Number of playlists successfully updated */
  updated: number;
  /** Operations that failed during update */
  failed: FailedOperation[];
  /** Details about each updated playlist */
  playlists: Array<{
    /** Playlist name */
    name: string;
    /** Number of tracks in the updated playlist */
    trackCount: number;
    /** Output path of the playlist file */
    outputPath: string;
  }>;
}

/**
 * Result from showing a smart playlist's details.
 */
export interface PlaylistShowResult {
  /** The smart playlist definition from the database */
  playlist: DbSmartPlaylist;
  /** Generation history entries */
  history: Array<{
    /** ISO timestamp when the playlist was generated */
    generatedAt: string;
    /** Number of tracks at time of generation */
    trackCount: number;
  }>;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a PlaylistSource is a FilterPlaylistSource.
 */
export function isFilterPlaylistSource(source: PlaylistSource): source is FilterPlaylistSource {
  return source.type === "filter";
}

/**
 * Type guard to check if a PlaylistSource is a PlexPlaylistSource.
 */
export function isPlexPlaylistSource(source: PlaylistSource): source is PlexPlaylistSource {
  return source.type === "plex-playlist";
}
