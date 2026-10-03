/**
 * Type definitions for non-destructive preview (dry-run) output.
 *
 * These types support detailed file-by-file previews with before/after
 * comparisons, similar to Terraform's plan output.
 */

import type { CopyRange, ConvertFormat } from "./options.js";

/**
 * Action that would be taken for a suffix copy.
 *
 * - create: Destination doesn't exist, will be created
 * - skip: Destination exists and is complete
 * - overwrite: Destination exists but --force will overwrite
 * - incomplete: Destination exists but is incomplete (missing files)
 */
export type PreviewAction = "create" | "skip" | "overwrite" | "incomplete";

/**
 * Preview info for a single album-suffix combination.
 *
 * @example
 * {
 *   suffix: '001',
 *   destPath: '/dest/Artist/Album-001',
 *   action: 'create',
 *   fileCount: 50,
 *   totalBytes: 367001600  // 350MB
 * }
 */
export interface AlbumSuffixPreview {
  /** Formatted suffix string (e.g., "001") */
  suffix: string;
  /** Full destination path for this copy */
  destPath: string;
  /** Action that would be taken */
  action: PreviewAction;
  /** Human-readable reason for the action (e.g., "already exists", "incomplete (3/50 files)") */
  reason?: string;
  /** Number of files that would be copied */
  fileCount: number;
  /** Total bytes that would be copied */
  totalBytes: number;
  /** Number of existing files (for incomplete destinations) */
  existingFiles?: number;
}

/**
 * Preview info for an entire album across all suffixes in the range.
 */
export interface AlbumPreview {
  /** Album folder name (without artist path) */
  albumName: string;
  /** Full source path to the album */
  sourcePath: string;
  /** Preview results for each suffix in the range */
  suffixes: AlbumSuffixPreview[];
  /** Summary counts for this album */
  summary: {
    /** Number of suffixes that will be created */
    willCreate: number;
    /** Number of suffixes that will be skipped (already exist) */
    willSkip: number;
    /** Number of suffixes that will be overwritten (--force) */
    willOverwrite: number;
    /** Number of suffixes that are incomplete */
    willRecreate: number;
  };
}

/**
 * Aggregate preview result for the entire copy operation.
 *
 * Contains all albums being processed and aggregate totals.
 */
export interface PreviewResult {
  /** Preview results for each album */
  albums: AlbumPreview[];
  /** Aggregate totals across all albums */
  totals: {
    /** Total files that would be copied */
    files: number;
    /** Total bytes that would be copied */
    bytes: number;
    /** Total suffix copies that will be created */
    creates: number;
    /** Total suffix copies that will be skipped */
    skips: number;
    /** Total suffix copies that will be overwritten */
    overwrites: number;
    /** Total suffix copies that are incomplete and will be recreated */
    recreates: number;
  };
}

/**
 * Preview info for a single track in filter mode.
 */
export interface TrackPreview {
  /** Source file path */
  sourcePath: string;
  /** Destination file path */
  destPath: string;
  /** Action that would be taken */
  action: PreviewAction;
  /** File size in bytes */
  bytes: number;
  /** Reason for action (e.g., "exists", "filtered") */
  reason?: string;
}

/**
 * Preview info for filter mode, grouped by output folder.
 */
export interface FilterPreview {
  /** Artist name (source folder basename) */
  artistName: string;
  /** Source directory path */
  sourcePath: string;
  /** Tracks that passed the filter */
  likedTracks: TrackPreview[];
  /** Number of tracks filtered out (below threshold) */
  filteredCount: number;
  /** Summary counts */
  summary: {
    /** Tracks that will be copied */
    willCopy: number;
    /** Tracks that will be skipped (already exist) */
    willSkip: number;
    /** Total bytes to copy */
    totalBytes: number;
  };
}

/**
 * Aggregate preview result for filter mode copy operation.
 */
export interface FilterPreviewResult {
  /** Preview results per source */
  sources: FilterPreview[];
  /** Aggregate totals */
  totals: {
    /** Total tracks that will be copied */
    copies: number;
    /** Total tracks skipped (existing) */
    skips: number;
    /** Total tracks filtered out */
    filtered: number;
    /** Total bytes to copy */
    bytes: number;
  };
}

/**
 * Options for collecting preview information.
 */
export interface PreviewOptions {
  /** Range of suffixes to preview */
  range: CopyRange;
  /** Whether --force mode is enabled */
  force: boolean;
  /** Whether to use hardlinks */
  hardlink: boolean;
  /** Audio conversion format (affects file extension matching) */
  convertFormat?: ConvertFormat;
  /** Whether to collect file-level details (for --verbose) */
  verbose?: boolean;
}

/**
 * Options for formatting preview output.
 */
export interface PreviewFormatOptions {
  /** Show file-level details */
  verbose?: boolean;
  /** Maximum files to show per suffix in verbose mode */
  maxFilesShown?: number;
}
