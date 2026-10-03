/**
 * History command action for rfapps CLI.
 *
 * Shows deployment history for services with filtering options.
 * History is retrieved from the SQLite state database and displayed
 * in either table format (default) or JSON format.
 *
 * Filtering options:
 * - `--service`: Filter by service name (exact match)
 * - `--action`: Filter by action type (deploy, rebuild, delete, rollback, apply, prune)
 * - `--since`: Filter entries after a specific date (ISO 8601 format)
 * - `--limit`: Maximum number of entries to return (default: 10)
 *
 * Output formats:
 * - Table: Color-coded status and action columns, truncated image tags
 * - JSON: Full {@link HistoryResult} object with entries, totalCount, and filters
 *
 * Table rendering uses Unicode-safe width measurement and truncation
 * (string-width + cli-truncate) consistent with the centralized rfapps
 * table renderer in lib/formatters/table.ts. Terminal width is detected
 * dynamically with a deterministic fallback for non-TTY environments.
 */

import stringWidth from "string-width";

import { logInfo, logDebug, colors, formatError, outputFormattedError } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import type {
  HistoryOptions,
  HistoryResult,
  StateEntry,
  DeploymentAction,
} from "../types/index.js";

import {
  initializeDatabase,
  closeDatabase,
  getDeploymentHistory,
  getDeploymentCount,
  InvalidArgumentError,
} from "../lib/index.js";
import {
  formatOutput,
  getStderrTerminalWidth,
  truncateToWidth,
  padToWidth,
  padStartToWidth,
  formatTimestamp,
  getStatusColor,
  getActionColor,
} from "../lib/formatters/index.js";

/**
 * Default limit for history queries.
 */
const DEFAULT_HISTORY_LIMIT = 10;

/**
 * Column gutter width (spacing between columns in a row).
 */
const COLUMN_GAP = 2;

/**
 * Left margin prefix for all table rows.
 */
const ROW_PREFIX = "  ";

/**
 * Fixed column widths for history table columns that have predictable content.
 * These are display widths (visual columns), not byte lengths.
 *
 * - ID: right-aligned, 4 digits is sufficient for most deployments
 * - Timestamp: "YYYY-MM-DD HH:mm:ss" is always 19 characters
 * - Action: longest value "rollback" = 8, padded to 10
 * - Status: longest value "rolled_back" = 11, padded to 12
 */
const FIXED_COLUMNS = {
  id: 4,
  timestamp: 19,
  action: 10,
  status: 12,
} as const;

/**
 * Minimum width for flexible columns (Service, Image Tag).
 */
const MIN_FLEX_WIDTH = 6;

/**
 * Raw options from CLI parser.
 *
 * All values come as strings from the command line and are validated/parsed
 * into typed {@link HistoryOptions} before use.
 */
interface RawHistoryOptions {
  /** Service name filter (exact match) */
  service?: string;
  /** Maximum entries to return (parsed to number) */
  limit?: string;
  /** ISO 8601 date string or parseable date format */
  since?: string;
  /** Action type filter (validated against VALID_ACTIONS) */
  action?: string;
}

/**
 * Valid deployment actions for CLI validation.
 * Must match the DeploymentAction type definition.
 */
const VALID_ACTIONS: DeploymentAction[] = [
  "deploy",
  "rebuild",
  "delete",
  "rollback",
  "apply",
  "prune",
  "import",
];

/**
 * Validates and parses the action filter option.
 *
 * Normalizes the input (lowercase, trimmed) and validates against the
 * known action types. Throws {@link InvalidArgumentError} if validation fails.
 *
 * @param action - Raw action string from CLI (case-insensitive)
 * @returns Validated DeploymentAction or undefined if not provided
 * @throws {InvalidArgumentError} If the action value is not a valid action type
 */
function parseActionFilter(action: string | undefined): DeploymentAction | undefined {
  if (action === undefined) {
    return undefined;
  }

  const normalized = action.toLowerCase().trim();
  if (VALID_ACTIONS.includes(normalized as DeploymentAction)) {
    return normalized as DeploymentAction;
  }

  throw new InvalidArgumentError("action", action, "Unknown action type", [...VALID_ACTIONS]);
}

/**
 * Calculate the available width budget for flexible columns (Service, Image Tag).
 *
 * Fixed columns (ID, Timestamp, Action, Status) consume a known budget.
 * The remaining width after fixed columns, gaps, and row prefix is split
 * between Service (40%) and Image Tag (60%).
 *
 * @returns Object with serviceWidth and imageTagWidth
 */
function calculateFlexWidths(): { serviceWidth: number; imageTagWidth: number } {
  const terminalWidth = getStderrTerminalWidth();
  const prefixWidth = stringWidth(ROW_PREFIX);
  const fixedBudget =
    FIXED_COLUMNS.id + FIXED_COLUMNS.timestamp + FIXED_COLUMNS.action + FIXED_COLUMNS.status;
  // 6 columns = 5 gaps between them + prefix
  const totalGaps = 5 * COLUMN_GAP;
  const flexBudget = terminalWidth - prefixWidth - fixedBudget - totalGaps;

  // Allocate 40% to service, 60% to image tag (service names tend to be shorter)
  const serviceWidth = Math.max(Math.floor(flexBudget * 0.4), MIN_FLEX_WIDTH);
  const imageTagWidth = Math.max(flexBudget - serviceWidth, MIN_FLEX_WIDTH);

  return { serviceWidth, imageTagWidth };
}

/**
 * Formats a single history entry for table display.
 *
 * Uses Unicode-safe width measurement for correct alignment with
 * fullwidth characters, emoji, and ANSI escape codes.
 *
 * @param entry - State entry to format
 * @param flexWidths - Pre-calculated flexible column widths
 * @returns Formatted table row string
 */
function formatTableRow(
  entry: StateEntry,
  flexWidths: { serviceWidth: number; imageTagWidth: number },
): string {
  const gap = " ".repeat(COLUMN_GAP);

  const id = padStartToWidth(entry.id.toString(), FIXED_COLUMNS.id);
  const timestamp = formatTimestamp(entry.timestamp);
  const service = truncateToWidth(entry.service, flexWidths.serviceWidth);
  const servicePadded = padToWidth(service, flexWidths.serviceWidth);
  const action = getActionColor(entry.action)(padToWidth(entry.action, FIXED_COLUMNS.action));
  const status = getStatusColor(entry.status)(padToWidth(entry.status, FIXED_COLUMNS.status));
  const imageTag = truncateToWidth(entry.imageTag ?? "-", flexWidths.imageTagWidth);

  return `${ROW_PREFIX}${id}${gap}${timestamp}${gap}${servicePadded}${gap}${action}${gap}${status}${gap}${imageTag}`;
}

/**
 * Prints the table header for history display.
 *
 * Uses the same dynamic width calculations as data rows to ensure
 * headers and data remain aligned.
 *
 * @param flexWidths - Pre-calculated flexible column widths
 */
function printTableHeader(flexWidths: { serviceWidth: number; imageTagWidth: number }): void {
  const gap = " ".repeat(COLUMN_GAP);

  const id = padStartToWidth("ID", FIXED_COLUMNS.id);
  const timestamp = padToWidth("Timestamp", FIXED_COLUMNS.timestamp);
  const service = padToWidth("Service", flexWidths.serviceWidth);
  const action = padToWidth("Action", FIXED_COLUMNS.action);
  const status = padToWidth("Status", FIXED_COLUMNS.status);
  const imageTag = "Image Tag";

  const header = `${ROW_PREFIX}${id}${gap}${timestamp}${gap}${service}${gap}${action}${gap}${status}${gap}${imageTag}`;
  const separatorWidth = stringWidth(header) - stringWidth(ROW_PREFIX);

  console.error("");
  console.error(colors.bold("Deployment History"));
  console.error("");
  console.error(colors.gray(header));
  console.error(colors.gray(ROW_PREFIX + "-".repeat(separatorWidth)));
}

/**
 * Execute the history command.
 *
 * Shows deployment history for services with optional filtering by service,
 * action type, and date. Results are displayed in table format or JSON.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, json mode)
 *
 * @example
 * ```typescript
 * // Show last 10 deployments
 * await executeHistory({}, { json: false });
 *
 * // Show last 20 deployments for traefik
 * await executeHistory({ service: 'traefik', limit: '20' }, {});
 *
 * // Show deploy actions since a specific date
 * await executeHistory({ action: 'deploy', since: '2024-01-01' }, {});
 * ```
 */
export async function executeHistory(
  rawOptions: RawHistoryOptions,
  globalOptions: { debug?: boolean; json?: boolean; output?: OutputFormat },
): Promise<void> {
  // Step 1: Extract global options
  const format = globalOptions.output ?? "text";

  logDebug(`History raw options: ${JSON.stringify(rawOptions)}`);
  logDebug(`History global options: ${JSON.stringify(globalOptions)}`);

  // Step 2: Build typed HistoryOptions from command options
  const limit =
    rawOptions.limit !== undefined ? parseInt(rawOptions.limit, 10) : DEFAULT_HISTORY_LIMIT;

  if (isNaN(limit) || limit < 1) {
    throw new InvalidArgumentError("limit", rawOptions.limit ?? "", "Must be a positive number");
  }

  // Validate action filter (throws InvalidArgumentError if invalid)
  const action = parseActionFilter(rawOptions.action);

  // Validate since date if provided
  let since: string | undefined;
  if (rawOptions.since !== undefined) {
    const parsedDate = new Date(rawOptions.since);
    if (isNaN(parsedDate.getTime())) {
      throw new InvalidArgumentError(
        "since",
        rawOptions.since,
        "Invalid date format. Use ISO 8601 format (e.g., 2024-01-01 or 2024-01-01T00:00:00Z)",
      );
    }
    since = parsedDate.toISOString();
  }

  const historyOptions: HistoryOptions = {
    service: rawOptions.service,
    limit,
    since,
    action,
  };

  logDebug(`Parsed history options: ${JSON.stringify(historyOptions)}`);

  // Steps 3-4: Initialize database connection
  let db;
  try {
    db = await initializeDatabase();
  } catch (error) {
    const dbError = error instanceof Error ? error : new Error(String(error));
    const formatted = formatError(dbError);
    outputFormattedError(formatted);
    process.exitCode = 1;
    return;
  }

  try {
    // Step 5: Query deployment history
    const entries = getDeploymentHistory(db, historyOptions);

    // Get total count for the filters (without limit) for JSON output
    const totalCount = getDeploymentCount(db, {
      service: historyOptions.service,
      action: historyOptions.action,
      since: historyOptions.since,
    });

    logDebug(`Found ${entries.length} entries (total matching: ${totalCount})`);

    // Step 6-7: Format output for CLI or structured format
    if (format !== "text") {
      const result: HistoryResult = {
        entries,
        totalCount,
        filters: {
          service: historyOptions.service,
          action: historyOptions.action,
          since: historyOptions.since,
          limit,
        },
      };
      await formatOutput(format, result);
      return;
    }

    // Handle empty results gracefully
    if (entries.length === 0) {
      console.error("");
      logInfo("No deployment history found");

      if (
        historyOptions.service !== undefined ||
        historyOptions.action !== undefined ||
        historyOptions.since !== undefined
      ) {
        const filters: string[] = [];
        if (historyOptions.service !== undefined) {
          filters.push(`service="${historyOptions.service}"`);
        }
        if (historyOptions.action !== undefined) {
          filters.push(`action="${historyOptions.action}"`);
        }
        if (historyOptions.since !== undefined) {
          filters.push(`since="${historyOptions.since}"`);
        }
        logInfo(`Applied filters: ${filters.join(", ")}`);
      }
      console.error("");
      return;
    }

    // Print table format
    const flexWidths = calculateFlexWidths();
    printTableHeader(flexWidths);

    for (const entry of entries) {
      console.error(formatTableRow(entry, flexWidths));
    }

    console.error("");

    // Show count summary
    if (totalCount > entries.length) {
      logInfo(`Showing ${entries.length} of ${totalCount} entries (use --limit to see more)`);
    } else {
      logInfo(`Showing ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`);
    }
    console.error("");
  } catch (error) {
    const queryError = error instanceof Error ? error : new Error(String(error));
    const formatted = formatError(queryError);
    outputFormattedError(formatted);
    process.exitCode = 1;
  } finally {
    // Step 8: Close database connection
    closeDatabase(db);
  }
}
