/**
 * Migrate-tracking command definition for rfmedia CLI.
 *
 * Migrates legacy tracking and history files to SQLite database.
 */

import { Command } from "commander";
import { logError } from "../lib/logger.js";
import { isMachineFormat } from "@rfmedia/common";
import type { MigrateOptions, GlobalOptions } from "../types/options.js";
import type { MigrateResult } from "../types/results.js";

/**
 * JSON output structure for migrate-tracking command.
 */
interface MigrateJsonOutput {
  command: "migrate-tracking";
  result: {
    tracking: {
      operations: number;
      sources: number;
      legacyFiles: Array<{
        path: string;
        type: "completed" | "failed";
        hash: string;
        entryCount: number;
        inputFile?: string;
      }>;
    };
    history: {
      sessions: number;
      operations: number;
      legacyFiles: Array<{
        path: string;
        sessionId: string;
        operationCount: number;
        command: string;
        startedAt: string;
      }>;
    };
    filesDeleted: number;
    errors: Array<{ path: string; message: string; code?: string }>;
  };
}

/**
 * Migrate-tracking command for migrating legacy files to SQLite database.
 *
 * Discovers and migrates legacy tracking and history files to the database,
 * with optional cleanup of legacy files after successful migration.
 */
export const migrateCommand = new Command("migrate-tracking")
  .alias("migrate")
  .description("Migrate legacy tracking and history files to SQLite database")
  .option("--delete-old", "Remove legacy files after successful migration")
  .option("-f, --force", "Skip confirmation prompts")
  .option("--tracking-only", "Only migrate tracking files (skip history)")
  .option("--history-only", "Only migrate history files (skip tracking)")
  .option("--history-path <path>", "Custom history directory (default: ~/.rfmedia/history)")
  .action(async (cmdOptions: Record<string, unknown>) => {
    // Get global options from parent command
    const globalOpts = migrateCommand.parent?.opts() as GlobalOptions | undefined;

    // Build MigrateOptions from parsed command options
    const options: MigrateOptions = {
      deleteOld: Boolean(cmdOptions["deleteOld"]),
      force: Boolean(cmdOptions["force"]),
      trackingOnly: Boolean(cmdOptions["trackingOnly"]),
      historyOnly: Boolean(cmdOptions["historyOnly"]),
      historyPath: cmdOptions["historyPath"] as string | undefined,
      dryRun: Boolean(globalOpts?.dryRun),
    };

    // Validate mutually exclusive options
    if (options.trackingOnly && options.historyOnly) {
      logError("Cannot use both --tracking-only and --history-only");
      process.exitCode = 1;
      return;
    }

    // Lazy load the action handler to improve startup time
    const { executeMigrate } = await import("../actions/migrate-tracking.js");
    const result: MigrateResult = await executeMigrate(options);

    // Output JSON if --json flag is set
    const jsonOutput: MigrateJsonOutput = {
      command: "migrate-tracking",
      result: {
        tracking: result.tracking,
        history: result.history,
        filesDeleted: result.filesDeleted,
        errors: result.errors,
      },
    };

    const format = globalOpts?.output ?? "text";
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(format, jsonOutput);
    }

    // Exit with error code if any operations failed
    if (result.errors.length > 0) {
      process.exitCode = 1;
    }
  });
