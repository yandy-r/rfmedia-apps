/**
 * History action for rfmedia CLI.
 *
 * Provides functionality to query operation history with date/mode/status filtering
 * and duplicate detection capabilities.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { initializeDatabase, closeDatabase } from "../lib/db.js";
import type { DbConnection } from "../types/db.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { resolveUndoDatabasePath } from "../lib/config.js";
import { logDebug } from "../lib/logger.js";
import type { HistoryOptions } from "../types/options.js";
import type {
  HistoryResult,
  HistoryEntry,
  DuplicateGroup,
  DuplicateSource,
} from "../types/results.js";

// ============================================================================
// ENTRY FUNCTION
// ============================================================================

/**
 * Executes the history command.
 *
 * Queries the tracking database to provide filtered operation history including:
 * - Date range filtering (from/to)
 * - Mode filtering (album vs filter)
 * - Status filtering (pending/completed/failed/partial)
 * - Command type filtering
 * - Optional duplicate detection
 *
 * @param options - History options from CLI
 * @returns History result with filtered entries and optional duplicates
 */
export async function executeHistory(options: HistoryOptions): Promise<HistoryResult> {
  // Resolve database path
  const config = getLoadedConfig();
  const dbPath = options.trackingDatabase ?? resolveUndoDatabasePath(config);
  logDebug(`Using database: ${dbPath}`);

  // Initialize database connection
  const db = await initializeDatabase(dbPath);

  try {
    // Parse date filters
    const fromDate = options.from ? parseDate(options.from) : undefined;
    const toDate = options.to ? parseDate(options.to) : undefined;

    logDebug(`Date range: ${fromDate ?? "none"} to ${toDate ?? "none"}`);

    // Query total count before limit
    const totalCount = queryHistoryCount(db, {
      from: fromDate,
      to: toDate,
      mode: options.mode,
      status: options.status,
      command: options.command,
    });

    logDebug(`Total matching operations: ${totalCount}`);

    // Query history entries
    const entries = queryHistory(db, {
      from: fromDate,
      to: toDate,
      mode: options.mode,
      status: options.status,
      command: options.command,
      limit: options.limit,
    });

    logDebug(`Retrieved ${entries.length} entries (limit: ${options.limit})`);

    // Query duplicates if requested
    let duplicates: DuplicateGroup[] | undefined;
    let duplicateSources: DuplicateSource[] | undefined;

    if (options.showDuplicates) {
      duplicates = queryDuplicateOperations(db);
      duplicateSources = queryDuplicateSources(db);
      logDebug(
        `Found ${duplicates.length} duplicate operation group(s) and ${duplicateSources.length} duplicate source(s)`,
      );
    }

    return {
      entries,
      totalCount,
      duplicates,
      duplicateSources,
    };
  } finally {
    closeDatabase(db);
  }
}

// ============================================================================
// DATE PARSING
// ============================================================================

/**
 * Parses a date string into an ISO timestamp.
 *
 * Supports two formats:
 * 1. ISO date: "2026-01-15" or "2026-01-15T10:30:00"
 * 2. Relative date: "7 days ago", "2 weeks ago", "1 month ago"
 *
 * @param dateStr - Date string to parse
 * @returns ISO timestamp string
 * @throws Error if date format is invalid
 */
function parseDate(dateStr: string): string {
  // Try ISO date parsing first
  const isoDate = new Date(dateStr);
  if (!isNaN(isoDate.getTime())) {
    return isoDate.toISOString();
  }

  // Try relative date parsing
  const relativePattern = /^(\d+)\s+(days?|weeks?|months?)\s+ago$/i;
  const match = dateStr.match(relativePattern);

  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `Invalid date format: "${dateStr}". Use ISO format (e.g., "2026-01-15") or relative format (e.g., "7 days ago")`,
    );
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  const now = new Date();

  if (unit.startsWith("day")) {
    now.setDate(now.getDate() - amount);
  } else if (unit.startsWith("week")) {
    now.setDate(now.getDate() - amount * 7);
  } else if (unit.startsWith("month")) {
    now.setMonth(now.getMonth() - amount);
  }

  return now.toISOString();
}

// ============================================================================
// QUERY FUNCTIONS
// ============================================================================

interface QueryFilters {
  from?: string;
  to?: string;
  mode?: "album" | "filter";
  status?: "pending" | "completed" | "failed" | "partial";
  command?: "copy-album" | "copy-filter" | "sync";
  limit?: number;
}

/**
 * Queries operation history with filters and limit.
 *
 * @param db - Database connection
 * @param filters - Query filters
 * @returns Array of history entries
 */
function queryHistory(db: DbConnection, filters: QueryFilters): HistoryEntry[] {
  let sql = `
    SELECT
      id,
      created_at,
      command,
      mode,
      input_file,
      options_hash,
      status,
      total_sources,
      completed_count,
      failed_count,
      started_at,
      ended_at
    FROM operations
    WHERE 1=1
  `;

  const params: unknown[] = [];

  if (filters.from) {
    sql += ` AND created_at >= ?`;
    params.push(filters.from);
  }

  if (filters.to) {
    sql += ` AND created_at <= ?`;
    params.push(filters.to);
  }

  if (filters.mode) {
    sql += ` AND mode = ?`;
    params.push(filters.mode);
  }

  if (filters.status) {
    sql += ` AND status = ?`;
    params.push(filters.status);
  }

  if (filters.command) {
    sql += ` AND command = ?`;
    params.push(filters.command);
  }

  sql += ` ORDER BY created_at DESC`;

  if (filters.limit) {
    sql += ` LIMIT ?`;
    params.push(filters.limit);
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<{
    id: number;
    created_at: string;
    command: string;
    mode: string;
    input_file: string | null;
    options_hash: string;
    status: string;
    total_sources: number;
    completed_count: number;
    failed_count: number;
    started_at: string;
    ended_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    command: row.command,
    mode: row.mode,
    inputFile: row.input_file,
    optionsHash: row.options_hash,
    status: row.status,
    totalSources: row.total_sources,
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }));
}

/**
 * Queries total count of operations matching filters (before limit).
 *
 * @param db - Database connection
 * @param filters - Query filters (without limit)
 * @returns Total count of matching operations
 */
function queryHistoryCount(db: DbConnection, filters: Omit<QueryFilters, "limit">): number {
  let sql = `SELECT COUNT(*) as count FROM operations WHERE 1=1`;

  const params: unknown[] = [];

  if (filters.from) {
    sql += ` AND created_at >= ?`;
    params.push(filters.from);
  }

  if (filters.to) {
    sql += ` AND created_at <= ?`;
    params.push(filters.to);
  }

  if (filters.mode) {
    sql += ` AND mode = ?`;
    params.push(filters.mode);
  }

  if (filters.status) {
    sql += ` AND status = ?`;
    params.push(filters.status);
  }

  if (filters.command) {
    sql += ` AND command = ?`;
    params.push(filters.command);
  }

  const stmt = db.prepare(sql);
  const row = stmt.get(...params) as { count: number } | undefined;

  return row?.count ?? 0;
}

/**
 * Queries operations with duplicate options_hash values.
 *
 * Groups operations by options_hash and returns only those with count > 1.
 *
 * @param db - Database connection
 * @returns Array of duplicate groups
 */
function queryDuplicateOperations(db: DbConnection): DuplicateGroup[] {
  const stmt = db.prepare(`
    SELECT
      options_hash,
      COUNT(*) as duplicate_count,
      GROUP_CONCAT(id) as operation_ids
    FROM operations
    WHERE options_hash IS NOT NULL
    GROUP BY options_hash
    HAVING COUNT(*) > 1
    ORDER BY duplicate_count DESC
  `);

  const rows = stmt.all() as Array<{
    options_hash: string;
    duplicate_count: number;
    operation_ids: string;
  }>;

  return rows.map((row) => ({
    optionsHash: row.options_hash,
    count: row.duplicate_count,
    operationIds: row.operation_ids.split(",").map((id) => parseInt(id, 10)),
  }));
}

/**
 * Queries sources that have been processed in multiple operations.
 *
 * Groups completed sources by source_path and returns only those processed
 * in more than one operation.
 *
 * @param db - Database connection
 * @returns Array of duplicate sources
 */
function queryDuplicateSources(db: DbConnection): DuplicateSource[] {
  const stmt = db.prepare(`
    SELECT
      source_path,
      COUNT(DISTINCT operation_id) as operation_count
    FROM completed_sources
    GROUP BY source_path
    HAVING COUNT(DISTINCT operation_id) > 1
    ORDER BY operation_count DESC
  `);

  const rows = stmt.all() as Array<{
    source_path: string;
    operation_count: number;
  }>;

  return rows.map((row) => ({
    sourcePath: row.source_path,
    operationCount: row.operation_count,
  }));
}
