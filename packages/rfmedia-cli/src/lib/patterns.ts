/**
 * Pattern matching utility for rfmedia CLI.
 *
 * Provides glob pattern matching against file paths for the clean command's
 * --exclude and --protect options.
 */

import { readFile } from "node:fs/promises";
import { relative, basename } from "node:path";

import picomatch from "picomatch";

import { logDebug } from "./logger.js";

/**
 * Checks if a path matches any of the provided glob patterns.
 *
 * Patterns are matched against:
 * 1. The path relative to basePath (e.g., "Artist Name/Album Name")
 * 2. The basename only (e.g., "Album Name")
 *
 * @param absolutePath - Absolute path to test
 * @param patterns - Glob patterns (e.g., "**\/Holiday*", "Various Artists/**")
 * @param basePath - Base directory for relative pattern matching
 * @returns true if the path matches any pattern
 *
 * @example
 * // Match holiday albums
 * matchesAnyPattern('/music/Artist/Holiday Album', ['*Holiday*'], '/music')
 * // Returns: true (basename match)
 *
 * matchesAnyPattern('/music/Artist/Holiday Album', ['**\/Holiday*'], '/music')
 * // Returns: true (relative path match)
 *
 * matchesAnyPattern('/music/Various Artists/Compilation', ['Various Artists/**'], '/music')
 * // Returns: true (artist folder match)
 */
export function matchesAnyPattern(
  absolutePath: string,
  patterns: string[],
  basePath: string,
): boolean {
  if (patterns.length === 0) {
    return false;
  }

  // Get the relative path from basePath
  const relativePath = relative(basePath, absolutePath);
  const name = basename(absolutePath);

  // Create picomatch matchers for all patterns
  const isMatch = picomatch(patterns, {
    dot: true, // Match dotfiles
    nocase: false, // Case-sensitive matching
    bash: true, // Use bash-like glob behavior
  });

  // Check if relative path matches any pattern
  if (isMatch(relativePath)) {
    logDebug(`Pattern match (relative): ${relativePath}`);
    return true;
  }

  // Check if basename matches any pattern
  if (isMatch(name)) {
    logDebug(`Pattern match (basename): ${name}`);
    return true;
  }

  return false;
}

/**
 * Reads protection patterns from a file.
 *
 * The file format supports:
 * - One pattern per line
 * - Empty lines are ignored
 * - Lines starting with # are treated as comments and ignored
 * - Leading/trailing whitespace is trimmed
 *
 * @param filePath - Path to the patterns file
 * @returns Array of glob patterns
 * @throws Error if the file cannot be read
 *
 * @example
 * // File contents:
 * // # Protect holiday albums
 * // **\/Holiday*
 * // **\/*Christmas*
 * //
 * // # Protect specific artist
 * // Various Artists/**
 * //
 * // Returns: ['**\/Holiday*', '**\/*Christmas*', 'Various Artists/**']
 */
export async function readProtectionPatterns(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const patterns: string[] = [];

  for (const rawLine of lines) {
    // Trim leading/trailing whitespace
    const line = rawLine.trim();

    // Skip empty lines
    if (line === "") {
      continue;
    }

    // Skip comments (lines starting with #)
    if (line.startsWith("#")) {
      logDebug(`Skipping comment: ${line}`);
      continue;
    }

    patterns.push(line);
    logDebug(`Read protection pattern: ${line}`);
  }

  logDebug(`Read ${patterns.length} protection pattern(s) from ${filePath}`);

  return patterns;
}
