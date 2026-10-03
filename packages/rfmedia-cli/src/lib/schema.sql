-- Schema version tracking
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Track copy/sync operations
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,           -- ISO timestamp
  command TEXT NOT NULL,              -- 'copy-album', 'copy-filter', 'sync'
  mode TEXT NOT NULL,                 -- 'album', 'filter'
  input_file TEXT,                    -- Source file path (nullable for CLI args)
  options_hash TEXT NOT NULL,         -- e.g., 'album-001-010', 'filter-r80-mp3'
  rating_key TEXT,                    -- 'r80', 's3', null
  range_key TEXT,                     -- '001-010', null
  convert_key TEXT,                   -- 'mp3', 'alac', null
  status TEXT NOT NULL,               -- 'pending', 'completed', 'failed', 'partial'
  total_sources INTEGER DEFAULT 0,
  completed_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  started_at TEXT,                    -- ISO timestamp
  ended_at TEXT                       -- ISO timestamp
);

CREATE INDEX IF NOT EXISTS idx_operations_created ON operations(created_at);
CREATE INDEX IF NOT EXISTS idx_operations_input ON operations(input_file);
CREATE INDEX IF NOT EXISTS idx_operations_hash ON operations(options_hash);

-- Track individual source directories processed
CREATE TABLE IF NOT EXISTS completed_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  completed_at TEXT NOT NULL,         -- ISO timestamp
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
  UNIQUE(operation_id, source_path)
);

-- operation_id lookups are covered by the implicit UNIQUE(operation_id, source_path) index
CREATE INDEX IF NOT EXISTS idx_completed_source ON completed_sources(source_path);

-- Track failed sources with error details
CREATE TABLE IF NOT EXISTS failed_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  error_message TEXT,
  failed_at TEXT NOT NULL,            -- ISO timestamp
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
  UNIQUE(operation_id, source_path)
);

-- operation_id lookups are covered by the implicit UNIQUE(operation_id, source_path) index
CREATE INDEX IF NOT EXISTS idx_failed_source ON failed_sources(source_path);

-- Track file inventory for sync operations
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,          -- Source directory
  relative_path TEXT NOT NULL,        -- File path relative to source
  mtime INTEGER NOT NULL,             -- Modification time (epoch ms)
  size INTEGER NOT NULL,              -- File size in bytes
  rating REAL,                        -- Normalized rating 0.0-1.0 (nullable)
  genre TEXT,                         -- First genre from metadata (nullable)
  year INTEGER,                       -- Release year (nullable)
  bpm REAL,                           -- Beats per minute (nullable, floating point for precision)
  artist TEXT,                        -- Primary artist (nullable)
  dest_path TEXT NOT NULL,            -- Absolute destination path
  content_hash TEXT,                  -- SHA-256 hash of destination bytes (nullable)
  copied_at INTEGER NOT NULL,         -- Timestamp when copied (epoch ms)
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
  UNIQUE(operation_id, source_path, relative_path)
);

-- operation_id lookups are covered by the implicit UNIQUE(operation_id, source_path, relative_path) index
CREATE INDEX IF NOT EXISTS idx_inventory_source ON inventory(source_path);
CREATE INDEX IF NOT EXISTS idx_inventory_dest ON inventory(dest_path);
CREATE INDEX IF NOT EXISTS idx_inventory_rating ON inventory(rating);
CREATE INDEX IF NOT EXISTS idx_inventory_genre ON inventory(genre);
CREATE INDEX IF NOT EXISTS idx_inventory_year ON inventory(year);
CREATE INDEX IF NOT EXISTS idx_inventory_bpm ON inventory(bpm);
CREATE INDEX IF NOT EXISTS idx_inventory_artist ON inventory(artist);

-- Track individual album copy suffixes for granular per-path range tracking
-- This enables range expansion: if 001-002 was completed, running with 001-020
-- will only process 003-020 instead of skipping the entire source.
-- The rating_key column enables rating-aware tracking: different rating filters
-- create separate tracking states (e.g., r50 vs r80 are tracked independently).
CREATE TABLE IF NOT EXISTS completed_album_copies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,          -- Source album directory
  album_name TEXT NOT NULL,           -- Album folder name (basename)
  suffix TEXT NOT NULL,               -- Suffix that was completed (e.g., '001', '002')
  rating_key TEXT,                    -- Rating filter key (e.g., 'r80', 's3', null for no filter)
  completed_at TEXT NOT NULL,         -- ISO timestamp
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
  UNIQUE(operation_id, source_path, album_name, suffix, rating_key)
);

-- operation_id lookups are covered by the implicit
-- UNIQUE(operation_id, source_path, album_name, suffix, rating_key) index
CREATE INDEX IF NOT EXISTS idx_completed_album_copies_source ON completed_album_copies(source_path);
CREATE INDEX IF NOT EXISTS idx_completed_album_copies_album ON completed_album_copies(album_name);
CREATE INDEX IF NOT EXISTS idx_completed_album_copies_rating ON completed_album_copies(rating_key);

-- Track undo/history sessions (replaces JSONL file headers)
CREATE TABLE IF NOT EXISTS history_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,        -- {timestamp}-{command}-{pid}
  version TEXT NOT NULL,                  -- Format version "1"
  command TEXT NOT NULL,                  -- 'copy', 'clean', etc.
  started_at TEXT NOT NULL,               -- ISO timestamp
  ended_at TEXT,                          -- ISO timestamp (nullable)
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'undone', 'partial'
  cwd TEXT NOT NULL,                      -- Working directory
  operation_count INTEGER DEFAULT 0       -- Total operations
);

-- session_id lookups are covered by the implicit UNIQUE index on the column
CREATE INDEX IF NOT EXISTS idx_history_sessions_started_at ON history_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_sessions_status ON history_sessions(status);

-- Track individual filesystem operations
CREATE TABLE IF NOT EXISTS history_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,            -- FK to history_sessions.id
  operation_type TEXT NOT NULL,           -- 'copy', 'hardlink', 'convert', 'mkdir', 'remove', 'trash'
  occurred_at TEXT NOT NULL,              -- ISO timestamp
  source_path TEXT,                       -- Source file (nullable for mkdir/remove/trash)
  dest_path TEXT NOT NULL,                -- Destination file/directory
  created_dir INTEGER DEFAULT 0,          -- Boolean: 1 if mkdir created dir
  convert_format TEXT,                    -- Target format for convert ops
  FOREIGN KEY (session_id) REFERENCES history_sessions(id) ON DELETE CASCADE
);

-- Composite index serves both the session_id filter and the occurred_at
-- ordering used when replaying a session for undo
CREATE INDEX IF NOT EXISTS idx_history_operations_session_occurred
  ON history_operations(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_history_operations_type ON history_operations(operation_type);

-- Queue jobs (replaces ~/.rfmedia/queue.json)
-- Stores batch jobs for copy and delete operations with interactive selection support
CREATE TABLE IF NOT EXISTS queue_jobs (
  id TEXT PRIMARY KEY,              -- UUID
  job_type TEXT NOT NULL,           -- 'copy' | 'delete'
  added_at TEXT NOT NULL,           -- ISO timestamp
  destination TEXT NOT NULL,
  options_json TEXT NOT NULL,       -- SerializableCopyOptions/DeleteOptions as JSON
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'completed' | 'failed'
  source TEXT,                      -- Single source path (nullable for multi-source jobs)
  started_at TEXT,                  -- ISO timestamp (nullable)
  completed_at TEXT,                -- ISO timestamp (nullable)
  error TEXT                        -- Error message for failed jobs (nullable)
);

-- Composite index serves status-filtered job listing ordered by added_at
-- (e.g., next pending job) without a separate sort step
CREATE INDEX IF NOT EXISTS idx_queue_jobs_status_added ON queue_jobs(status, added_at);
CREATE INDEX IF NOT EXISTS idx_queue_jobs_job_type ON queue_jobs(job_type);

-- Multi-source entries (from --paths YAML or --file)
CREATE TABLE IF NOT EXISTS queue_job_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_index INTEGER,             -- --source-idx selection
  source_name TEXT,                 -- --source-name selection
  source_artist TEXT,               -- --artist selection
  source_group TEXT,                -- --group selection
  range_start INTEGER,              -- Per-source range override
  range_end INTEGER,                -- Per-source range override
  count INTEGER,                    -- Per-source count override
  FOREIGN KEY (job_id) REFERENCES queue_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queue_job_sources_job ON queue_job_sources(job_id);

-- Interactive selections (preserves ReadonlyMap data)
-- Stores user's interactive suffix/album/track selections that would otherwise be lost in JSON serialization
CREATE TABLE IF NOT EXISTS queue_job_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  selection_type TEXT NOT NULL,     -- 'copy' | 'delete'
  level TEXT,                       -- 'album' | 'track' (copy only, nullable for delete)
  FOREIGN KEY (job_id) REFERENCES queue_jobs(id) ON DELETE CASCADE,
  UNIQUE(job_id, source_path)
);

CREATE INDEX IF NOT EXISTS idx_queue_job_selections_job ON queue_job_selections(job_id);

-- Selected items (albums, tracks, or suffixes)
-- Individual items selected during interactive mode
CREATE TABLE IF NOT EXISTS queue_job_selected_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,          -- 'album' | 'track' | 'suffix'
  item_value TEXT NOT NULL,         -- Album name, track path, or suffix path
  FOREIGN KEY (selection_id) REFERENCES queue_job_selections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queue_job_selected_items_selection ON queue_job_selected_items(selection_id);

-- Plex query history and results storage
-- Stores query metadata for `plex query` command results
CREATE TABLE IF NOT EXISTS plex_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,             -- ISO timestamp
  library_name TEXT NOT NULL,           -- Plex library name
  media_type TEXT NOT NULL,             -- 'track', 'album', 'artist'
  filters_json TEXT NOT NULL,           -- JSON of query filters
  result_count INTEGER DEFAULT 0,       -- Number of results returned
  total_count INTEGER DEFAULT 0,        -- Total matches available in Plex
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'failed'
  name TEXT                             -- Optional user-provided name for saved queries
);

CREATE INDEX IF NOT EXISTS idx_plex_queries_created ON plex_queries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plex_queries_library ON plex_queries(library_name);
CREATE INDEX IF NOT EXISTS idx_plex_queries_media_type ON plex_queries(media_type);
CREATE INDEX IF NOT EXISTS idx_plex_queries_status ON plex_queries(status);
CREATE INDEX IF NOT EXISTS idx_plex_queries_name ON plex_queries(name);

-- Plex query results storage
-- Stores individual results from Plex queries for later use in `plex copy`
CREATE TABLE IF NOT EXISTS plex_query_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_id INTEGER NOT NULL,            -- FK to plex_queries.id
  rating_key TEXT NOT NULL,             -- Plex item ID
  media_type TEXT NOT NULL,             -- 'track', 'album', 'artist'
  title TEXT NOT NULL,                  -- Item title
  artist TEXT,                          -- Artist name (nullable for artists themselves)
  album TEXT,                           -- Album name (only for tracks)
  user_rating REAL NOT NULL DEFAULT 0,  -- 0-10 scale rating
  view_count INTEGER,                   -- Play count (nullable)
  year INTEGER,                         -- Release year (nullable)
  file_path TEXT,                       -- Absolute file path (only for tracks)
  track_count INTEGER,                  -- Number of tracks (only for albums)
  album_count INTEGER,                  -- Number of albums (only for artists)
  FOREIGN KEY (query_id) REFERENCES plex_queries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plex_query_results_query ON plex_query_results(query_id);
CREATE INDEX IF NOT EXISTS idx_plex_query_results_rating_key ON plex_query_results(rating_key);
CREATE INDEX IF NOT EXISTS idx_plex_query_results_media_type ON plex_query_results(media_type);
CREATE INDEX IF NOT EXISTS idx_plex_query_results_user_rating ON plex_query_results(user_rating);
CREATE INDEX IF NOT EXISTS idx_plex_query_results_artist ON plex_query_results(artist);

-- Playlist export tracking for sync operations
-- Stores metadata about playlist exports for incremental sync capabilities
CREATE TABLE IF NOT EXISTS playlist_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  playlist_key TEXT NOT NULL,
  playlist_name TEXT NOT NULL,
  destination TEXT NOT NULL,
  track_count INTEGER DEFAULT 0,
  last_synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_playlist_exports_key ON playlist_exports(playlist_key, destination);

-- Playlist export tracks for sync state tracking
-- Stores individual tracks for computing sync diffs
CREATE TABLE IF NOT EXISTS playlist_export_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  export_id INTEGER NOT NULL,
  track_rating_key TEXT NOT NULL,
  source_path TEXT NOT NULL,
  dest_path TEXT NOT NULL,
  FOREIGN KEY (export_id) REFERENCES playlist_exports(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlist_export_tracks_export ON playlist_export_tracks(export_id);

-- Smart playlist definitions
-- Stores smart playlist configuration for M3U generation from filters or Plex playlists
CREATE TABLE IF NOT EXISTS smart_playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT NOT NULL UNIQUE,
  output_path TEXT NOT NULL,
  source_type TEXT NOT NULL,          -- 'filter' | 'plex-playlist'
  source_name TEXT NOT NULL,          -- Filter name or Plex playlist name
  relative_paths INTEGER DEFAULT 0,
  track_count INTEGER DEFAULT 0
);

-- name lookups are covered by the implicit UNIQUE index on the column

-- Smart playlist generation history
-- Tracks when playlists were generated for update/history support
CREATE TABLE IF NOT EXISTS smart_playlist_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  track_count INTEGER NOT NULL,
  FOREIGN KEY (playlist_id) REFERENCES smart_playlists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_smart_playlist_history_playlist_id ON smart_playlist_history(playlist_id);

-- Individual tracks in a smart playlist generation
-- Stores track metadata for each generation for comparison and display
CREATE TABLE IF NOT EXISTS smart_playlist_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  history_id INTEGER NOT NULL,
  track_order INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  title TEXT,
  artist TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (history_id) REFERENCES smart_playlist_history(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_smart_playlist_tracks_history_id ON smart_playlist_tracks(history_id);

-- Version 10: Lidarr resilience layer (issue #195)
-- Deferred mutation intents replayed explicitly after Lidarr/metadata outages
CREATE TABLE IF NOT EXISTS lidarr_deferred_intents (
  id TEXT PRIMARY KEY,                       -- UUID (queue_jobs TEXT-PK precedent: replay-stable ids for #202)
  origin TEXT NOT NULL,
  operation TEXT NOT NULL,
  tier TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|in-progress|succeeded|failed|cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  error_code TEXT,
  error_message TEXT,                        -- scrubbed; never raw bodies or credentials
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  UNIQUE(origin, idempotency_key)            -- + INSERT OR IGNORE = idempotent enqueue
);
CREATE INDEX IF NOT EXISTS idx_lidarr_deferred_intents_status
  ON lidarr_deferred_intents(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_lidarr_deferred_intents_origin
  ON lidarr_deferred_intents(origin);

-- Persistent metadata cache served stale only under explicit --allow-stale
CREATE TABLE IF NOT EXISTS lidarr_metadata_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,      -- schema convention (TEXT-PK exception is queue_jobs only)
  origin TEXT NOT NULL,
  category TEXT NOT NULL,
  discriminator TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,                  -- TTL/staleness computed at read time from config
  UNIQUE(origin, category, discriminator)
);

-- Circuit-breaker state shared across CLI invocations (no-daemon recovery)
CREATE TABLE IF NOT EXISTS lidarr_circuit_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  scope TEXT NOT NULL,                       -- 'lidarr' | 'metadata'
  state TEXT NOT NULL DEFAULT 'closed',      -- 'closed' | 'open' | 'half-open' (queryable summary)
  state_json TEXT NOT NULL,                  -- full CircuitState union (extensible without schema bumps)
  updated_at TEXT NOT NULL,
  UNIQUE(origin, scope)
);

-- Version 11: Plex-Lidarr artist identity snapshots (issue #207)
-- Complete validated documents are replaced atomically per provider-instance scope
CREATE TABLE IF NOT EXISTS bridge_identity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plex_origin TEXT NOT NULL,
  plex_machine_id TEXT NOT NULL,
  plex_library_id TEXT NOT NULL,
  lidarr_origin TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind = 'artist'),
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
  resolver_version INTEGER NOT NULL CHECK (resolver_version > 0),
  payload_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  UNIQUE(plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind)
);

-- Initialize schema version
-- Version 2: Added completed_album_copies table for granular per-path range tracking
-- Version 3: Added rating_key column to completed_album_copies for rating-aware tracking
-- Version 4: Added queue tables (queue_jobs, queue_job_sources, queue_job_selections, queue_job_selected_items)
-- Version 5: Added plex_queries and plex_query_results tables for Plex query history
-- Version 6: Added playlist_exports and playlist_export_tracks tables for playlist sync tracking
-- Version 7: Added smart_playlists, smart_playlist_history, and smart_playlist_tracks tables
-- Version 8: SQLite optimization audit (#112) - dropped indexes redundant with implicit
--            UNIQUE indexes, added composite indexes for sorted lookups
-- Version 9: Added inventory.content_hash for copied destination SHA-256 hashes
-- Version 10: Added Lidarr resilience tables (lidarr_deferred_intents,
--             lidarr_metadata_cache, lidarr_circuit_state) for issue #195
-- Version 11: Added bridge_identity_snapshots for Plex-Lidarr artist identity mapping
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '11');

-- Migration from version 1 to version 2
-- The completed_album_copies table is created via CREATE IF NOT EXISTS, so no explicit migration needed.

-- Migration from version 2 to version 3
-- Add rating_key column to completed_album_copies if it doesn't exist
-- SQLite doesn't support ADD COLUMN IF NOT EXISTS, so migration must be handled in application code
-- when opening existing databases. The new UNIQUE constraint will be enforced by the schema.

-- Migration from version 4 to version 5
-- The plex_queries and plex_query_results tables are created via CREATE IF NOT EXISTS in schema.sql.
-- Existing databases at v4 will have these tables created automatically during migration.
-- The migration logic updates the schema_version metadata to reflect the upgrade.

-- Migration from version 7 to version 8 (#112)
-- Drop indexes that duplicate the prefix of an implicit UNIQUE index (pure
-- write amplification) and indexes superseded by the new composite indexes
-- above. These statements are idempotent no-ops once applied.
DROP INDEX IF EXISTS idx_completed_operation;
DROP INDEX IF EXISTS idx_failed_operation;
DROP INDEX IF EXISTS idx_inventory_operation;
DROP INDEX IF EXISTS idx_completed_album_copies_operation;
DROP INDEX IF EXISTS idx_history_sessions_session_id;
DROP INDEX IF EXISTS idx_smart_playlists_name;
DROP INDEX IF EXISTS idx_history_operations_session;
DROP INDEX IF EXISTS idx_queue_jobs_status;
UPDATE metadata SET value = '8' WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 8;

-- Migration from version 8 to version 9
-- The inventory.content_hash column is created for new databases by CREATE TABLE.
-- Existing databases get the column from application migration code because
-- SQLite does not support ADD COLUMN IF NOT EXISTS.
