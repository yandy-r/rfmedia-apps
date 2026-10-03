/**
 * Display helpers for deployment-state table rendering.
 *
 * Shared color and timestamp formatting for human-readable state tables
 * (history, generations) so action/status colors stay consistent across
 * commands.
 *
 * @module rfapps-cli/lib/formatters/state-display
 */

import { colors } from "@rfmedia/common";

/**
 * Formats an ISO 8601 timestamp for display in a table.
 *
 * @param timestamp - ISO 8601 timestamp
 * @returns Formatted "YYYY-MM-DD HH:mm:ss" string (or the input if unparseable)
 */
export function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    // Format: YYYY-MM-DD HH:mm:ss
    return date.toISOString().replace("T", " ").substring(0, 19);
  } catch {
    return timestamp;
  }
}

/**
 * Gets the color function for a deployment status.
 *
 * Color mapping:
 * - success: green
 * - failed: red
 * - rolled_back: yellow
 * - unknown: gray
 *
 * @param status - Deployment status string
 * @returns Color function that wraps text with ANSI color codes
 */
export function getStatusColor(status: string): (text: string) => string {
  switch (status) {
    case "success":
      return colors.green;
    case "failed":
      return colors.red;
    case "rolled_back":
      return colors.yellow;
    default:
      return colors.gray;
  }
}

/**
 * Gets the color function for an action type.
 *
 * Color mapping:
 * - deploy: green (new deployment)
 * - rebuild: blue (service refresh)
 * - delete/prune: red (destructive)
 * - rollback: yellow (caution/recovery)
 * - apply: cyan (plan execution)
 * - import: magenta (adopted baseline)
 * - unknown: gray
 *
 * @param action - Deployment action string
 * @returns Color function that wraps text with ANSI color codes
 */
export function getActionColor(action: string): (text: string) => string {
  switch (action) {
    case "deploy":
      return colors.green;
    case "rebuild":
      return colors.blue;
    case "delete":
      return colors.red;
    case "prune":
      return colors.red;
    case "rollback":
      return colors.yellow;
    case "apply":
      return colors.cyan;
    case "import":
      return colors.magenta;
    default:
      return colors.gray;
  }
}
