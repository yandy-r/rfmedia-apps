/**
 * Terminal table width-policy utility.
 *
 * Provides deterministic width detection, column budget allocation,
 * and Unicode-safe truncation helpers for human-readable table output.
 *
 * Phase-1 semantics: single-line truncation with ellipsis marker (no wrapping).
 */

import stringWidth from "string-width";
import cliTruncate from "cli-truncate";

/**
 * Deterministic fallback width for non-TTY output streams.
 * Used when `isTTY` is false or `columns` is unavailable (e.g., CI, piped output).
 */
export const FALLBACK_TABLE_COLUMNS = 120;

/**
 * Minimum usable terminal width. Below this threshold, table rendering
 * degrades gracefully by assigning minimum widths to all columns.
 */
const MIN_USABLE_WIDTH = 40;

/**
 * Column definition for table layout calculation.
 */
export interface ColumnDef {
  /** Column identifier / header name */
  name: string;
  /** Minimum width this column requires (including content and padding) */
  minWidth: number;
  /** Whether this column should expand to fill remaining space */
  flex: boolean;
  /** Column alignment hint */
  alignment: "left" | "right" | "center";
}

/**
 * Result of column width calculation.
 */
export interface ColumnWidthResult {
  /** Column name matching the input ColumnDef */
  name: string;
  /** Allocated width for the column content */
  width: number;
}

/**
 * Detect the usable width of the given output stream.
 *
 * Returns the stream's `columns` property if the stream is a TTY,
 * otherwise falls back to `FALLBACK_TABLE_COLUMNS`.
 *
 * @param stream - Output stream to check (defaults to `process.stdout`)
 * @returns Terminal width in columns
 */
export function getTerminalWidth(stream?: NodeJS.WriteStream): number {
  const target = stream ?? process.stdout;

  if (target.isTTY && typeof target.columns === "number" && target.columns > 0) {
    return target.columns;
  }

  return FALLBACK_TABLE_COLUMNS;
}

/**
 * Calculate allocated widths for each column given a total available width.
 *
 * Fixed columns receive their `minWidth`. Flex columns share the remaining
 * width equally, each receiving at least their `minWidth`. If the total
 * available width is smaller than the sum of all minimum widths, every
 * column receives its `minWidth` (the table will overflow).
 *
 * @param columns - Column definitions describing fixed and flex columns
 * @param totalWidth - Total available terminal width
 * @returns Array of column width allocations in the same order as input
 */
export function calculateColumnWidths(
  columns: ColumnDef[],
  totalWidth: number,
): ColumnWidthResult[] {
  const effectiveWidth = Math.max(totalWidth, MIN_USABLE_WIDTH);

  // Sum of all minimum widths
  const totalMinWidth = columns.reduce((sum, col) => sum + col.minWidth, 0);

  // If total width cannot satisfy minimums, give everyone their minimum
  if (effectiveWidth <= totalMinWidth) {
    return columns.map((col) => ({
      name: col.name,
      width: col.minWidth,
    }));
  }

  // Budget for fixed columns
  const fixedBudget = columns
    .filter((col) => !col.flex)
    .reduce((sum, col) => sum + col.minWidth, 0);

  // Remaining width for flex columns
  const flexColumns = columns.filter((col) => col.flex);
  const flexMinBudget = flexColumns.reduce((sum, col) => sum + col.minWidth, 0);
  const remainingWidth = effectiveWidth - fixedBudget;

  // Distribute remaining width equally among flex columns
  let flexWidthPerColumn = 0;
  let flexRemainder = 0;

  if (flexColumns.length > 0) {
    if (remainingWidth <= flexMinBudget) {
      // Not enough room: each flex column gets its minimum
      flexWidthPerColumn = 0; // Will use minWidth below
    } else {
      flexWidthPerColumn = Math.floor(remainingWidth / flexColumns.length);
      flexRemainder = remainingWidth - flexWidthPerColumn * flexColumns.length;
    }
  }

  let flexIndex = 0;

  return columns.map((col) => {
    if (!col.flex) {
      return { name: col.name, width: col.minWidth };
    }

    // Flex column: use distributed width (at least minWidth)
    let width: number;
    if (remainingWidth <= flexMinBudget) {
      width = col.minWidth;
    } else {
      width = flexWidthPerColumn;
      // Distribute leftover pixels to the first flex columns
      if (flexIndex < flexRemainder) {
        width += 1;
      }
    }

    // Ensure flex columns never go below their minimum
    width = Math.max(width, col.minWidth);
    flexIndex++;

    return { name: col.name, width };
  });
}

/**
 * Truncate a string to fit within a given display width using
 * Unicode-aware width measurement.
 *
 * Uses `cli-truncate` which handles fullwidth characters, emoji,
 * and ANSI escape codes correctly. The truncation marker is an
 * ellipsis character appended at the end.
 *
 * Note: `cli-truncate` can exceed the requested width by 1 column
 * when a fullwidth character falls on the truncation boundary.
 * This function applies a secondary pass to guarantee the width
 * constraint is respected.
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

  // Safety: cli-truncate can overflow by 1 column at fullwidth boundaries.
  // If that happens, retry with width - 1 to guarantee the constraint.
  if (stringWidth(result) > width) {
    return cliTruncate(text, width - 1, { position: "end" });
  }

  return result;
}

/**
 * Measure the visual display width of a string.
 *
 * Accounts for fullwidth Unicode characters (CJK), emoji, and
 * ANSI escape codes. This is the correct replacement for `.length`
 * when calculating terminal column usage.
 *
 * @param text - Text to measure
 * @returns Display width in terminal columns
 */
export function displayWidth(text: string): number {
  return stringWidth(text);
}
