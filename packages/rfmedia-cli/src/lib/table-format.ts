/**
 * Table formatting for dry-run preview output.
 *
 * Uses console-table-printer to create clean, structured tables
 * for displaying preview information in a readable format.
 *
 * Width-aware truncation uses the shared terminal-table width-policy
 * utilities to handle Unicode characters (CJK, emoji) correctly.
 */

import { Table } from "console-table-printer";
import type { PreviewResult, FilterPreviewResult, AlbumPreview } from "../types/preview.js";
import { formatBytes } from "./preview.js";
import { truncateToWidth, displayWidth } from "./terminal-table.js";

/**
 * Truncates an album name to a maximum display width using
 * Unicode-aware width measurement.
 *
 * Unlike raw `string.length`, this correctly handles fullwidth
 * characters (CJK), emoji, and ANSI escape codes by measuring
 * visual column width.
 *
 * @param name - Album name to truncate
 * @param maxWidth - Maximum display width in terminal columns
 * @returns Truncated name that fits within the specified display width
 */
function truncateAlbumName(name: string, maxWidth: number): string {
  if (displayWidth(name) <= maxWidth) {
    return name;
  }
  return truncateToWidth(name, maxWidth);
}

/**
 * Calculates total bytes for an album across all suffixes.
 *
 * @param album - Album preview
 * @returns Total bytes for all non-skipped suffixes
 */
function totalBytesForAlbum(album: AlbumPreview): number {
  let total = 0;
  for (const suffix of album.suffixes) {
    if (suffix.action !== "skip") {
      total += suffix.totalBytes;
    }
  }
  return total;
}

/**
 * Determines row color based on album actions.
 *
 * @param album - Album preview
 * @returns Color name for the row
 */
function getAlbumRowColor(album: AlbumPreview): string {
  if (album.summary.willCreate > 0) {
    return "green";
  }
  if (album.summary.willSkip === album.suffixes.length) {
    return "white_bold";
  }
  if (album.summary.willOverwrite > 0 || album.summary.willRecreate > 0) {
    return "yellow";
  }
  return "white";
}

/**
 * Formats album mode preview as a table.
 *
 * @param result - Preview result to format
 * @returns Formatted table as string
 */
export function formatAlbumPreviewTable(result: PreviewResult): string {
  const table = new Table({
    columns: [
      { name: "album", title: "Album", alignment: "left" },
      { name: "create", title: "Create", alignment: "right" },
      { name: "skip", title: "Skip", alignment: "right" },
      { name: "overwrite", title: "Overwrite", alignment: "right" },
      { name: "recreate", title: "Recreate", alignment: "right" },
      { name: "size", title: "Size", alignment: "right" },
    ],
  });

  for (const album of result.albums) {
    const rowColor = getAlbumRowColor(album);
    const totalBytes = totalBytesForAlbum(album);

    table.addRow(
      {
        album: truncateAlbumName(album.albumName, 50),
        create: album.summary.willCreate || "-",
        skip: album.summary.willSkip || "-",
        overwrite: album.summary.willOverwrite || "-",
        recreate: album.summary.willRecreate || "-",
        size: totalBytes > 0 ? formatBytes(totalBytes) : "-",
      },
      { color: rowColor },
    );
  }

  return table.render();
}

/**
 * Formats filter mode album preview (album mode within filter) as a table.
 *
 * @param albums - Array of album data with artist name, album name, and track count
 * @param rangeCount - Number of copies per album (from range)
 * @returns Formatted table as string
 */
export function formatAlbumModePreviewTable(
  albums: Array<{ artistName: string; albumName: string; trackCount: number }>,
  rangeCount: number,
): string {
  const table = new Table({
    columns: [
      { name: "album", title: "Album", alignment: "left" },
      { name: "tracks", title: "Tracks", alignment: "right" },
      { name: "copies", title: "Copies", alignment: "right" },
      { name: "total", title: "Total", alignment: "right" },
    ],
  });

  for (const album of albums) {
    const totalFiles = album.trackCount * rangeCount;
    // Show only album name (artist context is clear from the header)
    const displayName = album.albumName;

    table.addRow(
      {
        album: truncateAlbumName(displayName, 50),
        tracks: album.trackCount,
        copies: rangeCount,
        total: totalFiles,
      },
      { color: "green" },
    );
  }

  return table.render();
}

/**
 * Formats filter mode preview as a table.
 *
 * @param result - Filter preview result to format
 * @returns Formatted table as string
 */
export function formatFilterPreviewTable(result: FilterPreviewResult): string {
  const table = new Table({
    columns: [
      { name: "source", title: "Source", alignment: "left" },
      { name: "copy", title: "Copy", alignment: "right" },
      { name: "skip", title: "Skip", alignment: "right" },
      { name: "filtered", title: "Filtered", alignment: "right" },
      { name: "size", title: "Size", alignment: "right" },
    ],
  });

  for (const source of result.sources) {
    const rowColor = source.summary.willCopy > 0 ? "green" : "white_bold";

    table.addRow(
      {
        source: truncateAlbumName(source.artistName, 40),
        copy: source.summary.willCopy || "-",
        skip: source.summary.willSkip || "-",
        filtered: source.filteredCount || "-",
        size: source.summary.totalBytes > 0 ? formatBytes(source.summary.totalBytes) : "-",
      },
      { color: rowColor },
    );
  }

  return table.render();
}

/**
 * Stats for copy summary table.
 */
export interface CopySummaryStats {
  /** Total number of sources */
  totalSources: number;
  /** Number of successfully processed sources */
  processed: number;
  /** Number of sources skipped because already completed */
  skippedCompleted: number;
  /** Number of sources that failed */
  failed: number;
  /** Number of files created/copied */
  filesCreated: number;
  /** Number of files skipped (already existing) */
  filesSkipped: number;
  /** Number of files filtered out (optional, for filter mode) */
  filesFiltered?: number;
  /** Number of files that failed to copy */
  filesFailed: number;
  /** Formatted elapsed time (e.g., "5s" or "2m 34s") */
  elapsed: string;
  /** Sources processed per minute */
  sourcesPerMin: number;
  /** Optional tracking info string (e.g., "Database (operation #1)") */
  trackingInfo?: string;
}

/**
 * Formats a copy operation summary as tables.
 *
 * Produces two tables:
 * 1. Sources table: Total, Processed, Completed, Skipped, Failed
 * 2. Files table: Total, Created, Existing, Filtered (if applicable), Failed
 *
 * Plus timing and tracking info below.
 *
 * @param stats - Summary statistics for the copy operation
 * @returns Formatted output string
 */
export function formatCopySummaryTable(stats: CopySummaryStats): string {
  const lines: string[] = [];

  // Sources table
  const sourcesTable = new Table({
    columns: [
      { name: "total", title: "Sources", alignment: "right" },
      { name: "processed", title: "Processed", alignment: "right" },
      { name: "skipped", title: "Skipped", alignment: "right" },
      { name: "failed", title: "Failed", alignment: "right" },
    ],
  });

  const sourceColor = stats.failed > 0 ? "yellow" : "green";
  sourcesTable.addRow(
    {
      total: stats.totalSources,
      processed: stats.processed,
      skipped: stats.skippedCompleted,
      failed: stats.failed,
    },
    { color: sourceColor },
  );

  lines.push(sourcesTable.render());
  lines.push("");

  // Files table - include filtered column only if filter mode was used
  const hasFiltered = stats.filesFiltered !== undefined && stats.filesFiltered > 0;

  const filesColumns = [
    { name: "created", title: "Created", alignment: "right" },
    { name: "existing", title: "Existing", alignment: "right" },
  ];

  if (hasFiltered) {
    filesColumns.push({ name: "filtered", title: "Filtered", alignment: "right" });
  }

  filesColumns.push({ name: "failed", title: "Failed", alignment: "right" });

  const filesTable = new Table({ columns: filesColumns });

  const fileColor = stats.filesFailed > 0 ? "yellow" : "green";
  const fileRow: Record<string, number> = {
    created: stats.filesCreated,
    existing: stats.filesSkipped,
    failed: stats.filesFailed,
  };

  if (hasFiltered) {
    fileRow["filtered"] = stats.filesFiltered ?? 0;
  }

  filesTable.addRow(fileRow, { color: fileColor });

  lines.push(filesTable.render());
  lines.push("");

  // Timing info
  lines.push(`Time: ${stats.elapsed} (${stats.sourcesPerMin.toFixed(1)} sources/min)`);

  // Tracking info
  if (stats.trackingInfo) {
    lines.push(`Tracking: ${stats.trackingInfo}`);
  }

  return lines.join("\n");
}

/**
 * Stats for sync summary table.
 */
export interface SyncSummaryStats {
  /** Total number of sources scanned */
  sourcesScanned: number;
  /** Number of new files copied */
  newFilesCopied: number;
  /** Number of updated files copied */
  updatedFilesCopied: number;
  /** Number of unchanged files skipped */
  unchangedSkipped: number;
  /** Number of files deleted (if deleteDowngraded is enabled) */
  deletedFiles: number;
  /** Number of files that failed */
  failedFiles: number;
}

/**
 * Formats a sync operation summary as a table.
 *
 * @param stats - Summary statistics for the sync operation
 * @returns Formatted output string
 */
export function formatSyncSummaryTable(stats: SyncSummaryStats): string {
  const lines: string[] = [];

  // Sources info
  lines.push(`Sources scanned: ${stats.sourcesScanned}`);
  lines.push("");

  // Files table
  const filesTable = new Table({
    columns: [
      { name: "new", title: "New", alignment: "right" },
      { name: "updated", title: "Updated", alignment: "right" },
      { name: "unchanged", title: "Unchanged", alignment: "right" },
      { name: "deleted", title: "Deleted", alignment: "right" },
      { name: "failed", title: "Failed", alignment: "right" },
    ],
  });

  const fileColor = stats.failedFiles > 0 ? "yellow" : "green";
  filesTable.addRow(
    {
      new: stats.newFilesCopied,
      updated: stats.updatedFilesCopied,
      unchanged: stats.unchangedSkipped,
      deleted: stats.deletedFiles,
      failed: stats.failedFiles,
    },
    { color: fileColor },
  );

  lines.push(filesTable.render());

  return lines.join("\n");
}

/**
 * Stats for delete summary table.
 */
export interface DeleteSummaryStats {
  /** Total number of sources processed */
  sourcesProcessed: number;
  /** Total number of files/folders deleted */
  deleted: number;
  /** Number of tracking entries removed */
  trackingRemoved: number;
  /** Number of operations that failed */
  failed: number;
}

/**
 * Formats a delete operation summary as a table.
 *
 * @param stats - Summary statistics for the delete operation
 * @returns Formatted output string
 */
export function formatDeleteSummaryTable(stats: DeleteSummaryStats): string {
  const lines: string[] = [];

  // Delete summary table
  const deleteTable = new Table({
    columns: [
      { name: "sources", title: "Sources", alignment: "right" },
      { name: "deleted", title: "Deleted", alignment: "right" },
      { name: "tracking", title: "Tracking", alignment: "right" },
      { name: "failed", title: "Failed", alignment: "right" },
    ],
  });

  const rowColor = stats.failed > 0 ? "yellow" : "green";
  deleteTable.addRow(
    {
      sources: stats.sourcesProcessed,
      deleted: stats.deleted,
      tracking: stats.trackingRemoved,
      failed: stats.failed,
    },
    { color: rowColor },
  );

  lines.push(deleteTable.render());

  return lines.join("\n");
}
