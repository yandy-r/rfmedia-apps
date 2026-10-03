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

/**
 * Checks if the terminal is interactive (pure TTY check).
 *
 * Returns true when stdin is a TTY, regardless of JSON mode.
 * Use this when you need to know if the terminal supports input
 * but want to handle JSON mode separately.
 *
 * @returns true if stdin is a TTY
 */
export function isTerminalInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Wraps a prompt function with graceful cancellation handling.
 *
 * Catches `ExitPromptError` (thrown by @inquirer/prompts and similar libraries
 * when the user presses Ctrl+C or ESC) and returns null instead of throwing.
 * Other errors are re-thrown.
 *
 * @template T - The return type of the prompt function
 * @param promptFn - Async function that invokes an interactive prompt
 * @returns The prompt result, or null if the user cancelled
 * @throws Re-throws any error that is not an ExitPromptError
 *
 * @example
 * ```typescript
 * const result = await withCancellation(() =>
 *   checkbox({ message: 'Select items:', choices })
 * );
 * if (result === null) {
 *   console.log('User cancelled');
 *   return;
 * }
 * ```
 */
export async function withCancellation<T>(promptFn: () => Promise<T>): Promise<T | null> {
  try {
    return await promptFn();
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return null;
    }
    throw error;
  }
}
