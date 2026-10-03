/**
 * Stats action for rfmedia CLI.
 *
 * Provides functionality to query and analyze the SQLite tracking database,
 * showing operation statistics, storage usage, and success rates.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { initializeDatabase, closeDatabase } from "../lib/db.js";
import type { DbConnection } from "../types/db.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { resolveUndoDatabasePath } from "../lib/config.js";
import { logDebug } from "../lib/logger.js";
import type { StatsOptions } from "../types/options.js";
import type { StatsResult, OperationStats, StorageByRating } from "../types/results.js";

// ============================================================================
// ENTRY FUNCTION
// ============================================================================

/**
 * Executes the stats command.
 *
 * Queries the tracking database to provide comprehensive statistics including:
 * - Operation statistics by command type
 * - Success rates by mode (album vs filter)
 * - Total file count and storage size
 * - Storage breakdown by rating ranges
 *
 * @param options - Stats options from CLI
 * @returns Statistics result with aggregated data
 */
export async function executeStats(options: StatsOptions): Promise<StatsResult> {
  // Resolve database path
  const config = getLoadedConfig();
  const dbPath = options.trackingDatabase ?? resolveUndoDatabasePath(config);
  logDebug(`Using database: ${dbPath}`);

  // Initialize database connection
  const db = await initializeDatabase(dbPath);

  try {
    // Query operation statistics
    const operations = queryOperationStats(db);
    logDebug(`Found ${operations.length} operation type(s) with statistics`);

    // Query success rate by mode
    const successRateByMode = querySuccessRateByMode(db);
    logDebug(`Success rates by mode: ${JSON.stringify(successRateByMode)}`);

    // Query total storage
    const { totalFiles, totalSize } = queryTotalStorage(db);
    logDebug(`Total storage: ${totalFiles} files, ${totalSize} bytes`);

    // Query storage by rating
    const storageByRating = queryStorageByRating(db);
    logDebug(`Storage grouped into ${storageByRating.length} rating range(s)`);

    return {
      operations,
      totalFiles,
      totalSize,
      storageByRating,
      successRateByMode,
    };
  } finally {
    closeDatabase(db);
  }
}

// ============================================================================
// QUERY FUNCTIONS
// ============================================================================

/**
 * Queries operation statistics grouped by command type.
 *
 * Aggregates operations by command name, counting total, completed, failed,
 * and partial operations, and calculates success rate as percentage.
 *
 * @param db - Database connection
 * @returns Array of operation statistics
 */
function queryOperationStats(db: DbConnection): OperationStats[] {
  const stmt = db.prepare(`
    SELECT
      command,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) as partial
    FROM operations
    GROUP BY command
    ORDER BY total DESC
  `);

  const rows = stmt.all() as Array<{
    command: string;
    total: number;
    completed: number;
    failed: number;
    partial: number;
  }>;

  return rows.map((row) => {
    const successCount = row.completed;
    const successRate = row.total > 0 ? (successCount / row.total) * 100 : 0;

    return {
      command: row.command,
      total: row.total,
      completed: row.completed,
      failed: row.failed,
      partial: row.partial,
      successRate: Math.round(successRate * 100) / 100, // Round to 2 decimal places
    };
  });
}

/**
 * Queries success rate breakdown by copy mode (album vs filter).
 *
 * Calculates average success rate for each mode type. Success is defined
 * as operations with status = 'completed'.
 *
 * @param db - Database connection
 * @returns Object with optional album and filter success rates
 */
function querySuccessRateByMode(db: DbConnection): { album?: number; filter?: number } {
  const stmt = db.prepare(`
    SELECT
      mode,
      COUNT(*) as total,
      AVG(CASE WHEN status = 'completed' THEN 1.0 ELSE 0.0 END) * 100 as success_rate
    FROM operations
    WHERE mode IS NOT NULL
    GROUP BY mode
  `);

  const rows = stmt.all() as Array<{
    mode: string;
    total: number;
    success_rate: number;
  }>;

  const result: { album?: number; filter?: number } = {};

  for (const row of rows) {
    const rate = Math.round(row.success_rate * 100) / 100; // Round to 2 decimal places
    if (row.mode === "album") {
      result.album = rate;
    } else if (row.mode === "filter") {
      result.filter = rate;
    }
  }

  return result;
}

/**
 * Queries total file count and storage size from inventory table.
 *
 * @param db - Database connection
 * @returns Object with totalFiles count and totalSize in bytes
 */
function queryTotalStorage(db: DbConnection): { totalFiles: number; totalSize: number } {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total_files,
      COALESCE(SUM(size), 0) as total_size
    FROM inventory
  `);

  const row = stmt.get() as { total_files: number; total_size: number } | undefined;

  return {
    totalFiles: row?.total_files ?? 0,
    totalSize: row?.total_size ?? 0,
  };
}

/**
 * Queries storage breakdown by rating ranges.
 *
 * Groups inventory files by rating ranges:
 * - 4-5 stars: rating >= 0.8
 * - 3-4 stars: rating >= 0.6
 * - 2-3 stars: rating >= 0.4
 * - 1-2 stars: rating >= 0.2
 * - Unrated: rating < 0.2 or NULL
 *
 * @param db - Database connection
 * @returns Array of storage statistics by rating range
 */
function queryStorageByRating(db: DbConnection): StorageByRating[] {
  const stmt = db.prepare(`
    SELECT
      CASE
        WHEN rating >= 0.8 THEN '4-5 stars'
        WHEN rating >= 0.6 THEN '3-4 stars'
        WHEN rating >= 0.4 THEN '2-3 stars'
        WHEN rating >= 0.2 THEN '1-2 stars'
        ELSE 'Unrated'
      END as rating_range,
      COUNT(*) as file_count,
      COALESCE(SUM(size), 0) as total_size
    FROM inventory
    GROUP BY rating_range
    ORDER BY
      CASE rating_range
        WHEN '4-5 stars' THEN 1
        WHEN '3-4 stars' THEN 2
        WHEN '2-3 stars' THEN 3
        WHEN '1-2 stars' THEN 4
        WHEN 'Unrated' THEN 5
      END
  `);

  const rows = stmt.all() as Array<{
    rating_range: string;
    file_count: number;
    total_size: number;
  }>;

  return rows.map((row) => ({
    range: row.rating_range,
    fileCount: row.file_count,
    totalSize: row.total_size,
  }));
}
