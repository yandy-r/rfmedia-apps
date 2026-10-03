/**
 * Error handling utilities for CLI applications.
 *
 * This module provides a centralized error handling system that transforms
 * raw errors into user-friendly output with actionable suggestions.
 * Stack traces are only shown in debug mode.
 *
 * @module @rfmedia/common/errors
 */

import { isDebugMode, colors } from "./logger.js";
import { SecretsInjectionError, ConfigSizeError } from "./secrets.js";

/** Raised when an interactive prompt is interrupted with Ctrl+C. */
export class PromptInterruptedError extends Error {
  override readonly name = "PromptInterruptedError";

  constructor() {
    super("Operation interrupted");
  }
}

/**
 * Formatted error output structure.
 */
export interface FormattedError {
  /** User-friendly error message */
  message: string;
  /** Actionable suggestions for fixing the error */
  suggestions: string[];
  /** Exit code for the process */
  exitCode: number;
  /** Original error for debug output */
  originalError: Error;
}

/**
 * Error formatter interface for registering custom error handlers.
 */
export interface ErrorFormatter<T extends Error = Error> {
  /** Determines if this formatter can handle the given error */
  canHandle: (error: Error) => error is T;
  /** Formats the error message */
  formatMessage: (error: T) => string;
  /** Returns suggestions for fixing the error */
  getSuggestions: (error: T) => string[];
  /** Exit code to use (default: 1) */
  exitCode?: number;
}

// Registry of error formatters
const errorFormatters: ErrorFormatter<Error>[] = [];

/**
 * Registers an error formatter for a specific error type.
 *
 * Formatters are checked in registration order, so more specific
 * formatters should be registered before generic ones.
 *
 * @param formatter - The error formatter to register
 *
 * @example
 * ```typescript
 * registerErrorFormatter({
 *   canHandle: (error): error is MyCustomError =>
 *     error instanceof MyCustomError,
 *   formatMessage: (error) => `Custom error: ${error.customField}`,
 *   getSuggestions: (error) => ['Try this', 'Or that'],
 *   exitCode: 2,
 * });
 * ```
 */
export function registerErrorFormatter<T extends Error>(formatter: ErrorFormatter<T>): void {
  // Cast to base Error type for storage - the canHandle guard ensures type safety at runtime
  errorFormatters.push(formatter as unknown as ErrorFormatter<Error>);
}

/**
 * Formats an error into a user-friendly structure.
 *
 * Checks registered formatters first, then falls back to default formatting.
 *
 * @param error - The error to format
 * @returns Formatted error with message, suggestions, and exit code
 */
export function formatError(error: Error): FormattedError {
  // Check registered formatters in order
  for (const formatter of errorFormatters) {
    if (formatter.canHandle(error)) {
      return {
        message: formatter.formatMessage(error),
        suggestions: formatter.getSuggestions(error),
        exitCode: formatter.exitCode ?? 1,
        originalError: error,
      };
    }
  }

  // Default formatting for unknown errors
  return {
    message: error.message || "An unexpected error occurred",
    suggestions: ["Run with --debug for more details"],
    exitCode: 1,
    originalError: error,
  };
}

/**
 * Outputs formatted error information to stderr.
 *
 * In normal mode, shows the error message and suggestions.
 * In debug mode, also shows error type, properties, and stack trace.
 *
 * @param formatted - The formatted error to output
 */
export function outputFormattedError(formatted: FormattedError): void {
  const { message, suggestions, originalError } = formatted;

  // Main error message
  console.error(`\n${colors.red("Error:")} ${message}\n`);

  // Suggestions
  if (suggestions.length > 0) {
    console.error(colors.yellow("Suggestions:"));
    for (const suggestion of suggestions) {
      console.error(`  ${colors.dim("\u2022")} ${suggestion}`);
    }
    console.error("");
  }

  // Debug information
  if (isDebugMode()) {
    console.error(colors.dim("--- Debug Information ---"));
    console.error(`${colors.dim("Error type:")} ${originalError.name}`);

    // Extract and display error properties (excluding standard Error fields)
    const props = extractErrorProperties(originalError);
    if (Object.keys(props).length > 0) {
      console.error(`${colors.dim("Properties:")}`);
      for (const [key, value] of Object.entries(props)) {
        console.error(`  ${colors.dim(key + ":")} ${JSON.stringify(value)}`);
      }
    }

    // Stack trace
    if (originalError.stack) {
      console.error(`\n${colors.dim("Stack trace:")}`);
      // Remove the first line (error message) from stack
      const stackLines = originalError.stack.split("\n").slice(1);
      console.error(colors.dim(stackLines.join("\n")));
    }
    console.error("");
  }
}

/**
 * Extracts custom properties from an error object.
 *
 * Filters out standard Error properties (name, message, stack).
 *
 * @param error - The error to extract properties from
 * @returns Object containing custom error properties
 */
function extractErrorProperties(error: Error): Record<string, unknown> {
  const standardProps = new Set(["name", "message", "stack"]);
  const props: Record<string, unknown> = {};

  // Use getOwnPropertyNames to include non-enumerable properties
  for (const key of Object.getOwnPropertyNames(error)) {
    if (!standardProps.has(key)) {
      props[key] = (error as unknown as Record<string, unknown>)[key];
    }
  }

  return props;
}

/**
 * Main entry point for CLI error handling.
 *
 * Formats the error, outputs user-friendly information, and exits
 * with the appropriate code.
 *
 * @param error - The error to handle
 *
 * @example
 * ```typescript
 * try {
 *   await program.parseAsync(process.argv);
 * } catch (error) {
 *   handleCliError(error);
 * }
 * ```
 */
export function handleCliError(error: unknown): never {
  // Convert non-Error objects to Error
  const errorObj = error instanceof Error ? error : new Error(String(error));

  const formatted = formatError(errorObj);
  outputFormattedError(formatted);
  process.exit(formatted.exitCode);
}

// =============================================================================
// Built-in Formatters
// =============================================================================

registerErrorFormatter({
  canHandle: (error): error is PromptInterruptedError => error instanceof PromptInterruptedError,
  formatMessage: (error) => error.message,
  getSuggestions: () => [],
  exitCode: 130,
});

/**
 * Formatter for SecretsInjectionError (missing environment variables).
 */
registerErrorFormatter({
  canHandle: (error): error is SecretsInjectionError => error instanceof SecretsInjectionError,
  formatMessage: (error) => {
    const pathInfo = error.configPath ? ` (in ${error.configPath})` : "";
    return `Missing required environment variable: ${error.variableName}${pathInfo}`;
  },
  getSuggestions: (error) => [
    `Set the ${error.variableName} environment variable before running the command`,
    "Use --use-dotenvx or --use-op to inject secrets from a secure source",
    "Check that your .env file contains the required variable",
    "Run with --debug for more details",
  ],
  exitCode: 1,
});

/**
 * Formatter for ConfigSizeError (config file too large).
 */
registerErrorFormatter({
  canHandle: (error): error is ConfigSizeError => error instanceof ConfigSizeError,
  formatMessage: (error) => {
    const pathInfo = error.configPath ? ` (${error.configPath})` : "";
    const actualKb = Math.round(error.actualSize / 1024);
    const maxKb = Math.round(error.maxSize / 1024);
    return `Config file${pathInfo} exceeds maximum size: ${actualKb}KB > ${maxKb}KB limit`;
  },
  getSuggestions: (error) => [
    "Remove unnecessary content from the config file",
    "Split configuration into multiple smaller files",
    "Check for accidental large data in the config",
    "Run with --debug for more details",
  ],
  exitCode: 1,
});
