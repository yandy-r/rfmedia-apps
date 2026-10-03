/**
 * Clean command definition for rfmedia CLI.
 *
 * Deletes empty album folders and cascades to empty artist folders.
 */

import { Command, Option } from "commander";
import { isMachineFormat } from "@rfmedia/common";
import { getLoadedConfig } from "../cli.js";
import type { CleanOptions, GlobalOptions } from "../types/options.js";

/**
 * JSON output structure for clean command.
 */
interface CleanJsonOutput {
  command: "clean";
  directory: string;
  result: {
    albumsDeleted: number;
    artistsDeleted: number;
    errors: Array<{ path: string; message: string; code?: string }>;
  };
}

/**
 * Parse and validate --depth option (0 = unlimited, positive = max depth).
 */
function parseDepthArg(value: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid depth: "${value}". Must be a non-negative integer.`);
  }
  if (parsed < 0) {
    throw new Error(`Depth must be non-negative (use 0 for unlimited), got ${parsed}.`);
  }
  return parsed;
}

/**
 * Parse a comma-separated list of exclude patterns.
 */
function parseExcludePatterns(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(",").map((p) => p.trim())];
}

/**
 * Clean command for deleting empty album folders.
 *
 * Scans the specified directory for empty albums (folders with no audio files)
 * and removes them. Artist folders that become empty after album deletion
 * are also removed.
 */
export const cleanCommand = new Command("clean")
  .description("Delete empty album folders")
  .argument("<directory>", "Music directory to clean")
  .option("--force", "Skip confirmation prompt")
  .addOption(
    new Option("--min-files <number>", "Delete albums with fewer than N audio files").argParser(
      parseInt,
    ),
  )
  .option(
    "--exclude <patterns>",
    "Exclude patterns from deletion (comma-separated)",
    parseExcludePatterns,
  )
  .option("--protect <file>", "File containing patterns to never delete")
  .option("--trash", "Move to trash instead of permanent delete")
  .addOption(
    new Option(
      "--older-than <days>",
      "Only delete albums not modified in the past N days",
    ).argParser(parseInt),
  )
  .addOption(
    new Option(
      "--depth <number>",
      "Maximum directory depth to scan (default: 2, use 0 for unlimited)",
    ).argParser(parseDepthArg),
  )
  .action(async (directory: string, cmdOptions: Record<string, unknown>) => {
    // Get global options from parent command
    const globalOpts = cleanCommand.parent?.opts() as GlobalOptions | undefined;

    // Get config values (CLI options take precedence)
    const cleanConfig = getLoadedConfig().clean ?? {};

    // Construct CleanOptions from parsed command options and config
    const options: CleanOptions = {
      force:
        cmdOptions["force"] !== undefined
          ? Boolean(cmdOptions["force"])
          : (cleanConfig.force ?? false),
      dryRun: Boolean(globalOpts?.dryRun),
      minFiles: (cmdOptions["minFiles"] as number | undefined) ?? cleanConfig.minFiles,
      exclude: (cmdOptions["exclude"] as string[] | undefined) ?? cleanConfig.exclude,
      protect: (cmdOptions["protect"] as string | undefined) ?? cleanConfig.protect,
      useTrash:
        cmdOptions["trash"] !== undefined
          ? Boolean(cmdOptions["trash"])
          : (cleanConfig.useTrash ?? false),
      olderThan: (cmdOptions["olderThan"] as number | undefined) ?? cleanConfig.olderThan,
      depth: (cmdOptions["depth"] as number | undefined) ?? cleanConfig.depth,
    };

    // Lazy load the action handler to improve startup time
    const { executeClean } = await import("../actions/clean.js");
    const result = await executeClean(directory, options);

    // Output JSON if --json flag is set
    const jsonOutput: CleanJsonOutput = {
      command: "clean",
      directory,
      result: {
        albumsDeleted: result.albumsDeleted,
        artistsDeleted: result.artistsDeleted,
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
