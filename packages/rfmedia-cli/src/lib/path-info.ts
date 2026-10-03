/**
 * Path information utilities for extracting artist/album names from file paths.
 */

import path from "node:path";
import { logDebug } from "./logger.js";

/**
 * Detect whether the source directory is a library root or an artist folder.
 *
 * A library root has structure: Source/Artist/Album/tracks
 * An artist folder has structure: Source/Album/tracks
 *
 * Detection: If any audio file has a relative path with 3+ parts (Artist/Album/track),
 * the source is a library root.
 *
 * @param source - Source directory path
 * @param audioFiles - List of audio file paths found in source
 * @returns true if source is a library root, false if it's an artist folder
 */
export function detectLibraryRoot(source: string, audioFiles: string[]): boolean {
  if (audioFiles.length === 0) {
    return false;
  }

  // Check the first few files to determine structure
  // Library root: relative path has 3+ parts (Artist/Album/track.ext)
  // Artist folder: relative path has 2 parts (Album/track.ext)
  const samplesToCheck = Math.min(audioFiles.length, 10);

  for (let i = 0; i < samplesToCheck; i++) {
    const filePath = audioFiles[i];
    if (!filePath) continue;

    const relativePath = path.relative(source, filePath);
    const parts = relativePath.split(path.sep);

    // If we find a file with 3+ parts, it's a library root
    if (parts.length >= 3) {
      logDebug(
        `Detected library root structure: ${relativePath} has ${parts.length} path components`,
      );
      return true;
    }
  }

  // All sampled files had 2 or fewer parts - it's an artist folder
  logDebug(`Detected artist folder structure (files have <=2 path components)`);
  return false;
}

/**
 * Extract artist and album names from a file path relative to source directory.
 *
 * Supports two source structures:
 * - Library root: Source contains Artist/Album/track structure (isLibraryRoot=true)
 * - Artist folder: Source IS the artist folder, contains Album/track structure (isLibraryRoot=false)
 *
 * @param filePath - Absolute path to the audio file
 * @param sourceDir - Base source directory path
 * @param fallbackArtistName - Artist name to use when source is artist folder (basename of source)
 * @param isLibraryRoot - Whether source is a library root containing multiple artists
 * @returns Object with artistName and albumName
 */
export function extractPathInfo(
  filePath: string,
  sourceDir: string,
  fallbackArtistName: string,
  isLibraryRoot: boolean = false,
): { artistName: string; albumName: string } {
  // Get the relative path from source
  const relativePath = path.relative(sourceDir, filePath);
  const parts = relativePath.split(path.sep);

  if (isLibraryRoot) {
    // Library root structure: Artist/Album/track.ext or Artist/Album/subfolder/track.ext
    // parts[0] is artist, parts[1] is album, last is filename
    if (parts.length >= 3) {
      return {
        artistName: parts[0] ?? "Unknown Artist",
        albumName: parts[1] ?? "Unknown Album",
      };
    } else if (parts.length === 2) {
      // Track directly in artist folder (no album subfolder): Artist/track.ext
      return {
        artistName: parts[0] ?? "Unknown Artist",
        albumName: "Unknown Album",
      };
    }
    // Fallback for unexpected structure
    return {
      artistName: "Unknown Artist",
      albumName: "Unknown Album",
    };
  }

  // Artist folder structure: Album/track.ext or Album/subfolder/track.ext
  // parts[0] is the album folder, parts[length-1] is the filename
  if (parts.length >= 2) {
    return {
      artistName: fallbackArtistName,
      albumName: parts[0] ?? "Unknown Album",
    };
  }

  // Track directly in source folder (no album subfolder)
  return {
    artistName: fallbackArtistName,
    albumName: "Unknown Album",
  };
}
