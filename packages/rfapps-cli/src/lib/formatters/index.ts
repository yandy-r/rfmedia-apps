/**
 * Formatter factory and dispatch for rfapps CLI.
 *
 * Provides a unified `formatOutput()` function that routes data to the
 * correct formatter based on the active output format:
 *
 * - **json, yaml, csv**: Delegates to `@rfmedia/common`'s `formatMachineOutput()`
 *   which serializes data and writes to stdout.
 * - **table**: Uses the built-in table renderer which writes to stdout
 *   (human-readable structured output).
 * - **text**: Returns early -- actions handle their own human-readable rendering.
 *
 * Uses lazy dynamic imports for each formatter module to maintain fast CLI startup.
 *
 * @module rfapps-cli/lib/formatters
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { OutputFormat } from "@rfmedia/common";

import type { FormatOptions } from "./types.js";

// Re-export types for consumer convenience
export type { FormatOptions } from "./types.js";
export { isHumanFormat } from "./types.js";

// Re-export diff helpers
export {
  formatChangeType,
  formatDirection,
  formatDiffValue,
  formatArrayDiff,
} from "./diff-helpers.js";

// Re-export contextual plan annotation renderers (`rfapps plan --explain`)
export {
  formatServiceIntelligenceLines,
  formatPlanIntelligenceLines,
} from "./plan-intelligence.js";

// Re-export Unicode-safe width helpers for stderr table rendering
export {
  FALLBACK_TABLE_COLUMNS,
  getStderrTerminalWidth,
  truncateToWidth,
  padToWidth,
  padStartToWidth,
} from "./width.js";

// Re-export deployment-state display helpers (colors, timestamps)
export { formatTimestamp, getStatusColor, getActionColor } from "./state-display.js";
export {
  projectConflictValidationTable,
  type ConflictValidationTableRow,
} from "./conflict-validation-table.js";

type FormatOutputCapture = (format: OutputFormat, data: unknown) => void;

const formatOutputCaptureStorage = new AsyncLocalStorage<FormatOutputCapture>();

/**
 * Run formatter output within a scoped capture context.
 *
 * When active, calls to `formatOutput()` with non-text formats send their raw
 * payload to the capture callback instead of writing to stdout.
 */
export async function withFormatOutputCapture<TResult>(
  capture: FormatOutputCapture,
  execute: () => Promise<TResult>,
): Promise<TResult> {
  return formatOutputCaptureStorage.run(capture, execute);
}

/**
 * Format and output data in the specified format.
 *
 * This is the main dispatch function for rfapps-cli output. It routes
 * data to the appropriate formatter based on the format value:
 *
 * - `"text"` - Returns early (action handles its own human-readable output)
 * - `"table"` - Renders a structured table to stdout via the built-in table renderer
 * - `"json"`, `"yaml"`, `"csv"` - Delegates to `@rfmedia/common`'s machine output
 *   serializers which write to stdout
 *
 * @param format - The output format to use
 * @param data - The data to format and output
 * @param options - Optional format-specific configuration
 */
export async function formatOutput(
  format: OutputFormat,
  data: unknown,
  options?: FormatOptions,
): Promise<void> {
  // Text format is handled by the action's own rendering logic
  if (format === "text") {
    return;
  }

  const capture = formatOutputCaptureStorage.getStore();
  if (capture !== undefined) {
    capture(format, data);
    return;
  }

  // Table format: human-readable structured output to stdout
  if (format === "table") {
    const { renderTable } = await import("./table.js");
    renderTable(data, options?.columns);
    return;
  }

  // Machine-readable formats: delegate to @rfmedia/common serializers (stdout)
  const { formatMachineOutput } = await import("@rfmedia/common");
  if (options && options.columns !== undefined) {
    await formatMachineOutput(format, data, { columns: options.columns });
    return;
  }
  await formatMachineOutput(format, data);
}
