/**
 * Basic table renderer for rfapps CLI structured output.
 *
 * Uses Unicode-safe width measurement and truncation for correct alignment
 * with fullwidth characters, emoji, and ANSI escape codes. Terminal width
 * is detected dynamically from the output stream with a deterministic
 * fallback for non-TTY environments.
 *
 * Table output is human-readable and goes to stdout via console.log().
 *
 * @module rfapps-cli/lib/formatters/table
 */

import stringWidth from "string-width";
import cliTruncate from "cli-truncate";

/**
 * Deterministic fallback width for non-TTY output streams.
 * Used when `isTTY` is false or `columns` is unavailable (e.g., CI, piped output).
 */
const FALLBACK_TABLE_COLUMNS = 120;

/**
 * Column gutter width (spacing between columns).
 */
const COLUMN_GAP = 2;

/**
 * Left margin prefix for all table rows.
 */
const ROW_PREFIX = "  ";

/**
 * Minimum column content width before truncation is applied.
 */
const MIN_COLUMN_WIDTH = 4;

/**
 * Detect the usable width of the stdout stream.
 *
 * Returns the stream's `columns` property if stdout is a TTY,
 * otherwise falls back to `FALLBACK_TABLE_COLUMNS`.
 */
function getTerminalWidth(): number {
  if (
    process.stdout.isTTY &&
    typeof process.stdout.columns === "number" &&
    process.stdout.columns > 0
  ) {
    return process.stdout.columns;
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
function truncateToWidth(text: string, width: number): string {
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
function padToWidth(text: string, targetWidth: number): string {
  const currentWidth = stringWidth(text);
  if (currentWidth >= targetWidth) {
    return text;
  }
  return text + " ".repeat(targetWidth - currentWidth);
}

/**
 * Render data as a formatted table to stdout.
 *
 * Handles three data shapes:
 * - Array of objects: each object becomes a row, keys become column headers
 * - Single object: rendered as a key-value list (two columns)
 * - Primitive/empty: rendered as a single value
 *
 * Column widths are auto-calculated based on content with a configurable
 * set of visible columns. The table adapts to the terminal width and uses
 * Unicode-safe measurement for correct alignment.
 *
 * @param data - The data to render as a table
 * @param columns - Optional list of column names to include (default: all keys)
 */
export function renderTable(data: unknown, columns?: string[]): void {
  if (data === null || data === undefined) {
    console.log("(no data)");
    return;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log("(empty)");
      return;
    }

    renderArrayTable(data as Record<string, unknown>[], columns);
    return;
  }

  if (typeof data === "object") {
    renderObjectTable(data as Record<string, unknown>);
    return;
  }

  // Primitive value
  console.log(String(data));
}

/**
 * Render an array of objects as a table with column headers.
 *
 * Each object becomes a row. Keys from the first object determine
 * the default column set unless explicitly overridden.
 *
 * Column widths are allocated within the available terminal width:
 * 1. Measure the natural (max content) width for each column.
 * 2. If the total natural width fits within the terminal, use natural widths.
 * 3. Otherwise, allocate proportionally and truncate oversized cells.
 *
 * @param rows - Array of row objects
 * @param columns - Optional column filter
 */
function renderArrayTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (rows.length === 0) {
    console.log("(empty)");
    return;
  }

  // Determine columns from first row or filter
  const allKeys = Object.keys(rows[0] as Record<string, unknown>);
  const visibleColumns =
    columns !== undefined ? columns.filter((c) => allKeys.includes(c)) : allKeys;

  if (visibleColumns.length === 0) {
    console.log("(no matching columns)");
    return;
  }

  // Calculate natural (max content) width per column using display width
  const naturalWidths = new Map<string, number>();
  for (const col of visibleColumns) {
    naturalWidths.set(col, stringWidth(col));
  }

  for (const row of rows) {
    for (const col of visibleColumns) {
      const value = formatCellValue(row[col]);
      const current = naturalWidths.get(col) ?? stringWidth(col);
      naturalWidths.set(col, Math.max(current, stringWidth(value)));
    }
  }

  // Calculate allocated widths within terminal budget
  const allocatedWidths = allocateColumnWidths(visibleColumns, naturalWidths);

  // Render header
  const headerParts: string[] = [];
  for (const col of visibleColumns) {
    const width = allocatedWidths.get(col) ?? stringWidth(col);
    headerParts.push(padToWidth(truncateToWidth(col, width), width));
  }
  const gap = " ".repeat(COLUMN_GAP);
  const header = ROW_PREFIX + headerParts.join(gap);
  const separatorWidth = stringWidth(header) - stringWidth(ROW_PREFIX);
  const separator = ROW_PREFIX + "-".repeat(separatorWidth);

  console.log("");
  console.log(header);
  console.log(separator);

  // Render rows
  for (const row of rows) {
    const rowParts: string[] = [];
    for (const col of visibleColumns) {
      const width = allocatedWidths.get(col) ?? stringWidth(col);
      const value = formatCellValue(row[col]);
      rowParts.push(padToWidth(truncateToWidth(value, width), width));
    }
    console.log(ROW_PREFIX + rowParts.join(gap));
  }

  console.log("");
}

/**
 * Allocate column widths to fit within the available terminal width.
 *
 * If natural widths fit, they are used as-is. Otherwise, columns are
 * shrunk proportionally. Every column gets at least MIN_COLUMN_WIDTH.
 *
 * @param visibleColumns - Ordered list of column names
 * @param naturalWidths - Map of column name to natural (max content) width
 * @returns Map of column name to allocated width
 */
function allocateColumnWidths(
  visibleColumns: string[],
  naturalWidths: Map<string, number>,
): Map<string, number> {
  const terminalWidth = getTerminalWidth();
  const prefixWidth = stringWidth(ROW_PREFIX);
  const totalGapWidth = (visibleColumns.length - 1) * COLUMN_GAP;
  const availableContentWidth = terminalWidth - prefixWidth - totalGapWidth;

  // Sum of all natural widths
  const totalNaturalWidth = visibleColumns.reduce(
    (sum, col) => sum + (naturalWidths.get(col) ?? MIN_COLUMN_WIDTH),
    0,
  );

  const allocated = new Map<string, number>();

  if (totalNaturalWidth <= availableContentWidth) {
    // All columns fit at their natural width
    for (const col of visibleColumns) {
      allocated.set(col, naturalWidths.get(col) ?? MIN_COLUMN_WIDTH);
    }
    return allocated;
  }

  // Shrink columns proportionally to fit within available width
  // First pass: ensure every column gets at least MIN_COLUMN_WIDTH
  const effectiveAvailable = Math.max(
    availableContentWidth,
    visibleColumns.length * MIN_COLUMN_WIDTH,
  );

  // Proportional distribution
  let remainingWidth = effectiveAvailable;
  let remainingNatural = totalNaturalWidth;
  const tempWidths: number[] = [];

  for (let i = 0; i < visibleColumns.length; i++) {
    const col = visibleColumns[i] as string;
    const natural = naturalWidths.get(col) ?? MIN_COLUMN_WIDTH;

    if (i === visibleColumns.length - 1) {
      // Last column gets whatever remains
      tempWidths.push(Math.max(remainingWidth, MIN_COLUMN_WIDTH));
    } else {
      // Proportional share based on natural width
      const share = Math.max(
        Math.floor((natural / remainingNatural) * remainingWidth),
        MIN_COLUMN_WIDTH,
      );
      tempWidths.push(share);
      remainingWidth -= share;
      remainingNatural -= natural;
      // Ensure remaining natural stays positive for division
      if (remainingNatural <= 0) {
        remainingNatural = 1;
      }
    }
  }

  // Second pass: cap to natural widths, then redistribute any leftover
  // width (discarded by capping) to columns that are still truncated.
  const allocatedArray: number[] = [];
  let allocatedTotal = 0;

  for (let i = 0; i < visibleColumns.length; i++) {
    const col = visibleColumns[i] as string;
    const natural = naturalWidths.get(col) ?? MIN_COLUMN_WIDTH;
    const cappedWidth = Math.min(tempWidths[i] as number, natural);
    allocatedArray[i] = cappedWidth;
    allocatedTotal += cappedWidth;
    allocated.set(col, cappedWidth);
  }

  let leftover = effectiveAvailable - allocatedTotal;

  if (leftover > 0) {
    const deficits: number[] = [];
    let totalDeficit = 0;

    for (let i = 0; i < visibleColumns.length; i++) {
      const col = visibleColumns[i] as string;
      const natural = naturalWidths.get(col) ?? MIN_COLUMN_WIDTH;
      const deficit = Math.max(natural - (allocatedArray[i] ?? 0), 0);
      deficits[i] = deficit;
      totalDeficit += deficit;
    }

    if (totalDeficit > 0) {
      let remainingExtra = leftover;

      for (let i = 0; i < visibleColumns.length && remainingExtra > 0; i++) {
        const deficit = deficits[i];
        if (deficit === undefined || deficit <= 0) continue;
        const proportionalShare = Math.floor((deficit / totalDeficit) * leftover);
        if (proportionalShare <= 0) continue;
        const add = Math.min(deficit, proportionalShare, remainingExtra);
        if (add <= 0) continue;
        allocatedArray[i] = (allocatedArray[i] ?? 0) + add;
        remainingExtra -= add;
      }

      let guard = visibleColumns.length * 10;
      while (remainingExtra > 0 && guard > 0) {
        let progressed = false;
        for (let i = 0; i < visibleColumns.length && remainingExtra > 0; i++) {
          const col = visibleColumns[i] as string;
          const natural = naturalWidths.get(col) ?? MIN_COLUMN_WIDTH;
          if (allocatedArray[i] ?? 0 >= natural) continue;
          allocatedArray[i] = (allocatedArray[i] ?? 0) + 1;
          remainingExtra -= 1;
          progressed = true;
        }
        if (!progressed) break;
        guard -= 1;
      }

      for (let i = 0; i < visibleColumns.length; i++) {
        const col = visibleColumns[i] as string;
        allocated.set(col, allocatedArray[i] ?? 0);
      }
    }
  }

  return allocated;
}

/**
 * Render a single object as a key-value table.
 *
 * Each key becomes a row with two columns: Key and Value.
 * Uses Unicode-safe width measurement for key column sizing.
 *
 * @param obj - Object to render
 */
function renderObjectTable(obj: Record<string, unknown>): void {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    console.log("(empty)");
    return;
  }

  // Calculate key column width using display width
  const maxKeyWidth = Math.max(...entries.map(([key]) => stringWidth(key)));
  const keyWidth = Math.max(maxKeyWidth, stringWidth("Key")); // minimum "Key" header

  const terminalWidth = getTerminalWidth();
  const prefixWidth = stringWidth(ROW_PREFIX);
  const gapWidth = COLUMN_GAP;
  const valueWidth = Math.max(terminalWidth - prefixWidth - keyWidth - gapWidth, MIN_COLUMN_WIDTH);

  const gap = " ".repeat(gapWidth);

  console.log("");
  console.log(ROW_PREFIX + padToWidth("Key", keyWidth) + gap + "Value");
  console.log(ROW_PREFIX + "-".repeat(keyWidth + gapWidth + Math.min(valueWidth, 20)));

  for (const [key, value] of entries) {
    const formattedValue = formatCellValue(value);
    const truncatedValue = truncateToWidth(formattedValue, valueWidth);
    console.log(ROW_PREFIX + padToWidth(key, keyWidth) + gap + truncatedValue);
  }

  console.log("");
}

/**
 * Format a cell value as a string for table display.
 *
 * Arrays are joined with commas. Objects are JSON-stringified inline.
 * Null/undefined become "-".
 *
 * @param value - The cell value to format
 * @returns Formatted string
 */
function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
