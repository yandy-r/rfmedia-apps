/**
 * CSV serializer for machine-readable output.
 *
 * Handles flat objects, arrays of objects, and nested objects
 * with dot-notation key flattening up to 2 levels deep.
 *
 * For deeply nested data beyond 2 levels, throws an error
 * suggesting JSON or YAML format instead.
 */

/**
 * CSV formatting options.
 *
 * @property columns - Optional subset of columns to include in output.
 *   When specified, only these keys appear in the CSV (in order).
 * @property delimiter - Column separator character (defaults to ",").
 *
 * **Nesting limit**: CSV flattening supports up to 2 levels of nesting
 * (e.g., `parent.child`). Data with deeper nesting (3+ levels) will
 * cause an error. Use JSON or YAML format for deeply nested structures.
 */
export interface CsvOptions {
  columns?: string[];
  delimiter?: string;
}

/** Maximum nesting depth for CSV flattening */
const MAX_DEPTH = 2;

/**
 * Escape a CSV field value.
 *
 * Wraps the value in double quotes if it contains the delimiter,
 * double quotes, or newlines. Internal double quotes are escaped
 * by doubling them (RFC 4180).
 *
 * @param value - The string value to escape
 * @param delimiter - The delimiter character to check for
 * @returns The escaped CSV field value
 */
function escapeCsvField(value: string, delimiter: string): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Convert a value to its CSV string representation.
 *
 * @param value - The value to convert
 * @returns String representation suitable for CSV output
 */
function valueToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

/**
 * Check if a value is a plain object (not an array, null, or primitive).
 *
 * @param value - The value to check
 * @returns `true` if the value is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten a nested object into dot-notation keys.
 *
 * Supports up to {@link MAX_DEPTH} levels of nesting. Throws an error
 * if deeper nesting is encountered.
 *
 * @param obj - The object to flatten
 * @param prefix - Dot-notation prefix for nested keys
 * @param depth - Current nesting depth (starts at 0)
 * @returns Flattened record with dot-notation keys
 * @throws Error if nesting exceeds {@link MAX_DEPTH} levels
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix: string = "",
  depth: number = 0,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (isPlainObject(value)) {
      if (depth + 1 >= MAX_DEPTH) {
        throw new Error(
          `CSV format does not support nesting deeper than ${MAX_DEPTH} levels at "${fullKey}". ` +
            "Use --output json or --output yaml.",
        );
      }
      const nested = flattenObject(value, fullKey, depth + 1);
      Object.assign(result, nested);
    } else if (Array.isArray(value)) {
      // Serialize arrays as JSON strings in CSV cells
      result[fullKey] = JSON.stringify(value);
    } else {
      result[fullKey] = value;
    }
  }

  return result;
}

/**
 * Format a single row of values as a CSV line.
 *
 * @param columns - Column keys in order
 * @param row - Flattened record of values
 * @param delimiter - Column separator
 * @returns Formatted CSV line
 */
function formatRow(columns: string[], row: Record<string, unknown>, delimiter: string): string {
  return columns.map((col) => escapeCsvField(valueToString(row[col]), delimiter)).join(delimiter);
}

/**
 * Format data as a CSV string.
 *
 * Supports three input shapes:
 * - **Flat object**: Single row with header derived from object keys
 * - **Array of objects**: Header row + one data row per array element
 * - **Nested object**: Dot-notation key flattening up to 2 levels deep
 *
 * @param data - Data to format as CSV
 * @param options - Optional CSV formatting configuration
 * @returns CSV-formatted string with header row and data rows
 * @throws Error if data contains nesting deeper than 2 levels
 * @throws Error if data is not an object or array of objects
 */
export function formatAsCsv(data: unknown, options?: CsvOptions): string {
  const delimiter = options?.delimiter ?? ",";

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return "";
    }

    // Flatten all rows first to discover all columns
    const flatRows = data.map((item) => {
      if (!isPlainObject(item)) {
        throw new Error(
          "CSV format requires an array of objects. " +
            "Use --output json or --output yaml for arrays of primitives.",
        );
      }
      return flattenObject(item);
    });

    // Derive columns from all rows (union of all keys)
    const allKeys = new Set<string>();
    for (const row of flatRows) {
      for (const key of Object.keys(row)) {
        allKeys.add(key);
      }
    }

    const columns = options?.columns ?? [...allKeys];
    const header = columns.map((col) => escapeCsvField(col, delimiter)).join(delimiter);
    const rows = flatRows.map((row) => formatRow(columns, row, delimiter));

    return [header, ...rows].join("\n");
  }

  if (isPlainObject(data)) {
    const flat = flattenObject(data);
    const columns = options?.columns ?? Object.keys(flat);
    const header = columns.map((col) => escapeCsvField(col, delimiter)).join(delimiter);
    const row = formatRow(columns, flat, delimiter);

    return [header, row].join("\n");
  }

  throw new Error(
    "CSV format requires an object or array of objects. " +
      "Use --output json or --output yaml for other data types.",
  );
}
