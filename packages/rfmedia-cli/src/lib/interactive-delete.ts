/**
 * Interactive selection UI for rfmedia delete command.
 *
 * Provides a multi-select selection flow using ink + @inkjs/ui:
 * 1. Scan destination for existing suffixed album copies
 * 2. Present user with list of discovered copies to select for deletion
 * 3. Return selection for processing by delete actions
 */

import path from "node:path";
import { readdir } from "node:fs/promises";
import { render } from "ink";
import React from "react";
import { pathExists } from "./filesystem.js";
import { isInteractive } from "./prompt.js";
import { isJsonMode, logDebug, logWarn, output } from "./logger.js";
import { DeleteSelector } from "./interactive/index.js";
import { STDIN_CLEANUP_DELAY_MS } from "./interactive/constants.js";
import type {
  PathEntry,
  DeleteSelection,
  DeleteSourceSelection,
  DeleteMode,
} from "../types/index.js";
import type { InteractiveConfig } from "../types/config.js";
import type { DeleteDisplayInfo } from "../types/interactive.js";

/**
 * Display formatted numbered list of selected items.
 */
function displayDeleteSummary<T>(
  label: string,
  items: ReadonlyArray<T>,
  formatter: (item: T, index: number) => string = (item) => String(item),
): void {
  if (items.length === 0) return;

  output(""); // Empty line before
  output(`${label}:`);
  items.forEach((item, index) => {
    output(`  ${index + 1}. ${formatter(item, index)}`);
  });
  output(""); // Empty line after
}

/**
 * Renders the DeleteSelector ink component and handles stdin cleanup.
 *
 * This function provides critical stdin cleanup after ink exits to prevent
 * the "confirmation prompt closing early" bug. After ink exits raw mode,
 * any buffered input (like the Enter keypress) needs time to be discarded
 * before subsequent readline prompts can safely use stdin.
 *
 * @param items - Delete display info items to show in the selector
 * @param pageSize - Number of visible options in the selection menu
 * @returns Array of selected paths, or null if cancelled
 */
async function renderDeleteSelector(
  items: readonly DeleteDisplayInfo[],
  pageSize: number,
): Promise<readonly string[] | null> {
  let result: readonly string[] | null = null;

  const { unmount, waitUntilExit } = render(
    React.createElement(DeleteSelector, {
      items,
      pageSize,
      onSelect: (selected: readonly string[]) => {
        result = selected;
      },
      onCancel: () => {
        result = null;
      },
    }),
  );

  await waitUntilExit();
  unmount();

  // Critical stdin cleanup to prevent confirmation prompt issues
  // Ink puts stdin in raw mode and the Enter keypress that confirms selection
  // remains buffered. We must drain it before subsequent readline prompts.
  try {
    if (process.stdin.isTTY) {
      // Exit raw mode first
      process.stdin.setRawMode(false);

      // Force buffer clear by temporarily entering flowing mode
      // This drains any pending input (like the Enter keypress)
      const discardHandler = (): void => {
        // Intentionally discard any data
      };
      process.stdin.on("data", discardHandler);
      process.stdin.resume();

      // Wait for any buffered data to flow through and be discarded
      await new Promise((resolve) => setTimeout(resolve, STDIN_CLEANUP_DELAY_MS));

      // Clean up and pause stdin for readline to take over
      process.stdin.removeListener("data", discardHandler);
      process.stdin.pause();
    }
  } catch (stdinError) {
    // Stdin cleanup failed, but we can still return results
    // This can happen in edge cases with terminal state
    logDebug(
      `Stdin cleanup warning: ${stdinError instanceof Error ? stdinError.message : String(stdinError)}`,
    );
  }

  return result;
}

/**
 * Guards for interactive mode availability.
 */
export function requireInteractiveMode(): void {
  if (!isInteractive()) {
    throw new Error(
      "Interactive mode requires a TTY terminal. Cannot use --interactive in piped input, CI, or non-interactive environments.",
    );
  }
  if (isJsonMode()) {
    throw new Error(
      "Interactive mode cannot be used with --json output. Remove --json or --interactive.",
    );
  }
}

/**
 * Suffix information for a discovered album copy or output folder.
 */
interface SuffixInfo {
  /** Full path to the directory */
  path: string;
  /** Directory name (e.g., "Album-005" or "liked-songs-003") */
  name: string;
  /** Suffix number (e.g., 5 for Album-005) */
  suffixNum: number;
  /** Formatted suffix string (e.g., "005") */
  suffix: string;
  /** Artist name (parent directory) */
  artistName: string;
  /** Base name without suffix (e.g., "Album" or "liked-songs") */
  baseName: string;
}

/**
 * Discovers all numbered copies in destination for a given source.
 *
 * For album mode: scans destination artist folder for Album-XXX patterns
 * For filter mode: scans destination artist folder for outputFolder-XXX patterns
 *
 * @param source - Source path (artist or album folder)
 * @param destination - Destination base directory
 * @param mode - Delete mode (album or filter)
 * @param albumOnly - Whether source is a single album
 * @param outputFolder - Output folder name for filter mode
 * @returns Array of suffix info, sorted descending by suffix number
 */
async function discoverDestinationSuffixes(
  source: string,
  destination: string,
  mode: DeleteMode,
  albumOnly: boolean,
  outputFolder?: string,
): Promise<SuffixInfo[]> {
  // Determine artist name based on mode
  let artistName: string;
  if (albumOnly) {
    // Album-only mode: source is an album, extract artist from parent
    artistName = path.basename(path.dirname(source));
  } else {
    // Artist mode: source is an artist folder
    artistName = path.basename(source);
  }

  const artistDest = path.join(destination, artistName);

  logDebug(`Scanning destination for suffixes: ${artistDest}`);

  // Check if artist destination exists
  if (!(await pathExists(artistDest))) {
    logDebug(`Artist destination does not exist: ${artistDest}`);
    return [];
  }

  const entries = await readdir(artistDest, { withFileTypes: true });

  // Pattern matches: anything ending with -XXX where XXX is 3+ digits
  const suffixPattern = /^(.+)-(\d{3,})$/;

  const suffixes: SuffixInfo[] = [];

  for (const entry of entries) {
    // Only check directories
    if (!entry.isDirectory()) {
      continue;
    }

    const match = entry.name.match(suffixPattern);
    if (!match || !match[1] || !match[2]) {
      continue;
    }

    const baseName = match[1];
    const suffixStr = match[2];
    const suffixNum = parseInt(suffixStr, 10);

    // For filter mode with outputFolder (flat mode), only match that specific folder
    // For filter mode with albumMode, accept all album suffixes without filtering
    if (
      mode.type === "filter" &&
      !mode.rating.albumMode &&
      outputFolder &&
      baseName !== outputFolder
    ) {
      // Flat mode filter: skip folders that don't match the specific outputFolder
      continue;
    }

    suffixes.push({
      path: path.join(artistDest, entry.name),
      name: entry.name,
      suffixNum,
      suffix: suffixStr,
      artistName,
      baseName,
    });
  }

  // Sort by suffix number in descending order (highest first, matching delete behavior)
  return suffixes.sort((a, b) => b.suffixNum - a.suffixNum);
}

/**
 * Converts discovered SuffixInfo items into DeleteDisplayInfo for the selector component.
 *
 * @param allSuffixesMap - Map of source paths to their discovered suffixes
 * @returns Array of delete display info items
 */
function prepareSuffixedCopiesForDisplay(
  allSuffixesMap: Map<string, SuffixInfo[]>,
): readonly DeleteDisplayInfo[] {
  const items: DeleteDisplayInfo[] = [];

  for (const suffixes of allSuffixesMap.values()) {
    for (const suffix of suffixes) {
      items.push({
        path: suffix.path,
        label: suffix.name,
        suffix: suffix.name,
        artistName: suffix.artistName,
      });
    }
  }

  return items;
}

/**
 * Main entry: run interactive delete selection flow.
 * Returns null if the user cancels the selection.
 *
 * @param sourceEntries - Source paths to scan for suffixed copies
 * @param destination - Destination directory to search in
 * @param mode - Delete mode (album or filter)
 * @param albumOnly - Whether sources are single albums
 * @param config - Interactive configuration with page sizes
 * @param signal - Optional abort signal for cancellation
 * @returns Delete selection object or null if cancelled
 */
export async function runInteractiveDeleteSelection(
  sourceEntries: readonly PathEntry[],
  destination: string,
  mode: DeleteMode,
  albumOnly: boolean,
  config: InteractiveConfig,
  signal?: AbortSignal,
): Promise<DeleteSelection | null> {
  requireInteractiveMode();

  // Check for early cancellation
  if (signal?.aborted) {
    return null;
  }

  // Scan destination for all existing suffixed copies across all sources
  // Parallelize filesystem operations for better performance with many sources
  const discoveries = await Promise.all(
    sourceEntries.map(async (entry) => {
      const outputFolder =
        mode.type === "filter" && mode.rating.outputFolder ? mode.rating.outputFolder : undefined;

      const suffixes = await discoverDestinationSuffixes(
        entry.path,
        destination,
        mode,
        albumOnly,
        outputFolder,
      );

      return { sourcePath: entry.path, suffixes };
    }),
  );

  const allSuffixesMap = new Map(
    discoveries.map(({ sourcePath, suffixes }) => [sourcePath, suffixes]),
  );

  // Calculate total available copies
  const totalCopies = Array.from(allSuffixesMap.values()).reduce((sum, arr) => sum + arr.length, 0);

  if (totalCopies === 0) {
    throw new Error("No suffixed copies found in destination. Nothing to delete.");
  }

  logDebug(`Found ${totalCopies} suffixed copies across ${sourceEntries.length} sources`);

  // Convert to display format for the ink component
  const deleteItems = prepareSuffixedCopiesForDisplay(allSuffixesMap);

  // Retry loop for empty selection
  let selected: readonly string[] | null = null;
  while (true) {
    // Present multi-select to user using ink component
    selected = await renderDeleteSelector(deleteItems, config.artistPageSize);

    // User cancelled with Escape
    if (selected === null) {
      return null;
    }

    // User selected items - proceed
    if (selected.length > 0) {
      break;
    }

    // Empty selection - show friendly message and retry
    logWarn("\nNo items selected. Use Space to toggle items, then Enter to confirm.\n");
  }

  logDebug(`User selected ${selected.length} items for deletion`);

  // Display formatted selection summary
  displayDeleteSummary("Selected items", [...selected], (itemPath) => path.basename(itemPath));

  // Build result structure
  const selectedSet = new Set(selected);

  // Determine which sources have selections
  const selectedSources: string[] = [];
  const sourceSelections = new Map<string, DeleteSourceSelection>();

  for (const [sourcePath, suffixes] of allSuffixesMap) {
    const selectedForSource = suffixes.filter((s) => selectedSet.has(s.path)).map((s) => s.path);

    if (selectedForSource.length > 0) {
      selectedSources.push(sourcePath);
      sourceSelections.set(sourcePath, {
        sourcePath,
        selectedSuffixes: selectedForSource,
      });
    }
  }

  return {
    selectedSources,
    sourceSelections,
  };
}
