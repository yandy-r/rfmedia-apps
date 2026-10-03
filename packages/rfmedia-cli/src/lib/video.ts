/**
 * Video file utilities for rfmedia CLI.
 *
 * Provides video file detection, scanning, and title extraction
 * for the link-videos command.
 */

import path from "node:path";
import fg from "fast-glob";

import { VIDEO_EXTENSIONS, type VideoExtension, type VideoFile } from "../types/link-videos.js";
import { logDebug } from "./logger.js";

/**
 * Set of video extensions for fast lookup.
 */
const VIDEO_EXTENSION_SET = new Set<string>(VIDEO_EXTENSIONS);

/**
 * Regex patterns to strip from video titles.
 * These patterns match common video suffixes like "(Official HD Video)", "(Official Video)", etc.
 * The patterns are applied in order until one matches.
 */
const VIDEO_TITLE_PATTERNS: RegExp[] = [
  // Match "-video" suffix (common in downloaded videos)
  /-video$/i,
  // Match "(Official HD Video)" and similar variations
  /\s*\((?:Official\s+)?(?:HD\s+)?Video\)$/i,
  /\s*\((?:Official\s+)?(?:Music\s+)?Video\)$/i,
  /\s*\((?:Official\s+)?(?:Lyric\s+)?Video\)$/i,
  /\s*\((?:Official\s+)?(?:Audio\s+)?Video\)$/i,
  // Match "[Official Video]" bracket variations
  /\s*\[(?:Official\s+)?(?:HD\s+)?Video\]$/i,
  /\s*\[(?:Official\s+)?(?:Music\s+)?Video\]$/i,
  // Match "- Official Video" dash variations
  /\s*-\s*(?:Official\s+)?(?:HD\s+)?Video$/i,
  /\s*-\s*(?:Official\s+)?(?:Music\s+)?Video$/i,
  // Match "Official HD Video" without brackets
  /\s+Official\s+(?:HD\s+)?Video$/i,
  /\s+Official\s+(?:Music\s+)?Video$/i,
];

/**
 * Checks if a file path has a video file extension.
 * Performs case-insensitive matching.
 *
 * @param filePath - The file path to check
 * @returns true if the file has a video extension
 */
export function isVideoFile(filePath: string): boolean {
  const ext = getVideoExtension(filePath);
  return ext !== null;
}

/**
 * Extracts the video extension from a file path if it has one.
 * Returns the extension in lowercase without the leading dot.
 *
 * @param filePath - The file path to check
 * @returns The lowercase extension without dot, or null if not a video file
 */
export function getVideoExtension(filePath: string): VideoExtension | null {
  const ext = path.extname(filePath).toLowerCase();
  const extWithoutDot = ext.slice(1);

  if (VIDEO_EXTENSION_SET.has(extWithoutDot)) {
    return extWithoutDot as VideoExtension;
  }
  return null;
}

/**
 * Extracts the song title from a video filename.
 * Removes common suffixes like "(Official HD Video)-video".
 *
 * @param filename - The video filename (with or without path)
 * @returns The extracted song title
 *
 * @example
 * extractVideoSongTitle("Born To Make You Happy (Official HD Video)-video.mkv")
 * // Returns: "Born To Make You Happy"
 *
 * extractVideoSongTitle("...Baby One More Time (Official HD Video)-video.mkv")
 * // Returns: "...Baby One More Time"
 */
export function extractVideoSongTitle(filename: string): string {
  // Get basename without extension
  const basename = path.basename(filename);
  const ext = path.extname(basename);
  let title = basename.slice(0, -ext.length);

  // Apply each pattern to strip suffixes
  for (const pattern of VIDEO_TITLE_PATTERNS) {
    const newTitle = title.replace(pattern, "");
    if (newTitle !== title) {
      logDebug(`Stripped "${pattern.source}" from title: "${title}" -> "${newTitle}"`);
      title = newTitle;
    }
  }

  return title.trim();
}

/**
 * Finds all video files in a directory recursively.
 * Uses fast-glob for efficient file discovery.
 *
 * @param dir - The directory to search in
 * @param artist - Optional artist name to filter by (subdirectory name)
 * @returns Array of absolute paths to video files
 */
export async function findVideoFiles(dir: string, artist?: string): Promise<string[]> {
  // Build glob patterns for all video extensions
  const patterns = VIDEO_EXTENSIONS.map((ext) => {
    if (artist) {
      // Search only within artist subdirectory
      return `${artist}/**/*.${ext}`;
    }
    return `**/*.${ext}`;
  });

  const files = await fg(patterns, {
    cwd: dir,
    absolute: true,
    caseSensitiveMatch: false,
    onlyFiles: true,
    followSymbolicLinks: true,
  });

  return files;
}

/**
 * Scans a video source directory and extracts video file metadata.
 *
 * @param videoSource - Root directory containing video files
 * @param artist - Optional artist name to filter by
 * @returns Array of VideoFile objects with extracted metadata
 */
export async function scanVideoFiles(videoSource: string, artist?: string): Promise<VideoFile[]> {
  const filePaths = await findVideoFiles(videoSource, artist);
  const videos: VideoFile[] = [];

  for (const filePath of filePaths) {
    const relativePath = path.relative(videoSource, filePath);
    const pathParts = relativePath.split(path.sep);

    // Extract artist from first directory component
    const artistName = pathParts[0];
    if (!artistName) {
      logDebug(`Skipping video without artist directory: ${relativePath}`);
      continue;
    }

    const filename = path.basename(filePath);
    const extension = getVideoExtension(filePath);
    if (!extension) {
      continue;
    }

    const songTitle = extractVideoSongTitle(filename);

    videos.push({
      path: filePath,
      relativePath,
      artist: artistName,
      songTitle,
      extension,
    });

    logDebug(`Scanned video: "${artistName}" - "${songTitle}" (${extension})`);
  }

  return videos;
}
