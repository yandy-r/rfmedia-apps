/**
 * Public Plex compatibility contracts.
 *
 * These types preserve the established Plex-branded command, action, machine
 * output, and persistence shapes while the adapter implementation uses the
 * provider-neutral media-server contract internally. Raw Plex response DTOs
 * belong under `lib/adapters/plex/` and must not be added here.
 *
 * Key considerations:
 * - Plex uses 0-10 rating scale internally (0-5 stars displayed to users)
 * - Media type values are integers: track=10, album=9, artist=8
 * - File paths are nested in Media[0].Part[0].file in API responses
 */

import type { ConvertFormat, CopyRange } from "./options.js";
import type { FailedOperation } from "./results.js";
import type { MediaKind } from "./media-server.js";

/**
 * Discriminated union for Plex query media types.
 *
 * These map to Plex API type parameter values:
 * - track: 10
 * - album: 9
 * - artist: 8
 */
/** @deprecated Use {@link MediaKind} in provider-neutral implementation code. */
export type PlexMediaType = MediaKind;

/**
 * Canonical Plex metadata type code for music entities.
 *
 * - artist: 8
 * - album: 9
 * - track: 10
 */
/**
 * Plex numeric media kind retained for compatibility projections.
 *
 * @deprecated Plex protocol code ownership belongs to the private Plex adapter.
 */
export type PlexMetadataTypeCode = 8 | 9 | 10;

/**
 * Canonical media-type to Plex metadata type code mapping.
 *
 * This is the single source of truth for collection/query type codes.
 */
/** @deprecated Plex protocol mapping belongs to the private Plex adapter. */
export const PLEX_MEDIA_TYPE_CODES: Readonly<Record<PlexMediaType, PlexMetadataTypeCode>> =
  Object.freeze({
    track: 10,
    album: 9,
    artist: 8,
  });

/**
 * Reverse mapping from Plex metadata type code to media type.
 */
/** @deprecated Plex protocol mapping belongs to the private Plex adapter. */
export const PLEX_METADATA_TYPE_TO_MEDIA_TYPE: Readonly<
  Record<PlexMetadataTypeCode, PlexMediaType>
> = Object.freeze({
  8: "artist",
  9: "album",
  10: "track",
});

/**
 * True when the numeric value is a supported Plex music metadata type code.
 */
/** @deprecated Plex protocol validation belongs to the private Plex adapter. */
export function isPlexMetadataTypeCode(value: number): value is PlexMetadataTypeCode {
  return value === 8 || value === 9 || value === 10;
}

/**
 * Convert Plex metadata type code to media type label.
 */
/** @deprecated Plex protocol mapping belongs to the private Plex adapter. */
export function mediaTypeFromMetadataTypeCode(
  metadataTypeCode: number | undefined,
): PlexMediaType | undefined {
  if (metadataTypeCode === undefined || !isPlexMetadataTypeCode(metadataTypeCode)) {
    return undefined;
  }
  return PLEX_METADATA_TYPE_TO_MEDIA_TYPE[metadataTypeCode];
}

/**
 * Plex-shaped track compatibility projection.
 *
 * Represents the established public/action result shape, not a raw Plex wire
 * DTO. The compatibility projection maps:
 * - artist: grandparentTitle
 * - album: parentTitle
 * - filePath: Media[0].Part[0].file
 *
 * @example
 * const track: PlexTrack = {
 *   ratingKey: '12345',
 *   title: 'My Song',
 *   artist: 'Artist Name',
 *   album: 'Album Name',
 *   userRating: 8,  // 4 stars
 *   viewCount: 15,
 *   duration: 240000,
 *   year: 2024,
 *   filePath: '/music/Artist/Album/track.flac',
 * };
 */
/** @deprecated Use {@link MediaTrack} in provider-neutral implementation code. */
export interface PlexTrack {
  /** Unique identifier for the track in Plex */
  ratingKey: string;
  /** Track title */
  title: string;
  /** Artist name (from grandparentTitle in API response) */
  artist: string;
  /** Album name (from parentTitle in API response) */
  album: string;
  /** User rating on 0-10 scale (0-5 stars = 0-10 value) */
  userRating: number;
  /** Number of times the track has been played */
  viewCount: number;
  /** Track duration in milliseconds */
  duration: number;
  /** Release year (optional, may not be present for all tracks) */
  year?: number;
  /** Absolute path to the audio file (from Media[0].Part[0].file) */
  filePath: string;
  /** Mood tags (e.g., 'Relaxing', 'Energetic') - tracks only have moods, not styles */
  moods?: string[];
}

/**
 * Plex-shaped album compatibility projection.
 *
 * Represents an album with its associated metadata.
 * Field mappings from Plex API:
 * - artist: parentTitle
 *
 * @example
 * const album: PlexAlbum = {
 *   ratingKey: '67890',
 *   title: 'Album Name',
 *   artist: 'Artist Name',
 *   userRating: 10,  // 5 stars
 *   year: 2024,
 *   trackCount: 12,
 * };
 */
/** @deprecated Use {@link MediaAlbum} in provider-neutral implementation code. */
export interface PlexAlbum {
  /** Unique identifier for the album in Plex */
  ratingKey: string;
  /** Album title */
  title: string;
  /** Artist name (from parentTitle in API response) */
  artist: string;
  /** User rating on 0-10 scale (0-5 stars = 0-10 value) */
  userRating: number;
  /** Release year (optional, may not be present for all albums) */
  year?: number;
  /** Number of tracks in the album */
  trackCount: number;
  /** Album thumbnail URL path (optional) */
  thumb?: string;
  /** Style tags (e.g., 'Jazz', 'Fusion') - only for artists/albums */
  styles?: string[];
  /** Mood tags (e.g., 'Relaxing', 'Energetic') */
  moods?: string[];
}

/**
 * Plex-shaped artist compatibility projection.
 *
 * Represents an artist with their associated metadata.
 *
 * @example
 * const artist: PlexArtist = {
 *   ratingKey: '11111',
 *   title: 'Artist Name',
 *   userRating: 8,  // 4 stars
 *   albumCount: 5,
 * };
 */
/** @deprecated Use {@link MediaArtist} in provider-neutral implementation code. */
export interface PlexArtist {
  /** Unique identifier for the artist in Plex */
  ratingKey: string;
  /** Artist name */
  title: string;
  /** User rating on 0-10 scale (0-5 stars = 0-10 value) */
  userRating: number;
  /** Number of albums by this artist */
  albumCount: number;
  /** Artist thumbnail URL path (optional) */
  thumb?: string;
  /** Style tags (e.g., 'Jazz', 'Fusion') - only for artists/albums */
  styles?: string[];
  /** Mood tags (e.g., 'Relaxing', 'Energetic') */
  moods?: string[];
}

/**
 * Query parameters for Plex library searches.
 *
 * Supports filtering by various criteria with pagination.
 * Rating values are specified in 1-5 star scale and converted
 * to Plex's 0-10 scale internally.
 *
 * Hierarchical rating filters allow cascading filtering:
 * - minArtistRating: Filter by artist rating (works on all types)
 * - minAlbumRating: Filter by album rating (works on albums, tracks)
 * - minTrackRating: Filter by track rating (works on tracks only)
 *
 * @example
 * const options: PlexQueryOptions = {
 *   library: 'Music',
 *   type: 'track',
 *   minArtistRating: 3,   // From 3+ star artists
 *   minAlbumRating: 4,    // With 4+ star albums
 *   minTrackRating: 3.5,  // And 3.5+ star tracks
 *   genre: 'Rock',
 *   limit: 100,
 * };
 */
export interface PlexQueryOptions {
  /** Name of the Plex library to query */
  library: string;
  /** Type of media to query (track, album, or artist) */
  type: PlexMediaType;
  /** Minimum artist star rating (1-5 scale, works on all types) */
  minArtistRating?: number;
  /** Maximum artist star rating (1-5 scale, works on all types) */
  maxArtistRating?: number;
  /** Minimum album star rating (1-5 scale, works on albums and tracks) */
  minAlbumRating?: number;
  /** Maximum album star rating (1-5 scale, works on albums and tracks) */
  maxAlbumRating?: number;
  /** Minimum track star rating (1-5 scale, works on tracks only) */
  minTrackRating?: number;
  /** Maximum track star rating (1-5 scale, works on tracks only) */
  maxTrackRating?: number;
  /** Filter by genre name */
  genre?: string;
  /** Filter by exact year */
  year?: number;
  /** Filter by minimum year (inclusive) */
  minYear?: number;
  /** Filter by maximum year (inclusive) */
  maxYear?: number;
  /** Filter by minimum play count */
  minPlays?: number;
  /** Filter by artist name (case-insensitive substring match) */
  artist?: string;
  /** Filter by title (case-insensitive substring match) */
  title?: string;
  /** Filter by album name (tracks only, case-insensitive substring match) */
  album?: string;
  /** Filter by style tag (e.g., 'Jazz', 'Fusion') - only for artists/albums */
  style?: string;
  /** Filter by mood tag (e.g., 'Relaxing', 'Energetic') */
  mood?: string;

  // ==========================================================================
  // NEGATIVE OPERATOR FIELDS
  // ==========================================================================
  // These fields support exclusion filters using Plex API's != operator.
  // For text fields: != means "does not contain" (substring exclusion).
  // Only the !=-based "not*" filters documented below are currently supported.
  // ==========================================================================

  /** Exclude genre (does not contain) - uses Plex API genre!= */
  notGenre?: string;
  /** Exclude style (does not contain) - uses Plex API style!= */
  notStyle?: string;
  /** Exclude mood (does not contain) - uses Plex API mood!= */
  notMood?: string;
  /** Exclude artist name (does not contain) - uses Plex API artist.title!= */
  notArtist?: string;
  /** Exclude album name (does not contain) - uses Plex API album.title!= (tracks only) */
  notAlbum?: string;
  /** Exclude track title (does not contain) - uses Plex API title!= */
  notTitle?: string;

  /** Exclude artist rating (not equals) - uses Plex API userRating!= or artist.userRating!= */
  notArtistRating?: number;
  /** Exclude album rating (not equals) - uses Plex API userRating!= or album.userRating!= */
  notAlbumRating?: number;
  /** Exclude track rating (not equals) - uses Plex API userRating!= (tracks only) */
  notTrackRating?: number;

  /** Exclude year (not equals) - uses Plex API year!= */
  notYear?: number;

  /** Maximum number of results to return per page */
  limit?: number;
  /** Starting offset for pagination (0-based) */
  offset?: number;
}

/**
 * Result from a Plex track query with pagination metadata.
 *
 * Uses readonly array to prevent mutation of results.
 *
 * @example
 * const result: PlexQueryResult = {
 *   tracks: [{ ratingKey: '123', title: 'Song', ... }],
 *   totalSize: 1500,
 *   offset: 0,
 *   hasMore: true,
 * };
 */
export interface PlexQueryResult {
  /** Array of tracks matching the query (immutable) */
  readonly tracks: readonly PlexTrack[];
  /** Total number of matching tracks across all pages */
  totalSize: number;
  /** Current offset in the result set */
  offset: number;
  /** Number of items returned by Plex for this page before backup client-side filtering */
  pageItemCount?: number;
  /** Whether more results are available beyond this page */
  hasMore: boolean;
}

/**
 * Result from a Plex album query with pagination metadata.
 *
 * Uses readonly array to prevent mutation of results.
 */
export interface PlexAlbumQueryResult {
  /** Array of albums matching the query (immutable) */
  readonly albums: readonly PlexAlbum[];
  /** Total number of matching albums across all pages */
  totalSize: number;
  /** Current offset in the result set */
  offset: number;
  /** Number of items returned by Plex for this page before backup client-side filtering */
  pageItemCount?: number;
  /** Whether more results are available beyond this page */
  hasMore: boolean;
}

/**
 * Result from a Plex artist query with pagination metadata.
 *
 * Uses readonly array to prevent mutation of results.
 */
export interface PlexArtistQueryResult {
  /** Array of artists matching the query (immutable) */
  readonly artists: readonly PlexArtist[];
  /** Total number of matching artists across all pages */
  totalSize: number;
  /** Current offset in the result set */
  offset: number;
  /** Number of items returned by Plex for this page before backup client-side filtering */
  pageItemCount?: number;
  /** Whether more results are available beyond this page */
  hasMore: boolean;
}

/**
 * Base copy options shared by all Plex copy modes.
 *
 * Contains configuration options common to both query-results mode
 * and query mode.
 */
export interface PlexCopyBaseOptions {
  /** Destination directory for copied files */
  destination: string;
  /** Use hardlinks instead of copies (when possible) */
  hardlink?: boolean;
  /** Convert files to specified format during copy */
  convertFormat?: ConvertFormat;
  /** Preserve artist/album folder hierarchy in destination */
  preserveStructure?: boolean;
  /** Number of parallel workers for file operations */
  workers?: number;
  /** Preview operations without executing them */
  dryRun?: boolean;
  /** Show progress bar during copy operations */
  progress?: boolean;
  /** Create a Plex playlist from copied tracks (future feature) */
  createPlaylist?: string;
  /** Trigger Plex library scan after copy (default: true) */
  plexScan?: boolean;
  /** Range of suffixes to create (e.g., 001-005) */
  range?: CopyRange;
  /** Number of copies to create (auto-detects next range) */
  count?: number;
  /** Output folder name for tracks (default: "plex-liked") */
  outputFolder?: string;
  /** Preserve album folders with suffixes (e.g., Album-001, Album-002) */
  albumMode?: boolean;
  /** Stop processing immediately on first error (default: false, continues collecting errors) */
  failFast?: boolean;
  /** Enable Plex rating sync to destination files */
  syncRatings?: boolean;
  /** POPM email identifier for MP3 rating writes (default: 'no@email') */
  popmEmail?: string;
  /** Vorbis rating scale for FLAC/OGG writes */
  vorbisScale?: "normalized" | "stars" | "percent";
}

/**
 * Options for copying from saved query results.
 *
 * Uses a query ID to retrieve pre-saved query results from the database.
 * Does not require library or type parameters.
 *
 * @example
 * const options: PlexCopyQueryResultsOptions = {
 *   mode: 'query-results',
 *   queryId: 123,
 *   destination: '/path/to/dest',
 *   hardlink: true,
 * };
 */
export interface PlexCopyQueryResultsOptions extends PlexCopyBaseOptions {
  /** Discriminator for query-results mode */
  mode: "query-results";
  /** Query ID to copy from */
  queryId: number;
}

/**
 * Options for copying with a new query.
 *
 * Extends PlexQueryOptions with copy-specific configuration.
 * Executes a new query and copies the results.
 *
 * @example
 * const options: PlexCopyQueryOptions = {
 *   mode: 'query',
 *   library: 'Music',
 *   type: 'track',
 *   minTrackRating: 4,
 *   destination: '/path/to/dest',
 *   hardlink: true,
 *   preserveStructure: true,
 * };
 */
export interface PlexCopyQueryOptions extends PlexCopyBaseOptions, PlexQueryOptions {
  /** Discriminator for query mode (optional since it's the default) */
  mode?: "query";
}

/**
 * Discriminated union for all Plex copy options.
 *
 * Supports two modes:
 * - Query-results mode: Copy from saved query ID (mode: 'query-results')
 * - Query mode: Execute new query and copy results (mode: 'query' or undefined)
 */
export type PlexCopyOptions = PlexCopyQueryResultsOptions | PlexCopyQueryOptions;

/**
 * Result from a Plex-based copy operation.
 *
 * Provides metrics about files processed, including successes,
 * failures, and total data transferred.
 *
 * @example
 * const result: PlexCopyResult = {
 *   created: 150,
 *   skipped: 5,
 *   failed: [],
 *   totalSize: 1024 * 1024 * 500, // 500MB
 * };
 */
export interface PlexCopyResult {
  /** Number of files successfully created */
  created: number;
  /** Number of files skipped (already exist or missing) */
  skipped: number;
  /** List of failed file operations with error details */
  failed: FailedOperation[];
  /** Total size of copied files in bytes */
  totalSize: number;
  /** Name of created playlist (if createPlaylist option was used) */
  playlistCreated?: string;
}

/**
 * Plex-shaped playlist compatibility projection.
 *
 * Represents a Plex playlist with its associated metadata.
 * Used for listing and discovering playlists before export operations.
 *
 * @example
 * const playlist: PlexPlaylist = {
 *   ratingKey: '12345',
 *   title: 'My Favorites',
 *   smart: false,
 *   leafCount: 50,
 *   duration: 12000000,
 *   addedAt: 1704067200,
 *   updatedAt: 1704153600,
 * };
 */
/** @deprecated Use {@link MediaPlaylist} in provider-neutral implementation code. */
export interface PlexPlaylist {
  /** Unique identifier for the playlist in Plex */
  ratingKey: string;
  /** Playlist name/title */
  title: string;
  /** Whether this is a smart (auto-updating) playlist */
  smart: boolean;
  /** Number of tracks in the playlist */
  leafCount: number;
  /** Total duration of all tracks in milliseconds */
  duration: number;
  /** Unix timestamp when the playlist was created */
  addedAt: number;
  /** Unix timestamp when the playlist was last modified */
  updatedAt: number;
}

/**
 * Options for exporting a Plex playlist to a destination folder.
 *
 * Provides configuration for one-time playlist export operations,
 * including file handling, conversion, and progress display options.
 *
 * @example
 * const options: PlaylistExportOptions = {
 *   playlistName: 'My Favorites',
 *   destination: '/music/exports/favorites',
 *   hardlink: true,
 *   workers: 4,
 *   progress: true,
 * };
 */
export interface PlaylistExportOptions {
  /** Name of the playlist to find and export */
  playlistName: string;
  /** Destination folder path for exported tracks */
  destination: string;
  /** Use hardlinks instead of copies (when possible) */
  hardlink?: boolean;
  /** Convert files to specified format during export */
  convertFormat?: ConvertFormat;
  /** Preserve artist/album folder structure in destination */
  preserveStructure?: boolean;
  /** Output files directly to destination without playlist subfolder (default: false) */
  flat?: boolean;
  /** Custom folder name to use instead of playlist name (mutually exclusive with flat) */
  folder?: string;
  /** Number of parallel workers for file operations (default: 4) */
  workers?: number;
  /** Preview operations without executing them */
  dryRun?: boolean;
  /** Show progress bar during export operations */
  progress?: boolean;
  /** Trigger Plex library scan after export completes */
  plexScan?: boolean;
  /** Range of suffixes to create (e.g., 001-005) */
  range?: CopyRange;
  /** Number of copies to create (auto-detects next range from existing files) */
  count?: number;
  /** Enable Plex rating sync to destination files */
  syncRatings?: boolean;
  /** POPM email identifier for MP3 rating writes (default: 'no@email') */
  popmEmail?: string;
  /** Vorbis rating scale for FLAC/OGG writes */
  vorbisScale?: "normalized" | "stars" | "percent";
}

/**
 * Options for syncing a Plex playlist to a destination folder.
 *
 * Extends PlaylistExportOptions with sync-specific options for
 * incremental synchronization, including removal of tracks no
 * longer present in the playlist.
 *
 * @example
 * const options: PlaylistSyncOptions = {
 *   playlistName: 'My Favorites',
 *   destination: '/music/exports/favorites',
 *   deleteRemoved: true,
 *   workers: 4,
 *   progress: true,
 * };
 */
export interface PlaylistSyncOptions extends PlaylistExportOptions {
  /** Remove tracks from destination that are no longer in the playlist */
  deleteRemoved?: boolean;
}

/**
 * Options for creating a new Plex playlist from filtered tracks.
 *
 * Provides configuration for playlist creation, supporting both
 * static playlists (explicit track references) and smart playlists
 * (filter-based, auto-updating).
 *
 * @example
 * // Create a static playlist from filter criteria
 * const staticOptions: PlaylistCreateOptions = {
 *   playlistName: 'My Jazz Favorites',
 *   libraryName: 'Music',
 *   queryOptions: { library: 'Music', type: 'track', genre: 'Jazz', minTrackRating: 4 },
 *   progress: true,
 * };
 *
 * // Create a smart playlist
 * const smartOptions: PlaylistCreateOptions = {
 *   playlistName: '2020s Rock',
 *   libraryName: 'Music',
 *   smart: true,
 *   filterName: 'rock-2020s',
 * };
 */
export interface PlaylistCreateOptions {
  /** Name of the playlist to create */
  playlistName: string;
  /** Library name to query tracks from */
  libraryName?: string;
  /** Create as a smart (filter-based) playlist */
  smart?: boolean;
  /** Update existing playlist instead of throwing error */
  updateExisting?: boolean;
  /** Query options for filtering tracks (library/type can be omitted; action uses libraryName/filter) */
  queryOptions?: Partial<PlexQueryOptions>;
  /** Maximum number of tracks to add (global cap; distinct from queryOptions.limit per-page) */
  maxTracks?: number;
  /** Named filter from config file to use for track selection */
  filterName?: string;
  /** Show progress bar during track query */
  progress?: boolean;
  /** Preview operations without executing them */
  dryRun?: boolean;
  /** Plex server URL (overrides config) */
  url?: string;
  /** Plex authentication token (overrides config) */
  token?: string;
  /** Output in JSON format */
  json?: boolean;
}

/**
 * Result from a playlist create operation.
 *
 * Provides information about the created or updated playlist,
 * including the action taken and track count.
 *
 * @example
 * const result: PlaylistCreateResult = {
 *   playlistName: 'My Jazz Favorites',
 *   ratingKey: '12345',
 *   tracksAdded: 50,
 *   action: 'created',
 *   smart: false,
 * };
 */
export interface PlaylistCreateResult {
  /** Name of the created playlist */
  playlistName: string;
  /** Unique identifier for the playlist in Plex */
  ratingKey: string;
  /** Number of tracks added to the playlist */
  tracksAdded: number;
  /** Whether the playlist was created or updated */
  action: "created" | "updated";
  /** Whether this is a smart (filter-based) playlist */
  smart: boolean;
}

/**
 * Options for adding tracks to an existing Plex playlist.
 *
 * Provides configuration for adding tracks to an existing playlist
 * using filter criteria or named filters from config.
 *
 * @example
 * const options: PlaylistAddOptions = {
 *   playlistName: 'My Jazz Favorites',
 *   libraryName: 'Music',
 *   queryOptions: { library: 'Music', type: 'track', artist: 'Miles Davis' },
 *   progress: true,
 * };
 */
export interface PlaylistAddOptions {
  /** Name of the playlist to add tracks to */
  playlistName: string;
  /** Library name to query tracks from */
  libraryName?: string;
  /** Query options for filtering tracks (library/type can be omitted; action uses libraryName/filter) */
  queryOptions?: Partial<PlexQueryOptions>;
  /** Maximum number of tracks to add (global cap; distinct from queryOptions.limit per-page) */
  maxTracks?: number;
  /** Named filter from config file to use for track selection */
  filterName?: string;
  /** Show progress bar during track query */
  progress?: boolean;
  /** Preview operations without executing them */
  dryRun?: boolean;
  /** Plex server URL (overrides config) */
  url?: string;
  /** Plex authentication token (overrides config) */
  token?: string;
  /** Output in JSON format */
  json?: boolean;
}

/**
 * Result from a playlist add operation.
 *
 * Provides information about tracks added to the playlist,
 * including the new track count.
 *
 * @example
 * const result: PlaylistAddResult = {
 *   playlistName: 'My Jazz Favorites',
 *   ratingKey: '12345',
 *   tracksAdded: 15,
 *   totalTracks: 65,
 * };
 */
export interface PlaylistAddResult {
  /** Name of the playlist */
  playlistName: string;
  /** Unique identifier for the playlist in Plex */
  ratingKey: string;
  /** Number of tracks added in this operation */
  tracksAdded: number;
  /** Total number of tracks in the playlist after the operation */
  totalTracks: number;
}

/**
 * Result from a playlist export or sync operation.
 *
 * Provides metrics about tracks processed, including successes,
 * failures, and total data transferred.
 *
 * @example
 * const result: PlaylistExportResult = {
 *   playlistName: 'My Favorites',
 *   totalTracks: 50,
 *   created: 45,
 *   skipped: 5,
 *   failed: [],
 *   totalSize: 1024 * 1024 * 500, // 500MB
 * };
 */
export interface PlaylistExportResult {
  /** Name of the exported playlist */
  playlistName: string;
  /** Total number of tracks in the playlist */
  totalTracks: number;
  /** Number of files successfully created */
  created: number;
  /** Number of files skipped (already exist) */
  skipped: number;
  /** Number of files removed (only present in sync operations with deleteRemoved) */
  removed?: number;
  /** List of failed file operations with error details */
  failed: FailedOperation[];
  /** Total size of copied files in bytes */
  totalSize: number;
}

// ============================================================================
// Metadata Sync Types
// ============================================================================

/**
 * Sync direction discriminated union.
 * Uses discriminated union pattern for exhaustive type checking.
 *
 * @example
 * // Push mode: File ratings -> Plex
 * const push: SyncDirection = { type: 'push' };
 *
 * // Pull mode: Plex ratings -> File
 * const pull: SyncDirection = { type: 'pull' };
 *
 * // Bidirectional mode: requires prefer option
 * const both: SyncDirection = { type: 'both', prefer: 'plex' };
 */
export type SyncDirection =
  | { type: "push"; prefer?: never } // File -> Plex
  | { type: "pull"; prefer?: never } // Plex -> File
  | { type: "both"; prefer: "plex" | "file" }; // Bidirectional

/**
 * Options for metadata sync operations.
 *
 * Controls bidirectional rating synchronization between embedded file tags
 * (POPM for MP3, Vorbis comments for FLAC/OGG) and Plex Media Server.
 *
 * @example
 * const options: MetadataSyncOptions = {
 *   direction: { type: 'push' },
 *   library: 'Music',
 *   sourcePath: '/path/to/music',
 *   onlyRated: true,
 *   workers: 4,
 *   dryRun: false,
 * };
 */
export interface MetadataSyncOptions {
  /** Sync direction configuration */
  direction: SyncDirection;
  /** Plex library name to sync with */
  library: string;
  /** Source path containing audio files */
  sourcePath: string;
  /** Only sync tracks that have ratings */
  onlyRated?: boolean;
  /** Preview operations without executing */
  dryRun?: boolean;
  /** Number of parallel workers (default: 4) */
  workers?: number;
  /** Show progress bar during sync */
  progress?: boolean;
  /** POPM email identifier for MP3 writes */
  popmEmail?: string;
  /** Vorbis rating scale for FLAC/OGG writes */
  vorbisScale?: "normalized" | "stars" | "percent";
}

/**
 * Result of a metadata sync operation.
 *
 * Provides metrics about tracks processed, including successes,
 * skipped items, conflicts resolved, and failures.
 *
 * @example
 * const result: MetadataSyncResult = {
 *   totalTracks: 500,
 *   synced: 450,
 *   skipped: 45,
 *   conflicts: 5,
 *   failed: [],
 * };
 */
export interface MetadataSyncResult {
  /** Total number of tracks processed */
  totalTracks: number;
  /** Number of tracks successfully synced */
  synced: number;
  /** Number of tracks skipped (no change needed) */
  skipped: number;
  /** Number of conflicts resolved */
  conflicts: number;
  /** List of failed operations */
  failed: FailedOperation[];
}

/**
 * Represents a track with ratings from both sources for comparison.
 *
 * Used to build a comparison list before sync to identify which tracks
 * need updates and detect conflicts.
 *
 * @example
 * const comparison: SyncComparison = {
 *   filePath: '/music/Artist/Album/track.flac',
 *   ratingKey: '12345',
 *   fileRating: 0.8,
 *   plexRating: 0.6,
 *   isDifferent: true,
 * };
 */
export interface SyncComparison {
  /** Local file path */
  filePath: string;
  /** Plex track rating key */
  ratingKey: string;
  /** File rating (normalized 0-1), null if unrated */
  fileRating: number | null;
  /** Plex rating (normalized 0-1), null if unrated */
  plexRating: number | null;
  /** Whether ratings differ */
  isDifferent: boolean;
}

// ============================================================================
// Collection Types
// ============================================================================

/**
 * Plex-shaped collection compatibility projection.
 *
 * Represents a music collection in Plex, which can be either a static
 * collection (manually curated items) or a smart collection (filter-based,
 * auto-updating).
 *
 * @example
 * const collection: PlexCollection = {
 *   ratingKey: '12345',
 *   key: '/library/collections/12345/children',
 *   title: '2020s Rock',
 *   childCount: 50,
 *   smart: false,
 *   summary: 'My favorite rock tracks from the 2020s',
 *   addedAt: 1704067200,
 *   updatedAt: 1704153600,
 *   thumb: '/library/collections/12345/thumb/1704153600',
 *   type: 'collection',
 *   metadataType: 10,
 *   mediaType: 'track',
 * };
 */
/** @deprecated Use {@link MediaCollection} in provider-neutral implementation code. */
export interface PlexCollection {
  /** Unique identifier for the collection in Plex */
  ratingKey: string;
  /** API endpoint for this collection's children */
  key: string;
  /** Collection name/title */
  title: string;
  /** Number of items in the collection */
  childCount: number;
  /** Whether this is a smart (filter-based) or static collection */
  smart: boolean;
  /** Optional description of the collection */
  summary?: string;
  /** Unix timestamp when the collection was created */
  addedAt: number;
  /** Unix timestamp when the collection was last modified */
  updatedAt: number;
  /** Thumbnail URL for the collection */
  thumb?: string;
  /** Literal type discriminator for collection entities */
  type: "collection";
  /**
   * Plex metadata type code for collection items (artist=8, album=9, track=10).
   *
   * Optional for backward compatibility with older call paths/tests.
   */
  metadataType?: PlexMetadataTypeCode;
  /**
   * Human-readable collection item type derived from metadataType.
   *
   * Optional for backward compatibility with older call paths/tests.
   */
  mediaType?: PlexMediaType;
}

/**
 * Typed input for creating a new Plex collection.
 */
/** @deprecated Use {@link MediaCollectionCreateInput} in provider-neutral implementation code. */
export interface PlexCollectionCreateInput {
  /** Name of the collection to create */
  title: string;
  /**
   * Collection media type (artist, album, track).
   * Defaults to track when omitted.
   */
  mediaType?: PlexMediaType;
}

/**
 * Options for creating a new Plex collection.
 *
 * Provides configuration for collection creation, supporting both
 * static collections (empty or with initial items via filters) and
 * smart collections (filter-based, auto-updating).
 *
 * @example
 * // Create a static collection
 * const staticOptions: CollectionCreateOptions = {
 *   title: 'My Favorites',
 *   libraryKey: '1',
 *   mediaType: 'track',
 * };
 *
 * // Create a smart collection with filters
 * const smartOptions: CollectionCreateOptions = {
 *   title: '2020s Rock',
 *   libraryKey: '1',
 *   smart: true,
 *   filters: { genre: 'Rock', minYear: 2020 },
 * };
 */
export interface CollectionCreateOptions {
  /** Name + media type for the collection */
  title: PlexCollectionCreateInput["title"];
  /** Collection media type (defaults to track when omitted) */
  mediaType?: PlexCollectionCreateInput["mediaType"];
  /** Library section ID (not name) where collection will be created */
  libraryKey: string;
  /** Create as a smart (filter-based) collection */
  smart?: boolean;
  /** Filters for smart collections or initial item selection */
  filters?: PlexQueryFilters;
}

/**
 * Options for adding items to an existing Plex collection.
 *
 * Supports adding tracks, albums, or artists to a collection
 * via their rating keys.
 *
 * @example
 * const addOptions: CollectionAddOptions = {
 *   collectionKey: '12345',
 *   ratingKeys: ['100', '101', '102'],
 * };
 */
export interface CollectionAddOptions {
  /** Rating key of the collection to add items to */
  collectionKey: string;
  /** Rating keys of items (tracks/albums/artists) to add */
  readonly ratingKeys: readonly string[];
}

/**
 * Result from a collection create or add operation.
 *
 * Provides information about the collection after the operation,
 * including item counts for tracking what was added.
 *
 * @example
 * const result: CollectionResult = {
 *   collection: { ... },
 *   itemsAdded: 10,
 *   totalItems: 50,
 * };
 */
export interface CollectionResult {
  /** The created or modified collection metadata */
  collection: PlexCollection;
  /** Number of items added in this operation (for add operations) */
  itemsAdded?: number;
  /** Total number of items in the collection after the operation */
  totalItems: number;
}

// Re-export PlexQueryFilters from db.ts for collection usage
import type { PlexQueryFilters } from "./db.js";
export type { PlexQueryFilters };
