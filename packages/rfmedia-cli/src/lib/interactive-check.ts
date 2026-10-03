/**
 * TTY detection utilities for interactive mode.
 *
 * Provides functions to determine if the CLI should use interactive mode
 * for source/album/track selection. Interactive mode is enabled when:
 * - stdin is a TTY (not piped or non-interactive)
 * - JSON output mode is not enabled
 * - The user hasn't explicitly disabled interactive mode
 *
 * @module rfmedia-cli/lib/interactive-check
 */

import { isJsonMode } from "@rfmedia/common";

/**
 * Checks if the current environment supports interactive mode.
 *
 * Returns true when stdin is a TTY and JSON mode is not enabled.
 * This is the base check for any interactive features.
 *
 * @returns true if interactive prompts are supported
 */
export function isInteractiveEnvironment(): boolean {
  return process.stdin.isTTY === true && !isJsonMode();
}

/**
 * Determines if interactive selection UI should be shown based on the
 * interactive flag and environment capabilities.
 *
 * Behavior:
 * - If `interactiveFlag` is explicitly `false`, returns `false`
 * - If `interactiveFlag` is explicitly `true`, validates TTY environment
 *   and throws if not available
 * - If `interactiveFlag` is `undefined`, auto-detects based on environment
 *
 * @param interactiveFlag - The --interactive flag value from CLI options
 * @returns true if interactive selection should be displayed
 * @throws Error if interactive mode is explicitly requested but TTY is not available
 */
export function shouldShowInteractiveSelection(interactiveFlag: boolean | undefined): boolean {
  if (interactiveFlag === false) {
    return false;
  }
  if (interactiveFlag === true) {
    if (!isInteractiveEnvironment()) {
      throw new Error("Interactive mode requires a TTY. Use --no-interactive or pipe to a file.");
    }
    return true;
  }
  return isInteractiveEnvironment();
}

/**
 * Validates that the current environment supports interactive mode.
 *
 * Call this function at the start of any interactive flow that requires
 * user input. Throws an error if the environment does not support TTY
 * operations.
 *
 * @throws Error if not in an interactive TTY environment
 */
export function requireInteractiveMode(): void {
  if (!isInteractiveEnvironment()) {
    throw new Error("Interactive mode requires a TTY environment with stdin attached.");
  }
}
