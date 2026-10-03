/**
 * Output format type and state management for rfmedia CLI tools.
 *
 * Provides a centralized output format state that determines:
 * - Whether log output is suppressed (machine-readable formats)
 * - Which serializer to use for structured output
 * - Whether progress rendering should be silent
 *
 * Machine-readable formats (json, yaml, csv) suppress all human-readable
 * output (logs, progress spinners) to keep stdout clean for data.
 * Human-readable formats (text, table) allow normal log and progress output.
 */

/**
 * Supported output format values.
 *
 * - `"text"` - Default human-readable output (action/command handles rendering)
 * - `"table"` - Structured table output (CLI-specific rendering)
 * - `"json"` - JSON serialization to stdout
 * - `"yaml"` - YAML serialization to stdout
 * - `"csv"` - CSV serialization to stdout
 */
export const OUTPUT_FORMATS = ["json", "yaml", "csv", "table", "text"] as const;

/**
 * Supported output format types.
 */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Generic formatter interface for structured output.
 *
 * Implementations convert typed data into a formatted string
 * for a specific output format.
 */
export interface Formatter<T = unknown> {
  format(data: T): string;
}

/** Machine-readable formats that suppress human-readable output */
const MACHINE_FORMATS: ReadonlySet<OutputFormat> = new Set(["json", "yaml", "csv"]);

/**
 * Check if a value is a valid output format string.
 *
 * @param value - The value to validate
 * @returns `true` if the value is a supported output format
 */
export function isValidOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string" && OUTPUT_FORMATS.includes(value as OutputFormat);
}

/** Module-level output format state */
let activeFormat: OutputFormat = "text";

/**
 * Set the active output format.
 *
 * When set to a machine-readable format (json, yaml, csv), all log output
 * and progress rendering will be suppressed.
 *
 * @param format - The output format to activate
 */
export function setOutputFormat(format: OutputFormat): void {
  activeFormat = format;
}

/**
 * Get the currently active output format.
 *
 * @returns The active output format (defaults to "text")
 */
export function getOutputFormat(): OutputFormat {
  return activeFormat;
}

/**
 * Check if a format is machine-readable (json, yaml, csv).
 *
 * Machine-readable formats suppress all human-readable output (logs, progress)
 * to keep stdout clean for structured data.
 *
 * When called without an argument, checks the currently active output format.
 *
 * @param format - Optional format to check. If omitted, checks the active format.
 * @returns `true` if the format is machine-readable
 */
export function isMachineFormat(format?: OutputFormat): boolean {
  return MACHINE_FORMATS.has(format ?? activeFormat);
}
