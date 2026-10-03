/**
 * Type definitions for completed source tracking in rfmedia CLI.
 *
 * Enables idempotent copy operations by tracking which sources have been
 * successfully processed. Uses option-aware sidecar files to support
 * resuming operations after interruptions.
 */

import type { DbConnection } from "./db.js";

/**
 * Hash components derived from copy options.
 * Used to create unique tracking filenames for different option combinations.
 *
 * @example
 * // Album mode with range:
 * { mode: 'album', rangeKey: '001-010' }
 *
 * @example
 * // Filter mode with min-rating and conversion:
 * { mode: 'filter', ratingKey: 'r80', convertKey: 'mp3' }
 */
export interface TrackingOptionsHash {
  /** Copy mode type */
  mode: "album" | "filter";
  /** Rating key: 'r{value}' for min-rating or 's{stars}' for min-stars */
  ratingKey?: string;
  /** Range key: '{start}-{end}' formatted */
  rangeKey?: string;
  /** Conversion format key: format name */
  convertKey?: string;
  /** Filter name (for smart filters) */
  filterName?: string;
}

/**
 * Configuration for the tracking system.
 */
export interface TrackingConfig {
  /** Whether tracking is enabled for this operation */
  enabled: boolean;
  /** Path to the completed sources file */
  completedFilePath: string;
  /** Path to the failed sources file */
  failedFilePath: string;
  /** Whether to reset (clear) existing tracking before starting */
  reset: boolean;
  /** Database connection (for database-backed tracking mode) */
  db?: DbConnection;
  /** Operation ID (for database-backed tracking mode) */
  operationId?: number;
}

/**
 * Runtime state of the tracking system.
 */
export interface TrackingState {
  /** Set of completed source paths (normalized) */
  completed: Set<string>;
  /** Set of failed source paths (normalized) */
  failed: Set<string>;
  /** Metadata from the tracking file header */
  metadata?: TrackingMetadata;
  /**
   * Granular album copy tracking state.
   * Maps: source_path -> album_name -> Set<suffix>
   * Used for per-path range expansion support.
   */
  completedAlbumCopies?: Map<string, Map<string, Set<string>>>;
}

/**
 * Information about pending suffixes for an album.
 * Used when determining which suffixes still need to be processed.
 */
export interface PendingSuffixInfo {
  /** Album folder name */
  albumName: string;
  /** Suffixes that are already completed */
  completedSuffixes: Set<string>;
  /** Suffixes that still need processing */
  pendingSuffixes: string[];
}

/**
 * Metadata stored in tracking file headers.
 */
export interface TrackingMetadata {
  /** Original input file path */
  inputFile: string;
  /** ISO timestamp when file was generated */
  generatedAt: string;
  /** Options hash used for this tracking file */
  options: TrackingOptionsHash;
}

/**
 * Statistics for tracking operations, used in enhanced summaries.
 */
export interface TrackingStats {
  /** Total sources in the input file */
  totalSources: number;
  /** Sources that were processed successfully */
  processed: number;
  /** Sources skipped because they were already completed */
  skippedCompleted: number;
  /** Sources that failed during processing */
  failed: number;
  /** Start time of the operation */
  startTime: number;
  /** End time of the operation */
  endTime?: number;
  /** Path to the tracking file (for display) */
  trackingFile?: string;
}

/**
 * Calculated timing statistics from TrackingStats.
 */
export interface TimingStats {
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Formatted elapsed time string (e.g., "2m 45s") */
  elapsedFormatted: string;
  /** Sources processed per minute */
  sourcesPerMinute: number;
}
