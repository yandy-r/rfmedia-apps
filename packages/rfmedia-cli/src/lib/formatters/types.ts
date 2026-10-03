/**
 * Formatter type definitions for rfmedia CLI.
 *
 * Provides format-specific configuration and type guards for
 * distinguishing machine-readable vs human-readable output formats.
 */

import type { OutputFormat } from "@rfmedia/common";

/**
 * Options for controlling format-specific output behavior.
 *
 * Used by formatter dispatch to customize output rendering
 * beyond the base format selection.
 */
export interface FormatOptions {
  /** Whether to include ANSI color codes in output (applicable to table/text formats) */
  colorize?: boolean;
  /** Restrict output to specific columns (applicable to csv/table formats) */
  columns?: string[];
}

/** Human-readable formats that are rendered by command code */
const HUMAN_FORMATS: ReadonlySet<OutputFormat> = new Set(["text", "table"]);

/**
 * Check if a format is human-readable (text, table).
 *
 * Human-readable formats are rendered by the command code itself
 * using `console-table-printer` and `format*Output()` functions,
 * not by the generic formatter dispatch.
 *
 * @param format - The output format to check
 * @returns `true` if the format is human-readable
 */
export function isHumanFormat(format: OutputFormat): boolean {
  return HUMAN_FORMATS.has(format);
}
