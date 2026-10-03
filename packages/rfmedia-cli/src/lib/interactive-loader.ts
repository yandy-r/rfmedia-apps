/**
 * Lazy loader for interactive UI components.
 *
 * This module provides lazy loading of the React/Ink-based interactive
 * selection UI to minimize bundle impact when interactive mode is not used.
 * The React ecosystem (~2MB) is only loaded when actually needed.
 *
 * @module rfmedia-cli/lib/interactive-loader
 */

import type { CopySelection, DeleteSelection, PathEntry, DeleteMode } from "../types/options.js";
import type { InteractiveConfig } from "../types/config.js";

/**
 * Lazy-loaded interactive copy selection.
 *
 * Dynamically imports the interactive module only when called,
 * preventing the React/Ink ecosystem from being loaded for non-interactive commands.
 *
 * @param sourceEntries - Source paths to select from
 * @param config - Interactive configuration with page sizes
 * @param allowTrackSelection - Whether to offer track-level selection (false in album mode)
 * @param signal - Optional abort signal for cancellation
 * @returns Selected sources and optional per-source refinements, or null if cancelled
 *
 * @example
 * ```typescript
 * // In a command handler - only loads React/Ink when interactive mode is used
 * if (shouldShowInteractiveSelection(options.interactive)) {
 *   const config = getLoadedConfig();
 *   const interactiveConfig = getInteractiveConfig(config);
 *   const allowTrackSelection = copyOptions.mode.type === 'filter';
 *   const selection = await loadCopyInteractiveSelection(
 *     sourceEntries,
 *     interactiveConfig,
 *     allowTrackSelection,
 *   );
 *   if (selection === null) {
 *     console.log('Selection cancelled');
 *     return;
 *   }
 *   // Use selection...
 * }
 * ```
 */
export async function loadCopyInteractiveSelection(
  sourceEntries: readonly PathEntry[],
  config: InteractiveConfig,
  allowTrackSelection: boolean,
  signal?: AbortSignal,
): Promise<CopySelection | null> {
  // Dynamically import the interactive module
  const { runInteractiveSelection } = await import("./interactive.js");
  // runInteractiveSelection accepts readonly PathEntry[] - no cast needed
  return runInteractiveSelection(sourceEntries, config, allowTrackSelection, signal);
}

/**
 * Lazy-loaded interactive delete selection.
 *
 * Dynamically imports the interactive-delete module only when called,
 * preventing the React/Ink ecosystem from being loaded for non-interactive commands.
 *
 * @param sourceEntries - Source paths to select from
 * @param destination - Destination directory to scan for suffixed copies
 * @param mode - Delete mode (album or filter)
 * @param albumOnly - Whether source is treated as a single album
 * @param config - Interactive configuration with page sizes
 * @param signal - Optional abort signal for cancellation
 * @returns Selected sources and suffixes to delete, or null if cancelled
 *
 * @example
 * ```typescript
 * // In a command handler - only loads React/Ink when interactive mode is used
 * if (shouldShowInteractiveSelection(options.interactive)) {
 *   const config = getLoadedConfig();
 *   const interactiveConfig = getInteractiveConfig(config);
 *   const selection = await loadDeleteInteractiveSelection(
 *     sourceEntries,
 *     destination,
 *     mode,
 *     albumOnly,
 *     interactiveConfig,
 *   );
 *   if (selection === null) {
 *     console.log('Selection cancelled');
 *     return;
 *   }
 *   // Use selection...
 * }
 * ```
 */
export async function loadDeleteInteractiveSelection(
  sourceEntries: readonly PathEntry[],
  destination: string,
  mode: DeleteMode,
  albumOnly: boolean,
  config: InteractiveConfig,
  signal?: AbortSignal,
): Promise<DeleteSelection | null> {
  // Dynamically import the interactive-delete module
  const { runInteractiveDeleteSelection } = await import("./interactive-delete.js");
  return runInteractiveDeleteSelection(sourceEntries, destination, mode, albumOnly, config, signal);
}

/**
 * Check if the terminal supports interactive mode.
 *
 * Interactive mode requires a TTY for stdin to handle keyboard input.
 *
 * @returns true if interactive mode is available
 */
export function isInteractiveAvailable(): boolean {
  return process.stdin.isTTY === true;
}
