/**
 * rfmedia-cli format dispatch layer.
 *
 * Provides a unified `formatOutput()` function that routes structured data
 * to the appropriate serializer based on the active output format.
 *
 * Machine-readable formats (json, yaml, csv) delegate to `@rfmedia/common`'s
 * generic serializers, which write directly to stdout.
 *
 * Human-readable formats (text, table) return early -- rfmedia-cli commands
 * handle their own human-readable rendering via `console-table-printer` and
 * local `format*Output()` functions.
 *
 * @module formatters
 */

import type { OutputFormat } from "@rfmedia/common";
import type { CsvOptions } from "@rfmedia/common";
import type { FormatOptions } from "./types.js";

export type { FormatOptions } from "./types.js";
export { isHumanFormat } from "./types.js";

const CSV_FORMULA_PREFIX = /^[\t\r\n=+\-@]/u;

/**
 * Prefixes spreadsheet-formula-looking CSV cell values with an apostrophe.
 *
 * JSON and YAML output retain the original values; this copy is created only
 * for CSV serialization. Arrays and plain records are traversed because the
 * shared serializer accepts both shapes and flattens nested records.
 */
function neutralizeCsvFormulaCells(value: unknown): unknown {
  if (typeof value === "string") {
    return CSV_FORMULA_PREFIX.test(value) ? `'${value}` : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const neutralized = neutralizeCsvFormulaCells(item);
      changed ||= neutralized !== item;
      return neutralized;
    });
    return changed ? items : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const neutralized = neutralizeCsvFormulaCells(item);
      changed ||= neutralized !== item;
      return [key, neutralized] as const;
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

/**
 * Format and output data in the specified format.
 *
 * For machine-readable formats (json, yaml, csv), delegates to
 * `@rfmedia/common`'s `formatMachineOutput()` which serializes the data
 * and writes the result to stdout.
 *
 * For human-readable formats (text, table), returns early without output.
 * Commands handle their own human-readable rendering using
 * `console-table-printer` and local `format*Output()` functions.
 *
 * @param format - The output format to use
 * @param data - The data to serialize and output
 * @param options - Optional format-specific configuration
 */
export async function formatOutput(
  format: OutputFormat,
  data: unknown,
  options?: FormatOptions,
): Promise<void> {
  // Human-readable formats are handled by command code directly
  if (format === "text" || format === "table") {
    return;
  }

  // Machine-readable formats delegate to @rfmedia/common
  const { formatMachineOutput } = await import("@rfmedia/common");

  const csvOptions: CsvOptions | undefined = options?.columns
    ? { columns: options.columns }
    : undefined;

  await formatMachineOutput(
    format,
    format === "csv" ? neutralizeCsvFormulaCells(data) : data,
    csvOptions,
  );
}
