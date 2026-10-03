/**
 * Generations listing action for rfapps CLI.
 *
 * Shows immutable generation snapshots (Nix-style generational state) for
 * services, invoked via `rfapps history --generations`. Each successful
 * deploy-like action (deploy, rebuild, apply, rollback) appends a numbered
 * generation per service; this view lists those restore targets.
 *
 * Restore a listed generation with:
 * - `rfapps rollback -s <service> --to-generation <n>`
 * - `rfapps rollback -s <service> --to-time <timestamp>`
 *
 * Filtering options:
 * - `--service`: Filter by service name (exact match)
 * - `--limit`: Maximum number of entries to return (default: 10)
 *
 * Output formats:
 * - Table: Color-coded action column, truncated image tags (stderr)
 * - JSON/YAML/CSV/table: Full {@link GenerationsResult} object (stdout)
 */

import stringWidth from "string-width";

import { logInfo, logDebug, colors, formatError, outputFormattedError } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import type { GenerationEntry, GenerationsOptions, GenerationsResult } from "../types/index.js";

import {
  initializeDatabase,
  closeDatabase,
  getGenerations,
  getGenerationCount,
  InvalidArgumentError,
} from "../lib/index.js";
import {
  formatOutput,
  getStderrTerminalWidth,
  truncateToWidth,
  padToWidth,
  padStartToWidth,
  formatTimestamp,
  getActionColor,
} from "../lib/formatters/index.js";

/**
 * Default limit for generation queries.
 */
const DEFAULT_GENERATIONS_LIMIT = 10;

/**
 * Column gutter width (spacing between columns in a row).
 */
const COLUMN_GAP = 2;

/**
 * Left margin prefix for all table rows.
 */
const ROW_PREFIX = "  ";

/**
 * Fixed column widths for generations table columns with predictable content.
 * These are display widths (visual columns), not byte lengths.
 *
 * - Gen: right-aligned generation number
 * - Timestamp: "YYYY-MM-DD HH:mm:ss" is always 19 characters
 * - Action: longest value "rollback" = 8, padded to 10
 * - Deploy: right-aligned originating deployment ID
 */
const FIXED_COLUMNS = {
  gen: 5,
  timestamp: 19,
  action: 10,
  deploy: 6,
} as const;

/**
 * Minimum width for flexible columns (Service, Image Tag).
 */
const MIN_FLEX_WIDTH = 6;

/**
 * Raw options from CLI parser (shared with the history command).
 */
interface RawGenerationsOptions {
  /** Service name filter (exact match) */
  service?: string;
  /** Maximum entries to return (parsed to number) */
  limit?: string;
  /** Unsupported in generations mode: action filter from history command */
  action?: string;
  /** Unsupported in generations mode: since filter from history command */
  since?: string;
}

/**
 * Calculate the available width budget for flexible columns (Service, Image Tag).
 *
 * Fixed columns (Gen, Timestamp, Action, Deploy) consume a known budget.
 * The remaining width after fixed columns, gaps, and row prefix is split
 * between Service (40%) and Image Tag (60%).
 *
 * @returns Object with serviceWidth and imageTagWidth
 */
function calculateFlexWidths(): { serviceWidth: number; imageTagWidth: number } {
  const terminalWidth = getStderrTerminalWidth();
  const prefixWidth = stringWidth(ROW_PREFIX);
  const fixedBudget =
    FIXED_COLUMNS.gen + FIXED_COLUMNS.timestamp + FIXED_COLUMNS.action + FIXED_COLUMNS.deploy;
  // 6 columns = 5 gaps between them + prefix
  const totalGaps = 5 * COLUMN_GAP;
  const flexBudget = terminalWidth - prefixWidth - fixedBudget - totalGaps;

  // Allocate 40% to service, 60% to image tag (service names tend to be shorter)
  const serviceWidth = Math.max(Math.floor(flexBudget * 0.4), MIN_FLEX_WIDTH);
  const imageTagWidth = Math.max(flexBudget - serviceWidth, MIN_FLEX_WIDTH);

  return { serviceWidth, imageTagWidth };
}

/**
 * Formats a single generation entry for table display.
 *
 * @param entry - Generation entry to format
 * @param flexWidths - Pre-calculated flexible column widths
 * @returns Formatted table row string
 */
function formatTableRow(
  entry: GenerationEntry,
  flexWidths: { serviceWidth: number; imageTagWidth: number },
): string {
  const gap = " ".repeat(COLUMN_GAP);

  const gen = padStartToWidth(`#${entry.generation}`, FIXED_COLUMNS.gen);
  const timestamp = formatTimestamp(entry.timestamp);
  const service = padToWidth(
    truncateToWidth(entry.service, flexWidths.serviceWidth),
    flexWidths.serviceWidth,
  );
  const action = getActionColor(entry.createdByAction)(
    padToWidth(entry.createdByAction, FIXED_COLUMNS.action),
  );
  const deploy = padStartToWidth(
    entry.deploymentId !== undefined ? entry.deploymentId.toString() : "-",
    FIXED_COLUMNS.deploy,
  );
  const imageTag = truncateToWidth(entry.imageTag ?? "-", flexWidths.imageTagWidth);

  return `${ROW_PREFIX}${gen}${gap}${timestamp}${gap}${service}${gap}${action}${gap}${deploy}${gap}${imageTag}`;
}

/**
 * Prints the table header for generations display.
 *
 * @param flexWidths - Pre-calculated flexible column widths
 */
function printTableHeader(flexWidths: { serviceWidth: number; imageTagWidth: number }): void {
  const gap = " ".repeat(COLUMN_GAP);

  const gen = padStartToWidth("Gen", FIXED_COLUMNS.gen);
  const timestamp = padToWidth("Timestamp", FIXED_COLUMNS.timestamp);
  const service = padToWidth("Service", flexWidths.serviceWidth);
  const action = padToWidth("Action", FIXED_COLUMNS.action);
  const deploy = padStartToWidth("Deploy", FIXED_COLUMNS.deploy);
  const imageTag = "Image Tag";

  const header = `${ROW_PREFIX}${gen}${gap}${timestamp}${gap}${service}${gap}${action}${gap}${deploy}${gap}${imageTag}`;
  const separatorWidth = stringWidth(header) - stringWidth(ROW_PREFIX);

  console.error("");
  console.error(colors.bold("Generations"));
  console.error("");
  console.error(colors.gray(header));
  console.error(colors.gray(ROW_PREFIX + "-".repeat(separatorWidth)));
}

/**
 * Execute the generations listing (history --generations).
 *
 * Shows immutable generation snapshots with optional filtering by service.
 * Results are displayed in table format (stderr) or a structured format.
 *
 * @param rawOptions - Command-specific options from CLI
 * @param globalOptions - Global CLI options (debug, output format)
 * @throws {InvalidArgumentError} If limit is invalid or history-only filters are combined
 *
 * @example
 * ```typescript
 * // Show last 10 generations across all services
 * await executeGenerations({}, {});
 *
 * // Show last 20 generations for traefik
 * await executeGenerations({ service: 'traefik', limit: '20' }, {});
 * ```
 */
export async function executeGenerations(
  rawOptions: RawGenerationsOptions,
  globalOptions: { debug?: boolean; json?: boolean; output?: OutputFormat },
): Promise<void> {
  const format = globalOptions.output ?? "text";

  logDebug(`Generations raw options: ${JSON.stringify(rawOptions)}`);

  // History-only filters are not supported for generations
  if (rawOptions.action !== undefined) {
    throw new InvalidArgumentError(
      "--action",
      rawOptions.action,
      "Cannot be combined with --generations (generations only track deploy-like actions)",
    );
  }
  if (rawOptions.since !== undefined) {
    throw new InvalidArgumentError(
      "--since",
      rawOptions.since,
      "Cannot be combined with --generations (use rollback --to-time to restore by time)",
    );
  }

  const limit =
    rawOptions.limit !== undefined ? parseInt(rawOptions.limit, 10) : DEFAULT_GENERATIONS_LIMIT;

  if (isNaN(limit) || limit < 1) {
    throw new InvalidArgumentError("limit", rawOptions.limit ?? "", "Must be a positive number");
  }

  const options: GenerationsOptions = {
    service: rawOptions.service,
    limit,
  };

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
    const entries = getGenerations(db, options);
    const totalCount = getGenerationCount(db, { service: options.service });

    logDebug(`Found ${entries.length} generations (total matching: ${totalCount})`);

    if (format !== "text") {
      const result: GenerationsResult = {
        entries,
        totalCount,
        filters: {
          service: options.service,
          limit,
        },
      };
      await formatOutput(format, result);
      return;
    }

    if (entries.length === 0) {
      console.error("");
      logInfo("No generations found");
      if (options.service !== undefined) {
        logInfo(`Applied filters: service="${options.service}"`);
      }
      logInfo("Generations are created by successful deploy, rebuild, apply, and rollback actions");
      console.error("");
      return;
    }

    const flexWidths = calculateFlexWidths();
    printTableHeader(flexWidths);

    for (const entry of entries) {
      console.error(formatTableRow(entry, flexWidths));
    }

    console.error("");

    if (totalCount > entries.length) {
      logInfo(`Showing ${entries.length} of ${totalCount} generations (use --limit to see more)`);
    } else {
      logInfo(`Showing ${entries.length} ${entries.length === 1 ? "generation" : "generations"}`);
    }
    logInfo("Restore with: rfapps rollback -s <service> --to-generation <n>");
    console.error("");
  } catch (error) {
    const queryError = error instanceof Error ? error : new Error(String(error));
    const formatted = formatError(queryError);
    outputFormattedError(formatted);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}
