/**
 * Album completeness verification for rfmedia CLI.
 *
 * Provides functions to verify if an album copy is complete by comparing
 * file lists between source and destination directories.
 */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import { isAudioFile } from "./audio.js";
import { pathExists, normalizePathResolved } from "./filesystem.js";
import { logDebug } from "./logger.js";

/**
 * Result of album completeness verification.
 * - 'complete': All expected files are present in destination
 * - 'incomplete': Some files are missing from destination
 * - 'missing': Destination directory does not exist
 */
export type VerificationResult = "complete" | "incomplete" | "missing";

/**
 * Extension mappings for each conversion format.
 */
const CONVERT_FORMAT_EXTENSIONS: Record<string, string> = {
  alac: "m4a",
  apple: "m4a", // alias for alac
  mp3: "mp3",
  aac: "m4a",
  opus: "opus",
};

/**
 * Gets the expected destination filename, handling extension changes for audio conversion.
 *
 * When a convert format is specified and the file is an audio file, the extension
 * is changed accordingly (e.g., .flac -> .m4a for ALAC conversion).
 *
 * @param sourceFile - Full path or filename of the source file
 * @param convertFormat - Optional conversion format ('alac', 'mp3', 'aac', 'opus')
 * @returns The expected destination filename with appropriate extension
 */
export function getExpectedDestFilename(sourceFile: string, convertFormat?: string): string {
  const filename = path.basename(sourceFile);

  if (convertFormat && isAudioFile(sourceFile)) {
    // Change extension based on conversion format
    const ext = path.extname(filename);
    const nameWithoutExt = filename.slice(0, -ext.length);
    const newExt = CONVERT_FORMAT_EXTENSIONS[convertFormat.toLowerCase()];

    if (newExt) {
      return `${nameWithoutExt}.${newExt}`;
    }

    // Unknown conversion format, keep original filename
    return filename;
  }

  return filename;
}

/**
 * Allocates deterministic destination paths for an ordered set of desired paths.
 *
 * Duplicate basenames are matched case-insensitively within each destination
 * directory. The first occurrence keeps its requested name; later occurrences
 * receive the established `-002`, `-003`, ... suffix before the extension.
 *
 * @param destinationPaths - Desired destination paths in stable source order
 * @returns Newly allocated destination paths in the same order
 */
export function allocateUniqueDestinationPaths(destinationPaths: readonly string[]): string[] {
  const allocationsByDirectory = new Map<
    string,
    {
      allocatedNames: Set<string>;
      nextSuffixByName: Map<string, number>;
    }
  >();

  return destinationPaths.map((destinationPath) => {
    const directory = path.dirname(destinationPath);
    const filename = path.basename(destinationPath);

    let allocation = allocationsByDirectory.get(directory);
    if (allocation === undefined) {
      allocation = { allocatedNames: new Set(), nextSuffixByName: new Map() };
      allocationsByDirectory.set(directory, allocation);
    }

    const key = filename.toLowerCase();
    const extension = path.extname(filename);
    const basename = path.basename(filename, extension);
    let allocatedFilename = filename;
    let nextSuffix = allocation.nextSuffixByName.get(key) ?? 2;

    while (allocation.allocatedNames.has(allocatedFilename.toLowerCase())) {
      const suffix = String(nextSuffix).padStart(3, "0");
      allocatedFilename = `${basename}-${suffix}${extension}`;
      nextSuffix++;
    }

    allocation.allocatedNames.add(allocatedFilename.toLowerCase());
    allocation.nextSuffixByName.set(key, nextSuffix);

    return allocatedFilename === filename
      ? destinationPath
      : path.join(directory, allocatedFilename);
  });
}

/**
 * Verifies if an album copy is complete by comparing file lists.
 *
 * This function:
 * 1. Normalizes the source path (resolves symlinks)
 * 2. Checks if the destination directory exists
 * 3. Compares files (not directories) between source and destination
 * 4. Handles audio file extension changes when convertFormat is specified
 *
 * @param sourceDir - Path to the source album directory
 * @param destDir - Path to the destination album directory
 * @param convertFormat - Optional conversion format for extension mapping
 * @returns 'complete' if all files present, 'incomplete' if files missing, 'missing' if dest doesn't exist
 */
export async function verifyAlbumComplete(
  sourceDir: string,
  destDir: string,
  convertFormat?: string,
): Promise<VerificationResult> {
  // Normalize source path (resolves symlinks)
  const normalizedSourceDir = await normalizePathResolved(sourceDir);

  logDebug("verifyAlbumComplete:");
  logDebug(`  source_dir: ${normalizedSourceDir}`);
  logDebug(`  dest_dir: ${destDir}`);
  logDebug(`  convert_format: ${convertFormat ?? "(none)"}`);

  // Check if destination exists
  if (!(await pathExists(destDir))) {
    logDebug("  Result: destination does not exist");
    return "missing";
  }

  // Read source directory contents
  let sourceEntries;
  try {
    sourceEntries = await readdir(normalizedSourceDir, { withFileTypes: true });
  } catch (err) {
    // If source doesn't exist or can't be read, treat as empty
    logDebug(`  Result: cannot read source directory: ${(err as Error).message}`);
    return "missing";
  }

  let missingFiles = 0;
  let totalFiles = 0;

  // Iterate through source entries, skipping directories
  for (const entry of sourceEntries) {
    // Skip directories - only compare files
    if (entry.isDirectory()) {
      continue;
    }

    const sourceFile = path.join(normalizedSourceDir, entry.name);
    const expectedFilename = getExpectedDestFilename(sourceFile, convertFormat);
    const destFile = path.join(destDir, expectedFilename);

    totalFiles++;

    // Check if the expected file exists in destination
    if (!(await pathExists(destFile))) {
      logDebug(`  Missing: ${expectedFilename}`);
      missingFiles++;
    }
  }

  logDebug(`  Total files: ${totalFiles}, Missing: ${missingFiles}`);

  // Handle empty source directory case
  if (totalFiles === 0) {
    logDebug("  Result: source is empty");
    // Empty source directory - return 'missing' to indicate nothing to copy
    // This matches the bash behavior (return 2 for empty)
    return "missing";
  }

  if (missingFiles === 0) {
    logDebug("  Result: complete");
    return "complete";
  }

  logDebug(`  Result: incomplete (${missingFiles} missing)`);
  return "incomplete";
}

/**
 * Finds files in destination that are not expected based on source.
 *
 * This function identifies extra files in the destination directory that
 * don't correspond to any source file (accounting for conversion format).
 *
 * @param expectedFiles - Set of expected filenames in destination
 * @param destDir - Path to the destination directory
 * @returns Array of extra file paths relative to destDir
 * @throws Error if destDir doesn't exist or can't be read
 */
export async function findExtraFiles(
  expectedFiles: Set<string>,
  destDir: string,
): Promise<string[]> {
  logDebug("findExtraFiles:");
  logDebug(`  dest_dir: ${destDir}`);
  logDebug(`  expected_count: ${expectedFiles.size}`);

  if (!(await pathExists(destDir))) {
    throw new Error(`Destination directory does not exist: ${destDir}`);
  }

  let destEntries;
  try {
    destEntries = await readdir(destDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read destination directory: ${(err as Error).message}`);
  }

  const extraFiles: string[] = [];

  for (const entry of destEntries) {
    // Skip directories
    if (entry.isDirectory()) {
      continue;
    }

    // Check if this file is expected
    if (!expectedFiles.has(entry.name)) {
      extraFiles.push(entry.name);
      logDebug(`  Extra: ${entry.name}`);
    }
  }

  logDebug(`  Result: ${extraFiles.length} extra files found`);
  return extraFiles;
}

/**
 * Verifies file size matches between source and destination.
 *
 * This function compares the file sizes of source and destination files
 * to detect incomplete or corrupted copies.
 *
 * @param sourcePath - Path to the source file
 * @param destPath - Path to the destination file
 * @returns True if sizes match, false otherwise
 * @throws Error if either file doesn't exist or can't be accessed
 */
export async function verifyFileSize(sourcePath: string, destPath: string): Promise<boolean> {
  try {
    const [sourceStat, destStat] = await Promise.all([stat(sourcePath), stat(destPath)]);

    const match = sourceStat.size === destStat.size;

    if (!match) {
      logDebug(
        `Size mismatch: ${path.basename(sourcePath)} (source: ${sourceStat.size}, dest: ${destStat.size})`,
      );
    }

    return match;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    throw new Error(
      `Cannot verify file size for ${path.basename(sourcePath)}: ${error.message} (code: ${error.code ?? "unknown"})`,
    );
  }
}
