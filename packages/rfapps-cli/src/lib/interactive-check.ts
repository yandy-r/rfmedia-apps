/**
 * TTY detection utilities for interactive mode.
 *
 * Provides functions to determine if the CLI should use interactive mode
 * for service selection. Interactive mode is enabled when:
 * - stdin is a TTY (not piped or non-interactive)
 * - JSON output mode is not enabled
 * - No service targeting flags are provided
 * - Auto-confirm (--yes) is not set
 *
 * @module rfapps-cli/lib/interactive-check
 */

import { isJsonMode } from "@rfmedia/common";
import { hasExplicitSelector } from "./selector.js";

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
 * Options for determining if interactive selection should be shown.
 */
interface InteractiveSelectionCheckOptions {
  /** Single service target (-s, --service) */
  service?: string;
  /** Multiple service targets (--services) */
  services?: string[];
  /** Service group target (-g, --group) */
  group?: string;
  /** Hierarchical tag patterns (--tag), one entry per flag occurrence */
  tag?: string[];
  /** Auto-confirm flag (--yes) */
  yes?: boolean;
}

/**
 * Determines if interactive service selection should be shown.
 *
 * Interactive selection is shown when:
 * - The environment supports interactive mode (TTY + no JSON)
 * - No service targeting flags are provided (-s, --services, -g, --tag)
 * - The --yes flag is NOT set (auto-confirm implies no prompts)
 *
 * @param options - CLI options to check for service targeting
 * @returns true if interactive selection should be displayed
 */
export function shouldShowInteractiveSelection(options: InteractiveSelectionCheckOptions): boolean {
  // Must be in interactive environment
  if (!isInteractiveEnvironment()) {
    return false;
  }

  // If --yes is set, skip interactive (auto-confirm implies no prompts)
  if (options.yes === true) {
    return false;
  }

  // If any service targeting flag is provided, skip interactive (selector site 2).
  // `--tag` is a targeting flag, so it must suppress the prompt too - otherwise
  // `rfapps deploy --tag "media/**"` pops the Ink multi-select on a TTY.
  if (hasExplicitSelector(options)) {
    return false;
  }

  return true;
}
