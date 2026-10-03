/**
 * Colored logging utility for rfmedia CLI
 *
 * Re-exports logging utilities from @rfmedia/common with rfmedia-specific
 * configuration (RF_MEDIA_DEBUG environment variable).
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

import {
  initLogger,
  setDebugMode as _setDebugMode,
  isDebugMode,
  setJsonMode,
  isJsonMode,
  formatDryRun,
  logInfo,
  logSuccess,
  logWarn,
  logError,
  logDebug,
  outputJson,
  output,
  outputSuccess,
  outputInlineSuccess,
  colors,
} from "@rfmedia/common";

// Initialize logger with rfmedia-specific environment variable
initLogger({ debugEnvVar: "RF_MEDIA_DEBUG" });

/**
 * Enable or disable debug mode
 */
export function setDebugMode(enabled: boolean): void {
  _setDebugMode(enabled);
}

// Re-export everything else
export {
  isDebugMode,
  setJsonMode,
  isJsonMode,
  formatDryRun,
  logInfo,
  logSuccess,
  logWarn,
  logError,
  logDebug,
  outputJson,
  output,
  outputSuccess,
  outputInlineSuccess,
  colors,
};
