/**
 * Queue type definitions for batch job management.
 */

import type { CopyMode, CopyRange, ConvertFormat, PathEntry, DeleteMode } from "./options.js";

/**
 * Job type discriminator for queue jobs.
 */
export type QueueJobType = "copy" | "delete";

/**
 * Status of a queued job.
 */
export type QueueJobStatus = "pending" | "running" | "completed" | "failed";

/**
 * Serializable subset of CopyOptions for queue storage.
 *
 * Excludes non-serializable fields like `selection` (contains ReadonlyMap)
 * and `dryRun` (determined at run time).
 *
 * @see CopyOptions for the full options interface
 */
export interface SerializableCopyOptions {
  /** Copy mode: album-based (--range) or rating-based (--min-stars/--min-rating) */
  mode: CopyMode;
  /** Treat source as a single album, not an artist folder */
  albumOnly: boolean;
  /** Use hardlinks instead of file copies (same filesystem required) */
  hardlink: boolean;
  /** Audio conversion format for transcoding audio files (requires ffmpeg) */
  convertFormat?: ConvertFormat;
  /** Overwrite existing copies even if complete */
  force: boolean;
  /** Number of parallel workers for conversion */
  workers: number;
  /** Path to a file containing source paths (one per line) */
  file?: string;
  /** Path to a YAML file containing sources and destination (--paths option) */
  paths?: string;
  /** Show visual progress bar with ETA (undefined = auto-detect based on TTY) */
  progress?: boolean;
  /** Track completed sources in sidecar file for resume support */
  trackCompleted?: boolean;
  /** Custom path for the completed tracking file */
  completedFile?: string;
  /** Clear existing tracking and restart fresh */
  resetCompleted?: boolean;
  /** Plex scan override: true=force scan, false=disable scan, undefined=use config */
  plexScan?: boolean;
  /** Plex server URL override */
  plexUrl?: string;
  /** Plex token override */
  plexToken?: string;
  /** Plex library name override */
  plexLibrary?: string;
  /** Scan Plex after each source instead of at end of batch */
  plexPerSource?: boolean;
  /** Custom path to SQLite tracking database */
  trackingDatabase?: string;
  /** Use legacy file-based tracking instead of database */
  useLegacyTracking?: boolean;
  /** Disk space behavior: true=abort, false=skip check, undefined=warn only */
  requireDiskSpace?: boolean;
  /** Range explicitly provided via CLI --range option */
  cliRange?: CopyRange;
  /** Default range from config file (lowest priority) */
  configRange?: CopyRange;
  /** Number of copies to create with auto-detected range */
  count?: number;
  /** Source entries provided directly via CLI arguments */
  cliSourceEntries?: PathEntry[];
  /** Show detailed file-level preview in dry-run mode */
  verbose?: boolean;
  // Note: selection is intentionally excluded (not JSON serializable)

  // Source selection tracking fields (for display in queue list --verbose)
  // These document what selection was applied at add time; actual filtering
  // happens at add time and results are stored in cliSourceEntries.

  /** Stores the --source-idx selection used at add time */
  sourceIdx?: string;
  /** Stores the --source-name selection used at add time */
  sourceName?: string;
  /** Stores the --artist selection used at add time */
  sourceArtist?: string;
  /** Stores the --group selection used at add time */
  sourceGroup?: string;
}

/**
 * Serializable subset of DeleteOptions for queue storage.
 *
 * Excludes non-serializable fields like `selection` (contains ReadonlyMap)
 * and `dryRun` (determined at run time).
 *
 * @see DeleteOptions for the full options interface
 */
export interface SerializableDeleteOptions {
  /** Delete mode: album-based (--range) or rating-based (--min-stars/--min-rating) */
  mode: DeleteMode;
  /** Treat source as a single album, not an artist folder */
  albumOnly: boolean;
  /** Audio conversion format that was used during copy (affects filename matching) */
  convertFormat?: ConvertFormat;
  /** Skip confirmation prompt */
  force: boolean;
  /** Number of parallel workers for deletion */
  workers: number;
  /** Path to a file containing source paths (one per line) */
  file?: string;
  /** Show visual progress bar with ETA (undefined = auto-detect based on TTY) */
  progress?: boolean;
  /** Move to trash instead of permanent delete */
  useTrash: boolean;
  /** Keep database tracking entries (don't allow re-copy to the same paths) */
  keepTracking: boolean;
  /** Custom path to SQLite tracking database */
  trackingDatabase?: string;
  /** Use legacy file-based tracking instead of database */
  useLegacyTracking?: boolean;
  /** Range explicitly provided via CLI --range option */
  cliRange?: CopyRange;
  /** Default range from config file (lowest priority) */
  configRange?: CopyRange;
  /** Number of copies to delete with auto-detected range */
  count?: number;
  /** Source entries provided directly via CLI arguments */
  cliSourceEntries?: PathEntry[];
  /** Trigger Plex library scan after delete */
  plexScan?: boolean;
  /** Plex server URL */
  plexUrl?: string;
  /** Plex authentication token */
  plexToken?: string;
  /** Plex library name to scan */
  plexLibrary?: string;
  /** Scan Plex after each source instead of at end */
  plexPerSource?: boolean;
  // Note: selection is intentionally excluded (not JSON serializable)

  // Source selection tracking fields (for display in queue list --verbose)
  /** Stores the --source-idx selection used at add time */
  sourceIdx?: string;
  /** Stores the --source-name selection used at add time */
  sourceName?: string;
  /** Stores the --artist selection used at add time */
  sourceArtist?: string;
  /** Stores the --group selection used at add time */
  sourceGroup?: string;
}

/**
 * A queued job (copy or delete).
 *
 * Jobs are stored in the queue file at ~/.rfmedia/queue.json and
 * executed by the `queue run` command.
 *
 * **Job Type**:
 * The `jobType` field discriminates between copy and delete operations.
 *
 * **Source Specification**:
 * Either `source` (single path) or `sources` (multi-path from --paths/--file) will be set.
 * At runtime, one of these must be present - this invariant is enforced during job creation.
 *
 * - `source`: Used for single-path jobs (traditional CLI usage)
 * - `sources`: Used for multi-path jobs (from YAML --paths or interactive selection)
 */
export interface QueueJob {
  /** Unique job identifier (UUID) */
  id: string;
  /** Job type discriminator (copy or delete) */
  jobType: QueueJobType;
  /** ISO timestamp when the job was added to the queue */
  addedAt: string;
  /**
   * Source path for single-source operations.
   * Optional when `sources` is provided for multi-source jobs.
   * @see sources for multi-path jobs
   */
  source?: string;
  /**
   * Source entries for multi-source operations.
   * Used when job was created from --paths YAML file or --file with multiple entries.
   * PathEntry is serializable (no Maps or non-JSON types).
   * @see source for single-path jobs
   */
  sources?: PathEntry[];
  /** Destination path for the operation */
  destination: string;
  /** Operation options (serializable subset) */
  options: SerializableCopyOptions | SerializableDeleteOptions;
  /** Current job status */
  status: QueueJobStatus;
  /** ISO timestamp when the job started running (optional) */
  startedAt?: string;
  /** ISO timestamp when the job completed or failed (optional) */
  completedAt?: string;
  /** Error message if the job failed (optional) */
  error?: string;
}

/**
 * Queue file format stored at ~/.rfmedia/queue.json.
 *
 * Contains version information and all queued jobs.
 */
export interface QueueFile {
  /** Schema version for forward compatibility */
  version: "1";
  /** ISO timestamp when the queue was last updated */
  updatedAt: string;
  /** Array of queued jobs */
  jobs: QueueJob[];
}

/**
 * Options for the `queue add copy` command.
 */
export interface QueueAddOptions {
  /** Preview mode (don't actually add to queue) */
  dryRun: boolean;
}

/**
 * Options for the `queue list` command.
 */
export interface QueueListOptions {
  /** Filter jobs by status (undefined = show all) */
  status?: QueueJobStatus;
  /** Show detailed job information */
  verbose: boolean;
}

/**
 * Options for the `queue run` command.
 */
export interface QueueRunOptions {
  /** Number of parallel job workers */
  workers: number;
  /** Continue running jobs after failures */
  continueOnError: boolean;
  /** Trigger Plex scan after completion (overrides per-job settings) */
  plexScan?: boolean;
  /** Preview mode (show what would run without executing) */
  dryRun: boolean;
}

/**
 * Options for the `queue clear` command.
 */
export interface QueueClearOptions {
  /** Filter which jobs to clear by status (undefined = clear all) */
  status?: QueueJobStatus;
  /** Skip confirmation prompt */
  force: boolean;
  /** Preview mode (show what would be cleared) */
  dryRun: boolean;
}

/**
 * Result from the `queue run` command.
 */
export interface QueueRunResult {
  /** Total number of jobs that were processed */
  total: number;
  /** Number of jobs that completed successfully */
  completed: number;
  /** Number of jobs that failed */
  failed: number;
  /** Per-job result details */
  jobs: Array<{
    /** Job ID */
    id: string;
    /** Source path for the job */
    source: string;
    /** Final job status */
    status: QueueJobStatus;
    /** Error message if the job failed */
    error?: string;
  }>;
}

/**
 * Result from the `queue clear` command.
 */
export interface QueueClearResult {
  /** Number of jobs removed from the queue */
  removed: number;
  /** Number of jobs remaining in the queue */
  remaining: number;
}
