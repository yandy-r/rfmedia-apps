/**
 * Configuration file type definitions for rfmedia CLI.
 *
 * Users can define default options via JSON config files at multiple locations.
 * CLI options always take precedence over config file values.
 */

import type { ConflictStrategy } from "./conflict.js";
import type { FiltersConfigOptions } from "./filters.js";
import type { MediaFiltersConfigOptions } from "./media-filters.js";
import type { PolicyDecisionEvidenceFingerprint, PolicyDecisionKey } from "./lidarr-policy.js";
import type { ConvertFormat } from "./options.js";
import type {
  LidarrPresetCapability,
  LidarrPresetCustomFormat,
  LidarrPresetNaming,
  LidarrPresetQualityProfile,
} from "./lidarr-presets.js";

/**
 * Root configuration file structure.
 * Each command can have its own section with default options.
 */
export interface ConfigFile {
  /** Copy command default options */
  copy?: CopyConfigOptions;
  /** Clean command default options */
  clean?: CleanConfigOptions;
  /** Watch command default options */
  watch?: WatchConfigOptions;
  /** Link-videos command default options */
  linkVideos?: LinkVideosConfigOptions;
  /** Global options applied to all commands */
  global?: GlobalConfigOptions;
  /** Plex Media Server integration options */
  plex?: PlexConfigOptions;
  /** Lidarr music-management integration options */
  lidarr?: LidarrConfigOptions;
  /** Independent media discovery provider options */
  discovery?: DiscoveryConfigOptions;
  /** Consumption-driven Lidarr policy engine options */
  policy?: PolicyConfigOptions;
  /** Undo/history tracking options */
  undo?: UndoConfigOptions;
  /** Tracking database configuration */
  tracking?: TrackingConfigOptions;
  /** Smart filter definitions for named filters */
  filters?: FiltersConfigOptions;
  /** Named Plex filter definitions for library queries */
  plexFilters?: MediaFiltersConfigOptions;
  /** Interactive selection UI configuration */
  interactive?: InteractiveConfig;
  /** Plugin system configuration */
  plugins?: PluginsConfigOptions;
}

/**
 * Configuration options for the copy command.
 * These values serve as defaults when not specified on the command line.
 */
export interface CopyConfigOptions {
  /** Output folder name for filter mode (default: "liked-songs") */
  outputFolder?: string;
  /** Use hardlinks instead of file copies */
  hardlink?: boolean;
  /** Overwrite existing copies even if complete */
  force?: boolean;
  /** Strategy for handling file conflicts (skip, overwrite, rename, ask) */
  conflictStrategy?: ConflictStrategy;
  /** Audio conversion format (alac, mp3, aac, opus) */
  convertFormat?: ConvertFormat;
  /** Number of parallel workers for processing */
  workers?: number;
  /** Show visual progress bar with ETA */
  progress?: boolean;
  /** Treat source as single album (not artist folder) */
  albumOnly?: boolean;
  /** Keep album subfolders in filter mode output */
  preserveStructure?: boolean;
  /** Preserve album folders with only liked tracks */
  albumMode?: boolean;
  /** Track completed sources in sidecar file for resume support */
  trackCompleted?: boolean;
  /** Minimum star rating (1-5) for filter mode */
  minStars?: number;
  /** Minimum rating (0-100) for filter mode */
  minRating?: number;
  /** Delete files from destination when rating falls below threshold (default: true) */
  deleteDowngraded?: boolean;
  /**
   * Default range for album mode (e.g., "001-005").
   * Used as lowest priority fallback when neither CLI --range nor per-path range is specified.
   */
  range?: string;

  // Metadata filtering options (filter mode)
  /** Minimum track duration in seconds (CLI accepts MM:SS format) */
  minDuration?: number;
  /** Maximum track duration in seconds (CLI accepts MM:SS format) */
  maxDuration?: number;
  /** Minimum bitrate in kbps */
  minBitrate?: number;
  /** Required codec (case-insensitive match, e.g., "FLAC", "MP3") */
  codec?: string;
  /** Minimum play count from POPM counter (MP3 only) */
  minPlays?: number;
  /** Safety margin for disk space checks as percentage (0-50). Default: 5 */
  diskSpaceMargin?: number;
  /** Abort operation if insufficient disk space. Default: false (warn only) */
  requireDiskSpace?: boolean;

  /**
   * Verify file integrity after copy using SHA-256 checksum.
   * If verification fails, the copy is considered failed.
   */
  verify?: boolean;
}

/**
 * Configuration options for the clean command.
 */
export interface CleanConfigOptions {
  /** Skip confirmation prompt */
  force?: boolean;
  /** Delete albums with fewer than N audio files */
  minFiles?: number;
  /** Patterns to exclude from deletion (comma-separated) */
  exclude?: string[];
  /** Path to file containing patterns to protect from deletion */
  protect?: string;
  /** Move to trash instead of permanent delete */
  useTrash?: boolean;
  /** Only delete albums not modified in the past N days */
  olderThan?: number;
  /**
   * Maximum directory depth to scan for empty directories.
   * - `undefined` means use default depth of 2 (backward-compatible Artist/Album scan)
   * - `0` means unlimited recursive depth
   * - Any positive integer N means scan up to N levels deep
   */
  depth?: number;
}

/**
 * Configuration options for the watch command.
 */
export interface WatchConfigOptions {
  /** Output folder name for filter mode (default: "liked-songs") */
  outputFolder?: string;
  /** Use hardlinks instead of file copies */
  hardlink?: boolean;
  /** Debounce delay in milliseconds before processing */
  debounceMs?: number;
  /** Treat detected folders as single albums, not artist folders */
  albumOnly?: boolean;
  /** Keep album subfolders in filter mode output */
  preserveStructure?: boolean;
}

/**
 * Global configuration options applied to all commands.
 */
export interface GlobalConfigOptions {
  /** Enable verbose debug output */
  debug?: boolean;
}

/**
 * Result of loading configuration from the filesystem.
 */
export interface ConfigLoadResult {
  /** Loaded configuration (empty object if no config found) */
  config: ConfigFile;
  /** Path the config was loaded from, if any */
  loadedFrom?: string;
  /** All paths that were searched */
  searchedPaths: string[];
}

/**
 * Maps a local filesystem path prefix to a Plex library name.
 * Used for automatic library detection based on destination path.
 */
export interface PlexLibraryMapping {
  /** Local filesystem path prefix (e.g., "/mnt/media/music") */
  path: string;
  /** Plex library name (e.g., "Music") */
  library: string;
}

/**
 * Default filters to apply to all Plex queries.
 */
export interface PlexDefaultFilters {
  /** Minimum star rating (1-5) for filtering results */
  minRating?: number;
  /** Genre to filter by */
  genre?: string;
  /** Minimum play count for filtering results (0 or higher) */
  minPlays?: number;
  /** Genres to exclude from results (requires client-side filtering due to Plex API limitations) */
  excludeGenres?: string[];
}

/**
 * Default settings for Plex playlist operations.
 */
export interface PlexPlaylistDefaults {
  /** Whether to create smart playlists by default */
  smart?: boolean;
  /** Whether to update existing playlists by default */
  updateExisting?: boolean;
}

/**
 * Default settings for Plex rating sync operations.
 */
export interface PlexSyncDefaults {
  /** Conflict resolution: prefer Plex or file rating */
  prefer?: "plex" | "file";
  /** Only sync tracks that have ratings */
  onlyRated?: boolean;
  /** POPM email identifier for MP3 writes */
  popmEmail?: string;
  /** Vorbis rating scale: 'normalized' (0-1), 'stars' (0-5), 'percent' (0-100) */
  vorbisScale?: "normalized" | "stars" | "percent";
}

/**
 * Default settings for sync-on-copy operations.
 * Used during `plex copy` and `plex playlist export` to write ratings to destination files.
 */
export interface PlexSyncOnCopyDefaults {
  /** POPM email identifier for MP3 rating writes (default: 'no@email') */
  popmEmail?: string;
  /** Vorbis rating scale: 'normalized' (0-1), 'stars' (0-5), 'percent' (0-100) */
  vorbisScale?: "normalized" | "stars" | "percent";
}

/**
 * Cache configuration for Plex API responses.
 * Note: This defines configuration only; actual caching is implemented separately.
 */
export interface PlexCacheConfig {
  /** Whether caching is enabled */
  enabled?: boolean;
  /** Cache time-to-live in seconds */
  ttlSeconds?: number;
}

/**
 * Plex credential-source policy (issue #251). All fields are optional.
 *
 * Fields are deliberately mutable: `validatePlexConfigOptions` builds a
 * `PlexConfigOptions` literal and assigns validated keys by mutation.
 */
export interface PlexAuthConfigOptions {
  /**
   * `"static"` (default) preserves today's behaviour exactly — the credential
   * comes from `--plex-token` or `plex.token`. `"jwt"` opts in to the enrolled
   * credential store and never falls back to a static token.
   */
  mode?: "static" | "jwt";
  /** Credential-store path override. Tilde-expanded. A path, never a secret. */
  storePath?: string;
  /** Device label shown in plex.tv Authorized Devices. Non-secret. Defaults to the hostname. */
  deviceName?: string;
  /** Proactive refresh margin in seconds (default 300, min 60, max 86_400). */
  refreshMarginSeconds?: number;
}

/**
 * Configuration options for Plex Media Server integration.
 * Enables automatic library scanning after copy operations complete.
 */
export interface PlexConfigOptions {
  /** Plex Media Server URL (e.g., "http://localhost:32400") */
  url?: string;
  /** Plex authentication token (X-Plex-Token) */
  token?: string;
  /** Trigger library scan after copy operations (default: false) */
  scanAfterCopy?: boolean;
  /** Library name to scan (e.g., "Music"). If not set, scans all libraries. */
  libraryName?: string;
  /** Scan after each source instead of at end of batch (default: false) */
  scanPerSource?: boolean;
  /** Library path mappings for automatic library detection from destination path */
  libraries?: PlexLibraryMapping[];
  /** Default page size for query pagination */
  pageSize?: number;
  /** Default filters to apply to all queries */
  defaultFilters?: PlexDefaultFilters;
  /** Allowed library root paths - files outside these paths are filtered out */
  allowedLibraryRoots?: string[];
  /** Default settings for rating sync operations */
  syncDefaults?: PlexSyncDefaults;
  /** Default settings for playlist operations */
  playlistDefaults?: PlexPlaylistDefaults;
  /** Cache configuration for API responses */
  cache?: PlexCacheConfig;
  /** Enable rating sync during copy operations (default: false) */
  syncRatingsOnCopy?: boolean;
  /** Default settings for sync-on-copy operations */
  syncOnCopyDefaults?: PlexSyncOnCopyDefaults;
  /** Credential-source policy: static token (default) or enrolled JWT (issue #251) */
  auth?: PlexAuthConfigOptions;
}

/**
 * Resilience tuning knobs for the Lidarr integration (issue #195).
 * All keys are optional and config-only (no CLI flags); defaults are applied
 * at the consumption site with `??` — never written back into config.
 */
export interface LidarrResilienceConfigOptions {
  /** Circuit-breaker failure threshold before tripping (default: 3). */
  failureThreshold?: number;
  /** Sliding window in seconds for counting failures (default: 300). */
  failureWindowSeconds?: number;
  /** Open-circuit cooldown in seconds before a half-open probe (default: 60). */
  cooldownSeconds?: number;
  /** In-place retry attempts for read operations; 0 disables (default: 1). */
  retryAttempts?: number;
  /** Cap in ms for retry backoff and honored Retry-After waits (default: 15_000). */
  retryBackoffCapMs?: number;
  /** Metadata cache fresh window in seconds; 0 disables caching (default: 900). */
  cacheTtlSeconds?: number;
  /** Maximum stale age in seconds served under --allow-stale (default: 86_400). */
  cacheStaleMaxAgeSeconds?: number;
  /** Maximum replay attempts for deferred intents (default: 5). */
  deferredMaxAttempts?: number;
}

/** Optional overrides for one Lidarr scheduler execution lane. */
export interface LidarrSchedulerLaneConfigOptions {
  /** Maximum operations from this lane that may execute concurrently. */
  concurrency?: number;
  /** Maximum operations admitted from this lane in one scheduler batch. */
  operationBudget?: number;
  /** Additional attempts for retryable, idempotent operations. */
  retryAttempts?: number;
  /** Maximum scheduler retry delay in milliseconds. */
  retryBackoffCapMs?: number;
}

/** Optional per-lane scheduler policy overrides, keyed by canonical lane name. */
export interface LidarrSchedulerLanesConfigOptions {
  /** Reliable operations backed only by Lidarr's local database. */
  "local-only"?: LidarrSchedulerLaneConfigOptions;
  /** Operations that require Lidarr's upstream metadata provider. */
  "metadata-dependent"?: LidarrSchedulerLaneConfigOptions;
  /** Operations backed by independent discovery providers. */
  discovery?: LidarrSchedulerLaneConfigOptions;
  /** File-mutating or bulk destructive operations. */
  destructive?: LidarrSchedulerLaneConfigOptions;
}

/** Scheduler isolation, budget, and retry overrides for Lidarr execution lanes. */
export interface LidarrSchedulerConfigOptions {
  /** Per-lane overrides; omitted fields retain safe built-in defaults. */
  lanes?: LidarrSchedulerLanesConfigOptions;
}

/** Static per-plan allowances and modelling assumptions for Lidarr cascade analysis. */
export interface LidarrCascadeAnalysisConfigOptions {
  readonly budgets?: {
    readonly indexerQueries?: number;
    readonly acquisitionCandidates?: number;
  };
  readonly assumptions?: {
    readonly albumsPerArtist?: number;
    readonly indexerQueriesPerCandidate?: number;
  };
}

/** One strict, self-contained configured Lidarr preset pack. */
export interface LidarrConfiguredPresetPack {
  /** Positive pack version used in provenance and machine output. */
  readonly version: number;
  readonly description: string;
  readonly assumptions: readonly string[];
  readonly consequences: readonly string[];
  readonly capabilities: readonly LidarrPresetCapability[];
  readonly customFormats: readonly LidarrPresetCustomFormat[];
  readonly qualityProfiles: readonly LidarrPresetQualityProfile[];
  readonly naming: LidarrPresetNaming;
}

/** Exact configured-pack collection under `lidarr.profilePresets`. */
export interface LidarrProfilePresetsConfigOptions {
  readonly packs: Readonly<Record<string, LidarrConfiguredPresetPack>>;
}

/**
 * Configuration options for Lidarr music-management integration.
 * Provides connection settings for the `rfmedia lidarr` command namespace.
 */
export interface LidarrConfigOptions {
  /** Lidarr base URL (e.g., "http://localhost:8686"). */
  baseUrl?: string;
  /** Lidarr API key (X-Api-Key header). SENSITIVE — never commit. */
  apiKey?: string;
  /** Request timeout in ms; client default 30_000. */
  timeoutMs?: number;
  /** Resilience tuning knobs (circuit breaker, retries, cache, deferred queue). */
  resilience?: LidarrResilienceConfigOptions;
  /** Per-lane scheduler isolation, budget, and retry overrides. */
  scheduler?: LidarrSchedulerConfigOptions;
  /** Static per-plan cascade allowances and modelling assumptions. */
  cascadeAnalysis?: LidarrCascadeAnalysisConfigOptions;
  /** Strict local quality preset packs; absent preserves legacy configuration behavior. */
  profilePresets?: LidarrProfilePresetsConfigOptions;
}

/** Configuration for the fixed Last.fm discovery boundary. */
export interface LastFmConfigOptions {
  /** Last.fm application API key. SENSITIVE — never commit. */
  readonly apiKey?: string;
  /** Provider request timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Independent discovery configuration. */
export interface DiscoveryConfigOptions {
  /** Last.fm similar-artist discovery configuration. */
  readonly lastfm?: LastFmConfigOptions;
}

/** Configuration for the fixed `rating-quality-upgrade` policy rule. */
export interface PolicyRatingQualityUpgradeConfigOptions {
  /** Whether the rule participates in an evaluation. */
  readonly enabled?: boolean;
  /** Plex artist rating floor on the 1-5 star input scale. */
  readonly minRating?: number;
  /** Existing Lidarr quality profile, by name or numeric id. */
  readonly targetQualityProfile?: string;
  /** Per-rule proposal cap. */
  readonly maxProposals?: number;
}

/** Configuration for the fixed `stale-monitoring-cleanup` policy rule. */
export interface PolicyStaleMonitoringConfigOptions {
  readonly enabled?: boolean;
  /** Inclusive total-play ceiling. Absolute count, NOT recency. */
  readonly maxPlays?: number;
  /** Minimum whole days since the latest trustworthy Plex track view. */
  readonly minDaysSinceLastViewed?: number;
  /** Star rating at or above which an artist is never unmonitored. */
  readonly protectRatingAtOrAbove?: number;
  /** Require at least one Plex track to have joined this artist. */
  readonly requireTrackCoverage?: boolean;
  /** Minimum Lidarr `statistics.trackFileCount` to consider the artist acquired. */
  readonly minTrackFileCount?: number;
  readonly maxProposals?: number;
}

/** Configuration for the fixed `discovery-seed` policy rule. */
export interface PolicyDiscoverySeedConfigOptions {
  readonly enabled?: boolean;
  readonly minRating?: number;
  readonly minPlays?: number;
  readonly maxSeeds?: number;
}

/** The three fixed policy rules. Unknown rule ids are rejected. */
export interface PolicyRulesConfigOptions {
  readonly "rating-quality-upgrade"?: PolicyRatingQualityUpgradeConfigOptions;
  readonly "stale-monitoring-cleanup"?: PolicyStaleMonitoringConfigOptions;
  readonly "discovery-seed"?: PolicyDiscoverySeedConfigOptions;
}

/** One durable, evidence-bound operator decision override. */
export interface PolicyOverrideConfigOptions {
  readonly action: "suppress";
  readonly evidenceFingerprint: PolicyDecisionEvidenceFingerprint;
  readonly reason: string;
}

/** Consumption-driven Lidarr policy engine options. */
export interface PolicyConfigOptions {
  /** Plex music library consumption signals are read from. */
  readonly plexLibrary?: string;
  readonly rules?: PolicyRulesConfigOptions;
  /** Durable suppressions keyed by a stable three-segment proposal key. */
  readonly overrides?: Readonly<Record<PolicyDecisionKey, PolicyOverrideConfigOptions>>;
}

/**
 * Configuration options for undo/history tracking.
 * Controls how operation history is recorded for later undo.
 */
export interface UndoConfigOptions {
  /** Enable operation history logging (default: true) */
  enabled?: boolean;
  /** History retention in days (default: 30) */
  retentionDays?: number;
  /** Maximum history directory size in MB (default: 100) */
  maxSizeMB?: number;
  /** Custom history directory path (default: ~/.rfmedia/history) */
  historyPath?: string;
  /** Path to SQLite database (defaults to tracking.database). Phase 2.5: database mode */
  database?: string;
  /** Use JSONL files instead of database (default: false). Phase 2.5: legacy mode */
  useLegacy?: boolean;
}

/**
 * Configuration options for the link-videos command.
 * Default options for linking music videos to audio tracks.
 */
export interface LinkVideosConfigOptions {
  /** Minimum similarity score (0-100) for matching (default: 70) */
  minScore?: number;
  /** Preferred video format when duplicates exist (default: mkv) */
  preferredFormat?: string;
  /** Show progress bar */
  progress?: boolean;
}

/**
 * Configuration options for tracking database.
 */
export interface TrackingConfigOptions {
  /** Path to SQLite database file (default: ~/.rfmedia/tracking.db) */
  database?: string;
  /** Use legacy file-based tracking instead of database (default: false) */
  useLegacy?: boolean;
}

/**
 * Configuration options for interactive selection UI.
 * Controls pagination for the ink-based MultiSelect components.
 */
export interface InteractiveConfig {
  /** Number of artists/sources visible in the selection menu (default: 20) */
  readonly artistPageSize: number;
  /** Number of albums visible in the selection menu (default: 20) */
  readonly albumPageSize: number;
  /** Number of tracks visible in the selection menu (default: 25) */
  readonly trackPageSize: number;
}

/**
 * Configuration options for the plugin system.
 * Controls plugin loading, directories, and external command integrations.
 */
export interface PluginsConfigOptions {
  /** Enable/disable the entire plugin system (default: true) */
  enabled?: boolean;
  /** Plugin search directory (default: ~/.rfmedia/plugins/) */
  directory?: string;
  /** Additional plugin directories to search */
  additionalDirectories?: string[];
  /** Plugins to disable by name */
  disabled?: string[];
  /** External command plugin configurations */
  commands?: ExternalCommandPluginConfig[];
}

/**
 * Configuration for an external command plugin.
 * Allows integrating external tools like beets or MusicBrainz Picard without writing code.
 */
export interface ExternalCommandPluginConfig {
  /** Unique name for this command plugin */
  name: string;
  /** Command to execute */
  command: string;
  /** Arguments (supports {sourcePath}, {destPath}, {metadata} placeholders) */
  args?: string[];
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number;
  /** Which hooks to run this command on */
  hooks: {
    afterCopy?: boolean | string; // true or custom args
    afterBatch?: boolean | string;
  };
}
