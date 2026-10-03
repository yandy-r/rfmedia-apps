/**
 * Queue command definition for rfmedia CLI.
 *
 * This module defines the queue command for managing batch copy job queues.
 * Jobs are stored persistently at ~/.rfmedia/queue.json and executed via
 * the `queue run` command.
 *
 * Subcommands:
 * - `queue add copy <source> <destination>` - Add a copy job to the queue
 * - `queue list` - List jobs in the queue
 * - `queue run` - Execute pending jobs
 * - `queue clear` - Remove jobs from the queue
 */

import os from "node:os";
import { Command, Option } from "commander";
import { isMachineFormat } from "@rfmedia/common";

import { logError, logDebug, logInfo, output } from "../lib/logger.js";
import { parseRange } from "../lib/range.js";
import { getDefaultWorkers, validateWorkers } from "../lib/parallel.js";
import { getValidFormats } from "../lib/convert.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { getInteractiveConfig } from "../lib/config.js";
import {
  loadCopyInteractiveSelection,
  loadDeleteInteractiveSelection,
} from "../lib/interactive-loader.js";
import { shouldShowInteractiveSelection } from "../lib/interactive-check.js";
import type {
  GlobalOptions,
  CopyOptions,
  CopyMode,
  CopyRange,
  RatingFilter,
  PathEntry,
} from "../types/options.js";
import type { QueueJobStatus } from "../types/queue.js";

/**
 * Maximum number of parallel workers allowed.
 */
const MAX_WORKERS = os.cpus().length;

/**
 * Default output folder name for filter mode.
 */
const DEFAULT_OUTPUT_FOLDER = "liked-songs";

/**
 * Parses a string to an integer.
 * Used as argParser for numeric options.
 *
 * @param value - String value to parse
 * @returns Parsed integer
 * @throws Error if the value is not a valid integer
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
 *
 * @param value - String value to parse
 * @param optionName - Name of the option for error messages
 * @returns Parsed float value
 * @throws Error if the value is not a valid number or out of range
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
 * Queue command - parent for subcommands.
 *
 * Manages batch job queues (copy and delete) with persistent storage at ~/.rfmedia/queue.json.
 */
export const queueCommand = new Command("queue").description(
  "Manage batch job queue (copy and delete operations)",
);

/**
 * queue add copy - Add a copy job to the queue.
 *
 * Supports both album mode (--range) and filter mode (--min-stars, --min-rating).
 */
const addCopyCommand = new Command("copy")
  .description("Add a copy job to the queue")
  .argument("[source]", "Source path (required unless --paths is used)")
  .argument("[destination]", "Destination path (required unless --paths is used)")
  // Album mode options
  .addOption(
    new Option("-r, --range <START-END>", "Range of suffixes to create (e.g., 001-010)").argParser(
      parseRange,
    ),
  )
  .addOption(
    new Option("--count <N>", "Number of copies to create (auto-detects next range)")
      .argParser(parseIntArg)
      .conflicts("range"),
  )
  .addOption(new Option("--album-only", "Treat source as single album"))
  .addOption(new Option("--hardlink", "Use hardlinks instead of copies"))
  .addOption(new Option("--force", "Overwrite existing copies"))
  .addOption(new Option("--file <path>", "Read source paths from file").conflicts("paths"))
  .addOption(new Option("--paths <file>", "Read sources from YAML paths file").conflicts("file"))
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
  // Filter mode options
  .addOption(
    new Option("--min-stars <N>", "Minimum star rating (1.0-5.0)").argParser((val) =>
      parseFloatArg(val, "--min-stars"),
    ),
  )
  .addOption(new Option("--min-rating <N>", "Minimum rating (0-100)").argParser(parseIntArg))
  .addOption(
    new Option("--output-folder <name>", "Folder name for filtered tracks").default(
      DEFAULT_OUTPUT_FOLDER,
    ),
  )
  .addOption(new Option("--preserve-structure", "Keep album subfolders in output"))
  .addOption(new Option("--album-mode", "Preserve album folders with only liked tracks"))
  // Interactive selection option
  .addOption(new Option("-i, --interactive", "Interactively select sources"))
  // Common options
  .addOption(
    new Option("-w, --workers <N>", `Number of parallel workers (1-${MAX_WORKERS})`).argParser(
      parseIntArg,
    ),
  )
  .addOption(
    new Option("-c, --convert <format>", "Convert audio files to format").choices(
      getValidFormats(),
    ),
  )
  .addOption(new Option("--progress", "Show visual progress bar"))
  // Plex options
  .addOption(new Option("--plex-scan", "Trigger Plex scan after completion"))
  .addOption(new Option("--plex-library <name>", "Plex library name to scan"))
  .action(
    async (
      source: string | undefined,
      destination: string | undefined,
      cmdOptions: Record<string, unknown>,
    ) => {
      const globalOpts = queueCommand.parent?.opts() as GlobalOptions | undefined;
      const dryRun = Boolean(globalOpts?.dryRun);

      try {
        // Validate --paths conflicts with positional source argument
        const hasPathsOption = cmdOptions["paths"] !== undefined;
        if (hasPathsOption && source !== undefined) {
          throw new Error("--paths cannot be used with positional source argument");
        }

        // Validate selection options require --paths
        const hasSelectionOptions =
          cmdOptions["sourceIdx"] !== undefined ||
          cmdOptions["sourceName"] !== undefined ||
          cmdOptions["artist"] !== undefined ||
          cmdOptions["group"] !== undefined;
        if (hasSelectionOptions && !hasPathsOption) {
          throw new Error(
            "Selection options (--source-idx, --source-name, --artist, --group) require --paths. " +
              "Please provide a YAML paths file with --paths to use source filtering.",
          );
        }

        // Variables that may be set from YAML
        let sourceEntries: PathEntry[] | undefined;
        let effectiveDestination: string;
        let effectiveSource: string;
        let hasYamlFilters = false;
        let firstFilterName: string | undefined;
        let copySelection: import("../types/options.js").CopySelection | undefined;

        if (hasPathsOption) {
          // Load and validate YAML paths file
          const { loadAndValidatePathsYaml } = await import("../lib/paths-yaml.js");
          const result = await loadAndValidatePathsYaml({
            pathsFile: cmdOptions["paths"] as string,
            sourceIdx: cmdOptions["sourceIdx"] as string | undefined,
            sourceName: cmdOptions["sourceName"] as string | undefined,
            sourceArtist: cmdOptions["artist"] as string | undefined,
            sourceGroup: cmdOptions["group"] as string | undefined,
            dryRun,
          });

          sourceEntries = result.sourceEntries;
          effectiveDestination = result.destination;
          effectiveSource = sourceEntries[0]?.path ?? "";
          hasYamlFilters = result.hasYamlFilters;
          firstFilterName = result.firstFilterName;

          logDebug(
            `Loaded ${sourceEntries.length} source(s) from YAML, destination: ${effectiveDestination}`,
          );
        } else {
          // Validate required arguments when not using --paths
          if (source === undefined || destination === undefined) {
            throw new Error("Source and destination are required unless --paths is used");
          }
          effectiveSource = source;
          effectiveDestination = destination;
        }

        // Handle --file option for plain text file input
        if (cmdOptions["file"] !== undefined && !hasPathsOption) {
          const { readSourcePaths } = await import("../lib/input-file.js");
          const fileEntries = await readSourcePaths(cmdOptions["file"] as string);
          if (fileEntries.length === 0) {
            throw new Error(`No valid paths found in file: ${cmdOptions["file"]}`);
          }
          sourceEntries = fileEntries;
          logDebug(`Loaded ${sourceEntries.length} source(s) from file`);
        }

        // Interactive selection: let user choose sources
        if (shouldShowInteractiveSelection(cmdOptions["interactive"] as boolean | undefined)) {
          // Validate we have source entries to select from
          if (!sourceEntries || sourceEntries.length === 0) {
            throw new Error(
              "--interactive requires multiple sources (use --paths or --file). " +
                "Interactive selection filters which sources to include in the queue job.",
            );
          }

          // Get interactive config for page sizes
          const config = getLoadedConfig();
          const interactiveConfig = getInteractiveConfig(config);

          // Build a temporary mode for interactive selection (needed for selection level choice)
          // The mode type determines whether album or track-level selection is offered
          const tempMode: import("../types/options.js").CopyMode =
            cmdOptions["minStars"] !== undefined ||
            cmdOptions["minRating"] !== undefined ||
            hasYamlFilters
              ? {
                  type: "filter",
                  rating: {
                    minStars: cmdOptions["minStars"] as number | undefined,
                    outputFolder: DEFAULT_OUTPUT_FOLDER,
                    preserveStructure: false,
                  },
                }
              : { type: "album", range: { start: 1, end: 1, padWidth: 3 } };

          // Track-level selection only applies in filter mode
          // In album mode, track selections are ignored (entire albums queued)
          const allowTrackSelection = tempMode.type === "filter";

          // Use lazy loader for interactive selection
          const selection = await loadCopyInteractiveSelection(
            sourceEntries,
            interactiveConfig,
            allowTrackSelection,
          );

          // Handle user cancellation (Ctrl+C)
          if (selection === null) {
            logInfo("Selection cancelled");
            return;
          }

          // Filter sourceEntries to selected sources only
          sourceEntries = sourceEntries.filter((e) => selection.selectedSources.includes(e.path));

          if (sourceEntries.length === 0) {
            throw new Error("No sources selected. Use space to select items, then press enter.");
          }

          output(
            `Selected ${sourceEntries.length} source(s), ${tempMode.type} mode${firstFilterName ? ` (${firstFilterName})` : ""}`,
          );

          // Store selection for database serialization
          copySelection = selection;
        }

        // Build CopyOptions from CLI options
        const copyConfig = getLoadedConfig()?.copy ?? {};

        // Determine mode - hasPathsOption with YAML filters can auto-enable filter mode
        const hasAlbumMode =
          cmdOptions["range"] !== undefined ||
          cmdOptions["count"] !== undefined ||
          cmdOptions["file"] !== undefined;
        const hasFilterMode =
          cmdOptions["minStars"] !== undefined || cmdOptions["minRating"] !== undefined;

        // Auto-enable filter mode from YAML filters when no explicit mode is specified
        const shouldAutoEnableFilterMode =
          hasYamlFilters &&
          !hasAlbumMode &&
          !hasFilterMode &&
          !cmdOptions["minStars"] &&
          !cmdOptions["minRating"];

        if (!hasAlbumMode && !hasFilterMode && !shouldAutoEnableFilterMode) {
          throw new Error(
            "Must specify either album mode (--range) or filter mode (--min-stars or --min-rating)",
          );
        }

        let mode: CopyMode;

        if (hasFilterMode || shouldAutoEnableFilterMode) {
          const ratingFilter: RatingFilter = {
            minStars: cmdOptions["minStars"] as number | undefined,
            minRating: cmdOptions["minRating"] as number | undefined,
            // Merge CLI options with config defaults (CLI takes precedence)
            outputFolder:
              (cmdOptions["outputFolder"] as string | undefined) ??
              copyConfig.outputFolder ??
              DEFAULT_OUTPUT_FOLDER,
            preserveStructure:
              (cmdOptions["preserveStructure"] as boolean | undefined) ??
              copyConfig.preserveStructure ??
              false,
            range: cmdOptions["range"] as CopyRange | undefined,
            albumMode:
              (cmdOptions["albumMode"] as boolean | undefined) ?? copyConfig.albumMode ?? false,
            // When auto-enabling from YAML, pass the filter name for evaluation during execution
            filterName: shouldAutoEnableFilterMode ? firstFilterName : undefined,
          };
          mode = { type: "filter", rating: ratingFilter };

          if (shouldAutoEnableFilterMode && !cmdOptions["interactive"]) {
            output(
              `Selected ${sourceEntries?.length ?? 1} source(s), filter mode (${firstFilterName})`,
            );
          }
        } else {
          const range = (cmdOptions["range"] as CopyRange | undefined) ?? {
            start: 1,
            end: 1,
            padWidth: 3,
          };
          mode = { type: "album", range };
        }

        const workers = validateWorkers(
          (cmdOptions["workers"] as number | undefined) ??
            copyConfig.workers ??
            getDefaultWorkers(),
        );

        const copyOptions: CopyOptions = {
          mode,
          albumOnly: Boolean(cmdOptions["albumOnly"]),
          hardlink: Boolean(cmdOptions["hardlink"]),
          convertFormat: cmdOptions["convert"] as CopyOptions["convertFormat"],
          force: Boolean(cmdOptions["force"]),
          dryRun: false, // Not stored in queue
          workers,
          file: cmdOptions["file"] as string | undefined,
          progress: cmdOptions["progress"] as boolean | undefined,
          plexScan: cmdOptions["plexScan"] as boolean | undefined,
          plexLibrary: cmdOptions["plexLibrary"] as string | undefined,
          cliRange: cmdOptions["range"] as CopyRange | undefined,
          count: cmdOptions["count"] as number | undefined,
          selection: copySelection, // Interactive selection (preserved in database)
          // Store source entries for multi-source mode
          cliSourceEntries: sourceEntries,
          // Store source selection filters for display in queue list --verbose
          sourceIdx: cmdOptions["sourceIdx"] as string | undefined,
          sourceName: cmdOptions["sourceName"] as string | undefined,
          sourceArtist: cmdOptions["artist"] as string | undefined,
          sourceGroup: cmdOptions["group"] as string | undefined,
        };

        logDebug(`Adding job to queue: ${effectiveSource} -> ${effectiveDestination}`);

        const { executeQueueAdd } = await import("../actions/queue.js");
        // Pass sourceEntries for multi-source job support (from --paths YAML or --file)
        const job = await executeQueueAdd(
          effectiveSource,
          effectiveDestination,
          copyOptions,
          { dryRun },
          sourceEntries,
        );

        const format = globalOpts?.output ?? "text";
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          await formatOutput(format, { command: "queue add", job });
        }
      } catch (error) {
        logError(`Failed to add job: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    },
  );

/**
 * queue list - List queued jobs.
 */
const listCommand = new Command("list")
  .description("List jobs in the queue")
  .addOption(
    new Option("--status <status>", "Filter by status").choices([
      "pending",
      "running",
      "completed",
      "failed",
    ]),
  )
  .addOption(new Option("-v, --verbose", "Show detailed job information"))
  .action(async (cmdOptions: Record<string, unknown>) => {
    const globalOpts = queueCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      const { executeQueueList } = await import("../actions/queue.js");
      const jobs = await executeQueueList({
        status: cmdOptions["status"] as QueueJobStatus | undefined,
        verbose: Boolean(cmdOptions["verbose"]),
        dryRun: Boolean(globalOpts?.dryRun),
      });

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, { command: "queue list", jobs });
      }
    } catch (error) {
      logError(`Failed to list queue: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

/**
 * queue run - Execute queued jobs.
 */
const runCommand = new Command("run")
  .description("Run pending jobs in the queue")
  .addOption(
    new Option("-w, --workers <N>", "Number of parallel job workers")
      .argParser(parseIntArg)
      .default(1),
  )
  .addOption(new Option("--continue-on-error", "Continue running jobs after failures"))
  .addOption(new Option("--plex-scan", "Trigger Plex scan after completion"))
  .addOption(new Option("--no-plex-scan", "Disable Plex scan"))
  .action(async (cmdOptions: Record<string, unknown>) => {
    const globalOpts = queueCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      const { executeQueueRun } = await import("../actions/queue.js");
      const result = await executeQueueRun({
        workers: cmdOptions["workers"] as number,
        continueOnError: Boolean(cmdOptions["continueOnError"]),
        plexScan: cmdOptions["plexScan"] as boolean | undefined,
        dryRun: Boolean(globalOpts?.dryRun),
      });

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, { command: "queue run", result });
      }

      if (result.failed > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      logError(`Queue run failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

/**
 * queue clear - Remove jobs from the queue.
 */
const clearCommand = new Command("clear")
  .description("Clear jobs from the queue")
  .addOption(new Option("--completed", "Only clear completed jobs"))
  .addOption(new Option("--failed", "Only clear failed jobs"))
  .addOption(new Option("--pending", "Only clear pending jobs"))
  .addOption(new Option("-f, --force", "Skip confirmation prompt"))
  .action(async (cmdOptions: Record<string, unknown>) => {
    const globalOpts = queueCommand.parent?.opts() as GlobalOptions | undefined;

    // Determine status filter
    let status: QueueJobStatus | undefined;
    if (cmdOptions["completed"]) status = "completed";
    else if (cmdOptions["failed"]) status = "failed";
    else if (cmdOptions["pending"]) status = "pending";

    try {
      const { executeQueueClear } = await import("../actions/queue.js");
      const result = await executeQueueClear({
        status,
        force: Boolean(cmdOptions["force"]),
        dryRun: Boolean(globalOpts?.dryRun),
      });

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, { command: "queue clear", result });
      }
    } catch (error) {
      logError(`Failed to clear queue: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

/**
 * queue add delete - Add a delete job to the queue.
 */
const addDeleteCommand = new Command("delete")
  .description("Add a delete job to the queue")
  .argument("[paths...]", "Source and destination paths (same format as delete command)")
  // Album mode options
  .addOption(
    new Option("-r, --range <START-END>", "Range of suffixes to delete (e.g., 008-010)").argParser(
      parseRange,
    ),
  )
  .addOption(
    new Option("--count <N>", "Number of copies to delete (deletes highest suffixes first)")
      .argParser(parseIntArg)
      .conflicts("range"),
  )
  .addOption(new Option("--album-only", "Treat source as single album"))
  .addOption(new Option("--file <path>", "Read source paths from file").conflicts("paths"))
  .addOption(new Option("--paths <file>", "Read paths from YAML file").conflicts("file"))
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
    ).argParser(parseIntArg),
  )
  .addOption(
    new Option(
      "--output-folder <name>",
      "Output folder name that was used for filtered tracks",
    ).default(DEFAULT_OUTPUT_FOLDER),
  )
  .addOption(new Option("--album-mode", "Match album folders with only liked tracks"))
  // Delete-specific options
  .addOption(new Option("--trash", "Move to trash instead of permanent delete"))
  .addOption(new Option("--keep-tracking", "Keep database tracking entries (don't allow re-copy)"))
  // Common options
  .addOption(
    new Option("-w, --workers <N>", `Number of parallel workers (1-${MAX_WORKERS})`).argParser(
      parseIntArg,
    ),
  )
  .addOption(
    new Option("-c, --convert <format>", "Match files converted to format").choices(
      getValidFormats(),
    ),
  )
  .addOption(new Option("--progress", "Show visual progress bar"))
  // Plex options
  .addOption(new Option("--plex-scan", "Trigger Plex scan after completion"))
  .addOption(new Option("--plex-library <name>", "Plex library name to scan"))
  // Interactive selection option
  .addOption(new Option("-i, --interactive", "Interactively select items to delete"))
  .action(async (paths: string[], cmdOptions: Record<string, unknown>) => {
    const globalOpts = queueCommand.parent?.opts() as GlobalOptions | undefined;
    const dryRun = Boolean(globalOpts?.dryRun);

    try {
      // Validate source selection options require --paths
      const hasSelectionOptions =
        cmdOptions["sourceIdx"] !== undefined ||
        cmdOptions["sourceName"] !== undefined ||
        cmdOptions["artist"] !== undefined ||
        cmdOptions["group"] !== undefined;
      if (hasSelectionOptions && !cmdOptions["paths"]) {
        throw new Error(
          "Selection options (--source-idx, --source-name, --artist, --group) require --paths. " +
            "Please provide a YAML paths file with --paths to use source filtering.",
        );
      }

      // Parse source and destination based on input method
      let sourceEntries: PathEntry[] | undefined;
      let destination: string;
      let effectiveSource: string;
      let deleteSelection: import("../types/options.js").DeleteSelection | undefined;

      if (cmdOptions["paths"]) {
        // With --paths: parse YAML file
        if (paths.length > 0) {
          throw new Error("With --paths option, do not provide positional path arguments");
        }

        const { loadAndValidatePathsYaml } = await import("../lib/paths-yaml.js");
        const result = await loadAndValidatePathsYaml({
          pathsFile: cmdOptions["paths"] as string,
          sourceIdx: cmdOptions["sourceIdx"] as string | undefined,
          sourceName: cmdOptions["sourceName"] as string | undefined,
          sourceArtist: cmdOptions["artist"] as string | undefined,
          sourceGroup: cmdOptions["group"] as string | undefined,
          dryRun,
        });

        sourceEntries = result.sourceEntries;
        destination = result.destination;
        effectiveSource = sourceEntries[0]?.path ?? "";
      } else if (cmdOptions["file"]) {
        // With --file: paths should be just [destination]
        if (paths.length !== 1) {
          throw new Error("With --file option, provide only the destination path");
        }
        const { readSourcePaths } = await import("../lib/input-file.js");
        sourceEntries = await readSourcePaths(cmdOptions["file"] as string);
        destination = paths[0]!;
        effectiveSource = sourceEntries[0]?.path ?? "";
      } else {
        // Without --file/--paths: paths should be [source1, source2, ..., destination]
        if (paths.length < 2) {
          throw new Error(
            "Provide at least <source> and <destination> paths, or use --paths/--file",
          );
        }
        destination = paths[paths.length - 1]!;
        const sourcePaths = paths.slice(0, -1);
        sourceEntries = sourcePaths.map((p) => ({ path: p }));
        effectiveSource = sourceEntries[0]?.path ?? "";
      }

      // Interactive selection
      if (shouldShowInteractiveSelection(cmdOptions["interactive"] as boolean | undefined)) {
        if (!sourceEntries || sourceEntries.length === 0) {
          throw new Error(
            "--interactive requires source paths (use --paths, --file, or positional sources)",
          );
        }

        // Get interactive config for page sizes
        const config = getLoadedConfig();
        const interactiveConfig = getInteractiveConfig(config);

        // Note: For queue, we only preserve source-level selection
        // Album/track-level refinements cannot be serialized

        // Build temporary mode for selection
        const hasFilterMode =
          cmdOptions["minStars"] !== undefined || cmdOptions["minRating"] !== undefined;
        const tempMode: import("../types/options.js").DeleteMode = hasFilterMode
          ? {
              type: "filter",
              rating: {
                minStars: cmdOptions["minStars"] as number | undefined,
                outputFolder: DEFAULT_OUTPUT_FOLDER,
                preserveStructure: false,
              },
            }
          : { type: "album" };

        // Use lazy loader for interactive delete selection
        const selection = await loadDeleteInteractiveSelection(
          sourceEntries,
          destination,
          tempMode,
          Boolean(cmdOptions["albumOnly"]),
          interactiveConfig,
        );

        if (selection === null) {
          logInfo("Selection cancelled");
          return;
        }

        // Filter to selected sources only
        sourceEntries = sourceEntries.filter((e) => selection.selectedSources.includes(e.path));

        if (sourceEntries.length === 0) {
          throw new Error("No sources selected");
        }

        output(`Selected ${sourceEntries.length} source(s) for deletion`);

        // Store selection for later use in DeleteOptions
        deleteSelection = selection;
      }

      // Build DeleteOptions
      const copyConfig = getLoadedConfig()?.copy ?? {};

      // Determine mode - --paths and --file enable album mode even without --range/--count
      const hasAlbumMode =
        cmdOptions["range"] !== undefined ||
        cmdOptions["count"] !== undefined ||
        cmdOptions["file"] !== undefined ||
        cmdOptions["paths"] !== undefined ||
        (sourceEntries !== undefined && sourceEntries.length > 0);
      const hasFilterMode =
        cmdOptions["minStars"] !== undefined || cmdOptions["minRating"] !== undefined;

      if (!hasAlbumMode && !hasFilterMode) {
        throw new Error(
          "Must specify either album mode (--range/--count) or filter mode (--min-stars/--min-rating)",
        );
      }

      let mode: import("../types/options.js").DeleteMode;

      if (hasFilterMode) {
        const ratingFilter: import("../types/options.js").RatingFilter = {
          minStars: cmdOptions["minStars"] as number | undefined,
          minRating: cmdOptions["minRating"] as number | undefined,
          outputFolder: (cmdOptions["outputFolder"] as string | undefined) ?? DEFAULT_OUTPUT_FOLDER,
          preserveStructure: false,
          albumMode: Boolean(cmdOptions["albumMode"]),
        };
        mode = { type: "filter", rating: ratingFilter };
      } else {
        mode = {
          type: "album",
          range: cmdOptions["range"] as CopyRange | undefined,
        };
      }

      const workers = validateWorkers(
        (cmdOptions["workers"] as number | undefined) ?? copyConfig.workers ?? getDefaultWorkers(),
      );

      const deleteOptions: import("../types/options.js").DeleteOptions = {
        mode,
        albumOnly: Boolean(cmdOptions["albumOnly"]),
        convertFormat: cmdOptions["convert"] as
          | import("../types/options.js").ConvertFormat
          | undefined,
        force: false, // Queue jobs don't use force
        dryRun: false, // Not stored in queue
        workers,
        file: cmdOptions["file"] as string | undefined,
        progress: cmdOptions["progress"] as boolean | undefined,
        useTrash: Boolean(cmdOptions["trash"]),
        keepTracking: Boolean(cmdOptions["keepTracking"]),
        plexScan: cmdOptions["plexScan"] as boolean | undefined,
        plexLibrary: cmdOptions["plexLibrary"] as string | undefined,
        cliRange: cmdOptions["range"] as CopyRange | undefined,
        count: cmdOptions["count"] as number | undefined,
        cliSourceEntries: sourceEntries,
        selection: deleteSelection, // Interactive selection (preserved in database)
        // Store source selection filters for display
        sourceIdx: cmdOptions["sourceIdx"] as string | undefined,
        sourceName: cmdOptions["sourceName"] as string | undefined,
        sourceArtist: cmdOptions["artist"] as string | undefined,
        sourceGroup: cmdOptions["group"] as string | undefined,
      };

      const { executeQueueAddDelete } = await import("../actions/queue.js");
      const job = await executeQueueAddDelete(
        effectiveSource,
        destination,
        deleteOptions,
        { dryRun },
        sourceEntries,
      );

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, { command: "queue add delete", job });
      }
    } catch (error) {
      logError(
        `Failed to add delete job: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  });

// Register subcommands
const addCommand = new Command("add").description("Add jobs to the queue");
addCommand.addCommand(addCopyCommand);
addCommand.addCommand(addDeleteCommand);

queueCommand.addCommand(addCommand);
queueCommand.addCommand(listCommand);
queueCommand.addCommand(runCommand);
queueCommand.addCommand(clearCommand);
