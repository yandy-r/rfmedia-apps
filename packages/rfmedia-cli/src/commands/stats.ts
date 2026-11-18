/**
 * Stats command definition for rfmedia CLI.
 *
 * Displays operation statistics and storage usage from the tracking database.
 */

import { Command } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat } from "@rfmedia/common";

import { logError } from "../lib/logger.js";
import type { StatsOptions, GlobalOptions } from "../types/options.js";
import type { StatsResult } from "../types/results.js";

/**
 * JSON output structure for stats command.
 */
interface StatsJsonOutput {
  command: "stats";
  result: StatsResult;
}

/**
 * Stats command for displaying operation statistics and storage usage.
 *
 * Queries the tracking database to show:
 * - Operation statistics by command type
 * - Success rates by mode (album/filter)
 * - Total files and storage size
 * - Storage breakdown by rating ranges
 */
export const statsCommand = new Command("stats")
  .description("Show operation statistics and storage usage")
  .option("--tracking-database <path>", "Path to SQLite tracking database")
  .action(async (cmdOptions: Record<string, unknown>) => {
    // Get global options from parent command
    const globalOpts = statsCommand.parent?.opts() as GlobalOptions | undefined;

    // Build StatsOptions from parsed command options
    const options: StatsOptions = {
      trackingDatabase: cmdOptions["trackingDatabase"] as string | undefined,
    };

    try {
      // Lazy load the action handler to improve startup time
      const { executeStats } = await import("../actions/stats.js");
      const result: StatsResult = await executeStats(options);

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: StatsJsonOutput = {
          command: "stats",
          result,
        };
        await formatOutput(format, jsonOutput);
      } else {
        formatStatsOutput(result);
      }
    } catch (error) {
      logError(`Stats command failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

/**
 * Formats stats result for console output using tables.
 *
 * @param result - Stats result from database queries
 */
function formatStatsOutput(result: StatsResult): void {
  console.error("");

  // Operation statistics table
  if (result.operations.length > 0) {
    console.error(pc.bold("Operation Statistics"));
    console.error("");

    const opsTable = new Table({
      columns: [
        { name: "command", title: "Command", alignment: "left" },
        { name: "total", title: "Total", alignment: "right" },
        { name: "completed", title: "Complete", alignment: "right" },
        { name: "failed", title: "Failed", alignment: "right" },
        { name: "partial", title: "Partial", alignment: "right" },
        { name: "success", title: "Success", alignment: "right" },
      ],
    });

    for (const op of result.operations) {
      const successColor = op.successRate >= 80 ? "green" : op.successRate >= 50 ? "yellow" : "red";
      opsTable.addRow(
        {
          command: op.command,
          total: op.total,
          completed: op.completed,
          failed: op.failed,
          partial: op.partial,
          success: `${op.successRate.toFixed(1)}%`,
        },
        { color: successColor },
      );
    }

    console.error(opsTable.render());
  } else {
    console.error(pc.yellow("No operations found in database"));
  }

  // Success rate by mode
  if (
    result.successRateByMode.album !== undefined ||
    result.successRateByMode.filter !== undefined
  ) {
    console.error("");
    console.error(pc.bold("Success Rate by Mode"));
    console.error("");

    const modeTable = new Table({
      columns: [
        { name: "mode", title: "Mode", alignment: "left" },
        { name: "rate", title: "Success Rate", alignment: "right" },
      ],
    });

    if (result.successRateByMode.album !== undefined) {
      const albumColor =
        result.successRateByMode.album >= 80
          ? "green"
          : result.successRateByMode.album >= 50
            ? "yellow"
            : "red";
      modeTable.addRow(
        { mode: "album", rate: `${result.successRateByMode.album.toFixed(1)}%` },
        { color: albumColor },
      );
    }

    if (result.successRateByMode.filter !== undefined) {
      const filterColor =
        result.successRateByMode.filter >= 80
          ? "green"
          : result.successRateByMode.filter >= 50
            ? "yellow"
            : "red";
      modeTable.addRow(
        { mode: "filter", rate: `${result.successRateByMode.filter.toFixed(1)}%` },
        { color: filterColor },
      );
    }

    console.error(modeTable.render());
  }

  // Total storage (simple key-value display)
  console.error("");
  console.error(pc.bold("Total Storage"));
  console.error(`  Files: ${pc.cyan(result.totalFiles.toLocaleString())}`);
  console.error(`  Size:  ${pc.cyan(formatBytes(result.totalSize))}`);

  // Storage by rating
  if (result.storageByRating.length > 0) {
    console.error("");
    console.error(pc.bold("Storage by Rating"));
    console.error("");

    const ratingTable = new Table({
      columns: [
        { name: "range", title: "Rating", alignment: "left" },
        { name: "files", title: "Files", alignment: "right" },
        { name: "size", title: "Size", alignment: "right" },
      ],
    });

    for (const range of result.storageByRating) {
      ratingTable.addRow({
        range: range.range,
        files: range.fileCount.toLocaleString(),
        size: formatBytes(range.totalSize),
      });
    }

    console.error(ratingTable.render());
  }

  console.error(""); // Empty line at end
}

/**
 * Formats bytes to human-readable string.
 *
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "1.5 GB")
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(1)} ${units[i]}`;
}
