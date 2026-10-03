/**
 * MCP error normalization helpers.
 */

import { formatError } from "../errors.js";
import { McpSchemaValidationError } from "./schema.js";
import type { McpErrorEnvelope, McpFailureEnvelope } from "./types.js";

/**
 * Convert unknown errors to MCP-safe structured error payloads.
 */
export function normalizeMcpError(error: unknown): McpErrorEnvelope {
  if (error instanceof McpSchemaValidationError) {
    const issue = error.issues[0];
    return {
      code: "MCP_VALIDATION_ERROR",
      message: issue?.message ?? "Schema validation failed",
      suggestions: [
        "Fix the input payload to match the documented tool schema",
        "Check argument names and value types",
      ],
      details: {
        issues: error.issues.map((entry) => ({
          path: entry.path,
          expected: entry.expected,
          received: entry.received,
          message: entry.message,
        })),
      },
    };
  }

  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const formatted = formatError(normalizedError);

  return {
    code: mapErrorCode(normalizedError.name),
    message: formatted.message,
    suggestions: formatted.suggestions,
    details: {
      errorName: normalizedError.name,
    },
  };
}

/**
 * Wrap an unknown error in an MCP failure envelope.
 */
export function toMcpFailure(error: unknown): McpFailureEnvelope {
  return {
    ok: false,
    error: normalizeMcpError(error),
  };
}

function mapErrorCode(errorName: string): string {
  if (errorName === "") {
    return "MCP_UNKNOWN_ERROR";
  }

  const transformed = errorName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .toUpperCase();

  return transformed.length > 0 ? transformed : "MCP_UNKNOWN_ERROR";
}
