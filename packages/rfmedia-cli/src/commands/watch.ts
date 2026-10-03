/**
 * Watch command definition for rfmedia CLI.
 *
 * This module defines the watch command which monitors directories for new content
 * and auto-processes using existing copy logic (album or filter mode).
 */

import { Command, Option } from "commander";
import { parseRange } from "../lib/range.js";
import { getLoadedConfig } from "../cli.js";
import type { WatchOptions } from "../types/index.js";

/**
 * Default debounce delay in milliseconds.
 * When a new album is added, many files arrive rapidly. Wait for this duration
 * of no new events before processing.
 */
const DEFAULT_DEBOUNCE_MS = 5000;

/**
 * Default output folder name for filter mode.
 */
const DEFAULT_OUTPUT_FOLDER = "liked-songs";

/**
 * Parses a string to an integer.
 * Used as argParser for numeric options.
 */
function parseIntArg(value: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

/**
 * Parses a string to a float for rating values.
 * Supports both integer (4) and float (3.5) formats.
 */
function parseFloatArg(value: string, optionName: string = "value"): number {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for ${optionName}: ${value}`);
  }
  if (parsed < 1.0 || parsed > 5.0) {
    throw new Error(`${optionName} must be between 1.0 and 5.0, got ${parsed}`);
  }
  return parsed;
}

/**
 * Raw options as parsed by Commander.js before transformation.
 */
interface RawWatchOptions {
  mode: "album" | "filter";
  range?: ReturnType<typeof parseRange>;
  albumOnly?: boolean;
  minStars?: number;
  minRating?: number;
  outputFolder?: string;
  preserveStructure?: boolean;
  hardlink?: boolean;
  debounce?: number;
}

/**
 * Validates and builds WatchOptions from raw CLI options.
 *
 * Merges values from config file with CLI options. CLI options take precedence.
 *
 * @param source - Source directory path
 * @param destination - Destination directory path
 * @param rawOptions - Raw options from Commander.js
 * @returns Fully constructed WatchOptions
 * @throws Error if options are invalid for the specified mode
 */
function buildWatchOptions(
  source: string,
  destination: string,
  rawOptions: RawWatchOptions,
): WatchOptions {
  const watchConfig = getLoadedConfig().watch ?? {};
  const { mode } = rawOptions;

  // Validate mode-specific options
  if (mode === "album") {
    if (!rawOptions.range) {
      throw new Error("Album mode requires --range option (e.g., --range=001-010)");
    }
  } else if (mode === "filter") {
    if (rawOptions.minStars === undefined && rawOptions.minRating === undefined) {
      throw new Error("Filter mode requires --min-stars or --min-rating option");
    }
  }

  return {
    source,
    destination,
    mode,
    // Album mode options
    range: rawOptions.range,
    albumOnly: rawOptions.albumOnly ?? watchConfig.albumOnly,
    // Filter mode options
    minStars: rawOptions.minStars,
    minRating: rawOptions.minRating,
    outputFolder: rawOptions.outputFolder ?? watchConfig.outputFolder ?? DEFAULT_OUTPUT_FOLDER,
    preserveStructure: rawOptions.preserveStructure ?? watchConfig.preserveStructure,
    // Common options
    hardlink: rawOptions.hardlink ?? watchConfig.hardlink,
    debounceMs: rawOptions.debounce ?? watchConfig.debounceMs ?? DEFAULT_DEBOUNCE_MS,
  };
}

/**
 * Watch command for monitoring directories and auto-processing new content.
 */
export const watchCommand = new Command("watch")
  .description("Watch directories for new content and auto-process using copy logic")
  .argument("<source>", "Source directory to watch")
  .argument("<destination>", "Destination directory for copied content")
  // Required mode option
  .addOption(
    new Option("--mode <mode>", "Copy mode to use for processing")
      .choices(["album", "filter"])
      .makeOptionMandatory(),
  )
  // Album mode options
  .addOption(
    new Option(
      "-r, --range <START-END>",
      "Range of suffixes to create (album mode, e.g., 001-010)",
    ).argParser(parseRange),
  )
  .addOption(
    new Option("--album-only", "Treat detected folders as single albums, not artist folders"),
  )
  // Filter mode options
  .addOption(
    new Option("--min-stars <N>", "Minimum star rating (1.0-5.0) for filter mode").argParser(
      (val) => parseFloatArg(val, "--min-stars"),
    ),
  )
  .addOption(
    new Option("--min-rating <N>", "Minimum rating (0-100) for filter mode").argParser(parseIntArg),
  )
  .addOption(
    new Option("--output-folder <name>", "Folder name for filtered tracks").default(
      DEFAULT_OUTPUT_FOLDER,
    ),
  )
  .addOption(new Option("--preserve-structure", "Keep album subfolders in filter mode output"))
  // Common options
  .addOption(new Option("--hardlink", "Use hardlinks instead of file copies"))
  .addOption(
    new Option("--debounce <ms>", "Debounce delay in milliseconds before processing")
      .argParser(parseIntArg)
      .default(DEFAULT_DEBOUNCE_MS),
  )
  .action(async (source: string, destination: string, options: RawWatchOptions) => {
    // Build fully typed WatchOptions from raw CLI options
    const watchOptions = buildWatchOptions(source, destination, options);

    // Lazy load the action handler to improve startup time
    const { executeWatch } = await import("../actions/watch.js");
    await executeWatch(watchOptions);
  });
