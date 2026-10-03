/**
 * Range parsing utilities for the copy command.
 *
 * This module provides functions for parsing and formatting range-based
 * suffixes used in album mode copying (e.g., --range=001-010).
 */

import { readdir } from "node:fs/promises";
import { InvalidArgumentError } from "commander";
import type { CopyRange } from "../types/index.js";

/**
 * Regular expression for validating range format.
 * Matches patterns like "001-010", "1-5", "0001-0100".
 * Exported for use in input file parsing.
 */
export const RANGE_PATTERN = /^(\d+)-(\d+)$/;

/**
 * Parses a range string into a CopyRange object.
 *
 * The range format is "START-END" where START and END are numeric values.
 * The pad width is derived from the length of the START string, preserving
 * leading zeros from the input.
 *
 * @param value - The range string to parse (e.g., "001-010")
 * @returns A CopyRange object with start, end, and padWidth
 * @throws InvalidArgumentError if the format is invalid or start > end
 *
 * @example
 * parseRange("001-010")
 * // Returns: { start: 1, end: 10, padWidth: 3 }
 *
 * @example
 * parseRange("1-5")
 * // Returns: { start: 1, end: 5, padWidth: 1 }
 */
export function parseRange(value: string): CopyRange {
  const match = value.match(RANGE_PATTERN);

  if (!match) {
    throw new InvalidArgumentError("Range must be in format START-END (e.g., 001-010)");
  }

  const [, startStr, endStr] = match;

  // TypeScript knows these are strings from the regex match,
  // but we add guards for defensive programming
  if (startStr === undefined || endStr === undefined) {
    throw new InvalidArgumentError("Range must be in format START-END (e.g., 001-010)");
  }

  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);

  if (start > end) {
    throw new InvalidArgumentError(
      `Range start (${start}) must be less than or equal to end (${end})`,
    );
  }

  return {
    start,
    end,
    padWidth: startStr.length,
  };
}

/**
 * Formats a number as a zero-padded suffix string.
 *
 * @param num - The number to format
 * @param padWidth - The minimum width to pad to
 * @returns A zero-padded string representation of the number
 *
 * @example
 * formatSuffix(1, 3)
 * // Returns: "001"
 *
 * @example
 * formatSuffix(42, 2)
 * // Returns: "42"
 *
 * @example
 * formatSuffix(100, 2)
 * // Returns: "100" (exceeds pad width, no truncation)
 */
export function formatSuffix(num: number, padWidth: number): string {
  return String(num).padStart(padWidth, "0");
}

/**
 * Checks if a string is a valid range format.
 *
 * Unlike parseRange, this function does not throw an error for invalid input.
 * It simply returns true/false indicating validity.
 *
 * @param value - The string to test
 * @returns True if the value matches the range pattern (e.g., "001-010")
 *
 * @example
 * isValidRange("001-010")
 * // Returns: true
 *
 * @example
 * isValidRange("invalid")
 * // Returns: false
 *
 * @example
 * isValidRange("/path/to/album")
 * // Returns: false
 */
export function isValidRange(value: string): boolean {
  return RANGE_PATTERN.test(value);
}

/**
 * Attempts to parse a range string, returning null if invalid.
 *
 * Unlike parseRange, this function does not throw an error for invalid input.
 * It's useful for optional range parsing where null is an acceptable result.
 *
 * @param value - The range string to parse (e.g., "001-010")
 * @returns A CopyRange object if valid, null otherwise
 *
 * @example
 * tryParseRange("001-010")
 * // Returns: { start: 1, end: 10, padWidth: 3 }
 *
 * @example
 * tryParseRange("invalid")
 * // Returns: null
 *
 * @example
 * tryParseRange("10-5")  // start > end
 * // Returns: null
 */
export function tryParseRange(value: string): CopyRange | null {
  const match = value.match(RANGE_PATTERN);

  if (!match) {
    return null;
  }

  const [, startStr, endStr] = match;

  if (startStr === undefined || endStr === undefined) {
    return null;
  }

  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);

  // Invalid if start > end
  if (start > end) {
    return null;
  }

  return {
    start,
    end,
    padWidth: startStr.length,
  };
}

/**
 * Detects the highest suffix in a directory by scanning for numbered patterns.
 * Returns the highest suffix number and its padding width, or null if none found.
 *
 * Scans for directories/files matching the pattern `*-XXX` where XXX is 3+ digits.
 *
 * @param destDir - Directory to scan for numbered items
 * @returns Object with highestSuffix and padWidth, or null if no numbered items found
 *
 * @example
 * await detectHighestSuffix("/music/Artist")
 * // Returns: { highestSuffix: 5, padWidth: 3 } if Album-001 through Album-005 exist
 *
 * @example
 * await detectHighestSuffix("/music/EmptyArtist")
 * // Returns: null
 */
export async function detectHighestSuffix(
  destDir: string,
): Promise<{ highestSuffix: number; padWidth: number } | null> {
  try {
    const entries = await readdir(destDir, { withFileTypes: true });

    // Pattern matches: anything ending with -XXX where XXX is 3+ digits
    const suffixPattern = /^(.+)-(\d{3,})$/;

    let highestSuffix = -1;
    let padWidth = 3; // Default padding width

    for (const entry of entries) {
      // Only check directories (album folders)
      if (!entry.isDirectory()) {
        continue;
      }

      const match = entry.name.match(suffixPattern);
      if (!match || !match[2]) {
        continue;
      }

      const suffixStr = match[2];
      const suffixNum = parseInt(suffixStr, 10);

      if (suffixNum > highestSuffix) {
        highestSuffix = suffixNum;
        padWidth = suffixStr.length;
      }
    }

    if (highestSuffix === -1) {
      return null;
    }

    return { highestSuffix, padWidth };
  } catch (err) {
    // Directory doesn't exist or can't be read - treat as empty
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Detects the highest file suffix in a directory by scanning for numbered file patterns.
 * Scans for files matching pattern `*-XXX.ext` where XXX is 3+ digits.
 *
 * Unlike detectHighestSuffix() which scans directories (for album folders),
 * this function scans files (for individual track copies).
 *
 * @param destDir - Directory to scan for numbered files
 * @returns Object with highestSuffix and padWidth, or null if no numbered files found
 *
 * @example
 * await detectHighestFileSuffix("/music/Playlist")
 * // Returns: { highestSuffix: 5, padWidth: 3 } if Track-001.flac through Track-005.flac exist
 *
 * @example
 * await detectHighestFileSuffix("/music/EmptyPlaylist")
 * // Returns: null
 */
export async function detectHighestFileSuffix(
  destDir: string,
): Promise<{ highestSuffix: number; padWidth: number } | null> {
  try {
    const entries = await readdir(destDir, { withFileTypes: true });

    // Pattern matches: anything ending with -XXX.ext where XXX is 3+ digits
    // Captures: base name, suffix digits, extension
    const suffixPattern = /^(.+)-(\d{3,})(\.[^.]+)$/;

    let highestSuffix = -1;
    let padWidth = 3; // Default padding width

    for (const entry of entries) {
      // Only check files (not directories)
      if (!entry.isFile()) {
        continue;
      }

      const match = entry.name.match(suffixPattern);
      if (!match || !match[2]) {
        continue;
      }

      const suffixStr = match[2];
      const suffixNum = parseInt(suffixStr, 10);

      if (suffixNum > highestSuffix) {
        highestSuffix = suffixNum;
        padWidth = suffixStr.length;
      }
    }

    if (highestSuffix === -1) {
      return null;
    }

    return { highestSuffix, padWidth };
  } catch (err) {
    // Directory doesn't exist or can't be read - treat as empty
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Builds a CopyRange from count and detected highest suffix.
 *
 * @param count - Number of copies to create
 * @param highestSuffix - Highest existing suffix number (0 if none)
 * @param padWidth - Zero-padding width to use
 * @returns CopyRange object for creating numbered copies
 *
 * @example
 * buildAutoRange(3, 5, 3)
 * // Returns: { start: 6, end: 8, padWidth: 3 }
 *
 * @example
 * buildAutoRange(2, 0, 3)
 * // Returns: { start: 1, end: 2, padWidth: 3 }
 */
export function buildAutoRange(count: number, highestSuffix: number, padWidth: number): CopyRange {
  return {
    start: highestSuffix + 1,
    end: highestSuffix + count,
    padWidth,
  };
}

/**
 * Formats a CopyRange for logging (e.g., "001-005").
 *
 * @param range - CopyRange to format
 * @returns Formatted range string with zero-padding
 *
 * @example
 * formatRange({ start: 1, end: 5, padWidth: 3 })
 * // Returns: "001-005"
 *
 * @example
 * formatRange({ start: 10, end: 20, padWidth: 2 })
 * // Returns: "10-20"
 */
export function formatRange(range: CopyRange): string {
  return `${formatSuffix(range.start, range.padWidth)}-${formatSuffix(range.end, range.padWidth)}`;
}
