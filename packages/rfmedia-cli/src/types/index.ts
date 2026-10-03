/**
 * Type definitions for rfmedia CLI.
 *
 * This module exports all types used throughout the rfmedia CLI tool.
 * Types are organized into:
 * - Options: Configuration types for CLI commands
 * - Results: Output types from command execution
 * - Shared: Common types used across the application
 */

// Output format type (re-exported from @rfmedia/common)
export type { OutputFormat } from "@rfmedia/common";

// Options types
export type {
  CopyRange,
  RatingFilter,
  CopyMode,
  ConvertFormat,
  VerificationTier,
  CopyOptions,
  VerifyOptions,
  CleanOptions,
  GlobalOptions,
  PathEntry,
  PathsYamlSource,
  PathsYamlDefaults,
  PathsYamlFile,
  ParsedPathsYaml,
  DeleteMode,
  DeleteOptions,
  SelectionLevel,
  SourceSelection,
  CopySelection,
  DeleteSourceSelection,
  DeleteSelection,
} from "./options.js";

// Smart filter types (for nested boolean logic filtering)
export type {
  FilterField,
  FilterOperator,
  FilterMatch,
  SeparationEnergyMode,
  SeparationConfig,
  FilterRule,
  FilterGroup,
  SmartFilterRule,
  SmartFilter,
  FiltersConfigOptions,
} from "./filters.js";
export { isFilterRule, isFilterGroup } from "./filters.js";

// Conflict resolution types (for interactive conflict handling)
export type {
  ConflictType,
  ConflictStrategy,
  ConflictContext,
  ConflictResolution,
  ConflictResolutionResult,
} from "./conflict.js";

// Extended metadata types (for smart filter evaluation)
export type { ExtendedMetadata } from "../lib/metadata.js";

// Watch types
export type { WatchOptions, WatchProcessResult, IgnoredExtension } from "./watch.js";
export { IGNORED_EXTENSIONS } from "./watch.js";

// Tracking types
export type {
  TrackingOptionsHash,
  TrackingConfig,
  TrackingState,
  TrackingMetadata,
  TrackingStats,
  TimingStats,
} from "./tracking.js";

// Inventory types (for sync command)
export type {
  FileInventoryEntry,
  SourceInventory,
  SyncDiff,
  SyncOptions,
  SyncResult,
  SyncFailedOperation,
  InventoryRecord,
  InventorySourceRecord,
  InventoryFileRecord,
  LoadedInventory,
  InventoryOptionsHash,
} from "./inventory.js";

// Config types
export type {
  ConfigFile,
  CopyConfigOptions,
  CleanConfigOptions,
  WatchConfigOptions,
  GlobalConfigOptions,
  ConfigLoadResult,
  PlexConfigOptions,
  PlexAuthConfigOptions,
  PlexDefaultFilters,
  PlexLibraryMapping,
  PlexSyncDefaults,
  PlexPlaylistDefaults,
  PlexCacheConfig,
  DiscoveryConfigOptions,
  LastFmConfigOptions,
  PolicyConfigOptions,
  PolicyRulesConfigOptions,
  PolicyRatingQualityUpgradeConfigOptions,
  PolicyStaleMonitoringConfigOptions,
  PolicyDiscoverySeedConfigOptions,
  LidarrConfiguredPresetPack,
  LidarrProfilePresetsConfigOptions,
  LidarrConfigOptions,
  LidarrResilienceConfigOptions,
  LidarrSchedulerConfigOptions,
  LidarrSchedulerLanesConfigOptions,
  LidarrSchedulerLaneConfigOptions,
  LinkVideosConfigOptions,
  UndoConfigOptions,
  TrackingConfigOptions,
  InteractiveConfig,
  PluginsConfigOptions,
  ExternalCommandPluginConfig,
} from "./config.js";

// Similar-artist discovery contracts
export type {
  DiscoveryCandidateExposure,
  DiscoveryCandidateLifecycle,
  DiscoveryCandidateProvenance,
  DiscoveryCandidateReason,
  DiscoveryAttribution,
  DiscoveryProviderFailure,
  DiscoveryProviderFailureCode,
  LastFmClient,
  LastFmSimilarArtist,
  LastFmSimilarArtistQuery,
  LastFmSimilarArtistResult,
  LidarrDiscoverApproval,
  LidarrDiscoverHandoff,
  LidarrDiscoverHandoffCounts,
  LidarrDiscoverHardBounds,
  LidarrDiscoverResolvedPolicy,
  LidarrDiscoverResult,
  LidarrDiscoverTraversalSummary,
  SimilarArtistRecommendation,
} from "./discovery.js";
export {
  LIDARR_DISCOVER_DEFAULT_DEPTH,
  LIDARR_DISCOVER_DEFAULT_DIVERSITY_BOOST,
  LIDARR_DISCOVER_DEFAULT_LIMIT,
  LIDARR_DISCOVER_DEFAULT_MAX_ADD,
  LIDARR_DISCOVER_DEFAULT_MAX_PER_SEED,
  LIDARR_DISCOVER_DEFAULT_MIN_SIMILARITY,
  LIDARR_DISCOVER_DEFAULT_POPULARITY_DAMPENING,
  LIDARR_DISCOVER_MAX_ADD,
  LIDARR_DISCOVER_MAX_DEPTH,
  LIDARR_DISCOVER_MAX_LIMIT,
  LIDARR_DISCOVER_MAX_PER_SEED,
  LIDARR_DISCOVER_MAX_MIN_SIMILARITY,
  LIDARR_DISCOVER_MAX_REQUESTS,
  LIDARR_DISCOVER_MAX_SCORE_WEIGHT,
  LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES,
  LIDARR_DISCOVER_MAX_VISITED_SEEDS,
} from "./discovery.js";

// Plugin types (for plugin system)
export type {
  RfmediaPlugin,
  PluginHook,
  PluginHookType,
  BeforeCopyHook,
  AfterCopyHook,
  ProcessFileHook,
  AfterBatchHook,
  BeforeCopyContext,
  AfterCopyContext,
  ProcessFileContext,
  AfterBatchContext,
  ExternalCommandHooksConfig,
  ExternalCommandPlugin,
} from "./plugins.js";

export {
  isBeforeCopyHook,
  isAfterCopyHook,
  isProcessFileHook,
  isAfterBatchHook,
  PluginLoadError,
  PluginExecutionError,
  ExternalCommandError,
} from "./plugins.js";

// Database types
export type {
  DbConnection,
  DbOperation,
  DbCompletedSource,
  DbFailedSource,
  DbInventoryEntry,
  CreateOperationParams,
  OperationFilter,
  OperationCounts,
} from "./db.js";

// Link-videos types
export type {
  VideoExtension,
  LinkVideosOptions,
  VideoFile,
  AudioTrack,
  VideoMatch,
  VideoLinkEntry,
  VideoInventoryHeader,
  LoadedVideoInventory,
  LinkVideosResult,
  LinkVideosFailedOperation,
} from "./link-videos.js";
export { VIDEO_EXTENSIONS, VIDEO_FORMAT_PRIORITY } from "./link-videos.js";

// Result types
export type {
  CopyResult,
  CleanResult,
  FailedOperation,
  VerifyStatus,
  VerifyResult,
  FileVerifyStatus,
  VerificationReason,
  VerificationEvidence,
  VerifiedFile,
  FixResult,
  VerifyCommandResult,
  CopyMethod,
  FileCopyResult,
  DeleteResult,
} from "./results.js";

// Queue types (batch job management)
export type {
  QueueJobType,
  QueueJobStatus,
  SerializableCopyOptions,
  SerializableDeleteOptions,
  QueueJob,
  QueueFile,
  QueueAddOptions,
  QueueListOptions,
  QueueRunOptions,
  QueueClearOptions,
  QueueRunResult,
  QueueClearResult,
} from "./queue.js";

// Completion types
export type { SupportedShell, CompletionOptions, CompletionResult } from "./completion.js";
export { SUPPORTED_SHELLS } from "./completion.js";

// Lidarr mutation plan/apply contracts
export * from "./lidarr-plan.js";

// Lidarr policy-plan contracts
export * from "./lidarr-policy-plan.js";

// Lidarr quality preset contracts
export * from "./lidarr-presets.js";

// History types (for undo command)
export type {
  HistoryOperationType,
  SessionStatus,
  CopyHistoryEntry,
  HardlinkHistoryEntry,
  ConvertHistoryEntry,
  MkdirHistoryEntry,
  RemoveHistoryEntry,
  TrashHistoryEntry,
  HistoryEntry,
  HistorySessionHeader,
  HistorySession,
  UndoOptions,
  UndoFailure,
  UndoSessionResult,
  UndoResult,
  ListSessionsOptions,
} from "./history.js";

// Playlist types (for smart playlist generation)
export type {
  FilterPlaylistSource,
  PlexPlaylistSource,
  PlaylistSource,
  M3UPlaylistOptions,
  M3UTrackInfo,
  M3UPlaylistResult,
  PlaylistUpdateResult,
  PlaylistShowResult,
} from "./playlist.js";
export { isFilterPlaylistSource, isPlexPlaylistSource } from "./playlist.js";

// Plex types (for Plex Media Server query functionality)
export type {
  PlexAlbum,
  PlexAlbumQueryResult,
  PlexArtist,
  PlexArtistQueryResult,
  PlexCopyOptions,
  PlexCopyResult,
  PlexMediaType,
  PlexQueryOptions,
  PlexQueryResult,
  PlexTrack,
} from "./plex.js";

// Provider-neutral media server domain and adapter types
export type {
  MediaArtistExternalIdentity,
  MediaArtistIdentity,
  MediaAlbum,
  MediaArtist,
  MediaCollection,
  MediaCollectionCreateInput,
  MediaEntityBase,
  MediaItem,
  MediaIdentityListArtistsOptions,
  MediaIdentityPage,
  MediaKind,
  MediaLibraryContentVersion,
  MediaLibraryContentVersionOptions,
  MediaPage,
  MediaPlaylist,
  MediaQueryOptions,
  MediaServerAdapter,
  MediaServerCapabilities,
  MediaServerCollectionCapability,
  MediaServerErrorCode,
  MediaServerErrorOptions,
  MediaServerFeatureAvailability,
  MediaServerFeatures,
  MediaServerFilterPushdownFeatures,
  MediaServerIdentityCapability,
  MediaServerLibrary,
  MediaServerLibraryCapability,
  MediaServerMetadataCapability,
  MediaServerNativeRatingScale,
  MediaServerQueryCapability,
  MediaServerRatingFeatures,
  MediaServerRatingUpdateResult,
  MediaServerScanCapability,
  MediaServerScanResult,
  MediaServerType,
  MediaServerPlaylistCapability,
  MediaTrack,
  MediaTrackLookupOptions,
  NormalizedMediaRating,
} from "./media-server.js";
export {
  MEDIA_IDENTITY_MAX_EXTERNAL_IDS,
  MEDIA_IDENTITY_MAX_EXTERNAL_ID_BYTES,
  MEDIA_IDENTITY_MAX_ID_BYTES,
  MEDIA_IDENTITY_MAX_PAGE_SIZE,
  MEDIA_IDENTITY_MAX_TITLE_BYTES,
  MediaServerError,
} from "./media-server.js";

// Metadata drift reconciliation contracts
export type {
  DatabaseStatOutcome,
  DatabaseStatOutcomeCode,
  DatabaseStatOutcomeStatus,
  DatabaseStatReconciliationBlocker,
  DatabaseStatReconciliationBlockerCode,
  RatingReconciliationBlocker,
  RatingReconciliationBlockerCode,
  RatingTargetOutcome,
  RatingTargetOutcomeCode,
  RatingTargetOutcomeStatus,
  ReconciliationBlocker,
  ReconciliationCounts,
  ReconciliationDatabaseStatOutcomeCounts,
  ReconciliationFailureCode,
  ReconciliationField,
  ReconciliationFileStat,
  ReconciliationFinding,
  ReconciliationFindingCode,
  ReconciliationMode,
  ReconciliationObservationState,
  ReconciliationPlane,
  ReconciliationPostApply,
  ReconciliationPostApplyStatus,
  ReconciliationRatingOutcomeCounts,
  ReconciliationRequestedFields,
  ReconciliationRequestedOperation,
  ReconciliationRequestedOperations,
  ReconciliationResult,
  ReconciliationResultV1,
  ReconciliationSchema,
  ReconciliationStatus,
  ReconciliationStrategy,
  ReconciliationTargetOutcome,
  ReconciliationValue,
} from "./reconciliation.js";

// Provider-neutral Plex-to-Lidarr artist bridge contracts
export type {
  BridgeArtistAmbiguousOutcome,
  BridgeArtistCandidate,
  BridgeArtistConflictOutcome,
  BridgeArtistIdentitySnapshot,
  BridgeArtistResolutionInput,
  BridgeArtistResolutionMethod,
  BridgeArtistResolutionOutcome,
  BridgeArtistResolutionReason,
  BridgeArtistResolvedOutcome,
  BridgeArtistSuggestedOutcome,
  BridgeArtistUnavailableOutcome,
  BridgeArtistUnmatchedOutcome,
  BridgeExpansionImpact,
  BridgeExpansionInput,
  BridgeExpansionTargetAlbum,
  BridgeIdentityCacheErrorCode,
  BridgeIdentityCacheErrorOptions,
  BridgeIdentityCompatibleScopeResult,
  BridgeIdentityCompatibleScopeSelector,
  BridgeIdentityCompleteness,
  BridgeIdentityKind,
  BridgeIdentityProvenance,
  BridgeIdentityScope,
  BridgeResolvedArtistTarget,
  BridgeSourceArtist,
  BridgeTargetArtist,
  PlexLidarrReconciliationResultV1,
  ReconciliationAmbiguousItem,
  ReconciliationAuthoritativeItem,
  ReconciliationCandidate,
  ReconciliationCategory,
  ReconciliationConflictItem,
  ReconciliationDuplicate,
  ReconciliationDuplicateCode,
  ReconciliationDuplicateMember,
  ReconciliationFuzzyNameReviewItem,
  ReconciliationItem,
  ReconciliationNormalizedNameReviewItem,
  ReconciliationPlexOnlyItem,
  ReconciliationReason,
  ReconciliationReviewSuggestedItem,
  ReconciliationSourceIdentity,
  ReconciliationSourceUnmatchedItem,
  ReconciliationSuggestion,
  ReconciliationSuggestionCode,
  ReconciliationSummary,
  ReconciliationTargetIdentity,
  ReconciliationTargetUnmatchedItem,
  ReconciliationUnavailableItem,
} from "./bridge.js";
export {
  BRIDGE_ARTIST_MAX_CANDIDATES,
  BRIDGE_ARTIST_MAX_COMPARISONS,
  BRIDGE_ARTIST_MAX_NORMALIZED_BYTES,
  BRIDGE_ARTIST_MAX_RECORDS,
  BRIDGE_ARTIST_MIN_FUZZY_NAME_LENGTH,
  BRIDGE_ARTIST_NORMALIZATION_VERSION,
  BRIDGE_ARTIST_RESOLVER_VERSION,
  BRIDGE_ARTIST_RUNNER_UP_MARGIN,
  BRIDGE_ARTIST_SCORE_FLOOR,
  BRIDGE_ARTIST_SCORING_VERSION,
  BRIDGE_IDENTITY_CACHE_ERROR_MAX_MESSAGE_BYTES,
  BRIDGE_IDENTITY_SNAPSHOT_MAX_BYTES,
  BRIDGE_IDENTITY_SNAPSHOT_VERSION,
  BridgeIdentityCacheError,
} from "./bridge.js";

// Provider-neutral media filter vocabulary
export type {
  MediaFilter,
  MediaFilterField,
  MediaFilterGroup,
  MediaFilterMatch,
  MediaFilterNode,
  MediaFilterOperator,
  MediaFilterRule,
  MediaFiltersConfigOptions,
} from "./media-filters.js";
export { MEDIA_FILTER_MAX_DEPTH, isMediaFilterGroup, isMediaFilterRule } from "./media-filters.js";

// Plex filter types
export type {
  PlexFilterField,
  PlexFilterOperator,
  PlexFilterMatch,
  PlexFilterRule,
  PlexFilterGroup,
  PlexSmartFilterRule,
  PlexSmartFilter,
  PlexFiltersConfigOptions,
} from "./plex-filters.js";
export { isPlexFilterRule, isPlexFilterGroup } from "./plex-filters.js";

// Interactive selection types (for ink-based UI)
export type {
  SourceDisplayInfo,
  AlbumDisplayInfo,
  TrackDisplayInfo,
  DeleteDisplayInfo,
  InteractiveSelectionOptions,
} from "./interactive.js";

// Preview types (for dry-run output)
export type {
  PreviewAction,
  AlbumSuffixPreview,
  AlbumPreview,
  PreviewResult,
  TrackPreview,
  FilterPreview,
  FilterPreviewResult,
  PreviewOptions,
  PreviewFormatOptions,
} from "./preview.js";

/**
 * Supported audio file extensions for detection and processing.
 * All comparisons should be case-insensitive.
 */
export const AUDIO_EXTENSIONS = [
  "flac",
  "wav",
  "mp3",
  "ogg",
  "opus",
  "m4a",
  "aac",
  "wma",
  "aiff",
  "ape",
  "wv",
  "alac",
] as const;

/**
 * Type representing a valid audio file extension.
 */
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

/**
 * Represents an audio file with its metadata.
 */
export interface AudioFile {
  /** Absolute path to the audio file */
  path: string;
  /** File extension without the leading dot (lowercase) */
  extension: string;
  /** Whether the file has a recognized audio extension */
  isAudio: boolean;
}

/**
 * Represents an album directory with its contents.
 */
export interface Album {
  /** Absolute path to the album directory */
  path: string;
  /** Album folder name (without parent path) */
  name: string;
  /** Artist name (parent folder name) */
  artist: string;
  /** List of files in the album directory */
  files: AudioFile[];
  /** Whether the album contains any audio files */
  hasAudioFiles: boolean;
}

/**
 * Represents an artist directory with its albums.
 */
export interface Artist {
  /** Absolute path to the artist directory */
  path: string;
  /** Artist folder name */
  name: string;
  /** List of albums under this artist */
  albums: Album[];
}

/**
 * Normalized rating value (0.0 to 1.0 scale).
 * All format-specific ratings should be converted to this scale internally.
 */
export interface NormalizedRating {
  /** Rating value on 0.0 to 1.0 scale */
  value: number;
  /** Original source of the rating (e.g., 'POPM', 'Vorbis', 'iTunes') */
  source: RatingSource;
  /** Email identifier for POPM ratings (if applicable) */
  email?: string;
  /** Play count from POPM frame (MP3 only) */
  counter?: number;
}

/**
 * Source format of a rating tag.
 */
export type RatingSource = "POPM" | "Vorbis" | "iTunes" | "unknown";

/**
 * Track information with rating for filter mode.
 */
export interface RatedTrack {
  /** Audio file information */
  file: AudioFile;
  /** Normalized rating (null if unrated) */
  rating: NormalizedRating | null;
  /** Album the track belongs to */
  albumName: string;
  /** Artist name */
  artistName: string;
}
