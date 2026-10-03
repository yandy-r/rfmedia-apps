/**
 * Unicode-safe width helpers for stderr table rendering.
 *
 * Shared by human-readable tables that write to stderr (history, generations).
 * Uses display-width measurement (string-width + cli-truncate) so alignment
 * stays correct with fullwidth characters, emoji, and ANSI escape codes.
 *
 * Note: the centralized stdout table renderer in `table.ts` keeps its own
 * private equivalents because its layout algorithm and output stream differ.
 *
 * @module rfapps-cli/lib/formatters/width
 */

import stringWidth from "string-width";
import cliTruncate from "cli-truncate";

/**
 * Deterministic fallback width for non-TTY output streams.
 * Consistent with FALLBACK_TABLE_COLUMNS in `table.ts`.
 */
export const FALLBACK_TABLE_COLUMNS = 120;

/**
 * Detect the usable width of the stderr stream.
 *
 * Human-readable tables write to stderr (via console.error), so width is
 * detected from stderr rather than stdout. Falls back to
 * {@link FALLBACK_TABLE_COLUMNS} for non-TTY environments (CI, piped output).
 */
export function getStderrTerminalWidth(): number {
  if (
    process.stderr.isTTY &&
    typeof process.stderr.columns === "number" &&
    process.stderr.columns > 0
  ) {
    return process.stderr.columns;
  }
  return FALLBACK_TABLE_COLUMNS;
}

/**
 * Truncate a string to fit within a given display width using
 * Unicode-aware measurement. Appends an ellipsis marker when truncated.
 *
 * Includes a safety check for fullwidth boundary overflow from cli-truncate.
 *
 * @param text - Text to truncate
 * @param width - Maximum display width in columns
 * @returns Truncated string that fits within the specified width
 */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const result = cliTruncate(text, width, { position: "end" });
  // Safety: cli-truncate can overflow by 1 column at fullwidth boundaries
  if (stringWidth(result) > width) {
    return cliTruncate(text, width - 1, { position: "end" });
  }
  return result;
}

/**
 * Pad a string to a target display width using Unicode-aware measurement.
 *
 * Unlike `String.padEnd()` which counts code units, this function measures
 * the visual display width and adds the correct number of spaces.
 *
 * @param text - Text to pad
 * @param targetWidth - Desired display width in columns
 * @returns Padded string
 */
export function padToWidth(text: string, targetWidth: number): string {
  const currentWidth = stringWidth(text);
  if (currentWidth >= targetWidth) {
    return text;
  }
  return text + " ".repeat(targetWidth - currentWidth);
}

/**
 * Right-align a string to a target display width using Unicode-aware measurement.
 *
 * Used for numeric columns (IDs, generation numbers) for visual consistency.
 *
 * @param text - Text to right-align
 * @param targetWidth - Desired display width in columns
 * @returns Right-aligned string
 */
export function padStartToWidth(text: string, targetWidth: number): string {
  const currentWidth = stringWidth(text);
  if (currentWidth >= targetWidth) {
    return text;
  }
  return " ".repeat(targetWidth - currentWidth) + text;
}
