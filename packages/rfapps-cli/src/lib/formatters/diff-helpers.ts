/**
 * Shared diff formatting utilities for rfapps CLI
 *
 * Extracted from plan.ts and drift.ts where these functions were duplicated.
 * Used for rendering config diffs in human-readable terminal output with ANSI colors.
 */

import { colors } from "@rfmedia/common";

import type { DriftDirection } from "../../types/drift.js";

/**
 * Format a plan change type with color and symbol prefix.
 *
 * Used by plan.ts to render service change types in the deployment plan display.
 *
 * @param changeType - The type of change (create, update, recreate, delete, unchanged)
 * @returns Colored string with symbol prefix
 */
export function formatChangeType(changeType: string): string {
  switch (changeType) {
    case "create":
      return colors.green("+") + " create";
    case "recreate":
      return colors.cyan("~") + " recreate";
    case "update":
      return colors.yellow("!") + " update";
    case "delete":
      return colors.red("-") + " delete";
    case "unchanged":
      return colors.dim("=") + " unchanged";
    default:
      return changeType;
  }
}

/**
 * Format a drift direction for display.
 *
 * Used by drift.ts to render the direction of configuration drift
 * between compose.yml and running containers.
 *
 * @param direction - The drift direction
 * @returns Colored string describing the direction
 */
export function formatDirection(direction: DriftDirection): string {
  switch (direction) {
    case "compose_ahead":
      return colors.yellow("compose ahead");
    case "container_ahead":
      return colors.cyan("container ahead");
    case "diverged":
      return colors.red("diverged");
    default:
      return direction;
  }
}

/**
 * Format a diff value for display.
 *
 * Renders a before/after comparison of a single value with color coding:
 * - Addition (undefined -> value): green "+ value"
 * - Removal (value -> undefined): red "- value"
 * - Change (value1 -> value2): red "- value1" arrow green "+ value2"
 * - Unchanged: dimmed value
 *
 * @param current - Current value (undefined if newly added)
 * @param desired - Desired value (undefined if being removed)
 * @returns Colored diff string
 */
export function formatDiffValue(current: string | undefined, desired: string | undefined): string {
  if (current === undefined && desired !== undefined) {
    return colors.green(`+ ${desired}`);
  }
  if (current !== undefined && desired === undefined) {
    return colors.red(`- ${current}`);
  }
  if (current !== desired) {
    return `${colors.red(`- ${current}`)} → ${colors.green(`+ ${desired}`)}`;
  }
  return colors.dim(current ?? "(none)");
}

/**
 * Format an array diff for display (multiline).
 *
 * Compares two arrays and produces colored diff lines showing:
 * - Removed items (in current but not in desired): red "- item"
 * - Unchanged items (in both): dimmed "= item"
 * - Added items (in desired but not in current): green "+ item"
 *
 * @param current - Current array of values (undefined treated as empty)
 * @param desired - Desired array of values (undefined treated as empty)
 * @returns Array of colored diff lines
 */
export function formatArrayDiff(
  current: string[] | undefined,
  desired: string[] | undefined,
): string[] {
  const currentSet = new Set(current ?? []);
  const desiredSet = new Set(desired ?? []);
  const lines: string[] = [];

  // If both are empty or undefined, show (none)
  if (currentSet.size === 0 && desiredSet.size === 0) {
    lines.push(colors.dim("(none)"));
    return lines;
  }

  // Items that are removed (in current but not in desired)
  for (const item of currentSet) {
    if (!desiredSet.has(item)) {
      lines.push(`${colors.red("-")} ${colors.red(item)}`);
    }
  }

  // Items that are unchanged (in both)
  for (const item of currentSet) {
    if (desiredSet.has(item)) {
      lines.push(`${colors.dim("=")} ${colors.dim(item)}`);
    }
  }

  // Items that are added (in desired but not in current)
  for (const item of desiredSet) {
    if (!currentSet.has(item)) {
      lines.push(`${colors.green("+")} ${colors.green(item)}`);
    }
  }

  return lines;
}
