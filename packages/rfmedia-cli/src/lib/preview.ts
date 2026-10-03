/**
 * Non-destructive preview logic for rfmedia CLI.
 *
 * Provides functions to collect and format detailed preview information
 * for dry-run mode, showing what would happen without making changes.
 */

import path from "node:path";
import { readdir } from "node:fs/promises";

import { pathExists, scanDirectoryStats } from "./filesystem.js";
import { verifyAlbumComplete, getExpectedDestFilename } from "./verify.js";
import { formatSuffix } from "./range.js";
import { logDebug, colors } from "./logger.js";
import { formatAlbumPreviewTable, formatFilterPreviewTable } from "./table-format.js";
import type {
  AlbumPreview,
  AlbumSuffixPreview,
  PreviewAction,
  PreviewResult,
  PreviewOptions,
  PreviewFormatOptions,
  FilterPreview,
  FilterPreviewResult,
  TrackPreview,
} from "../types/preview.js";
import type { CopyRange, ConvertFormat } from "../types/options.js";

/**
 * Formats a byte count into a human-readable string.
 *
 * @param bytes - Number of bytes
 * @returns Human-readable string (e.g., "350MB", "1.4GB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  // Use 1 decimal place for GB and above, no decimal for smaller units
  if (i >= 3) {
    return `${(bytes / Math.pow(k, i)).toFixed(1)}${units[i]}`;
  }

  // For MB, show decimal only if less than 100MB
  if (i === 2 && bytes / Math.pow(k, i) < 100) {
    return `${(bytes / Math.pow(k, i)).toFixed(1)}${units[i]}`;
  }

  return `${Math.round(bytes / Math.pow(k, i))}${units[i]}`;
}

/**
 * Counts files in a destination directory (for incomplete status reporting).
 *
 * @param destDir - Path to destination directory
 * @returns Number of files in the directory
 */
async function countDestFiles(destDir: string): Promise<number> {
  try {
    const entries = await readdir(destDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

/**
 * Collects preview information for a single album-suffix combination.
 *
 * @param albumSource - Path to source album directory
 * @param artistDest - Path to destination artist directory
 * @param suffix - Formatted suffix string (e.g., "001")
 * @param sourceStats - Pre-scanned source directory stats
 * @param options - Preview options
 * @returns Preview info for this suffix
 */
async function collectSuffixPreview(
  albumSource: string,
  artistDest: string,
  suffix: string,
  sourceStats: { fileCount: number; totalBytes: number },
  options: PreviewOptions,
): Promise<AlbumSuffixPreview> {
  const albumName = path.basename(albumSource);
  const destPath = path.join(artistDest, `${albumName}-${suffix}`);

  // Check if destination exists
  const exists = await pathExists(destPath);

  if (!exists) {
    return {
      suffix,
      destPath,
      action: "create",
      fileCount: sourceStats.fileCount,
      totalBytes: sourceStats.totalBytes,
    };
  }

  // Destination exists - check if complete
  const status = await verifyAlbumComplete(albumSource, destPath, options.convertFormat);

  if (status === "complete") {
    if (options.force) {
      return {
        suffix,
        destPath,
        action: "overwrite",
        reason: "force mode enabled",
        fileCount: sourceStats.fileCount,
        totalBytes: sourceStats.totalBytes,
      };
    }

    return {
      suffix,
      destPath,
      action: "skip",
      reason: "already exists",
      fileCount: 0,
      totalBytes: 0,
    };
  }

  // Incomplete - will be recreated
  const existingFiles = await countDestFiles(destPath);

  return {
    suffix,
    destPath,
    action: "incomplete",
    reason: `incomplete (${existingFiles}/${sourceStats.fileCount} files)`,
    fileCount: sourceStats.fileCount,
    totalBytes: sourceStats.totalBytes,
    existingFiles,
  };
}

/**
 * Collects preview information for an entire album across all suffixes.
 *
 * @param albumSource - Path to source album directory
 * @param artistDest - Path to destination artist directory
 * @param range - Range of suffixes to create
 * @param options - Preview options
 * @returns Album preview with all suffix previews
 */
export async function collectAlbumPreview(
  albumSource: string,
  artistDest: string,
  range: CopyRange,
  options: PreviewOptions,
): Promise<AlbumPreview> {
  const albumName = path.basename(albumSource);

  // Scan source directory for stats
  const sourceStats = await scanDirectoryStats(albumSource);

  logDebug(
    `Preview scan: ${albumName} (${sourceStats.fileCount} files, ${formatBytes(sourceStats.totalBytes)})`,
  );

  // Collect preview for each suffix
  const suffixes: AlbumSuffixPreview[] = [];

  for (let i = range.start; i <= range.end; i++) {
    const suffix = formatSuffix(i, range.padWidth);
    const suffixPreview = await collectSuffixPreview(
      albumSource,
      artistDest,
      suffix,
      sourceStats,
      options,
    );
    suffixes.push(suffixPreview);
  }

  // Calculate summary
  const summary = {
    willCreate: suffixes.filter((s) => s.action === "create").length,
    willSkip: suffixes.filter((s) => s.action === "skip").length,
    willOverwrite: suffixes.filter((s) => s.action === "overwrite").length,
    willRecreate: suffixes.filter((s) => s.action === "incomplete").length,
  };

  return {
    albumName,
    sourcePath: albumSource,
    suffixes,
    summary,
  };
}

/**
 * Collects preview information for multiple albums.
 *
 * @param albums - Array of source album paths
 * @param artistDest - Destination artist directory
 * @param range - Range of suffixes
 * @param options - Preview options
 * @returns Complete preview result
 */
export async function collectPreviewResult(
  albums: string[],
  artistDest: string,
  range: CopyRange,
  options: PreviewOptions,
): Promise<PreviewResult> {
  const albumPreviews: AlbumPreview[] = [];

  for (const album of albums) {
    const preview = await collectAlbumPreview(album, artistDest, range, options);
    albumPreviews.push(preview);
  }

  // Calculate totals
  const totals = {
    files: 0,
    bytes: 0,
    creates: 0,
    skips: 0,
    overwrites: 0,
    recreates: 0,
  };

  for (const album of albumPreviews) {
    totals.creates += album.summary.willCreate;
    totals.skips += album.summary.willSkip;
    totals.overwrites += album.summary.willOverwrite;
    totals.recreates += album.summary.willRecreate;

    // Sum up file/byte totals for creates, overwrites, and recreates
    for (const suffix of album.suffixes) {
      if (suffix.action !== "skip") {
        totals.files += suffix.fileCount;
        totals.bytes += suffix.totalBytes;
      }
    }
  }

  return {
    albums: albumPreviews,
    totals,
  };
}

/**
 * Gets the action color for console output.
 */
function getActionColor(action: PreviewAction): (text: string) => string {
  switch (action) {
    case "create":
      return colors.green;
    case "skip":
      return colors.gray;
    case "overwrite":
      return colors.yellow;
    case "incomplete":
      return colors.yellow;
    default:
      return (s: string) => s;
  }
}

/**
 * Gets the action prefix symbol.
 */
export function getActionSymbol(action: PreviewAction): string {
  switch (action) {
    case "create":
      return "+";
    case "skip":
      return "~";
    case "overwrite":
      return "!";
    case "incomplete":
      return "?";
    default:
      return " ";
  }
}

/**
 * Formats a single album preview for output.
 *
 * @param preview - Album preview to format
 * @param formatOptions - Formatting options
 */
function formatAlbumPreview(preview: AlbumPreview, formatOptions: PreviewFormatOptions): void {
  console.error(`Album: ${preview.albumName}`);

  for (const suffix of preview.suffixes) {
    const actionColor = getActionColor(suffix.action);
    const symbol = getActionSymbol(suffix.action);
    const destName = path.basename(suffix.destPath);

    let line: string;

    switch (suffix.action) {
      case "create":
        line = `  ${symbol} Will create: ${destName}/ (${suffix.fileCount} files, ${formatBytes(suffix.totalBytes)})`;
        break;
      case "skip":
        line = `  ${symbol} Will skip: ${destName}/ (${suffix.reason})`;
        break;
      case "overwrite":
        line = `  ${symbol} Will overwrite: ${destName}/ (${suffix.fileCount} files, ${formatBytes(suffix.totalBytes)})`;
        break;
      case "incomplete":
        line = `  ${symbol} Will recreate: ${destName}/ (${suffix.reason})`;
        break;
      default:
        line = `  ${symbol} ${destName}/`;
    }

    console.error(actionColor(line));
  }

  // Show album summary if it has mixed actions
  const actionTypes = new Set(preview.suffixes.map((s) => s.action));
  if (actionTypes.size > 1) {
    const parts: string[] = [];
    if (preview.summary.willCreate > 0) parts.push(`${preview.summary.willCreate} create`);
    if (preview.summary.willSkip > 0) parts.push(`${preview.summary.willSkip} skip`);
    if (preview.summary.willOverwrite > 0) parts.push(`${preview.summary.willOverwrite} overwrite`);
    if (preview.summary.willRecreate > 0) parts.push(`${preview.summary.willRecreate} recreate`);
    console.error(colors.gray(`  Summary: ${parts.join(", ")}`));
  }
}

/**
 * Formats the complete preview result for output.
 *
 * @param result - Preview result to format
 * @param formatOptions - Formatting options
 */
export async function formatPreviewOutput(
  result: PreviewResult,
  formatOptions: PreviewFormatOptions = {},
): Promise<void> {
  console.error("");
  console.error(colors.bold("=== DRY-RUN PREVIEW ==="));
  console.error("");

  // Always show table first
  const tableOutput = formatAlbumPreviewTable(result);
  console.error(tableOutput);

  // In verbose mode, show file-level details for each album
  if (formatOptions.verbose) {
    console.error("");
    console.error(colors.bold("--- File-Level Details ---"));
    console.error("");

    for (const album of result.albums) {
      console.error(colors.bold(`Album: ${album.albumName}`));

      for (const suffix of album.suffixes) {
        if (suffix.action !== "skip") {
          await formatVerboseSuffixPreview(
            suffix,
            album.sourcePath,
            formatOptions.maxFilesShown ?? 10,
          );
        }
      }
      console.error("");
    }
  }

  // Format totals
  console.error(colors.bold("--- Summary ---"));

  const summaryParts: string[] = [];
  if (result.totals.creates > 0) {
    summaryParts.push(`${result.totals.creates} will create`);
  }
  if (result.totals.skips > 0) {
    summaryParts.push(`${result.totals.skips} will skip`);
  }
  if (result.totals.overwrites > 0) {
    summaryParts.push(`${result.totals.overwrites} will overwrite`);
  }
  if (result.totals.recreates > 0) {
    summaryParts.push(`${result.totals.recreates} will recreate`);
  }

  if (summaryParts.length > 0) {
    console.error(
      `  Total: ${result.totals.creates + result.totals.skips + result.totals.overwrites + result.totals.recreates} album copies | ${summaryParts.join(" | ")}`,
    );
  }

  if (result.totals.files > 0) {
    console.error(
      `  Files: ${result.totals.files} files (${formatBytes(result.totals.bytes)}) to copy`,
    );
  } else {
    console.error(colors.gray("  Nothing to copy (all destinations up to date)"));
  }

  console.error("");
}

/**
 * Formats a verbose single-suffix preview showing individual files.
 * Used when --verbose flag is enabled.
 *
 * @param suffix - Suffix preview to format
 * @param albumSource - Source album path for file listing
 * @param maxFiles - Maximum files to show before truncating
 */
export async function formatVerboseSuffixPreview(
  suffix: AlbumSuffixPreview,
  albumSource: string,
  maxFiles: number = 5,
): Promise<void> {
  const actionColor = getActionColor(suffix.action);
  const destName = path.basename(suffix.destPath);

  if (suffix.action === "skip") {
    console.error(actionColor(`  ${destName}/: SKIP (${suffix.reason})`));
    return;
  }

  console.error(actionColor(`  ${destName}/:`));

  // List source files
  try {
    const entries = await readdir(albumSource, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());

    let shown = 0;
    for (const file of files) {
      if (shown >= maxFiles) {
        const remaining = files.length - shown;
        console.error(colors.gray(`    ... (${remaining} more files)`));
        break;
      }
      console.error(colors.green(`    + ${file.name}`));
      shown++;
    }
  } catch {
    console.error(colors.gray("    (unable to list files)"));
  }
}

// ============================================================================
// Filter Mode Preview Functions
// ============================================================================

/**
 * Collects preview information for filter mode.
 *
 * @param likedFiles - Files that passed the rating filter
 * @param filteredCount - Number of files that were filtered out
 * @param source - Source directory path
 * @param destination - Destination directory path
 * @param outputFolder - Output folder name
 * @param options - Preview options
 * @returns Filter preview result
 */
export async function collectFilterPreview(
  likedFiles: Array<{ path: string; bytes: number }>,
  filteredCount: number,
  source: string,
  destination: string,
  outputFolder: string,
  options: { force: boolean; convertFormat?: ConvertFormat },
): Promise<FilterPreview> {
  const artistName = path.basename(source);
  const destDir = path.join(destination, artistName, outputFolder);

  const tracks: TrackPreview[] = [];
  let willCopy = 0;
  let willSkip = 0;
  let totalBytes = 0;

  for (const file of likedFiles) {
    const filename = path.basename(file.path);
    const destFilename = getExpectedDestFilename(filename, options.convertFormat);
    const destPath = path.join(destDir, destFilename);

    const exists = await pathExists(destPath);

    if (exists && !options.force) {
      tracks.push({
        sourcePath: file.path,
        destPath,
        action: "skip",
        bytes: 0,
        reason: "exists",
      });
      willSkip++;
    } else {
      tracks.push({
        sourcePath: file.path,
        destPath,
        action: exists ? "overwrite" : "create",
        bytes: file.bytes,
      });
      willCopy++;
      totalBytes += file.bytes;
    }
  }

  return {
    artistName,
    sourcePath: source,
    likedTracks: tracks,
    filteredCount,
    summary: {
      willCopy,
      willSkip,
      totalBytes,
    },
  };
}

/**
 * Formats filter preview output.
 *
 * @param preview - Filter preview to format
 * @param verbose - Whether to show individual files
 * @param maxFiles - Maximum files to show in verbose mode
 */
export function formatFilterPreviewOutput(
  preview: FilterPreview,
  verbose: boolean = false,
  maxFiles: number = 10,
): void {
  console.error(`Source: ${preview.artistName}`);

  if (preview.filteredCount > 0) {
    console.error(colors.gray(`  Filtered out: ${preview.filteredCount} tracks (below threshold)`));
  }

  if (preview.summary.willCopy > 0) {
    console.error(
      colors.green(
        `  Will copy: ${preview.summary.willCopy} tracks (${formatBytes(preview.summary.totalBytes)})`,
      ),
    );
  }

  if (preview.summary.willSkip > 0) {
    console.error(colors.gray(`  Will skip: ${preview.summary.willSkip} tracks (already exist)`));
  }

  if (verbose && preview.likedTracks.length > 0) {
    console.error("  Files:");
    let shown = 0;
    for (const track of preview.likedTracks) {
      if (shown >= maxFiles) {
        const remaining = preview.likedTracks.length - shown;
        console.error(colors.gray(`    ... (${remaining} more files)`));
        break;
      }

      const filename = path.basename(track.sourcePath);
      const actionColor = getActionColor(track.action);
      const symbol = getActionSymbol(track.action);

      if (track.action === "skip") {
        console.error(actionColor(`    ${symbol} ${filename} (skip)`));
      } else {
        console.error(actionColor(`    ${symbol} ${filename} (${formatBytes(track.bytes)})`));
      }
      shown++;
    }
  }
}

/**
 * Formats aggregate filter preview result.
 *
 * @param result - Aggregate filter preview result
 * @param verbose - Whether to show verbose output
 */
export function formatFilterPreviewResult(
  result: FilterPreviewResult,
  verbose: boolean = false,
): void {
  console.error("");
  console.error(colors.bold("=== DRY-RUN PREVIEW ==="));
  console.error("");

  // Use table format for default output, line-by-line for verbose mode
  if (verbose) {
    // Verbose mode: show detailed line-by-line output
    for (const source of result.sources) {
      formatFilterPreviewOutput(source, verbose);
      console.error("");
    }
  } else {
    // Default mode: show table
    const tableOutput = formatFilterPreviewTable(result);
    console.error(tableOutput);
  }

  // Format totals
  console.error(colors.bold("--- Summary ---"));

  const summaryParts: string[] = [];
  if (result.totals.copies > 0) {
    summaryParts.push(`${result.totals.copies} will copy`);
  }
  if (result.totals.skips > 0) {
    summaryParts.push(`${result.totals.skips} will skip`);
  }
  if (result.totals.filtered > 0) {
    summaryParts.push(`${result.totals.filtered} filtered`);
  }

  if (summaryParts.length > 0) {
    console.error(`  ${summaryParts.join(" | ")}`);
  }

  if (result.totals.bytes > 0) {
    console.error(`  Total: ${formatBytes(result.totals.bytes)} to copy`);
  } else {
    console.error(colors.gray("  Nothing to copy"));
  }

  console.error("");
}
