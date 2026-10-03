/**
 * Type definitions for watch mode in rfmedia CLI.
 *
 * Watch mode monitors directories for new content and auto-processes
 * using existing copy logic (album or filter mode).
 */

import type { CopyRange } from "./options.js";

/**
 * Options for watch mode operation.
 *
 * Watch mode operates in one of two copy modes:
 * - album: Copies entire albums with numbered suffixes
 * - filter: Copies tracks meeting a rating threshold
 */
export interface WatchOptions {
  /** Source directory to watch for new content */
  source: string;
  /** Destination directory for copied content */
  destination: string;
  /** Copy mode: album-based or filter-based */
  mode: "album" | "filter";

  // Album mode options
  /** Range of suffixes to create (album mode) */
  range?: CopyRange;
  /** Treat detected folders as single albums, not artist folders */
  albumOnly?: boolean;

  // Filter mode options
  /** Minimum star rating threshold (1-5 stars) for filter mode */
  minStars?: number;
  /** Minimum rating threshold (0-100 percentage) for filter mode */
  minRating?: number;
  /** Output folder name for filtered tracks (default: "liked-songs") */
  outputFolder?: string;
  /** Whether to preserve album subfolders in filter mode output */
  preserveStructure?: boolean;

  // Common options
  /** Use hardlinks instead of file copies */
  hardlink?: boolean;
  /** Debounce delay in milliseconds before processing (default: 5000) */
  debounceMs?: number;
  /** Enable debug output */
  debug?: boolean;

  // Plex integration options
  /** Enable Plex library scan after successful copy */
  plexScan?: boolean;
}

/**
 * Extensions for partial/incomplete downloads that should be ignored.
 */
export const IGNORED_EXTENSIONS = [
  ".part",
  ".tmp",
  ".crdownload",
  ".download",
  ".partial",
] as const;

/**
 * Type representing an ignored file extension.
 */
export type IgnoredExtension = (typeof IGNORED_EXTENSIONS)[number];

/**
 * Result of watch mode processing a single change event.
 */
export interface WatchProcessResult {
  /** Type of content that was processed */
  type: "artist" | "album" | "file";
  /** Path that triggered the processing */
  path: string;
  /** Number of items created */
  created: number;
  /** Number of items skipped */
  skipped: number;
  /** Number of items filtered (filter mode only) */
  filtered: number;
  /** Error message if processing failed */
  error?: string;
}
