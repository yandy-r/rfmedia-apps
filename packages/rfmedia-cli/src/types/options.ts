/**
 * Options type definitions for rfmedia CLI commands.
 */

import type { OutputFormat } from "@rfmedia/common";
import type { ConflictStrategy } from "./conflict.js";
import type { SmartFilter } from "./filters.js";
import type { PlanPreviewCapture } from "./plan.js";

/**
 * Range specification for copy suffixes.
 * Used with --range option to create numbered album copies.
 *
 * @example
 * // --range=001-010 produces:
 * // { start: 1, end: 10, padWidth: 3 }
 */
export interface CopyRange {
  /** First suffix number (e.g., 1 for "001") */
  start: number;
  /** Last suffix number (e.g., 10 for "010") */
  end: number;
  /** Zero-padding width derived from input format (e.g., 3 for "001") */
  padWidth: number;
}

/**
 * Rating filter configuration for track-based copying.
 * Used in filter mode to copy only tracks meeting a rating threshold.
 */
export interface RatingFilter {
  /** Minimum star rating threshold (1.0-5.0, supports half-stars like 3.5) */
  minStars?: number;
  /** Minimum rating threshold on 0-100 percentage scale */
  minRating?: number;
  /** Output folder name for filtered tracks (default: "liked-songs") */
  outputFolder: string;
  /** Whether to preserve album subfolders in output structure */
  preserveStructure: boolean;
  /** Optional range for creating numbered copies of filtered tracks */
  range?: CopyRange;
  /** Preserve album structure with only liked tracks; range applies to album folders */
  albumMode?: boolean;

  // Metadata filtering options
  /** Minimum duration in seconds (parsed from MM:SS format on CLI) */
  minDuration?: number;
  /** Maximum duration in seconds (parsed from MM:SS format on CLI) */
  maxDuration?: number;
  /** Minimum bitrate in kbps */
  minBitrate?: number;
  /** Required codec (case-insensitive match against format.codec) */
  codec?: string;
  /** Minimum play count from POPM counter (MP3 only) */
  minPlays?: number;

  // Smart filter options (nested boolean logic)
  /** Smart filter with nested boolean rules for advanced filtering */
  smartFilter?: SmartFilter;
  /** Name of the filter used (for logging and dry-run output) */
  filterName?: string;
}

/**
 * Discriminated union for copy command modes.
 * The copy command operates in one of two mutually exclusive modes.
 */
export type CopyMode =
  | { type: "album"; range: CopyRange }
  | { type: "filter"; rating: RatingFilter };

/**
 * Supported audio conversion formats.
 */
export type ConvertFormat = "alac" | "mp3" | "aac" | "opus";

/**
 * Verification confidence level used by the verify command.
 */
export type VerificationTier = "quick" | "default" | "deep";

/**
 * Options for the copy command.
 */
export interface CopyOptions {
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
  /** Strategy for handling file conflicts during copy operations */
  conflictStrategy?: ConflictStrategy;
  /** Preview actions without making filesystem changes */
  dryRun: boolean;
  /** Number of parallel workers for conversion (future) */
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
  /**
   * Verify file integrity after copy using SHA-256 checksum.
   */
  verify?: boolean;
  /**
   * Range explicitly provided via CLI --range option.
   * When set, this range applies to ALL paths and overrides per-path and config ranges.
   * Used by file-input processing to determine range precedence.
   */
  cliRange?: CopyRange;
  /**
   * Default range from config file (lowest priority).
   * Used when neither CLI --range nor per-path range is specified.
   */
  configRange?: CopyRange;
  /**
   * Number of copies to create with auto-detected range.
   * Mutually exclusive with cliRange - converted to range internally.
   */
  count?: number;
  /**
   * Source entries provided directly via CLI arguments (not from --file).
   * When set, these paths (with optional ranges) are used instead of reading from a file.
   * Used by executeAlbumCopyWithFileInput to handle multi-source CLI input.
   */
  cliSourceEntries?: PathEntry[];
  /**
   * Show detailed file-level preview in dry-run mode.
   * When true, shows individual files that would be copied.
   */
  verbose?: boolean;
  /**
   * Interactive selection data (populated when --interactive is used).
   * Does not affect tracking hash computation.
   */
  selection?: CopySelection;

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
  /**
   * Runtime-only plan-generation hook (never serialized, like `selection`).
   * Invoked by the dry-run preview branches with the structured preview.
   */
  capturePreview?: (capture: PlanPreviewCapture) => void;
  /**
   * Runtime-only hook (never serialized). Invoked with the history session id
   * when a recorder is created, so plan-apply can link audit -> undo.
   */
  onHistorySession?: (id: string) => void;
}

/**
 * Options for the verify command.
 */
export interface VerifyOptions {
  /** Verify mode: album-based (--range) or rating-based (--min-stars/--min-rating) */
  mode: CopyMode;
  /** Effective verification confidence level */
  tier: VerificationTier;
  /** Treat source as a single album, not an artist folder */
  albumOnly: boolean;
  /** Audio conversion format expected in destination (affects filename matching) */
  convertFormat?: ConvertFormat;
  /** Preview mode (no-op for verify, kept for consistency) */
  dryRun: boolean;
  /** Number of parallel workers for verification */
  workers: number;
  /** Path to a file containing source paths (one per line) */
  file?: string;
  /** Path to the existing tracking database used for stored fingerprint evidence */
  trackingDatabase?: string;
  /** Show visual progress bar with ETA (undefined = auto-detect based on TTY) */
  progress?: boolean;
  /** Enable file size verification in addition to existence checks */
  verifySize?: boolean;
  /** Enable automatic fixing of discrepancies (re-copy missing files, remove extra files) */
  fix?: boolean;
  /** Skip confirmation prompts when fixing (use with --fix) */
  force?: boolean;
  /** Move extra files to trash instead of permanent deletion (use with --fix) */
  trash?: boolean;
  /** Strategy for handling file conflicts during fix operations */
  conflictStrategy?: ConflictStrategy;
  /**
   * Range explicitly provided via CLI --range option.
   * When set, this range applies to ALL paths and overrides per-path and config ranges.
   */
  cliRange?: CopyRange;
  /**
   * Default range from config file (lowest priority).
   * Used when neither CLI --range nor per-path range is specified.
   */
  configRange?: CopyRange;
  /**
   * Source entries provided directly via CLI arguments (not from --file).
   * When set, these paths (with optional ranges) are used instead of reading from a file.
   */
  cliSourceEntries?: PathEntry[];
}

/**
 * Options for the clean command.
 */
export interface CleanOptions {
  /** Skip confirmation prompt */
  force: boolean;
  /** Preview deletions without making filesystem changes */
  dryRun: boolean;
  /** Delete albums with fewer than N audio files */
  minFiles?: number;
  /** Delete albums older than N days (future) */
  olderThan?: number;
  /**
   * Maximum directory depth to scan.
   * - `undefined` uses default depth of 2 (backward-compatible Artist/Album scan)
   * - `0` means unlimited recursive depth
   * - Any positive integer N means scan up to N levels deep
   */
  depth?: number;
  /** Patterns to exclude from deletion */
  exclude?: string[];
  /** Path to file containing patterns to protect from deletion */
  protect?: string;
  /** Move to trash instead of permanent delete */
  useTrash: boolean;
}

/**
 * Global CLI options available to all commands.
 */
export interface GlobalOptions {
  /** Preview actions without making filesystem changes */
  dryRun: boolean;
  /** Enable verbose debug output */
  debug: boolean;
  /** Output results in JSON format for scripting */
  json: boolean;
  /** Output format for structured output (json, yaml, csv, table, text) */
  output?: OutputFormat;
}

/**
 * Represents a path entry from an input file, with optional per-path range or count.
 *
 * When reading paths from a file, each line can optionally include a suffix:
 * - Range format: `path,START-END` (e.g., `/music/Artist/Album,001-005`)
 * - Count format: `path,N` (e.g., `/music/Artist/Album,4`)
 *
 * Precedence for range resolution:
 * 1. CLI `--range` option (highest priority - overrides all)
 * 2. CLI `--count` option (auto-detect per source)
 * 3. Per-path count from file (this property)
 * 4. Per-path range from file (this property)
 * 5. Config file default range (lowest priority)
 *
 * Per-source options precedence (for YAML paths):
 * 1. Per-source YAML value (highest priority)
 * 2. YAML defaults section
 * 3. CLI options
 * 4. Config file defaults (lowest priority)
 */
export interface PathEntry {
  /** The source path */
  path: string;
  /** Optional range parsed from the file (format: START-END) */
  range?: CopyRange;
  /** Optional count parsed from the file (auto-detect next N items) */
  count?: number;
  /** Optional filter name for this source (from YAML --paths) */
  filterName?: string;
  /** Optional output folder override for this source (from YAML --paths) */
  outputFolder?: string;
  /** Optional audio conversion format for this source (from YAML --paths) */
  convertFormat?: ConvertFormat;
  /** Resolved source names for unified --source-name selection (groups + artist + basename) */
  sourceNames?: string[];
  /** Group names for --group selection (from YAML groups field) */
  sourceGroups?: string[];
  /** Artist name for --artist selection (from YAML artist field) */
  sourceArtist?: string;
  /** 1-based index in original sources array (for --source-idx selection) */
  sourceIndex?: number;
}

/**
 * Represents a source entry in a paths YAML file.
 *
 * Each source specifies a path and optionally a count or range for copies.
 * Per-source options (filter, outputFolder, convert) override YAML defaults and CLI options.
 *
 * @example
 * ```yaml
 * - groups: pop-divas         # Group identifier(s) for --group selection
 *   artist: Britney Spears    # Artist name for --artist selection
 *   path: /data/media/music/Artist Name (uuid)
 *   count: 5
 *   filter: liked
 * - groups:                   # Multiple groups for a single source
 *     - pop-divas
 *     - latin-divas
 *   artist: Shakira
 *   path: /data/media/music/Shakira (uuid)
 *   range: 001-003
 *   filter: rock-classics
 *   outputFolder: rock-tracks
 *   convert: alac
 * ```
 */
export interface PathsYamlSource {
  /** Source directory path (required) */
  path: string;
  /** Group identifier(s) for --group selection (string or array of strings) */
  groups?: string | string[];
  /** Number of copies to create with auto-detected range */
  count?: number;
  /** Explicit range string (e.g., "001-005") */
  range?: string;
  /** Smart filter name to use for this source (overrides defaults and CLI) */
  filter?: string;
  /** Output folder name for filtered tracks (overrides defaults and CLI) */
  outputFolder?: string;
  /** Audio conversion format: alac, mp3, aac, opus (overrides defaults and CLI) */
  convert?: ConvertFormat;
  /** Artist name for --artist selection (also used as fallback for --source-name) */
  artist?: string;
  /** Source type metadata (for documentation, not currently processed) */
  type?: string;
  /** Media type metadata (for documentation, not currently processed) */
  media?: string;
}

/**
 * Default options that apply to all sources in a paths YAML file.
 *
 * Sources can override any of these defaults with per-source values.
 * YAML defaults take precedence over CLI options.
 *
 * @example
 * ```yaml
 * defaults:
 *   filter: liked
 *   count: 5
 *   outputFolder: liked-tracks
 *   convert: mp3
 * ```
 */
export interface PathsYamlDefaults {
  /** Default smart filter name for all sources */
  filter?: string;
  /** Default number of copies for all sources */
  count?: number;
  /** Default range string for all sources */
  range?: string;
  /** Default output folder name for all sources */
  outputFolder?: string;
  /** Default audio conversion format for all sources */
  convert?: ConvertFormat;
}

/**
 * Structure of a paths YAML file for the --paths option.
 *
 * Provides a single-file alternative to combining --file with positional arguments.
 * Contains destination, optional defaults, and source paths with their configurations.
 *
 * @example
 * ```yaml
 * destination: /data/media/music-manual
 * defaults:
 *   filter: liked
 *   count: 5
 * sources:
 *   - path: /data/media/music/Artist
 *     # Uses defaults: filter=liked, count=5
 *   - path: /data/media/music/Another Artist
 *     filter: rock-classics
 *     # Override filter, uses default count=5
 * ```
 */
export interface PathsYamlFile {
  /** Destination directory for all copy operations */
  destination: string;
  /** Default options applied to all sources (can be overridden per-source) */
  defaults?: PathsYamlDefaults;
  /** Array of source entries with paths and optional range/count/filter/etc */
  sources: PathsYamlSource[];
}

/**
 * Parsed result from a paths YAML file.
 *
 * Converts PathsYamlSource entries to PathEntry format for use with existing
 * copy/sync action handlers.
 */
export interface ParsedPathsYaml {
  /** Destination directory from the YAML file */
  destination: string;
  /** Source entries converted to PathEntry format */
  sources: PathEntry[];
}

/**
 * Options for the migrate-tracking command.
 */
export interface MigrateOptions {
  /** Remove legacy files after successful migration */
  deleteOld: boolean;
  /** Skip confirmation prompts */
  force: boolean;
  /** Only migrate tracking files (skip history) */
  trackingOnly: boolean;
  /** Only migrate history files (skip tracking) */
  historyOnly: boolean;
  /** Custom history directory (default: ~/.rfmedia/history) */
  historyPath?: string;
  /** Preview actions without making filesystem changes */
  dryRun: boolean;
}

/**
 * Date filter string for history queries.
 * Supports ISO date format or relative dates like "7 days ago".
 */
export type DateFilter = string;

/**
 * Options for the stats command.
 */
export interface StatsOptions {
  /** Custom path to SQLite tracking database */
  trackingDatabase?: string;
  /** Preview mode (no-op for stats, kept for consistency) */
  dryRun: boolean;
}

/**
 * Options for the history command.
 */
export interface HistoryOptions {
  /** Start date filter (ISO format or relative like "7 days ago") */
  from?: DateFilter;
  /** End date filter (ISO format or relative) */
  to?: DateFilter;
  /** Filter by copy mode */
  mode?: "album" | "filter";
  /** Filter by operation status */
  status?: "pending" | "completed" | "failed" | "partial";
  /** Filter by command type */
  command?: "copy-album" | "copy-filter" | "sync";
  /** Maximum number of results to return */
  limit: number;
  /** Highlight duplicate operations with same options_hash */
  showDuplicates: boolean;
  /** Custom path to SQLite tracking database */
  trackingDatabase?: string;
  /** Preview mode (no-op for history, kept for consistency) */
  dryRun: boolean;
}

/**
 * Discriminated union for delete command modes.
 * The delete command operates in one of two mutually exclusive modes,
 * mirroring the copy command's modes.
 */
export type DeleteMode =
  | { type: "album"; range?: CopyRange }
  | { type: "filter"; rating: RatingFilter };

/**
 * Selection granularity for interactive mode.
 */
export type SelectionLevel = "album" | "track";

/**
 * Per-source selection data from interactive mode.
 */
export interface SourceSelection {
  /** Source path this selection applies to */
  readonly sourcePath: string;
  /** Selection level: album-level or track-level */
  readonly level: SelectionLevel;
  /** Selected album names (when level='album') */
  readonly selectedAlbums?: readonly string[];
  /** Selected track relative paths (when level='track') */
  readonly selectedTracks?: readonly string[];
}

/**
 * Complete selection from interactive mode.
 * Attached to CopyOptions when --interactive is used.
 */
export interface CopySelection {
  /** Selected source paths (subset of original sources) */
  readonly selectedSources: readonly string[];
  /** Per-source refinements (optional, missing = use all) */
  readonly sourceSelections: ReadonlyMap<string, SourceSelection>;
}

/**
 * Per-source selection data from interactive delete mode.
 */
export interface DeleteSourceSelection {
  /** Source path this selection applies to */
  readonly sourcePath: string;
  /** Selected destination suffix paths to delete (full paths) */
  readonly selectedSuffixes: readonly string[];
}

/**
 * Complete selection from interactive delete mode.
 * Attached to DeleteOptions when --interactive is used.
 */
export interface DeleteSelection {
  /** Selected source paths (subset of original sources) */
  readonly selectedSources: readonly string[];
  /** Per-source suffix selections (paths to delete from destination) */
  readonly sourceSelections: ReadonlyMap<string, DeleteSourceSelection>;
}

/**
 * Options for the delete command.
 *
 * The delete command removes previously copied files from the destination,
 * with support for the same filtering options as the copy command.
 * Key behaviors:
 * - Reverse order processing: When --count=5, deletes highest suffixes first
 * - Database tracking: Removes entries from completed_album_copies
 * - History support: Records deletions for potential undo
 */
export interface DeleteOptions {
  /** Delete mode: album-based (--range) or rating-based (--min-stars/--min-rating) */
  mode: DeleteMode;
  /** Treat source as a single album, not an artist folder */
  albumOnly: boolean;
  /** Audio conversion format that was used during copy (affects filename matching) */
  convertFormat?: ConvertFormat;
  /** Skip confirmation prompt */
  force: boolean;
  /** Preview actions without making filesystem changes */
  dryRun: boolean;
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
  /**
   * Range explicitly provided via CLI --range option.
   * Specifies which suffixes to delete (e.g., 008-010).
   */
  cliRange?: CopyRange;
  /**
   * Default range from config file (lowest priority).
   * Used when neither CLI --range nor per-path range is specified.
   */
  configRange?: CopyRange;
  /**
   * Number of copies to delete with auto-detected range.
   * Deletes the N highest suffixes (reverse order from copy).
   * Mutually exclusive with cliRange.
   */
  count?: number;
  /**
   * Source entries provided directly via CLI arguments (not from --file).
   * When set, these paths (with optional ranges) are used instead of reading from a file.
   */
  cliSourceEntries?: PathEntry[];
  // Plex integration options
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
  /**
   * Interactive selection data (populated when --interactive is used).
   * Does not affect tracking hash computation.
   */
  selection?: DeleteSelection;

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
