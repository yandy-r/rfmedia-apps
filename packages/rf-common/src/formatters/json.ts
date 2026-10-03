/**
 * JSON serializer for machine-readable output.
 *
 * Wraps `JSON.stringify` with pretty-printing (2-space indent)
 * for consistent, human-readable JSON output to stdout.
 */

/**
 * Format data as a pretty-printed JSON string.
 *
 * @param data - Any serializable value to format as JSON
 * @returns Pretty-printed JSON string with 2-space indentation
 */
export function formatAsJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
