/**
 * Database-related type definitions for rfmedia CLI.
 */

import type Database from "better-sqlite3";

/**
 * Database connection handle.
 */
export type DbConnection = Database.Database;

/**
 * Operation record from the database.
 */
export interface DbOperation {
  id: number;
  created_at: string;
  command: string;
  mode: "album" | "filter";
  input_file: string | null;
  options_hash: string;
  rating_key: string | null;
  range_key: string | null;
  convert_key: string | null;
  status: "pending" | "completed" | "failed" | "partial";
  total_sources: number;
  completed_count: number;
  failed_count: number;
  started_at: string | null;
  ended_at: string | null;
}

/**
 * Completed source record from the database.
 */
export interface DbCompletedSource {
  id: number;
  operation_id: number;
  source_path: string;
  completed_at: string;
}

/**
 * Failed source record from the database.
 */
export interface DbFailedSource {
  id: number;
  operation_id: number;
  source_path: string;
  error_message: string | null;
  failed_at: string;
}

/**
 * Completed album copy record from the database.
 * Tracks individual album suffix copies for granular per-path range tracking.
 * Includes rating_key for rating-aware tracking (different rating filters
 * create separate tracking states).
 */
export interface DbCompletedAlbumCopy {
  id: number;
  operation_id: number;
  source_path: string;
  album_name: string;
  suffix: string;
  /** Rating filter key (e.g., 'r80', 's3', null for no filter) */
  rating_key: string | null;
  completed_at: string;
}

/**
 * Inventory entry from the database.
 */
export interface DbInventoryEntry {
  id: number;
  operation_id: number;
  source_path: string;
  relative_path: string;
  mtime: number;
  size: number;
  rating: number | null;
  genre: string | null;
  year: number | null;
  bpm: number | null;
  artist: string | null;
  dest_path: string;
  content_hash: string | null;
  copied_at: number;
}

/**
 * Inventory fingerprint candidate joined with its producing operation.
 *
 * Candidate identity is resolved by the verification policy; duplicate rows
 * remain visible so ambiguous evidence can fail closed.
 */
export interface DbInventoryFingerprint extends DbInventoryEntry {
  convert_key: string | null;
}

/**
 * Inventory row selected for metadata reconciliation.
 *
 * Rows retain their operation and row identities so duplicate destinations
 * remain visible to the reconciliation policy and later writes can be guarded.
 */
export type DbReconciliationInventoryCandidate = DbInventoryEntry;

/**
 * Filesystem identity captured with an immutable reconciliation database snapshot.
 *
 * The writable reconciliation boundary requires this exact device/inode pair so
 * a replaced path cannot silently redirect an approved apply to another file.
 */
export interface ReconciliationDatabaseFileIdentity {
  readonly device: number;
  readonly inode: number;
}

/**
 * Whole-database generation reviewed by reconciliation.
 *
 * Active SQLite sidecars are never part of a valid generation. The additional
 * size and timestamp evidence makes this token suitable for cheaply rejecting
 * external commits without reopening or cloning the database.
 */
export interface ReconciliationDatabaseGeneration extends ReconciliationDatabaseFileIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/**
 * Immutable reconciliation database snapshot and its on-disk file identity.
 */
export interface ReconciliationDatabaseReadOnlySnapshot {
  readonly database: DbConnection;
  readonly identity: ReconciliationDatabaseFileIdentity;
  readonly generation: ReconciliationDatabaseGeneration;
}

/**
 * Result of one identity- and generation-pinned reconciliation write.
 */
export interface ReconciliationDatabaseWritableResult<T> {
  readonly value: T;
  readonly generation: ReconciliationDatabaseGeneration;
}

/**
 * Exclusive authority over the reviewed reconciliation database generation.
 *
 * The connection has an active immediate transaction for exact-row guards and
 * optional inventory updates. Commit and rollback both release every pinned
 * descriptor; close is an idempotent rollback-safe cleanup operation.
 */
export interface ReconciliationDatabaseAuthorityLease {
  readonly connection: DbConnection;
  commit(): ReconciliationDatabaseGeneration;
  rollback(): void;
  close(): void;
}

/**
 * Facts captured when a reconciliation inventory row was reviewed.
 */
export interface ReconciliationInventoryGuard {
  readonly rowId: number;
  readonly operationId: number;
  readonly destPath: string;
  readonly rating: number | null;
  readonly mtime: number;
  readonly size: number;
}

/**
 * New filesystem stat evidence for an existing inventory row.
 */
export interface ReconciliationInventoryStatUpdate {
  readonly mtime: number;
  readonly size: number;
}

/**
 * Exact optimistic inventory update for metadata reconciliation.
 *
 * A request must update a rating, stat evidence, or both. Non-rating metadata
 * and inventory provenance are intentionally outside this contract.
 */
export type ReconciliationInventoryUpdate = {
  readonly expected: ReconciliationInventoryGuard;
} & (
  | {
      readonly rating: number;
      readonly stat?: ReconciliationInventoryStatUpdate;
    }
  | {
      readonly rating?: never;
      readonly stat: ReconciliationInventoryStatUpdate;
    }
);

/**
 * Result of an exact optimistic reconciliation inventory update.
 */
export type ReconciliationInventoryUpdateResult =
  | {
      readonly status: "updated";
      readonly rowId: number;
    }
  | {
      readonly status: "stale-evidence";
      readonly rowId: number;
    };

/**
 * Parameters for creating a new operation.
 */
export interface CreateOperationParams {
  command: string;
  mode: "album" | "filter";
  inputFile: string | null;
  optionsHash: string;
  ratingKey: string | null;
  rangeKey: string | null;
  convertKey: string | null;
  totalSources?: number;
}

/**
 * Filter for finding operations.
 */
export interface OperationFilter {
  inputFile?: string;
  optionsHash?: string;
  mode?: "album" | "filter";
  status?: string;
}

/**
 * Operation count updates.
 */
export interface OperationCounts {
  totalSources?: number;
  completedCount?: number;
  failedCount?: number;
}

/**
 * History session record from the database (replaces JSONL file headers).
 */
export interface DbHistorySession {
  id: number;
  session_id: string;
  version: string;
  command: string;
  started_at: string;
  ended_at: string | null;
  status: "pending" | "undone" | "partial";
  cwd: string;
  operation_count: number;
}

/**
 * History operation record from the database (replaces JSONL entries).
 */
export interface DbHistoryOperation {
  id: number;
  session_id: number;
  operation_type: "copy" | "hardlink" | "convert" | "mkdir" | "remove" | "trash";
  occurred_at: string;
  source_path: string | null;
  dest_path: string;
  created_dir: number;
  convert_format: string | null;
}

/**
 * Parameters for creating a new history session.
 */
export interface CreateHistorySessionParams {
  sessionId: string;
  version: string;
  command: string;
  startedAt: string;
  cwd: string;
}

/**
 * Parameters for recording a history operation.
 */
export interface RecordHistoryOperationParams {
  sessionId: number;
  operationType: "copy" | "hardlink" | "convert" | "mkdir" | "remove" | "trash";
  occurredAt: string;
  sourcePath?: string;
  destPath: string;
  createdDir?: boolean;
  convertFormat?: string;
}

/**
 * Filter for querying history sessions.
 */
export interface HistorySessionFilter {
  status?: "pending" | "undone" | "partial";
  command?: string;
  limit?: number;
}

/**
 * Queue job record from the database.
 * Replaces the JSON-based queue file with database storage.
 */
export interface DbQueueJob {
  id: string;
  job_type: "copy" | "delete";
  added_at: string;
  destination: string;
  options_json: string;
  status: "pending" | "running" | "completed" | "failed";
  source: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

/**
 * Queue job source record from the database.
 * Stores multi-source entries from --paths YAML or --file options.
 */
export interface DbQueueJobSource {
  id: number;
  job_id: string;
  source_path: string;
  source_index: number | null;
  source_name: string | null;
  source_artist: string | null;
  source_group: string | null;
  range_start: number | null;
  range_end: number | null;
  count: number | null;
}

/**
 * Queue job selection record from the database.
 * Preserves interactive selection data that cannot be JSON-serialized (ReadonlyMap).
 */
export interface DbQueueJobSelection {
  id: number;
  job_id: string;
  source_path: string;
  selection_type: "copy" | "delete";
  level: "album" | "track" | null;
}

/**
 * Queue job selected item record from the database.
 * Individual items selected during interactive mode (albums, tracks, or suffixes).
 */
export interface DbQueueJobSelectedItem {
  id: number;
  selection_id: number;
  item_type: "album" | "track" | "suffix";
  item_value: string;
}

/**
 * Plex query record from the database.
 * Stores metadata about executed Plex queries for history and reuse.
 */
export interface DbPlexQuery {
  id: number;
  created_at: string;
  library_name: string;
  media_type: "track" | "album" | "artist";
  filters_json: string;
  result_count: number;
  total_count: number;
  status: "pending" | "completed" | "failed";
  name: string | null;
}

/**
 * Plex query result record from the database.
 * Stores individual results from Plex queries for later use in `plex copy`.
 */
export interface DbPlexQueryResult {
  id: number;
  query_id: number;
  rating_key: string;
  media_type: "track" | "album" | "artist";
  title: string;
  artist: string | null;
  album: string | null;
  user_rating: number;
  view_count: number | null;
  year: number | null;
  file_path: string | null;
  track_count: number | null;
  album_count: number | null;
}

/**
 * Parameters for creating a new Plex query record.
 */
export interface CreatePlexQueryParams {
  libraryName: string;
  mediaType: "track" | "album" | "artist";
  filters: PlexQueryFilters;
  name?: string;
}

/**
 * Filters object type for Plex queries.
 * Stored as JSON in the database.
 */
export interface PlexQueryFilters {
  /** Name of the plexFilters config entry used (if any) */
  filterName?: string;
  /** Minimum artist star rating (1-5 scale) */
  minArtistRating?: number;
  /** Maximum artist star rating (1-5 scale) */
  maxArtistRating?: number;
  /** Minimum album star rating (1-5 scale) */
  minAlbumRating?: number;
  /** Maximum album star rating (1-5 scale) */
  maxAlbumRating?: number;
  /** Minimum track star rating (1-5 scale) */
  minTrackRating?: number;
  /** Maximum track star rating (1-5 scale) */
  maxTrackRating?: number;
  /** Filter by genre name */
  genre?: string;
  /** Filter by style tag (e.g., 'Jazz', 'Fusion') - only for artists/albums */
  style?: string;
  /** Filter by mood tag (e.g., 'Relaxing', 'Energetic') */
  mood?: string;
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
}

/**
 * Options for listing Plex queries.
 */
export interface PlexQueryListOptions {
  /** Filter by library name */
  libraryName?: string;
  /** Filter by media type */
  mediaType?: "track" | "album" | "artist";
  /** Filter by status */
  status?: "pending" | "completed" | "failed";
  /** Filter by name (partial match) */
  name?: string;
  /** Maximum number of results to return */
  limit?: number;
}

/**
 * Plex query result for saving to database.
 * Represents a single item from Plex query results.
 */
export interface PlexQueryResultItem {
  ratingKey: string;
  mediaType: "track" | "album" | "artist";
  title: string;
  artist?: string;
  album?: string;
  userRating: number;
  viewCount?: number;
  year?: number;
  filePath?: string;
  trackCount?: number;
  albumCount?: number;
}

/**
 * Playlist export record from the database.
 * Stores metadata about playlist exports for incremental sync capabilities.
 */
export interface DbPlaylistExport {
  id: number;
  created_at: string;
  playlist_key: string;
  playlist_name: string;
  destination: string;
  track_count: number;
  last_synced_at: string | null;
}

/**
 * Playlist export track record from the database.
 * Stores individual track paths for computing sync diffs.
 */
export interface DbPlaylistExportTrack {
  id: number;
  export_id: number;
  track_rating_key: string;
  source_path: string;
  dest_path: string;
}

/**
 * Smart playlist definition record from the database.
 * Stores smart playlist configuration for M3U generation from filters or Plex playlists.
 */
export interface DbSmartPlaylist {
  id: number;
  created_at: string;
  updated_at: string;
  name: string;
  output_path: string;
  source_type: "filter" | "plex-playlist";
  source_name: string;
  relative_paths: number;
  track_count: number;
}

/**
 * Smart playlist generation history record from the database.
 * Tracks when playlists were generated for update/history support.
 */
export interface DbSmartPlaylistHistory {
  id: number;
  playlist_id: number;
  generated_at: string;
  track_count: number;
}

/**
 * Smart playlist track record from the database.
 * Stores track metadata for each generation for comparison and display.
 */
export interface DbSmartPlaylistTrack {
  id: number;
  history_id: number;
  track_order: number;
  file_path: string;
  title: string | null;
  artist: string | null;
  duration_ms: number | null;
}

/**
 * Parameters for creating a new smart playlist.
 */
export interface CreateSmartPlaylistParams {
  name: string;
  outputPath: string;
  sourceType: "filter" | "plex-playlist";
  sourceName: string;
  relativePaths?: boolean;
}

/**
 * Parameters for updating a smart playlist.
 * When recreating a playlist with the same name, pass full config so the DB stays in sync.
 */
export interface UpdateSmartPlaylistParams {
  trackCount?: number;
  outputPath?: string;
  sourceType?: "filter" | "plex-playlist";
  sourceName?: string;
  relativePaths?: boolean;
}

/**
 * Track info for recording playlist history.
 */
export interface SmartPlaylistTrackInfo {
  filePath: string;
  title?: string;
  artist?: string;
  durationMs?: number;
}

/**
 * Lidarr deferred mutation intent record from the database (schema v10).
 *
 * Operation-generic replay records for the Lidarr resilience layer (#195);
 * mutation producers/executors land with #202. Idempotent on
 * (origin, idempotency_key) via INSERT OR IGNORE.
 */
export interface DbLidarrDeferredIntent {
  /** UUID primary key (queue_jobs TEXT-PK precedent: replay-stable ids). */
  id: string;
  /** Credential-free canonical Lidarr origin — never the API key. */
  origin: string;
  /** Executor-map key, e.g. 'lidarr add artist' (#202 vocabulary; opaque here). */
  operation: string;
  tier: "local-only" | "metadata-dependent" | "discovery" | "destructive";
  payload_json: string;
  idempotency_key: string;
  status: "pending" | "in-progress" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  /** LidarrErrorCode value; raw TEXT at the row layer (domain layer narrows). */
  error_code: string | null;
  /** Scrubbed message — never raw response bodies or credentials. */
  error_message: string | null;
  created_at: string;
  updated_at: string;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
}

/**
 * Lidarr metadata cache entry from the database (schema v10).
 *
 * Keyed by origin + category + discriminator ('' for whole-list snapshots);
 * keys never contain the API key. TTL/staleness is computed at read time
 * from config, so rows carry only the fetch timestamp.
 */
export interface DbLidarrMetadataCacheEntry {
  id: number;
  /** Credential-free canonical Lidarr origin — never the API key. */
  origin: string;
  /** Cache category ('artists' | 'system-status' in v1; extensible without schema bumps). */
  category: string;
  /** Sub-key within a category; '' for whole-list snapshots. */
  discriminator: string;
  payload_json: string;
  /** ISO timestamp of the successful fetch that produced this row. */
  fetched_at: string;
}

/**
 * Lidarr circuit-breaker state record from the database (schema v10).
 *
 * One row per (origin, scope); persists breaker state so consecutive CLI
 * invocations share cooldown/half-open behavior (no-daemon recovery).
 */
export interface DbLidarrCircuitState {
  id: number;
  /** Credential-free canonical Lidarr origin — never the API key. */
  origin: string;
  scope: "lidarr" | "metadata";
  /** Queryable summary of the persisted state discriminant. */
  state: "closed" | "open" | "half-open";
  /** Full serialized CircuitState union (extensible without schema bumps). */
  state_json: string;
  updated_at: string;
}

/**
 * Parameters for creating a new Lidarr deferred intent row.
 *
 * Timestamps and defaulted columns (status, attempts) are populated by the
 * CRUD layer; the caller supplies the replay-stable identity and payload.
 */
export interface CreateLidarrDeferredIntentParams {
  /** UUID primary key generated by the caller (replay-stable for #202 --resume). */
  id: string;
  /** Credential-free canonical Lidarr origin — never the API key. */
  origin: string;
  /** Executor-map key for replay (#202 vocabulary; opaque here). */
  operation: string;
  tier: "local-only" | "metadata-dependent" | "discovery" | "destructive";
  payloadJson: string;
  idempotencyKey: string;
  /** Maximum replay attempts (defaults to 5 in the schema when omitted). */
  maxAttempts?: number;
  /** Seed LidarrErrorCode from the failure that deferred this intent. */
  errorCode?: string | null;
  /** Scrubbed failure message — never raw response bodies or credentials. */
  errorMessage?: string | null;
  /** ISO timestamp before which replay must not attempt this intent. */
  nextAttemptAt?: string | null;
}
