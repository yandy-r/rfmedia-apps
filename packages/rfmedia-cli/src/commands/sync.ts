/**
 * Sync command definition for rfmedia CLI.
 *
 * This module defines the sync command which performs incremental updates
 * to previously copied sources, detecting new files and rating changes.
 * It operates in the same two modes as the copy command:
 * - Album mode: Syncs entire albums with numbered suffixes (--range)
 * - Filter mode: Syncs tracks meeting a rating threshold (--min-stars/--min-rating)
 */

import os from "node:os";
import { Command, Option } from "commander";
import { parseRange } from "../lib/range.js";
import { logDebug } from "../lib/logger.js";
import { isMachineFormat } from "@rfmedia/common";
import { getDefaultWorkers, validateWorkers } from "../lib/parallel.js";
import { getValidFormats, isValidConvertFormat, requireFfmpeg } from "../lib/convert.js";
import { loadAndValidatePathsYaml } from "../lib/paths-yaml.js";
import {
  InvalidNumericArgumentError,
  LookupNotFoundError,
  MissingRequiredArgumentError,
  OptionConflictError,
} from "../lib/errors.js";
import { findClosestMatch } from "../lib/fuzzy-match.js";
import { getLoadedConfig } from "../cli.js";
import type {
  CopyOptions,
  CopyMode,
  RatingFilter,
  CopyRange,
  ConvertFormat,
  PathEntry,
} from "../types/index.js";
import type { SyncOptions, SyncResult } from "../types/inventory.js";

/**
 * JSON output structure for sync command.
 */
interface SyncJsonOutput {
  command: "sync";
  mode: "album" | "filter";
  inputFile: string;
  destination: string;
  result: {
    sourcesScanned: number;
    newFilesCopied: number;
    updatedFilesCopied: number;
    unchangedFilesSkipped: number;
    deletedFiles: number;
    failedFiles: number;
    failed: Array<{ sourcePath: string; destPath?: string; message: string; code?: string }>;
  };
}

/**
 * Default output folder name for filter mode.
 */
const DEFAULT_OUTPUT_FOLDER = "liked-songs";

/**
 * Maximum number of parallel workers allowed.
 */
const MAX_WORKERS = os.cpus().length;

/**
 * Parses a string to an integer.
 */
function parseIntArg(value: string, optionName: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new InvalidNumericArgumentError(optionName, value, "expected an integer");
  }
  return parsed;
}

function createIntArgParser(optionName: string): (value: string) => number {
  return (value: string) => parseIntArg(value, optionName);
}

/**
 * Parses a string to a float for rating values.
 * Supports both integer (4) and float (3.5) formats.
 */
function parseFloatArg(value: string, optionName: string = "value"): number {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidNumericArgumentError(optionName, value, "expected a numeric value");
  }
  if (parsed < 1.0 || parsed > 5.0) {
    throw new InvalidNumericArgumentError(optionName, parsed, "out of range", 1.0, 5.0);
  }
  return parsed;
}

/**
 * Raw options as parsed by Commander.js before transformation.
 */
interface RawSyncOptions {
  range?: CopyRange;
  hardlink?: boolean;
  force?: boolean;
  file?: string;
  paths?: string;
  minStars?: number;
  minRating?: number;
  outputFolder?: string;
  preserveStructure?: boolean;
  albumMode?: boolean;
  workers?: number;
  convert?: string;
  progress?: boolean;
  resetInventory?: boolean;
  deleteDowngraded?: boolean;
  plexScan?: boolean;
  plexUrl?: string;
  plexToken?: string;
  plexLibrary?: string;
  plexPerSource?: boolean;
  trackingDatabase?: string;
  useLegacyTracking?: boolean;
  requireSpace?: boolean;
  // Source selection options (for --paths)
  sourceIdx?: string;
  sourceName?: string;
  artist?: string;
  group?: string;
  // Explicit flag for YAML-based filter mode (set when sources have filters)
  useFilterMode?: boolean;
}

/**
 * Determines whether album mode options are present.
 */
function hasAlbumModeOptions(options: RawSyncOptions): boolean {
  return options.range !== undefined;
}

/**
 * Determines whether filter mode options are present (CLI, config, or YAML-based).
 */
function hasFilterModeOptions(options: RawSyncOptions): boolean {
  const copyConfig = getLoadedConfig().copy ?? {};
  return (
    options.useFilterMode === true ||
    options.minStars !== undefined ||
    options.minRating !== undefined ||
    copyConfig.minStars !== undefined ||
    copyConfig.minRating !== undefined
  );
}

/**
 * Constructs CopyOptions from raw CLI options for sync.
 *
 * @param rawOptions - Raw options from Commander.js
 * @param globalDryRun - Dry-run flag from global options
 * @returns Fully constructed CopyOptions
 */
function buildCopyOptions(rawOptions: RawSyncOptions, globalDryRun: boolean): CopyOptions {
  const copyConfig = getLoadedConfig().copy ?? {};

  const hasAlbumMode = hasAlbumModeOptions(rawOptions);
  const hasFilterMode = hasFilterModeOptions(rawOptions);

  // Validate that exactly one mode is specified
  if (!hasAlbumMode && !hasFilterMode) {
    throw new MissingRequiredArgumentError(
      "Must specify either album mode (--range) or filter mode (--min-stars or --min-rating)",
    );
  }

  let mode: CopyMode;

  // Filter mode takes precedence
  if (hasFilterMode) {
    // Use CLI value ?? config value for rating thresholds
    const minStars = rawOptions.minStars ?? copyConfig.minStars;
    const minRating = rawOptions.minRating ?? copyConfig.minRating;
    const ratingFilter: RatingFilter = {
      minStars,
      minRating,
      outputFolder: rawOptions.outputFolder ?? copyConfig.outputFolder ?? DEFAULT_OUTPUT_FOLDER,
      preserveStructure: rawOptions.preserveStructure ?? copyConfig.preserveStructure ?? false,
      range: rawOptions.range,
      albumMode: rawOptions.albumMode ?? copyConfig.albumMode ?? false,
    };
    mode = {
      type: "filter",
      rating: ratingFilter,
    };
  } else {
    mode = {
      type: "album",
      range: rawOptions.range!,
    };
  }

  // Determine worker count
  const requestedWorkers = rawOptions.workers ?? copyConfig.workers ?? getDefaultWorkers();
  const workers = validateWorkers(requestedWorkers);
  logDebug(`Using ${workers} parallel workers`);

  // Validate and parse conversion format
  const convertValue = rawOptions.convert ?? copyConfig.convertFormat;
  let convertFormat: ConvertFormat | undefined;
  if (convertValue) {
    if (!isValidConvertFormat(convertValue)) {
      const validFormats = getValidFormats();
      throw new LookupNotFoundError(
        "conversion format",
        convertValue,
        validFormats,
        findClosestMatch(convertValue, validFormats),
      );
    }
    convertFormat = convertValue;
    logDebug(`Audio conversion format: ${convertFormat}`);
  }

  return {
    mode,
    albumOnly: false, // Not used in sync
    hardlink: rawOptions.hardlink ?? copyConfig.hardlink ?? false,
    convertFormat,
    force: rawOptions.force ?? false,
    dryRun: globalDryRun,
    workers,
    file: rawOptions.file,
    progress: rawOptions.progress ?? copyConfig.progress,
    plexScan: rawOptions.plexScan,
    plexUrl: rawOptions.plexUrl,
    plexToken: rawOptions.plexToken,
    plexLibrary: rawOptions.plexLibrary,
    plexPerSource: rawOptions.plexPerSource,
    trackingDatabase: rawOptions.trackingDatabase,
    useLegacyTracking: rawOptions.useLegacyTracking,
    requireDiskSpace: rawOptions.requireSpace,
  };
}

/**
 * Sync command for incrementally updating previously copied sources.
 */
export const syncCommand = new Command("sync")
  .description("Sync previously copied sources, detecting new and updated files")
  .argument(
    "[destination]",
    "Destination directory. Required with --file, not needed with --paths (read from YAML)",
  )
  .addOption(new Option("--file <path>", "File containing source paths").conflicts("paths"))
  .addOption(
    new Option(
      "--paths <file>",
      "Read paths from YAML file (includes destination and sources)",
    ).conflicts("file"),
  )
  // Mode options (same as copy)
  .addOption(
    new Option(
      "-r, --range <START-END>",
      "Range of suffixes for album mode (e.g., 001-010)",
    ).argParser(parseRange),
  )
  .addOption(
    new Option("--min-stars <N>", "Minimum star rating (1.0-5.0) for filter mode").argParser(
      (val) => parseFloatArg(val, "--min-stars"),
    ),
  )
  .addOption(
    new Option("--min-rating <N>", "Minimum rating (0-100) for filter mode").argParser(
      createIntArgParser("--min-rating"),
    ),
  )
  .addOption(
    new Option("--output-folder <name>", "Folder name for filtered tracks").default(
      DEFAULT_OUTPUT_FOLDER,
    ),
  )
  .addOption(new Option("--preserve-structure", "Keep album subfolders in output"))
  .addOption(new Option("--album-mode", "Preserve album folders with only liked tracks"))
  // Sync-specific options
  .addOption(new Option("--reset-inventory", "Clear inventory and rescan all sources"))
  .addOption(new Option("--delete-downgraded", "Delete files when rating falls below threshold"))
  .addOption(new Option("--no-delete-downgraded", "Skip deletion of downgraded files"))
  .addOption(new Option("--force", "Force re-copy even if file appears unchanged"))
  // Common options
  .addOption(new Option("--hardlink", "Use hardlinks instead of file copies"))
  .addOption(
    new Option(
      "-c, --convert <format>",
      "Convert audio files to format (alac, mp3, aac, opus)",
    ).choices(getValidFormats()),
  )
  .addOption(
    new Option(
      "-w, --workers <N>",
      `Number of parallel workers (1-${MAX_WORKERS}, default: auto)`,
    ).argParser(createIntArgParser("--workers")),
  )
  .addOption(new Option("--progress", "Show visual progress bar with ETA"))
  .addOption(new Option("--no-progress", "Disable progress bar"))
  // Plex integration options
  .addOption(new Option("--plex-scan", "Trigger Plex library scan after sync"))
  .addOption(new Option("--no-plex-scan", "Disable Plex library scan"))
  .addOption(new Option("--plex-url <url>", "Plex server URL"))
  .addOption(new Option("--plex-token <token>", "Plex authentication token"))
  .addOption(new Option("--plex-library <name>", "Plex library name to scan"))
  .addOption(new Option("--plex-per-source", "Scan Plex after each source (not at end)"))
  .addOption(new Option("--tracking-database <path>", "Path to SQLite tracking database"))
  .addOption(new Option("--use-legacy-tracking", "Use legacy file-based tracking"))
  .addOption(new Option("--no-use-legacy-tracking", "Use database-backed tracking"))
  .addOption(new Option("--require-space", "Abort if insufficient disk space"))
  .addOption(new Option("--no-require-space", "Skip disk space check"))
  // Source selection options (for --paths)
  .addOption(
    new Option("--source-idx <indices>", 'Select sources by index (1-based, e.g., "1,3" or "2-5")'),
  )
  .addOption(
    new Option(
      "--source-name <names>",
      "Select sources by name (unified search: groups, artist, basename)",
    ),
  )
  .addOption(
    new Option("--artist <names>", "Select sources by artist (case-insensitive contains match)"),
  )
  .addOption(
    new Option("--group <names>", "Select sources by group (case-insensitive contains match)"),
  )
  .action(async (destinationArg: string | undefined, options: RawSyncOptions, command: Command) => {
    // Validate source selection options require --paths
    if (
      (options.sourceIdx || options.sourceName || options.artist || options.group) &&
      !options.paths
    ) {
      throw new MissingRequiredArgumentError(
        "--source-idx, --source-name, --artist, and --group options require --paths",
      );
    }

    // Determine destination and sources based on input method
    let destination: string;
    let pathsSourceEntries: PathEntry[] | undefined;
    let inputFile: string;

    if (options.paths) {
      // With --paths: parse YAML file for destination and sources
      if (destinationArg !== undefined) {
        throw new OptionConflictError(
          "--paths",
          "destination argument",
          "With --paths option, do not provide destination argument (it comes from the YAML file)",
        );
      }

      const result = await loadAndValidatePathsYaml({
        pathsFile: options.paths,
        sourceIdx: options.sourceIdx,
        sourceName: options.sourceName,
        sourceArtist: options.artist,
        sourceGroup: options.group,
      });

      destination = result.destination;
      pathsSourceEntries = result.sourceEntries;
      inputFile = options.paths;

      // Auto-enable filter mode from YAML filters
      if (result.hasYamlFilters && !options.minStars && !options.minRating) {
        options.useFilterMode = true;
        logDebug(`Auto-enabled filter mode from YAML (default filter: ${result.firstFilterName})`);
      }
    } else if (options.file) {
      // With --file: destination is required
      if (destinationArg === undefined) {
        throw new MissingRequiredArgumentError(
          "With --file option, destination argument is required",
        );
      }
      destination = destinationArg;
      inputFile = options.file;
    } else {
      throw new MissingRequiredArgumentError("Either --file or --paths option is required");
    }

    // Get global options from parent command
    const globalOpts = command.parent?.opts() ?? {};
    const globalDryRun = Boolean(globalOpts["dryRun"]);

    // Build CopyOptions from raw CLI options
    const copyOptions = buildCopyOptions(options, globalDryRun);

    // If using --paths, set the source entries on copyOptions
    if (pathsSourceEntries) {
      copyOptions.cliSourceEntries = pathsSourceEntries;
    }

    // Determine deleteDowngraded: CLI > config > default (true)
    const copyConfig = getLoadedConfig().copy ?? {};
    const deleteDowngraded = options.deleteDowngraded ?? copyConfig.deleteDowngraded ?? true;

    // Build SyncOptions
    const syncOptions: SyncOptions = {
      copyOptions,
      dryRun: globalDryRun,
      force: options.force ?? false,
      resetInventory: options.resetInventory ?? false,
      deleteDowngraded,
    };

    // If conversion is requested, verify ffmpeg is available
    if (copyOptions.convertFormat) {
      await requireFfmpeg();
    }

    // Lazy load action handler
    const { executeSyncWithFileInput } = await import("../actions/sync.js");
    const result = await executeSyncWithFileInput(destination, syncOptions);

    // Build JSON output
    const jsonOutput: SyncJsonOutput = {
      command: "sync",
      mode: copyOptions.mode.type,
      inputFile,
      destination,
      result: {
        sourcesScanned: result.sourcesScanned,
        newFilesCopied: result.newFilesCopied,
        updatedFilesCopied: result.updatedFilesCopied,
        unchangedFilesSkipped: result.unchangedFilesSkipped,
        deletedFiles: result.deletedFiles,
        failedFiles: result.failedFiles,
        failed: result.failed,
      },
    };

    const format = globalOpts?.["output"] ?? "text";
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(format, jsonOutput);
    }

    // Exit with error code if any operations failed
    if (result.failedFiles > 0) {
      process.exitCode = 1;
    }
  });
