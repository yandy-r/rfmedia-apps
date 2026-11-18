/**
 * Interactive environment detection utilities for rfmedia CLI tools.
 *
 * Provides functions to determine if the CLI is running in an interactive
 * environment (TTY) and helper utilities for handling user cancellation
 * in interactive prompts.
 *
 * @module @rfmedia/common/interactive
 */

import { isJsonMode } from "./logger.js";

/**
 * Checks if the current environment supports interactive mode.
 *
 * Returns true when stdin is a TTY and JSON mode is not enabled.
 * This is the base check for any interactive features that require
 * user input and should not run in CI/CD or piped environments.
 *
 * @returns true if interactive prompts are supported
 */
export function isInteractiveEnvironment(): boolean {
  return process.stdin.isTTY === true && !isJsonMode();
}
