/**
 * History command definition for rfmedia CLI.
 *
 * Queries operation history with filtering and duplicate detection.
 */

import { Command, Option } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat } from "@rfmedia/common";

import { logError } from "../lib/logger.js";
import type { HistoryOptions, GlobalOptions } from "../types/options.js";
import type { HistoryResult } from "../types/results.js";

/**
 * JSON output structure for history command.
 */
interface HistoryJsonOutput {
  command: "history";
  result: HistoryResult;
}

/**
 * History command for querying operation history with filters.
 *
 * Queries the tracking database to show operation history with support for:
 * - Date range filtering (from/to)
 * - Mode filtering (album/filter)
 * - Status filtering (pending/completed/failed/partial)
 * - Command type filtering
 * - Duplicate detection
 */
export const historyCommand = new Command("history")
  .description("Query operation history with filters")
  .option("--from <date>", 'Start date (ISO format or relative like "7 days ago")')
  .option("--to <date>", "End date (ISO format or relative)")
  .addOption(new Option("--mode <type>", "Filter by copy mode").choices(["album", "filter"]))
  .addOption(
    new Option("--status <status>", "Filter by operation status").choices([
      "pending",
      "completed",
      "failed",
      "partial",
    ]),
  )
  .addOption(
    new Option("--command <command>", "Filter by command type").choices([
      "copy-album",
      "copy-filter",
      "sync",
    ]),
  )
  .addOption(
    new Option("-l, --limit <number>", "Maximum results").default(50).argParser((value) => {
      const parsed = parseInt(value, 10);
      if (isNaN(parsed) || parsed <= 0) {
        throw new Error("Limit must be a positive integer");
      }
      return parsed;
    }),
  )
  .option("--show-duplicates", "Highlight duplicate operations")
  .option("--tracking-database <path>", "Path to SQLite tracking database")
  .action(async (cmdOptions: Record<string, unknown>) => {
    // Get global options from parent command
    const globalOpts = historyCommand.parent?.opts() as GlobalOptions | undefined;

    // Build HistoryOptions from parsed command options
    const options: HistoryOptions = {
      from: cmdOptions["from"] as string | undefined,
      to: cmdOptions["to"] as string | undefined,
      mode: cmdOptions["mode"] as "album" | "filter" | undefined,
      status: cmdOptions["status"] as "pending" | "completed" | "failed" | "partial" | undefined,
      command: cmdOptions["command"] as "copy-album" | "copy-filter" | "sync" | undefined,
      limit: (cmdOptions["limit"] as number) ?? 50,
      showDuplicates: Boolean(cmdOptions["showDuplicates"]),
      trackingDatabase: cmdOptions["trackingDatabase"] as string | undefined,
      dryRun: Boolean(globalOpts?.dryRun),
    };

    try {
      // Lazy load the action handler to improve startup time
      const { executeHistory } = await import("../actions/history.js");
      const result: HistoryResult = await executeHistory(options);

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: HistoryJsonOutput = {
          command: "history",
          result,
        };
        await formatOutput(format, jsonOutput);
      } else {
        formatHistoryOutput(result, options.limit);
      }
    } catch (error) {
      logError(`History command failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

/**
 * Formats history result for console output using tables.
 *
 * @param result - History result from database queries
 * @param limit - Maximum number of results requested
 */
function formatHistoryOutput(result: HistoryResult, limit: number): void {
  console.error("");
  console.error(pc.bold("Operation History"));

  if (result.totalCount === 0) {
    console.error("");
    console.error(pc.yellow("No operations found matching filters"));
    return;
  }

  // Count summary
  console.error("");
  if (result.totalCount > limit) {
    console.error(
      `Showing ${pc.cyan(result.entries.length.toString())} of ${pc.cyan(result.totalCount.toString())} operations (limit: ${limit})`,
    );
  } else {
    console.error(`Found ${pc.cyan(result.totalCount.toString())} operation(s)`);
  }
  console.error("");

  // History entries table
  const historyTable = new Table({
    columns: [
      { name: "id", title: "ID", alignment: "right" },
      { name: "time", title: "Time", alignment: "left" },
      { name: "command", title: "Command", alignment: "left" },
      { name: "mode", title: "Mode", alignment: "left" },
      { name: "status", title: "Status", alignment: "left" },
      { name: "progress", title: "Progress", alignment: "right" },
      { name: "failed", title: "Failed", alignment: "right" },
      { name: "duration", title: "Duration", alignment: "right" },
    ],
  });

  for (const entry of result.entries) {
    const statusColor = getStatusColor(entry.status);
    const duration = entry.endedAt ? calculateDuration(entry.startedAt, entry.endedAt) : "running";

    historyTable.addRow(
      {
        id: entry.id,
        time: formatTimestampShort(entry.createdAt),
        command: entry.command,
        mode: entry.mode,
        status: formatStatusLabel(entry.status),
        progress: `${entry.completedCount}/${entry.totalSources}`,
        failed: entry.failedCount,
        duration: duration,
      },
      { color: statusColor },
    );
  }

  console.error(historyTable.render());

  // Duplicate operations section
  if (result.duplicates && result.duplicates.length > 0) {
    console.error("");
    console.error(pc.bold(pc.yellow(`Duplicate Operations (${result.duplicates.length} groups)`)));
    console.error("");

    const dupOpsTable = new Table({
      columns: [
        { name: "hash", title: "Options Hash", alignment: "left" },
        { name: "count", title: "Count", alignment: "right" },
        { name: "ids", title: "Operation IDs", alignment: "left" },
      ],
    });

    for (const dup of result.duplicates) {
      dupOpsTable.addRow(
        {
          hash: truncateString(dup.optionsHash, 30),
          count: dup.count,
          ids: dup.operationIds.join(", "),
        },
        { color: "yellow" },
      );
    }

    console.error(dupOpsTable.render());
  }

  // Duplicate sources section
  if (result.duplicateSources && result.duplicateSources.length > 0) {
    console.error("");
    console.error(
      pc.bold(pc.yellow(`Duplicate Sources (${result.duplicateSources.length} paths)`)),
    );
    console.error("");

    const dupSourcesTable = new Table({
      columns: [
        { name: "path", title: "Source Path", alignment: "left" },
        { name: "count", title: "Times Processed", alignment: "right" },
      ],
    });

    const topDuplicates = result.duplicateSources.slice(0, 20);
    for (const dup of topDuplicates) {
      dupSourcesTable.addRow(
        {
          path: truncateString(dup.sourcePath, 60),
          count: dup.operationCount,
        },
        { color: "yellow" },
      );
    }

    console.error(dupSourcesTable.render());

    if (result.duplicateSources.length > 20) {
      console.error(pc.dim(`  ... and ${result.duplicateSources.length - 20} more`));
    }
  }

  console.error(""); // Empty line at end
}

/**
 * Gets the table row color based on status.
 *
 * @param status - Operation status
 * @returns Color string for console-table-printer
 */
function getStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "partial":
      return "yellow";
    case "pending":
      return "cyan";
    default:
      return "white";
  }
}

/**
 * Formats status as a simple label for table display.
 *
 * @param status - Operation status
 * @returns Status label string
 */
function formatStatusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "✓ done";
    case "failed":
      return "✗ failed";
    case "partial":
      return "⚠ partial";
    case "pending":
      return "○ pending";
    default:
      return status;
  }
}

/**
 * Truncates a string to a maximum length with ellipsis.
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length
 * @returns Truncated string
 */
function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + "...";
}

/**
 * Formats timestamp as a short display string for tables.
 *
 * @param isoTimestamp - ISO timestamp string
 * @returns Short formatted date/time string
 */
function formatTimestampShort(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    // Today - show time only
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (diffDays === 1) {
    return "yesterday";
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
}

/**
 * Calculates and formats duration between two timestamps.
 *
 * @param startIso - Start timestamp (ISO)
 * @param endIso - End timestamp (ISO)
 * @returns Formatted duration string
 */
function calculateDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const diffMs = end.getTime() - start.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
