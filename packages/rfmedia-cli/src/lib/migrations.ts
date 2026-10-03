/**
 * Database migration system for rfmedia CLI.
 * Handles schema version upgrades.
 */

import type { DbConnection } from "../types/db.js";
import { getCurrentSchemaVersion } from "./db.js";
import { logDebug } from "./logger.js";

/**
 * Current schema version.
 */
export const CURRENT_SCHEMA_VERSION = 11;

/**
 * Runs any pending migrations on the database.
 *
 * @param db - Database connection
 */
export async function runMigrations(db: DbConnection): Promise<void> {
  const currentVersion = getCurrentSchemaVersion(db);

  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    logDebug(`Database schema is up to date (version ${currentVersion})`);
    return;
  }

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}. ` +
        "Please upgrade rfmedia CLI.",
    );
  }

  logDebug(`Database schema needs upgrade: ${currentVersion} -> ${CURRENT_SCHEMA_VERSION}`);

  // Run migrations sequentially
  if (currentVersion < 4) {
    logDebug("Migrating from version 3 to version 4: Adding queue tables");
    // Queue tables are created via CREATE IF NOT EXISTS in schema.sql
    // Just update the version number
    db.prepare("UPDATE metadata SET value = '4' WHERE key = 'schema_version'").run();
    logDebug("Migration to version 4 complete");
  }

  if (currentVersion < 5) {
    logDebug("Migrating from version 4 to version 5: Adding Plex query tables");
    // Plex query tables (plex_queries and plex_query_results) are created via CREATE IF NOT EXISTS in schema.sql
    // Just update the version number
    db.prepare("UPDATE metadata SET value = '5' WHERE key = 'schema_version'").run();
    logDebug("Migration to version 5 complete");
  }

  if (currentVersion < 6) {
    logDebug("Migrating from version 5 to version 6: Adding playlist export tables");
    // Playlist export tables are created via CREATE IF NOT EXISTS in schema.sql
    // Just update the version number
    db.prepare("UPDATE metadata SET value = '6' WHERE key = 'schema_version'").run();
    logDebug("Migration to version 6 complete");
  }

  if (currentVersion < 7) {
    logDebug("Migrating from version 6 to version 7: Adding smart playlist tables");
    // Smart playlist tables (smart_playlists, smart_playlist_history, smart_playlist_tracks)
    // are created via CREATE IF NOT EXISTS in schema.sql
    // Just update the version number
    db.prepare("UPDATE metadata SET value = '7' WHERE key = 'schema_version'").run();
    logDebug("Migration to version 7 complete");
  }

  if (currentVersion < 8) {
    logDebug("Migrating from version 7 to version 8: SQLite optimization audit (#112)");
    // Redundant indexes are dropped and composite indexes created by the
    // DROP/CREATE INDEX statements in schema.sql, which also updates the
    // version number. Nothing further to do here.
    db.prepare("UPDATE metadata SET value = '8' WHERE key = 'schema_version'").run();
    logDebug("Migration to version 8 complete");
  }

  if (currentVersion < 9) {
    logDebug("Migrating from version 8 to version 9: Adding inventory content hashes");
    const columns = db.prepare("PRAGMA table_info(inventory)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "content_hash")) {
      db.prepare("ALTER TABLE inventory ADD COLUMN content_hash TEXT").run();
    }
    db.prepare("UPDATE metadata SET value = '9' WHERE key = 'schema_version'").run();
    logDebug("Migration to version 9 complete");
  }

  if (currentVersion < 10) {
    logDebug("Migrating from version 9 to version 10: Adding Lidarr resilience tables (#195)");
    // The lidarr_deferred_intents, lidarr_metadata_cache, and lidarr_circuit_state
    // tables are created via CREATE TABLE IF NOT EXISTS in schema.sql.
    // Just update the version number.
    db.prepare("UPDATE metadata SET value = '10' WHERE key = 'schema_version'").run();
    logDebug("Migration to version 10 complete");
  }

  if (currentVersion < 11) {
    logDebug(
      "Migrating from version 10 to version 11: Adding Plex-Lidarr artist identity snapshots (#207)",
    );
    // The bridge_identity_snapshots table is created via CREATE TABLE IF NOT EXISTS
    // in schema.sql. Just update the version number.
    db.prepare("UPDATE metadata SET value = '11' WHERE key = 'schema_version'").run();
    logDebug("Migration to version 11 complete");
  }

  logDebug("Migration complete");
}
