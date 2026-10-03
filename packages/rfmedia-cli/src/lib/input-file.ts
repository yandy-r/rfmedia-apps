/**
 * File-based input utility for rfmedia CLI.
 *
 * Reads source paths from a text file, supporting:
 * - Empty lines (skipped)
 * - Comments starting with # (skipped)
 * - Shell-escaped paths with single quotes (quotes removed)
 * - Whitespace trimming
 * - Per-path range suffixes (e.g., "path,001-005")
 *
 * This mirrors the bash read_source_paths function behavior.
 */

import { readFile } from "node:fs/promises";

import { logDebug } from "./logger.js";
import { isValidRange, tryParseRange } from "./range.js";
import type { PathEntry } from "../types/index.js";

/**
 * Parses a line into a path and optional range or count.
 *
 * The format supports an optional suffix after the last comma:
 * - Range format (with hyphen): "/path/to/album,001-005" -> { path: "/path/to/album", range: { start: 1, end: 5, padWidth: 3 } }
 * - Count format (pure digits): "/path/to/album,5" -> { path: "/path/to/album", count: 5 }
 * - No suffix: "/path/to/album" -> { path: "/path/to/album" }
 * - Path with commas: "/path/with,comma/album,001-005" -> { path: "/path/with,comma/album", range: { start: 1, end: 5, padWidth: 3 } }
 *
 * Only the LAST comma is considered as a potential delimiter.
 * This allows paths with commas to be used safely.
 *
 * @param line - The line to parse (already trimmed and de-quoted)
 * @returns PathEntry with path and optional range or count
 */
function parseLine(line: string): PathEntry {
  // Find the last comma in the line
  const lastCommaIdx = line.lastIndexOf(",");

  // If no comma found, it's just a path
  if (lastCommaIdx === -1) {
    return { path: line };
  }

  // Extract the potential suffix string (text after the last comma)
  const potentialSuffix = line.substring(lastCommaIdx + 1);
  const pathPart = line.substring(0, lastCommaIdx);

  // Try range first (existing logic)
  if (isValidRange(potentialSuffix)) {
    const range = tryParseRange(potentialSuffix);
    if (range) {
      logDebug(`Parsed per-path range: ${pathPart} with range ${potentialSuffix}`);
      return { path: pathPart, range };
    }
  }

  // Try count (pure digits)
  const trimmedSuffix = potentialSuffix.trim();
  if (/^\d+$/.test(trimmedSuffix)) {
    const count = parseInt(trimmedSuffix, 10);
    if (count < 1) {
      throw new Error(`Invalid count "${count}" for path "${pathPart}": must be at least 1`);
    }
    logDebug(`Parsed per-path count: ${pathPart} with count ${count}`);
    return { path: pathPart, count };
  }

  // Neither valid range nor count - treat whole line as path
  return { path: line };
}

/**
 * Reads source paths from a file.
 *
 * The file format supports:
 * - One path per line
 * - Empty lines are ignored
 * - Lines starting with # are treated as comments and ignored
 * - Leading/trailing whitespace is trimmed
 * - Single quotes are removed (handles eza shell-escaped output)
 * - Optional per-path range suffix: "path,START-END" (e.g., "/music/Album,001-005")
 *
 * @param filePath - Path to the input file
 * @returns Array of PathEntry objects with path and optional range
 * @throws Error if the file cannot be read
 *
 * @example
 * // File contents:
 * // /music/Artist1/Album1,001-003
 * // # This is a comment
 * // /music/'Artist (2024)'/Album,004-006
 * // /music/Artist3/Album3
 * //
 * // Returns:
 * // [
 * //   { path: '/music/Artist1/Album1', range: { start: 1, end: 3, padWidth: 3 } },
 * //   { path: '/music/Artist (2024)/Album', range: { start: 4, end: 6, padWidth: 3 } },
 * //   { path: '/music/Artist3/Album3', range: undefined }
 * // ]
 */
export async function readSourcePaths(filePath: string): Promise<PathEntry[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const entries: PathEntry[] = [];

  for (const rawLine of lines) {
    // Trim leading/trailing whitespace
    let line = rawLine.trim();

    // Skip empty lines
    if (line === "") {
      continue;
    }

    // Skip comments (lines starting with #)
    if (line.startsWith("#")) {
      logDebug(`Skipping comment: ${line}`);
      continue;
    }

    // Remove shell escape quotes (single quotes from eza output)
    // This handles paths like: /path/to/'Dir (with parens)'/file
    line = line.replaceAll("'", "");

    // Parse the line for path and optional range
    const entry = parseLine(line);
    entries.push(entry);
    logDebug(
      `Read source path: ${entry.path}${entry.range ? ` (range: ${entry.range.start}-${entry.range.end})` : ""}`,
    );
  }

  logDebug(`Read ${entries.length} source path(s) from ${filePath}`);

  return entries;
}
