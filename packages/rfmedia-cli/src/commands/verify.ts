/**
 * Verify command definition for rfmedia CLI.
 *
 * This module defines the verify command which operates in two mutually exclusive modes:
 * - Album mode: Verifies numbered album copies exist (--range)
 * - Filter mode: Verifies rating-filtered tracks exist (--min-stars/--min-rating)
 */

import os from "node:os";
import { Command, Option } from "commander";
import { Table } from "console-table-printer";
import { parseRange, tryParseRange, isValidRange } from "../lib/range.js";
import { parseDuration } from "../lib/ratings.js";
import { logDebug, logInfo, logSuccess, logWarn } from "../lib/logger.js";
import { isMachineFormat, type OutputFormat } from "@rfmedia/common";
import { getDefaultWorkers, validateWorkers } from "../lib/parallel.js";
import { getValidFormats, isValidConvertFormat } from "../lib/convert.js";
import { resolveUndoDatabasePath } from "../lib/config.js";
import { hasUnresolvedVerificationProblems } from "../lib/tiered-verification.js";
import { getLoadedConfig } from "../cli.js";
import type {
  VerifyOptions,
  CopyMode,
  RatingFilter,
  CopyRange,
  VerifyCommandResult,
  ConvertFormat,
  PathEntry,
  ConflictStrategy,
  VerificationTier,
  VerifiedFile,
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
 * JSON output structure for verify command.
 */
export interface VerifyStructuredOutput {
  command: "verify";
  mode: "album" | "filter";
  tier: VerificationTier;
  status: "complete" | "incomplete";
  source: string;
  destination: string;
  result: {
    verified: number;
    missing: number;
    sizeMismatch: number;
    metadataMismatch: number;
    hashMismatch: number;
    contentMismatch: number;
    unverifiable: number;
    notApplicable: number;
    unstable: number;
    extra: number;
    expectedTotal: number;
    issues: VerifiedFile[];
    failed: Array<{ path: string; message: string; code?: string }>;
    fixResults?: {
      copiedFiles: number;
      removedFiles: number;
      failedFixes: number;
      repairedFiles: number;
      reverifiedFiles: number;
      refusedFiles: number;
      remainingIssues: number;
    };
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

function sanitizeIssue(issue: VerifiedFile): VerifiedFile {
  return {
    path: issue.path,
    status: issue.status,
    ...(issue.sourcePath !== undefined && { sourcePath: issue.sourcePath }),
    ...(issue.reason !== undefined && { reason: issue.reason }),
    ...(issue.evidence !== undefined && { evidence: issue.evidence }),
    ...(issue.expectedSize !== undefined && { expectedSize: issue.expectedSize }),
    ...(issue.actualSize !== undefined && { actualSize: issue.actualSize }),
  };
}

/** Builds the additive structured verification contract without carrying raw digest fields. */
export function createVerifyOutput(
  mode: "album" | "filter",
  destination: string,
  result: VerifyCommandResult,
  source: string = result.source,
): VerifyStructuredOutput {
  return {
    command: "verify",
    mode,
    tier: result.tier,
    status: hasUnresolvedVerificationProblems(result) ? "incomplete" : "complete",
    source,
    destination,
    result: {
      verified: result.verified,
      missing: result.missing,
      sizeMismatch: result.sizeMismatch,
      metadataMismatch: result.metadataMismatch,
      hashMismatch: result.hashMismatch,
      contentMismatch: result.contentMismatch,
      unverifiable: result.unverifiable,
      notApplicable: result.notApplicable,
      unstable: result.unstable,
      extra: result.extra,
      expectedTotal: result.expectedTotal,
      issues: result.issues.map(sanitizeIssue),
      failed: result.failed.map((failure) => ({
        path: failure.path,
        message: failure.message,
        ...(failure.code !== undefined && { code: failure.code }),
      })),
      ...(result.fixResults && {
        fixResults: {
          copiedFiles: result.fixResults.copiedFiles,
          removedFiles: result.fixResults.removedFiles,
          failedFixes: result.fixResults.failedFixes.length,
          repairedFiles: result.fixResults.repairedFiles,
          reverifiedFiles: result.fixResults.reverifiedFiles,
          refusedFiles: result.fixResults.refusedFiles,
          remainingIssues: result.fixResults.remainingIssues,
        },
      }),
    },
  };
}

/** Returns a flat projection for table/CSV while retaining nested JSON/YAML compatibility. */
export function projectVerifyOutput(
  format: OutputFormat,
  output: VerifyStructuredOutput,
): VerifyStructuredOutput | Record<string, unknown> {
  if (format !== "table" && format !== "csv") {
    return output;
  }

  return {
    command: output.command,
    mode: output.mode,
    tier: output.tier,
    status: output.status,
    source: output.source,
    destination: output.destination,
    verified: output.result.verified,
    missing: output.result.missing,
    sizeMismatch: output.result.sizeMismatch,
    metadataMismatch: output.result.metadataMismatch,
    hashMismatch: output.result.hashMismatch,
    contentMismatch: output.result.contentMismatch,
    unverifiable: output.result.unverifiable,
    notApplicable: output.result.notApplicable,
    unstable: output.result.unstable,
    extra: output.result.extra,
    expectedTotal: output.result.expectedTotal,
    issues: output.result.issues,
    failed: output.result.failed,
    ...(output.result.fixResults && {
      copiedFiles: output.result.fixResults.copiedFiles,
      removedFiles: output.result.fixResults.removedFiles,
      failedFixes: output.result.fixResults.failedFixes,
      repairedFiles: output.result.fixResults.repairedFiles,
      reverifiedFiles: output.result.fixResults.reverifiedFiles,
      refusedFiles: output.result.fixResults.refusedFiles,
      remainingIssues: output.result.fixResults.remainingIssues,
    }),
  };
}

function renderVerifyTable(output: Record<string, unknown>): void {
  const table = new Table({
    columns: [
      { name: "field", title: "Field" },
      { name: "value", title: "Value" },
    ],
  });
  for (const [field, value] of Object.entries(output)) {
    table.addRow({
      field,
      value: typeof value === "object" ? JSON.stringify(value) : String(value),
    });
  }
  console.error(table.render());
}

/**
 * Raw options as parsed by Commander.js before transformation.
 * These correspond to the CLI options with camelCase names.
 */
export interface RawVerifyOptions {
  range?: CopyRange;
  albumOnly?: boolean;
  file?: string;
  minStars?: number;
  minRating?: number;
  outputFolder?: string;
  preserveStructure?: boolean;
  albumMode?: boolean;
  workers?: number;
  convert?: string;
  progress?: boolean;
  verifySize?: boolean;
  quick?: boolean;
  deep?: boolean;
  trackingDatabase?: string;
  // Fix mode options
  fix?: boolean;
  force?: boolean;
  trash?: boolean;
  conflictStrategy?: string;
  // Metadata filtering options (filter mode)
  minDuration?: string; // Raw MM:SS string from CLI
  maxDuration?: string; // Raw MM:SS string from CLI
  minBitrate?: number;
  codec?: string;
  minPlays?: number;
}

/**
 * Determines whether album mode options are present (CLI, config, or --file with potential per-path ranges).
 *
 * When --file is provided, we allow album mode to be determined later since
 * per-path ranges in the file can satisfy the range requirement.
 */
function hasAlbumModeOptions(
  options: RawVerifyOptions,
  hasCliSourceEntries: boolean = false,
): boolean {
  const copyConfig = getLoadedConfig().copy ?? {};
  // Album mode if:
  // 1. CLI --range provided
  // 2. config.range is set
  // 3. --file is provided (per-path ranges may exist in the file)
  // 4. CLI source entries provided (may have per-path ranges)
  return (
    options.range !== undefined ||
    copyConfig.range !== undefined ||
    options.file !== undefined ||
    hasCliSourceEntries
  );
}

/**
 * Determines whether filter mode options are present (CLI or config).
 */
function hasFilterModeOptions(options: RawVerifyOptions): boolean {
  const copyConfig = getLoadedConfig().copy ?? {};
  return (
    options.minStars !== undefined ||
    options.minRating !== undefined ||
    copyConfig.minStars !== undefined ||
    copyConfig.minRating !== undefined
  );
}

const TIER_DESCRIPTIONS: Readonly<Record<VerificationTier, string>> = {
  quick: "quick (metadata only; no content reads)",
  default: "default (stored destination SHA-256)",
  deep: "deep (stored SHA-256 plus applicable byte comparison)",
};

function logVerificationSelection(tier: VerificationTier): void {
  logInfo(`Verification tier: ${TIER_DESCRIPTIONS[tier]}`);
}

function logVerificationSummary(output: VerifyStructuredOutput): void {
  const result = output.result;
  logInfo(`Tier: ${TIER_DESCRIPTIONS[output.tier]}`);
  logInfo(
    "Outcomes: " +
      [
        `verified=${result.verified}`,
        `missing=${result.missing}`,
        `size-mismatch=${result.sizeMismatch}`,
        `metadata-mismatch=${result.metadataMismatch}`,
        `hash-mismatch=${result.hashMismatch}`,
        `content-mismatch=${result.contentMismatch}`,
        `unverifiable=${result.unverifiable}`,
        `not-applicable=${result.notApplicable}`,
        `unstable=${result.unstable}`,
        `extra=${result.extra}`,
        `failed=${result.failed.length}`,
      ].join(", "),
  );
  if (output.status === "complete") {
    logSuccess("Tier status: COMPLETE");
  } else {
    logWarn("Tier status: INCOMPLETE");
  }
}

/**
 * Constructs VerifyOptions from raw CLI options.
 *
 * Merges values from config file with CLI options. CLI options take precedence.
 *
 * @param rawOptions - Raw options from Commander.js
 * @param globalDryRun - Dry-run flag from global options
 * @param hasCliSourceEntries - Whether CLI source entries are provided (enables album mode)
 * @returns Fully constructed VerifyOptions
 * @throws Error if neither mode nor both modes are specified
 */
export function buildVerifyOptions(
  rawOptions: RawVerifyOptions,
  globalDryRun: boolean,
  hasCliSourceEntries: boolean = false,
  resolveTrackingDatabase: typeof resolveUndoDatabasePath = resolveUndoDatabasePath,
): VerifyOptions {
  const loadedConfig = getLoadedConfig();
  const copyConfig = loadedConfig.copy ?? {};

  const hasAlbumMode = hasAlbumModeOptions(rawOptions, hasCliSourceEntries);
  const hasFilterMode = hasFilterModeOptions(rawOptions);

  // Validate that exactly one mode is specified
  if (!hasAlbumMode && !hasFilterMode) {
    throw new Error(
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

  let mode: CopyMode;

  // Filter mode takes precedence when both --range and filter options are specified
  if (hasFilterMode) {
    // Use CLI value ?? config value for rating thresholds
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
    };
    mode = {
      type: "filter",
      rating: ratingFilter,
    };
  } else {
    // Album mode: use CLI range if provided, otherwise use config range
    const effectiveRange = rawOptions.range ?? configRange;

    if (!effectiveRange && !rawOptions.file && !hasCliSourceEntries) {
      // No range available and no file input or CLI source entries (can't have per-path ranges)
      throw new Error(
        'Album mode requires a range. Specify --range=START-END or set "range" in config file.',
      );
    }

    // When using --file or CLI source entries without CLI/config range, create a placeholder mode
    // The actual range will be determined per-path in the action
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
      const validFormats = getValidFormats().join(", ");
      throw new Error(
        `Invalid conversion format: '${convertValue}'. ` + `Valid formats are: ${validFormats}`,
      );
    }
    convertFormat = convertValue;
    logDebug(`Expected audio conversion format: ${convertFormat}`);
  }

  // Validate and parse conflict strategy
  const validStrategies = ["skip", "overwrite", "rename", "ask"] as const;
  let conflictStrategy: ConflictStrategy | undefined;
  if (rawOptions.conflictStrategy) {
    if (!validStrategies.includes(rawOptions.conflictStrategy as ConflictStrategy)) {
      throw new Error(
        `Invalid conflict strategy: '${rawOptions.conflictStrategy}'. ` +
          `Valid strategies are: ${validStrategies.join(", ")}`,
      );
    }
    conflictStrategy = rawOptions.conflictStrategy as ConflictStrategy;
    logDebug(`Conflict resolution strategy: ${conflictStrategy}`);
  }

  const tier: VerificationTier = rawOptions.quick ? "quick" : rawOptions.deep ? "deep" : "default";
  const trackingDatabase =
    tier === "quick"
      ? undefined
      : (rawOptions.trackingDatabase ?? resolveTrackingDatabase(loadedConfig));

  return {
    mode,
    tier,
    albumOnly: rawOptions.albumOnly ?? copyConfig.albumOnly ?? false,
    convertFormat,
    dryRun: globalDryRun,
    workers,
    file: rawOptions.file,
    trackingDatabase,
    progress: rawOptions.progress ?? copyConfig.progress,
    verifySize: rawOptions.verifySize,
    fix: rawOptions.fix ?? false,
    force: rawOptions.force ?? false,
    trash: rawOptions.trash ?? false,
    conflictStrategy,
    cliRange, // Track CLI --range for per-path range precedence
    configRange, // Config default range as fallback
  };
}

/**
 * Verify command for verifying music album copies or filtered tracks.
 */
export const verifyCommand = new Command("verify")
  .description(
    "Verify music copies using stored destination SHA-256 by default; select quick metadata or deep comparison explicitly",
  )
  .argument(
    "<paths...>",
    "Source and destination paths. " +
      "With --file: <destination> only. " +
      "Without --file: <source1> [<source2> ...] <destination>. " +
      "Sources may include optional ranges: <path>,<START-END> (e.g., /music/Album,001-003)",
  )
  // Album mode options
  .addOption(
    new Option("-r, --range <START-END>", "Range of suffixes to verify (e.g., 001-010)").argParser(
      parseRange,
    ),
  )
  .addOption(new Option("--album-only", "Treat source as single album (not artist folder)"))
  .addOption(new Option("--file <path>", "Read source paths from file"))
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
  .addOption(new Option("--preserve-structure", "Expect album subfolders in output"))
  .addOption(
    new Option(
      "--album-mode",
      "Verify album folders with only liked tracks (range applies to albums)",
    ),
  )
  // Metadata filtering options (filter mode)
  .addOption(new Option("--min-duration <MM:SS>", "Minimum track duration (filter mode)"))
  .addOption(new Option("--max-duration <MM:SS>", "Maximum track duration (filter mode)"))
  .addOption(
    new Option("--min-bitrate <kbps>", "Minimum bitrate in kbps (filter mode)").argParser(
      parseIntArg,
    ),
  )
  .addOption(new Option("--codec <format>", 'Required codec, e.g., "FLAC", "MP3" (filter mode)'))
  .addOption(
    new Option("--min-plays <N>", "Minimum play count from POPM (filter mode, MP3 only)").argParser(
      parseIntArg,
    ),
  )
  .addOption(
    new Option(
      "-w, --workers <N>",
      `Number of parallel workers (1-${MAX_WORKERS}, default: auto)`,
    ).argParser(parseIntArg),
  )
  .addOption(
    new Option(
      "-c, --convert <format>",
      "Expected conversion format in destination (alac, mp3, aac, opus)",
    ).choices(getValidFormats()),
  )
  .addOption(new Option("--progress", "Show visual progress bar with ETA"))
  .addOption(new Option("--no-progress", "Disable progress bar"))
  .addOption(
    new Option("--quick", "Metadata-only verification (no database or content reads)").conflicts(
      "deep",
    ),
  )
  .addOption(
    new Option(
      "--deep",
      "Stored SHA-256 verification plus applicable source/destination byte comparison",
    ).conflicts("quick"),
  )
  .addOption(
    new Option(
      "--tracking-database <path>",
      "Existing SQLite tracking database for default/deep fingerprint evidence",
    ),
  )
  .addOption(new Option("--verify-size", "Verify file sizes match between source and destination"))
  .addOption(new Option("--no-verify-size", "Skip file size verification (default)"))
  .addOption(
    new Option(
      "--fix",
      "Automatically fix discrepancies (re-copy missing files, remove extra files)",
    ),
  )
  .addOption(new Option("--force", "Skip confirmation prompts when fixing (use with --fix)"))
  .addOption(
    new Option(
      "--trash",
      "Move extra files to trash instead of permanent deletion (use with --fix)",
    ),
  )
  .addOption(
    new Option("--conflict-strategy <strategy>", "How to handle file conflicts during fix")
      .choices(["skip", "overwrite", "rename", "ask"])
      .default("ask"),
  )
  .action(async (paths: string[], options: RawVerifyOptions, command: Command) => {
    // Parse source and destination from paths array based on --file usage
    let sourceEntries: PathEntry[] | undefined;
    let destination: string;

    if (options.file) {
      // With --file: paths should be just [destination]
      if (paths.length !== 1) {
        throw new Error("With --file option, provide only the destination path");
      }
      sourceEntries = undefined; // Will be read from file
      destination = paths[0]!;
    } else {
      // Without --file: paths should be [source1, source2, ..., destination]
      if (paths.length < 2) {
        throw new Error("Without --file option, provide at least <source> and <destination> paths");
      }

      // Last path is destination (cannot have range suffix)
      destination = paths[paths.length - 1]!;

      // Validate destination doesn't have range suffix
      if (hasRangeSuffix(destination)) {
        throw new Error(
          "Destination path cannot have a range suffix (found comma-separated range). " +
            "Did you mean to put the range on a source path instead?",
        );
      }

      // All other paths are sources (may have range suffixes)
      const sourcePaths = paths.slice(0, -1);

      // Parse each source path for optional range suffix
      sourceEntries = sourcePaths.map(parsePathWithRange);
    }

    // Get global options from parent command
    const globalOpts = command.parent?.opts() ?? {};
    const globalDryRun = Boolean(globalOpts["dryRun"]);

    // Build fully typed VerifyOptions from raw CLI options and add CLI source entries if present
    const hasCliSourceEntries = sourceEntries !== undefined && sourceEntries.length > 0;
    let verifyOptions = buildVerifyOptions(options, globalDryRun, hasCliSourceEntries);
    if (hasCliSourceEntries) {
      verifyOptions = {
        ...verifyOptions,
        cliSourceEntries: sourceEntries,
      };
    }

    const format = (globalOpts["output"] ?? "text") as OutputFormat;
    if (!isMachineFormat(format)) {
      logVerificationSelection(verifyOptions.tier);
    }

    // Dispatch to appropriate action handler based on mode type
    // Lazy load action handlers to improve startup time
    let result: VerifyCommandResult;

    // Pass undefined as source when we have CLI source entries
    const sourcePath = sourceEntries && sourceEntries.length > 0 ? undefined : undefined;

    if (verifyOptions.mode.type === "album") {
      // Album mode: verify numbered album copies
      const { executeAlbumVerifyWithFileInput } = await import("../actions/verify-album.js");
      result = await executeAlbumVerifyWithFileInput(sourcePath, destination, verifyOptions);
    } else {
      // Filter mode: verify filtered tracks exist
      const { executeFilterVerifyWithFileInput } = await import("../actions/verify-filter.js");
      result = await executeFilterVerifyWithFileInput(sourcePath, destination, verifyOptions);
    }

    const outputSource =
      options.file ??
      (sourceEntries && sourceEntries.length === 1 ? sourceEntries[0]!.path : result.source);
    const structuredOutput = createVerifyOutput(
      verifyOptions.mode.type,
      destination,
      result,
      outputSource,
    );

    if (!isMachineFormat(format)) {
      logVerificationSummary(structuredOutput);
    }
    const projectedOutput = projectVerifyOutput(format, structuredOutput);
    if (format === "table") {
      renderVerifyTable(projectedOutput as Record<string, unknown>);
    } else if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(format, projectedOutput);
    }

    if (hasUnresolvedVerificationProblems(result)) {
      process.exitCode = 1;
    }
  });
