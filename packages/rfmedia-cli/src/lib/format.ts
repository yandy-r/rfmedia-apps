/**
 * Formatting utilities for console output.
 *
 * Provides helper functions for converting and displaying various data types
 * in a user-friendly format, including star ratings and durations.
 *
 * For display-width-aware truncation (Unicode, emoji, fullwidth characters),
 * use {@link truncateDisplay} or import directly from `./terminal-table.js`.
 */

import { truncateToWidth } from "./terminal-table.js";

/**
 * Unicode star characters for rating display.
 */
const STAR_FILLED = "\u2605"; // Black Star: ★
const STAR_EMPTY = "\u2606"; // White Star: ☆

/**
 * Convert a Plex rating (0-10 scale) to a star display string.
 *
 * Plex stores ratings on a 0-10 scale internally, where:
 * - 0 = unrated
 * - 2 = 1 star
 * - 4 = 2 stars
 * - 6 = 3 stars
 * - 8 = 4 stars
 * - 10 = 5 stars
 *
 * Half-step ratings (odd values like 5) are accepted and rounded up to the next
 * full star when displayed (e.g., 5 → "★★★☆☆").
 *
 * @param rating - Plex rating on 0-10 scale
 * @returns Star display string (e.g., "★★★★☆" for rating 8)
 */
export function ratingToStars(rating: number): string {
  // Handle unrated or invalid numeric items
  if (rating === 0 || rating === undefined || rating === null || isNaN(rating)) {
    return "-----";
  }

  // Convert 0-10 scale to 0-5 star scale
  const starValue = rating / 2;
  const fullStars = Math.floor(starValue);
  const hasHalfStar = starValue % 1 >= 0.5;

  let result = "";

  // Add filled stars
  for (let i = 0; i < fullStars; i++) {
    result += STAR_FILLED;
  }

  // Add half star as a filled star (simplification)
  if (hasHalfStar && fullStars < 5) {
    result += STAR_FILLED;
  }

  // Fill remaining with empty stars
  const totalStars = fullStars + (hasHalfStar ? 1 : 0);
  for (let i = totalStars; i < 5; i++) {
    result += STAR_EMPTY;
  }

  return result;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param durationMs - Duration in milliseconds
 * @returns Formatted duration string (e.g., "3:45" for 225000ms)
 */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 *
 * Uses raw `string.length` for width measurement, which does not account
 * for fullwidth Unicode characters (CJK, emoji). For new code, prefer
 * {@link truncateDisplay} which provides Unicode-safe display-width-aware
 * truncation.
 *
 * Retained for backward compatibility with callers that only handle
 * ASCII content.
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length including ellipsis
 * @returns Truncated string
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + "...";
}

/**
 * Truncate a string to a maximum display width using Unicode-aware
 * width measurement.
 *
 * This is the **preferred** width-aware alternative to {@link truncate}
 * for all new code. It correctly handles fullwidth characters (CJK),
 * emoji, and ANSI escape codes by measuring visual column width rather
 * than raw string length.
 *
 * Internally delegates to `truncateToWidth` from the terminal-table
 * width-policy module.
 *
 * @param str - String to truncate
 * @param maxWidth - Maximum display width in terminal columns
 * @returns Truncated string that fits within the specified display width
 */
export function truncateDisplay(str: string, maxWidth: number): string {
  return truncateToWidth(str, maxWidth);
}
