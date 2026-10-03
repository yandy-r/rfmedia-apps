/**
 * M3U playlist file utilities for rfmedia CLI.
 *
 * Provides functions to read and write M3U/M3U8 playlist files:
 * - Uses .m3u8 extension to indicate UTF-8 encoding
 * - Supports extended M3U format with #EXTINF metadata
 * - Handles relative and absolute path modes
 * - Gracefully handles missing metadata
 */

import { dirname, basename, relative } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { ensureDir } from "./filesystem.js";
import { logDebug } from "./logger.js";
import type { M3UTrackInfo } from "../types/playlist.js";

/**
 * Options for writing an M3U playlist file.
 */
export interface WriteM3UOptions {
  /** Output file path for the playlist */
  outputPath: string;
  /** Array of tracks to include in the playlist */
  tracks: M3UTrackInfo[];
  /** If true, use paths relative to baseDir; otherwise use absolute paths */
  relativePaths?: boolean;
  /** Base directory for computing relative paths (required if relativePaths is true) */
  baseDir?: string;
}

/**
 * Result from writing an M3U playlist file.
 */
export interface WriteM3UResult {
  /** Whether the write operation succeeded */
  success: boolean;
  /** Number of tracks written to the playlist */
  trackCount: number;
  /** Path where the playlist was written */
  outputPath: string;
}

/**
 * Formats duration from milliseconds to integer seconds for EXTINF.
 *
 * @param durationMs - Duration in milliseconds (optional)
 * @returns Duration in seconds, or 0 if not provided
 */
function formatDuration(durationMs?: number): number {
  if (durationMs === undefined || durationMs <= 0) {
    return 0;
  }
  return Math.round(durationMs / 1000);
}

/**
 * Extracts a title from a file path when no metadata title is available.
 * Uses the filename without extension.
 *
 * @param filePath - Path to the audio file
 * @returns Filename without extension
 */
function titleFromFilename(filePath: string): string {
  const filename = basename(filePath);
  // Remove extension (last .xxx)
  const lastDot = filename.lastIndexOf(".");
  if (lastDot > 0) {
    return filename.substring(0, lastDot);
  }
  return filename;
}

/**
 * Formats track info for the EXTINF line.
 * Format: #EXTINF:duration,artist - title
 *
 * @param track - Track information
 * @returns Formatted EXTINF line without the leading #EXTINF:
 */
function formatExtInf(track: M3UTrackInfo): string {
  const duration = formatDuration(track.durationMs);
  const title = track.title ?? titleFromFilename(track.filePath);
  const artist = track.artist;

  if (artist) {
    return `${duration},${artist} - ${title}`;
  }
  return `${duration},${title}`;
}

/**
 * Writes an M3U playlist file with the specified tracks.
 *
 * Creates a UTF-8 encoded M3U8 playlist file with:
 * - #EXTM3U header
 * - #EXTINF metadata for each track (duration, artist, title)
 * - File paths (relative or absolute based on options)
 *
 * @param options - Write options including output path, tracks, and path mode
 * @returns Result with success status, track count, and output path
 * @throws Error if directory creation or file write fails
 *
 * @example
 * const result = await writeM3UPlaylist({
 *   outputPath: '/playlists/favorites.m3u8',
 *   tracks: [
 *     { filePath: '/music/song1.flac', title: 'Song One', artist: 'Artist', durationMs: 180000 }
 *   ],
 *   relativePaths: false
 * });
 */
export async function writeM3UPlaylist(options: WriteM3UOptions): Promise<WriteM3UResult> {
  const { outputPath, tracks, relativePaths = false, baseDir } = options;

  // Ensure parent directory exists
  const parentDir = dirname(outputPath);
  await ensureDir(parentDir);

  // Build playlist content
  const lines: string[] = ["#EXTM3U"];

  for (const track of tracks) {
    // Add EXTINF line with metadata
    const extInf = formatExtInf(track);
    lines.push(`#EXTINF:${extInf}`);

    // Add file path (relative or absolute)
    let trackPath = track.filePath;
    if (relativePaths && baseDir) {
      trackPath = relative(baseDir, track.filePath);
    }
    lines.push(trackPath);
  }

  // Write file with trailing newline
  const content = lines.join("\n") + "\n";
  await writeFile(outputPath, content, "utf-8");

  logDebug(`Wrote M3U playlist with ${tracks.length} tracks to ${outputPath}`);

  return {
    success: true,
    trackCount: tracks.length,
    outputPath,
  };
}

/**
 * Parses an M3U/M3U8 playlist file and returns track information.
 *
 * Supports both simple M3U (just file paths) and extended M3U format:
 * - #EXTM3U header (optional, validated if present)
 * - #EXTINF:duration,title or #EXTINF:duration,artist - title
 * - File paths (absolute or relative)
 *
 * @param filePath - Path to the M3U/M3U8 file to parse
 * @returns Array of track information extracted from the playlist
 * @throws Error if the file cannot be read
 *
 * @example
 * const tracks = await parseM3UPlaylist('/playlists/favorites.m3u8');
 * // Returns: [{ filePath: '/music/song.flac', title: 'Song', artist: 'Artist', durationMs: 180000 }]
 */
export async function parseM3UPlaylist(filePath: string): Promise<M3UTrackInfo[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const tracks: M3UTrackInfo[] = [];

  // State for parsing EXTINF -> path pairs
  let pendingExtInf: { title?: string; artist?: string; durationMs?: number } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines
    if (line === "") {
      continue;
    }

    // Handle #EXTM3U header
    if (line === "#EXTM3U") {
      continue;
    }

    // Handle #EXTINF metadata
    if (line.startsWith("#EXTINF:")) {
      pendingExtInf = parseExtInfLine(line);
      continue;
    }

    // Skip other comments/directives
    if (line.startsWith("#")) {
      continue;
    }

    // This line is a file path
    const track: M3UTrackInfo = {
      filePath: line,
      ...pendingExtInf,
    };

    // If no title from EXTINF, derive from filename
    if (!track.title) {
      track.title = titleFromFilename(line);
    }

    tracks.push(track);

    // Reset pending metadata
    pendingExtInf = null;
  }

  logDebug(`Parsed M3U playlist ${filePath}: ${tracks.length} tracks`);

  return tracks;
}

/**
 * Parses an #EXTINF line into duration, artist, and title.
 *
 * Supported formats:
 * - #EXTINF:180,Title
 * - #EXTINF:180,Artist - Title
 * - #EXTINF:-1,Title (unknown duration)
 *
 * @param line - The full #EXTINF line
 * @returns Parsed metadata object
 */
function parseExtInfLine(line: string): { title?: string; artist?: string; durationMs?: number } {
  // Remove #EXTINF: prefix
  const content = line.substring(8);

  // Split on first comma: duration,display
  const commaIdx = content.indexOf(",");
  if (commaIdx === -1) {
    // Malformed, just duration
    const duration = parseInt(content, 10);
    return {
      durationMs: isNaN(duration) || duration < 0 ? undefined : duration * 1000,
    };
  }

  const durationStr = content.substring(0, commaIdx);
  const display = content.substring(commaIdx + 1);

  const duration = parseInt(durationStr, 10);
  const durationMs = isNaN(duration) || duration < 0 ? undefined : duration * 1000;

  // Try to split display on " - " for artist - title pattern
  const separatorIdx = display.indexOf(" - ");
  if (separatorIdx !== -1) {
    return {
      durationMs,
      artist: display.substring(0, separatorIdx),
      title: display.substring(separatorIdx + 3),
    };
  }

  // Just title, no artist
  return {
    durationMs,
    title: display,
  };
}
