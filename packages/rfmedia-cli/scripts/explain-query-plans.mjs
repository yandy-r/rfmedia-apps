#!/usr/bin/env node
/**
 * EXPLAIN QUERY PLAN audit for the hot queries in db.ts / queue-db.ts (#112).
 *
 * Loads schema.sql into a temporary database and prints the query plan for
 * each representative query. Exits non-zero if any plan contains a full
 * table scan (`SCAN <table>` without an index), so this can run in CI or
 * be used as a one-off audit tool.
 *
 * Usage: node scripts/explain-query-plans.mjs
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "../src/lib/schema.sql"), "utf-8");

const db = new Database(":memory:");
db.exec(schema);

/**
 * Representative hot queries keyed by the function that issues them.
 *
 * Each entry is the base variant of the query: optional predicates the real
 * implementations add conditionally (e.g., rating_key in
 * getCompletedAlbumCopies*, command/LIMIT in getHistorySessions) do not
 * change which index SQLite picks for the listed key columns.
 */
const queries = {
  "findOperation (db.ts)": `
    SELECT * FROM operations
    WHERE input_file = ? AND options_hash = ?
    ORDER BY created_at DESC LIMIT 1`,
  "getCompletedSources (db.ts)": `
    SELECT source_path FROM completed_sources
    WHERE operation_id = ? ORDER BY completed_at`,
  "isSourceCompleted (db.ts)": `
    SELECT 1 FROM completed_sources
    WHERE operation_id = ? AND source_path = ?`,
  "getFailedSources (db.ts)": `
    SELECT * FROM failed_sources
    WHERE operation_id = ? ORDER BY failed_at`,
  "getCompletedAlbumCopies (db.ts)": `
    SELECT * FROM completed_album_copies
    WHERE operation_id = ? AND source_path = ?
    ORDER BY album_name, suffix`,
  "getCompletedAlbumCopiesUnderPath (db.ts)": `
    SELECT * FROM completed_album_copies
    WHERE operation_id = ? AND (source_path = ? OR source_path LIKE ?)
    ORDER BY source_path, album_name, suffix`,
  "getCompletedSuffixesForAlbum (db.ts)": `
    SELECT suffix FROM completed_album_copies
    WHERE operation_id = ? AND source_path = ? AND album_name = ?`,
  "getInventory (db.ts)": `
    SELECT * FROM inventory
    WHERE operation_id = ? ORDER BY source_path, relative_path`,
  "getInventoryForSource (db.ts)": `
    SELECT * FROM inventory
    WHERE operation_id = ? AND source_path = ? ORDER BY relative_path`,
  "findHistorySession (db.ts)": `
    SELECT * FROM history_sessions WHERE session_id = ?`,
  "getHistorySessions (db.ts)": `
    SELECT * FROM history_sessions WHERE status = ?
    ORDER BY started_at DESC LIMIT ?`,
  "getHistoryOperations (db.ts)": `
    SELECT * FROM history_operations
    WHERE session_id = ? ORDER BY occurred_at`,
  "getNextPendingJobFromDb (queue-db.ts)": `
    SELECT * FROM queue_jobs WHERE status = 'pending'
    ORDER BY added_at ASC LIMIT 1`,
  // The real implementation builds `job_id IN (${placeholders})` dynamically,
  // chunked at MAX_BATCH_PARAMS; the placeholder count does not affect the plan
  "loadSourcesForJobs (queue-db.ts)": `
    SELECT * FROM queue_job_sources WHERE job_id IN (?, ?, ?) ORDER BY id`,
  "getSmartPlaylist (db.ts)": `
    SELECT * FROM smart_playlists WHERE name = ?`,
  "getPlexQueryResults (db.ts)": `
    SELECT * FROM plex_query_results WHERE query_id = ? ORDER BY id`,
};

let fullScans = 0;

for (const [name, sql] of Object.entries(queries)) {
  const paramCount = (sql.match(/\?/g) ?? []).length;
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(paramCount).fill(1));
  console.log(`\n${name}`);
  for (const step of plan) {
    const detail = String(step.detail);
    // A bare "SCAN <table>" (no index mentioned) is a full table scan
    const isFullScan = /^SCAN \S+$/.test(detail);
    if (isFullScan) fullScans++;
    console.log(`  ${isFullScan ? "!! FULL SCAN" : "ok"}  ${detail}`);
  }
}

db.close();

if (fullScans > 0) {
  console.error(`\n${fullScans} full table scan(s) detected`);
  process.exit(1);
}
console.log("\nAll queries use an index.");
