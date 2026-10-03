/**
 * Copy command definition for rfmedia CLI.
 *
 * This module defines the copy command which operates in two mutually exclusive modes:
 * - Album mode: Copies entire albums with numbered suffixes (--range)
 * - Filter mode: Copies tracks meeting a rating threshold (--min-stars/--min-rating)
 */

import os from "node:os";
import path from "node:path";
import { Command, Option } from "commander";
import {
  parseRange,
  tryParseRange,
  isValidRange,
  detectHighestSuffix,
  buildAutoRange,
  formatRange,
} from "../lib/range.js";
import { parseDuration } from "../lib/ratings.js";
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
import { loadCopyInteractiveSelection } from "../lib/interactive-loader.js";
import { shouldShowInteractiveSelection } from "../lib/interactive-check.js";
import { getInteractiveConfig } from "../lib/config.js";
import type {
  CopyOptions,
  CopyMode,
  RatingFilter,
  CopyRange,
  CopyResult,
  ConvertFormat,
  PathEntry,
  SmartFilter,
  ConflictStrategy,
} from "../types/index.js";

/**
 * Parses a path string that may include an optional range suffix.
 *
 * Format: "path,START-END" (e.g., "/music/Artist/Album,001-005")
 * Uses the same comma delimiter logic as file-based input.
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
 *
 * @param pathString - Path string to check
 * @returns True if the path has a valid range suffix
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
 * Extracts the artist name from a source path based on albumOnly mode.
 *
 * @param sourcePath - Source path to extract artist name from
 * @param albumOnly - Whether the source is a single album (true) or artist folder (false)
 * @returns Artist name (directory name)
 */
function extractArtistName(sourcePath: string, albumOnly: boolean): string {
  if (albumOnly) {
    // Source is album folder, artist is parent directory
    return path.basename(path.dirname(sourcePath));
  }
  // Source is artist folder
  return path.basename(sourcePath);
}

/**
 * JSON output structure for copy command.
 */
interface CopyJsonOutput {
  command: "copy";
  mode: "album" | "filter";
  source: string;
  destination: string;
  result: {
    created: number;
    skipped: number;
    filtered?: number;
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
 * Used as argParser for numeric options.
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
 * These correspond to the CLI options with camelCase names.
 */
interface RawCopyOptions {
  range?: CopyRange;
  count?: number;
  albumOnly?: boolean;
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
  trackCompleted?: boolean;
  completedFile?: string;
  resetCompleted?: boolean;
  trackingDatabase?: string;
  useLegacyTracking?: boolean;
  plexScan?: boolean;
  plexUrl?: string;
  plexToken?: string;
  plexLibrary?: string;
  plexPerSource?: boolean;
  // Metadata filtering options (filter mode)
  minDuration?: string; // Raw MM:SS string from CLI
  maxDuration?: string; // Raw MM:SS string from CLI
  minBitrate?: number;
  codec?: string;
  minPlays?: number;
  // Disk space options
  requireSpace?: boolean;
  // Smart filter option
  filter?: string;
  // Source selection options (for --paths)
  sourceIdx?: string;
  sourceName?: string;
  artist?: string;
  group?: string;
  // Verbose preview option
  verbose?: boolean;
  // Interactive selection option
  interactive?: boolean;
  // Conflict resolution strategy
  conflictStrategy?: string;
  // Verification option
  verify?: boolean;
  // Plan/apply options
  dryRun?: boolean;
  plan?: boolean;
  planOutput?: string;
  apply?: string;
  yes?: boolean;
  forceStale?: boolean;
}

/**
 * Determines whether album mode options are present (CLI, config, or --file/--paths with potential per-path ranges).
 *
 * When --file or --paths is provided, we allow album mode to be determined later since
 * per-path ranges in the file can satisfy the range requirement.
 */
function hasAlbumModeOptions(
  options: RawCopyOptions,
  hasCliSourceEntries: boolean = false,
): boolean {
  const copyConfig = getLoadedConfig().copy ?? {};
  // Album mode if:
  // 1. CLI --range provided
  // 2. CLI --count provided
  // 3. config.range is set
  // 4. --file is provided (per-path ranges may exist in the file)
  // 5. --paths is provided (per-path ranges may exist in the YAML)
  // 6. CLI source entries provided (may have per-path ranges)
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
 * Determines whether filter mode options are present (CLI or config).
 * Includes --filter option for smart filters.
 */
function hasFilterModeOptions(options: RawCopyOptions): boolean {
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
 * Constructs CopyOptions from raw CLI options.
 *
 * Merges values from config file with CLI options. CLI options take precedence.
 *
 * @param rawOptions - Raw options from Commander.js
 * @param globalDryRun - Dry-run flag from global options
 * @param hasCliSourceEntries - Whether CLI source entries are provided (enables album mode)
 * @returns Fully constructed CopyOptions
 * @throws Error if neither mode nor both modes are specified
 */
function buildCopyOptions(
  rawOptions: RawCopyOptions,
  globalDryRun: boolean,
  hasCliSourceEntries: boolean = false,
): CopyOptions {
  const copyConfig = getLoadedConfig().copy ?? {};

  const hasAlbumMode = hasAlbumModeOptions(rawOptions, hasCliSourceEntries);
  const hasFilterMode = hasFilterModeOptions(rawOptions);

  // Validate that exactly one mode is specified
  if (!hasAlbumMode && !hasFilterMode) {
    throw new MissingRequiredArgumentError(
      "Must specify either album mode (--range) or filter mode (--min-stars or --min-rating)",
    );
  }

  // Parse config range if present (for fallback when CLI range not provided)
  let configRange: CopyRange | undefined;
  if (copyConfig.range) {
    const parsed = tryParseRange(copyConfig.range);
    if (parsed === null) {
      logDebug(`Invalid range in config file: ${copyConfig.range}`);
    } else {
      configRange = parsed;
      logDebug(`Config default range: ${copyConfig.range}`);
    }
  }

  // Track CLI-provided range separately for per-path range precedence
  const cliRange = rawOptions.range;

  // Validate count if provided
  if (rawOptions.count !== undefined) {
    if (rawOptions.count < 1) {
      throw new InvalidNumericArgumentError("--count", rawOptions.count, "must be at least 1", 1);
    }
    logDebug(`Auto-range mode with count: ${rawOptions.count}`);
  }

  let mode: CopyMode;

  // Filter mode takes precedence when both --range and filter options are specified
  // This allows creating multiple numbered copies of filtered (liked) tracks
  if (hasFilterMode) {
    const config = getLoadedConfig();

    // Handle --filter option for smart filters
    let smartFilter: SmartFilter | undefined;
    let filterName: string | undefined;

    if (rawOptions.filter) {
      // Validate mutual exclusivity: --filter cannot be used with --min-stars or --min-rating
      if (rawOptions.minStars !== undefined || rawOptions.minRating !== undefined) {
        throw new OptionConflictError(
          "--filter",
          "--min-stars/--min-rating",
          "Smart filters override all legacy rating options",
        );
      }

      // Load filter from config
      const availableFilters = config.filters ?? {};
      const filterDef = availableFilters[rawOptions.filter];

      if (!filterDef) {
        const filterNames = Object.keys(availableFilters);
        throw new LookupNotFoundError(
          "filter",
          rawOptions.filter,
          filterNames,
          findClosestMatch(rawOptions.filter, filterNames),
          "No smart filters are configured in your .rfmedia.yaml file",
        );
      }

      smartFilter = filterDef;
      filterName = rawOptions.filter;
      logDebug(`Using smart filter: ${filterName}`);
    }

    // Use CLI value ?? config value for rating thresholds (ignored when smartFilter is set)
    const minStars = rawOptions.minStars ?? copyConfig.minStars;
    const minRating = rawOptions.minRating ?? copyConfig.minRating;

    // Parse duration strings to seconds (CLI > config)
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
      preserveStructure: rawOptions.preserveStructure ?? copyConfig.preserveStructure ?? false,
      range: rawOptions.range,
      albumMode: rawOptions.albumMode ?? copyConfig.albumMode ?? false,
      // Metadata filters
      minDuration,
      maxDuration,
      minBitrate: rawOptions.minBitrate ?? copyConfig.minBitrate,
      codec: rawOptions.codec ?? copyConfig.codec,
      minPlays: rawOptions.minPlays ?? copyConfig.minPlays,
      // Smart filter options
      smartFilter,
      filterName,
    };
    mode = {
      type: "filter",
      rating: ratingFilter,
    };
  } else {
    // Album mode: use CLI range if provided, otherwise use config range
    // When --file or CLI source entries are used, per-path ranges can be specified
    const effectiveRange = rawOptions.range ?? configRange;

    if (!effectiveRange && !rawOptions.file && !hasCliSourceEntries) {
      // No range available and no file input or CLI source entries (can't have per-path ranges)
      throw new MissingRequiredArgumentError(
        'Album mode requires a range. Specify --range=START-END or set "range" in config file.',
      );
    }

    // When using --file or CLI source entries without CLI/config range, create a placeholder mode
    // The actual range will be determined per-path in the action
    // Use a dummy range that will be overridden per-path
    const modeRange = effectiveRange ?? { start: 1, end: 1, padWidth: 3 };

    mode = {
      type: "album",
      range: modeRange,
    };
  }

  // Determine worker count: CLI > config > auto-detect
  const requestedWorkers = rawOptions.workers ?? copyConfig.workers ?? getDefaultWorkers();
  const workers = validateWorkers(requestedWorkers);
  logDebug(`Using ${workers} parallel workers`);

  // Validate and parse conversion format: CLI > config
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

  // Validate and extract conflict strategy
  let conflictStrategy: ConflictStrategy | undefined;
  if (rawOptions.conflictStrategy) {
    const validStrategies: ConflictStrategy[] = ["skip", "overwrite", "rename", "ask"];
    if (!validStrategies.includes(rawOptions.conflictStrategy as ConflictStrategy)) {
      throw new LookupNotFoundError(
        "conflict strategy",
        rawOptions.conflictStrategy,
        validStrategies,
        findClosestMatch(rawOptions.conflictStrategy, validStrategies),
      );
    }
    conflictStrategy = rawOptions.conflictStrategy as ConflictStrategy;
    logDebug(`Conflict resolution strategy: ${conflictStrategy}`);
  }

  return {
    mode,
    albumOnly: rawOptions.albumOnly ?? copyConfig.albumOnly ?? false,
    hardlink: rawOptions.hardlink ?? copyConfig.hardlink ?? false,
    convertFormat,
    force: rawOptions.force ?? copyConfig.force ?? false,
    conflictStrategy,
    dryRun: globalDryRun,
    workers,
    file: rawOptions.file,
    paths: rawOptions.paths,
    progress: rawOptions.progress ?? copyConfig.progress,
    trackCompleted: rawOptions.trackCompleted ?? copyConfig.trackCompleted,
    completedFile: rawOptions.completedFile,
    resetCompleted: rawOptions.resetCompleted,
    trackingDatabase: rawOptions.trackingDatabase,
    useLegacyTracking: rawOptions.useLegacyTracking,
    plexScan: rawOptions.plexScan,
    plexUrl: rawOptions.plexUrl,
    plexToken: rawOptions.plexToken,
    plexLibrary: rawOptions.plexLibrary,
    plexPerSource: rawOptions.plexPerSource,
    requireDiskSpace: rawOptions.requireSpace ?? copyConfig.requireDiskSpace,
    cliRange, // Track CLI --range for per-path range precedence
    configRange, // Config default range as fallback
    count: rawOptions.count, // Auto-range mode: number of copies to create
    verbose: rawOptions.verbose, // Show detailed file-level preview in dry-run mode
    verify: rawOptions.verify ?? copyConfig.verify ?? false,
  };
}

/**
 * Copy command for copying music albums or filtered tracks.
 */
export const copyCommand = new Command("copy")
  .description("Copy music albums with numbered suffixes or filter tracks by rating")
  .argument(
    "[paths...]",
    "Source and destination paths. " +
      "With --paths: not required (read from YAML). " +
      "With --file: <destination> only. " +
      "Without --file/--paths: <source1> [<source2> ...] <destination>. " +
      "Sources may include optional ranges: <path>,<START-END> (e.g., /music/Album,001-003)",
  )
  // Album mode options
  .addOption(
    new Option("-r, --range <START-END>", "Range of suffixes to create (e.g., 001-010)").argParser(
      parseRange,
    ),
  )
  .addOption(
    new Option("--count <N>", "Number of copies to create (auto-detects next range)")
      .argParser(createIntArgParser("--count"))
      .conflicts("range"),
  )
  .addOption(new Option("--album-only", "Treat source as single album (not artist folder)"))
  .addOption(new Option("--hardlink", "Use hardlinks instead of file copies"))
  .addOption(new Option("--force", "Overwrite existing copies even if complete"))
  .addOption(
    new Option("--conflict-strategy <strategy>", "How to handle file conflicts")
      .choices(["skip", "overwrite", "rename", "ask"])
      .default("ask"),
  )
  .addOption(new Option("--file <path>", "Read source paths from file").conflicts("paths"))
  .addOption(
    new Option(
      "--paths <file>",
      "Read paths from YAML file (includes destination and sources)",
    ).conflicts("file"),
  )
  // Filter mode options
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
  .addOption(
    new Option(
      "--album-mode",
      "Preserve album folders with only liked tracks (range applies to albums)",
    ),
  )
  // Metadata filtering options (filter mode)
  .addOption(new Option("--min-duration <MM:SS>", "Minimum track duration (filter mode)"))
  .addOption(new Option("--max-duration <MM:SS>", "Maximum track duration (filter mode)"))
  .addOption(
    new Option("--min-bitrate <kbps>", "Minimum bitrate in kbps (filter mode)").argParser(
      createIntArgParser("--min-bitrate"),
    ),
  )
  .addOption(new Option("--codec <format>", 'Required codec, e.g., "FLAC", "MP3" (filter mode)'))
  .addOption(
    new Option("--min-plays <N>", "Minimum play count from POPM (filter mode, MP3 only)").argParser(
      createIntArgParser("--min-plays"),
    ),
  )
  .addOption(
    new Option(
      "-w, --workers <N>",
      `Number of parallel workers (1-${MAX_WORKERS}, default: auto)`,
    ).argParser(createIntArgParser("--workers")),
  )
  .addOption(
    new Option(
      "-c, --convert <format>",
      "Convert audio files to format (alac, mp3, aac, opus)",
    ).choices(getValidFormats()),
  )
  .addOption(new Option("--progress", "Show visual progress bar with ETA"))
  .addOption(new Option("--no-progress", "Disable progress bar"))
  .addOption(new Option("-v, --verbose", "Show detailed file-level preview in dry-run mode"))
  // Tracking options for idempotent operations (with --file)
  .addOption(
    new Option("--track-completed", "Track completed sources in sidecar file for resume support"),
  )
  .addOption(new Option("--no-track-completed", "Disable completed source tracking"))
  .addOption(new Option("--completed-file <path>", "Custom path for completed tracking file"))
  .addOption(new Option("--reset-completed", "Clear existing tracking and restart fresh"))
  .addOption(new Option("--tracking-database <path>", "Path to SQLite tracking database"))
  .addOption(new Option("--use-legacy-tracking", "Use legacy file-based tracking"))
  .addOption(new Option("--no-use-legacy-tracking", "Use database-backed tracking"))
  // Plex integration options
  .addOption(new Option("--plex-scan", "Trigger Plex library scan after copy"))
  .addOption(new Option("--no-plex-scan", "Disable Plex library scan"))
  .addOption(new Option("--plex-url <url>", "Plex server URL (e.g., http://localhost:32400)"))
  .addOption(new Option("--plex-token <token>", "Plex authentication token"))
  .addOption(new Option("--plex-library <name>", "Plex library name to scan (e.g., Music)"))
  .addOption(new Option("--plex-per-source", "Scan Plex after each source (not at end)"))
  // Disk space options
  .addOption(new Option("--require-space", "Abort if insufficient disk space"))
  .addOption(new Option("--no-require-space", "Skip disk space check"))
  // Smart filter option
  .addOption(new Option("--filter <name>", "Use named smart filter from config"))
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
  // Interactive selection option
  .addOption(new Option("-i, --interactive", "Interactively select sources and albums/tracks"))
  // Verification option
  .addOption(new Option("--verify", "Verify file integrity after copy (SHA-256 checksum)"))
  .addOption(new Option("--no-verify", "Disable file integrity verification"))
  // Dry-run option (fixes pre-existing bug: cli.ts never defines a global --dry-run,
  // so `rfmedia copy --dry-run` errored as unknown option despite README)
  .addOption(new Option("--dry-run", "Preview actions without making filesystem changes"))
  // Plan/apply options
  .addOption(
    new Option(
      "--plan",
      "Generate a reviewable plan manifest (performs a dry run; no library writes)",
    ),
  )
  .addOption(
    new Option("--plan-output <path>", "Custom output path for the plan manifest (implies --plan)"),
  )
  .addOption(new Option("--apply <planPath>", "Execute a previously saved plan"))
  .addOption(new Option("-y, --yes", "Skip apply confirmation prompt"))
  .addOption(
    new Option(
      "--force-stale",
      "Apply despite overridable staleness errors (downgraded to warnings)",
    ),
  )
  .action(async (paths: string[], options: RawCopyOptions, command: Command) => {
    // Validate source selection options require --paths
    if (
      (options.sourceIdx || options.sourceName || options.artist || options.group) &&
      !options.paths
    ) {
      throw new MissingRequiredArgumentError(
        "--source-idx, --source-name, --artist, and --group options require --paths",
      );
    }

    // Get global options from parent command (needed early for paths validation)
    const globalOpts = command.parent?.opts() ?? {};
    const globalDryRun = Boolean(globalOpts["dryRun"]);
    const effectiveDryRun = Boolean(options.dryRun) || globalDryRun;
    const planRequested = Boolean(options.plan) || options.planOutput !== undefined;

    // Conflict matrix: plan generation is exclusive with apply, dry-run,
    // interactive selection, and filter album mode (no serializable structure yet)
    if (planRequested && options.apply) {
      throw new OptionConflictError("--plan", "--apply");
    }
    if (planRequested && options.dryRun) {
      throw new OptionConflictError("--plan", "--dry-run", "--plan already performs a dry run");
    }
    if (planRequested && options.interactive) {
      throw new OptionConflictError(
        "--plan",
        "--interactive",
        "Interactive selections cannot be serialized to a plan file",
      );
    }
    if (planRequested && options.albumMode) {
      throw new OptionConflictError(
        "--plan",
        "--album-mode",
        "Filter --album-mode has no serializable dry-run structure yet",
      );
    }

    // --apply early branch: runs with ZERO positionals, so it must precede the
    // positional-input triage below (which requires <source> and <destination>)
    if (options.apply) {
      if (paths.length > 0) {
        throw new OptionConflictError(
          "--apply",
          "positional path arguments",
          "--apply executes a saved plan; do not provide sources or destination",
        );
      }
      // Allowlist: --apply is exclusive with all copy-shaping input.
      const applyCompanions = new Set([
        "apply",
        "dryRun",
        "yes",
        "forceStale",
        "progress",
        "verbose",
      ]);
      for (const opt of command.options) {
        const key = opt.attributeName(); // camelCase, matches RawCopyOptions keys
        if (applyCompanions.has(key)) continue;
        if (command.getOptionValueSource(key) === "cli") {
          throw new OptionConflictError(
            "--apply",
            opt.flags,
            "--apply replays the frozen plan options; remove copy-shaping flags",
          );
        }
      }
      const format = globalOpts?.["output"] ?? "text";
      const { executePlanApply } = await import("../actions/copy-plan.js");
      const result = await executePlanApply({
        planPath: options.apply,
        dryRun: effectiveDryRun,
        yes: options.yes ?? false,
        forceStale: options.forceStale ?? false,
        machineOutput: isMachineFormat(format),
        progress: options.progress,
        verbose: options.verbose,
      });
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, {
          command: "copy",
          result: {
            planPath: options.apply,
            applied: !effectiveDryRun,
            created: result.created,
            skipped: result.skipped,
            // Mirrors the direct-copy payload's filtered count. The apply
            // result always carries it (album-mode plans report 0) because
            // the frozen plan's mode is not surfaced at the command layer.
            filtered: result.filtered,
            failed: result.failed,
          },
        });
      }
      if (result.failed.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    // Parse source and destination based on input method: --paths, --file, or positional args
    let sourceEntries: PathEntry[] | undefined;
    let destination: string;

    if (options.paths) {
      // With --paths: parse YAML file for destination and sources
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
        dryRun: effectiveDryRun,
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
      sourceEntries = undefined; // Will be read from file
      destination = paths[0]!;
    } else {
      // Without --file/--paths: paths should be [source1, source2, ..., destination]
      if (paths.length < 2) {
        throw new MissingRequiredArgumentError(
          "Provide at least <source> and <destination> paths, or use --paths/--file",
        );
      }

      // Last path is destination (cannot have range suffix)
      destination = paths[paths.length - 1]!;

      // Validate destination doesn't have range suffix
      if (hasRangeSuffix(destination)) {
        throw new OptionConflictError(
          "destination argument",
          "range suffix",
          "Destination path cannot have a range suffix (found comma-separated range). " +
            "Put the range on a source path instead",
        );
      }

      // All other paths are sources (may have range suffixes)
      const sourcePaths = paths.slice(0, -1);

      // Parse each source path for optional range suffix
      sourceEntries = sourcePaths.map(parsePathWithRange);
    }

    // Build fully typed CopyOptions from raw CLI options and add CLI source entries if present
    const hasCliSourceEntries = sourceEntries !== undefined && sourceEntries.length > 0;
    let copyOptions = buildCopyOptions(options, effectiveDryRun, hasCliSourceEntries);
    if (hasCliSourceEntries) {
      copyOptions = {
        ...copyOptions,
        cliSourceEntries: sourceEntries,
      };
    }

    // Resolved-options validation: config copy.albumMode can enable filter album
    // mode without the CLI flag, bypassing the raw-flag conflict check above
    if (planRequested && copyOptions.mode.type === "filter" && copyOptions.mode.rating.albumMode) {
      throw new OptionConflictError(
        "--plan",
        "--album-mode",
        "Filter album mode (from CLI flag or config copy.albumMode) has no serializable dry-run structure yet",
      );
    }

    // Interactive selection: let user choose sources and albums/tracks
    // Plan generation must never pass through interactive selection: `selection`
    // is runtime-only and cannot be frozen, so the plan would execute the
    // unselected superset. Explicit --plan --interactive already errored above.
    if (!planRequested && shouldShowInteractiveSelection(options.interactive)) {
      // Validate we have source entries to select from
      if (!sourceEntries || sourceEntries.length === 0) {
        throw new MissingRequiredArgumentError(
          "--interactive requires source paths (use --paths, --file, or positional sources)",
        );
      }

      // Get interactive configuration with page sizes
      const config = getLoadedConfig();
      const interactiveConfig = getInteractiveConfig(config);

      // Track-level selection only applies in filter mode
      // In album mode, track selections are ignored (entire albums copied)
      const allowTrackSelection = copyOptions.mode.type === "filter";

      // Lazy load interactive module and run selection flow
      const selection = await loadCopyInteractiveSelection(
        sourceEntries,
        interactiveConfig,
        allowTrackSelection,
      );

      // Handle user cancellation (Ctrl+C)
      if (selection === null) {
        return;
      }

      // Filter sourceEntries to selected sources only
      sourceEntries = sourceEntries.filter((e) => selection.selectedSources.includes(e.path));

      // Update copyOptions with filtered sources and selection data
      copyOptions = {
        ...copyOptions,
        cliSourceEntries: sourceEntries,
        selection,
      };
    }

    // If conversion is requested, verify ffmpeg is available before proceeding
    if (copyOptions.convertFormat) {
      await requireFfmpeg();
    }

    // --plan branch: generate a reviewable plan manifest instead of dispatching
    if (planRequested) {
      // Freeze conflictStrategy only when explicitly passed; the Commander
      // default "ask" must not be baked into plans (breaks non-interactive apply).
      const planCopyOptions =
        command.getOptionValueSource("conflictStrategy") === "cli"
          ? copyOptions
          : { ...copyOptions, conflictStrategy: undefined };
      const { executePlanGeneration } = await import("../actions/copy-plan.js");
      const { planPath, plan } = await executePlanGeneration({
        destination,
        copyOptions: planCopyOptions,
        planOutput: options.planOutput,
      });
      const format = globalOpts?.["output"] ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, {
          command: "copy",
          result: { planPath, planId: plan.id, summary: plan.review.summary },
        });
      }
      return;
    }

    // Dispatch to appropriate action handler based on mode type
    // Lazy load action handlers to improve startup time
    let result: CopyResult;

    // Pass undefined as source when we have CLI source entries
    const sourcePath = sourceEntries && sourceEntries.length > 0 ? undefined : undefined;

    if (copyOptions.mode.type === "album") {
      // Album mode: copy entire albums with numbered suffixes
      // Use executeAlbumCopyWithFileInput which handles both single source and --file
      const { executeAlbumCopyWithFileInput } = await import("../actions/copy-album.js");
      result = await executeAlbumCopyWithFileInput(sourcePath, destination, copyOptions);
    } else {
      // Filter mode: copy tracks meeting rating threshold
      const { executeFilterCopyWithFileInput } = await import("../actions/copy-filter.js");
      result = await executeFilterCopyWithFileInput(sourcePath, destination, copyOptions);
    }

    // Common result handling: output JSON if --json flag is set
    // Build structured JSON output with command metadata
    const jsonOutput: CopyJsonOutput = {
      command: "copy",
      mode: copyOptions.mode.type,
      source:
        options.paths ??
        options.file ??
        (sourceEntries && sourceEntries.length === 1 ? sourceEntries[0]!.path : "") ??
        "",
      destination,
      result: {
        created: result.created,
        skipped: result.skipped,
        failed: result.failed,
      },
    };

    // Include filtered count only for filter mode
    if (copyOptions.mode.type === "filter") {
      jsonOutput.result.filtered = result.filtered;
    }

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
