/**
 * Generic serializers for machine-readable CLI output formats.
 *
 * Provides a unified dispatch function that selects the correct serializer
 * (JSON, YAML, or CSV) based on the active output format and writes the
 * result to stdout.
 *
 * Human-readable formats ("text", "table") are not handled here --
 * those are CLI-specific and managed by each package's formatter layer.
 *
 * @module formatters
 */

import type { OutputFormat } from "../output.js";
import type { CsvOptions } from "./csv.js";

export type { CsvOptions } from "./csv.js";

/**
 * Get the serializer function for a given machine-readable format.
 *
 * Uses lazy dynamic imports to avoid loading serializer modules
 * until they are needed, maintaining fast CLI startup.
 *
 * @param format - The machine-readable output format
 * @returns The serializer function for the specified format
 * @throws Error if the format is not a supported machine format
 */
async function getSerializer(
  format: OutputFormat,
): Promise<(data: unknown, options?: CsvOptions) => string> {
  switch (format) {
    case "json":
      return (await import("./json.js")).formatAsJson;
    case "yaml":
      return (await import("./yaml.js")).formatAsYaml;
    case "csv":
      return (await import("./csv.js")).formatAsCsv;
    default:
      throw new Error(`Unsupported machine format: ${format}`);
  }
}

/**
 * Format and output data in the specified machine-readable format.
 *
 * Selects the correct serializer for the given format, serializes the data,
 * and writes the result to stdout via `console.log()`.
 *
 * Returns early with no-op for "text" and "table" formats, as those
 * are handled by CLI-specific rendering logic.
 *
 * @param format - The output format to use
 * @param data - The data to serialize and output
 * @param options - Optional CSV-specific formatting options
 */
export async function formatMachineOutput(
  format: OutputFormat,
  data: unknown,
  options?: CsvOptions,
): Promise<void> {
  // Human-readable formats are handled by CLI-specific code
  if (format === "text" || format === "table") {
    return;
  }

  const serialize = await getSerializer(format);
  const output = serialize(data, options);
  console.log(output);
}
