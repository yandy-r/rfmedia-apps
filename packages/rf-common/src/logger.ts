/**
 * Colored logging utility for rfmedia CLI tools
 *
 * Log levels:
 * - INFO: Blue - General information
 * - SUCCESS: Green - Successful operations
 * - WARN: Yellow - Warning messages
 * - ERROR: Red - Error messages (output to stderr)
 * - DEBUG: Yellow - Debug messages (only when debug mode enabled)
 *
 * All log output goes to stderr to keep stdout clean for data output.
 */

import pc from "picocolors";

import { getOutputFormat, isMachineFormat, setOutputFormat } from "./output.js";

/**
 * Logger state that can be initialized per CLI tool
 */
interface LoggerState {
  debugMode: boolean;
  jsonMode: boolean;
  debugEnvVar: string;
}

/** Global logger state */
const state: LoggerState = {
  debugMode: false,
  jsonMode: false,
  debugEnvVar: "RF_DEBUG",
};

/**
 * Initialize the logger with tool-specific configuration
 *
 * @param options - Logger initialization options
 */
export function initLogger(options: {
  debugEnvVar?: string;
  debugMode?: boolean;
  jsonMode?: boolean;
}): void {
  if (options.debugEnvVar !== undefined) {
    state.debugEnvVar = options.debugEnvVar;
  }
  if (options.debugMode !== undefined) {
    state.debugMode = options.debugMode;
  } else {
    state.debugMode = process.env[state.debugEnvVar] === "true";
  }
  if (options.jsonMode !== undefined) {
    state.jsonMode = options.jsonMode;
  }
}

/**
 * Enable or disable debug mode
 */
export function setDebugMode(enabled: boolean): void {
  state.debugMode = enabled;
}

/**
 * Check if debug mode is currently enabled
 */
export function isDebugMode(): boolean {
  return state.debugMode;
}

/**
 * Enable or disable JSON output mode.
 * When enabled, log functions become no-ops and outputJson() emits to stdout.
 *
 * Internally sets the output format to "json" (enabled) or "text" (disabled)
 * for integration with the multi-format output system.
 */
export function setJsonMode(enabled: boolean): void {
  state.jsonMode = enabled;
  setOutputFormat(enabled ? "json" : "text");
}

/**
 * Check if JSON mode is currently enabled.
 *
 * Returns true only when the output format is specifically "json",
 * for backwards compatibility with existing code paths.
 */
export function isJsonMode(): boolean {
  return getOutputFormat() === "json";
}

/**
 * Format a log message with prefix
 */
function formatMessage(prefix: string, message: string): string {
  return `${prefix} ${message}`;
}

/**
 * Format a dry-run prefixed message
 */
export function formatDryRun(action: string): string {
  return `[DRY-RUN] Would ${action}`;
}

/**
 * Log an informational message (blue)
 * Output to stderr to keep stdout clean
 */
export function logInfo(message: string): void {
  if (isMachineFormat()) return;
  console.error(formatMessage(pc.blue("[INFO]"), message));
}

/**
 * Log a success message (green)
 * Output to stderr to keep stdout clean
 */
export function logSuccess(message: string): void {
  if (isMachineFormat()) return;
  console.error(formatMessage(pc.green("[SUCCESS]"), message));
}

/**
 * Log a warning message (yellow)
 * Output to stderr to keep stdout clean
 */
export function logWarn(message: string): void {
  if (isMachineFormat()) return;
  console.error(formatMessage(pc.yellow("[WARN]"), message));
}

/**
 * Log an error message (red)
 * Output to stderr
 */
export function logError(message: string): void {
  if (isMachineFormat()) return;
  console.error(formatMessage(pc.red("[ERROR]"), message));
}

/**
 * Log a debug message (yellow)
 * Only outputs when debug mode is enabled
 * Output to stderr to keep stdout clean
 */
export function logDebug(message: string): void {
  if (isMachineFormat()) return;
  if (!state.debugMode) return;
  console.error(formatMessage(pc.yellow("[DEBUG]"), message));
}

/**
 * Output structured JSON result to stdout.
 * Only outputs when JSON mode is enabled (via setJsonMode or setOutputFormat("json")).
 *
 * Checks both the legacy `state.jsonMode` flag and the output format state
 * to maintain backwards compatibility with existing unconditional `outputJson()`
 * calls in rfmedia-cli.
 *
 * @param data - Object to serialize and output as JSON
 */
export function outputJson(data: unknown): void {
  if (!state.jsonMode && getOutputFormat() !== "json") return;
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Output a clean message without prefix (for user-facing status).
 * Output to stderr to keep stdout clean for data output.
 */
export function output(message: string): void {
  if (isMachineFormat()) return;
  console.error(message);
}

/**
 * Output a clean success message with checkmark (for completion messages).
 * Output to stderr to keep stdout clean for data output.
 */
export function outputSuccess(message: string): void {
  if (isMachineFormat()) return;
  console.error(pc.green(`✓ ${message}`));
}

/**
 * Output an indented success message (for inline status after progress bar).
 * Output to stderr to keep stdout clean for data output.
 */
export function outputInlineSuccess(message: string): void {
  if (isMachineFormat()) return;
  console.error(pc.green(`  ✓ ${message}`));
}

/**
 * Color utilities for custom formatting
 */
export const colors = {
  blue: pc.blue,
  green: pc.green,
  yellow: pc.yellow,
  red: pc.red,
  cyan: pc.cyan,
  magenta: pc.magenta,
  gray: pc.gray,
  bold: pc.bold,
  dim: pc.dim,
};
