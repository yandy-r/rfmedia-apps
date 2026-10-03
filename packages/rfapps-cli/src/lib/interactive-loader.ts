/**
 * Lazy loader for interactive UI components.
 *
 * This module provides lazy loading of the React/Ink-based interactive
 * service selection UI to minimize bundle impact when interactive mode
 * is not used. The React ecosystem (~2MB) is only loaded when actually needed.
 *
 * @module rfapps-cli/lib/interactive-loader
 */

import type { EnvToolExecConfig } from "../types/options.js";

/**
 * Lazy-loaded interactive service selection.
 *
 * Dynamically imports the interactive module only when called,
 * preventing the React/Ink ecosystem from being loaded for non-interactive commands.
 *
 * @param composePath - Path to the Docker Compose file
 * @param projectDir - Project directory for container matching
 * @param options - Optional configuration including env tool for secrets injection
 * @returns Array of selected service names, or null if cancelled
 *
 * @example
 * ```typescript
 * // In a command handler - only loads React/Ink when interactive mode is used
 * if (options.interactive) {
 *   const selected = await loadInteractiveSelection(composePath, projectDir);
 *   if (selected === null) {
 *     console.log('Selection cancelled');
 *     return;
 *   }
 *   // Use selected services...
 * }
 * ```
 */
export async function loadInteractiveSelection(
  composePath: string,
  projectDir: string,
  options: { envTool?: EnvToolExecConfig } = {},
): Promise<string[] | null> {
  // Dynamically import the interactive module
  const { selectServicesInteractive } = await import("./interactive.js");
  return selectServicesInteractive(composePath, projectDir, options);
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
