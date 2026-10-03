/**
 * Delete command definition for rfmedia CLI.
 *
 * This module defines the delete command which removes previously copied files
 * from the destination. It operates in two mutually exclusive modes (like copy):
 * - Album mode: Deletes entire album copies with numbered suffixes (--range or --count)
 * - Filter mode: Deletes tracks/albums that were copied via rating threshold (--min-stars/--min-rating)
 *
 * Key behaviors:
 * - Reverse order processing: --count=5 deletes the 5 highest suffixes (010, 009, 008, 007, 006)
 * - Database tracking: Removes entries from completed_album_copies to allow future re-copy
 * - History support: Records deletions for potential undo via existing history system
 */

import os from "node:os";
import path from "node:path";
import { Command, Option } from "commander";
import { parseRange, tryParseRange, isValidRange } from "../lib/range.js";
import { parseDuration } from "../lib/ratings.js";
import { logDebug } from "../lib/logger.js";
import { isMachineFormat } from "@rfmedia/common";
import { getDefaultWorkers, validateWorkers } from "../lib/parallel.js";
import { getValidFormats, isValidConvertFormat } from "../lib/convert.js";
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
  DeleteOptions,
  DeleteMode,
  RatingFilter,
  CopyRange,
  DeleteResult,
  ConvertFormat,
  PathEntry,
  SmartFilter,
} from "../types/index.js";

/**
 * Parses a path string that may include an optional range suffix.
 *
 * Format: "path,START-END" (e.g., "/music/Artist/Album,001-005")
 *
 * @param pathString - Path string from CLI argument
 * @returns PathEntry with path and optional range
 */
function parsePathWithRange(pathString: string): PathEntry {
  const lastCommaIdx = pathString.lastIndexOf(",");

  if (lastCommaIdx === -1) {
    return { path: pathString };
  }

  const potentialRange = pathString.substring(lastCommaIdx + 1);

  if (isValidRange(potentialRange)) {
    const range = tryParseRange(potentialRange);
    const pathPart = pathString.substring(0, lastCommaIdx);

    if (range) {
      logDebug(`Parsed CLI path range: ${pathPart} with range ${potentialRange}`);
      return { path: pathPart, range };
    }
  }

  return { path: pathString };
}

/**
 * Checks if a path string has a range suffix.
 */
function hasRangeSuffix(pathString: string): boolean {
  const lastCommaIdx = pathString.lastIndexOf(",");

  if (lastCommaIdx === -1) {
    return false;
  }

  const potentialRange = pathString.substring(lastCommaIdx + 1);
  return isValidRange(potentialRange);
}

/**
 * JSON output structure for delete command.
 */
interface DeleteJsonOutput {
  command: "delete";
  mode: "album" | "filter";
  source: string;
  destination: string;
  result: {
    deleted: number;
    skipped: number;
    trackingRemoved: number;
    failed: Array<{ path: string; message: string; code?: string }>;
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
interface RawDeleteOptions {
  range?: CopyRange;
  count?: number;
  albumOnly?: boolean;
  file?: string;
  paths?: string;
  minStars?: number;
  minRating?: number;
  outputFolder?: string;
  albumMode?: boolean;
  workers?: number;
  convert?: string;
  progress?: boolean;
  trackingDatabase?: string;
  useLegacyTracking?: boolean;
  trash?: boolean;
  keepTracking?: boolean;
  // Metadata filtering options (filter mode)
  minDuration?: string;
  maxDuration?: string;
  minBitrate?: number;
  codec?: string;
  minPlays?: number;
  // Smart filter option
  filter?: string;
  // Source selection options (for --paths)
  sourceIdx?: string;
  sourceName?: string;
  artist?: string;
  group?: string;
  // Plex integration options
  plexScan?: boolean;
  plexUrl?: string;
  plexToken?: string;
  plexLibrary?: string;
  plexPerSource?: boolean;
  // Confirmation
  yes?: boolean;
  // Interactive selection option
  interactive?: boolean;
}

/**
 * Determines whether album mode options are present.
 */
function hasAlbumModeOptions(
  options: RawDeleteOptions,
  hasCliSourceEntries: boolean = false,
): boolean {
  const copyConfig = getLoadedConfig().copy ?? {};
  return (
    options.range !== undefined ||
    options.count !== undefined ||
    copyConfig.range !== undefined ||
    options.file !== undefined ||
    options.paths !== undefined ||
    hasCliSourceEntries
  );
}

/**
 * Determines whether filter mode options are present.
 */
function hasFilterModeOptions(options: RawDeleteOptions): boolean {
  const copyConfig = getLoadedConfig().copy ?? {};
  return (
    options.filter !== undefined ||
    options.minStars !== undefined ||
    options.minRating !== undefined ||
    copyConfig.minStars !== undefined ||
    copyConfig.minRating !== undefined
  );
}

/**
 * Constructs DeleteOptions from raw CLI options.
 */
function buildDeleteOptions(
  rawOptions: RawDeleteOptions,
  globalDryRun: boolean,
  hasCliSourceEntries: boolean = false,
): DeleteOptions {
  const copyConfig = getLoadedConfig().copy ?? {};

  const hasAlbumMode = hasAlbumModeOptions(rawOptions, hasCliSourceEntries);
  const hasFilterMode = hasFilterModeOptions(rawOptions);

  // Validate that at least one mode is specified
  if (!hasAlbumMode && !hasFilterMode) {
    throw new MissingRequiredArgumentError(
      "Must specify either album mode (--range or --count) or filter mode (--min-stars or --min-rating)",
    );
  }

  // Parse config range if present
  let configRange: CopyRange | undefined;
  if (copyConfig.range) {
    const parsed = tryParseRange(copyConfig.range);
    if (parsed !== null) {
      configRange = parsed;
      logDebug(`Config default range: ${copyConfig.range}`);
    }
  }

  // Track CLI-provided range
  const cliRange = rawOptions.range;

  // Validate count if provided
  if (rawOptions.count !== undefined) {
    if (rawOptions.count < 1) {
      throw new InvalidNumericArgumentError("--count", rawOptions.count, "must be at least 1", 1);
    }
    logDebug(`Delete count: ${rawOptions.count} (will delete highest suffixes)`);
  }

  let mode: DeleteMode;

  // Filter mode takes precedence when both --range and filter options are specified
  if (hasFilterMode) {
    const config = getLoadedConfig();

    // Handle --filter option for smart filters
    let smartFilter: SmartFilter | undefined;
    let filterName: string | undefined;

    if (rawOptions.filter) {
      if (rawOptions.minStars !== undefined || rawOptions.minRating !== undefined) {
        throw new OptionConflictError(
          "--filter",
          "--min-stars/--min-rating",
          "Smart filters override all legacy rating options",
        );
      }

      const availableFilters = config.filters ?? {};
      const filterDef = availableFilters[rawOptions.filter];

      if (!filterDef) {
        const filterNames = Object.keys(availableFilters);
        throw new LookupNotFoundError(
          "filter",
          rawOptions.filter,
          filterNames,
          findClosestMatch(rawOptions.filter, filterNames),
          undefined,
          ["Add filters to your .rfmedia.yaml file"],
        );
      }

      smartFilter = filterDef;
      filterName = rawOptions.filter;
      logDebug(`Using smart filter: ${filterName}`);
    }

    const minStars = rawOptions.minStars ?? copyConfig.minStars;
    const minRating = rawOptions.minRating ?? copyConfig.minRating;

    // Parse duration strings to seconds
    const minDuration = rawOptions.minDuration
      ? parseDuration(rawOptions.minDuration)
      : copyConfig.minDuration;
    const maxDuration = rawOptions.maxDuration
      ? parseDuration(rawOptions.maxDuration)
      : copyConfig.maxDuration;

    const ratingFilter: RatingFilter = {
      minStars,
      minRating,
      outputFolder: rawOptions.outputFolder ?? copyConfig.outputFolder ?? DEFAULT_OUTPUT_FOLDER,
      preserveStructure: copyConfig.preserveStructure ?? false,
      range: rawOptions.range,
      albumMode: rawOptions.albumMode ?? copyConfig.albumMode ?? false,
      minDuration,
      maxDuration,
      minBitrate: rawOptions.minBitrate ?? copyConfig.minBitrate,
      codec: rawOptions.codec ?? copyConfig.codec,
      minPlays: rawOptions.minPlays ?? copyConfig.minPlays,
      smartFilter,
      filterName,
    };
    mode = {
      type: "filter",
      rating: ratingFilter,
    };
  } else {
    // Album mode
    const effectiveRange = rawOptions.range ?? configRange;

    mode = {
      type: "album",
      range: effectiveRange,
    };
  }

  // Determine worker count
  const requestedWorkers = rawOptions.workers ?? copyConfig.workers ?? getDefaultWorkers();
  const workers = validateWorkers(requestedWorkers);
  logDebug(`Using ${workers} parallel workers`);

  // Validate and parse conversion format (for filename matching)
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
    logDebug(`Matching converted files: ${convertFormat}`);
  }

  return {
    mode,
    albumOnly: rawOptions.albumOnly ?? copyConfig.albumOnly ?? false,
    convertFormat,
    force: false, // Will be set by global options
    dryRun: globalDryRun,
    workers,
    file: rawOptions.file,
    progress: rawOptions.progress ?? copyConfig.progress,
    trackingDatabase: rawOptions.trackingDatabase,
    useLegacyTracking: rawOptions.useLegacyTracking,
    useTrash: rawOptions.trash ?? false,
    keepTracking: rawOptions.keepTracking ?? false,
    cliRange,
    configRange,
    count: rawOptions.count,
    // Plex options
    plexScan: rawOptions.plexScan,
    plexUrl: rawOptions.plexUrl,
    plexToken: rawOptions.plexToken,
    plexLibrary: rawOptions.plexLibrary,
    plexPerSource: rawOptions.plexPerSource,
  };
}

/**
 * Delete command for removing copied music albums or filtered tracks.
 */
export const deleteCommand = new Command("delete")
  .description("Delete previously copied albums or filtered tracks from destination")
  .argument(
    "[paths...]",
    "Source and destination paths. " +
      "With --paths: not required (read from YAML). " +
      "With --file: <destination> only. " +
      "Without --file/--paths: <source1> [<source2> ...] <destination>. " +
      "Sources may include optional ranges: <path>,<START-END>",
  )
  // Album mode options
  .addOption(
    new Option("-r, --range <START-END>", "Range of suffixes to delete (e.g., 008-010)").argParser(
      parseRange,
    ),
  )
  .addOption(
    new Option("--count <N>", "Number of copies to delete (deletes highest suffixes first)")
      .argParser(createIntArgParser("--count"))
      .conflicts("range"),
  )
  .addOption(new Option("--album-only", "Treat source as single album (not artist folder)"))
  .addOption(new Option("--file <path>", "Read source paths from file").conflicts("paths"))
  .addOption(
    new Option(
      "--paths <file>",
      "Read paths from YAML file (includes destination and sources)",
    ).conflicts("file"),
  )
  // Filter mode options
  .addOption(
    new Option(
      "--min-stars <N>",
      "Delete copies created with this star rating filter (1.0-5.0)",
    ).argParser((val) => parseFloatArg(val, "--min-stars")),
  )
  .addOption(
    new Option(
      "--min-rating <N>",
      "Delete copies created with this rating filter (0-100)",
    ).argParser(createIntArgParser("--min-rating")),
  )
  .addOption(
    new Option(
      "--output-folder <name>",
      "Output folder name that was used for filtered tracks",
    ).default(DEFAULT_OUTPUT_FOLDER),
  )
  .addOption(
    new Option(
      "--album-mode",
      "Match album folders with only liked tracks (range applies to albums)",
    ),
  )
  // Metadata filtering options (for matching which files to delete)
  .addOption(new Option("--min-duration <MM:SS>", "Match copies created with duration filter"))
  .addOption(new Option("--max-duration <MM:SS>", "Match copies created with duration filter"))
  .addOption(
    new Option("--min-bitrate <kbps>", "Match copies created with bitrate filter").argParser(
      createIntArgParser("--min-bitrate"),
    ),
  )
  .addOption(new Option("--codec <format>", "Match copies created with codec filter"))
  .addOption(
    new Option("--min-plays <N>", "Match copies created with play count filter").argParser(
      createIntArgParser("--min-plays"),
    ),
  )
  // General options
  .addOption(
    new Option(
      "-w, --workers <N>",
      `Number of parallel workers (1-${MAX_WORKERS}, default: auto)`,
    ).argParser(createIntArgParser("--workers")),
  )
  .addOption(
    new Option(
      "-c, --convert <format>",
      "Match files converted to format (alac, mp3, aac, opus)",
    ).choices(getValidFormats()),
  )
  .addOption(new Option("--progress", "Show visual progress bar"))
  .addOption(new Option("--no-progress", "Disable progress bar"))
  // Tracking options
  .addOption(new Option("--tracking-database <path>", "Path to SQLite tracking database"))
  .addOption(new Option("--use-legacy-tracking", "Use legacy file-based tracking"))
  .addOption(new Option("--no-use-legacy-tracking", "Use database-backed tracking"))
  // Delete-specific options
  .addOption(new Option("--trash", "Move to trash instead of permanent delete"))
  .addOption(
    new Option(
      "--keep-tracking",
      "Keep database tracking entries (don't allow re-copy to same paths)",
    ),
  )
  // Smart filter option
  .addOption(
    new Option("--filter <name>", "Match copies created with named smart filter from config"),
  )
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
  // Plex integration options
  .addOption(new Option("--plex-scan", "Trigger Plex library scan after delete"))
  .addOption(new Option("--no-plex-scan", "Disable Plex library scan"))
  .addOption(new Option("--plex-url <url>", "Plex server URL (e.g., http://localhost:32400)"))
  .addOption(new Option("--plex-token <token>", "Plex authentication token"))
  .addOption(new Option("--plex-library <name>", "Plex library name to scan (e.g., Music)"))
  .addOption(new Option("--plex-per-source", "Scan Plex after each source (not at end)"))
  // Force option
  .addOption(new Option("-y, --yes", "Skip confirmation prompt"))
  // Interactive selection option
  .addOption(new Option("-i, --interactive", "Interactively select album copies to delete"))
  .action(async (paths: string[], options: RawDeleteOptions, command: Command) => {
    // Validate source selection options require --paths
    if (
      (options.sourceIdx || options.sourceName || options.artist || options.group) &&
      !options.paths
    ) {
      throw new MissingRequiredArgumentError(
        "--source-idx, --source-name, --artist, and --group options require --paths",
      );
    }

    // Parse source and destination based on input method
    let sourceEntries: PathEntry[] | undefined;
    let destination: string;

    if (options.paths) {
      // With --paths: parse YAML file
      if (paths.length > 0) {
        throw new OptionConflictError(
          "--paths",
          "positional path arguments",
          "With --paths option, do not provide positional path arguments",
        );
      }

      const result = await loadAndValidatePathsYaml({
        pathsFile: options.paths,
        sourceIdx: options.sourceIdx,
        sourceName: options.sourceName,
        sourceArtist: options.artist,
        sourceGroup: options.group,
      });

      sourceEntries = result.sourceEntries;
      destination = result.destination;

      // Auto-enable filter mode from YAML filters
      if (result.hasYamlFilters && !options.filter && !options.minStars && !options.minRating) {
        options.filter = result.firstFilterName;
        logDebug(`Auto-enabled filter mode from YAML (default filter: ${result.firstFilterName})`);
      }
    } else if (options.file) {
      // With --file: paths should be just [destination]
      if (paths.length !== 1) {
        throw new MissingRequiredArgumentError(
          "With --file option, provide only the destination path",
        );
      }
      sourceEntries = undefined;
      destination = paths[0]!;
    } else {
      // Without --file/--paths: paths should be [source1, source2, ..., destination]
      if (paths.length < 2) {
        throw new MissingRequiredArgumentError(
          "Provide at least <source> and <destination> paths, or use --paths/--file",
        );
      }

      destination = paths[paths.length - 1]!;

      if (hasRangeSuffix(destination)) {
        throw new OptionConflictError(
          "destination argument",
          "range suffix",
          "Destination path cannot have a range suffix. " +
            "Put the range on a source path instead",
        );
      }

      const sourcePaths = paths.slice(0, -1);
      sourceEntries = sourcePaths.map(parsePathWithRange);
    }

    // Get global options from parent command
    const globalOpts = command.parent?.opts() ?? {};
    const globalDryRun = Boolean(globalOpts["dryRun"]);

    // Build fully typed DeleteOptions from raw CLI options
    const hasCliSourceEntries = sourceEntries !== undefined && sourceEntries.length > 0;
    let deleteOptions = buildDeleteOptions(options, globalDryRun, hasCliSourceEntries);

    // Set force from --yes flag
    deleteOptions = {
      ...deleteOptions,
      force: options.yes ?? false,
    };

    if (hasCliSourceEntries) {
      deleteOptions = {
        ...deleteOptions,
        cliSourceEntries: sourceEntries,
      };
    }

    // Interactive selection: let user choose which suffixed copies to delete
    // Import interactive utilities at the top of the action block for lazy loading
    const { shouldShowInteractiveSelection } = await import("../lib/interactive-check.js");

    if (shouldShowInteractiveSelection(options.interactive)) {
      // Validate we have source entries to scan from
      if (!sourceEntries || sourceEntries.length === 0) {
        throw new MissingRequiredArgumentError(
          "--interactive requires source paths (use --paths, --file, or positional sources)",
        );
      }

      // Get interactive config for page sizes
      const { getInteractiveConfig } = await import("../lib/config.js");
      const interactiveConfig = getInteractiveConfig(getLoadedConfig());

      // Lazy load interactive module and run selection flow
      const { loadDeleteInteractiveSelection } = await import("../lib/interactive-loader.js");
      const selection = await loadDeleteInteractiveSelection(
        sourceEntries,
        destination,
        deleteOptions.mode,
        deleteOptions.albumOnly,
        interactiveConfig,
      );

      // Handle user cancellation (Ctrl+C)
      if (selection === null) {
        return;
      }

      // Filter sourceEntries to selected sources only
      sourceEntries = sourceEntries.filter((e) => selection.selectedSources.includes(e.path));

      // Update deleteOptions with filtered sources and selection data
      deleteOptions = {
        ...deleteOptions,
        cliSourceEntries: sourceEntries,
        selection,
      };
    }

    // Dispatch to appropriate action handler based on mode type
    let result: DeleteResult;

    if (deleteOptions.mode.type === "album") {
      // Album mode: delete album copies with numbered suffixes
      const { executeAlbumDeleteWithFileInput } = await import("../actions/delete-album.js");
      result = await executeAlbumDeleteWithFileInput(undefined, destination, deleteOptions);
    } else {
      // Filter mode: delete filtered track copies
      const { executeFilterDeleteWithFileInput } = await import("../actions/delete-filter.js");
      result = await executeFilterDeleteWithFileInput(undefined, destination, deleteOptions);
    }

    // Build structured JSON output
    const jsonOutput: DeleteJsonOutput = {
      command: "delete",
      mode: deleteOptions.mode.type,
      source:
        options.paths ??
        options.file ??
        (sourceEntries && sourceEntries.length === 1 ? sourceEntries[0]!.path : "") ??
        "",
      destination,
      result: {
        deleted: result.deleted,
        skipped: result.skipped,
        trackingRemoved: result.trackingRemoved,
        failed: result.failed,
      },
    };

    const format = globalOpts?.["output"] ?? "text";
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(format, jsonOutput);
    }

    // Exit with error code if any operations failed
    if (result.failed.length > 0) {
      process.exitCode = 1;
    }
  });
